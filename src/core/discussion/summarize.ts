/**
 * Summarizer — distills a concluded (or in-progress) discussion into a
 * `ConversationSummary` payload.
 *
 * Implementation mirrors `orchestrator.ts`: one-shot `claude -p` on the
 * `fastModel` (Haiku by default), strict JSON contract validated against
 * `conversationSummaryPayloadSchema`. Deterministic post-processing fills in
 * defaults so the resulting object always satisfies `ConversationSummary`.
 *
 * This is the seed for Phase 1.5's auto-ingest hook
 * (see `docs/development/KNOWLEDGE_WIKI.md` §16): on discussion conclude, the summary +
 * full transcript become `raw/summaries/<short>.md` and `raw/discussions/<short>.md`,
 * then ingest creates/updates wiki pages from them.
 */
import { runClaude, extractText } from '../../llm/claude-code-runner.js';
import { logger } from '../logger.js';
import { nowIso } from '../utils.js';
import { safeParseJSON, safeParseJSONWithSchema } from '../parsing/safe-json.js';
import { conversationSummaryPayloadSchema } from '../parsing/llm-response-schemas.js';
import { ContractError, ModelError } from '../errors.js';
import type {
  AdvisoryBoardMember,
  AppSettings,
  ConversationSummary,
  Discussion,
  ParticipationMetrics,
  Response,
} from '../../storage/types.js';

export interface SummarizeOptions {
  discussion: Discussion;
  members: AdvisoryBoardMember[];
  settings: AppSettings;
  signal?: AbortSignal;
}

export async function summarizeDiscussion(opts: SummarizeOptions): Promise<ConversationSummary> {
  const { discussion, members, settings, signal } = opts;

  if (discussion.rounds.length === 0) {
    // Defensive — the command-layer already guards this, but make the engine safe too.
    return deterministicFallback(discussion, members, 'Discussion has no rounds.');
  }

  const prompt = buildSummaryPrompt(discussion, members);
  logger.debug('[summarize] requesting summary', {
    discussionId: discussion.id,
    rounds: discussion.rounds.length,
    members: members.length,
  });

  let text: string;
  try {
    const result = await runClaude({
      prompt,
      model: typeof settings.fastModel === 'string' ? settings.fastModel : 'haiku',
      allowedTools: [],
      maxTurns: 1,
      maxBudgetUsd: settings.perCallBudgetUsd,
      signal,
      timeoutMs: 120_000,
    });
    text = extractText(result);
  } catch (error) {
    throw new ModelError(
      `Summary generation failed: ${error instanceof Error ? error.message : String(error)}`,
      'Re-run with `aab discuss summarize <id> --force` or check `aab doctor` for the claude CLI.',
    );
  }

  return parseSummary(text, discussion, members);
}

// ----------------------------------------------------------------------------
// Prompt
// ----------------------------------------------------------------------------

function buildSummaryPrompt(discussion: Discussion, members: AdvisoryBoardMember[]): string {
  const memberRoster = members
    .map((m) => `- ${m.name} (${m.title}): ${m.expertise.join(', ')}`)
    .join('\n');

  // Cap per-response at 6000 chars (~1500 tokens) and use an explicit editorial
  // truncation marker. Earlier versions used `…` at 1200 chars, which Haiku
  // mistook for a mid-stream cutoff and refused to summarize ("transcript
  // appears to be incomplete"). The explicit `[…truncated for summarization…]`
  // marker tells the model this was an editorial choice, not corruption.
  const PER_RESPONSE_CAP = 6000;
  const history: string[] = [];
  discussion.rounds.forEach((round) => {
    history.push(`### Round ${round.roundNumber}`);
    if (round.followUpQuestion) history.push(`(follow-up: "${round.followUpQuestion}")`);
    for (const r of round.responses) {
      const preview =
        r.content.length > PER_RESPONSE_CAP
          ? `${r.content.slice(0, PER_RESPONSE_CAP)}\n\n[…truncated for summarization — full response in the raw discussion file…]`
          : r.content;
      history.push(`**${r.memberName}** (turn ${r.turnNumber}):`);
      history.push(preview);
      history.push('');
    }
    if (round.orchestratorDecision) {
      history.push(
        `_orchestrator → ${round.orchestratorDecision.action} · confidence ${round.orchestratorDecision.confidence}%_`,
      );
    }
    history.push('');
  });

  return [
    'You are a senior analyst summarizing a multi-round advisory-board discussion.',
    '',
    '## Original question',
    `"${discussion.question}"`,
    '',
    '## Board',
    memberRoster || '(no members listed)',
    '',
    '## Transcript',
    history.join('\n').trim() || '(empty)',
    '',
    '## Your task',
    'Read the full transcript and produce a faithful, decision-grade summary that captures:',
    '1. The 3-7 most important *substantive* points the board made (keyPoints).',
    '2. The claims members converged on (consensus).',
    '3. The places members openly disagreed or hedged (disagreements).',
    '4. The 3-5 concrete actions a reader could take from this discussion (actionableInsights).',
    '5. A per-member participation breakdown (topics each covered, qualitative influence 0-100).',
    '6. An `overallQuality` score 0-100 — penalise repetition, low-information bullets, and unanchored speculation; reward concreteness, well-cited claims, and productive disagreement.',
    '',
    'Be terse and information-dense. Prefer specific claims over generic statements ("Tesla\'s gross margin slipped 4pp in Q2" beats "margins are a concern"). Quote distinctive phrasing where useful.',
    '',
    '## Output contract',
    'Return ONLY a raw JSON object — no fences, no commentary. Start with `{`, end with `}`.',
    '',
    '{',
    '  "keyPoints": ["…"],',
    '  "consensus": ["…"],',
    '  "disagreements": ["…"],',
    '  "actionableInsights": ["…"],',
    '  "participationBreakdown": [',
    '    { "memberName": "Elon Musk", "topicsCovered": ["…"], "influence": 70 }',
    '  ],',
    '  "overallQuality": 78',
    '}',
    '',
    'Every member that spoke MUST appear in `participationBreakdown` with the exact `memberName` from the roster above.',
  ].join('\n');
}

