import { describe, expect, it } from 'vitest';
import { buildDecisionCoachSystemPrompt, newDecisionSession, __test } from '../decision-coach.js';
import type { Principle } from '../../../storage/types.js';

const { extractReferencedPrincipleIds, mergeAppliedPrinciples, renderPrincipleForPrompt, buildTranscript, buildCoachWikiInstruction } = __test;

function p(overrides: Partial<Principle>): Principle {
  return {
    id: overrides.id ?? 'p-test',
    category: overrides.category ?? 'work',
    title: overrides.title ?? 'Test Principle',
    description: overrides.description ?? 'desc',
    behavior: overrides.behavior ?? 'do the thing',
    antiPattern: overrides.antiPattern,
    triggerQuestions: overrides.triggerQuestions,
    priority: overrides.priority ?? 5,
    examples: overrides.examples,
    isActive: overrides.isActive ?? true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('buildDecisionCoachSystemPrompt', () => {
  it('injects principles ordered by priority descending', () => {
    const principles = [
      p({ id: '1', title: 'Low', priority: 2 }),
      p({ id: '2', title: 'High', priority: 9 }),
      p({ id: '3', title: 'Mid', priority: 5 }),
    ];
    const prompt = buildDecisionCoachSystemPrompt(principles);
    const highIdx = prompt.indexOf('High');
    const midIdx = prompt.indexOf('Mid');
    const lowIdx = prompt.indexOf('Low');
    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(midIdx).toBeGreaterThan(highIdx);
    expect(lowIdx).toBeGreaterThan(midIdx);
  });

  it('skips inactive principles', () => {
    const principles = [p({ id: '1', title: 'Active' }), p({ id: '2', title: 'Inactive', isActive: false })];
    const prompt = buildDecisionCoachSystemPrompt(principles);
    expect(prompt).toContain('Active');
    expect(prompt).not.toContain('**Inactive**');
  });

  it('emits the no-principles fallback when none are active', () => {
    const prompt = buildDecisionCoachSystemPrompt([]);
    expect(prompt).toContain('(no principles defined yet');
  });

  it('instructs the coach to ground time-sensitive facts via web search', () => {
    const prompt = buildDecisionCoachSystemPrompt([p({ title: 'Embrace Reality' })]);
    expect(prompt).toContain('WebSearch');
    expect(prompt).toContain('WebFetch');
    // Mentions the stale-training failure mode the web-search grounding fixes.
    expect(prompt.toLowerCase()).toContain('public');
    expect(prompt.toLowerCase()).toContain('cutoff');
  });
});

describe('buildCoachWikiInstruction', () => {
  it('embeds the wiki dir (forward-slashed) and the catalog-first guidance', () => {
    const out = buildCoachWikiInstruction('C:\\ws\\wiki');
    expect(out).toContain('C:/ws/wiki');
    expect(out).toContain('.aab/catalog.json');
    // Must steer away from reading the mega-index in full.
    expect(out).toContain('index.md');
  });

  it('carries the "fuel for sharper questions, do NOT lecture" guardrail', () => {
    const out = buildCoachWikiInstruction('/ws/wiki');
    const lower = out.toLowerCase();
    expect(lower).toContain('sharper');
    expect(lower).toContain('never subject matter');
    // Explicitly forbids summarizing/advising on the wiki contents.
    expect(lower).toContain('do not summarize');
    expect(lower).toContain('not a business advisor');
  });

  it('keeps wiki as the default source and web search as the fallback', () => {
    const out = buildCoachWikiInstruction('/ws/wiki').toLowerCase();
    expect(out).toContain('default source');
    expect(out).toContain('fallback');
  });
});

describe('renderPrincipleForPrompt', () => {
  it('includes priority, category, description, behavior, anti-pattern, triggers', () => {
    const out = renderPrincipleForPrompt(
      p({
        title: 'Embrace Reality',
        priority: 9,
        category: 'life',
        behavior: 'face it',
        antiPattern: 'denial',
        triggerQuestions: ['q1', 'q2'],
      }),
    );
    expect(out).toContain('**Embrace Reality**');
    expect(out).toContain('priority 9/10');
    expect(out).toContain('Behavior: face it');
    expect(out).toContain('Anti-pattern: denial');
    expect(out).toContain('Trigger questions: q1 | q2');
  });
});

describe('newDecisionSession', () => {
  it('creates a fresh session with empty messages + applied principles', () => {
    const s = newDecisionSession('Should I ship?', 'Pivot decision');
    expect(s.situation).toBe('Should I ship?');
    expect(s.title).toBe('Pivot decision');
    expect(s.messages).toEqual([]);
    expect(s.appliedPrinciples).toEqual([]);
    expect(s.status).toBe('active');
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('leaves title undefined when not provided', () => {
    const s = newDecisionSession('What now?');
    expect(s.title).toBeUndefined();
  });
});

describe('extractReferencedPrincipleIds', () => {
  it('matches principles by title substring (case-insensitive)', () => {
    const principles = [
      p({ id: 'a', title: 'Embrace Reality' }),
      p({ id: 'b', title: 'Disagree and Commit' }),
    ];
    const text = 'Your **Embrace Reality** principle suggests facing the truth.';
    expect(extractReferencedPrincipleIds(text, principles)).toEqual(['a']);
  });

  it('returns unique ids when a title appears multiple times', () => {
    const principles = [p({ id: 'a', title: 'Truth' })];
    expect(extractReferencedPrincipleIds('Truth Truth Truth.', principles)).toEqual(['a']);
  });
});

describe('mergeAppliedPrinciples', () => {
  it('dedupes new ids against existing ones', () => {
    expect(mergeAppliedPrinciples(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});

describe('buildTranscript', () => {
  it('prefixes with SITUATION and labels turns', () => {
    const s = newDecisionSession('Ship the pivot?');
    const userTurn = { id: 'u', sessionId: s.id, role: 'user' as const, content: 'I am scared.', createdAt: '' };
    const out = buildTranscript(s, userTurn, false);
    expect(out).toContain('SITUATION: Ship the pivot?');
    expect(out).toContain('USER: I am scared.');
  });

  it('emits opener placeholder for empty session + no user turn', () => {
    const s = newDecisionSession('Ship?');
    const out = buildTranscript(s, null, true);
    expect(out).toContain('(no user messages yet');
  });
});
