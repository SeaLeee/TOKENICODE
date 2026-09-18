import { describe, it, expect, afterEach } from 'vitest';
import type { UnifiedCommand } from '../tauri-bridge';
import { useSkillMetaStore } from '../../stores/skillMetaStore';
import { slugOf, tokenize, scoreSkill, suggestSkills, usageBoost } from '../skill-suggestion';

function skill(name: string, description: string, overrides: Partial<UnifiedCommand> = {}): UnifiedCommand {
  return {
    name,
    description,
    source: 'global',
    category: 'skill',
    has_args: false,
    immediate: false,
    ...overrides,
  };
}

afterEach(() => {
  useSkillMetaStore.setState({ usage: {}, installedAt: {}, categories: {}, tags: {}, favorites: {}, ratings: {} });
});

describe('slugOf', () => {
  it('strips the leading slash', () => {
    expect(slugOf(skill('/summarize', ''))).toBe('summarize');
    expect(slugOf(skill('nested/path', ''))).toBe('nested/path');
  });
});

describe('tokenize', () => {
  it('splits Latin words and numbers', () => {
    expect(tokenize('Summarize this article')).toEqual(['summarize', 'this', 'article']);
  });

  it('emits CJK character bigrams for a run of CJK', () => {
    expect(tokenize('代码审查')).toEqual(['代码', '码审', '审查']);
  });

  it('keeps a single CJK char as-is', () => {
    expect(tokenize('总结')).toEqual(['总结']);
  });

  it('lowercases Latin words', () => {
    expect(tokenize('PDF Export')).toEqual(['pdf', 'export']);
  });
});

describe('scoreSkill', () => {
  it('weights a name hit at 3', () => {
    expect(scoreSkill('summarize', skill('/summarize', 'condense text'))).toBe(3);
  });

  it('weights a description hit at 1', () => {
    expect(scoreSkill('condense', skill('/summarize', 'condense text'))).toBe(1);
  });

  it('matches CJK bigrams against a Chinese-named skill', () => {
    expect(scoreSkill('帮我做代码审查', skill('/代码审查', '审查代码'))).toBeGreaterThanOrEqual(3);
  });

  it('ignores stopwords', () => {
    expect(scoreSkill('请帮我', skill('/summarize', 'condense text'))).toBe(0);
  });

  it('weights a tag hit at 2 (above description, below name)', () => {
    // 'pdf' isn't in the name or description, only in the tag list.
    expect(scoreSkill('pdf', skill('/summarize', 'condense text'), ['pdf', 'export'])).toBe(2);
  });

  it('prefers a name hit over a tag hit for the same token', () => {
    expect(scoreSkill('summarize', skill('/summarize', 'condense'), ['summarize'])).toBe(3);
  });
});

describe('usageBoost', () => {
  it('is 0 for unused skills', () => {
    expect(usageBoost(0)).toBe(0);
  });

  it('grows with diminishing returns', () => {
    expect(usageBoost(1)).toBeCloseTo(0.5);
    expect(usageBoost(3)).toBeCloseTo(1);
    // Never large enough to overtake a full extra name hit (+3) on its own.
    expect(usageBoost(1000)).toBeLessThan(3);
  });
});

describe('suggestSkills', () => {
  const skills = [
    skill('/summarize', 'condense text'),
    skill('/data-analysis', 'analyze data'),
    skill('/translate', 'translate languages'),
  ];

  it('returns [] for an empty query', () => {
    expect(suggestSkills('   ', skills)).toEqual([]);
  });

  it('filters out below-threshold (desc-only) matches', () => {
    // 'condense' only hits /summarize's description → score 1 < 2.
    const result = suggestSkills('condense', skills);
    expect(result).toEqual([]);
  });

  it('surfaces a name hit', () => {
    const result = suggestSkills('summarize', skills);
    expect(result.map((r) => r.skill.name)).toContain('/summarize');
  });

  it('excludes already-attached skills', () => {
    const result = suggestSkills('summarize', skills, { excludeNames: new Set(['/summarize']) });
    expect(result).toEqual([]);
  });

  it('breaks score ties by usage frequency', () => {
    useSkillMetaStore.setState({
      usage: { 'data-analysis': 5, summarize: 1 },
      installedAt: {},
      categories: {},
    });
    // 'data' hits both /data-analysis and /summarize? No — /summarize has no 'data'.
    // Use two skills that both hit 'data' by name.
    const two = [
      skill('/data-summary', 'summarize data'),
      skill('/data-analysis', 'analyze data'),
    ];
    useSkillMetaStore.setState({
      usage: { 'data-analysis': 5, 'data-summary': 1 },
      installedAt: {},
      categories: {},
    });
    const result = suggestSkills('data', two);
    expect(result.map((r) => r.skill.name)).toEqual(['/data-analysis', '/data-summary']);
  });

  it('surfaces a skill via a tag match', () => {
    useSkillMetaStore.setState({ tags: { summarize: ['pdf'] } });
    // 'pdf' hits neither name nor description, only the tag — tag weight 2 ≥ threshold.
    const result = suggestSkills('pdf', skills);
    expect(result.map((r) => r.skill.name)).toContain('/summarize');
  });

  it('folds the usage boost into the combined score', () => {
    useSkillMetaStore.setState({ usage: { summarize: 4 } });
    const [top] = suggestSkills('summarize', skills);
    // relevance 3 (name hit) + usageBoost(4) = 3 + 0.5*log2(5) ≈ 4.16
    expect(top.relevance).toBe(3);
    expect(top.score).toBeGreaterThan(3);
  });

  it('never lets usage alone surface an irrelevant skill', () => {
    useSkillMetaStore.setState({ usage: { translate: 999 } });
    const result = suggestSkills('summarize', skills);
    expect(result.map((r) => r.skill.name)).not.toContain('/translate');
  });

  it('ranks a custom-folder skill above an equally-relevant global one', () => {
    const two = [
      skill('/summarize', 'condense text'),
      skill('/summarize-mine', 'condense text', { source: 'custom' }),
    ];
    // Both hit 'summarize' by name (relevance 3); the custom one gets the boost.
    const result = suggestSkills('summarize', two);
    expect(result[0].skill.name).toBe('/summarize-mine');
  });
});
