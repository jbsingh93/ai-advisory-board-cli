import { describe, expect, it } from 'vitest';
import {
  MAX_ANCHOR_RESPONSE_CHARS,
  MAX_BUSINESS_CONTEXT_CHARS,
  MAX_DISCUSSION_CONTEXT_CHARS,
  MAX_SPARRING_HISTORY_CHARS,
  TRUNCATION_MARKER_OVERHEAD,
  truncateDeterministically,
} from '../truncate.js';

describe('truncate constants', () => {
  it('matches sage-council PLAN.md §4.3.15 verbatim', () => {
    // These caps are exposed as part of the public contract — if a future
    // refactor wants to change one, it's a deliberate decision that should
    // require touching this test.
    expect(MAX_DISCUSSION_CONTEXT_CHARS).toBe(14_000);
    expect(MAX_SPARRING_HISTORY_CHARS).toBe(8_000);
    expect(MAX_BUSINESS_CONTEXT_CHARS).toBe(4_000);
    expect(MAX_ANCHOR_RESPONSE_CHARS).toBe(4_000);
    expect(TRUNCATION_MARKER_OVERHEAD).toBe(120);
  });
});

describe('truncateDeterministically', () => {
  it('returns the input unchanged when within budget', () => {
    const input = 'hello world';
    const out = truncateDeterministically(input, 1000, 'Test');
    expect(out).toBe(input);
  });

  it('returns the input unchanged when exactly at budget', () => {
    const input = 'a'.repeat(1000);
    const out = truncateDeterministically(input, 1000, 'Test');
    expect(out).toBe(input);
  });

  it('emits a marker with the omitted-chars count when over budget', () => {
    const input = 'a'.repeat(2000) + 'TAIL_MARKER';
    const out = truncateDeterministically(input, 500, 'Discussion context');
    expect(out).toContain('[Discussion context truncated to fit context window: omitted');
    expect(out).toContain('chars]');
    // Must preserve the tail so the model can see the most recent content.
    expect(out).toMatch(/TAIL_MARKER\s*$/);
  });

  it('preserves head 70/tail 30 split (with marker overhead carved out)', () => {
    const input = 'HEAD' + 'x'.repeat(20_000) + 'TAIL';
    const out = truncateDeterministically(input, 1000, 'X');
    expect(out.startsWith('HEAD')).toBe(true);
    expect(out.endsWith('TAIL')).toBe(true);
    // Roughly head 70 / tail 30 of the post-marker budget
    const availableForContent = 1000 - TRUNCATION_MARKER_OVERHEAD;
    const expectedHead = Math.ceil(availableForContent * 0.7);
    expect(out.slice(0, expectedHead).startsWith('HEAD')).toBe(true);
  });

  it('uses the supplied label in the marker', () => {
    const input = 'x'.repeat(5_000);
    const out = truncateDeterministically(input, 500, 'Sparring history');
    expect(out).toContain('[Sparring history truncated to fit context window:');
  });

  it('guarantees a minimum tail length of 80 chars', () => {
    // Even with a tiny maxChars, the tail clamp at 80 means we always show
    // the last bit of the input.
    const input = 'A' + 'x'.repeat(1000) + 'TAIL_FINGERPRINT';
    const out = truncateDeterministically(input, 250, 'X');
    expect(out).toContain('TAIL_FINGERPRINT');
  });
});
