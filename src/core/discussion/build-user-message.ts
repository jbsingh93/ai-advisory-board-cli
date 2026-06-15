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
import type { RetrievedWikiPage } from '../knowledge/retrieve.js';

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
  /**
   * Absolute path to the Knowledge Wiki directory (`<workspace>/wiki`). When
   * present, the member is instructed to consult it BEFORE answering — it holds
   * everything known about the user and their business. The path is absolute
   * because the member's cwd is the project dir, not the workspace.
   */
  wikiDir?: string;
  /**
   * Pages the CLI already retrieved (deterministic keyword scoring) and wants to
   * inject as excerpts so the member doesn't have to search the wiki itself.
   * When non-empty, the member message leads with these and frames Read/Grep/Glob
   * as a fallback rather than the primary path.
   */
  retrievedContext?: RetrievedWikiPage[];
  /**
   * For a member joining mid-discussion via `summary` catch-up: a pre-rendered
   * text block summarising the prior rounds (used in place of the full
   * transcript). When set, the message frames the member as a newcomer being
   * brought up to speed.
   */
  priorRoundsSummary?: string;
  /**
   * Catch-up mode for a mid-discussion joiner (spec §2.3). Governs the framing
   * of the join note; the actual context shaping (which history to pass) is
   * done by the caller. Undefined ⇒ a returning/founding member (normal flow).
   */
  joinCatchUpMode?: 'full' | 'summary' | 'fresh';
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

  // Mid-discussion join note (newcomer being brought up to speed).
  if (opts.joinCatchUpMode) {
    lines.push('## You are joining this discussion mid-stream');
    if (opts.joinCatchUpMode === 'fresh') {
      lines.push(
        'You are being brought in for a fresh, uncontaminated take. You have NOT been given the prior rounds on purpose — respond to the question above from first principles, in your own voice.',
      );
    } else if (opts.joinCatchUpMode === 'summary') {
      lines.push(
        'You are new to this discussion. Below is a summary of what the board has covered so far — use it to ground your answer, then add your distinct perspective.',
      );
    } else {
      lines.push(
        'You are new to this discussion. The full prior-rounds transcript is included below so you can catch up — read it, then add your distinct perspective rather than repeating what others said.',
      );
    }
    lines.push('');
  }

  // Summary of prior rounds (summary catch-up mode for a newcomer).
  if (opts.priorRoundsSummary && opts.priorRoundsSummary.trim()) {
    lines.push('## Summary of prior rounds');
    lines.push(opts.priorRoundsSummary.trim());
    lines.push('');
  }

  // Pre-retrieved wiki context. The CLI scored the wiki against the question
  // and pre-fetched the most relevant pages so the member can advise directly
  // instead of searching. This is the primary grounding when present.
  const retrieved = opts.retrievedContext ?? [];
  if (retrieved.length > 0) {
    lines.push('## Retrieved knowledge — pre-fetched for you (ground your answer in this)');
    lines.push(
      `The CLI already searched the user's Knowledge Wiki and pulled the ${retrieved.length} most relevant page(s) below. Treat these as your primary context — you usually do NOT need to open the wiki yourself.`,
    );
    lines.push('');
    for (const page of retrieved) {
      lines.push(`### [[${page.slug}]]${page.title ? ` — ${page.title}` : ''} _(${page.type})_`);
      lines.push(page.excerpt.trim());
      lines.push('');
    }
  }

  // Knowledge Wiki — grounding + fallback retrieval guidance. Members spawn
  // with cwd = project dir, so the wiki (under the workspace root) is reachable
  // only by its absolute path, granted via `--add-dir`.
  if (opts.wikiDir) {
    const dir = opts.wikiDir.replace(/\\/g, '/');
    if (retrieved.length > 0) {
      lines.push('## Need more from the wiki? (fallback retrieval)');
      lines.push(
        `If the pre-fetched context above is insufficient, the full wiki is at \`${dir}\`. To dig deeper, follow these rules — they keep you within your tool budget:`,
      );
    } else {
      lines.push('## Knowledge base — consult it before answering');
      lines.push(
        `The user's Knowledge Wiki lives at \`${dir}\` — it holds what we know about the user, their business, goals, and prior decisions. Retrieve from it with these rules (they keep you within your tool budget):`,
      );
    }
    lines.push(`1. **Do NOT \`Read ${dir}/index.md\` in full** — it can exceed 256 KB and will blow your tool budget. If you must inspect it, \`Read\` it with \`limit: 150\` or \`Grep\` it for keywords.`);
    lines.push(`2. \`Grep ${dir}\` for the key terms in the question first (target \`summary:\` and \`tags:\` frontmatter). For \`[[wikilink]]\` resolution, prefer the compact catalog at \`${dir}/.aab/catalog.json\` over the index.`);
    lines.push('3. `Read` only the 1-3 most relevant pages before answering. You have a finite tool-turn budget — answer after targeted retrieval rather than browsing.');
    lines.push(
      'Tailor your answer to THIS user, not generic advice. Use web search only to fill genuine gaps the wiki does not cover. Put the wiki slugs you actually used in your `sources`.',
    );
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
