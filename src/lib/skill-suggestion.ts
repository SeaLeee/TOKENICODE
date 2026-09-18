import type { UnifiedCommand } from './tauri-bridge';
import { bridge } from './tauri-bridge';
import { useSkillMetaStore } from '../stores/skillMetaStore';
import { useProviderStore, type ApiProvider } from '../stores/providerStore';

/**
 * Skill auto-suggestion: given a typed query, score which installed skills are
 * relevant so the input bar can suggest (or auto-attach) them.
 *
 * Local scoring is deterministic and free — it tokenizes the query into Latin
 * words and CJK character bigrams and counts substring hits against a skill's
 * name (high weight) and description (low weight). It deliberately does NOT do
 * semantic matching, so cross-language / near-synonym cases (e.g. the Chinese
 * "总结" vs a skill described as "摘要") are missed; that gap is what the
 * optional AI enhancement (`suggestSkillsWithAi`) covers.
 */

const NAME_WEIGHT = 3;
const TAG_WEIGHT = 2;
const DESC_WEIGHT = 1;
/** How much each doubling of usage adds to a skill's combined suggestion score. */
const USAGE_WEIGHT = 0.5;
/** Cap on the usage boost so a frequently-used skill can nudge ranking but never
 *  outweigh a full extra name hit (+3) of relevance. */
const MAX_USAGE_BOOST = 2;

/** Common function words (en + zh) that should not count as relevance signal. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is',
  'are', 'was', 'were', 'be', 'been', 'it', 'its', 'my', 'me', 'you', 'your',
  'do', 'does', 'did', 'can', 'could', 'would', 'should', 'how', 'what',
  'which', 'when', 'where', 'who', 'why', 'please', 'this', 'that', 'these',
  'those', 'from', 'by', 'at', 'as', 'into', 'about', 'not', 'no', 'yes',
  '请', '帮我', '一个', '这个', '那个', '可以', '怎么', '如何',
  '一下', '什么', '为什么', '哪个', '哪里', '能否', '麻烦',
]);

/** Strip the leading slash from a skill command name → slug. */
export function slugOf(skill: UnifiedCommand): string {
  return skill.name.replace(/^\//, '');
}

/**
 * Split text into matchable terms: Latin/number runs become words, CJK runs
 * become overlapping character bigrams (a single CJK char stays as-is). This
 * lets short Chinese sub-phrases overlap a description without a word segmenter.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    const word = m[0];
    if (/[一-鿿]/.test(word)) {
      if (word.length === 1) {
        tokens.push(word);
      } else {
        for (let i = 0; i + 1 < word.length; i++) {
          tokens.push(word.slice(i, i + 2));
        }
      }
    } else {
      tokens.push(word);
    }
  }
  return tokens;
}

/** Score a single skill against the query. Higher is better. Each query token
 *  counts once, at the highest-weight field it hits: name > tags > description. */
export function scoreSkill(query: string, skill: UnifiedCommand, tags?: string[]): number {
  const tokens = tokenize(query);
  if (!tokens.length) return 0;
  const slug = slugOf(skill).toLowerCase();
  const desc = skill.description.toLowerCase();
  const tagText = (tags ?? []).join(' ').toLowerCase();
  let score = 0;
  const seen = new Set<string>();
  for (const tok of tokens) {
    if (seen.has(tok) || STOPWORDS.has(tok)) continue;
    seen.add(tok);
    if (slug.includes(tok)) score += NAME_WEIGHT;
    else if (tagText.includes(tok)) score += TAG_WEIGHT;
    else if (desc.includes(tok)) score += DESC_WEIGHT;
  }
  return score;
}

/** Usage boost added on top of relevance: diminishing (log-scaled) so a couple
 *  of uses nudges ranking without letting a very frequent skill drown out a
 *  clearly more relevant one. */
export function usageBoost(usage: number): number {
  if (usage <= 0) return 0;
  return Math.min(MAX_USAGE_BOOST, USAGE_WEIGHT * Math.log2(1 + usage));
}

export interface SkillSuggestion {
  skill: UnifiedCommand;
  /** Combined ranking score: text/tag relevance + usage boost. */
  score: number;
  /** The pure text/tag relevance component, before the usage boost. */
  relevance?: number;
}

export interface SuggestOptions {
  /** Skill names (with slash) already attached and thus to exclude. */
  excludeNames?: Set<string>;
  /** Minimum score to surface a suggestion (default 2 = one name hit or two desc hits). */
  threshold?: number;
  /** Max suggestions returned (default 4). */
  limit?: number;
}

/** Ranking bump for user-registered (custom-folder) skills so a user's own
 *  skills outrank equally-relevant built-in/marketplace ones. */
const CUSTOM_SOURCE_BOOST = 1;

/**
 * Rank installed skills by relevance to `query`. Relevance combines name, tag
 * and description hits; the final ranking score adds a log-scaled usage boost so
 * frequently-used skills float up without overriding a clearly more relevant one,
 * plus a small boost for user-registered custom-folder skills.
 * A skill must clear the relevance `threshold` on its own to be suggested — usage
 * alone never surfaces an unrelated skill.
 */
export function suggestSkills(
  query: string,
  skills: UnifiedCommand[],
  opts?: SuggestOptions,
): SkillSuggestion[] {
  const q = query.trim();
  if (!q) return [];
  const threshold = opts?.threshold ?? 2;
  const limit = opts?.limit ?? 4;
  const exclude = opts?.excludeNames;
  const meta = useSkillMetaStore.getState();

  return skills
    .filter((s) => s.category === 'skill')
    .filter((s) => !exclude?.has(s.name))
    .map((s) => {
      const slug = slugOf(s);
      const relevance = scoreSkill(q, s, meta.tags[slug]);
      const customBoost = s.source === 'custom' ? CUSTOM_SOURCE_BOOST : 0;
      const score = relevance + usageBoost(meta.usage[slug] ?? 0) + customBoost;
      return { skill: s, score, relevance };
    })
    .filter((x) => (x.relevance ?? 0) >= threshold)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if ((b.relevance ?? 0) !== (a.relevance ?? 0)) return (b.relevance ?? 0) - (a.relevance ?? 0);
      const ua = meta.usage[slugOf(a.skill)] ?? 0;
      const ub = meta.usage[slugOf(b.skill)] ?? 0;
      if (ub !== ua) return ub - ua;
      return (b.skill.modified ?? 0) - (a.skill.modified ?? 0);
    })
    .slice(0, limit);
}

