import { useProviderStore, type ModelMapping } from '../stores/providerStore';

/**
 * Pricing for non-Claude (ccswitch-routed) models.
 *
 * Claude Code's `total_cost_usd` in the `result` event is computed at
 * Anthropic prices for whatever model name it was told. When the CLI is routed
 * through ccswitch to a non-Claude model (DeepSeek, GLM, Kimi, Qwen, …), that
 * number is WRONG. The token counts in `usage.input_tokens` /
 * `usage.output_tokens` ARE correct — they come from the actual backend — so
 * the accurate cost is `tokens × the real model's per-token price`.
 *
 * All prices are USD per **million** tokens. The table below is best-effort and
 * drifts (providers change pricing, resellers like ccswitch charge their own
 * rate), so it is overridable per-model in the provider form — the authoritative
 * figure is whatever the user actually pays.
 */

export interface PricingEntry {
  /** USD per 1M input tokens */
  inputPerMtok: number;
  /** USD per 1M output tokens */
  outputPerMtok: number;
}

/** Normalize a model id: lowercase, drop org prefix (`deepseek/deepseek-chat`
 *  → `deepseek-chat`), trim whitespace. */
export function normalizeModelId(model: string): string {
  const last = model.trim().toLowerCase().split('/').pop() ?? model.trim().toLowerCase();
  return last.trim();
}

/** True when the model id refers to an Anthropic Claude model. For Claude the
 *  CLI's `total_cost_usd` is authoritative, so no manual pricing is needed. */
export function isClaudeModel(model: string): boolean {
  return normalizeModelId(model).includes('claude');
}

/** A built-in default price for a known model family, if any. */
export interface PricingRule {
  test: (normalized: string) => boolean;
  price: PricingEntry;
}

/**
 * Best-effort defaults. DeepSeek `deepseek-chat` / `deepseek-reasoner` were
 * retired (Jul 2026) and now resolve to `deepseek-v4-flash`; the alias entries
 * below keep legacy model ids mapping to the same rate.
 */
const DEFAULT_RULES: PricingRule[] = [
  {
    // deepseek-v4-pro — standard rate (promotional rate is ~$0.435/$0.87).
    test: (m) => m.startsWith('deepseek') && (m.includes('v4-pro') || m.includes('v4_pro')),
    price: { inputPerMtok: 1.74, outputPerMtok: 3.48 },
  },
  {
    // deepseek-v4-flash and legacy aliases (chat / reasoner / v3 / v3.2).
    test: (m) => m.startsWith('deepseek'),
    price: { inputPerMtok: 0.14, outputPerMtok: 0.28 },
  },
];

/** Compute cost from a pricing entry and token counts. */
export function computeCost(entry: PricingEntry, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * entry.inputPerMtok
    + (outputTokens / 1_000_000) * entry.outputPerMtok;
}

/** Look up the active provider's per-mapping price override for `model`. */
function mappingOverride(model: string): PricingEntry | null {
  const provider = useProviderStore.getState().getActive();
  if (!provider) return null;
  const normalized = normalizeModelId(model);
  const mapping = provider.modelMappings.find(
    (m: ModelMapping) => normalizeModelId(m.providerModel) === normalized,
  );
  if (!mapping) return null;
  if (typeof mapping.inputPerMtok === 'number' && typeof mapping.outputPerMtok === 'number') {
    return { inputPerMtok: mapping.inputPerMtok, outputPerMtok: mapping.outputPerMtok };
  }
  return null;
}

/** Best-effort default price for a known model family, or null. */
function defaultPrice(model: string): PricingEntry | null {
  const normalized = normalizeModelId(model);
  const rule = DEFAULT_RULES.find((r) => r.test(normalized));
  return rule ? rule.price : null;
}

/**
 * Resolve the authoritative cost for a turn.
 *
 * - Claude models (or unknown model in native mode) → the CLI's cumulative
 *   `total_cost_usd` is authoritative and returned as-is.
 * - Non-Claude models → computed from `tokens × price`, preferring the
 *   provider's per-mapping override, then a built-in default, and returning
 *   `null` (tokens-only, no fabricated cost) when neither is available.
 *
 * `model` is `sessionMeta.spawnedModel` — the actual resolved model for a
 * provider, or `undefined` in native mode.
 */
export function resolveCostUsd(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cliTotalCostUsd?: number | null,
): number | null {
  if (!inputTokens && !outputTokens) return null;

  // Native mode (no model) or Claude → trust the CLI's Claude-priced total.
  if (!model || isClaudeModel(model)) {
    return typeof cliTotalCostUsd === 'number' ? cliTotalCostUsd : null;
  }

  const override = mappingOverride(model) ?? defaultPrice(model);
  if (!override) return null;
  return computeCost(override, inputTokens, outputTokens);
}
