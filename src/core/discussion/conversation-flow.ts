/**
 * Top-level discussion engine. Wraps round execution, orchestrator analysis,
 * and persistence.
 *
 * Phase 1 surface:
 *   - startDiscussion         — round 1
 *   - continueDiscussion      — orchestrator-gated next round (with pre-round
 *                               clarification gate per PLAN.md §4.3.1)
 *   - respondToUserRequest    — answer a pending HITL `request_user_input`,
 *                               then drive a follow-up round
 *   - addFollowUpQuestion     — targeted follow-up round (all / specific /
 *                               subset of members) carrying the user's new
 *                               question. Strict: any member failure aborts
 *                               the round per PLAN.md §1.5.
 *
 * Sparring and summarize/export come next.
 */
import { logger } from '../logger.js';
import { UserError } from '../errors.js';
import { generateUUID, nowIso } from '../utils.js';
import { existsSync } from 'node:fs';
import { runMember } from './run-member.js';
import {
  analyzeConversation,
  createInitialOrchestratorState,
  updateOrchestratorState,
} from './orchestrator.js';
import { summarizeDiscussion } from './summarize.js';
import { resolveWorkspace, paths } from '../../storage/paths.js';
import { ingestDiscussionRaw, ingestPaste } from '../knowledge/ingest.js';
import { memberAgentSlug, memberAgentPath, emitMemberAgentFile } from '../../agents/emit-member-agent.js';
import { ensureParticipants } from './participants.js';
import { buildCatchUpContext, renderSummaryText, type CatchUpMode } from './catch-up.js';
import type {
  AdvisoryBoardMember,
  AppSettings,
  BusinessContext,
  ConversationRound,
  Discussion,
  Response,
  StorageService,
  UserResponse,
} from '../../storage/types.js';

export type StartProgressEvent =
  | { stage: 'initializing' }
  | { stage: 'context' }
  | { stage: 'generating'; memberName: string; index: number; total: number }
  | {
      stage: 'member_activity';
      memberName: string;
      activity: string;
      tool?: string;
      detail?: string;
    }
  | {
      stage: 'member_done';
      memberName: string;
      durationMs: number;
      costUsd: number;
      response: Response;
      roundNumber: number;
    }
  | { stage: 'orchestrating' }
  | {
      stage: 'orchestrator_decided';
      decision: import('../../storage/types.js').OrchestratorDecision;
      roundNumber: number;
    }
  | { stage: 'finalizing'; round: number };

export interface StartDiscussionOptions {
  question: string;
  members: AdvisoryBoardMember[];
  settings: AppSettings;
  storage: StorageService;
  /** Where the .claude/agents/ directory lives. Default: process.cwd(). */
  projectRoot?: string;
  signal?: AbortSignal;
  onProgress?: (event: StartProgressEvent) => void;
  /** Board this discussion was convened from (Phase 7 snapshot). */
  boardId?: string;
  boardName?: string;
}

export interface StartDiscussionResult {
  discussion: Discussion;
  totalCostUsd: number;
  totalDurationMs: number;
}