/** Pick the cheapest provider model (haiku → sonnet → opus → first mapping). */
function pickRoutingModel(provider: ApiProvider): string | undefined {
  for (const tier of ['haiku', 'sonnet', 'opus']) {
    const m = provider.modelMappings.find((x) => x.tier === tier && x.providerModel);
    if (m) return m.providerModel;
  }
  return provider.modelMappings.find((x) => x.providerModel)?.providerModel;
}

/** Parse a JSON array of slugs out of a model's raw text reply. */
function parseSlugs(text: string, knownSlugs: string[]): string[] {
  const cleaned = text.replace(/```[a-z]*/gi, '').replace(/```/g, '').trim();
  try {
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (m) {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) {
        return arr.filter((x): x is string => typeof x === 'string');
      }
    }
  } catch {
    // fall through to substring fallback
  }
  return knownSlugs.filter((slug) => cleaned.toLowerCase().includes(slug.toLowerCase()));
}

/**
 * AI-enhanced suggestion: ask the active provider (a cheap model) which of the
 * installed skills are relevant to the query. Returns [] when there's no active
 * provider, no API key, or the call fails — callers fall back to local scoring.
 *
 * Successful results are cached per provider+model+query so typing the same
 * message (or toggling suggestions) does not re-charge the API.
 */
const aiCache = new Map<string, SkillSuggestion[]>();

export async function suggestSkillsWithAi(
  query: string,
  skills: UnifiedCommand[],
): Promise<SkillSuggestion[]> {
  const provider = useProviderStore.getState().getActive();
  if (!provider || !provider.apiKey) return [];
  const model = pickRoutingModel(provider);
  if (!model) return [];

  const cacheKey = `${provider.id}:${model}:${query.trim()}`;
  const cached = aiCache.get(cacheKey);
  if (cached) return cached;

  const skillList = skills.filter((s) => s.category === 'skill');
  const catalog = skillList.map((s) => ({ slug: slugOf(s), description: s.description }));
  const prompt = [
    'You are a skill router. Given a user message and a catalog of skills, choose the skills that are relevant to the message.',
    'Return ONLY a JSON array of skill slugs (strings), e.g. ["summarize"]. Return [] if none apply.',
    '',
    'User message: ' + query,
    '',
    'Skills (slug: description):',
    ...catalog.map((c) => `- ${c.slug}: ${c.description}`),
  ].join('\n');

  try {
    const text = await bridge.providerChat(
      provider.baseUrl,
      provider.apiFormat,
      provider.apiKey,
      model,
      prompt,
      provider.proxyUrl || undefined,
    );
    const slugs = parseSlugs(text, catalog.map((c) => c.slug));
    const slugSet = new Set(slugs.map((s) => s.toLowerCase()));
    const result = skillList
      .filter((s) => slugSet.has(slugOf(s).toLowerCase()))
      .map((skill) => ({ skill, score: 99 }));
    aiCache.set(cacheKey, result);
    return result;
  } catch (e) {
    console.warn('[skill-suggestion] AI suggestion failed:', e);
    return [];
  }
}
