import { describe, expect, it } from 'vitest';
import { __test, extractEnhancement } from '../ai-enhancer.js';

const { buildPrompt, cleanPersonaText, composeEnhancedPersona } = __test;

describe('buildPrompt', () => {
  it('emits the FAMOUS template when type=famous', () => {
    const out = buildPrompt('famous', 'Elon Musk', 'CEO Tesla', 'first-principles');
    expect(out).toContain('# IDENTITY LOCK: Elon Musk');
    expect(out).toContain('FAMOUS person who is widely recognized');
    expect(out).toContain('psychometricProfile');
    expect(out).toContain('cognitiveProcess');
  });

  it('emits the TOP-EXPERT template when type=expert', () => {
    const out = buildPrompt('expert', 'Alexandra Chen, CFA', 'CFO', 'capital allocation');
    expect(out).toContain('TOP 1% EXPERT');
    expect(out).toContain('among the very best in capital allocation');
    // Famous-only psychometricProfile section should NOT be in expert prompt.
    expect(out).not.toContain('psychometricProfile');
  });

  it('emits the NON-FAMOUS template and threads in currentPersona', () => {
    const out = buildPrompt('non-famous', 'Jane Doe', 'CTO', 'cloud infra', 'existing persona text');
    expect(out).toContain('NON-FAMOUS professional');
    expect(out).toContain('CURRENT PERSONA: existing persona text');
  });
});

describe('extractEnhancement', () => {
  it('parses a clean JSON envelope', () => {
    const json = JSON.stringify({
      persona: 'Persona body.',
      voiceGuide: 'Voice body.',
      psychometricProfile: ['I am direct.', 'I challenge assumptions.'],
      cognitiveProcess: 'Step 1 -> Step 2',
    });
    const r = extractEnhancement(json, 'Test');
    expect(r.persona).toContain('Persona body.');
    expect(r.persona).toContain('Psychometric Profile (BFI-2):');
    expect(r.persona).toContain('- I am direct.');
    expect(r.persona).toContain('Cognitive Process:');
    expect(r.persona).toContain('Step 1 -> Step 2');
    expect(r.voiceGuide).toBe('Voice body.');
  });

  it('strips a ```json fence', () => {
    const text = '```json\n{"persona": "body", "voiceGuide": "voice"}\n```';
    const r = extractEnhancement(text, 'Test');
    expect(r.persona).toBe('body');
    expect(r.voiceGuide).toBe('voice');
  });

  it('falls back to a regex extract on broken JSON', () => {
    const text = 'Some chatter then {"persona": "regex worked", "voiceGuide": "v"} trailing.';
    const r = extractEnhancement(text, 'Test');
    expect(r.persona).toContain('regex worked');
  });

  it('uses the hardcoded voice fallback when voiceGuide is missing', () => {
    const text = JSON.stringify({ persona: 'body' });
    const r = extractEnhancement(text, 'Elon Musk');
    expect(r.voiceGuide).toContain('First Principles Master');
  });
});

describe('cleanPersonaText', () => {
  it('strips JSON-escape leakage', () => {
    expect(cleanPersonaText('"hello\\nworld"')).toBe('hello\nworld');
  });
});

describe('composeEnhancedPersona', () => {
  it('preserves base persona when no extras', () => {
    expect(composeEnhancedPersona('base only')).toBe('base only');
  });
  it('appends Psychometric + Cognitive sections', () => {
    const out = composeEnhancedPersona('base', ['line a', 'line b'], 'Step 1 -> Step 2');
    expect(out).toMatch(/base\n\nPsychometric Profile \(BFI-2\):\n- line a\n- line b\n\nCognitive Process:\nStep 1 -> Step 2/);
  });
});