// ----------------------------------------------------------------------------
// Parse + finalize
// ----------------------------------------------------------------------------

function parseSummary(
  text: string,
  discussion: Discussion,
  members: AdvisoryBoardMember[],
): ConversationSummary {
  const strict = safeParseJSONWithSchema(text, conversationSummaryPayloadSchema);
  if (strict.success) return finalize(strict.data, discussion, members);

  const loose = safeParseJSON<Record<string, unknown>>(text);
  if (loose.success && loose.data && typeof loose.data === 'object') {
    return finalize(loose.data, discussion, members);
  }

  logger.warn(`[summarize] parse failed: ${strict.success ? '' : strict.error}; using deterministic fallback.`);
  return deterministicFallback(discussion, members, 'LLM summary unparseable.');
}

function finalize(
  parsed: Record<string, unknown>,
  discussion: Discussion,
  members: AdvisoryBoardMember[],
): ConversationSummary {
  const keyPoints = asStringArray(parsed.keyPoints);
  const consensus = asStringArray(parsed.consensus);
  const disagreements = asStringArray(parsed.disagreements);
  const actionableInsights = asStringArray(parsed.actionableInsights);
  const overallQuality = clampNumber(parsed.overallQuality, 0, 100, 50);

  // Compute participation deterministically from the transcript, then merge
  // the LLM's qualitative fields (topicsCovered, influence) on top. The LLM
  // is unreliable at counting — we let it do what it's good at (themes,
  // qualitative influence) and compute the rest ourselves.
  const breakdown = computeParticipation(discussion, members);
  if (Array.isArray(parsed.participationBreakdown)) {
    for (const raw of parsed.participationBreakdown) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const name = typeof row.memberName === 'string' ? row.memberName : undefined;
      if (!name) continue;
      const target = breakdown.find((p) => p.memberName === name);
      if (!target) continue;
      const topics = asStringArray(row.topicsCovered);
      if (topics.length > 0) target.topicsCovered = topics;
      const influence = clampNumber(row.influence, 0, 100, NaN);
      if (Number.isFinite(influence)) target.influence = influence;
    }
  }

  if (keyPoints.length === 0 && consensus.length === 0 && disagreements.length === 0) {
    throw new ContractError(
      'Summary returned no keyPoints, consensus, or disagreements — empty payload.',
      'Try `aab discuss summarize <id> --force` again, or check `aab doctor`.',
    );
  }

  return {
    keyPoints,
    consensus,
    disagreements,
    actionableInsights,
    participationBreakdown: breakdown,
    overallQuality,
    generatedAt: nowIso(),
  };
}

function deterministicFallback(
  discussion: Discussion,
  members: AdvisoryBoardMember[],
  note: string,
): ConversationSummary {
  return {
    keyPoints: [`Summary unavailable: ${note}`],
    consensus: [],
    disagreements: [],
    actionableInsights: [],
    participationBreakdown: computeParticipation(discussion, members),
    overallQuality: 0,
    generatedAt: nowIso(),
  };
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function computeParticipation(
  discussion: Discussion,
  members: AdvisoryBoardMember[],
): ParticipationMetrics[] {
  const memberById = new Map(members.map((m) => [m.id, m]));
  const byId = new Map<string, { responses: Response[]; name: string }>();

  for (const r of discussion.responses) {
    const m = memberById.get(r.memberId);
    if (!m) {
      // Member may have been deleted since the discussion ran — still count
      // their contributions under whatever name appears in the response.
      const entry = byId.get(r.memberId) ?? { responses: [], name: r.memberName };
      entry.responses.push(r);
      byId.set(r.memberId, entry);
      continue;
    }
    const entry = byId.get(m.id) ?? { responses: [], name: m.name };
    entry.responses.push(r);
    byId.set(m.id, entry);
  }

  const out: ParticipationMetrics[] = [];
  for (const [memberId, { responses, name }] of byId) {
    const totalChars = responses.reduce((sum, r) => sum + r.content.length, 0);
    out.push({
      memberId,
      memberName: name,
      totalResponses: responses.length,
      averageLength: responses.length ? Math.round(totalChars / responses.length) : 0,
      topicsCovered: [],
      influence: 50,
    });
  }

  // Stable order: highest participation first, then alphabetical.
  out.sort((a, b) => b.totalResponses - a.totalResponses || a.memberName.localeCompare(b.memberName));
  return out;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim()))
    .filter((s) => s.length > 0);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
