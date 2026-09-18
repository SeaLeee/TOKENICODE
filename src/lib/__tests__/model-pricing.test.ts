import { describe, it, expect, afterEach } from 'vitest';
import { useProviderStore } from '../../stores/providerStore';
import {
  normalizeModelId,
  isClaudeModel,
  computeCost,
  resolveCostUsd,
} from '../model-pricing';

afterEach(() => {
  useProviderStore.setState({ providers: [], activeProviderId: null, loaded: false });
});

describe('normalizeModelId', () => {
  it('drops org prefix and lowercases', () => {
    expect(normalizeModelId('deepseek/deepseek-chat')).toBe('deepseek-chat');
    expect(normalizeModelId(' DeepSeek-Chat ')).toBe('deepseek-chat');
  });
});

describe('isClaudeModel', () => {
  it('detects Claude ids', () => {
    expect(isClaudeModel('claude-sonnet-4-6')).toBe(true);
    expect(isClaudeModel('anthropic/claude-opus-4-8')).toBe(true);
    expect(isClaudeModel('deepseek-chat')).toBe(false);
    expect(isClaudeModel('glm-5')).toBe(false);
  });
});

describe('computeCost', () => {
  it('computes cost from per-million-token prices', () => {
    expect(computeCost({ inputPerMtok: 0.14, outputPerMtok: 0.28 }, 1_000_000, 1_000_000))
      .toBeCloseTo(0.42);
    expect(computeCost({ inputPerMtok: 1.74, outputPerMtok: 3.48 }, 500_000, 500_000))
      .toBeCloseTo(2.61);
  });
});

describe('resolveCostUsd', () => {
  it('returns null when there is no usage', () => {
    expect(resolveCostUsd('deepseek-chat', 0, 0, 0.01)).toBeNull();
  });

  it('trusts the CLI total for Claude models', () => {
    expect(resolveCostUsd('claude-sonnet-4-6', 1000, 500, 0.0123)).toBeCloseTo(0.0123);
  });

  it('trusts the CLI total in native mode (undefined model)', () => {
    expect(resolveCostUsd(undefined, 1000, 500, 0.0456)).toBeCloseTo(0.0456);
  });

  it('computes from the built-in DeepSeek default', () => {
    // deepseek-chat (legacy) → deepseek-v4-flash rate: $0.14 in / $0.28 out.
    expect(resolveCostUsd('deepseek/deepseek-chat', 1_000_000, 0, 9.99)).toBeCloseTo(0.14);
  });

  it('uses the v4-pro rate for deepseek-v4-pro', () => {
    expect(resolveCostUsd('deepseek-v4-pro', 1_000_000, 0, 9.99)).toBeCloseTo(1.74);
  });

  it('returns null (tokens-only) for unknown non-Claude models', () => {
    expect(resolveCostUsd('some-unknown-model', 1000, 500, 0.03)).toBeNull();
  });

  it('prefers the active provider mapping override over defaults', () => {
    useProviderStore.setState({
      providers: [
        {
          id: 'p1',
          name: 'ccswitch',
          baseUrl: 'https://ccswitch.example.com',
          apiFormat: 'anthropic',
          modelMappings: [
            { tier: 'sonnet', providerModel: 'deepseek/deepseek-chat', inputPerMtok: 0.5, outputPerMtok: 1.0 },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeProviderId: 'p1',
      loaded: true,
    });

    expect(resolveCostUsd('deepseek/deepseek-chat', 1_000_000, 1_000_000, 9.99))
      .toBeCloseTo(1.5);
  });
});
