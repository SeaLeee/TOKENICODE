import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { useChatStore, useActiveTab, getActiveTabState, generateMessageId, isSessionBusy, registerLiveComposerSnapshotProvider, type ChatMessage } from '../../stores/chatStore';
import { useSettingsStore, MODEL_OPTIONS, mapSessionModeToPermissionMode, setSessionModeLocal, type ThinkingLevel } from '../../stores/settingsStore';
import { bridge, type UnifiedCommand } from '../../lib/tauri-bridge';
import { ModelSelector } from './ModelSelector';
import { ModeSelector } from './ModeSelector';
import { ContextMeter } from './ContextMeter';
import { FileUploadChips } from './FileUploadChips';
import { RewindPanel } from './RewindPanel';
import { useFileAttachments } from '../../hooks/useFileAttachments';
import { useRewind } from '../../hooks/useRewind';
import { useStreamProcessor, flushStreamBuffer } from '../../hooks/useStreamProcessor';
import { useAgentStore } from '../../stores/agentStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useT } from '../../lib/i18n';
import { SlashCommandPopover, getFilteredCommandList } from './SlashCommandPopover';
import { SkillPicker } from './SkillPicker';
import { useCommandStore } from '../../stores/commandStore';
import { suggestSkills, suggestSkillsWithAi, type SkillSuggestion } from '../../lib/skill-suggestion';
import { envFingerprint, resolveModelForProvider, resolveModelOrError, spawnConfigHash } from '../../lib/api-provider';
import { useProviderStore } from '../../stores/providerStore';
import { PROVIDER_PRESETS } from '../../lib/provider-presets';
import { stripAnsi } from '../../lib/strip-ansi';
import { usePlanPanelStore } from './ChatPanel';
import { PlanReviewCard } from './PlanReviewCard';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { TiptapEditor, type TiptapEditorHandle } from './TiptapEditor';
import { spawnSession, teardownSession, cleanupStdinRoute, waitForStdinCleared } from '../../lib/sessionLifecycle';
import type { FileAttachment } from '../../hooks/useFileAttachments';
// drag-state import removed — tree drag handled by ChatPanel

/** Thinking effort level configuration data */
const THINK_LEVELS: { id: ThinkingLevel; labelKey: string }[] = [
  { id: 'off', labelKey: 'think.off' },
  { id: 'low', labelKey: 'think.low' },
  { id: 'medium', labelKey: 'think.medium' },
  { id: 'high', labelKey: 'think.high' },
  { id: 'max', labelKey: 'think.max' },
];

function buildInterruptedContinuationPrompt(interruptedAssistantText: string, nextUserText: string): string {
  const cleanInterrupted = interruptedAssistantText.trim();
  const cleanNext = nextUserText.trim();
  if (!cleanInterrupted) return cleanNext;
  return [
    '系统注记：你上一条回复在用户手动停止前，已经输出了下面这段未完成正文。',
    '请把它视为本会话里你刚刚已经写出的内容，在此基础上继续，不要声称之前没有写过这些内容。',
    '已输出正文：',
    cleanInterrupted,
    '用户接下来的消息是基于这段已输出内容的后续指令：',
    cleanNext,
  ].join('\n\n');
}

const VISION_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function isVisionImageAttachment(file: FileAttachment): boolean {
  return file.isImage && VISION_IMAGE_TYPES.has(file.type);
}

function visionImagePaths(files: FileAttachment[]): string[] {
  return files
    .filter(isVisionImageAttachment)
    .map((file) => file.path);
}

function hasResumableConversationEvidence(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) =>
      m.role === 'assistant'
      && (m.type === 'text' || m.type === 'tool_use' || m.type === 'thinking')
      && m.content.trim().length > 0,
  );
}

/** True when the caret sits on the first visual line of the editor (within the
 *  first paragraph and with no line break before it). Up/Down recall history only
 *  here — elsewhere they keep moving the caret within a multi-line draft. */
function isCaretOnFirstLine(editor: any): boolean {
  if (!editor) return true;
  const { selection, doc } = editor.state;
  if (!selection.empty) return false;
  const $from = selection.$from;
  // Count line breaks before the caret: hardBreak nodes (Shift+Enter) and any
  // block node that starts after position 0 (a paragraph boundary). If any are
  // present, the caret is on a later line.
  let lineBreaks = 0;
  doc.nodesBetween(0, $from.pos, (node: any, pos: number) => {
    if (node.type?.name === 'hardBreak' || (node.isBlock && pos > 0)) {
      lineBreaks += 1;
      return false;
    }
    return true;
  });
  return lineBreaks === 0;
}