export async function startDiscussion(opts: StartDiscussionOptions): Promise<StartDiscussionResult> {
  const t0 = Date.now();
  opts.onProgress?.({ stage: 'initializing' });

  const activeMembers = opts.members.filter((m) => m.isActive);
  if (activeMembers.length === 0) {
    throw new Error('No active board members. Add or activate at least one with `aab members add`.');
  }

  // Skeleton discussion record
  const discussionId = generateUUID();
  const now = nowIso();
  const discussion: Discussion = {
    id: discussionId,
    question: opts.question,
    selectedMemberIds: activeMembers.map((m) => m.id),
    boardId: opts.boardId,
    boardName: opts.boardName,
    // Founding-participant snapshot (Phase 7) so history renders correctly even
    // if a member is later renamed or deleted.
    participants: activeMembers.map((m) => ({
      memberId: m.id,
      name: m.name,
      slug: memberAgentSlug(m.name),
      title: m.title,
      joinedAtRound: 1,
    })),
    responses: [],
    rounds: [],
    orchestratorState: createInitialOrchestratorState(),
    totalTurns: 0,
    maxTurns: opts.settings.maxTurnsPerDiscussion,
    userResponses: [],
    createdAt: now,
  };

  // Capture the user's original question as a UserResponse (matches source behavior)
  const initialUserResponse: UserResponse = {
    id: generateUUID(),
    requestId: 'initial-question',
    content: opts.question,
    timestamp: now,
    roundNumber: 1,
    type: 'initial_question',
    prompt: opts.question,
  };
  discussion.userResponses.push(initialUserResponse);

  // Load business context for prompt injection (Phase 1: load existing only,
  // we don't yet auto-extract new context from the question — that's Phase 2)
  opts.onProgress?.({ stage: 'context' });
  const businessContext = await loadBusinessContextSafe(opts.storage);

  // Round 1
  const round1: ConversationRound = {
    roundNumber: 1,
    responses: [],
    orchestratorDecision: {
      action: 'continue',
      reasoning: 'Initial round.',
      consensusReached: false,
      confidence: 100,
    },
    startedAt: nowIso(),
  };

  let totalCostUsd = 0;
  for (let i = 0; i < activeMembers.length; i++) {
    const member = activeMembers[i]!;
    opts.onProgress?.({ stage: 'generating', memberName: member.name, index: i + 1, total: activeMembers.length });

    const result = await runMember({
      question: opts.question,
      member,
      roundNumber: 1,
      previousResponsesInRound: round1.responses,
      conversationHistory: [],
      businessContext,
      settings: opts.settings,
      storage: opts.storage,
      discussionId,
      projectRoot: opts.projectRoot,
      workspaceRoot: opts.storage.getWorkspaceRoot(),
      signal: opts.signal,
      onActivity: (a) =>
        opts.onProgress?.({ stage: 'member_activity', memberName: member.name, ...a }),
    });

    round1.responses.push(result.response);
    discussion.responses.push(result.response);
    discussion.totalTurns++;
    totalCostUsd += result.costUsd;

    opts.onProgress?.({
      stage: 'member_done',
      memberName: member.name,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      response: result.response,
      roundNumber: 1,
    });
  }

  if (round1.responses.length === 0) {
    throw new Error('All board members failed to respond. Check `aab doctor` and try again.');
  }

  round1.completedAt = nowIso();

  // Orchestrator analysis (decides whether the next round should run, ask user, etc.)
  opts.onProgress?.({ stage: 'orchestrating' });
  try {
    const decision = await analyzeConversation({
      question: opts.question,
      rounds: [round1],
      members: activeMembers,
      currentTurn: discussion.totalTurns,
      settings: opts.settings,
      storage: opts.storage,
      discussionId,
      signal: opts.signal,
    });
    round1.orchestratorDecision = decision;
    discussion.orchestratorState = updateOrchestratorState(
      discussion.orchestratorState,
      decision,
      round1,
    );
    if (decision.action === 'request_user_input' && decision.userInputRequest) {
      discussion.pendingUserRequest = decision.userInputRequest;
    }
    opts.onProgress?.({ stage: 'orchestrator_decided', decision, roundNumber: 1 });
  } catch (error) {
    logger.warn('[startDiscussion] orchestrator failed (non-blocking):', error);
  }

  discussion.rounds.push(round1);

  // If we hit the conclusion right after round 1, mark the discussion complete
  if (round1.orchestratorDecision.action === 'conclude' || discussion.totalTurns >= discussion.maxTurns) {
    discussion.completedAt = nowIso();
    discussion.pendingUserRequest = undefined;
  }

  opts.onProgress?.({ stage: 'finalizing', round: 1 });
  await opts.storage.saveDiscussion(discussion);

  // Phase 1.5: auto-ingest into the Knowledge Wiki on conclude.
  await maybeAutoIngestOnConclude(discussion, activeMembers, opts.settings, opts.storage);

  return {
    discussion,
    totalCostUsd,
    totalDurationMs: Date.now() - t0,
  };
}

async function loadBusinessContextSafe(storage: StorageService): Promise<BusinessContext[]> {
  // Always inject any structured business context we have, even when a wiki is
  // present. The wiki (members read it natively via Read/Grep/Glob, pointed at
  // the absolute path in the user message) is the rich source, but a compact
  // inline context guarantees members have baseline grounding even if their
  // wiki pass comes up thin — earlier we returned [] here and, combined with a
  // broken wiki path, members ended up with no context at all.
  try {
    return await storage.loadBusinessContext();
  } catch (error) {
    logger.debug('[conversation-flow] business context load failed (non-blocking):', error);
    return [];
  }
}

/**
 * Auto-ingest a concluded discussion into the Knowledge Wiki. Wrapped in
 * try/catch — a failed ingest never blocks discussion completion. Logs to
 * `wiki/log.md` with `[ingest-failed]` prefix on errors.
 * Reference: `docs/development/KNOWLEDGE_WIKI.md` §16.
 */
