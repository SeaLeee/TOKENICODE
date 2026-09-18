import { create } from 'zustand';
import { bridge, type InstallSkillResult, type SkillHubSkill } from '../lib/tauri-bridge';
import { useSkillStore } from './skillStore';
import { useSkillMetaStore } from './skillMetaStore';
import { useCommandStore } from './commandStore';

export type MarketplaceSort = 'score' | 'downloads' | 'trending';

interface MarketplaceState {
  skills: SkillHubSkill[];
  total: number;
  isLoading: boolean;
  error: string | null;
  installingSlug: string | null;
  keyword: string;
  sortBy: MarketplaceSort;

  /** Search the SkillHub marketplace. */
  search: (keyword: string, sortBy?: MarketplaceSort) => Promise<void>;
  /**
   * Download + install a skill into ~/.claude/skills/<slug>/ and refresh the
   * local installed list. Resolves to the install result on success, or null
   * on failure (with `error` populated for the caller to surface).
   */
  install: (skill: SkillHubSkill, cwd?: string) => Promise<InstallSkillResult | null>;
}

export const useMarketplaceStore = create<MarketplaceState>()((set) => ({
  skills: [],
  total: 0,
  isLoading: false,
  error: null,
  installingSlug: null,
  keyword: '',
  sortBy: 'score',

  search: async (keyword, sortBy = 'score') => {
    set({ isLoading: true, error: null, keyword, sortBy });
    try {
      const result = await bridge.searchSkillHub({
        keyword,
        page: 1,
        pageSize: 30,
        sortBy,
      });
      set({ skills: result.skills ?? [], total: result.total ?? 0, isLoading: false });
    } catch (e) {
      set({ skills: [], total: 0, isLoading: false, error: String(e) });
    }
  },

  install: async (skill, cwd) => {
    set({ installingSlug: skill.slug, error: null });
    try {
      const result = await bridge.installSkill(skill.slug, skill.namespace?.handle);
      // Record install time + category so the input skill picker can surface it
      // as "recently downloaded", and seed tags (category + label keys) so
      // auto-suggestion can match on them.
      const seedTags = [
        skill.category,
        ...(skill.labels && typeof skill.labels === 'object' && !Array.isArray(skill.labels)
          ? Object.keys(skill.labels as Record<string, unknown>)
          : []),
      ].filter((x): x is string => Boolean(x));
      useSkillMetaStore.getState().recordInstall(
        skill.slug,
        skill.category || undefined,
        seedTags,
      );
      // Refresh the local installed list so the panel reflects the new skill immediately.
      await useSkillStore.getState().fetchSkills(cwd);
      // Also refresh the unified command list (powers the input SkillPicker).
      await useCommandStore.getState().fetchCommands(cwd);
      set({ installingSlug: null });
      return result;
    } catch (e) {
      const message = String(e);
      set({ installingSlug: null, error: message });
      return null;
    }
  },
}));
