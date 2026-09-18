import { useEffect, useMemo, useRef, useState } from 'react';
import { useCommandStore } from '../../stores/commandStore';
import { useSkillMetaStore } from '../../stores/skillMetaStore';
import { useT } from '../../lib/i18n';
import { inferSkillCategory, CATEGORY_ORDER, type SkillCategoryId } from '../../lib/skill-category';
import type { UnifiedCommand } from '../../lib/tauri-bridge';

interface SkillPickerProps {
  onSelect: (skill: UnifiedCommand) => void;
  onClose: () => void;
}

/**
 * A dedicated "add a skill" popover for the input bar. Unlike the slash-command
 * popover (which is triggered by typing "/" and mixes built-in commands with
 * skills), this surfaces ONLY installed skills so the user can attach one to
 * the conversation without knowing the slash gesture.
 *
 * Layout: a wide two-column item grid grouped as
 *   我的技能 (custom-folder skills) → 收藏 → 常用 → per-category (inferred),
 * so many more skills are visible at once, each with a favorite toggle and a
 * hover tooltip carrying the full description.
 */
export function SkillPicker({ onSelect, onClose }: SkillPickerProps) {
  const t = useT();
  const commands = useCommandStore((s) => s.commands);
  const activePrefixes = useCommandStore((s) => s.activePrefixes);
  const usage = useSkillMetaStore((s) => s.usage);
  const tags = useSkillMetaStore((s) => s.tags);
  const favorites = useSkillMetaStore((s) => s.favorites);
  const ratings = useSkillMetaStore((s) => s.ratings);
  const toggleFavorite = useSkillMetaStore((s) => s.toggleFavorite);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const slugOf = (s: UnifiedCommand) => s.name.replace(/^\//, '');

  // Names already attached to the input, so the picker can mark them as added.
  const addedNames = useMemo(
    () => new Set(activePrefixes.map((p) => p.name)),
    [activePrefixes],
  );

  const skills = useMemo(
    () => commands.filter((c) => c.category === 'skill'),
    [commands],
  );

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (tags[slugOf(s)] ?? []).some((tag) => tag.toLowerCase().includes(q)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skills, query, tags]);

  const sections = useMemo(() => {
    const byUsage = (a: UnifiedCommand, b: UnifiedCommand) => {
      const ub = usage[slugOf(b)] ?? 0;
      const ua = usage[slugOf(a)] ?? 0;
      if (ub !== ua) return ub - ua;
      return a.name.localeCompare(b.name);
    };
    const isFav = (s: UnifiedCommand) =>
      Boolean(favorites[slugOf(s)]) || (ratings[slugOf(s)] ?? 0) >= 4;

    const mine: UnifiedCommand[] = [];
    const favs: UnifiedCommand[] = [];
    const frequent: UnifiedCommand[] = [];
    const byCategory = new Map<SkillCategoryId, UnifiedCommand[]>();

    for (const s of filtered) {
      if (s.source === 'custom') { mine.push(s); continue; }
      if (isFav(s)) { favs.push(s); continue; }
      if ((usage[slugOf(s)] ?? 0) > 0) { frequent.push(s); continue; }
      const cat = inferSkillCategory(slugOf(s), s.description, tags[slugOf(s)]);
      const arr = byCategory.get(cat);
      if (arr) arr.push(s);
      else byCategory.set(cat, [s]);
    }

    mine.sort(byUsage);
    favs.sort((a, b) => (ratings[slugOf(b)] ?? 0) - (ratings[slugOf(a)] ?? 0) || byUsage(a, b));
    frequent.sort(byUsage);

    const categoryGroups = CATEGORY_ORDER
      .filter((id) => byCategory.has(id))
      .map((id) => ({
        key: id as string,
        label: t(`skillCategory.${id}`),
        skills: [...byCategory.get(id)!].sort((a, b) => a.name.localeCompare(b.name)),
      }));

    const result: { key: string; label: string; skills: UnifiedCommand[] }[] = [];
    if (mine.length) result.push({ key: '__mine__', label: t('skills.mine'), skills: mine });
    if (favs.length) result.push({ key: '__fav__', label: t('skills.favorites'), skills: favs });
    if (frequent.length) result.push({ key: '__freq__', label: t('skills.frequent'), skills: frequent });
    return [...result, ...categoryGroups];
  }, [filtered, usage, tags, favorites, ratings, t]);

  // Autofocus search on open
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Close on Escape (outside-click is handled by the parent so the toggle
  // button itself isn't mistaken for an "outside" click)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="absolute bottom-full left-0 mb-1 w-[520px] max-w-[92vw]
        bg-bg-card border border-border-subtle rounded-xl shadow-lg py-1 z-50
        animate-in fade-in slide-in-from-bottom-2 duration-150"
    >
      {/* Search */}
      <div className="px-2 pt-1 pb-1.5">
        <div className="relative">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5"
            className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary">
            <circle cx="7" cy="7" r="5" />
            <path d="M11 11l3 3" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('skills.search')}
            className="w-full pl-7 pr-3 py-1.5 text-xs bg-bg-tertiary
              rounded-lg text-text-primary placeholder:text-text-tertiary
              outline-none transition-smooth"
          />
        </div>
      </div>

      <div className="max-h-[420px] overflow-y-auto px-1 pb-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-5 text-center text-xs text-text-tertiary leading-relaxed">
            {skills.length === 0 ? t('skillPicker.empty') : t('marketplace.empty')}
          </div>
        ) : (
          sections.map(({ key, label, skills: groupSkills }) => (
            <SkillSection
              key={key}
              label={label}
              count={groupSkills.length}
              skills={groupSkills}
              addedNames={addedNames}
              favorites={favorites}
              onSelect={onSelect}
              onToggleFavorite={(slug) => toggleFavorite(slug)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SkillSection({
  label,
  count,
  skills,
  addedNames,
  favorites,
  onSelect,
  onToggleFavorite,
}: {
  label: string;
  count: number;
  skills: UnifiedCommand[];
  addedNames: Set<string>;
  favorites: Record<string, boolean>;
  onSelect: (skill: UnifiedCommand) => void;
  onToggleFavorite: (slug: string) => void;
}) {
  return (
    <div className="mb-1">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <span className="text-[11px] text-text-tertiary font-medium uppercase tracking-wider">
          {label}
        </span>
        <span className="text-[10px] text-text-tertiary/70">{count}</span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {skills.map((skill) => (
          <SkillItem
            key={`${skill.source}-${skill.name}`}
            skill={skill}
            added={addedNames.has(skill.name)}
            favorite={Boolean(favorites[skill.name.replace(/^\//, '')])}
            onSelect={onSelect}
            onToggleFavorite={onToggleFavorite}
          />
        ))}
      </div>
    </div>
  );
}

function SkillItem({
  skill,
  added,
  favorite,
  onSelect,
  onToggleFavorite,
}: {
  skill: UnifiedCommand;
  added: boolean;
  favorite: boolean;
  onSelect: (skill: UnifiedCommand) => void;
  onToggleFavorite: (slug: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const slug = skill.name.replace(/^\//, '');

  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={() => onSelect(skill)}
        className={`w-full text-left px-2 py-1.5 flex items-start gap-2 rounded-lg
          transition-smooth hover:bg-bg-secondary border border-transparent
          hover:border-border-subtle ${added ? 'opacity-60' : ''}`}
      >
        <span className="flex-shrink-0 w-6 h-6 mt-0.5 rounded-lg bg-bg-tertiary
          flex items-center justify-center text-accent">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1l2.5 5 5.5.8-4 3.9.9 5.3L8 13.3 3.1 16l.9-5.3-4-3.9L5.5 6z" />
          </svg>
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <span className="font-medium font-mono text-[12px] text-text-primary truncate">
              {skill.name}
            </span>
            {skill.source === 'custom' && (
              <span className="flex-shrink-0 px-1 rounded text-[8px] font-bold
                bg-amber-400/20 text-amber-500">C</span>
            )}
          </div>
          <div className="text-text-tertiary text-[11px] truncate mt-0.5">
            {skill.description}
          </div>
        </div>
        {added && (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            strokeLinejoin="round" className="text-accent flex-shrink-0 mt-1">
            <path d="M3 8l3 3 7-7" />
          </svg>
        )}
      </button>

      {/* Favorite star — top-right, appears on hover or when favorited */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggleFavorite(slug); }}
        className={`absolute top-1 right-1 p-0.5 rounded transition-smooth
          ${favorite ? 'text-amber-400' : 'text-text-tertiary opacity-0'}
          ${hovered ? 'opacity-100' : ''}`}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill={favorite ? 'currentColor' : 'none'}
          stroke="currentColor" strokeWidth="1.5">
          <path d="M8 1l2.5 5 5.5.8-4 3.9.9 5.3L8 13.3 3.1 16l.9-5.3-4-3.9L5.5 6z" />
        </svg>
      </button>

      {/* Hover tooltip — full description */}
      {hovered && (
        <div className="absolute left-1 right-1 top-full mt-0.5 z-50 p-2.5
          rounded-lg border border-border-subtle bg-bg-card shadow-lg
          pointer-events-none animate-fade-in">
          <div className="text-[12px] font-medium text-text-primary mb-1">{skill.name}</div>
          <p className="text-[11px] text-text-muted leading-relaxed">{skill.description}</p>
        </div>
      )}
    </div>
  );
}