async function maybeAutoIngestOnConclude(
  discussion: Discussion,
  members: AdvisoryBoardMember[],
  settings: AppSettings,
  storage: StorageService,
): Promise<void> {
  if (!discussion.completedAt) return;
  if (settings.knowledgeWiki?.enabled === false) return;
  if (settings.knowledgeWiki?.autoIngestDiscussions === false) return;
  try {
    const root = storage.getWorkspaceRoot();
    const p = paths(root);
    if (!existsSync(p.wiki) || !existsSync(p.wikiKnowledge)) return; // no wiki = no auto-ingest

    // 1. Generate a summary first if autoSummarization is on and missing.
    if (settings.autoSummarization && !discussion.summary && discussion.rounds.length > 0) {
      try {
        discussion.summary = await summarizeDiscussion({ discussion, members, settings });
        await storage.saveDiscussion(discussion);
      } catch (error) {
        logger.warn('[auto-ingest] summarize failed (non-blocking):', error);
      }
    }

    // 2. Resolve workspace for the ingest pipeline.
    const workspace = resolveWorkspace({ override: storage.getWorkspaceId() });
    // Override root in case the env doesn't match (storage knows the truth).
    workspace.root = root;

    await ingestDiscussionRaw({ discussion, workspace, settings, storage });
  } catch (error) {
    logger.warn('[auto-ingest] discussion ingest failed (non-blocking):', error);
  }
}

/**
 * Auto-ingest a user's HITL response as a paste-style raw input. Same
 * non-blocking semantics as discussion ingest.
 * Reference: `docs/development/KNOWLEDGE_WIKI.md` §16 ("User HITL responses also get
 * auto-ingested").
 */
async function maybeAutoIngestUserResponse(
  content: string,
  settings: AppSettings,
  storage: StorageService,
): Promise<void> {
  if (settings.knowledgeWiki?.enabled === false) return;
  if (settings.knowledgeWiki?.autoIngestUserResponses === false) return;
  const trimmed = content.trim();
  if (trimmed.length < 40) return; // tiny replies aren't worth a wiki entry
  try {
    const root = storage.getWorkspaceRoot();
    const p = paths(root);
    if (!existsSync(p.wiki) || !existsSync(p.wikiKnowledge)) return;
    const workspace = resolveWorkspace({ override: storage.getWorkspaceId() });
    workspace.root = root;
    await ingestPaste({ text: trimmed, workspace, settings });
  } catch (error) {
    logger.warn('[auto-ingest] user-response ingest failed (non-blocking):', error);
  }
}

// ============================================================
// continueDiscussion — orchestrator-gated next round
// ============================================================

export interface ContinueDiscussionOptions {
  discussion: Discussion;
  members: AdvisoryBoardMember[];
  settings: AppSettings;
  storage: StorageService;
  /** Where the .claude/agents/ directory lives. Default: process.cwd(). */
  projectRoot?: string;
  signal?: AbortSignal;
  onProgress?: (event: StartProgressEvent) => void;
  /**
   * When provided, treat the user's reply as a follow-up question driving
   * the next round. Used internally by `respondToUserRequest`.
   */
  userFollowUp?: { content: string; selectedOption?: string };
  /**
   * If true, skip the pre-round clarification gate. Used internally by
   * `respondToUserRequest` since the orchestrator's question is the very
   * thing the user just answered — re-asking would loop forever.
   */
  skipPreRoundGate?: boolean;
}

export interface ContinueDiscussionResult {
  discussion: Discussion;
  totalCostUsd: number;
  totalDurationMs: number;
  /** True when the pre-round gate ended early because the orchestrator wants user input. */
  gated: boolean;
  /** True when the discussion concluded as part of this call. */
  concluded: boolean;
  /** Round number that was generated in this call, or null if gated/no-op. */
  roundNumber: number | null;
}

