import { useEffect, useRef, useState } from 'react';
import { useMarketplaceStore, type MarketplaceSort } from '../../stores/marketplaceStore';
import { useSkillStore } from '../../stores/skillStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useCommandStore } from '../../stores/commandStore';
import { useT } from '../../lib/i18n';
import { showToast } from '../shared/Toast';
import type { SkillHubSkill } from '../../lib/tauri-bridge';

const SORT_OPTIONS: { value: MarketplaceSort; labelKey: string }[] = [
  { value: 'score', labelKey: 'marketplace.sort.score' },
  { value: 'downloads', labelKey: 'marketplace.sort.downloads' },
  { value: 'trending', labelKey: 'marketplace.sort.trending' },
];

function formatCount(n: number): string {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** `labels` is an opaque field — SkillHub returns an object like
 *  {"requires_api_key":"false"}. Detect the "needs API key" flag robustly. */
function requiresApiKey(labels: unknown): boolean {
  if (labels && typeof labels === 'object' && !Array.isArray(labels)) {
    const v = (labels as Record<string, unknown>).requires_api_key;
    return v === true || v === 'true';
  }
  if (Array.isArray(labels)) {
    return labels.some((l) => typeof l === 'string' && /api[_ -]?key/i.test(l));
  }
  return false;
}

export function SkillMarketplace() {
  const t = useT();
  const skills = useMarketplaceStore((s) => s.skills);
  const total = useMarketplaceStore((s) => s.total);
  const isLoading = useMarketplaceStore((s) => s.isLoading);
  const error = useMarketplaceStore((s) => s.error);
  const installingSlug = useMarketplaceStore((s) => s.installingSlug);
  const search = useMarketplaceStore((s) => s.search);
  const install = useMarketplaceStore((s) => s.install);
  const sortBy = useMarketplaceStore((s) => s.sortBy);
  const installedSkills = useSkillStore((s) => s.skills);
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  const locale = useSettingsStore((s) => s.locale);

  const [keyword, setKeyword] = useState('');
  const debounceRef = useRef<number | undefined>(undefined);

  // Initial load on mount
  useEffect(() => {
    search('');
    return () => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeywordChange = (value: string) => {
    setKeyword(value);
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => search(value), 300);
  };

  const onSortChange = (value: MarketplaceSort) => {
    search(keyword, value);
  };

  const descriptionOf = (skill: SkillHubSkill) =>
    locale === 'zh' && skill.description_zh ? skill.description_zh : skill.description;

  const isInstalled = (slug: string) => installedSkills.some((s) => s.name === slug);

  const onInstall = async (skill: SkillHubSkill) => {
    const result = await install(skill, workingDirectory || undefined);
    if (result) {
      showToast(t('marketplace.installSuccess').replace('{slug}', result.slug), 'success');
    } else {
      showToast(
        useMarketplaceStore.getState().error || t('marketplace.installFailed'),
        'error',
      );
    }
  };

  // Make an installed skill active in the conversation input: set the slash
  // command prefix so the user's next message invokes the skill.
  const onUse = (skill: SkillHubSkill) => {
    const installedInfo = installedSkills.find((s) => s.name === skill.slug);
    useCommandStore.getState().addPrefix({
      name: `/${skill.slug}`,
      description: descriptionOf(skill),
      source: 'global',
      category: 'skill',
      has_args: true,
      path: installedInfo?.path,
      immediate: false,
    });
    showToast(t('marketplace.useSuccess'), 'success');
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Search + sort */}
      <div className="px-2 py-1.5 space-y-1.5">
        <div className="relative">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5"
            className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary">
            <circle cx="7" cy="7" r="5" />
            <path d="M11 11l3 3" />
          </svg>
          <input
            type="text"
            value={keyword}
            onChange={(e) => onKeywordChange(e.target.value)}
            placeholder={t('marketplace.search')}
            className="w-full pl-7 pr-7 py-1.5 text-xs bg-transparent
              rounded-lg text-text-primary
              placeholder:text-text-tertiary outline-none
              hover:bg-bg-tertiary focus:bg-bg-tertiary
              transition-smooth"
          />
          {keyword && (
            <button
              onClick={() => onKeywordChange('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2
                p-0.5 rounded text-text-tertiary hover:text-text-primary
                transition-smooth"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.5">
                <path d="M2 2l6 6M8 2l-6 6" />
              </svg>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 px-1">
          <select
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value as MarketplaceSort)}
            className="flex-1 px-2 py-1 text-xs bg-transparent rounded-lg
              text-text-secondary outline-none border border-transparent
              hover:border-border-subtle focus:border-border-subtle
              transition-smooth"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value} className="bg-bg-card">
                {t(opt.labelKey)}
              </option>
            ))}
          </select>
          <span className="text-[10px] text-text-tertiary flex-shrink-0">
            {total}
          </span>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-1">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-accent/30
              border-t-accent rounded-full animate-spin" />
          </div>
        ) : error && skills.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8
            text-text-tertiary text-xs gap-2">
            <p className="text-xs text-text-tertiary leading-relaxed">
              {t('marketplace.error')}
            </p>
          </div>
        ) : skills.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8
            text-text-tertiary text-xs gap-2">
            <p className="text-xs text-text-tertiary leading-relaxed">
              {t('marketplace.empty')}
            </p>
          </div>
        ) : (
          skills.map((skill) => (
            <MarketCard
              key={skill.slug}
              skill={skill}
              description={descriptionOf(skill)}
              installed={isInstalled(skill.slug)}
              installing={installingSlug === skill.slug}
              onInstall={onInstall}
              onUse={onUse}
              t={t}
            />
          ))
        )}
      </div>
    </div>
  );
}

