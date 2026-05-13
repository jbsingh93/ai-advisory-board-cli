/**
 * Build the user message we send into a member sub-agent.
 *
 * The member's identity / voice / persona / output contract live in their
 * `.claude/agents/<slug>.md` body (rendered at init time). The user message
 * carries only the per-call payload: round mode, the original question,
 * previous responses, business context, and any follow-up prompt.
 *
 * Mode prefixes are documented in the agent file body so the agent knows
 * which response shape to produce:
 *   [ROUND: 1 | INITIAL]
 *   [ROUND: N | MULTI_TURN | IS_FOLLOW_UP: true|false]
 *   [FOLLOWUP_QUESTION]
 *   [SPARRING]
 */

import type { AdvisoryBoardMember, BusinessContext, Response } from '../../storage/types.js';

export interface BuildMessageOptions {
  question: string;
  member: AdvisoryBoardMember;
  roundNumber: number;
  /** Responses produced earlier in this same round (siblings — same round). */
  previousResponsesInRound?: Response[];
  /** Full prior-round responses across the whole discussion. */
  conversationHistory?: Response[];
  /** Business context from storage to inject. */
  businessContext?: BusinessContext[];
  /** Was the user's original message a follow-up question? */
  isFollowUp?: boolean;
  /** Free-form follow-up question to put at the bottom (overrides original q). */
  followUpQuestion?: string;
}

const MAX_BUSINESS_CONTEXT_CHARS = 3500;
const MAX_BUSINESS_CONTEXT_ITEMS = 12;
const MAX_HISTORY_RESPONSE_CHARS = 1200;

export function buildMemberUserMessage(opts: BuildMessageOptions): string {
  const lines: string[] = [];

  // Mode prefix
  if (opts.roundNumber === 1 && !opts.followUpQuestion) {
    lines.push(`[ROUND: 1 | INITIAL]`);
  } else if (opts.followUpQuestion) {
    lines.push(`[FOLLOWUP_QUESTION]`);
  } else {
    lines.push(`[ROUND: ${opts.roundNumber} | MULTI_TURN | IS_FOLLOW_UP: ${opts.isFollowUp ? 'true' : 'false'}]`);
  }
  lines.push('');

  // Original question
  lines.push('## Original question');
  lines.push(opts.question.trim());
  lines.push('');

  // Follow-up (if present)
  if (opts.followUpQuestion) {
    lines.push('## User follow-up question');
    lines.push(opts.followUpQuestion.trim());
    lines.push('');
  }

  // Business context
  const contextBlock = renderBusinessContext(opts.businessContext ?? []);
  if (contextBlock) {
    lines.push('## Business context');
    lines.push(contextBlock);
    lines.push('');
  }

  // Conversation history (prior rounds)
  if (opts.conversationHistory && opts.conversationHistory.length > 0) {
    lines.push('## Prior rounds (chronological)');
    for (const r of opts.conversationHistory) {
      const truncated = truncate(r.content, MAX_HISTORY_RESPONSE_CHARS);
      lines.push(`**${r.memberName}** (round ${r.roundNumber}):`);
      lines.push(truncated);
      lines.push('');
    }
  }

  // Previous responses in this round (siblings)
  if (opts.previousResponsesInRound && opts.previousResponsesInRound.length > 0) {
    lines.push('## Other members in this round so far');
    for (const r of opts.previousResponsesInRound) {
      const truncated = truncate(r.content, MAX_HISTORY_RESPONSE_CHARS);
      lines.push(`**${r.memberName}**:`);
      lines.push(truncated);
      lines.push('');
    }
  }

  // Closing nudge
  lines.push('---');
  lines.push(
    `Respond as ${opts.member.name} per your output contract — return ONLY the JSON object specified in your system prompt. Start with \`{\` and end with \`}\`. No prose, no fences.`,
  );

  return lines.join('\n');
}

function renderBusinessContext(contexts: BusinessContext[]): string {
  const active = contexts.filter((c) => c.isActive);
  if (active.length === 0) return '';
  const sorted = [...active].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  const limited = sorted.slice(0, MAX_BUSINESS_CONTEXT_ITEMS);
  const grouped = limited.reduce<Record<string, BusinessContext[]>>((acc, ctx) => {
    (acc[ctx.category] ??= []).push(ctx);
    return acc;
  }, {});
  const sections = Object.entries(grouped).map(([cat, list]) => {
    const items = list.map((ctx) => `- **${ctx.title}**: ${ctx.description}`).join('\n');
    return `### ${cat.toUpperCase()}\n${items}`;
  });
  const full = sections.join('\n\n');
  return full.length > MAX_BUSINESS_CONTEXT_CHARS
    ? full.slice(0, MAX_BUSINESS_CONTEXT_CHARS) + '\n\n[business context trimmed]'
    : full;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}
