import { describe, expect, it } from 'vitest';
import { summariseUsage } from '../usage-summary.js';
import type { TokenUsageLog } from '../../../storage/types.js';

function log(over: Partial<TokenUsageLog> = {}): TokenUsageLog {
  return {
    id: 'l-' + Math.random().toString(36).slice(2, 8),
    feature: 'discussion',
    operationType: 'member',
    model: 'claude-sonnet-4-6',
    tokens: {
      promptTokenCount: 100,
      candidatesTokenCount: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokenCount: 300,
    },
    costUsd: 0.01,
    createdAt: '2026-05-21T10:00:00Z',
    ...over,
  };
}

describe('summariseUsage', () => {
  it('returns zeroed totals + empty buckets for empty input', () => {
    const s = summariseUsage([]);
    expect(s.totals).toEqual({
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    });
    expect(s.byDay).toEqual([]);
    expect(s.byFeature).toEqual([]);
    expect(s.byModel).toEqual([]);
    expect(s.windowStart).toBeUndefined();
    expect(s.windowEnd).toBeUndefined();
  });

  it('sums totals across all logs', () => {
    const s = summariseUsage([log(), log({ costUsd: 0.04 }), log({ costUsd: 0.02 })]);
    expect(s.totals.calls).toBe(3);
    expect(s.totals.totalTokens).toBe(900);
    expect(s.totals.costUsd).toBeCloseTo(0.07, 5);
  });

  it('groups by day ascending', () => {
    const s = summariseUsage([
      log({ createdAt: '2026-05-19T01:00:00Z' }),
      log({ createdAt: '2026-05-21T12:00:00Z' }),
      log({ createdAt: '2026-05-20T05:00:00Z' }),
      log({ createdAt: '2026-05-21T22:00:00Z' }),
    ]);
    expect(s.byDay.map((d) => d.key)).toEqual(['2026-05-19', '2026-05-20', '2026-05-21']);
    expect(s.byDay.find((d) => d.key === '2026-05-21')!.calls).toBe(2);
  });

  it('groups by feature descending by cost', () => {
    const s = summariseUsage([
      log({ feature: 'discussion', costUsd: 0.05 }),
      log({ feature: 'skill', costUsd: 0.5 }),
      log({ feature: 'sparring', costUsd: 0.2 }),
    ]);
    expect(s.byFeature.map((b) => b.key)).toEqual(['skill', 'sparring', 'discussion']);
    expect(s.byFeature[0]!.costUsd).toBeCloseTo(0.5, 5);
  });

  it('groups by model descending by cost', () => {
    const s = summariseUsage([
      log({ model: 'haiku', costUsd: 0.001 }),
      log({ model: 'opus', costUsd: 1.0 }),
      log({ model: 'sonnet', costUsd: 0.1 }),
    ]);
    expect(s.byModel.map((b) => b.key)).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('accumulates cache tokens separately from prompt + completion', () => {
    const s = summariseUsage([
      log({
        tokens: {
          promptTokenCount: 50,
          candidatesTokenCount: 100,
          cacheReadTokens: 1000,
          cacheCreationTokens: 200,
          totalTokenCount: 150,
        },
      }),
    ]);
    expect(s.totals.cacheReadTokens).toBe(1000);
    expect(s.totals.cacheCreationTokens).toBe(200);
    expect(s.totals.promptTokens).toBe(50);
    expect(s.totals.completionTokens).toBe(100);
  });

  it('sets windowStart and windowEnd to the earliest and latest createdAt', () => {
    const s = summariseUsage([
      log({ createdAt: '2026-05-19T01:00:00Z' }),
      log({ createdAt: '2026-05-21T12:00:00Z' }),
      log({ createdAt: '2026-05-20T05:00:00Z' }),
    ]);
    expect(s.windowStart).toBe('2026-05-19T01:00:00Z');
    expect(s.windowEnd).toBe('2026-05-21T12:00:00Z');
  });

  it('falls back to "unknown" for missing feature / model / date', () => {
    const malformed = log() as unknown as Record<string, unknown>;
    malformed.feature = '';
    malformed.model = '';
    malformed.createdAt = '';
    const s = summariseUsage([malformed as unknown as TokenUsageLog]);
    expect(s.byFeature[0]!.key).toBe('unknown');
    expect(s.byModel[0]!.key).toBe('unknown');
    expect(s.byDay[0]!.key).toBe('unknown');
  });
});
