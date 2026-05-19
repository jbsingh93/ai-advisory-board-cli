import { describe, expect, it } from 'vitest';
import { getFallbackVoiceGuide } from '../fallback-voice-guides.js';

describe('getFallbackVoiceGuide', () => {
  it('recognises Elon Musk', () => {
    expect(getFallbackVoiceGuide('Elon Musk')).toContain('First Principles Master');
    expect(getFallbackVoiceGuide('elon r. musk')).toContain('First Principles Master');
  });
  it('recognises Steve Jobs', () => {
    expect(getFallbackVoiceGuide('Steve Jobs')).toContain('Perfectionist Visionary');
  });
  it('recognises Jeff Bezos', () => {
    expect(getFallbackVoiceGuide('Jeff Bezos')).toContain('Long-term Builder');
  });
  it('falls back to a generic voice with expertise context', () => {
    const out = getFallbackVoiceGuide('Jane Doe', { expertise: ['AI', 'product'] });
    expect(out).toContain('Distinctive Voice');
    expect(out).toContain('Draw from your specific expertise in AI, product');
  });
  it('generic voice without expertise omits the expertise clause', () => {
    const out = getFallbackVoiceGuide('Anonymous');
    expect(out).toContain('Distinctive Voice');
    expect(out).not.toContain('Draw from your specific expertise');
  });
});
