import { useT } from '../../lib/i18n';
import { useSessionStore } from '../../stores/sessionStore';
import { useChatStore } from '../../stores/chatStore';
import { useAgentStore } from '../../stores/agentStore';
import { useFileStore } from '../../stores/fileStore';
import { useSettingsStore } from '../../stores/settingsStore';

/**
 * Browser-like tab strip for open sessions, rendered at the top of the chat
 * panel. Click a tab to switch sessions; click the ✕ to close it from the
 * strip (the session itself is NOT deleted — it stays in the sidebar list).
 */
export function SessionTabs() {
  const t = useT();
  const openTabs = useSessionStore((s) => s.openTabs);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const customPreviews = useSessionStore((s) => s.customPreviews);
  const runningSessions = useSessionStore((s) => s.runningSessions);
  const setSelectedSession = useSessionStore((s) => s.setSelectedSession);
  const closeTab = useSessionStore((s) => s.closeTab);

  if (openTabs.length === 0) return null;

  const displayName = (id: string): string => {
    const session = sessions.find((s) => s.id === id);
    if (!session) return '…';
    const custom = customPreviews[id];
    if (custom) return custom;
    if (session.preview) return session.preview;
    if (session.project) return session.project.split(/[\\/]/).pop() || session.project;
    return t('tab.untitled');
  };

  const restoreSelection = (id: string) => {
    const restored = useChatStore.getState().restoreFromCache(id);
    if (restored) {
      useAgentStore.getState().restoreFromCache(id);
      const session = useSessionStore.getState().sessions.find((s) => s.id === id);
      if (session?.project) {
        useSettingsStore.getState().setWorkingDirectory(session.project);
      }
    }
  };

  const switchTo = (id: string) => {
    if (id === selectedSessionId) return;
    const currentTabId = useSessionStore.getState().selectedSessionId;
    if (currentTabId) {
      useChatStore.getState().saveToCache(currentTabId);
      useAgentStore.getState().saveToCache(currentTabId);
    }
    useFileStore.getState().closePreview();
    setSelectedSession(id);
    restoreSelection(id);
  };

  const onClose = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const isActive = id === selectedSessionId;
    // Flush the closing tab's live data to cache so it can be reopened from the
    // sidebar without losing the in-memory draft.
    if (isActive) {
      useChatStore.getState().saveToCache(id);
      useAgentStore.getState().saveToCache(id);
    }
    closeTab(id);
    // If we just closed the active tab, restore the tab closeTab switched to.
    const nextId = useSessionStore.getState().selectedSessionId;
    if (isActive && nextId) {
      useFileStore.getState().closePreview();
      restoreSelection(nextId);
    } else if (isActive) {
      // No open tabs remain — return to the welcome/empty state.
      useSettingsStore.getState().setWorkingDirectory('');
    }
  };

  return (
    <div
      className="flex items-center gap-1 px-3 h-9 border-b border-border-subtle
        bg-bg-chat overflow-x-auto flex-shrink-0"
    >
      {openTabs.map((id) => {
        const isActive = id === selectedSessionId;
        const isRunning = runningSessions.has(id);
        return (
          <div
            key={id}
            onClick={() => switchTo(id)}
            className={`group flex items-center gap-1.5 px-2.5 py-1 rounded-t-md text-xs
              border border-b-0 cursor-pointer select-none whitespace-nowrap transition-smooth
              ${isActive
                ? 'bg-bg-primary text-text-primary border-border-subtle'
                : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary/60 border-transparent'
              }`}
          >
            {isRunning && (
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse-soft flex-shrink-0" />
            )}
            <span className="max-w-[140px] truncate">{displayName(id)}</span>
            <button
              onClick={(e) => onClose(e, id)}
              className={`w-4 h-4 flex items-center justify-center rounded
                transition-smooth text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary
                ${isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-100'}`}
              title={t('tab.close')}
            >
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M2 2l8 8M10 2l-8 8" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