export async function continueDiscussion(
  opts: ContinueDiscussionOptions,
): Promise<ContinueDiscussionResult> {
  const t0 = Date.now();
  const { discussion } = opts;

  if (discussion.completedAt) {
    throw new UserError(
      'This discussion is already concluded.',
      'Start a new one with `aab discuss start "<question>"` or open a sparring session with `aab discuss spar`.',
    );
  }
  if (discussion.pendingUserRequest && !opts.userFollowUp) {
    throw new UserError(
      'This discussion is awaiting your input.',
      'Reply with `aab discuss respond <id> "<answer>" [--option <i>]` first.',
    );
  }

  const activeMembers = opts.members.filter((m) => m.isActive);
  if (activeMembers.length === 0) {
    throw new UserError('No active board members. Add or activate at least one with `aab members add`.');
  }

  // Back-fill the participant snapshot for legacy discussions (non-destructive;
  // persisted on the next save). New discussions already carry one.
  ensureParticipants(discussion, opts.members);

  // Bail if we're already at maxTurns — mark concluded.
  if (discussion.totalTurns >= discussion.maxTurns) {
    if (!discussion.completedAt) {
      discussion.completedAt = nowIso();
      await opts.storage.saveDiscussion(discussion);
    }
    return {
      discussion,
      totalCostUsd: 0,
      totalDurationMs: Date.now() - t0,
      gated: false,
      concluded: true,
      roundNumber: null,
    };
  }

  // Pre-round clarification gate — runs *before* any model spawns.
  if (!opts.skipPreRoundGate) {
    opts.onProgress?.({ stage: 'orchestrating' });
    try {
      const gate = await analyzeConversation({
        question: discussion.question,
        rounds: discussion.rounds,
        members: activeMembers,
        currentTurn: discussion.totalTurns,
        settings: opts.settings,
        storage: opts.storage,
        discussionId: discussion.id,
        signal: opts.signal,
      });
      if (gate.action === 'request_user_input' && gate.userInputRequest) {
        discussion.pendingUserRequest = gate.userInputRequest;
        await opts.storage.saveDiscussion(discussion);
        return {
          discussion,
          totalCostUsd: 0,
          totalDurationMs: Date.now() - t0,
          gated: true,
          concluded: false,
          roundNumber: null,
        };
      }
      if (gate.action === 'conclude') {
        // Orchestrator decided no further round is warranted — close out.
        discussion.completedAt = nowIso();
        // Stamp the gate decision onto the most recent round if present
        const last = discussion.rounds[discussion.rounds.length - 1];
        if (last) last.orchestratorDecision = gate;
        await opts.storage.saveDiscussion(discussion);
        return {
          discussion,
          totalCostUsd: 0,
          totalDurationMs: Date.now() - t0,
          gated: false,
          concluded: true,
          roundNumber: null,
        };
      }
    } catch (error) {
      logger.warn('[continueDiscussion] pre-round gate failed (non-blocking):', error);
    }
  }

  // Build the next round
  const lastRound = discussion.rounds[discussion.rounds.length - 1];
  const nextRoundNumber = (lastRound?.roundNumber ?? 0) + 1;

  const round: ConversationRound = {
    roundNumber: nextRoundNumber,
    responses: [],
    orchestratorDecision: {
      action: 'continue',
      reasoning: `Round ${nextRoundNumber} starting.`,
      consensusReached: false,
      confidence: 100,
    },
    startedAt: nowIso(),
  };
  if (opts.userFollowUp) {
    const lastResponse = discussion.userResponses[discussion.userResponses.length - 1];
    round.userResponse = lastResponse;
  }

  const conversationHistory = discussion.responses;
  const businessContext = await loadBusinessContextSafe(opts.storage);

  let totalCostUsd = 0;
  for (let i = 0; i < activeMembers.length; i++) {
    const member = activeMembers[i]!;
    opts.onProgress?.({
      stage: 'generating',
      memberName: member.name,
      index: i + 1,
      total: activeMembers.length,
    });

    try {
      const result = await runMember({
        question: discussion.question,
        member,
        roundNumber: nextRoundNumber,
        previousResponsesInRound: round.responses,
        conversationHistory,
        businessContext,
        settings: opts.settings,
        storage: opts.storage,
        discussionId: discussion.id,
        projectRoot: opts.projectRoot,
        workspaceRoot: opts.storage.getWorkspaceRoot(),
        signal: opts.signal,
        isFollowUp: true,
        followUpQuestion: opts.userFollowUp?.content,
        onActivity: (a) =>
          opts.onProgress?.({ stage: 'member_activity', memberName: member.name, ...a }),
      });

      round.responses.push(result.response);
      discussion.responses.push(result.response);
      discussion.totalTurns++;
      totalCostUsd += result.costUsd;

      opts.onProgress?.({
        stage: 'member_done',
        memberName: member.name,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
        response: result.response,
        roundNumber: nextRoundNumber,
      });
    } catch (error) {
      logger.warn(`[continueDiscussion] ${member.name} failed (continuing with other members):`, error);
    }
  }

  if (round.responses.length === 0) {
    throw new UserError(
      'All board members failed to respond in this round.',
      'Run `aab doctor` to verify the claude CLI is reachable, then try `aab discuss continue <id>` again.',
    );
  }

  round.completedAt = nowIso();

  // Post-round orchestrator analysis
  opts.onProgress?.({ stage: 'orchestrating' });
  try {
    const decision = await analyzeConversation({
      question: discussion.question,
      rounds: [...discussion.rounds, round],
      members: activeMembers,
      currentTurn: discussion.totalTurns,
      settings: opts.settings,
      storage: opts.storage,
      discussionId: discussion.id,
      signal: opts.signal,
    });
    round.orchestratorDecision = decision;
    discussion.orchestratorState = updateOrchestratorState(discussion.orchestratorState, decision, round);
    if (decision.action === 'request_user_input' && decision.userInputRequest) {
      discussion.pendingUserRequest = decision.userInputRequest;
    }
    opts.onProgress?.({ stage: 'orchestrator_decided', decision, roundNumber: nextRoundNumber });
  } catch (error) {
    logger.warn('[continueDiscussion] orchestrator failed (non-blocking):', error);
  }

  discussion.rounds.push(round);

  let concluded = false;
  if (
    round.orchestratorDecision.action === 'conclude' ||
    discussion.totalTurns >= discussion.maxTurns
  ) {
    discussion.completedAt = nowIso();
    concluded = true;
    // If the orchestrator wanted input but we're out of turns, the question
    // is moot — clear it so the UI doesn't show "done" alongside an
    // unanswerable HITL prompt.
    discussion.pendingUserRequest = undefined;
  }

  opts.onProgress?.({ stage: 'finalizing', round: nextRoundNumber });
  await opts.storage.saveDiscussion(discussion);

  // Phase 1.5: auto-ingest into the Knowledge Wiki on conclude.
  if (concluded) {
    await maybeAutoIngestOnConclude(discussion, activeMembers, opts.settings, opts.storage);
  }

  return {
    discussion,
    totalCostUsd,
    totalDurationMs: Date.now() - t0,
    gated: false,
    concluded,
    roundNumber: nextRoundNumber,
  };
}

