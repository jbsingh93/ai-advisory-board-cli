/**
 * Sparring service (Phase 3) — 1:1 deep dives anchored at a specific
 * (member, round, turn) of an existing discussion. Ported from
 * sage-council/src/lib/sparring-service.ts and adapted to the CLI's
 * shell-out-to-claude model.
 *
 * Truncation budgets, multi-section prompt layout, deterministic head/tail
 * trimming with a `[…truncated N chars…]` marker, and the
 * researchModel → primaryModel fallback are preserved verbatim
 * (PLAN.md §4.3.15).
 */
import { extractText, runClaude, type ClaudeStreamEvent } from '../../llm/claude-code-runner.js';
import { logger } from '../logger.js';
import { generateUUID, nowIso } from '../utils.js';
import { memberAgentSlug } from '../../agents/emit-member-agent.js';
import type {
  AdvisoryBoardMember,
  AppSettings,
  Discussion,
  Response,
  SparringMessage,
  SparringSession,
  SparringSource,
  StorageService,
  TokenUsageLog,
} from '../../storage/types.js';
import { buildSparringUserMessage } from './build-sparring-prompt.js';
import { maybeEnqueueUserInput } from '../knowledge/ingest-queue.js';

const ANCHOR_PREVIEW_CHARS = 220;
const DEFAULT_TOOLS = ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'];

export interface SparringActivityEvent {
  activity: string;
  tool?: string;
  detail?: string;
}

export interface OpenSparringOptions {
  discussion: Discussion;
  member: AdvisoryBoardMember;
  /** 1-based round number the anchor lives in. */
  anchorRoundNumber?: number;
  /** 1-based turn number the anchor lives in (within that round). */
  anchorTurnNumber?: number;
  title?: string;
  storage: StorageService;
}

export interface OpenSparringResult {
  session: SparringSession;
  /** True when an existing session at the same (memberId, round, turn) was reused. */
  reused: boolean;
}

/**
 * Find or create the canonical sparring session for a (discussion, member,
 * anchor) triple. Sage-council uses getOrCreateSparringSession; we mirror that
 * shape so the UI's "open the spar panel" gesture is idempotent. If no anchor
 * is provided, we pick the member's most recent response in this discussion.
 */