/** Thinking effort level selector dropdown for the toolbar */
function ThinkLevelSelector({ disabled = false }: { disabled?: boolean }) {
  const t = useT();
  const thinkingLevel = useSettingsStore((s) => s.thinkingLevel);
  const setThinkingLevel = useSettingsStore((s) => s.setThinkingLevel);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const thinkingSupport = useProviderStore((s) => {
    if (!s.activeProviderId) return 'full';
    const provider = s.providers.find((p) => p.id === s.activeProviderId);
    if (!provider?.preset) return 'unknown';
    return PROVIDER_PRESETS.find((p) => p.id === provider.preset)?.thinkingSupport ?? 'unknown';
  });

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const isOff = thinkingLevel === 'off';
  const current = THINK_LEVELS.find((l) => l.id === thinkingLevel) || THINK_LEVELS[3];

  return (
    <div ref={ref} className={`relative ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs
          border transition-smooth cursor-pointer
          ${isOff
            ? 'border-border-subtle bg-bg-secondary/50 text-text-muted hover:text-text-primary hover:bg-bg-secondary'
            : 'border-accent/30 bg-accent/10 text-accent'
          }`}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="6" r="4" />
          <path d="M5.5 9.5C5.5 11.5 6 13 8 13s2.5-1.5 2.5-3.5" />
          <path d="M6.5 14h3" />
        </svg>
        <span className="font-medium">{t(current.labelKey)}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}>
          <path d="M1.5 3L4 5.5 6.5 3" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[140px]
          bg-bg-card border border-border-subtle rounded-lg shadow-lg
          py-1 z-50 animate-fade-in">
          {THINK_LEVELS.map((level) => {
            const isActive = level.id === thinkingLevel;
            return (
              <button
                key={level.id}
                onClick={() => { setThinkingLevel(level.id); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs
                  transition-smooth cursor-pointer
                  ${isActive
                    ? 'bg-accent/10 text-accent font-medium'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
                  }`}
              >
                {t(level.labelKey)}
                {isActive && (
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
                    stroke="currentColor" strokeWidth="1.5" className="ml-auto">
                    <path d="M2.5 6l2.5 2.5 4.5-4.5" />
                  </svg>
                )}
              </button>
            );
          })}
          {thinkingSupport === 'ignored' && (
            <div className="px-3 py-1.5 text-[10px] text-text-tertiary border-t border-border-subtle mt-1">
              {t('think.providerIgnored')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PlanToggleButton() {
  const t = useT();
  const isOpen = usePlanPanelStore((s) => s.open);
  const toggle = usePlanPanelStore((s) => s.toggle);
  const hasPlanMessages = useActiveTab((t) =>
    t.messages.some((m) => m.type === 'plan_review' || m.type === 'plan' || m.planContent),
  );
  const inPlanMode = useSettingsStore((s) => s.sessionMode) === 'plan';

  // Only show when in plan mode or there are plan-related messages
  if (!inPlanMode && !hasPlanMessages) return null;

  return (
    <button
      onClick={toggle}
      className={`p-1.5 rounded-lg transition-smooth flex items-center gap-1
        ${isOpen
          ? 'bg-accent/10 text-accent'
          : 'text-text-tertiary hover:text-text-primary hover:bg-bg-secondary'
        }`}
      title={t('msg.viewPlan')}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M3 4h10M3 8h8M3 12h5" />
      </svg>
      <span className="text-[10px]">Plan</span>
    </button>
  );
}

/* PlanApprovalBar removed — PlanReviewCard (triggered by ExitPlanMode detection)
   is the proper plan approval UI. The fallback bar was too broad: it appeared on
   every completed session in plan/bypass mode, even without a real plan. */

export function InputBar() {
  const t = useT();
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const inputDraft = useActiveTab((t) => t.inputDraft);
  const setInputDraftStore = useChatStore((s) => s.setInputDraft);
  // Local alias for the store-backed draft
  const input = inputDraft;
  const setInput = useCallback((text: string) => {
    if (selectedSessionId) {
      useChatStore.getState().ensureTab(selectedSessionId);
      setInputDraftStore(selectedSessionId, text);
    }
  }, [selectedSessionId, setInputDraftStore]);
  const textareaRef = useRef<TiptapEditorHandle>(null);
  const latestFilesRef = useRef<FileAttachment[]>([]);
  const previousSessionIdRef = useRef<string | null>(selectedSessionId);
  /** Up/Down history navigation. `-1` = not navigating; the draft that was on
   *  screen before navigation is saved so Down can restore it. */
  const historyIndexRef = useRef(-1);
  const historyDraftRef = useRef('');
  /** Sync both the Zustand store and the tiptap editor.
   *  Use this for all programmatic input changes (clear, set, etc.).
   *  The editor's onUpdate callback uses setInput directly to avoid circular updates. */
  const setInputSync = useCallback((text: string) => {
    setInput(text);
    textareaRef.current?.setText(text);
  }, [setInput]);
  /** Like setInputSync, but places the caret at the start of the recalled text so
   *  Up/Down history navigation keeps working even on multi-line entries. */
  const setHistoryInput = useCallback((text: string) => {
    setInput(text);
    textareaRef.current?.setText(text, 'start');
  }, [setInput]);
  const captureLiveDraftSnapshot = useCallback((tabId: string) => {
    if (!selectedSessionId || tabId !== selectedSessionId) return null;
    return {
      inputDraft: textareaRef.current?.getText() ?? inputDraft,
      pendingAttachments: latestFilesRef.current,
    };
  }, [inputDraft, selectedSessionId]);

  useEffect(() => {
    registerLiveComposerSnapshotProvider(captureLiveDraftSnapshot);
    return () => registerLiveComposerSnapshotProvider(null);
  }, [captureLiveDraftSnapshot]);

  // When the selected tab changes, snapshot the current editor content back to
  // the tab we are leaving before the next restore effect repaints the editor.
  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current;
    if (previousSessionId && previousSessionId !== selectedSessionId) {
      const currentText = textareaRef.current?.getText();
      if (currentText !== undefined) {
        setInputDraftStore(previousSessionId, currentText);
      }
      useChatStore.getState().setPendingAttachments(previousSessionId, latestFilesRef.current);
    }
    previousSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId, setInputDraftStore]);

  // Reset history navigation when switching sessions — each session has its own history.
  useEffect(() => {
    historyIndexRef.current = -1;
    historyDraftRef.current = '';
  }, [selectedSessionId]);

  // Restore input text from store when session switches (restoreFromCache → inputDraft change)
  const prevEditorSyncRef = useRef<{ tabId: string | null; inputDraft: string } | null>(null);
  useEffect(() => {
    const previous = prevEditorSyncRef.current;
    const tabChanged = previous?.tabId !== selectedSessionId;
    const draftChanged = previous?.inputDraft !== inputDraft;
    if (tabChanged || draftChanged) {
      // Never call setText during IME composition — it destroys the composing state
      if (!tabChanged && textareaRef.current?.isComposing()) {
        prevEditorSyncRef.current = { tabId: selectedSessionId, inputDraft };
        return;
      }
      // Only sync editor if its content actually differs (avoid cursor reset on user typing)
      const current = textareaRef.current?.getText() ?? '';
      if (current !== inputDraft) {
        textareaRef.current?.setText(inputDraft);
      }
    }
    prevEditorSyncRef.current = { tabId: selectedSessionId, inputDraft };
  }, [inputDraft, selectedSessionId]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sessionStatus = useActiveTab((t) => t.sessionStatus);
  const activityPhase = useActiveTab((t) => t.activityStatus.phase);
  const addMessage = useChatStore((s) => s.addMessage);
  const setSessionStatus = useChatStore((s) => s.setSessionStatus);
  const setSessionMeta = useChatStore((s) => s.setSessionMeta);
  const setActivityStatus = useChatStore((s) => s.setActivityStatus);
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const sessionMode = useSettingsStore((s) => s.sessionMode);
  const handlePlanApprove = useCallback(async () => {
    const tabId = useSessionStore.getState().selectedSessionId;
    if (!tabId) return;
    const currentMode = useSettingsStore.getState().sessionMode;
    const tabState = getActiveTabState();
    const meta = tabState.sessionMeta;
    const status = tabState.sessionStatus;

    // If CLI is still alive (e.g., Bypass auto-accepted ExitPlanMode),
    // just dismiss the card — no restart needed.
    if (meta.stdinId && status === 'running') {
      if (useSettingsStore.getState().sessionMode !== 'auto') {
        setSessionModeLocal('auto');
      }
      if (meta.snapshotMode === 'plan') {
        useChatStore.getState().setSessionMeta(tabId, { snapshotMode: 'auto' });
      }
      useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
      return;
    }

    // CLI exited after ExitPlanMode (permission denied in stream-json mode).
    // Plan mode: switch to Code mode for execution.
    // Bypass mode: stay in Bypass (no mode switch needed).
    if (currentMode === 'plan') {
      useSettingsStore.getState().setSessionMode('auto');
    }

    // Clean up dead CLI process via lifecycle module
    if (meta.stdinId) {
      const exitingStdinId = meta.stdinId;
      await teardownSession(exitingStdinId, tabId, 'plan-approve');
      await waitForStdinCleared(tabId, exitingStdinId);
    }

    // Restart with --resume <sessionId>
    useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
    setInputSync('Execute the plan above.');
    requestAnimationFrame(() => {
      handleSubmitRef.current();
    });
  }, [setInputSync]);

  // Listen for plan-execute events from PlanReviewCard and Enter shortcut
  useEffect(() => {
    const handler = () => handlePlanApprove();
    window.addEventListener('tokenicode:plan-execute', handler);
    return () => window.removeEventListener('tokenicode:plan-execute', handler);
  }, [handlePlanApprove]);

  // Floating approval cards — unresolved plan_review / question messages
  // are rendered above the input instead of inline in the chat flow.
  const floatingCard = useActiveTab((tab) => {
    for (let i = tab.messages.length - 1; i >= 0; i--) {
      const m = tab.messages[i];
      if ((m.type === 'plan_review' || m.type === 'question' || m.type === 'permission') && !m.resolved) return m;
    }
    return null;
  });

  const { files, setFiles, isProcessing, addFiles, removeFile, clearFiles } = useFileAttachments();

  useLayoutEffect(() => {
    latestFilesRef.current = files;
  }, [files]);

  // Sync files → store.pendingAttachments so tab switch can persist them
  const setPendingAttachmentsStore = useChatStore((s) => s.setPendingAttachments);
  useEffect(() => {
    const tid = useSessionStore.getState().selectedSessionId;
    if (tid) setPendingAttachmentsStore(tid, files);
  }, [files, setPendingAttachmentsStore]);

  // Restore files from store when tab switches back (pendingAttachments → local files)
  const pendingAttachments = useActiveTab((t) => t.pendingAttachments);
  const prevAttachmentsRef = useRef(pendingAttachments);
  useEffect(() => {
    // Only restore when store value changes externally (e.g. restoreFromCache)
    // and differs from current files
    if (prevAttachmentsRef.current !== pendingAttachments && pendingAttachments !== files) {
      setFiles(pendingAttachments);
    }
    prevAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments, setFiles]); // intentionally exclude `files` to avoid loop

  // Inline file insertion: drop or drag → insert a file chip at cursor
  useEffect(() => {
    const onTreeFileInline = (e: Event) => {
      const fullPath = (e as CustomEvent<string>).detail;
      if (!fullPath || !textareaRef.current) return;

      // Convert to path relative to working directory for readability
      const cwd = useSettingsStore.getState().workingDirectory;
      let displayPath = fullPath;
      if (cwd && fullPath.startsWith(cwd)) {
        displayPath = fullPath.slice(cwd.length).replace(/^[\\/]/, '');
      }

      textareaRef.current.insertFileChip({ fullPath, label: displayPath });
    };
    window.addEventListener('tokenicode:tree-file-inline', onTreeFileInline);
    return () => window.removeEventListener('tokenicode:tree-file-inline', onTreeFileInline);
  }, []);

  // Slash command state
  const [slashQuery, setSlashQuery] = useState('');
  const [slashVisible, setSlashVisible] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashCommands = useCommandStore((s) => s.commands);
  const activePrefixes = useCommandStore((s) => s.activePrefixes);

  // Skill auto-suggestion state — populated by a debounce effect on `input`.
  const [skillSuggestions, setSkillSuggestions] = useState<SkillSuggestion[]>([]);
  const [aiSuggesting, setAiSuggesting] = useState(false);
  const skillAutoSuggest = useSettingsStore((s) => s.skillAutoSuggest);
  const skillAiEnhance = useSettingsStore((s) => s.skillAiEnhance);

  // Debounced skill suggestion: local keyword scoring (300ms), or AI-enhanced
  // semantic matching (800ms) when the setting is on and a provider is active.
  useEffect(() => {
    const q = input.trim();
    if (!skillAutoSuggest || !q || slashVisible) {
      setSkillSuggestions([]);
      setAiSuggesting(false);
      return;
    }
    const skills = useCommandStore.getState().commands;
    const exclude = new Set(useCommandStore.getState().activePrefixes.map((p) => p.name));
    const applyLocal = () => {
      setSkillSuggestions(suggestSkills(q, skills, { excludeNames: exclude }));
      setAiSuggesting(false);
    };
    const useAi = skillAiEnhance && Boolean(useProviderStore.getState().getActive());
    const delay = useAi ? 800 : 300;
    const timer = setTimeout(async () => {
      if (useAi) {
        setAiSuggesting(true);
        const ai = await suggestSkillsWithAi(q, skills);
        if (ai.length > 0) {
          setSkillSuggestions(ai);
          setAiSuggesting(false);
        } else {
          // No AI match (or call failed / returned []) → fall back to local.
          applyLocal();
        }
      } else {
        applyLocal();
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [input, slashVisible, skillAutoSuggest, skillAiEnhance, activePrefixes]);

  // Dedicated "add skill" picker state (separate from the slash-command popover)
  const [skillPickerVisible, setSkillPickerVisible] = useState(false);
  const skillPickerRef = useRef<HTMLDivElement>(null);

  // Close the skill picker when clicking outside its container
  useEffect(() => {
    if (!skillPickerVisible) return;
    const onDown = (e: MouseEvent) => {
      if (skillPickerRef.current && !skillPickerRef.current.contains(e.target as Node)) {
        setSkillPickerVisible(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [skillPickerVisible]);

  // Focus input when activePrefixes are set externally (e.g. from SkillsPanel "Use in Input")
  useEffect(() => {
    if (activePrefixes.length) {
      textareaRef.current?.focus();
    }
  }, [activePrefixes]);

  // Rewind state
  const [showRewindPanel, setShowRewindPanel] = useState(false);
  const { showRewind, canRewind } = useRewind();
  // lastEscTime removed — double-Esc rewind disabled (#36/#71)

  // Listen for rewind event from /rewind command
  useEffect(() => {
    const handler = () => {
      if (canRewind) {
        setShowRewindPanel(true);
      } else {
        const tid = useSessionStore.getState().selectedSessionId;
        if (tid) {
          useChatStore.getState().addMessage(tid, {
            id: generateMessageId(), role: 'system', type: 'text',
            content: t('rewind.disabled'), commandType: 'error', timestamp: Date.now(),
          });
        }
      }
    };
    window.addEventListener('tokenicode:rewind', handler);
    return () => window.removeEventListener('tokenicode:rewind', handler);
  }, [canRewind, t]);

  // Double-Esc rewind shortcut disabled (#36 / #71) — rewind feature is hidden in TOKENICODE

  // Drag state (file drop)
  const [isDragging, setIsDragging] = useState(false);

  const customSkillDirs = useSettingsStore((s) => s.customSkillDirs);

  // Fetch slash commands when working directory or custom skill dirs change
  useEffect(() => {
    useCommandStore.getState().fetchCommands(workingDirectory || undefined);
  }, [workingDirectory, customSkillDirs]);

  // Shared busy state for follow-up placeholder / stop controls / selector lock.
  // We keep a stricter editor lock for `stopping` below so the user can't
  // interleave a new message while teardown is still in flight.
  const isRunning = isSessionBusy(sessionStatus);
  const isStopping = sessionStatus === 'stopping';
  const isAwaiting = isRunning && activityPhase === 'awaiting';
  const inputPlaceholder = isStopping
    ? t('input.stoppingPlaceholder')
    : isRunning
      ? t('input.followUp')
      : t('input.placeholder');

  // Whether this is a follow-up (session already has a CLI session ID)
  const hasActiveSession = sessionStatus !== 'idle';

  // --- Slash command detection ---
  // Relaxed: detect "/" at start of first line, keep popover open even after spaces
  const detectSlashCommand = useCallback((text: string) => {
    const firstLine = text.split('\n')[0];
    if (firstLine.startsWith('/') && !activePrefixes.length) {
      const query = firstLine.slice(1); // strip leading "/"
      setSlashQuery(query);
      setSlashVisible(true);
      setSlashIndex(0);
    } else {
      setSlashVisible(false);
    }
  }, [activePrefixes]);

  // Ref to always point to the latest handleSubmit (avoids stale closure)
  const handleSubmitRef = useRef<() => void>(() => {});
  // Ref to always point to the latest handleStderrLine (used by retry logic in handleStreamMessage)
  const handleStderrLineRef = useRef<(line: string, sid: string) => void>(() => {});
  /** Last non-empty stderr line — shown to user if process exits without response */
  const lastStderrRef = useRef('');
  /** Tracks ExitPlanMode in current turn for Code mode auto-restart */
  const exitPlanModeSeenRef = useRef(false);
  /** When true, next handleSubmit skips creating user message bubble (Code mode silent restart) */
  const silentRestartRef = useRef(false);

  // Stream processing hook — handles foreground + background stream messages
  const { handleStreamMessage } = useStreamProcessor({
    exitPlanModeSeenRef,
    silentRestartRef,
    handleSubmitRef,
    handleStderrLineRef,
    lastStderrRef,
    setInputSync,
  });

  // --- Immediate command execution ---
  // All built-in commands are handled in the UI layer because they don't work
  // via stdin in stream-json mode (CLI treats them as normal text, not commands).
  const executeImmediateCommand = useCallback(async (cmdName: string, args?: string) => {
    const cmd = cmdName.toLowerCase().replace(/^\//, '');
    const { addMessage } = useChatStore.getState();
    const tabId = useSessionStore.getState().selectedSessionId;

    // Always clear the input box first
    setInputSync('');

    // Helper: resolve model ID to display name
    const modelLabel = (id: string | undefined): string => {
      if (!id) return '—';
      return MODEL_OPTIONS.find((m) => m.id === id)?.label || id;
    };

    // Helper: add a structured command feedback message
    const feedback = (
      commandType: 'mode' | 'info' | 'help' | 'action' | 'error',
      content: string,
      commandData?: Record<string, any>,
    ) => {
      if (!tabId) return;
      addMessage(tabId, {
        id: generateMessageId(),
        role: 'system',
        type: 'text',
        content,
        commandType,
        commandData,
        timestamp: Date.now(),
      });
    };

    switch (cmd) {
      // --- Mode switching ---
      case 'ask':
        useSettingsStore.getState().setSessionMode('ask');
        feedback('mode', t('cmd.switchedToAsk'), { mode: 'ask', icon: '💬' });
        return;
      case 'plan':
        useSettingsStore.getState().setSessionMode('plan');
        feedback('mode', t('cmd.switchedToPlan'), { mode: 'plan', icon: '📋' });
        return;
      case 'auto':
      case 'code': // legacy alias for the pre-rename slash command
      case 'bypass': // legacy alias — old "bypass" meant fully-auto, now 'auto'
        useSettingsStore.getState().setSessionMode('auto');
        feedback('mode', t('cmd.switchedToAuto'), { mode: 'auto', icon: '⚡' });
        return;
      case 'edit-auto':
        useSettingsStore.getState().setSessionMode('editAuto');
        feedback('mode', t('cmd.switchedToEditAuto'), { mode: 'editAuto', icon: '📝' });
        return;

      // --- Session management ---
      case 'clear':
        if (tabId) useChatStore.getState().resetTab(tabId);
        return;

      case 'rewind':
        window.dispatchEvent(new CustomEvent('tokenicode:rewind'));
        return;

      // /compact is handled in the session stdin commands group below

      // --- Info commands ---
      case 'cost': {
        const meta = getActiveTabState().sessionMeta;
        const hasData = meta.cost != null || meta.duration != null || meta.turns != null
          || meta.inputTokens != null || meta.outputTokens != null;
        const tokenValue = (meta.inputTokens != null || meta.outputTokens != null)
          ? `${(meta.inputTokens ?? 0).toLocaleString()} input / ${(meta.outputTokens ?? 0).toLocaleString()} output`
          : '—';
        feedback('info', hasData ? t('cmd.costTitle') : t('cmd.noSessionData'), {
          command: '/cost',
          title: t('cmd.costTitle'),
          rows: [
            { label: t('cmd.costModel'), value: modelLabel(meta.model || useSettingsStore.getState().selectedModel) },
            { label: t('cmd.costAmount'), value: meta.cost != null ? `$${meta.cost.toFixed(4)}` : '—' },
            { label: t('cmd.costDuration'), value: meta.duration != null ? `${(meta.duration / 1000).toFixed(1)}s` : '—' },
            { label: t('cmd.costTurns'), value: meta.turns != null ? String(meta.turns) : '—' },
            { label: t('cmd.costTokens'), value: tokenValue },
          ],
          hasData,
        });
        return;
      }


      case 'usage': {
        const meta = getActiveTabState().sessionMeta;
        const isOfficialProvider = useProviderStore.getState().activeProviderId === null;

        if (isOfficialProvider) {
          // Official Anthropic account: quota data is only available in the CLI REPL TUI.
          // Show local session data + a hint to use the terminal.
          const hasData = meta.cost != null || meta.turns != null
            || meta.inputTokens != null || meta.outputTokens != null;
          const totalInput = meta.totalInputTokens ?? 0;
          const totalOutput = meta.totalOutputTokens ?? 0;
          feedback('info', hasData ? t('cmd.usageTitle') : t('cmd.noSessionData'), {
            command: '/usage',
            title: t('cmd.usageTitle'),
            rows: [
              { label: t('cmd.costModel'), value: modelLabel(meta.model || useSettingsStore.getState().selectedModel) },
              { label: t('cmd.costTurns'), value: meta.turns != null ? String(meta.turns) : '—' },
              { label: t('cmd.usageTotalSession'), value: totalInput || totalOutput
                ? `${totalInput.toLocaleString()} in / ${totalOutput.toLocaleString()} out`
                : '—' },
            ],
            hasData,
            hint: t('cmd.usageOfficialHint'),
          });
        } else {
          // Third-party API provider: show detailed token breakdown.
          const hasData = meta.inputTokens != null || meta.outputTokens != null
            || meta.totalInputTokens != null || meta.totalOutputTokens != null;
          const turnInput = meta.inputTokens ?? 0;
          const turnOutput = meta.outputTokens ?? 0;
          const totalInput = meta.totalInputTokens ?? 0;
          const totalOutput = meta.totalOutputTokens ?? 0;
          feedback('info', hasData ? t('cmd.usageTitle') : t('cmd.noSessionData'), {
            command: '/usage',
            title: t('cmd.usageTitle'),
            rows: [
              { label: t('cmd.costModel'), value: modelLabel(meta.model || useSettingsStore.getState().selectedModel) },
              { label: `${t('cmd.usageCurrentTurn')} — ${t('cmd.usageInput')}`, value: turnInput.toLocaleString() },
              { label: `${t('cmd.usageCurrentTurn')} — ${t('cmd.usageOutput')}`, value: turnOutput.toLocaleString() },
              { label: `${t('cmd.usageTotalSession')} — ${t('cmd.usageInput')}`, value: totalInput.toLocaleString() },
              { label: `${t('cmd.usageTotalSession')} — ${t('cmd.usageOutput')}`, value: totalOutput.toLocaleString() },
              { label: t('cmd.usageTotal'), value: (totalInput + totalOutput).toLocaleString() },
              { label: t('cmd.costAmount'), value: meta.cost != null ? `$${meta.cost.toFixed(4)}` : '—' },
            ],
            hasData,
          });
        }
        return;
      }

      case 'help': {
        const cmds = useCommandStore.getState().commands;
        const builtins = cmds.filter((c) => c.category === 'builtin')
          .map((c) => ({ name: c.name, desc: c.description }));
        const customCount = cmds.filter((c) => c.category === 'command').length;
        const skillCount = cmds.filter((c) => c.category === 'skill').length;
        feedback('help', t('cmd.helpTitle'), {
          builtins,
          customCount,
          skillCount,
        });
        return;
      }

      // --- External commands ---
      case 'bug':
        feedback('action', t('cmd.bugReport'), { action: 'bug', url: 'https://github.com/anthropics/claude-code/issues' });
        return;

      // --- UI-handled commands ---

      case 'rename': {
        if (!args) {
          feedback('error', t('cmd.renameNoArgs'));
          return;
        }
        const sessionId = useSessionStore.getState().selectedSessionId;
        if (sessionId) {
          useSessionStore.getState().setCustomPreview(sessionId, args);
          feedback('action', t('cmd.renamed').replace('{name}', args));
        }
        return;
      }

      case 'export': {
        const meta = getActiveTabState().sessionMeta;
        const sessions = useSessionStore.getState().sessions;
        const session = sessions.find((s: any) => s.id === meta.sessionId);
        const sessionPath = session?.path;
        if (!sessionPath) {
          feedback('error', t('cmd.exportNoPath'));
          return;
        }
        const outputPath = args || sessionPath.replace(/\.jsonl$/, '.md');
        await bridge.exportSessionMarkdown(sessionPath, outputPath);
        feedback('action', `${t('export.success')} ${outputPath}`);
        return;
      }


      // --- All CLI commands: pass through to active session via stdin ---
      // TOKENICODE is a GUI wrapper — all slash commands are handled by Claude Code CLI.
      default: {
        const stdinId = getActiveTabState().sessionMeta.stdinId;
        if (stdinId && tabId) {
          // Emit a processing card immediately so user sees feedback
          const processingMsgId = generateMessageId();
          addMessage(tabId, {
            id: processingMsgId,
            role: 'system',
            type: 'text',
            content: '',
            commandType: 'processing',
            commandData: { command: `/${cmd}${args ? ' ' + args : ''}` },
            commandStartTime: Date.now(),
            commandCompleted: false,
            timestamp: Date.now(),
          });
          useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: processingMsgId });
          useChatStore.getState().setSessionStatus(tabId, 'running');
          useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
          await bridge.sendStdin(stdinId, `/${cmd}${args ? ' ' + args : ''}`);
        } else {
          feedback('error', `/${cmd}: ${t('cmd.noActiveSession')}`, { command: `/${cmd}` });
        }
        return;
      }
    }
  }, [t, workingDirectory]);

  // --- Slash command selection ---
  const handleSlashSelect = useCallback((cmd: UnifiedCommand) => {
    setSlashVisible(false);
    setInputSync('');

    if (cmd.immediate) {
      if (cmd.has_args) {
        // Immediate + has_args: show prefix chip so user can type the argument
        useCommandStore.getState().addPrefix(cmd);
        textareaRef.current?.focus();
      } else {
        // Immediate execution: send command via stdin or as first message
        executeImmediateCommand(cmd.name);
      }
    } else {
      // Deferred: attach as a prefix chip (skills can stack)
      useCommandStore.getState().addPrefix(cmd);
      textareaRef.current?.focus();
    }
  }, [executeImmediateCommand]);

  // --- Skill picker selection (attaches the prefix chip WITHOUT clearing input,
  //      so the user can add a skill at any point and keep what they've typed) ---
  const handleSkillPick = useCallback((skill: UnifiedCommand) => {
    setSkillPickerVisible(false);
    useCommandStore.getState().addPrefix(skill);
    textareaRef.current?.focus();
  }, []);

  // --- Submit ---
  const handleSubmit = useCallback(async () => {
    // Capture tabId at the start of submission
    const tabId = useSessionStore.getState().selectedSessionId;
    if (!tabId) return;
    useChatStore.getState().ensureTab(tabId);

    // Read input from store directly (not closure) so that async callers
    // like handlePlanApprove (setInput + rAF) always see the latest value.
    const rawInput = getActiveTabState().inputDraft || '';
    let text = rawInput.trim();

    // Plan approval shortcut: empty Enter triggers approve & execute flow
    const tabState = getActiveTabState();
    const pendingPlanReview = tabState.messages.find(
      (m: import('../../stores/chatStore').ChatMessage) => m.type === 'plan_review' && !m.resolved,
    );
    if (pendingPlanReview && !text && !useCommandStore.getState().activePrefixes.length) {
      const stdinId = tabState.sessionMeta.stdinId;
      const hasLivePlanSession = Boolean(stdinId && tabState.sessionStatus === 'running');
      if (!hasLivePlanSession) {
        useChatStore.getState().updateMessage(tabId, pendingPlanReview.id, {
          resolved: true,
          interactionState: 'failed',
          interactionError: 'CLI process exited',
        });
        return;
      }
      const permData = pendingPlanReview.permissionData;
      if (permData?.requestId && stdinId) {
        try {
          await bridge.respondPermission(
            stdinId,
            permData.requestId,
            true,
            undefined,
            permData.toolUseId,
            permData.input,
          );
        } catch (err) {
          console.error('[TC:plan] Empty-Enter plan approval failed:', err);
          return;
        }
      }
      if (useSettingsStore.getState().sessionMode === 'plan') {
        setSessionModeLocal('auto');
      }
      useChatStore.getState().setSessionMeta(tabId, { snapshotMode: 'auto' });
      useChatStore.getState().updateMessage(tabId, pendingPlanReview.id, {
        resolved: true,
        interactionState: 'resolved',
      });
      window.dispatchEvent(new CustomEvent('tokenicode:plan-execute'));
      return;
    }

    // Auto-attach the top skill suggestion when enabled (setting). Uses the
    // deterministic local scorer so behavior is predictable and free; the async
    // AI-enhanced list is surfaced via chips, not force-attached here.
    if (useSettingsStore.getState().skillAutoSuggest && useSettingsStore.getState().skillAutoAttach && text) {
      const skills = useCommandStore.getState().commands;
      const attached = new Set(useCommandStore.getState().activePrefixes.map((p) => p.name));
      const top = suggestSkills(text, skills, { excludeNames: attached, limit: 1 })[0];
      if (top) useCommandStore.getState().addPrefix(top.skill);
    }

    // Prefix mode: attached skills are converted into an explicit skill-invocation
    // directive (so the model actually calls the Skill tool) rather than a bare
    // "/slug" token — in stream-json SDK mode the CLI does NOT expand slash
    // commands, it relies on the model to invoke skills. Non-skill prefixes
    // (deferred commands) keep their "/name" syntax.
    // clearPrefixes() is deferred until after the interaction card blocking check
    // so the visual chips survive if the submit is blocked and rawInput is restored.
    const prefixes = useCommandStore.getState().activePrefixes;
    // Skill slugs attached to this message — surfaced on the user bubble so the
    // user can confirm which skills were actually sent.
    const attachedSkills = prefixes
      .filter((p) => p.category === 'skill')
      .map((s) => s.name.replace(/^\//, ''));
    if (prefixes.length) {
      const skills = prefixes.filter((p) => p.category === 'skill');
      const commands = prefixes.filter((p) => p.category !== 'skill');
      const parts: string[] = [];
      if (skills.length) {
        parts.push(t('input.skillDirective').replace('{names}', attachedSkills.join('、')));
      }
      if (commands.length) {
        parts.push(commands.map((c) => c.name).join(' '));
      }
      const prefixStr = parts.join(' ');
      text = text ? `${prefixStr}\n\n${text}` : prefixStr;
    }

    if (!text && files.length === 0) return;

    // Intercept immediate (built-in) commands even when submitted directly
    // (e.g. user types "/help" and presses Enter without using the popover)
    if (text.startsWith('/')) {
      const parts = text.split(/\s+/);
      const cmdPart = parts[0].toLowerCase();
      const restText = parts.slice(1).join(' ').trim();

      // Mode-switching commands: /ask, /plan, /auto, /edit-auto (/bypass = legacy 'auto')
      // If followed by text, switch mode then submit the text normally
      const modeMap: Record<string, 'ask' | 'plan' | 'auto' | 'editAuto'> = {
        '/ask': 'ask', '/plan': 'plan', '/auto': 'auto', '/code': 'auto', '/bypass': 'auto', '/edit-auto': 'editAuto',
      };
      if (modeMap[cmdPart]) {
        useSettingsStore.getState().setSessionMode(modeMap[cmdPart]);
        if (restText) {
          // Directly apply the mode prefix and continue with submission
          text = `${cmdPart} ${restText}`;
        } else {
          setInputSync('');
          const modeVal = modeMap[cmdPart];
          const modeKey = `cmd.switchedTo${modeVal.charAt(0).toUpperCase() + modeVal.slice(1)}` as any;
          const iconMap: Record<string, string> = { ask: '💬', plan: '📋', auto: '⚡', editAuto: '📝' };
          addMessage(tabId, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: t(modeKey),
            commandType: 'mode',
            commandData: { mode: modeVal, icon: iconMap[modeVal] },
            timestamp: Date.now(),
          });
          return;
        }
      } else {
        // Other immediate commands (e.g. /clear, /help, /compact)
        const cmds = useCommandStore.getState().commands;
        const match = cmds.find(
          (c) => c.immediate && c.name.toLowerCase() === cmdPart
        );
        if (match) {
          setInputSync('');
          executeImmediateCommand(match.name, restText || undefined);
          return;
        }
      }
    }

    // Vision images are already embedded as content blocks. Repeating their
    // paths encourages unknown third-party models to call Claude's Read tool,
    // whose internal vision allowlist rejects them as "Unsupported Image".
    const pathOnlyFiles = files.filter((file) => !isVisionImageAttachment(file));
    if (pathOnlyFiles.length > 0) {
      const filePaths = pathOnlyFiles.map((file) => file.path).join('\n');
      text = `${text}\n\n${t('input.attachedFiles')}\n${filePaths}`;
    }

    // Gate: queue follow-up messages while AI is actively processing (#142).
    // IMPORTANT: when queueing, do NOT addMessage to messages[] — ChatPanel
    // renders pendingUserMessages separately AFTER the partialText bubble so
    // the queued items visually appear behind the streaming reply.
    // The flush logic in useStreamProcessor will addMessage at send time.
    //
    // This check runs BEFORE clearFiles/setInputSync so that the blocking
    // return path (unresolved interaction card) does not lose attachments.
    const currentTabState = getActiveTabState();
    const existingStdinId = currentTabState.sessionMeta.stdinId;
    const currentStatus = currentTabState.sessionStatus;
    const interruptedAssistantText = currentTabState.sessionMeta.interruptedAssistantText?.trim() || '';
    if (interruptedAssistantText) {
      text = buildInterruptedContinuationPrompt(interruptedAssistantText, text);
    }

    // Phase 2 §6: hard-block queueing while an interaction card (AskUserQuestion,
    // PlanReview, Permission) is unresolved — the queued text is almost always
    // intended as the answer to the open card, not a follow-up turn. Treat it as
    // such by restoring the input instead of silently queueing.
    const hasUnresolvedInteraction = currentTabState.messages.some(
      (m) =>
        (m.type === 'question' || m.type === 'plan_review' || m.type === 'permission') &&
        !m.resolved,
    );

    if (existingStdinId && isSessionBusy(currentStatus)) {
      if (hasUnresolvedInteraction) {
        // Restore the text to inputDraft so the user notices the pending
        // interaction card and can answer it directly.
        // No clearFiles/clearPrefixes has run yet, so attachments and chips are intact.
        useChatStore.getState().setInputDraft(tabId, rawInput);
        return;
      }
      // Queueing path: clear prefix, input and files, then enqueue.
      if (prefixes.length) useCommandStore.getState().clearPrefixes();
      setInputSync('');
      historyIndexRef.current = -1;
      clearFiles();
      useChatStore.getState().addPendingMessage(tabId, text, {
        // Native CCswitch turns must return through handleSubmit after the
        // active turn finishes so image/text turns can switch Vision/Pro.
        enqueueConfigHash: useProviderStore.getState().activeProviderId
          ? spawnConfigHash()
          : '__ccswitch_turn_route__',
        enqueueStdinId: existingStdinId,
        attachedSkills: attachedSkills.length ? attachedSkills : undefined,
        attachments: [...files],
      });
      return;
    }

    // Past all early-return checks — commit to sending. Clear prefix chips now.
    if (prefixes.length) useCommandStore.getState().clearPrefixes();
    setInputSync('');
    historyIndexRef.current = -1;

    // Snapshot attachments before clearFiles wipes them — full snapshot
    // for restoration on failure, reduced snapshot for the user message.
    const savedFiles = [...files];
    const userMsgAttachments = files.length > 0
      ? files.map((f) => ({ name: f.name, path: f.path, isImage: f.isImage, preview: f.preview }))
      : undefined;

    clearFiles();

    // Normal path: show user message immediately
    let pendingTurnMeta: { pendingTurnMessageId?: string; pendingTurnInput?: string; pendingTurnAttachments?: FileAttachment[] };
    if (silentRestartRef.current) {
      silentRestartRef.current = false;
      pendingTurnMeta = {
        pendingTurnMessageId: undefined,
        pendingTurnInput: undefined,
        pendingTurnAttachments: undefined,
      };
    } else {
      const pendingTurnMessageId = generateMessageId();
      addMessage(tabId, {
        id: pendingTurnMessageId,
        role: 'user',
        type: 'text',
        content: rawInput.trim(),
        timestamp: Date.now(),
        attachments: userMsgAttachments,
        attachedSkills: attachedSkills.length ? attachedSkills : undefined,
      });
      pendingTurnMeta = {
        pendingTurnMessageId,
        pendingTurnInput: rawInput.trim(),
        pendingTurnAttachments: savedFiles,
      };
    }

    // Initialize agent tracking — clear previous turn's agents (they may be from a
    // different project/session) and create a fresh main agent for this turn.
    useAgentStore.getState().clearAgents();
    useAgentStore.getState().upsertAgent({
      id: 'main',
      parentId: null,
      description: rawInput.trim(),
      phase: 'spawning',
      startTime: Date.now(),
      isMain: true,
    });

    try {
      if (!workingDirectory) {
        setSessionStatus(tabId, 'error');
        addMessage(tabId, {
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: 'No working directory selected. Please select a project folder first.',
          timestamp: Date.now(),
        });
        // Restore input and file attachments so user doesn't lose them
        useChatStore.getState().setInputDraft(tabId, rawInput);
        useChatStore.getState().setSessionMeta(tabId, {
          pendingTurnMessageId: undefined,
          pendingTurnInput: undefined,
          pendingTurnAttachments: undefined,
        });
        if (savedFiles.length > 0) setFiles(savedFiles);
        return;
      }

      // Check model mapping before sending — block if provider has no mapping for selected tier
      const modelResolution = resolveModelOrError(selectedModel);
      if (!modelResolution.ok) {
        const msg = t('provider.noModelMapping')
          .replace('{provider}', modelResolution.providerName)
          .replace('{tier}', modelResolution.tier);
        addMessage(tabId, {
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: msg,
          timestamp: Date.now(),
        });
        setSessionStatus(tabId, 'error');
        // Restore input and file attachments so user doesn't lose them
        useChatStore.getState().setInputDraft(tabId, rawInput);
        useChatStore.getState().setSessionMeta(tabId, {
          pendingTurnMessageId: undefined,
          pendingTurnInput: undefined,
          pendingTurnAttachments: undefined,
        });
        if (savedFiles.length > 0) setFiles(savedFiles);
        return;
      }

      const activeProviderId = useProviderStore.getState().activeProviderId || '';
      const imagePaths = visionImagePaths(savedFiles);
      const routedModel = activeProviderId
        ? null
        : await bridge.resolveCcswitchTurnModel(text, imagePaths);
      let didRouteModelSwitch = false;

      const markTurnPending = () => {
        setSessionStatus(tabId, 'running');
        setSessionMeta(tabId, {
          turnStartTime: undefined,
          lastProgressAt: undefined,
          apiRetry: undefined,
          inputTokens: 0,
          outputTokens: 0,
          teardownReason: undefined,
          pendingReadyMessage: undefined,
          turnAcceptedForResume: false,
          ...pendingTurnMeta,
        });
        setActivityStatus(tabId, { phase: 'idle' });
      };

      const markTurnThinking = () => {
        const turnStartedAt = Date.now();
        setSessionStatus(tabId, 'running');
        setSessionMeta(tabId, {
          turnStartTime: turnStartedAt,
          lastProgressAt: turnStartedAt,
          apiRetry: undefined,
          inputTokens: 0,
          outputTokens: 0,
          pendingReadyMessage: undefined,
        });
        setActivityStatus(tabId, { phase: 'thinking' });
      };

      markTurnPending();
      lastStderrRef.current = ''; // Clear stale stderr before new turn/startup wait

      // Use stdinId (desk-generated) for stdin communication, not CLI's own sessionId.
      // stdinId exists when: (a) a pre-warmed process is waiting, or (b) follow-up in active session.
      const submitTabState = getActiveTabState();
      let stdinId = submitTabState.sessionMeta.stdinId;
      let sentViaStdin = false;

      // Phase 2 §2.1/§2.2: unified config-mismatch check. If ANY of
      // providerId / selectedModel / thinkingLevel / provider.updatedAt has
      // changed since this process was spawned, we must kill + respawn (with
      // --resume via cliResumeId from sessionStore) before sending.
      // A missing sessionSpawnHash means this session predates the field
      // (e.g. freshly reloaded old tab) — in that case we lock in the
      // current hash on the first follow-up rather than respawn.
      if (stdinId) {
        const currentHash = spawnConfigHash();
        const sessionSpawnHash = getActiveTabState().sessionMeta.spawnConfigHash;
        if (sessionSpawnHash === undefined) {
          setSessionMeta(tabId, { spawnConfigHash: currentHash });
        }
      }

      if (stdinId) {
        // Check if API provider config changed since this process was spawned (TK-303).
        // If so, the pre-warmed process has stale env vars — kill it and spawn fresh.
        const currentFp = envFingerprint();
        const sessionFp = getActiveTabState().sessionMeta.envFingerprint;
        if (currentFp !== sessionFp) {
          console.warn('[TOKENICODE] API provider config changed, killing stale session');
          // Use lifecycle teardown — properly unregisters stdinTab mapping
          await teardownSession(stdinId, tabId, 'switch');
          await waitForStdinCleared(tabId, stdinId);
          // Keep cliResumeId so we attempt resume (preserving context).
          // If the resume fails due to thinking signature mismatch, the
          // stream error handler will auto-retry without resume.
          setSessionMeta(tabId, { envFingerprint: undefined, providerSwitched: true, providerSwitchPendingText: text });
          stdinId = undefined;
        } else {
          const sessionMeta = getActiveTabState().sessionMeta;
          const runningModel = sessionMeta.spawnedModel ?? sessionMeta.model;
          const mustRestartForRoutedModel = routedModel !== null && (
            (routedModel === 'deepseek-v4-flash-vision-exp' && runningModel !== routedModel)
            || (runningModel !== undefined && runningModel !== routedModel)
          );
          if (mustRestartForRoutedModel) {
            console.warn(`[TOKENICODE] Routed model changed (${runningModel ?? 'shared config'} → ${routedModel}), restarting with resume`);
            await teardownSession(stdinId, tabId, 'switch');
            await waitForStdinCleared(tabId, stdinId);
            setSessionMeta(tabId, {
              spawnedModel: undefined,
              modelSwitched: true,
              modelSwitchPendingText: text,
            });
            didRouteModelSwitch = true;
            stdinId = undefined;
          } else {
          // Check if model changed since this process was spawned.
          // If so, kill the stale process and fall through to spawn a new one with --resume.
          const currentModel = resolveModelForProvider(selectedModel);
          const spawnedModel = getActiveTabState().sessionMeta.spawnedModel;
          if (activeProviderId && spawnedModel && currentModel !== spawnedModel) {
            const oldShort = MODEL_OPTIONS.find((m) => m.id === spawnedModel)?.short ?? spawnedModel;
            const newShort = MODEL_OPTIONS.find((m) => m.id === currentModel)?.short ?? currentModel;
            console.warn(`[TOKENICODE] Model changed (${oldShort} → ${newShort}), killing stale session`);
            // Use lifecycle teardown — properly unregisters stdinTab mapping
            await teardownSession(stdinId, tabId, 'switch');
            await waitForStdinCleared(tabId, stdinId);
            // System message already inserted by ModelSelector — no duplicate here.
            // Keep cliResumeId so we attempt resume (preserving context).
            setSessionMeta(tabId, { spawnedModel: undefined, modelSwitched: true, modelSwitchPendingText: text });
            stdinId = undefined;
          } else {
            // Phase 2 §2.1/§2.2: catch-all config-drift check covering dimensions
            // not caught by the envFingerprint / spawnedModel gates above —
            // most importantly thinkingLevel (S4 fix). When the full
            // spawnConfigHash differs, respawn with --resume (preserving
            // conversation context) so the new process picks up the new env.
            const catchAllHash = spawnConfigHash();
            const sessionHash = getActiveTabState().sessionMeta.spawnConfigHash;
            if (sessionHash !== undefined && catchAllHash !== sessionHash) {
              console.warn('[TOKENICODE] spawnConfigHash changed (thinking/misc), respawning');
              await teardownSession(stdinId, tabId, 'switch');
              await waitForStdinCleared(tabId, stdinId);
              // Unlike provider/model switch, thinking-level-only changes do NOT
              // require stripping thinking blocks — signatures remain valid.
              stdinId = undefined;
            } else {
              // ===== Send via stdin to existing persistent process (pre-warmed or follow-up) =====
              // NOTE: Do NOT gate the first message on stdinReady. Claude Code CLI 2.1.237
              // emits system:init only AFTER the first stdin message arrives, so an
              // empty-prompt pre-warm never becomes "ready" and gating here holds the first
              // message forever (the "正在启动 Agent" stuck state). Send immediately; if the
              // process has actually died, sendStdin throws and the catch below respawns.
              try {
                markTurnThinking();
                await bridge.sendStdin(
                  stdinId,
                  text,
                  imagePaths,
                );
                sentViaStdin = true;
                // Defensive: ensure spawnedModel is always recorded after first successful stdin send
                if (!getActiveTabState().sessionMeta.spawnedModel) {
                  const activeProviderId = useProviderStore.getState().activeProviderId;
                  setSessionMeta(tabId, {
                    // Native mode: leave undefined so the CLI's shared-config model governs.
                    spawnedModel: activeProviderId ? resolveModelForProvider(selectedModel) : undefined,
                  });
                }
              } catch (stdinErr) {
                // stdin write failed (broken pipe — process already exited).
                // Drop the stale stdin route via lifecycle helpers, then spawn fresh.
                console.warn('[TOKENICODE] sendStdin failed, spawning new process:', stdinErr);
                cleanupStdinRoute(stdinId);
                setSessionMeta(tabId, {
                  stdinId: undefined,
                  stdinReady: false,
                  pendingReadyMessage: undefined,
                });
                setActivityStatus(tabId, { phase: 'idle' });
                stdinId = undefined;
              }
            } // close spawnConfigHash-mismatch else
          } // close spawnedModel-mismatch else
          } // close routed-model-mismatch else
        } // close envFingerprint-mismatch else
      } // close if(stdinId) outer gate

      if (!sentViaStdin) {
        // ===== No running process: spawn a new persistent stream-json process =====

        // Mode is now passed via --mode CLI arg in startSession, not text prefix.
        // Text prefix (/ask, /plan) caused "Unknown skill" errors in stream-json mode.

        // Resume guard: only resume if the session has user-visible assistant
        // evidence. Interrupted thinking counts because the CLI has already
        // established a real conversation that the next send should continue.
        const resumeTab = useChatStore.getState().getTab(tabId);
        const tabMessages = resumeTab?.messages ?? [];
        const hasResumableEvidence = hasResumableConversationEvidence(tabMessages)
          || resumeTab?.sessionMeta.turnAcceptedForResume === true;
        const fallbackResumeId = resumeTab?.sessionMeta.sessionId;
        const existingSessionId = hasResumableEvidence
          ? (useSessionStore.getState().sessions.find((s) => s.id === tabId)?.cliResumeId
            ?? (fallbackResumeId && !fallbackResumeId.startsWith('desk_') ? fallbackResumeId : undefined))
          : undefined;

        // Clean up old stdinId listener if any (via lifecycle module)
        const oldStdinId = getActiveTabState().sessionMeta.stdinId;
        if (oldStdinId) {
          cleanupStdinRoute(oldStdinId);
          flushStreamBuffer(oldStdinId);
        }

        const cwd = workingDirectory;

        // Generate the desk-side session ID
        const preGeneratedId = `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Reset guards for the new session
        exitPlanModeSeenRef.current = false;

        // Read sessionMode from store (not closure) so plan-approve → code
        // mode switch is visible even when called via rAF.
        const liveSessionMode = useSettingsStore.getState().sessionMode;
        const didSwitchModel = didRouteModelSwitch || getActiveTabState().sessionMeta.modelSwitched || getActiveTabState().sessionMeta.providerSwitched;
        // Phase 2 §2.1: capture the spawn-time config hash BEFORE the async
        // spawn so it reflects the config that was actually used, not whatever
        // the user might change while the spawn is in flight.
        const preSpawnConfigHash = spawnConfigHash();
        const preEnvFingerprint = envFingerprint();
        setSessionMeta(tabId, {
          stdinReady: false,
          pendingReadyMessage: undefined,
        });
        markTurnThinking();

        console.log('[TOKENICODE:session] starting session', { cwd, stdinId: preGeneratedId, mode: liveSessionMode, provider: useProviderStore.getState().activeProviderId, modelSwitch: !!didSwitchModel, resumeSessionId: existingSessionId });

        // Native CCswitch mode resolves the model per turn: images use Vision,
        // while ordinary text returns to Pro.
        const model = activeProviderId ? resolveModelForProvider(selectedModel) : (routedModel ?? undefined);

        // Use lifecycle module for unified spawn
        const spawnResult = await spawnSession({
          tabId,
          stdinId: preGeneratedId,
          cwdSnapshot: cwd,
          configSnapshot: {
            model,
            providerId: activeProviderId,
            thinkingLevel: useSettingsStore.getState().thinkingLevel,
            permissionMode: mapSessionModeToPermissionMode(liveSessionMode),
          },
          sessionModeSnapshot: liveSessionMode,
          sessionParams: {
            prompt: text,
            image_paths: imagePaths,
            cwd,
            model,
            session_id: preGeneratedId,
            resume_session_id: existingSessionId || undefined,
            thinking_level: useSettingsStore.getState().thinkingLevel,
            session_mode: (liveSessionMode === 'ask' || liveSessionMode === 'plan') ? liveSessionMode : undefined,
            provider_id: activeProviderId || undefined,
            permission_mode: mapSessionModeToPermissionMode(liveSessionMode),
            model_switch: didSwitchModel ? true : undefined,
          },
          onStream: handleStreamMessage,
          onStderr: (line: string) => handleStderrLine(line, preGeneratedId),
        });

        console.log('[TOKENICODE:session] started successfully', {
          stdinId: spawnResult.sessionInfo.stdin_id,
          cliSessionId: spawnResult.sessionInfo.cli_session_id,
          pid: spawnResult.sessionInfo.pid,
          cli: spawnResult.sessionInfo.cli_path,
        });

        // Write additional meta to the current stdin owner. A draft can be
        // promoted to the real CLI session id before startSession resolves.
        const spawnOwnerTabId = useSessionStore.getState().getTabForStdin(preGeneratedId) ?? tabId;
        const existingOwnerSessionId = useChatStore.getState().getTab(spawnOwnerTabId)?.sessionMeta.sessionId;
        const nextSessionId = spawnResult.sessionInfo.cli_session_id
          ?? (spawnOwnerTabId !== tabId ? existingOwnerSessionId : undefined);
        setSessionMeta(spawnOwnerTabId, {
          sessionId: nextSessionId,
          envFingerprint: preEnvFingerprint,
          spawnedModel: model,
          stdinReady: false,
          pendingReadyMessage: undefined,
          // Phase 2 §2.1: lock in the spawn-time config hash for later
          // mismatch detection in handleSubmit and the drain paths.
          // Uses pre-computed value captured before async spawn to avoid
          // race with user config changes during the spawn window.
          spawnConfigHash: preSpawnConfigHash,
          modelSwitched: false,
          providerSwitched: false,
          modelSwitchPendingText: undefined,
          providerSwitchPendingText: undefined,
        });

        useSessionStore.getState().fetchSessions();
        // Delayed retry in case JSONL file isn't written yet
        setTimeout(() => useSessionStore.getState().fetchSessions(), 1500);
      }
    } catch (err: any) {
      // spawnSession handles its own rollback — no need to manually unlisten/unregister
      setSessionStatus(tabId, 'error');
      addMessage(tabId, {
        id: generateMessageId(),
        role: 'system',
        type: 'text',
        content: `Error: ${err}`,
        timestamp: Date.now(),
      });
      // PRD: restore user message and file attachments so nothing is lost on spawn failure.
      useChatStore.getState().setInputDraft(tabId, rawInput);
      useChatStore.getState().setSessionMeta(tabId, {
        pendingTurnMessageId: undefined,
        pendingTurnInput: undefined,
        pendingTurnAttachments: undefined,
      });
      if (savedFiles.length > 0) setFiles(savedFiles);
    }
  }, [hasActiveSession, workingDirectory, selectedModel, sessionMode, files, clearFiles]);

  // Keep ref in sync so executeImmediateCommand can call latest handleSubmit
  handleSubmitRef.current = handleSubmit;

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const testWindow = window as any;
    testWindow.__tokenicode_editor = textareaRef.current?.getEditor() || null;
    testWindow.__tokenicode_send = () => handleSubmitRef.current();
    return () => {
      if (testWindow.__tokenicode_send) delete testWindow.__tokenicode_send;
      if (testWindow.__tokenicode_editor) delete testWindow.__tokenicode_editor;
    };
  });

  // handleStreamMessage and handleBackgroundStreamMessage are provided by
  // useStreamProcessor hook (see src/hooks/useStreamProcessor.ts).

  // Handle stderr lines — detect permission prompts and other interactive requests
  const handleStderrLine = useCallback((line: string, sid: string) => {
    if (sid) {
      const ownerTabId = useSessionStore.getState().getTabForStdin(sid);
      const activeTabId = useSessionStore.getState().selectedSessionId;
      if (ownerTabId && ownerTabId !== activeTabId) {
        const clean = stripAnsi(line).trim();
        if (clean) {
          useChatStore.getState().addMessageToCache(ownerTabId, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: `[stderr] ${clean}`,
            timestamp: Date.now(),
          });
        }
        return;
      }
    }

    // Strip ANSI escape codes so regex matching works on raw text
    const clean = stripAnsi(line).trim();
    console.log('[TOKENICODE:stderr]', clean);

    // Track last non-trivial stderr line for error reporting on unexpected exit
    if (clean && !/^\s*$/.test(clean)) {
      lastStderrRef.current = clean;
    }

    const stderrTabId = useSessionStore.getState().selectedSessionId;

    // Detect ExitPlanMode prompt — create plan_review card as fallback (Plan mode only).
    // In Code/Bypass modes the CLI or Rust backend handles this — no UI card needed.
    if (/(?:Exit|Leave)\s+plan\s+mode/i.test(clean)
        && useSettingsStore.getState().sessionMode === 'plan') {
      const stderrTabState = getActiveTabState();
      const existingReview = stderrTabState.messages.find(
        (m: import('../../stores/chatStore').ChatMessage) => m.id === 'plan_review_current' && m.type === 'plan_review',
      );
      if (!existingReview || existingReview.resolved) {
        if (existingReview?.resolved) return;
        let planContent = '';
        for (let i = stderrTabState.messages.length - 1; i >= 0; i--) {
          const m = stderrTabState.messages[i];
          if (m.type === 'tool_use' && m.toolName === 'Write' && m.toolInput?.content) {
            planContent = m.toolInput.content;
            break;
          }
        }
        if (stderrTabId) {
          useChatStore.getState().addMessage(stderrTabId, {
            id: 'plan_review_current',
            role: 'assistant', type: 'plan_review',
            content: planContent, planContent: planContent,
            resolved: false, timestamp: Date.now(),
          });
          useChatStore.getState().setActivityStatus(stderrTabId, { phase: 'awaiting' });
        }
      }
      return;
    }

    // Permission prompts are now handled via SDK control protocol (P1-03/P1-04).
    // The Rust backend intercepts control_request messages from stdout and emits
    // them as tokenicode_permission_request in the stream channel, handled by
    // the stream processor. Stderr is now purely for diagnostic logging.
  }, []);

  // Keep stderr ref in sync so auto-retry logic in handleStreamMessage can call it
  handleStderrLineRef.current = handleStderrLine;

  // Register global stream handler on mount so pre-warm events (system:init,
  // process_exit) are processed immediately — not deferred until user sends.
  // Without this, a pre-warm process_exit would be silently dropped and stdinId
  // would remain set, causing sendStdin to write to a dead process.
  //
  // IMPORTANT: We intentionally do NOT clear __claudeStreamHandler in the cleanup.
  // During React's effect cycle (cleanup → setup), there's a micro-window where
  // the handler is null. If a Tauri event arrives during this window, it would be
  // silently dropped — causing the "no reply" bug where the CLI generates content
  // but the UI never shows it. The handler uses getState() internally so a stale
  // reference is safe.
  useEffect(() => {
    (window as any).__claudeStreamHandler = handleStreamMessage;
    // Drain any events that were queued while handler was unavailable
    const queue: any[] = (window as any).__claudeStreamQueue;
    if (queue && queue.length > 0) {
      console.warn(`[TOKENICODE] draining ${queue.length} queued stream events on handler mount`);
      const pending = queue.splice(0);
      for (const msg of pending) handleStreamMessage(msg);
    }
  }, [handleStreamMessage]);

  // --- Keyboard handler ---
  /** Keyboard handler for the tiptap editor.
   *  Receives a native KeyboardEvent (not React.KeyboardEvent).
   *  Return true to prevent tiptap default handling. */
  const handleKeyDown = (e: KeyboardEvent): boolean | void => {
    // Slash command navigation
    if (slashVisible) {
      const filtered = getFilteredCommandList(slashCommands, slashQuery);
      const count = filtered.length;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((prev) => (prev - 1 + count) % count);
        return true;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((prev) => (prev + 1) % count);
        return true;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.isComposing)) {
        if (filtered[slashIndex]) {
          e.preventDefault();
          handleSlashSelect(filtered[slashIndex]);
          return true;
        }
        // No matching command — close popover, let Enter fall through to submit
        if (e.key === 'Enter') {
          setSlashVisible(false);
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashVisible(false);
        return true;
      }
    }

    // History recall (Up/Down) — like VSCode Claude Code / a terminal REPL.
    // Up walks back through previously submitted inputs; Down walks forward and
    // eventually restores the draft that was on screen before navigation began.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (e.isComposing || e.keyCode === 229) return;
      // Only recall history when the caret is on the first line — otherwise
      // Up/Down keep moving the caret inside a multi-line draft.
      if (!isCaretOnFirstLine(textareaRef.current?.getEditor())) return;
      const history = getActiveTabState().messages
        .filter((m) => m.role === 'user' && m.type === 'text' && m.content.trim().length > 0)
        .map((m) => m.content.trim());
      if (history.length === 0) return;

      const idx = historyIndexRef.current;
      if (e.key === 'ArrowUp') {
        if (idx === -1) {
          historyDraftRef.current = textareaRef.current?.getText() ?? '';
          historyIndexRef.current = history.length - 1;
        } else if (idx > 0) {
          historyIndexRef.current = idx - 1;
        }
        e.preventDefault();
        setHistoryInput(history[historyIndexRef.current]);
        return true;
      }
      // ArrowDown
      if (idx === -1) return; // not navigating — let the caret move normally
      e.preventDefault();
      if (idx < history.length - 1) {
        historyIndexRef.current = idx + 1;
        setHistoryInput(history[historyIndexRef.current]);
      } else {
        historyIndexRef.current = -1;
        setInputSync(historyDraftRef.current);
      }
      return true;
    }

    // Backspace at position 0 with empty input removes the last attached prefix
    if (e.key === 'Backspace' && activePrefixes.length && (textareaRef.current?.isEmpty() ?? true)) {
      e.preventDefault();
      useCommandStore.getState().removePrefix(activePrefixes[activePrefixes.length - 1].name);
      return true;
    }

    if (e.key !== 'Enter') return;

    // Skip if IME composition is in progress (e.g. Chinese/Japanese input method
    // confirming a candidate with Enter — should NOT send the message).
    // Only trust browser-native signals: e.isComposing + keyCode 229.
    // Previously also checked TipTap's composingRef, but compositionend can be
    // missed on macOS WebKit (focus change, click outside), leaving composingRef
    // stuck true and permanently blocking Enter. See issue #66.
    if (e.isComposing || e.keyCode === 229) return;

    const keyTabState = getActiveTabState();
    const pendingInteraction = keyTabState.messages.find(
      (m: import('../../stores/chatStore').ChatMessage) => ['permission', 'question', 'plan_review'].includes(m.type) && !m.resolved,
    );
    if (pendingInteraction) {
      const inputText = (keyTabState.inputDraft || '').trim();
      const isEmptyPlanApproval = pendingInteraction.type === 'plan_review' && !inputText;
      if (!isEmptyPlanApproval && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        return true;
      }
    }

    if (e.metaKey || e.ctrlKey) {
      // Cmd+Enter / Ctrl+Enter → let tiptap insert newline (default behavior)
      return false;
    } else if (!e.shiftKey) {
      if (isStopping) {
        e.preventDefault();
        return true;
      }
      // Plain Enter → send message
      e.preventDefault();
      handleSubmit();
      return true;
    }
    // Shift+Enter → let tiptap handle (inserts hard break / new paragraph)
    return false;
  };

  // --- File handling ---
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
      // Reset the input so the same file can be selected again
      e.target.value = '';
    }
  }, [addFiles]);

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = (e as any).clipboardData?.files as FileList | undefined;
    if (items && items.length > 0) {
      e.preventDefault();
      addFiles(items);
      return true;
    }
  }, [addFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    // Internal file tree drag uses mouse events (not HTML5 drag), so won't reach here.
    // OS file drops are handled by Tauri onDragDropEvent in useFileAttachments.
  }, []);

  return (
    <div className="px-4 pt-4 pb-2 relative">
      <div className="max-w-3xl mx-auto">
        {/* Rewind Panel — positioned above the input area */}
        {showRewindPanel && (
          <RewindPanel key={selectedSessionId || 'new'} onClose={() => setShowRewindPanel(false)} />
        )}

        {/* Floating approval card — plan_review, question, or permission awaiting user response */}
        {floatingCard && (
          <div key={`${selectedSessionId || 'new'}-${floatingCard.id}`} className="mb-3 animate-scale-in">
            {floatingCard.type === 'plan_review'
              ? <PlanReviewCard message={floatingCard} floating />
              : floatingCard.type === 'permission'
                ? <PermissionCard message={floatingCard} />
                : <QuestionCard message={floatingCard} floating />}
          </div>
        )}

        {/* File upload chips */}
        {(files.length > 0 || isProcessing) && (
          <div className="mb-2">
            <FileUploadChips files={files} onRemove={removeFile} isProcessing={isProcessing} />
          </div>
        )}

        {/* Attached skills/commands — a separate chip bar above the text area so
            typing stays a clean free-text box. */}
        {activePrefixes.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {activePrefixes.map((p) => (
              <span
                key={p.name}
                className="inline-flex items-center gap-1 px-2 py-1
                  bg-accent/10 border border-accent/20 rounded-md
                  text-xs text-accent font-medium font-mono whitespace-nowrap"
              >
                {p.name}
                <button
                  onClick={() => useCommandStore.getState().removePrefix(p.name)}
                  className="hover:text-red-400 transition-smooth ml-0.5"
                >
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
                    stroke="currentColor" strokeWidth="1.5">
                    <path d="M3 3l6 6M9 3l-6 6" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Skill suggestions — click to attach, or auto-attached on submit */}
        {skillSuggestions.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-text-tertiary flex-shrink-0 mr-0.5">
              {aiSuggesting ? t('input.skillSuggestLoading') : t('input.skillSuggestLabel')}
            </span>
            {skillSuggestions.map((s) => (
              <button
                key={s.skill.name}
                onClick={() => useCommandStore.getState().addPrefix(s.skill)}
                className="inline-flex items-center gap-1 px-2 py-1
                  bg-bg-secondary border border-border-subtle rounded-md
                  text-xs text-text-secondary hover:text-text-primary
                  hover:border-accent/40 transition-smooth cursor-pointer"
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"
                  className="text-accent/70 flex-shrink-0">
                  <path d="M8 1l2.5 5 5.5.8-4 3.9.9 5.3L8 13.3 3.1 16l.9-5.3-4-3.9L5.5 6z" />
                </svg>
                {s.skill.name}
              </button>
            ))}
          </div>
        )}

        {/* Main input area */}
        <div className="relative">
          <SlashCommandPopover
            query={slashQuery}
            visible={slashVisible}
            selectedIndex={slashIndex}
            onSelect={handleSlashSelect}
            onClose={() => setSlashVisible(false)}
          />
          <div
            className={`flex items-center gap-2 bg-bg-input border rounded-2xl px-4 py-2.5
              focus-within:border-border-focus focus-within:shadow-glow
              transition-smooth group/input
              ${isDragging
                ? 'border-accent bg-accent/5 shadow-glow'
                : 'border-border-subtle'
              }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
          {/* Free-text editor (skills/commands attach as chips above, not inline) */}
          <div className="flex-1 flex items-start gap-0 min-w-0">
            <TiptapEditor
              ref={textareaRef}
              data-chat-input
              editable={!isStopping}
              onUpdate={(text) => {
                setInput(text);
                detectSlashCommand(text);
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={inputPlaceholder}
              className="flex-1 bg-transparent text-sm text-text-primary
                placeholder:text-text-tertiary resize-none outline-none
                leading-normal overflow-y-auto min-w-0 py-0.5"
            />
          </div>
          {/* Shortcut hint — visible when input area is not focused and input is empty */}
          {isStopping && (
            <span className="flex-shrink-0 self-center inline-flex items-center gap-1.5
              px-2 py-1 rounded-full border text-[10px] font-medium whitespace-nowrap
              border-border-subtle bg-bg-secondary/70 text-text-muted">
              <span className="w-2.5 h-2.5 rounded-full border-2 border-warning/30 border-t-warning animate-spin text-warning" />
              {t('input.stopping')}
            </span>
          )}
          {!input && !activePrefixes.length && !isRunning && (
            <span className="flex-shrink-0 text-[10px] text-text-tertiary/50
              group-focus-within/input:hidden select-none whitespace-nowrap
              self-center mr-1">
              {t('input.shortcutHint')}
            </span>
          )}
          {/* Stop button — visible only while running */}
          {isRunning && (
            <button
              data-testid="stop-button"
              onClick={async () => {
                const stopTabId = useSessionStore.getState().selectedSessionId;
                const sid = getActiveTabState().sessionMeta.stdinId;
                if (!stopTabId || !sid) return;

                // Use lifecycle teardown — sets 'stopping' state, keeps listeners,
                // waits for process_exit to do full finalization. The process_exit
                // handler preserves partial text/thinking as interrupted messages.
                await teardownSession(sid, stopTabId, 'stop');
              }}
              disabled={isStopping}
              className="flex-shrink-0 self-end w-8 h-8 rounded-[10px]
                flex items-center justify-center transition-smooth
                disabled:cursor-not-allowed
                disabled:bg-warning/10 disabled:text-warning
                bg-red-500/15 text-red-500
                hover:bg-red-500/25"
              title={isStopping ? t('input.stopping') : t('input.stop')}
            >
              {isStopping ? (
                <span className="w-3.5 h-3.5 rounded-full border-2 border-warning/30 border-t-warning animate-spin" />
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16"
                  fill="currentColor">
                  <rect x="3" y="3" width="10" height="10" rx="2" />
                </svg>
              )}
            </button>
          )}
          <button
            data-testid="send-button"
            onClick={handleSubmit}
            disabled={isAwaiting || isStopping || (!input.trim() && !activePrefixes.length)}
            className={`flex-shrink-0 self-end w-8 h-8 rounded-[10px]
              flex items-center justify-center transition-smooth
              disabled:opacity-30 disabled:cursor-not-allowed
              ${isAwaiting
                ? 'bg-warning/15 text-warning cursor-not-allowed'
                : 'bg-accent hover:bg-accent-hover text-text-inverse hover:shadow-glow cursor-pointer'
              }`}
            title={isAwaiting ? t('input.awaitingInteraction') : undefined}
          >
            <svg width="16" height="16" viewBox="0 0 16 16"
              fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round">
              <path d="M3 8h10M9 4l4 4-4 4" />
            </svg>
          </button>
          </div>
        </div>

        {/* Tool row: skill, upload, mode, model */}
        <div className="flex items-center gap-2 mt-2">
          {/* Add skill */}
          <div ref={skillPickerRef} className="relative">
            <button
              onClick={() => setSkillPickerVisible((v) => !v)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-text-tertiary
                hover:text-text-primary hover:bg-bg-secondary transition-smooth"
              title={t('input.addSkillTitle')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"
                className="text-accent flex-shrink-0">
                <path d="M8 1l2.5 5 5.5.8-4 3.9.9 5.3L8 13.3 3.1 16l.9-5.3-4-3.9L5.5 6z" />
              </svg>
              <span className="text-[10px] font-medium">{t('input.addSkill')}</span>
            </button>
            {skillPickerVisible && (
              <SkillPicker
                onSelect={handleSkillPick}
                onClose={() => setSkillPickerVisible(false)}
              />
            )}
          </div>

          {/* Upload button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-1.5 rounded-lg text-text-tertiary
              hover:text-text-primary hover:bg-bg-secondary
              transition-smooth"
            title={t('input.attachFiles')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M14 8.5l-5.5 5.5a3.5 3.5 0 01-5-5l6-6a2.5 2.5 0 013.5 3.5l-6 6a1.5 1.5 0 01-2-2l5.5-5.5" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />

          {/* Open project folder / in VS Code */}
          <button
            onClick={() => {
              const d = useSettingsStore.getState().workingDirectory;
              if (d) bridge.openWithDefaultApp(d).catch(() => {});
            }}
            className="p-1.5 rounded-lg text-text-tertiary
              hover:text-text-primary hover:bg-bg-secondary transition-smooth"
            title={t('input.openProjectFolder')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5">
              <path d="M1.5 4A1.5 1.5 0 013 2.5h3l1.5 2H13A1.5 1.5 0 0114.5 6v6A1.5 1.5 0 0113 13.5H3A1.5 1.5 0 011.5 12V4z" />
            </svg>
          </button>
          <button
            onClick={() => {
              const d = useSettingsStore.getState().workingDirectory;
              if (d) bridge.openInVscode(d).catch(() => {});
            }}
            className="p-1.5 rounded-lg text-text-tertiary
              hover:text-text-primary hover:bg-bg-secondary transition-smooth"
            title={t('input.openProjectInVscode')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 3L3 3v10h10v-3M9 3h4v4M13 3L7 9" />
            </svg>
          </button>

          {/* Mode selector */}
          <ModeSelector disabled={isRunning} />

          {/* Think toggle */}
          <ThinkLevelSelector disabled={isRunning} />

          {/* Rewind button */}
          {showRewind && (
            <button
              onClick={() => { if (canRewind) setShowRewindPanel(!showRewindPanel); }}
              disabled={!canRewind}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-smooth
                ${canRewind
                  ? 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary cursor-pointer'
                  : 'text-text-muted cursor-not-allowed opacity-50'
                }`}
              title={canRewind ? `${t('rewind.title')} (Esc×2)` : t('rewind.disabled')}
            >
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none"
                stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
                <path d="M2 7a5 5 0 019.33-2.5M12 7a5 5 0 01-9.33 2.5"
                  strokeLinecap="round" />
                <path d="M11 2v3h-3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3 12V9h3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-[10px]">{t('rewind.title')}</span>
            </button>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Context-window fullness meter (VSCode parity) */}
          <ContextMeter />

          {/* Plan view button */}
          <PlanToggleButton />

          {/* Model selector */}
          <ModelSelector disabled={isRunning} />
        </div>
      </div>
    </div>
  );
}
