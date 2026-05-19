import { describe, expect, it, vi } from 'vitest';
import { injectSparringInsight } from '../inject-insight.js';
import type {
  ConversationRound,
  Discussion,
  SparringSession,
  StorageService,
  UserResponse,
} from '../../../storage/types.js';

function mkSession(overrides: Partial<SparringSession> = {}): SparringSession {
  return {
    id: overrides.id ?? 's-1',
    discussionId: overrides.discussionId ?? 'd-1',
    memberId: overrides.memberId ?? 'm-1',
    memberName: overrides.memberName ?? 'Elon Musk',
    anchorRoundNumber: overrides.anchorRoundNumber ?? 2,
    anchorTurnNumber: overrides.anchorTurnNumber ?? 1,
    anchorResponsePreview: overrides.anchorResponsePreview ?? 'Pivot now or…',
    title: overrides.title,
    messages: overrides.messages ?? [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function mkRound(roundNumber: number, opts: Partial<ConversationRound> = {}): ConversationRound {
  return {
    roundNumber,
    responses: opts.responses ?? [],
    orchestratorDecision: opts.orchestratorDecision ?? {
      action: 'continue',
      reasoning: '',
      consensusReached: false,
      confidence: 0,
    },
    startedAt: '',
    userResponse: opts.userResponse,
  };
}

function mkDiscussion(overrides: Partial<Discussion> = {}): Discussion {
  return {
    id: overrides.id ?? 'd-1',
    question: overrides.question ?? 'q?',
    responses: overrides.responses ?? [],
    rounds: overrides.rounds ?? [mkRound(1), mkRound(2), mkRound(3)],
    orchestratorState: {
      phase: 'continuation',
      reasoning: '',
      consensusLevel: 0,
      topicExploration: 0,
      repetitionDetected: false,
      shouldContinue: true,
      conversationQuality: 'good',
    },
    totalTurns: 0,
    maxTurns: 10,
    userResponses: overrides.userResponses ?? [],
    createdAt: '',
  };
}

function fakeStorage(): StorageService {
  return {
    updateDiscussion: vi.fn(async () => undefined),
  } as unknown as StorageService;
}

describe('injectSparringInsight', () => {
  it('throws on empty insight', async () => {
    await expect(
      injectSparringInsight({
        discussion: mkDiscussion(),
        session: mkSession(),
        insight: '   ',
        storage: fakeStorage(),
      }),
    ).rejects.toThrow(/cannot be empty/);
  });

  it('throws when the discussion has no rounds', async () => {
    await expect(
      injectSparringInsight({
        discussion: mkDiscussion({ rounds: [] }),
        session: mkSession(),
        insight: 'x',
        storage: fakeStorage(),
      }),
    ).rejects.toThrow(/no discussion round/i);
  });

  it('attaches to the anchor round by default', async () => {
    const discussion = mkDiscussion();
    const session = mkSession({ anchorRoundNumber: 2 });
    const result = await injectSparringInsight({
      discussion,
      session,
      insight: 'Sharper take: the math doesn\'t pencil.',
      storage: fakeStorage(),
    });
    expect(result.injectedUserResponse.roundNumber).toBe(2);
    expect(result.injectedUserResponse.type).toBe('sparring_injection');
  });

  it('falls back to the latest round when the anchor round no longer exists', async () => {
    const discussion = mkDiscussion({ rounds: [mkRound(1)] });
    const session = mkSession({ anchorRoundNumber: 99 }); // stale anchor
    const result = await injectSparringInsight({
      discussion,
      session,
      insight: 'x',
      storage: fakeStorage(),
    });
    expect(result.injectedUserResponse.roundNumber).toBe(1);
  });

  it('populates provenance fields', async () => {
    const session = mkSession({
      id: 's-42',
      anchorRoundNumber: 2,
      anchorTurnNumber: 1,
      memberId: 'm-1',
      memberName: 'Elon Musk',
    });
    const result = await injectSparringInsight({
      discussion: mkDiscussion(),
      session,
      insight: 'Trim the headcount before the pivot.',
      storage: fakeStorage(),
      sparringTriggerInput: 'Push back on the team-first take',
    });
    const ur = result.injectedUserResponse;
    expect(ur.type).toBe('sparring_injection');
    expect(ur.selectedMemberId).toBe('m-1');
    expect(ur.sourceRoundNumber).toBe(2);
    expect(ur.sourceTurnNumber).toBe(1);
    expect(ur.sparringSessionId).toBe('s-42');
    expect(ur.sparringTriggerInput).toBe('Push back on the team-first take');
    expect(ur.prompt).toContain('Injected from 1:1 Deep Dive with Elon Musk');
    expect(ur.requestId.startsWith('sparring-injection-d-1-')).toBe(true);
  });

  it('appends the UserResponse to discussion.userResponses', async () => {
    const discussion = mkDiscussion();
    const before = discussion.userResponses.length;
    await injectSparringInsight({
      discussion,
      session: mkSession(),
      insight: 'x',
      storage: fakeStorage(),
    });
    expect(discussion.userResponses.length).toBe(before + 1);
    expect(discussion.userResponses[before]!.type).toBe('sparring_injection');
  });

  it('sets sourceRound.userResponse when the round has none', async () => {
    const round2 = mkRound(2);
    const discussion = mkDiscussion({ rounds: [mkRound(1), round2, mkRound(3)] });
    await injectSparringInsight({
      discussion,
      session: mkSession({ anchorRoundNumber: 2 }),
      insight: 'x',
      storage: fakeStorage(),
    });
    expect(round2.userResponse).toBeDefined();
    expect(round2.userResponse!.type).toBe('sparring_injection');
  });

  it('preserves an existing userResponse on the source round (does not clobber)', async () => {
    const existing: UserResponse = {
      id: 'existing-1',
      requestId: 'r-1',
      content: 'HITL reply',
      timestamp: '',
      roundNumber: 2,
      type: 'advisory_board_requested',
    };
    const round2 = mkRound(2, { userResponse: existing });
    const discussion = mkDiscussion({ rounds: [mkRound(1), round2, mkRound(3)] });
    await injectSparringInsight({
      discussion,
      session: mkSession({ anchorRoundNumber: 2 }),
      insight: 'x',
      storage: fakeStorage(),
    });
    // Source round still points to the original HITL reply
    expect(round2.userResponse).toBe(existing);
    // But the injection landed in the flat userResponses list
    expect(discussion.userResponses.find((u) => u.type === 'sparring_injection')).toBeDefined();
  });

  it('persists by calling storage.updateDiscussion exactly once', async () => {
    const storage = fakeStorage();
    await injectSparringInsight({
      discussion: mkDiscussion(),
      session: mkSession(),
      insight: 'x',
      storage,
    });
    expect(storage.updateDiscussion).toHaveBeenCalledTimes(1);
  });

  it('honors sourceRoundNumber override over the session anchor', async () => {
    const discussion = mkDiscussion();
    const result = await injectSparringInsight({
      discussion,
      session: mkSession({ anchorRoundNumber: 2 }),
      insight: 'x',
      storage: fakeStorage(),
      sourceRoundNumber: 3,
    });
    expect(result.injectedUserResponse.roundNumber).toBe(3);
    expect(result.injectedUserResponse.sourceRoundNumber).toBe(3);
  });
});
