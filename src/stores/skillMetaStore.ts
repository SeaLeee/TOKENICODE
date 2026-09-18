import { create } from 'zustand';

const STORAGE_KEY = 'tokenicode-skill-meta';

/** Per-skill bookkeeping for the input skill picker: usage frequency,
 *  install time and category. Persisted in localStorage so it survives
 *  restarts. Category and install time are only known for skills installed
 *  via the marketplace (SkillHub) — everything else falls back to defaults. */
interface SkillMetaState {
  usage: Record<string, number>;
  installedAt: Record<string, number>;
  categories: Record<string, string>;
  /** Free-form tags per skill, used to boost auto-suggestion relevance and for
   *  display. Seeded from the marketplace category/labels on install; the user
   *  can also edit them from the skill detail panel. */
  tags: Record<string, string[]>;
  /** Slugs the user has starred in the installed-skills panel. */
  favorites: Record<string, boolean>;
  /** User-assigned rating (1-5) for a skill, set from the installed-skills panel. */
  ratings: Record<string, number>;
  /** Bump the usage counter for a skill (called when it's attached to input). */
  recordUse: (slug: string) => void;
  /** Record an install (optionally with its marketplace category + seed tags). */
  recordInstall: (slug: string, category?: string, tags?: string[]) => void;
  /** Replace the tag list for a skill (empty array clears it). */
  setTags: (slug: string, tags: string[]) => void;
  /** Flip the favorite flag for a skill. */
  toggleFavorite: (slug: string) => void;
  /** Set (or clear with 0/negative) a 1-5 rating for a skill. */
  setRating: (slug: string, rating: number) => void;
}

type Persisted = Pick<
  SkillMetaState,
  'usage' | 'installedAt' | 'categories' | 'tags' | 'favorites' | 'ratings'
>;

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>;
      return {
        usage: p.usage ?? {},
        installedAt: p.installedAt ?? {},
        categories: p.categories ?? {},
        tags: p.tags ?? {},
        favorites: p.favorites ?? {},
        ratings: p.ratings ?? {},
      };
    }
  } catch {
    // fall through to empty defaults
  }
  return { usage: {}, installedAt: {}, categories: {}, tags: {}, favorites: {}, ratings: {} };
}

function save(state: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage unavailable — silently ignore (best-effort tracking)
  }
}

function pick(state: SkillMetaState): Persisted {
  return {
    usage: state.usage,
    installedAt: state.installedAt,
    categories: state.categories,
    tags: state.tags,
    favorites: state.favorites,
    ratings: state.ratings,
  };
}

export const useSkillMetaStore = create<SkillMetaState>()((set) => ({
  ...load(),

  recordUse: (slug) =>
    set((state) => {
      const usage = { ...state.usage, [slug]: (state.usage[slug] ?? 0) + 1 };
      save({ ...pick(state), usage });
      return { usage };
    }),

  recordInstall: (slug, category, tags) =>
    set((state) => {
      const installedAt = { ...state.installedAt, [slug]: Date.now() };
      const categories = category
        ? { ...state.categories, [slug]: category }
        : state.categories;
      // Seed tags only if the skill has none yet, so we never clobber
      // user-edited tags on a re-install.
      const nextTags = tags && tags.length && !state.tags[slug]?.length
        ? { ...state.tags, [slug]: tags }
        : state.tags;
      save({ ...pick(state), installedAt, categories, tags: nextTags });
      return { installedAt, categories, tags: nextTags };
    }),

  setTags: (slug, tags) =>
    set((state) => {
      const next = { ...state.tags };
      const cleaned = tags.map((x) => x.trim()).filter(Boolean);
      if (cleaned.length) next[slug] = cleaned;
      else delete next[slug];
      save({ ...pick(state), tags: next });
      return { tags: next };
    }),

  toggleFavorite: (slug) =>
    set((state) => {
      const favorites = { ...state.favorites };
      if (favorites[slug]) delete favorites[slug];
      else favorites[slug] = true;
      save({ ...pick(state), favorites });
      return { favorites };
    }),

  setRating: (slug, rating) =>
    set((state) => {
      const ratings = { ...state.ratings };
      if (rating <= 0) delete ratings[slug];
      else ratings[slug] = Math.min(5, Math.max(1, rating));
      save({ ...pick(state), ratings });
      return { ratings };
    }),
}));