// ============================================================
// respondToUserRequest — answer a pending HITL request
// ============================================================

export interface RespondToUserRequestOptions {
  discussion: Discussion;
  content: string;
  selectedOption?: string;
  members: AdvisoryBoardMember[];
  settings: AppSettings;
  storage: StorageService;
  projectRoot?: string;
  signal?: AbortSignal;
  onProgress?: (event: StartProgressEvent) => void;
}

export async function respondToUserRequest(
  opts: RespondToUserRequestOptions,
): Promise<ContinueDiscussionResult> {
  const { discussion } = opts;
  const trimmed = opts.content.trim();
  if (!trimmed) {
    throw new UserError('Reply content is empty.');
  }
  if (!discussion.pendingUserRequest) {
    throw new UserError(
      'This discussion is not awaiting your input.',
      'Use `aab discuss continue <id>` to drive the next round.',
    );
  }

  const requestId = discussion.pendingUserRequest.id;
  const lastRoundNumber = discussion.rounds[discussion.rounds.length - 1]?.roundNumber ?? 1;
  const userResponse: UserResponse = {
    id: generateUUID(),
    requestId,
    content: trimmed,
    selectedOption: opts.selectedOption,
    timestamp: nowIso(),
    roundNumber: lastRoundNumber,
    type: 'advisory_board_requested',
    prompt: discussion.pendingUserRequest.question,
  };
  discussion.userResponses.push(userResponse);
  discussion.pendingUserRequest = undefined;

  // Persist the cleared HITL state immediately so a crash mid-round
  // doesn't leave the discussion stuck "awaiting input" forever.
  await opts.storage.saveDiscussion(discussion);

  // Phase 1.5: auto-ingest the user's HITL reply as a paste-style raw input
  // (fire-and-forget so a wiki hiccup never blocks the discussion).
  void maybeAutoIngestUserResponse(trimmed, opts.settings, opts.storage);

  // Drive the next round, threading the user's reply as a follow-up question.
  // Skip the pre-round gate — the orchestrator just asked for this exact
  // input, so re-running it would either say "continue" (waste of a call)
  // or loop forever asking again.
  return continueDiscussion({
    discussion,
    members: opts.members,
    settings: opts.settings,
    storage: opts.storage,
    projectRoot: opts.projectRoot,
    signal: opts.signal,
    onProgress: opts.onProgress,
    userFollowUp: { content: trimmed, selectedOption: opts.selectedOption },
    skipPreRoundGate: true,
  });
}

// ============================================================
// addFollowUpQuestion — targeted follow-up round
// ============================================================

export type FollowUpTargetType = 'all' | 'specific' | 'subset';

