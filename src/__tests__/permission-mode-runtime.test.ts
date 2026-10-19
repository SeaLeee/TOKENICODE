import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const settingsStoreSource = readFileSync(
  resolve(__dirname, '../stores/settingsStore.ts'),
  'utf-8',
);

describe('runtime permission mode switching', () => {
  it('sends set_permission_mode for bypassPermissions on a live session', () => {
    // Regression: this early return meant switching to Bypass permissions in
    // the UI never reached the CLI, which stayed in its previous mode.
    expect(settingsStoreSource).not.toContain(
      "if (cliMode === 'bypassPermissions') return;",
    );
    expect(settingsStoreSource).toContain('bridge.setPermissionMode(stdinId, cliMode)');
  });

  it('reverts the UI and reports when the CLI rejects the switch', () => {
    expect(settingsStoreSource).toContain('setSessionModeLocal(prevState.sessionMode)');
    expect(settingsStoreSource).toContain("t('mode.switchFailed')");
  });

  it('maps every session mode to a CLI permission mode', () => {
    expect(settingsStoreSource).toContain("case 'auto': return 'bypassPermissions';");
    expect(settingsStoreSource).toContain("case 'autoMode': return 'auto';");
    expect(settingsStoreSource).toContain("case 'ask': return 'default';");
    expect(settingsStoreSource).toContain("case 'plan': return 'plan';");
    expect(settingsStoreSource).toContain("case 'editAuto': return 'acceptEdits';");
  });
});
