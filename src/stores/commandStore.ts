import { create } from 'zustand';
import { bridge, type UnifiedCommand } from '../lib/tauri-bridge';
import { useSkillMetaStore } from './skillMetaStore';
import { useSettingsStore } from './settingsStore';

interface CommandState {
  // All available commands (built-in + custom)
  commands: UnifiedCommand[];
  isLoading: boolean;

  // Prefix mode: commands/skills attached to the next message. Supports
  // attaching multiple skills at once (e.g. /skill-a /skill-b <prompt>).
  activePrefixes: UnifiedCommand[];

  // Actions
  fetchCommands: (cwd?: string) => Promise<void>;
  addPrefix: (cmd: UnifiedCommand) => void;
  removePrefix: (name: string) => void;
  clearPrefixes: () => void;
}

export const useCommandStore = create<CommandState>()((set) => ({
  commands: [],
  isLoading: false,
  activePrefixes: [],

  fetchCommands: async (cwd?: string) => {
    set({ isLoading: true });
    try {
      const dirs = useSettingsStore.getState().customSkillDirs;
      const commands = await bridge.listAllCommands(cwd, dirs.length ? dirs : undefined);
      set({ commands, isLoading: false });
    } catch (err) {
      console.error('[commandStore] fetchCommands failed:', err);
      set({ isLoading: false });
    }
  },

  // Attach a command/skill to the next message. Re-selecting the same name is
  // a no-op (dedupe) so the user can freely re-click a skill without dupes.
  // Attaching a skill also bumps its usage counter (powers "常用" ordering).
  addPrefix: (cmd) => {
    const already = useCommandStore
      .getState()
      .activePrefixes.some((p) => p.name === cmd.name);
    if (already) return;
    if (cmd.category === 'skill') {
      useSkillMetaStore.getState().recordUse(cmd.name.replace(/^\//, ''));
    }
    set((state) => ({ activePrefixes: [...state.activePrefixes, cmd] }));
  },

  removePrefix: (name) =>
    set((state) => ({
      activePrefixes: state.activePrefixes.filter((p) => p.name !== name),
    })),

  clearPrefixes: () => set({ activePrefixes: [] }),
}));
