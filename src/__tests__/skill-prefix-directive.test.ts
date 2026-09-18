import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const inputBarSource = readFileSync(
  resolve(__dirname, '../components/chat/InputBar.tsx'),
  'utf-8',
);

const i18nSource = readFileSync(
  resolve(__dirname, '../lib/i18n.ts'),
  'utf-8',
);

describe('skill prefix → directive conversion', () => {
  it('separates skill prefixes from non-skill command prefixes', () => {
    expect(inputBarSource).toContain(
      "prefixes.filter((p) => p.category === 'skill')",
    );
    expect(inputBarSource).toContain(
      "prefixes.filter((p) => p.category !== 'skill')",
    );
  });

  it('strips the leading slash so the directive names the skill slug, not "/slug"', () => {
    expect(inputBarSource).toContain("s.name.replace(/^\\//, '')");
  });

  it('emits an explicit invocation directive (not a bare /slug token)', () => {
    expect(inputBarSource).toContain("t('input.skillDirective')");
    expect(i18nSource).toContain("'input.skillDirective': '请调用 {names} 技能来完成以下任务'");
  });
});
