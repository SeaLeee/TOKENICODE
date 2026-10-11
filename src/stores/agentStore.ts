import { create } from 'zustand';

// --- Types ---

export type AgentPhase = 'spawning' | 'thinking' | 'writing' | 'tool' | 'completed' | 'error';

/** How much of a subagent's transcript to keep, in characters (the tail). */
const AGENT_OUTPUT_CAP = 8000;

export interface AgentNode {
  id: string;
  parentId: string | null;
  description: string;
  phase: AgentPhase;
  currentTool?: string;
  startTime: number;
  endTime?: number;
  isMain: boolean;
  /** The prompt that spawned this agent (a subagent's Task input). The VS Code
   *  extension's agent map shows this in an agent's detail view. */
  prompt?: string;
  /** What the agent returned when it finished. The stream carried it all along
   *  (`parent_tool_use_id` results) but it used to be dropped — only the phase
   *  was kept — so the detail view had nothing to show. */
  result?: string;
  /** What the agent said while it ran — the transcript the extension's agent map
   *  shows as "output". Accumulated once per completed text block, not per
   *  streamed token, and capped: only the tail matters for reading progress. */
  output?: string;
}

interface AgentState {
  agents: Map<string, AgentNode>;
  /** Per-session agent cache for tab switching */
  agentCache: Map<string, Map<string, AgentNode>>;

  upsertAgent: (node: Partial<AgentNode> & { id: string }) => void;
  updatePhase: (id: string, phase: AgentPhase, currentTool?: string) => void;
  completeAgent: (id: string, phase?: AgentPhase, result?: string) => void;
  /** Append a finished text block to an agent's output (subagents only). */
  appendOutput: (id: string, text: string) => void;
  completeAll: (phase?: AgentPhase) => void;
  clearAgents: () => void;
  /** Save current agents to cache for a tab */
  saveToCache: (tabId: string) => void;
  /** Restore agents from cache for a tab (returns true if found) */
  restoreFromCache: (tabId: string) => boolean;
  /** Drop per-tab cache entry (call when the session is deleted) — fixes #B9 ghost-agent on delete+recreate with same ID */
  clearCacheForTab: (tabId: string) => void;
}

// --- Store ---

export const useAgentStore = create<AgentState>()((set, get) => ({
  agents: new Map(),
  agentCache: new Map(),

  upsertAgent: (node) => {
    const next = new Map(get().agents);
    const existing = next.get(node.id);
    next.set(node.id, { ...existing, ...node } as AgentNode);
    set({ agents: next });
  },

  updatePhase: (id, phase, currentTool) => {
    const next = new Map(get().agents);
    const agent = next.get(id);
    if (agent && agent.phase !== 'completed' && agent.phase !== 'error') {
      if (agent.phase === 'writing' && phase === 'thinking') {
        return;
      }
      next.set(id, { ...agent, phase, currentTool });
      set({ agents: next });
    }
  },

  appendOutput: (id, text) => {
    const next = new Map(get().agents);
    const agent = next.get(id);
    if (!agent || !text) return;
    const combined = (agent.output ?? '') + (agent.output ? '\n\n' : '') + text;
    // Keep the tail: a long-running agent's transcript is not worth unbounded memory.
    const capped = combined.length > AGENT_OUTPUT_CAP
      ? combined.slice(combined.length - AGENT_OUTPUT_CAP)
      : combined;
    next.set(id, { ...agent, output: capped });
    set({ agents: next });
  },

  completeAgent: (id, phase = 'completed', result) => {
    const next = new Map(get().agents);
    const agent = next.get(id);
    if (agent && agent.phase !== 'completed' && agent.phase !== 'error') {
      next.set(id, {
        ...agent,
        phase,
        endTime: Date.now(),
        currentTool: undefined,
        ...(result ? { result } : {}),
      });
      set({ agents: next });
    }
  },

  completeAll: (phase = 'completed') => {
    const next = new Map(get().agents);
    let changed = false;
    for (const [id, agent] of next) {
      if (agent.phase !== 'completed' && agent.phase !== 'error') {
        next.set(id, { ...agent, phase, endTime: Date.now(), currentTool: undefined });
        changed = true;
      }
    }
    if (changed) set({ agents: next });
  },

  clearAgents: () => set({ agents: new Map() }),

  saveToCache: (tabId) => {
    const next = new Map(get().agentCache);
    next.set(tabId, new Map(get().agents));
    set({ agentCache: next });
  },

  restoreFromCache: (tabId) => {
    const cached = get().agentCache.get(tabId);
    if (!cached) {
      set({ agents: new Map() });
      return false;
    }
    set({ agents: new Map(cached) });
    return true;
  },

  clearCacheForTab: (tabId) => {
    const current = get().agentCache;
    if (!current.has(tabId)) return;
    const next = new Map(current);
    next.delete(tabId);
    set({ agentCache: next });
  },
}));

// --- Helpers ---

/** Resolve which agent a stream event belongs to based on parent_tool_use_id */
export function resolveAgentId(
  parentToolUseId: string | null | undefined,
  agents: Map<string, AgentNode>,
): string {
  if (!parentToolUseId) return 'main';
  if (agents.has(parentToolUseId)) return parentToolUseId;
  return 'main';
}

/** Compute nesting depth of an agent (main = 0, direct sub-agent = 1, etc.) */
export function getAgentDepth(
  agentId: string,
  agents: Map<string, AgentNode>,
): number {
  let depth = 0;
  let current = agents.get(agentId);
  while (current && !current.isMain && current.parentId) {
    depth++;
    current = agents.get(current.parentId);
    if (depth > 10) break; // safety guard against cycles
  }
  return depth;
}
