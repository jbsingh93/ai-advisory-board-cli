/**
 * Mid-discussion member-join catch-up (Phase 7, spec §2.3 / §2.5).
 *
 * When a member joins a live discussion, an explicit, recorded choice governs
 * what they see:
 *   - `full`    → the full prior-rounds transcript (default; most consistent).
 *   - `summary` → the discussion's running summary (or an on-demand one).
 *   - `fresh`   → only the original question + the current follow-up.
 *
 * Founding/returning members always get the full transcript regardless of mode
 * — the mode only governs newcomers.
 */
import type { ConversationSummary, Response } from '../../storage/types.js';

export type CatchUpMode = 'full' | 'summary' | 'fresh';

export interface CatchUpContext {
  /** Prior-round responses to feed (empty for summary/fresh). */
  conversationHistory: Response[];
  /** Rendered summary text (summary mode only). */
  priorRoundsSummary?: string;
  /** Join framing for the user message (newcomers only). */
  joinCatchUpMode?: CatchUpMode;
}

/**
 * Build the catch-up context for one member in a follow-up round.
 *
 * @param isNewcomer  true if this member is joining the discussion this round.
 * @param mode        the catch-up mode chosen for newcomers.
 * @param fullHistory the full prior-round responses (for founding/returning + full-mode newcomers).
 * @param summaryText pre-rendered summary text (for summary-mode newcomers).
 */
export function buildCatchUpContext(
  isNewcomer: boolean,
  mode: CatchUpMode,
  fullHistory: Response[],
  summaryText: string | undefined,
): CatchUpContext {
  // Founding/returning members always get the full transcript.
  if (!isNewcomer) {
    return { conversationHistory: fullHistory };
  }
  if (mode === 'fresh') {
    return { conversationHistory: [], joinCatchUpMode: 'fresh' };
  }
  if (mode === 'summary') {
    return {
      conversationHistory: [],
      priorRoundsSummary: summaryText && summaryText.trim() ? summaryText : undefined,
      // If no summary could be produced, degrade to full framing so the
      // newcomer still gets context (we pass the full history below).
      joinCatchUpMode: summaryText && summaryText.trim() ? 'summary' : 'full',
      ...(summaryText && summaryText.trim() ? {} : { conversationHistory: fullHistory }),
    };
  }
  // full
  return { conversationHistory: fullHistory, joinCatchUpMode: 'full' };
}

/** Render a ConversationSummary into a compact catch-up text block. */
export function renderSummaryText(summary: ConversationSummary): string {
  const out: string[] = [];
  if (summary.keyPoints.length > 0) {
    out.push('Key points:');
    for (const p of summary.keyPoints) out.push(`- ${p}`);
  }
  if (summary.consensus.length > 0) {
    out.push('', 'Consensus:');
    for (const p of summary.consensus) out.push(`- ${p}`);
  }
  if (summary.disagreements.length > 0) {
    out.push('', 'Open disagreements:');
    for (const p of summary.disagreements) out.push(`- ${p}`);
  }
  if (summary.actionableInsights.length > 0) {
    out.push('', 'Actionable insights so far:');
    for (const p of summary.actionableInsights) out.push(`- ${p}`);
  }
  return out.join('\n').trim();
}
