/**
 * Deterministic head/tail truncation used by the sparring service to keep
 * prompts within the context window. Matches sage-council's behavior verbatim
 * (PLAN.md §4.3.15) so the user experience is identical.
 */

export const MAX_DISCUSSION_CONTEXT_CHARS = 14_000;
export const MAX_SPARRING_HISTORY_CHARS = 8_000;
export const MAX_BUSINESS_CONTEXT_CHARS = 4_000;
export const MAX_ANCHOR_RESPONSE_CHARS = 4_000;
export const TRUNCATION_MARKER_OVERHEAD = 120;

export function truncateDeterministically(input: string, maxChars: number, label: string): string {
  if (input.length <= maxChars) return input;

  const availableForContent = Math.max(maxChars - TRUNCATION_MARKER_OVERHEAD, 200);
  const headLength = Math.ceil(availableForContent * 0.7);
  const tailLength = Math.max(availableForContent - headLength, 80);
  const omittedCount = Math.max(input.length - headLength - tailLength, 0);
  const marker = `\n\n[${label} truncated to fit context window: omitted ${omittedCount} chars]\n\n`;

  return `${input.slice(0, headLength)}${marker}${input.slice(-tailLength)}`;
}