export async function openSparringSession(opts: OpenSparringOptions): Promise<OpenSparringResult> {
  const anchor = pickAnchorResponse(opts.discussion, opts.member.id, opts.anchorRoundNumber, opts.anchorTurnNumber);
  if (!anchor) {
    throw new Error(
      `No response from ${opts.member.name} found in this discussion to anchor the sparring session on.`,
    );
  }

  const existing = await opts.storage.loadSparringSessionsForDiscussion(opts.discussion.id);
  const match = existing.find(
    (s) =>
      s.memberId === opts.member.id &&
      s.anchorRoundNumber === anchor.roundNumber &&
      s.anchorTurnNumber === anchor.turnNumber,
  );
  if (match) {
    return { session: match, reused: true };
  }

  const preview = anchor.content.slice(0, ANCHOR_PREVIEW_CHARS) + (anchor.content.length > ANCHOR_PREVIEW_CHARS ? '…' : '');
  const session: SparringSession = {
    id: generateUUID(),
    discussionId: opts.discussion.id,
    memberId: opts.member.id,
    memberName: opts.member.name,
    anchorRoundNumber: anchor.roundNumber,
    anchorTurnNumber: anchor.turnNumber,
    anchorResponsePreview: preview,
    title: opts.title,
    messages: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await opts.storage.saveSparringSession(session);
  return { session, reused: false };
}

export interface SendSparringMessageOptions {
  session: SparringSession;
  member: AdvisoryBoardMember;
  discussion: Discussion;
  userMessage: string;
  settings: AppSettings;
  storage: StorageService;
  /** Where the .claude/agents/ directory lives. Default: process.cwd(). */
  projectRoot?: string;
  signal?: AbortSignal;
  onActivity?: (event: SparringActivityEvent) => void;
}

export interface SendSparringMessageResult {
  userMsg: SparringMessage;
  assistantMsg?: SparringMessage;
  error?: string;
  costUsd: number;
  durationMs: number;
  fellBackToPrimary: boolean;
}

/**
 * Append a user message to the session, run the deep-dive prompt, and persist
 * the assistant reply. Uses researchModel first; falls back to primaryModel
 * (no web grounding hint) on failure.
 */
export async function sendSparringMessage(opts: SendSparringMessageOptions): Promise<SendSparringMessageResult> {
  const trimmed = opts.userMessage.trim();
  if (!trimmed) {
    throw new Error('User message cannot be empty');
  }

  // 1) Save user message immediately.
  const userMsg: SparringMessage = {
    id: generateUUID(),
    sessionId: opts.session.id,
    role: 'user',
    content: trimmed,
    sources: [],
    createdAt: nowIso(),
  };
  await opts.storage.saveSparringMessage(opts.session.id, userMsg);
  opts.session.messages.push(userMsg);

  // Phase 8: ingest the user's sparring message as net-new user facts
  // (serialized, fire-and-forget — never blocks the deep-dive reply).
  maybeEnqueueUserInput({
    text: trimmed,
    kind: 'sparring_message',
    settings: opts.settings,
    storage: opts.storage,
    discussionId: opts.discussion.id,
    sparringSessionId: opts.session.id,
    eventId: userMsg.id,
  });

  // 2) Anchor lookup (use stored preview if the original response is gone).
  const anchorResponse =
    findResponseInDiscussion(opts.discussion, opts.session.memberId, opts.session.anchorRoundNumber, opts.session.anchorTurnNumber)
      ?.content ?? opts.session.anchorResponsePreview;

  // 3) Build prompt with the new user message appended.
  const prompt = buildSparringUserMessage({
    member: opts.member,
    discussion: opts.discussion,
    anchorResponse,
    history: opts.session.messages.slice(0, -1), // exclude the just-pushed user message; rebuilder folds it in
    pendingUserMessage: trimmed,
  });

  // 4) Try research model first; fall back to primary on failure.
  const slug = memberAgentSlug(opts.member.name);
  const tools = opts.member.allowedTools ?? DEFAULT_TOOLS;
  const research = pickModel(opts.settings.researchModel, 'opus');
  const primary = pickModel(opts.settings.primaryModel, 'sonnet');

  const start = Date.now();
  let fellBackToPrimary = false;
  let text = '';
  let costUsd = 0;
  let error: string | undefined;
  let sources: SparringSource[] = [];

  const activityForwarder = opts.onActivity ? makeActivityForwarder(opts.onActivity) : undefined;

  try {
    const result = await runClaude({
      prompt,
      agent: slug,
      model: research,
      allowedTools: tools,
      maxTurns: 5,
      maxBudgetUsd: opts.settings.perCallBudgetUsd,
      cwd: opts.projectRoot,
      signal: opts.signal,
      onEvent: activityForwarder,
    });
    text = extractText(result).trim();
    costUsd = result.json?.cost_usd ?? 0;
    sources = extractSourcesFromText(text);
    if (!text) {
      throw new Error('Research-model call returned an empty response');
    }
    logTokenUsage(opts.storage, {
      discussionId: opts.discussion.id,
      operationType: 'sparring_response',
      model: typeof research === 'string' ? research : 'inherit',
      usage: result.json?.usage,
      costUsd,
      metadata: {
        memberName: opts.member.name,
        sessionId: opts.session.id,
        fellBackToPrimary: false,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[sparring] Research model failed, falling back to primary: ${msg}`);
    fellBackToPrimary = true;
    try {
      const result = await runClaude({
        prompt,
        agent: slug,
        model: primary,
        allowedTools: tools,
        maxTurns: 5,
        maxBudgetUsd: opts.settings.perCallBudgetUsd,
        cwd: opts.projectRoot,
        signal: opts.signal,
        onEvent: activityForwarder,
      });
      text = extractText(result).trim();
      costUsd = result.json?.cost_usd ?? 0;
      sources = extractSourcesFromText(text);
      if (!text) {
        throw new Error('Primary-model fallback returned an empty response');
      }
      logTokenUsage(opts.storage, {
        discussionId: opts.discussion.id,
        operationType: 'sparring_response',
        model: typeof primary === 'string' ? primary : 'inherit',
        usage: result.json?.usage,
        costUsd,
        metadata: {
          memberName: opts.member.name,
          sessionId: opts.session.id,
          fellBackToPrimary: true,
        },
      });
    } catch (err2) {
      error = err2 instanceof Error ? err2.message : String(err2);
    }
  }

  const durationMs = Date.now() - start;

  if (error || !text) {
    return {
      userMsg,
      error: error ?? 'Model returned an empty response.',
      costUsd,
      durationMs,
      fellBackToPrimary,
    };
  }

  const assistantMsg: SparringMessage = {
    id: generateUUID(),
    sessionId: opts.session.id,
    role: 'assistant',
    content: text,
    sources,
    createdAt: nowIso(),
  };
  await opts.storage.saveSparringMessage(opts.session.id, assistantMsg);
  opts.session.messages.push(assistantMsg);

  return { userMsg, assistantMsg, costUsd, durationMs, fellBackToPrimary };
}

function pickAnchorResponse(
  discussion: Discussion,
  memberId: string,
  preferredRound?: number,
  preferredTurn?: number,
): Response | undefined {
  const matches = discussion.responses.filter((r) => r.memberId === memberId);
  if (matches.length === 0) return undefined;

  if (typeof preferredRound === 'number' && typeof preferredTurn === 'number') {
    const exact = matches.find((r) => r.roundNumber === preferredRound && r.turnNumber === preferredTurn);
    if (exact) return exact;
  }
  if (typeof preferredRound === 'number') {
    const roundMatch = matches
      .filter((r) => r.roundNumber === preferredRound)
      .sort((a, b) => b.turnNumber - a.turnNumber)[0];
    if (roundMatch) return roundMatch;
  }
  // Default: latest response from this member.
  return matches.sort((a, b) =>
    b.roundNumber - a.roundNumber !== 0 ? b.roundNumber - a.roundNumber : b.turnNumber - a.turnNumber,
  )[0];
}

function findResponseInDiscussion(
  discussion: Discussion,
  memberId: string,
  round: number,
  turn: number,
): Response | undefined {
  return discussion.responses.find(
    (r) => r.memberId === memberId && r.roundNumber === round && r.turnNumber === turn,
  );
}

function pickModel(setting: AppSettings['primaryModel'] | undefined, fallback: 'opus' | 'sonnet' | 'haiku'): string {
  if (typeof setting === 'string' && setting.length > 0) return setting;
  return fallback;
}

/**
 * Permissive URL scraper for citations the model may have inlined. We accept
 * markdown links `[Title](https://…)` first, then bare URLs as last resort.
 * Dedupes by URL. Capped at 5 sources to mirror sage-council.
 */
function extractSourcesFromText(text: string): SparringSource[] {
  const out: SparringSource[] = [];
  const seen = new Set<string>();

  const mdLink = /\[([^\]]{1,160})\]\((https?:\/\/[^\s)]+)\)/g;
  let match;
  while ((match = mdLink.exec(text)) !== null && out.length < 5) {
    const url = match[2]!;
    if (!seen.has(url)) {
      seen.add(url);
      out.push({ title: match[1]!.trim() || 'Source', url });
    }
  }

  if (out.length < 5) {
    const bareUrl = /(?:^|[^\]])(https?:\/\/[^\s)\]]+)/g;
    while ((match = bareUrl.exec(text)) !== null && out.length < 5) {
      const url = match[1]!.replace(/[.,;:!?]+$/, '');
      if (!seen.has(url)) {
        seen.add(url);
        out.push({ title: 'Source', url });
      }
    }
  }

  return out;
}

function makeActivityForwarder(
  onActivity: (a: SparringActivityEvent) => void,
): (event: ClaudeStreamEvent) => void {
  let lastActivity: string | null = null;
  const emit = (activity: string, tool?: string, detail?: string) => {
    if (activity === lastActivity) return;
    lastActivity = activity;
    onActivity({ activity, tool, detail });
  };
  return (event) => {
    if (event.type === 'system' && event.subtype === 'init') {
      emit('thinking…');
      return;
    }
    if (event.type !== 'assistant' || !event.message?.content) return;
    for (const block of event.message.content) {
      if (block.type === 'tool_use' && block.name) {
        const name = block.name.toLowerCase();
        if (name === 'websearch') {
          const q = typeof block.input?.query === 'string' ? block.input.query : undefined;
          emit('searching the web…', block.name, q);
          return;
        }
        if (name === 'webfetch') {
          const u = typeof block.input?.url === 'string' ? block.input.url : undefined;
          emit('reading a web page…', block.name, u);
          return;
        }
        if (name === 'read') {
          const p = typeof block.input?.file_path === 'string' ? block.input.file_path : undefined;
          emit('reading files…', block.name, p);
          return;
        }
        if (name === 'grep' || name === 'glob') {
          emit('searching the codebase…', block.name);
          return;
        }
        emit(`using ${block.name}…`, block.name);
        return;
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
        emit('writing response…');
        return;
      }
    }
  };
}

interface TokenUsageInput {
  discussionId?: string;
  operationType: string;
  model: string;
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      }
    | undefined;
  costUsd: number;
  metadata?: Record<string, unknown>;
}

/**
 * Test-only export — keeps internal helpers unit-testable without making them
 * part of the public engine surface.
 */
export const __test = {
  pickAnchorResponse,
  extractSourcesFromText,
};

function logTokenUsage(storage: StorageService, input: TokenUsageInput): void {
  const promptTokenCount =
    (input.usage?.input_tokens ?? 0) +
    (input.usage?.cache_creation_input_tokens ?? 0) +
    (input.usage?.cache_read_input_tokens ?? 0);
  const candidatesTokenCount = input.usage?.output_tokens ?? 0;
  const log: TokenUsageLog = {
    id: generateUUID(),
    discussionId: input.discussionId,
    feature: 'sparring',
    operationType: input.operationType,
    model: input.model,
    tokens: {
      promptTokenCount,
      candidatesTokenCount,
      cacheReadTokens: input.usage?.cache_read_input_tokens,
      cacheCreationTokens: input.usage?.cache_creation_input_tokens,
      totalTokenCount: promptTokenCount + candidatesTokenCount,
    },
    costUsd: input.costUsd,
    createdAt: nowIso(),
    metadata: input.metadata,
  };
  storage.appendTokenUsageLog(log).catch((err) => {
    logger.debug('[sparring] token-usage log failed (non-blocking):', err);
  });
}
