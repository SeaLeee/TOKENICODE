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
  const tabId = useSessionStore((s) => s.selectedSessionId);

  const resolvedModel = resolveModelForProvider(selectedModel);
  const contextWindow = is1MModel(resolvedModel) ? 1_000_000 : 200_000;
  const pct = Math.min(1, Math.max(0, contextTokens / contextWindow));
  const pctLabel = Math.round(pct * 100);

  const ringColor = pct >= 0.85 ? 'text-error' : pct >= 0.6 ? 'text-warning' : 'text-success';
  const textColor = pct >= 0.85 ? 'text-error' : pct >= 0.6 ? 'text-amber-500' : 'text-text-tertiary';

  return (
    <button
      type="button"
      onClick={() => tabId && triggerContextCompact(tabId)}
      disabled={!tabId}
      className="flex items-center gap-1.5 px-1 rounded cursor-pointer
        disabled:opacity-60 disabled:cursor-default"
      title={`${t('context.compact')} · ${contextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`}
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
  );
}
