import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSkillStore } from '../../stores/skillStore';
import { useSkillMetaStore } from '../../stores/skillMetaStore';
import { SkillMarketplace } from './SkillMarketplace';
import { useFileStore } from '../../stores/fileStore';
import { useCommandStore } from '../../stores/commandStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { bridge } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { showToast } from '../shared/Toast';
import { inferSkillCategory, CATEGORY_ORDER } from '../../lib/skill-category';
import type { SkillInfo } from '../../lib/tauri-bridge';

/** SkillInfo.name carries no leading slash — it *is* the slug used by skillMetaStore. */
const slugOf = (skill: SkillInfo) => skill.name;

export function SkillsPanel() {
  const t = useT();
  const skills = useSkillStore((s) => s.skills);
  const isLoading = useSkillStore((s) => s.isLoading);
  const fetchSkills = useSkillStore((s) => s.fetchSkills);
  const deleteSkill = useSkillStore((s) => s.deleteSkill);
  const toggleEnabled = useSkillStore((s) => s.toggleEnabled);
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  const customSkillDirs = useSettingsStore((s) => s.customSkillDirs);
  const addCustomSkillDir = useSettingsStore((s) => s.addCustomSkillDir);
  const removeCustomSkillDir = useSettingsStore((s) => s.removeCustomSkillDir);
  const selectFile = useFileStore((s) => s.selectFile);
  const selectedFile = useFileStore((s) => s.selectedFile);
  const tags = useSkillMetaStore((s) => s.tags);
  const favorites = useSkillMetaStore((s) => s.favorites);
  const ratings = useSkillMetaStore((s) => s.ratings);
  const toggleFavorite = useSkillMetaStore((s) => s.toggleFavorite);
  const setRating = useSkillMetaStore((s) => s.setRating);
  const setTags = useSkillMetaStore((s) => s.setTags);

  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<'installed' | 'marketplace'>('installed');

  // Larger detail panel opened by clicking a skill card
  const [detailSkill, setDetailSkill] = useState<SkillInfo | null>(null);

  // Context menu (triggered by "..." button)
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    skill: SkillInfo;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Fetch skills on mount and when working directory changes
  useEffect(() => {
    fetchSkills(workingDirectory || undefined);
  }, [workingDirectory, fetchSkills]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  // Close context menu on Escape
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [contextMenu]);

  // Filter skills by search query
  const filteredSkills = skills.filter((s) =>
    s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    s.description.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const sortByName = (a: SkillInfo, b: SkillInfo) =>
    a.name.localeCompare(b.name, 'zh-Hans-CN');

  // Custom-folder skills float to a dedicated "我的技能" group at the very top.
  const customSkills = filteredSkills
    .filter((s) => s.scope === 'custom')
    .sort(sortByName);

  // A skill is "starred" if the user favorited it, or rated it >= 4 — these
  // surface in a dedicated group ahead of the category-sorted rest.
  const isStarred = (s: SkillInfo) =>
    Boolean(favorites[slugOf(s)]) || (ratings[slugOf(s)] ?? 0) >= 4;

  const starredSkills = filteredSkills
    .filter((s) => s.scope !== 'custom' && isStarred(s))
    .sort((a, b) => {
      const rb = ratings[slugOf(b)] ?? 0;
      const ra = ratings[slugOf(a)] ?? 0;
      if (rb !== ra) return rb - ra;
      const fb = favorites[slugOf(b)] ? 1 : 0;
      const fa = favorites[slugOf(a)] ? 1 : 0;
      if (fb !== fa) return fb - fa;
      return sortByName(a, b);
    });

  // Remaining skills grouped by inferred functional category (name + description
  // + tags), so e.g. storyboard / 分镜 skills land in 影视 rather than 其他.
  const byCategory = new Map<string, SkillInfo[]>();
  for (const s of filteredSkills) {
    if (s.scope === 'custom' || isStarred(s)) continue;
    const cat = inferSkillCategory(slugOf(s), s.description, tags[slugOf(s)]);
    const arr = byCategory.get(cat);
    if (arr) arr.push(s);
    else byCategory.set(cat, [s]);
  }
  const categoryGroups = CATEGORY_ORDER
    .filter((id) => byCategory.has(id))
    .map((id) => ({
      label: t(`skillCategory.${id}`),
      skills: [...byCategory.get(id)!].sort(sortByName),
    }));

  const handleAddFolder = useCallback(async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, multiple: false, title: t('skills.addFolder') });
    if (typeof picked === 'string') {
      addCustomSkillDir(picked);
      try {
        const imported = await bridge.importCustomSkills(picked);
        if (imported.length > 0) {
          showToast(t('skills.importSuccess').replace('{names}', imported.join(', ')), 'success');
        }
      } catch (err) {
        console.error('Failed to import custom skills:', err);
        showToast(t('skills.importFailed') + ': ' + String(err), 'error');
      }
      await fetchSkills(workingDirectory || undefined);
      await useCommandStore.getState().fetchCommands(workingDirectory || undefined);
    }
  }, [t, addCustomSkillDir, fetchSkills, workingDirectory]);

  const handleRemoveFolder = useCallback(async (dir: string) => {
    removeCustomSkillDir(dir);
    await fetchSkills(workingDirectory || undefined);
    await useCommandStore.getState().fetchCommands(workingDirectory || undefined);
  }, [removeCustomSkillDir, fetchSkills, workingDirectory]);

  const handleSelect = useCallback((skill: SkillInfo) => {
    setDetailSkill(skill);
  }, []);

  const handleOpenMenu = useCallback((e: React.MouseEvent, skill: SkillInfo) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const menuWidth = 180;
    const menuHeight = 220; // approximate height of 5 menu items
    let x = rect.left;
    let y = rect.bottom + 4;
    // Keep menu within viewport horizontally
    if (x + menuWidth > window.innerWidth) {
      x = rect.right - menuWidth;
    }
    // Keep menu within viewport vertically
    if (y + menuHeight > window.innerHeight) {
      y = rect.top - menuHeight - 4;
    }
    setContextMenu({ x, y, skill });
  }, []);

  const handleUseInInput = useCallback((skill: SkillInfo) => {
    setContextMenu(null);
    useCommandStore.getState().addPrefix({
      name: `/${skill.name}`,
      description: skill.description,
      source: skill.scope,
      category: 'skill' as const,
      has_args: true,
      path: skill.path,
      immediate: false,
    });
  }, []);

  const handleEdit = useCallback((skill: SkillInfo) => {
    setContextMenu(null);
    setDetailSkill(null);
    selectFile(skill.path);
  }, [selectFile]);

  const handleDuplicate = useCallback(async (skill: SkillInfo) => {
    setContextMenu(null);
    try {
      const content = await bridge.readSkill(skill.path);
      const copyName = `${skill.name}-copy`;
      // Derive new path: replace the skill directory name
      const parentDir = skill.path.replace(/\/[^/]+\/SKILL\.md$/, '');
      const newPath = `${parentDir}/${copyName}/SKILL.md`;
      await bridge.writeSkill(newPath, content);
      await fetchSkills(workingDirectory || undefined);
    } catch (e) {
      console.error('Failed to duplicate skill:', e);
    }
  }, [fetchSkills, workingDirectory]);

  const handleRevealInFinder = useCallback((skill: SkillInfo) => {
    setContextMenu(null);
    bridge.revealInFinder(skill.path);
  }, []);

  const handleDelete = useCallback(async (skill: SkillInfo) => {
    setContextMenu(null);
    if (confirm(t('skills.confirmDelete'))) {
      if (detailSkill?.path === skill.path) setDetailSkill(null);
      await deleteSkill(skill);
    }
  }, [deleteSkill, t, detailSkill]);

  // Skill count
  const totalCount = filteredSkills.length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5"
            className="text-accent flex-shrink-0">
            <path d="M8 1L1 4.5l7 3.5 7-3.5L8 1zM1 11.5l7 3.5 7-3.5M1 8l7 3.5L15 8" />
          </svg>
          <span className="text-[13px] font-medium text-text-primary">
            {t('skills.title')}
          </span>
          <span className="text-xs text-text-muted flex-shrink-0">
            {totalCount}
          </span>
        </div>
        <button
          onClick={() => fetchSkills(workingDirectory || undefined)}
          className="p-1.5 rounded-lg hover:bg-bg-secondary
            text-text-tertiary transition-smooth"
          title={t('skills.refresh')}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5">
            <path d="M1 6a5 5 0 019-2M11 6a5 5 0 01-9 2" />
            <path d="M10 1v3h-3M2 11V8h3" />
          </svg>
        </button>
      </div>

      {/* View switcher: installed / marketplace */}
      <div className="flex mx-2 mb-1 p-0.5 rounded-lg bg-bg-secondary/60">
        <button
          onClick={() => setView('installed')}
          className={`flex-1 py-1 rounded-md text-xs transition-smooth ${
            view === 'installed'
              ? 'bg-bg-card text-text-primary shadow-sm'
              : 'text-text-tertiary hover:text-text-primary'
          }`}
        >
          {t('skills.installed')}
        </button>
        <button
          onClick={() => setView('marketplace')}
          className={`flex-1 py-1 rounded-md text-xs transition-smooth ${
            view === 'marketplace'
              ? 'bg-bg-card text-text-primary shadow-sm'
              : 'text-text-tertiary hover:text-text-primary'
          }`}
        >
          {t('skills.marketplace')}
        </button>
      </div>

      {view === 'installed' ? (
        <>
          {/* Custom skill folders — add / list / remove */}
          <div className="px-2 pt-1 pb-0.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-text-tertiary font-medium">
                {t('skills.customFolders')}
              </span>
              <button
                onClick={handleAddFolder}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px]
                  text-text-tertiary hover:text-text-primary hover:bg-bg-secondary transition-smooth"
                title={t('skills.addFolderHint')}
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M8 3v10M3 8h10" />
                </svg>
                {t('skills.addFolder')}
              </button>
            </div>
            {customSkillDirs.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {customSkillDirs.map((dir) => (
                  <div
                    key={dir}
                    className="flex items-center gap-1.5 px-1.5 py-1 rounded-md
                      bg-bg-secondary/50 group/dir"
                  >
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
                      stroke="currentColor" strokeWidth="1.5"
                      className="text-amber-500 flex-shrink-0">
                      <path d="M2 4h4l1.5 2H14v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" />
                    </svg>
                    <span className="flex-1 min-w-0 text-[10px] text-text-tertiary truncate" title={dir}>
                      {dir}
                    </span>
                    <button
                      onClick={() => handleRemoveFolder(dir)}
                      className="flex-shrink-0 p-0.5 rounded text-text-tertiary
                        opacity-0 group-hover/dir:opacity-100 hover:text-error transition-smooth"
                      title={t('skills.removeFolder')}
                    >
                      <svg width="9" height="9" viewBox="0 0 10 10" fill="none"
                        stroke="currentColor" strokeWidth="1.5">
                        <path d="M2 2l6 6M8 2l-6 6" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Search bar — borderless, hover 较深底色 */}
          <div className="px-2 py-1.5">
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
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('skills.search')}
            className="w-full pl-7 pr-7 py-1.5 text-xs bg-transparent
              rounded-lg text-text-primary
              placeholder:text-text-tertiary outline-none
              hover:bg-bg-tertiary focus:bg-bg-tertiary
              transition-smooth"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
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
      </div>

      {/* Skills list */}
      <div className="flex-1 overflow-y-auto py-1">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-accent/30
              border-t-accent rounded-full animate-spin" />
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8
            text-text-tertiary text-xs gap-2">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none"
              stroke="currentColor" strokeWidth="1.2"
              className="text-text-tertiary/40">
              <path d="M16 4L4 10l12 6 12-6L16 4zM4 22l12 6 12-6M4 16l12 6 12-6" />
            </svg>
            <p className="text-xs text-text-tertiary leading-relaxed">
              {searchQuery ? 'No matching skills' : t('skills.empty')}
            </p>
          </div>
        ) : (
          <>
            {customSkills.length > 0 && (
              <SkillGroup
                label={t('skills.mine')}
                skills={customSkills}
                selectedFile={selectedFile}
                onSelect={handleSelect}
                onOpenMenu={handleOpenMenu}
                onToggleEnabled={toggleEnabled}
                favorites={favorites}
                ratings={ratings}
                tags={tags}
                onToggleFavorite={toggleFavorite}
                onSetRating={setRating}
                t={t}
              />
            )}
            {starredSkills.length > 0 && (
              <SkillGroup
                label={t('skills.favorites')}
                skills={starredSkills}
                selectedFile={selectedFile}
                onSelect={handleSelect}
                onOpenMenu={handleOpenMenu}
                onToggleEnabled={toggleEnabled}
                favorites={favorites}
                ratings={ratings}
                tags={tags}
                onToggleFavorite={toggleFavorite}
                onSetRating={setRating}
                t={t}
              />
            )}
            {categoryGroups.map(({ label, skills: groupSkills }) => (
              <SkillGroup
                key={label}
                label={label}
                skills={groupSkills}
                selectedFile={selectedFile}
                onSelect={handleSelect}
                onOpenMenu={handleOpenMenu}
                onToggleEnabled={toggleEnabled}
                favorites={favorites}
                ratings={ratings}
                tags={tags}
                onToggleFavorite={toggleFavorite}
                onSetRating={setRating}
                t={t}
              />
            ))}
          </>
        )}
      </div>
        </>
      ) : (
        <SkillMarketplace />
      )}

      {/* Context menu — rendered via portal to escape overflow-hidden + backdrop-filter ancestors */}
      {contextMenu && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] min-w-[180px] py-1 rounded-xl border border-border-subtle
            bg-bg-card shadow-lg animate-fade-in"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {/* Use in Input */}
          <button
            onClick={() => handleUseInInput(contextMenu.skill)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary
              hover:bg-bg-secondary transition-smooth text-left"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
              className="text-text-tertiary flex-shrink-0">
              <path d="M12 9v4H4V5h4" />
              <path d="M8 8l6-6M10 2h4v4" />
            </svg>
            {t('skills.useInInput')}
          </button>

          {/* Edit */}
          <button
            onClick={() => handleEdit(contextMenu.skill)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary
              hover:bg-bg-secondary transition-smooth text-left"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
              className="text-text-tertiary flex-shrink-0">
              <path d="M11.5 1.5l3 3L5 14H2v-3l9.5-9.5z" />
            </svg>
            {t('skills.edit')}
          </button>

          {/* Duplicate */}
          <button
            onClick={() => handleDuplicate(contextMenu.skill)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary
              hover:bg-bg-secondary transition-smooth text-left"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
              className="text-text-tertiary flex-shrink-0">
              <rect x="5" y="5" width="9" height="9" rx="1.5" />
              <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" />
            </svg>
            {t('skills.duplicate')}
          </button>

          {/* Reveal in Finder */}
          <button
            onClick={() => handleRevealInFinder(contextMenu.skill)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary
              hover:bg-bg-secondary transition-smooth text-left"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
              className="text-text-tertiary flex-shrink-0">
              <path d="M2 4h5l2 2h5v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" />
            </svg>
            {t('skills.revealInFinder')}
          </button>

          <div className="my-1 border-t border-border-subtle" />

          {/* Delete */}
          <button
            onClick={() => handleDelete(contextMenu.skill)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-error
              hover:bg-error/10 transition-smooth text-left"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5"
              strokeLinecap="round" strokeLinejoin="round"
              className="flex-shrink-0">
              <path d="M2 4h12M5.333 4V2.667a1.333 1.333 0 011.334-1.334h2.666a1.333 1.333 0 011.334 1.334V4m2 0v9.333a1.333 1.333 0 01-1.334 1.334H4.667a1.333 1.333 0 01-1.334-1.334V4h9.334z" />
            </svg>
            {t('skills.delete')}
          </button>
        </div>,
        document.body
      )}

      {/* Detail panel — larger view opened by clicking a skill card, with
          category/rating info, favorite toggle and quick actions. */}
      {detailSkill && (
        <SkillDetailModal
          skill={detailSkill}
          category={t(`skillCategory.${inferSkillCategory(slugOf(detailSkill), detailSkill.description, tags[slugOf(detailSkill)])}`)}
          favorite={Boolean(favorites[slugOf(detailSkill)])}
          rating={ratings[slugOf(detailSkill)] ?? 0}
          tags={tags[slugOf(detailSkill)] ?? []}
          onSetTags={(next) => setTags(slugOf(detailSkill), next)}
          onToggleFavorite={() => toggleFavorite(slugOf(detailSkill))}
          onSetRating={(r) => setRating(slugOf(detailSkill), r)}
          onClose={() => setDetailSkill(null)}
          onUseInInput={() => { handleUseInInput(detailSkill); setDetailSkill(null); }}
          onEdit={() => handleEdit(detailSkill)}
          t={t}
        />
      )}
    </div>
  );
}

/* Larger detail panel for a single skill — rendered as a centered modal so
   there's much more room than the narrow sidebar list affords. */
function SkillDetailModal({
  skill,
  category,
  favorite,
  rating,
  tags,
  onSetTags,
  onToggleFavorite,
  onSetRating,
  onClose,
  onUseInInput,
  onEdit,
  t,
}: {
  skill: SkillInfo;
  category: string;
  favorite: boolean;
  rating: number;
  tags: string[];
  onSetTags: (tags: string[]) => void;
  onToggleFavorite: () => void;
  onSetRating: (rating: number) => void;
  onClose: () => void;
  onUseInInput: () => void;
  onEdit: () => void;
  t: (key: string) => string;
}) {
  const [tagDraft, setTagDraft] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const addTag = () => {
    const v = tagDraft.trim();
    if (!v) return;
    if (!tags.includes(v)) onSetTags([...tags, v]);
    setTagDraft('');
  };
  const removeTag = (tag: string) => onSetTags(tags.filter((x) => x !== tag));

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center
        bg-black/40 animate-fade-in"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[640px] max-w-[90vw] max-h-[80vh] flex flex-col
          bg-bg-card border border-border-subtle rounded-2xl shadow-lg overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-border-subtle">
          <span className="flex-shrink-0 w-9 h-9 rounded-xl bg-accent/10
            flex items-center justify-center text-accent mt-0.5">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1l2.5 5 5.5.8-4 3.9.9 5.3L8 13.3 3.1 16l.9-5.3-4-3.9L5.5 6z" />
            </svg>
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-medium text-text-primary truncate">
                {skill.name}
              </h2>
              <span className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold
                ${skill.scope === 'global' ? 'bg-blue-500/20 text-blue-400'
                  : skill.scope === 'custom' ? 'bg-amber-400/20 text-amber-500'
                  : 'bg-green-500/20 text-green-400'}`}>
                {skill.scope === 'global' ? t('skills.global')
                  : skill.scope === 'custom' ? t('skills.mine')
                  : t('skills.project')}
              </span>
              {category && (
                <span className="flex-shrink-0 px-1.5 py-0.5 rounded text-[9px] font-medium
                  bg-bg-secondary text-text-tertiary">
                  {category}
                </span>
              )}
            </div>
            <p className="text-xs text-text-muted mt-1.5 leading-relaxed">
              {skill.description}
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex-shrink-0 p-1 rounded-lg text-text-tertiary
              hover:text-text-primary hover:bg-bg-secondary transition-smooth"
            title={t('skills.detailClose')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Favorite + rating */}
          <div className="flex items-center gap-4">
            <button
              onClick={onToggleFavorite}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs
                border transition-smooth
                ${favorite
                  ? 'border-amber-400/40 bg-amber-400/10 text-amber-400'
                  : 'border-border-subtle text-text-tertiary hover:text-text-primary'
                }`}
              title={favorite ? t('skills.removeFavorite') : t('skills.addFavorite')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill={favorite ? 'currentColor' : 'none'}
                stroke="currentColor" strokeWidth="1.5">
                <path d="M8 1l2.5 5 5.5.8-4 3.9.9 5.3L8 13.3 3.1 16l.9-5.3-4-3.9L5.5 6z" />
              </svg>
              {favorite ? t('skills.removeFavorite') : t('skills.addFavorite')}
            </button>
            <div className="flex items-center gap-1">
              <span className="text-xs text-text-tertiary mr-1">{t('skills.rating')}</span>
              <StarRating rating={rating} onSetRating={onSetRating} size={16} />
            </div>
          </div>

          {/* Tags — editable; also boost auto-suggestion relevance */}
          <div>
            <div className="text-[11px] font-medium text-text-tertiary uppercase tracking-wider mb-1.5">
              {t('skills.tags')}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md
                    bg-bg-secondary text-text-secondary"
                >
                  {tag}
                  <button
                    onClick={() => removeTag(tag)}
                    className="hover:text-error transition-smooth"
                    title={t('skills.removeTag')}
                  >
                    <svg width="8" height="8" viewBox="0 0 10 10" fill="none"
                      stroke="currentColor" strokeWidth="1.5">
                      <path d="M2 2l6 6M8 2l-6 6" />
                    </svg>
                  </button>
                </span>
              ))}
              <input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); addTag(); }
                  else if (e.key === 'Backspace' && !tagDraft && tags.length) removeTag(tags[tags.length - 1]);
                }}
                onBlur={addTag}
                placeholder={t('skills.addTag')}
                className="flex-1 min-w-[100px] px-2 py-1 text-[11px] bg-transparent
                  rounded-md text-text-primary placeholder:text-text-tertiary
                  outline-none hover:bg-bg-tertiary focus:bg-bg-tertiary transition-smooth"
              />
            </div>
          </div>

          {/* Tools */}
          {skill.allowed_tools && skill.allowed_tools.length > 0 && (
            <div>
              <div className="text-[11px] font-medium text-text-tertiary uppercase tracking-wider mb-1.5">
                {t('skills.tools')}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {skill.allowed_tools.map((tool) => (
                  <span key={tool} className="px-2 py-1 text-[11px] rounded-md bg-accent/10 text-accent font-medium">
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Metadata */}
          {(skill.model || skill.context || skill.version || skill.agent) && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              {skill.model && (
                <div><span className="text-text-tertiary">{t('skills.model')}: </span><span className="text-text-primary">{skill.model}</span></div>
              )}
              {skill.context && (
                <div><span className="text-text-tertiary">{t('skills.context')}: </span><span className="text-text-primary">{skill.context}</span></div>
              )}
              {skill.version && (
                <div><span className="text-text-tertiary">{t('skills.version')}: </span><span className="text-text-primary">{skill.version}</span></div>
              )}
              {skill.agent && (
                <div><span className="text-text-tertiary">Agent: </span><span className="text-text-primary">{skill.agent}</span></div>
              )}
            </div>
          )}

          {/* Path */}
          <div className="text-[11px] text-text-tertiary font-mono break-all">
            {skill.path}
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-subtle">
          <button
            onClick={onEdit}
            className="px-3 py-1.5 rounded-lg text-xs text-text-primary
              border border-border-subtle hover:bg-bg-secondary transition-smooth"
          >
            {t('skills.edit')}
          </button>
          <button
            onClick={onUseInInput}
            className="px-3 py-1.5 rounded-lg text-xs text-text-inverse
              bg-accent hover:bg-accent-hover transition-smooth"
          >
            {t('skills.useInInput')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/* Compact 1-5 star rating control, shared by the card and the detail panel. */
function StarRating({
  rating,
  onSetRating,
  size = 12,
}: {
  rating: number;
  onSetRating: (rating: number) => void;
  size?: number;
}) {
  return (
    <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          onClick={() => onSetRating(rating === n ? 0 : n)}
          className="text-amber-400 hover:scale-110 transition-transform"
          title={`${n}`}
        >
          <svg width={size} height={size} viewBox="0 0 16 16" fill={n <= rating ? 'currentColor' : 'none'}
            stroke="currentColor" strokeWidth="1.2">
            <path d="M8 1l2.5 5 5.5.8-4 3.9.9 5.3L8 13.3 3.1 16l.9-5.3-4-3.9L5.5 6z" />
          </svg>
        </button>
      ))}
    </div>
  );
}

/* Collapsible skill group */
function SkillGroup({
  label,
  skills,
  selectedFile,
  onSelect,
  onOpenMenu,
  onToggleEnabled,
  favorites,
  ratings,
  tags,
  onToggleFavorite,
  onSetRating,
  t,
}: {
  label: string;
  skills: SkillInfo[];
  selectedFile: string | null;
  onSelect: (skill: SkillInfo) => void;
  onOpenMenu: (e: React.MouseEvent, skill: SkillInfo) => void;
  onToggleEnabled: (skill: SkillInfo) => void;
  favorites: Record<string, boolean>;
  ratings: Record<string, number>;
  tags: Record<string, string[]>;
  onToggleFavorite: (slug: string) => void;
  onSetRating: (slug: string, rating: number) => void;
  t: (key: string) => string;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="mb-1">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-3 py-1.5
          hover:bg-bg-secondary/50 rounded-lg transition-smooth"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          className={`text-text-tertiary transition-transform
            ${collapsed ? '' : 'rotate-90'}`}>
          <path d="M3 1l4 4-4 4" />
        </svg>
        <span className="text-xs font-medium text-text-tertiary uppercase tracking-wider flex-1 text-left">
          {label}
        </span>
        <span className="text-xs text-text-tertiary flex-shrink-0">
          {skills.length}
        </span>
      </button>

      {!collapsed && skills.map((skill) => (
        <SkillCard
          key={skill.path}
          skill={skill}
          isSelected={selectedFile === skill.path}
          onSelect={onSelect}
          onOpenMenu={onOpenMenu}
          onToggleEnabled={onToggleEnabled}
          favorite={Boolean(favorites[slugOf(skill)])}
          rating={ratings[slugOf(skill)] ?? 0}
          tags={tags[slugOf(skill)] ?? []}
          onToggleFavorite={onToggleFavorite}
          onSetRating={onSetRating}
          t={t}
        />
      ))}
    </div>
  );
}

/* Skill card — richer display with tools, metadata, toggle, favorite/rating
   and a hover tooltip with the full description. */
function SkillCard({
  skill,
  isSelected,
  onSelect,
  onOpenMenu,
  onToggleEnabled,
  favorite,
  rating,
  tags,
  onToggleFavorite,
  onSetRating,
  t,
}: {
  skill: SkillInfo;
  isSelected: boolean;
  onSelect: (skill: SkillInfo) => void;
  onOpenMenu: (e: React.MouseEvent, skill: SkillInfo) => void;
  onToggleEnabled: (skill: SkillInfo) => void;
  favorite: boolean;
  rating: number;
  tags: string[];
  onToggleFavorite: (slug: string) => void;
  onSetRating: (slug: string, rating: number) => void;
  t: (key: string) => string;
}) {
  const isDisabled = skill.disable_model_invocation === true;
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={() => onSelect(skill)}
      onContextMenu={(e) => onOpenMenu(e, skill)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`relative mx-1.5 mb-1 px-2.5 py-2 rounded-lg cursor-pointer
        transition-smooth group border
        ${isDisabled ? 'opacity-50' : ''}
        ${isSelected
          ? 'bg-accent/10 border-accent/30'
          : 'border-transparent hover:bg-bg-secondary hover:border-border-subtle'
        }`}
    >
      {/* Hover tooltip — full description, shown below the card */}
      {hovered && (
        <div
          className="absolute left-1.5 right-1.5 top-full mt-1 z-40 p-2.5
            rounded-lg border border-border-subtle bg-bg-card shadow-lg
            pointer-events-none animate-fade-in"
        >
          <div className="text-[12px] font-medium text-text-primary mb-1">{skill.name}</div>
          <p className="text-[11px] text-text-muted leading-relaxed">{skill.description}</p>
        </div>
      )}

      {/* Row 1: Name + scope badge + actions */}
      <div className="flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"
          className="flex-shrink-0 text-text-tertiary">
          <path d="M6 1l5 5-5 5-5-5z" />
        </svg>
        <span className={`text-[13px] truncate flex-1 ${
          isSelected ? 'text-accent' : 'text-text-primary'
        }`}>
          {skill.name}
        </span>
        <span className={`flex-shrink-0 w-3.5 h-3.5 rounded text-[8px]
          font-bold flex items-center justify-center
          ${skill.scope === 'global' ? 'bg-blue-500/20 text-blue-400'
            : skill.scope === 'custom' ? 'bg-amber-400/20 text-amber-500'
            : 'bg-green-500/20 text-green-400'}`}>
          {skill.scope === 'global' ? 'G' : skill.scope === 'custom' ? 'C' : 'P'}
        </span>

        {/* Favorite star */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(slugOf(skill)); }}
          className={`flex-shrink-0 ${favorite ? 'text-amber-400' : 'text-text-tertiary opacity-0 group-hover:opacity-100'}`}
          title={favorite ? t('skills.removeFavorite') : t('skills.addFavorite')}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill={favorite ? 'currentColor' : 'none'}
            stroke="currentColor" strokeWidth="1.5">
            <path d="M8 1l2.5 5 5.5.8-4 3.9.9 5.3L8 13.3 3.1 16l.9-5.3-4-3.9L5.5 6z" />
          </svg>
        </button>

        {/* Toggle switch */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleEnabled(skill); }}
          className="flex-shrink-0 ml-1"
          title={isDisabled ? t('skills.enable') : t('skills.disable')}
        >
          <div className={`w-6 h-3.5 rounded-full transition-colors relative
            ${isDisabled ? 'bg-text-tertiary/30' : 'bg-accent'}`}>
            <div className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow-sm
              transition-transform ${isDisabled ? 'left-0.5' : 'left-[11px]'}`} />
          </div>
        </button>

        {/* "..." menu button */}
        <button
          onClick={(e) => onOpenMenu(e, skill)}
          className="flex-shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100
            hover:bg-bg-secondary transition-smooth text-text-tertiary"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="4" cy="8" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="12" cy="8" r="1.5" />
          </svg>
        </button>
      </div>

      {/* Row 2: Description (1-2 lines, truncated) */}
      <p className="text-xs text-text-muted mt-1 line-clamp-2 leading-relaxed pl-5">
        {skill.description}
      </p>

      {/* Row 3: Rating stars — click to rate, high ratings promote the skill to Favorites */}
      <div className="pl-5 mt-1">
        <StarRating rating={rating} onSetRating={(r) => onSetRating(slugOf(skill), r)} size={11} />
      </div>

      {/* Row 4: Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5 pl-5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="px-1.5 py-0.5 text-[9px] rounded-md
                bg-bg-secondary text-text-tertiary font-medium"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Row 5: Allowed tools as tag badges */}
      {skill.allowed_tools && skill.allowed_tools.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5 pl-5">
          {skill.allowed_tools.map((tool) => (
            <span
              key={tool}
              className="px-1.5 py-0.5 text-[9px] rounded-md
                bg-accent/10 text-accent font-medium"
            >
              {tool}
            </span>
          ))}
        </div>
      )}

      {/* Row 6: Metadata (model, context, version) */}
      {(skill.model || skill.context || skill.version) && (
        <div className="flex items-center gap-2 mt-1 pl-5 text-[9px] text-text-tertiary">
          {skill.model && (
            <span>{t('skills.model')}: {skill.model}</span>
          )}
          {skill.context && (
            <span>{t('skills.context')}: {skill.context}</span>
          )}
          {skill.version && (
            <span>{t('skills.version')}: {skill.version}</span>
          )}
        </div>
      )}
    </div>
  );
}