export interface AddFollowUpQuestionOptions {
  discussion: Discussion;
  /** The user's new question to put to the targeted member(s). */
  question: string;
  /** Active members of the workspace — used both as the candidate pool and to populate the orchestrator's view. */
  members: AdvisoryBoardMember[];
  settings: AppSettings;
  storage: StorageService;
  projectRoot?: string;
  signal?: AbortSignal;
  onProgress?: (event: StartProgressEvent) => void;
  /** Default: 'all' (every active member from the discussion responds). */
  targetType?: FollowUpTargetType;
  /** Required when targetType='specific'. */
  selectedMemberId?: string;
  /** Required when targetType='subset'. */
  selectedMemberIds?: string[];
  /**
   * Members to add to the discussion before this round runs (active member ids
   * not yet in the discussion). They join the roster; whether they *respond*
   * this round depends on `targetType` (Slack "add to channel" vs "@mention").
   */
  addMemberIds?: string[];
  /** How freshly-added members are brought up to speed (spec §2.3). Default 'full'. */
  catchUpMode?: CatchUpMode;
}

export async function addFollowUpQuestion(
  opts: AddFollowUpQuestionOptions,
): Promise<ContinueDiscussionResult> {
  const t0 = Date.now();
  const { discussion } = opts;
  const trimmed = opts.question.trim();
  if (!trimmed) {
    throw new UserError('Follow-up question is empty.');
  }
  if (discussion.completedAt) {
    throw new UserError(
      'This discussion is already concluded.',
      'Start a new one with `aab discuss start "<question>"` or open a sparring session with `aab discuss spar`.',
    );
  }
  if (discussion.pendingUserRequest) {
    throw new UserError(
      'This discussion is awaiting your input.',
      'Reply with `aab discuss respond <id> "<answer>"` first.',
    );
  }
  if (discussion.totalTurns >= discussion.maxTurns) {
    if (!discussion.completedAt) {
      discussion.completedAt = nowIso();
      await opts.storage.saveDiscussion(discussion);
    }
    return {
      discussion,
      totalCostUsd: 0,
      totalDurationMs: Date.now() - t0,
      gated: false,
      concluded: true,
      roundNumber: null,
    };
  }

  const targetType: FollowUpTargetType = opts.targetType ?? 'all';
  const activeMembers = opts.members.filter((m) => m.isActive);
  if (activeMembers.length === 0) {
    throw new UserError('No active board members.');
  }

  // Back-fill the participant snapshot for legacy discussions (non-destructive).
  ensureParticipants(discussion, opts.members);

  const catchUpMode: CatchUpMode = opts.catchUpMode ?? 'full';

  // The roster as it stands before this round (existing participants).
  const rosterIds = new Set(discussion.selectedMemberIds ?? activeMembers.map((m) => m.id));

  // ---- Validate + resolve newly-added members (mid-discussion join) ----
  // `opts.members` is the full active-member pool (the CLI/server pass all
  // active members so newcomers are resolvable). New members must be active,
  // exist, and not already be in the discussion.
  const newcomers: AdvisoryBoardMember[] = [];
  for (const id of opts.addMemberIds ?? []) {
    const member = activeMembers.find((m) => m.id === id);
    if (!member) {
      throw new UserError(
        `Cannot add member ${id}: not found among active members.`,
        'Only active, existing members can be added. Create them first with `aab members add`.',
      );
    }
    if (rosterIds.has(id)) {
      throw new UserError(`${member.name} is already part of this discussion.`);
    }
    if (newcomers.some((m) => m.id === id)) continue; // dedupe
    newcomers.push(member);
  }

  // Ensure each newcomer has a .claude/agents/<slug>.md (emit if missing —
  // defensive; UI/CLI-created members always have one).
  const projectRootForAgents = opts.projectRoot ?? process.cwd();
  for (const member of newcomers) {
    const agentPath = memberAgentPath(memberAgentSlug(member.name), projectRootForAgents);
    if (!existsSync(agentPath)) {
      emitMemberAgentFile(member, { projectRoot: projectRootForAgents });
    }
  }

  const newcomerIds = new Set(newcomers.map((m) => m.id));

  // Candidate pool = existing roster members + newcomers (the relaxed pool).
  const candidatePool = activeMembers.filter((m) => rosterIds.has(m.id) || newcomerIds.has(m.id));
  if (candidatePool.length === 0) {
    throw new UserError('None of the discussion\'s members are still active.');
  }

  let targetMembers: AdvisoryBoardMember[];
  if (targetType === 'all') {
    targetMembers = candidatePool;
  } else if (targetType === 'specific') {
    if (!opts.selectedMemberId) {
      throw new UserError('targetType=specific requires selectedMemberId.');
    }
    const m = candidatePool.find((c) => c.id === opts.selectedMemberId);
    if (!m) {
      throw new UserError(`Member ${opts.selectedMemberId} is not part of this discussion.`);
    }
    targetMembers = [m];
  } else {
    // subset
    const ids = opts.selectedMemberIds ?? [];
    if (ids.length === 0) {
      throw new UserError('targetType=subset requires selectedMemberIds.');
    }
    const set = new Set(ids);
    targetMembers = candidatePool.filter((c) => set.has(c.id));
    if (targetMembers.length === 0) {
      throw new UserError('No members from selectedMemberIds are part of this discussion.');
    }
  }

  // Newcomers who actually respond this round (targeted). Non-targeted
  // newcomers join the roster for future rounds but don't respond / get caught
  // up yet (Slack "add to channel" vs "@mention" — spec §2.5).
  const respondingNewcomerIds = new Set(targetMembers.filter((m) => newcomerIds.has(m.id)).map((m) => m.id));

  // Pre-round clarification gate (PLAN.md §4.3.1: must fire here too).
  opts.onProgress?.({ stage: 'orchestrating' });
  try {
    const gate = await analyzeConversation({
      question: discussion.question,
      rounds: discussion.rounds,
      members: activeMembers,
      currentTurn: discussion.totalTurns,
      settings: opts.settings,
      storage: opts.storage,
      discussionId: discussion.id,
      signal: opts.signal,
    });
    if (gate.action === 'request_user_input' && gate.userInputRequest) {
      discussion.pendingUserRequest = gate.userInputRequest;
      await opts.storage.saveDiscussion(discussion);
      return {
        discussion,
        totalCostUsd: 0,
        totalDurationMs: Date.now() - t0,
        gated: true,
        concluded: false,
        roundNumber: null,
      };
    }
  } catch (error) {
    logger.warn('[addFollowUpQuestion] pre-round gate failed (non-blocking):', error);
  }

  const lastRound = discussion.rounds[discussion.rounds.length - 1];
  const nextRoundNumber = (lastRound?.roundNumber ?? 0) + 1;

  // Build the round in-memory; only commit on full success so a partial
  // failure doesn't leave a half-baked round saved.
  const round: ConversationRound = {
    roundNumber: nextRoundNumber,
    responses: [],
    orchestratorDecision: {
      action: 'continue',
      reasoning: `Follow-up round ${nextRoundNumber}.`,
      consensusReached: false,
      confidence: 100,
    },
    startedAt: nowIso(),
    followUpQuestion: trimmed,
    followUpTargetType: targetType,
  };
  if (targetType === 'specific') round.followUpSelectedMemberId = targetMembers[0]!.id;
  if (targetType === 'subset') round.followUpSelectedMemberIds = targetMembers.map((m) => m.id);

  const conversationHistory = discussion.responses;
  const businessContext = await loadBusinessContextSafe(opts.storage);

  // If any responding newcomer is caught up via `summary`, render the prior
  // rounds into a summary text block once (reuse discussion.summary if present,
  // else generate one — logged as a `catchup_summary` token call, spec §3.4).
  let catchUpSummaryText: string | undefined;
  const needsSummaryCatchUp =
    catchUpMode === 'summary' && targetMembers.some((m) => respondingNewcomerIds.has(m.id));
  if (needsSummaryCatchUp) {
    if (discussion.summary) {
      catchUpSummaryText = renderSummaryText(discussion.summary);
    } else if (discussion.rounds.length > 0) {
      try {
        const summary = await summarizeDiscussion({
          discussion,
          members: candidatePool,
          settings: opts.settings,
          storage: opts.storage,
          discussionId: discussion.id,
          operationType: 'catchup_summary',
          signal: opts.signal,
        });
        discussion.summary = summary;
        catchUpSummaryText = renderSummaryText(summary);
      } catch (error) {
        logger.warn('[addFollowUpQuestion] catch-up summary failed; falling back to full transcript:', error);
      }
    }
  }

  let totalCostUsd = 0;
  for (let i = 0; i < targetMembers.length; i++) {
    const member = targetMembers[i]!;
    opts.onProgress?.({
      stage: 'generating',
      memberName: member.name,
      index: i + 1,
      total: targetMembers.length,
    });

    // Shape the context per catch-up mode (newcomers only; founding/returning
    // members always get the full transcript).
    const catchUp = buildCatchUpContext(
      respondingNewcomerIds.has(member.id),
      catchUpMode,
      conversationHistory,
      catchUpSummaryText,
    );

    // Strict: any failure aborts the whole follow-up round (per PLAN §1.5).
    const result = await runMember({
      question: discussion.question,
      member,
      roundNumber: nextRoundNumber,
      previousResponsesInRound: round.responses,
      conversationHistory: catchUp.conversationHistory,
      priorRoundsSummary: catchUp.priorRoundsSummary,
      joinCatchUpMode: catchUp.joinCatchUpMode,
      businessContext,
      settings: opts.settings,
      storage: opts.storage,
      discussionId: discussion.id,
      projectRoot: opts.projectRoot,
      workspaceRoot: opts.storage.getWorkspaceRoot(),
      signal: opts.signal,
      isFollowUp: true,
      followUpQuestion: trimmed,
      onActivity: (a) =>
        opts.onProgress?.({ stage: 'member_activity', memberName: member.name, ...a }),
    });

    round.responses.push(result.response);
    totalCostUsd += result.costUsd;

    opts.onProgress?.({
      stage: 'member_done',
      memberName: member.name,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      response: result.response,
      roundNumber: nextRoundNumber,
    });
  }

  round.completedAt = nowIso();

  // Post-round orchestrator analysis
  opts.onProgress?.({ stage: 'orchestrating' });
  try {
    const decision = await analyzeConversation({
      question: discussion.question,
      rounds: [...discussion.rounds, round],
      members: activeMembers,
      currentTurn: discussion.totalTurns + round.responses.length,
      settings: opts.settings,
      storage: opts.storage,
      discussionId: discussion.id,
      signal: opts.signal,
    });
    round.orchestratorDecision = decision;
    opts.onProgress?.({ stage: 'orchestrator_decided', decision, roundNumber: nextRoundNumber });
  } catch (error) {
    logger.warn('[addFollowUpQuestion] orchestrator failed (non-blocking):', error);
  }

  // Commit to the discussion record.
  const userResponse: UserResponse = {
    id: generateUUID(),
    requestId: `follow-up-${nextRoundNumber}`,
    content: trimmed,
    timestamp: nowIso(),
    roundNumber: nextRoundNumber,
    type: 'follow_up_question',
    prompt: trimmed,
    targetType,
    selectedMemberId: targetType === 'specific' ? targetMembers[0]!.id : undefined,
    selectedMemberIds: targetType === 'subset' ? targetMembers.map((m) => m.id) : undefined,
  };
  round.userResponse = userResponse;
  discussion.userResponses.push(userResponse);
  for (const r of round.responses) discussion.responses.push(r);
  discussion.totalTurns += round.responses.length;

  // Commit the mid-discussion joins now that the round succeeded (strict-abort
  // means a member failure threw before reaching here, rolling back the add).
  if (newcomers.length > 0) {
    discussion.participants ??= [];
    discussion.selectedMemberIds = [...new Set([...(discussion.selectedMemberIds ?? []), ...newcomers.map((m) => m.id)])];
    for (const member of newcomers) {
      discussion.participants.push({
        memberId: member.id,
        name: member.name,
        slug: memberAgentSlug(member.name),
        title: member.title,
        joinedAtRound: nextRoundNumber,
        // Catch-up mode is recorded only for newcomers who actually responded
        // (and were caught up) this round; non-responding joins catch up the
        // first round they speak.
        ...(respondingNewcomerIds.has(member.id) ? { catchUpMode } : {}),
      });
    }
    round.addedMemberIds = newcomers.map((m) => m.id);
  }

  discussion.rounds.push(round);
  discussion.orchestratorState = updateOrchestratorState(
    discussion.orchestratorState,
    round.orchestratorDecision,
    round,
  );

  if (
    round.orchestratorDecision.action === 'request_user_input' &&
    round.orchestratorDecision.userInputRequest
  ) {
    discussion.pendingUserRequest = round.orchestratorDecision.userInputRequest;
  }

  let concluded = false;
  if (
    round.orchestratorDecision.action === 'conclude' ||
    discussion.totalTurns >= discussion.maxTurns
  ) {
    discussion.completedAt = nowIso();
    discussion.pendingUserRequest = undefined;
    concluded = true;
  }

  opts.onProgress?.({ stage: 'finalizing', round: nextRoundNumber });
  await opts.storage.saveDiscussion(discussion);

  // Phase 1.5: auto-ingest into the Knowledge Wiki on conclude.
  if (concluded) {
    await maybeAutoIngestOnConclude(discussion, activeMembers, opts.settings, opts.storage);
  }

  return {
    discussion,
    totalCostUsd,
    totalDurationMs: Date.now() - t0,
    gated: false,
    concluded,
    roundNumber: nextRoundNumber,
  };
}
