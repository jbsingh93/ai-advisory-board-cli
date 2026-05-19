import { describe, expect, it } from 'vitest';
import {
  EXPLORER_STEPS,
  applyStep,
  buildExplorerSystemPrompt,
  extractSuggested,
  __test,
} from '../principle-explorer.js';

const { renderCrossStepContext, renderExistingFields, parseNumberedList, STEP_LABELS } = __test;

const draft = {
  title: 'Embrace Reality',
  description: 'See it as it is.',
  category: 'life' as const,
  priority: 5,
  behavior: '',
};

describe('EXPLORER_STEPS', () => {
  it('runs behavior → antipattern → triggers → examples → priority', () => {
    expect(EXPLORER_STEPS).toEqual(['behavior', 'antipattern', 'triggers', 'examples', 'priority']);
  });
});

describe('buildExplorerSystemPrompt', () => {
  it('emits the behavior step with first-message opener', () => {
    const out = buildExplorerSystemPrompt({
      principle: draft,
      history: [],
      step: 'behavior',
      isFirstMessage: true,
    });
    expect(out).toContain('CURRENT STEP: Behavior');
    expect(out).toContain('YOU lead the conversation');
    expect(out).toContain('Embrace Reality');
  });

  it('weaves cross-step context when prior turns exist', () => {
    const history = [
      { step: 'behavior' as const, role: 'user' as const, content: 'I lean toward denial.' },
      { step: 'behavior' as const, role: 'assistant' as const, content: '**Suggested Behavior:** confront daily.' },
    ];
    const out = buildExplorerSystemPrompt({
      principle: draft,
      history,
      step: 'antipattern',
      isFirstMessage: true,
    });
    expect(out).toContain('PREVIOUS STEP CONVERSATIONS');
    expect(out).toContain('Step: Behavior');
    expect(out).toContain('I lean toward denial');
  });

  it('shows existing fields on the working draft', () => {
    const out = buildExplorerSystemPrompt({
      principle: { ...draft, behavior: 'face the music', priority: 7 },
      history: [],
      step: 'priority',
      isFirstMessage: false,
    });
    expect(out).toContain('Existing Behavior: face the music');
    expect(out).toContain('Existing Priority: 7/10');
  });
});

describe('renderCrossStepContext', () => {
  it('groups by step in canonical order', () => {
    const history = [
      { step: 'examples' as const, role: 'user' as const, content: 'eg1' },
      { step: 'behavior' as const, role: 'assistant' as const, content: 'syn behavior' },
      { step: 'behavior' as const, role: 'user' as const, content: 'me behavior' },
    ];
    const out = renderCrossStepContext(history, 'priority');
    const behaviorIdx = out.indexOf('Step: Behavior');
    const examplesIdx = out.indexOf('Step: Examples');
    expect(behaviorIdx).toBeGreaterThanOrEqual(0);
    expect(examplesIdx).toBeGreaterThan(behaviorIdx);
  });

  it('skips the current step', () => {
    const history = [{ step: 'priority' as const, role: 'user' as const, content: 'p' }];
    const out = renderCrossStepContext(history, 'priority');
    expect(out).toBe('');
  });
});

describe('renderExistingFields', () => {
  it('returns empty string when no fillable fields populated', () => {
    // `priority` defaults to 5 on the draft; strip it to exercise the empty path.
    const blank = { title: 't', description: 'd', category: 'life' as const };
    expect(renderExistingFields(blank)).toBe('');
  });
  it('shows priority on the working draft when it is set', () => {
    expect(renderExistingFields(draft)).toContain('Existing Priority: 5/10');
  });
  it('includes triggers list and priority when present', () => {
    const out = renderExistingFields({ ...draft, triggerQuestions: ['q1', 'q2'], priority: 9 });
    expect(out).toContain('Existing Trigger Questions: q1 | q2');
    expect(out).toContain('Existing Priority: 9/10');
  });
});

describe('extractSuggested', () => {
  it('parses behavior synthesis', () => {
    const reply = 'Some lead-in.\n\n**Suggested Behavior:** Confront daily.\n\nDoes that match?';
    expect(extractSuggested(reply, 'behavior')).toBe('Confront daily.');
  });
  it('parses triggers synthesis with numbered list', () => {
    const reply = '**Suggested Trigger Questions:**\n1. q one\n2. q two\n3. q three\n\nThoughts?';
    expect(extractSuggested(reply, 'triggers')).toBe('1. q one\n2. q two\n3. q three');
  });
  it('parses priority synthesis with slash format', () => {
    expect(extractSuggested('**Suggested Priority:** 8/10 - high impact.', 'priority')).toBe('8/10 - high impact.');
  });
  it('handles Anti-Pattern with optional hyphen', () => {
    expect(extractSuggested('**Suggested Anti-Pattern:** Denial loop.', 'antipattern')).toBe('Denial loop.');
    expect(extractSuggested('**Suggested AntiPattern:** Denial.', 'antipattern')).toBe('Denial.');
  });
  it('returns undefined when no synthesis line present', () => {
    expect(extractSuggested('Just a question, no synthesis here.', 'behavior')).toBeUndefined();
  });
});

describe('parseNumberedList', () => {
  it('strips numbering prefixes', () => {
    expect(parseNumberedList('1. one\n2) two\n  3. three')).toEqual(['one', 'two', 'three']);
  });
  it('drops empty lines', () => {
    expect(parseNumberedList('\n\n1. a\n\n2. b\n')).toEqual(['a', 'b']);
  });
});

describe('applyStep', () => {
  it('writes behavior', () => {
    const r = applyStep(draft, 'behavior', 'confront daily');
    expect(r.behavior).toBe('confront daily');
  });
  it('writes antiPattern', () => {
    const r = applyStep(draft, 'antipattern', 'denial');
    expect(r.antiPattern).toBe('denial');
  });
  it('parses triggers into an array', () => {
    const r = applyStep(draft, 'triggers', '1. am I seeing reality?\n2. what am I avoiding?');
    expect(r.triggerQuestions).toEqual(['am I seeing reality?', 'what am I avoiding?']);
  });
  it('parses examples into an array', () => {
    const r = applyStep(draft, 'examples', '1. quarterly review\n2. cofounder pushback');
    expect(r.examples).toEqual(['quarterly review', 'cofounder pushback']);
  });
  it('clamps priority into 1..10', () => {
    expect(applyStep(draft, 'priority', '8/10 - high').priority).toBe(8);
    expect(applyStep(draft, 'priority', '99/10 - off scale').priority).toBe(10);
    expect(applyStep(draft, 'priority', '-1/10').priority).toBe(1);
  });
  it('falls back to existing priority on non-numeric input', () => {
    expect(applyStep({ ...draft, priority: 6 }, 'priority', 'unknown').priority).toBe(6);
  });
});

describe('STEP_LABELS', () => {
  it('renders friendly labels for each step', () => {
    expect(STEP_LABELS.behavior).toBe('Behavior');
    expect(STEP_LABELS.antipattern).toBe('Anti-Pattern');
    expect(STEP_LABELS.triggers).toBe('Trigger Questions');
    expect(STEP_LABELS.examples).toBe('Examples');
    expect(STEP_LABELS.priority).toBe('Priority');
  });
});