function MarketCard({
  skill,
  description,
  installed,
  installing,
  onInstall,
  onUse,
  t,
}: {
  skill: SkillHubSkill;
  description: string;
  installed: boolean;
  installing: boolean;
  onInstall: (skill: SkillHubSkill) => void;
  onUse: (skill: SkillHubSkill) => void;
  t: (key: string) => string;
}) {
  const [iconFailed, setIconFailed] = useState(false);
  const needsApiKey = requiresApiKey(skill.labels);

  return (
    <div className="mx-1.5 mb-1 px-2.5 py-2 rounded-lg border border-transparent
      hover:bg-bg-secondary hover:border-border-subtle transition-smooth">
      {/* Row 1: icon + name + badges + install */}
      <div className="flex items-center gap-2">
        {skill.iconUrl && !iconFailed ? (
          <img
            src={skill.iconUrl}
            alt=""
            onError={() => setIconFailed(true)}
            className="w-7 h-7 rounded-md object-cover flex-shrink-0 bg-bg-tertiary"
          />
        ) : (
          <div className="w-7 h-7 rounded-md flex items-center justify-center
            bg-accent/10 flex-shrink-0">
            <svg width="14" height="14" viewBox="0 0 12 12" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"
              className="text-accent">
              <path d="M6 1l5 5-5 5-5-5z" />
            </svg>
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] text-text-primary truncate">{skill.name}</span>
            {skill.verified && (
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"
                className="text-accent flex-shrink-0">
                <title>{t('marketplace.verified')}</title>
                <path d="M8 1l2 1.5L12.5 2l.5 2.5L15.5 6l-2 1.5L14 10l-2.5.5L10 13l-2-.8L6 13l-1.5-2.5L2 10l1-2.5L1.5 6l2-1.5L4 2l2.5.5L8 1z" />
              </svg>
            )}
            {needsApiKey && (
              <span className="px-1 py-0.5 text-[8px] rounded bg-yellow-500/20
                text-yellow-400 font-medium flex-shrink-0">
                {t('marketplace.requiresApiKey')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-[9px] text-text-tertiary mt-0.5">
            <span title={t('marketplace.score')}>★ {skill.score?.toFixed(1) ?? '0'}</span>
            <span>↓ {formatCount(skill.downloads ?? 0)}</span>
            {skill.category ? <span className="truncate">{skill.category}</span> : null}
          </div>
        </div>

        <button
          onClick={() => (installed ? onUse(skill) : onInstall(skill))}
          disabled={installing}
          className={`flex-shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-medium
            transition-smooth ${
              installed
                ? 'bg-accent text-white hover:bg-accent/90'
                : 'bg-accent/15 text-accent hover:bg-accent/25'
            }`}
        >
          {installing ? (
            <span className="inline-flex items-center gap-1">
              <span className="w-3 h-3 border-2 border-accent/30 border-t-accent
                rounded-full animate-spin" />
            </span>
          ) : installed ? (
            t('marketplace.use')
          ) : (
            t('marketplace.install')
          )}
        </button>
      </div>

      {/* Row 2: description */}
      {description && (
        <p className="text-xs text-text-muted mt-1.5 line-clamp-2 leading-relaxed pl-9">
          {description}
        </p>
      )}
    </div>
  );
}
