import { useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useActiveTab, useChatStore, generateMessageId } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { resolveModelForProvider, is1MModel } from '../../lib/api-provider';
import { bridge } from '../../lib/tauri-bridge';
import { t } from '../../lib/i18n';

const RING_R = 10;
const RING_C = 2 * Math.PI * RING_R;

/**
 * Send a manual `/compact` to the active session's live CLI process (VSCode
 * Claude Code parity — the user can compress context themselves). Mirrors the
 * auto-compact body in useStreamProcessor. Returns false when there is no live
 * stdin binding (nothing to compact).
 */
function triggerContextCompact(tabId: string): boolean {
  const store = useChatStore.getState();
  const stdinId = store.getTab(tabId)?.sessionMeta.stdinId;
  if (!stdinId) return false;

  const msgId = generateMessageId();
  const startedAt = Date.now();
  store.addMessage(tabId, {
    id: msgId,
    role: 'system',
    type: 'text',
    content: t('chat.autoCompacting'),
    commandType: 'processing',
    commandData: { command: '/compact' },
    commandStartTime: startedAt,
    commandCompleted: false,
    timestamp: startedAt,
  });
  store.setSessionMeta(tabId, { pendingCommandMsgId: msgId });
  store.setSessionStatus(tabId, 'running');
  store.setActivityStatus(tabId, { phase: 'thinking' });
  bridge.sendStdin(stdinId, '/compact').catch((err) => {
    console.error('[TOKENICODE] Manual compact failed:', err);
  });

  // Timeout fallback (mirror auto-compact): complete the card if no result.
  setTimeout(() => {
    const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
    if (meta.pendingCommandMsgId === msgId) {
      useChatStore.getState().updateMessage(tabId, msgId, {
        commandCompleted: true,
        commandData: { command: '/compact', output: 'Compact timed out', completedAt: Date.now() },
      });
      useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
      if (useChatStore.getState().getTab(tabId)?.sessionStatus === 'running') {
        useChatStore.getState().setSessionStatus(tabId, 'idle');
      }
    }
  }, 15_000);

  return true;
}

/**
 * Context-window fullness meter (VSCode Claude Code parity): a circular ring
 * showing the current context usage. The CLI stream does not emit a
 * remaining-context signal, so fullness is computed client-side from the latest
 * full-context `contextTokens` vs. the model's window (200K / 1M for `-1m`).
 * Clicking the ring sends a manual `/compact` to free up context.
 */
