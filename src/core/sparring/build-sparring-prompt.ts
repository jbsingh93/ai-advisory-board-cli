/**
 * Sparring-deep-dive prompt builder. Ported from sage-council's
 * `sparring_deep_dive` template + fallback prompt (sparring-service.ts:441-485).
 *
 * The prompt instructs the model — speaking AS the named board member — to go
 * significantly deeper than the original board response: concrete examples,
 * stated assumptions/tradeoffs, pushback, real-world parallels, markdown
 * headings + bullets (no wall-of-text). Web search is allowed (via the agent's
 * allowedTools), but the sub-agent file is also where tool restrictions live.
 */

import type { AdvisoryBoardMember, Discussion, Response, SparringMessage } from '../../storage/types.js';
import {
  MAX_ANCHOR_RESPONSE_CHARS,
  MAX_DISCUSSION_CONTEXT_CHARS,
  MAX_SPARRING_HISTORY_CHARS,
  truncateDeterministically,
} from './truncate.js';

export interface BuildSparringPromptOptions {
  member: AdvisoryBoardMember;
  discussion: Discussion;
  anchorResponse: string;
  history: SparringMessage[];
  /** The user's new message that we're about to answer. Appended to history. */
  pendingUserMessage?: string;
}

export function buildSparringUserMessage(opts: BuildSparringPromptOptions): string {
  const {
    member,
    discussion,
    anchorResponse,
    history,
    pendingUserMessage,
  } = opts;

  const fullHistory: SparringMessage[] = pendingUserMessage
    ? [
        ...history,
        {
          id: 'pending',
          sessionId: 'pending',
          role: 'user' as const,
          content: pendingUserMessage,
          sources: [],
          createdAt: new Date().toISOString(),
        },
      ]
    : history;

  const renderedHistory = fullHistory
    .map((message) => `${message.role === 'user' ? 'User' : member.name}: ${message.content}`)
    .join('\n\n');

  const sparringHistory = truncateDeterministically(
    renderedHistory,
    MAX_SPARRING_HISTORY_CHARS,
    'Sparring history',
  );
  const discussionContext = buildDiscussionContext(discussion);
  const anchor = truncateDeterministically(anchorResponse, MAX_ANCHOR_RESPONSE_CHARS, 'Anchor response');

  return `# 1:1 DEEP DIVE SPARRING SESSION

You are ${member.name}, ${member.title}. You are in a private 1:1 deep-dive conversation with a user who wants to go deeper on your advisory board response.

## YOUR EXPERTISE
${member.expertise.join(', ')}

## YOUR PERSONA
${member.persona}

${member.voiceGuide ? `## YOUR VOICE GUIDE\n${member.voiceGuide}\n` : ''}
## ORIGINAL BOARD QUESTION
"${discussion.question}"

## YOUR ORIGINAL BOARD RESPONSE (ANCHOR)
${anchor}

## BROADER DISCUSSION CONTEXT
${discussionContext}

## SPARRING CONVERSATION SO FAR
${sparringHistory || '(no prior messages — this is the first deep-dive turn)'}

## YOUR TASK
Provide a deep, nuanced response that goes significantly beyond your original board answer:
- Give concrete examples and counterexamples
- Explicitly state assumptions and tradeoffs
- Challenge the user's thinking if appropriate
- Reference real-world parallels and data
- Be specific and actionable, not generic

## FORMATTING REQUIREMENTS
- Use ## and ### headers to organize your response into clear sections
- Use bullet points (-) or numbered lists (1.) for multiple items
- Use **bold** for key terms and important concepts
- Separate sections with blank lines for readability
- Do NOT output as a single wall of text

Respond directly as ${member.name} in first person. Output plain markdown — do NOT wrap your response in JSON.`;
}

function buildDiscussionContext(discussion: Discussion): string {
  const lines: string[] = [];
  lines.push(`Primary question: "${discussion.question}"`);
  lines.push(`Total turns so far: ${discussion.totalTurns}`);

  const hasRounds = discussion.rounds.length > 0;
  const groupedByRound = hasRounds
    ? discussion.rounds.map((round) => ({
        roundNumber: round.roundNumber,
        responses: [...round.responses].sort((a, b) => a.turnNumber - b.turnNumber),
      }))
    : groupResponsesByRound(discussion.responses);

  if (groupedByRound.length === 0) {
    lines.push('No prior board responses yet.');
    return lines.join('\n');
  }

  for (const round of groupedByRound) {
    lines.push(`\nRound ${round.roundNumber}`);
    for (const response of round.responses) {
      const followUpSuffix = response.isFollowUp ? ' (follow-up)' : '';
      lines.push(`- ${response.memberName} | Turn ${response.turnNumber}${followUpSuffix}: ${response.content}`);
    }
  }

  return truncateDeterministically(lines.join('\n'), MAX_DISCUSSION_CONTEXT_CHARS, 'Discussion context');
}

function groupResponsesByRound(responses: Response[]): Array<{ roundNumber: number; responses: Response[] }> {
  const byRound = new Map<number, Response[]>();
  for (const response of responses) {
    const rounded = byRound.get(response.roundNumber) ?? [];
    rounded.push(response);
    byRound.set(response.roundNumber, rounded);
  }

  return Array.from(byRound.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([roundNumber, roundResponses]) => ({
      roundNumber,
      responses: roundResponses.sort((a, b) => a.turnNumber - b.turnNumber),
    }));
}