export function ContextMeter() {
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const contextTokens = useActiveTab(
    (tab) => tab.sessionMeta.contextTokens ?? tab.sessionMeta.inputTokens ?? 0,
  );
  const [showBreakdown, setShowBreakdown] = useState(false);
  // The model the *CLI* resolved, not the UI selection: only the CLI's own
  // string carries the `[1m]` marker, and reading the UI selection instead gave a
  // 1M session a 200K denominator — which pinned this ring at 100% regardless of
  // how much context was really in use.
  const sessionModel = useActiveTab((tab) => tab.sessionMeta.model);
  const spawnedModel = useActiveTab((tab) => tab.sessionMeta.spawnedModel);
  const tabId = useSessionStore((s) => s.selectedSessionId);

  const resolvedModel = sessionModel ?? spawnedModel ?? resolveModelForProvider(selectedModel);
  const contextWindow = is1MModel(resolvedModel) ? 1_000_000 : 200_000;

  // The CLI's own accounting wins whenever we have it: it counts exactly, and it
  // reports the window too, so neither figure has to be derived. Verified
  // end-to-end — the reply arrives in ~0.4s and costs no API call.
  const cliContext = useActiveTab((tab) => tab.sessionMeta.cliContext);
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

  const cliPercent = num(cliContext?.percentage);
  const cliTotal = num(cliContext?.totalTokens);
  const cliMax = num(cliContext?.maxTokens) ?? num(cliContext?.rawMaxTokens);
  const cliFreeSpace = Array.isArray(cliContext?.categories)
    ? num((cliContext!.categories as Array<{ name?: string; tokens?: number }>)
        .find((c) => c?.name === 'Free space')?.tokens)
    : undefined;

  const pct = cliPercent !== undefined
    ? Math.min(1, Math.max(0, cliPercent / 100))
    : Math.min(1, Math.max(0, contextTokens / contextWindow));
  const pctLabel = Math.round(pct * 100);

  const ringColor = pct >= 0.85 ? 'text-error' : pct >= 0.6 ? 'text-warning' : 'text-success';
  const textColor = pct >= 0.85 ? 'text-error' : pct >= 0.6 ? 'text-amber-500' : 'text-text-tertiary';

  // The CLI's own breakdown of what is using the window — the same categories the
  // `/context` view renders (System prompt / System tools / Skills / Messages /
  // Free space). Only present when the CLI answered `get_context_usage`.
  const categories = Array.isArray(cliContext?.categories)
    ? (cliContext!.categories as Array<{ name?: string; tokens?: number }>)
        .filter((c) => c?.name && typeof c.tokens === 'number')
    : [];

  return (
    <div className="relative flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => tabId && triggerContextCompact(tabId)}
        disabled={!tabId}
        className="flex items-center gap-1.5 px-1 rounded cursor-pointer
          disabled:opacity-60 disabled:cursor-default"
        title={[
          // The CLI's own numbers, exactly as it reports them.
          cliTotal !== undefined && cliMax !== undefined
            ? `${t('context.compact')} · ${cliTotal.toLocaleString()} / ${cliMax.toLocaleString()} tokens`
            : `${t('context.compact')} · ${contextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`,
          cliPercent !== undefined ? `${Math.round(cliPercent)}% used` : null,
          cliFreeSpace !== undefined ? `free space ${cliFreeSpace.toLocaleString()}` : null,
        ].filter(Boolean).join(' · ')}
      >
        <svg width="26" height="26" viewBox="0 0 26 26" className="flex-shrink-0 -rotate-90">
          <circle
            cx="13" cy="13" r={RING_R} fill="none" strokeWidth="2.5"
            stroke="currentColor" className="text-text-tertiary/30"
          />
          <circle
            cx="13" cy="13" r={RING_R} fill="none" strokeWidth="2.5"
            strokeLinecap="round" stroke="currentColor"
            className={`${ringColor} transition-all`}
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - pct)}
          />
        </svg>
        <span className={`text-[10px] font-mono ${textColor} leading-none`}>{pctLabel}%</span>
      </button>

      {categories.length > 0 && (
        <button
          type="button"
          onClick={() => setShowBreakdown((v) => !v)}
          title={t('context.breakdown')}
          className="text-[9px] leading-none text-text-tertiary hover:text-text-secondary
            cursor-pointer"
        >
          {showBreakdown ? '▴' : '▾'}
        </button>
      )}

      {showBreakdown && categories.length > 0 && (
        <div className="absolute bottom-full right-0 mb-2 w-72 rounded-lg border border-border-subtle
          bg-bg-chat shadow-lg p-3 z-50"
        >
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-xs font-medium text-text-primary">{t('context.breakdown')}</span>
            <span className="text-[10px] text-text-tertiary font-mono">
              {cliTotal?.toLocaleString()} / {cliMax?.toLocaleString()}
              {cliPercent !== undefined ? ` · ${Math.round(cliPercent)}%` : ''}
            </span>
          </div>
          <div className="space-y-1.5">
            {categories.map((category) => {
              const tokens = category.tokens as number;
              const share = cliMax ? Math.min(1, tokens / cliMax) : 0;
              return (
                <div key={category.name}>
                  <div className="flex items-center justify-between text-[10px] text-text-tertiary">
                    <span>{category.name}</span>
                    <span className="font-mono">{tokens.toLocaleString()}</span>
                  </div>
                  <div className="h-1 rounded bg-bg-secondary overflow-hidden mt-0.5">
                    <div className="h-full bg-accent" style={{ width: `${share * 100}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-text-tertiary mt-2">{t('context.breakdownHint')}</p>
        </div>
      )}
    </div>
  );
}
