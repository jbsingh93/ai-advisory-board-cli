/**
 * Engine tests for mid-discussion member add in `addFollowUpQuestion`
 * (Phase 7, Chunk 4). runMember / orchestrator / summarize / agent-emit are
 * mocked so no real Claude calls happen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const runMemberMock = vi.fn();
const analyzeMock = vi.fn();
const summarizeMock = vi.fn();
const emitMock = vi.fn((..._args: unknown[]) => ({ path: '', written: true }));

vi.mock('../run-member.js', () => ({
  runMember: (...args: unknown[]) => runMemberMock(...args),
}));

vi.mock('../orchestrator.js', async (importActual) => {
  const actual = await importActual<typeof import('../orchestrator.js')>();
  return {
    ...actual,
    analyzeConversation: (...args: unknown[]) => analyzeMock(...args),
  };
});

vi.mock('../summarize.js', () => ({
  summarizeDiscussion: (...args: unknown[]) => summarizeMock(...args),
}));

vi.mock('../../../agents/emit-member-agent.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../agents/emit-member-agent.js')>();
  return {
    ...actual,
    // Pretend the agent file always exists so the engine never writes one.
    memberAgentPath: () => 'C:/nonexistent/agent.md',
    emitMemberAgentFile: (...args: unknown[]) => emitMock(...args),
  };
});

// existsSync is used to decide whether to emit a missing agent file; force true.
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return { ...actual, existsSync: () => true };
});

// The engine fires fire-and-forget user-fact ingests after each round (Phase 8).
// This test mocks `node:fs` existsSync→true, which would otherwise defeat the
// queue's wiki-dirs gate and spawn a real background ingest against the fake
// workspace — leaking past the test and hanging the vitest worker. Stub the
// queue to a no-op; the ingest pipeline has its own dedicated tests.
vi.mock('../../knowledge/ingest-queue.js', () => ({
  maybeEnqueueUserInput: () => undefined,
  drainUserFactQueue: async () => undefined,
}));

import { addFollowUpQuestion } from '../conversation-flow.js';
import type {
  AdvisoryBoardMember,
  AppSettings,
  Discussion,
  Response,
  StorageService,
} from '../../../storage/types.js';

function mkMember(id: string, name: string, isActive = true): AdvisoryBoardMember {
  return { id, name, title: 'T', expertise: [], persona: 'p', isActive, createdAt: '', updatedAt: '' };
}

function mkResponse(member: AdvisoryBoardMember, roundNumber: number): Response {
  return {
    memberId: member.id,
    memberName: member.name,
    content: `${member.name} says hi`,
    timestamp: '',
    order: 1,
    roundNumber,
    turnNumber: 1,
    isFollowUp: true,
    referencedMembers: [],
    sentiment: 'constructive',
    topicTags: [],
  };
}

function mkDiscussion(memberIds: string[]): Discussion {
  return {
    id: 'd1',
    question: 'Original Q?',
    selectedMemberIds: memberIds,
    participants: memberIds.map((id) => ({ memberId: id, name: id, slug: id, title: 'T', joinedAtRound: 1 })),
    responses: [
      {
        memberId: memberIds[0]!,
        memberName: memberIds[0]!,
        content: 'round1 take',
        timestamp: '',
        order: 1,
        roundNumber: 1,
        turnNumber: 1,
        isFollowUp: false,
        referencedMembers: [],
        sentiment: 'constructive',
        topicTags: [],
      },
    ],
    rounds: [
      {
        roundNumber: 1,
        responses: [],
        orchestratorDecision: { action: 'continue', reasoning: '', consensusReached: false, confidence: 100 },
        startedAt: '',
        completedAt: '',
      },
    ],
    orchestratorState: {
      phase: 'continuation',
      reasoning: '',
      consensusLevel: 0,
      topicExploration: 0,
      repetitionDetected: false,
      shouldContinue: true,
      conversationQuality: 'good',
    },
    totalTurns: 1,
    maxTurns: 20,
    userResponses: [],
    createdAt: '',
  };
}

const SETTINGS = { maxTurnsPerDiscussion: 20, maxMembersPerDiscussion: 5 } as AppSettings;

function fakeStorage(): { storage: StorageService; saved: Discussion[] } {
  const saved: Discussion[] = [];
  const storage = {
    saveDiscussion: vi.fn(async (d: Discussion) => {
      saved.push(JSON.parse(JSON.stringify(d)));
    }),
    getWorkspaceRoot: () => 'C:/nonexistent-workspace',
    loadBusinessContext: vi.fn(async () => []),
    appendTokenUsageLog: vi.fn(async () => undefined),
    getWorkspaceId: () => 'ws',
  } as unknown as StorageService;
  return { storage, saved };
}

const ALICE = mkMember('m1', 'Alice');
const BOB = mkMember('m2', 'Bob');
const CLEO = mkMember('m3', 'Cleo'); // active, not in discussion
const INACTIVE = mkMember('m4', 'Dorothy', false);

afterEach(() => {
  runMemberMock.mockReset();
  analyzeMock.mockReset();
  summarizeMock.mockReset();
  emitMock.mockClear();
});

describe('addFollowUpQuestion — addMemberIds', () => {
  it('adds a newcomer who responds, extends roster + participants + addedMemberIds', async () => {
    analyzeMock.mockResolvedValue({ action: 'continue', reasoning: '', consensusReached: false, confidence: 90 });
    runMemberMock.mockImplementation(async (o: { member: AdvisoryBoardMember }) => ({
      response: mkResponse(o.member, 2),
      structured: { response: 'x' },
      parseFallback: false,
      costUsd: 0.01,
      durationMs: 5,
    }));

    const discussion = mkDiscussion(['m1', 'm2']);
    const { storage, saved } = fakeStorage();
    const result = await addFollowUpQuestion({
      discussion,
      question: 'New angle?',
      members: [ALICE, BOB, CLEO],
      settings: SETTINGS,
      storage,
      targetType: 'all',
      addMemberIds: ['m3'],
      catchUpMode: 'full',
    });

    expect(result.roundNumber).toBe(2);
    // Cleo responded (targetType all includes newcomer).
    const calledMembers = runMemberMock.mock.calls.map((c) => (c[0] as { member: AdvisoryBoardMember }).member.id);
    expect(calledMembers).toContain('m3');
    // Roster extended.
    expect(discussion.selectedMemberIds).toContain('m3');
    // Participant entry with joinedAtRound 2 + catchUpMode.
    const p = discussion.participants!.find((x) => x.memberId === 'm3');
    expect(p?.joinedAtRound).toBe(2);
    expect(p?.catchUpMode).toBe('full');
    // Round records the join.
    expect(discussion.rounds[1]!.addedMemberIds).toEqual(['m3']);
    // Persisted.
    expect(saved.length).toBeGreaterThan(0);
  });

  it('rejects adding a member already in the discussion', async () => {
    analyzeMock.mockResolvedValue({ action: 'continue', reasoning: '', consensusReached: false, confidence: 90 });
    const discussion = mkDiscussion(['m1', 'm2']);
    const { storage } = fakeStorage();
    await expect(
      addFollowUpQuestion({
        discussion,
        question: 'q',
        members: [ALICE, BOB],
        settings: SETTINGS,
        storage,
        addMemberIds: ['m2'],
      }),
    ).rejects.toThrow(/already part of this discussion/);
  });

  it('rejects adding an inactive/unknown member', async () => {
    analyzeMock.mockResolvedValue({ action: 'continue', reasoning: '', consensusReached: false, confidence: 90 });
    const discussion = mkDiscussion(['m1', 'm2']);
    const { storage } = fakeStorage();
    await expect(
      addFollowUpQuestion({
        discussion,
        question: 'q',
        members: [ALICE, BOB, INACTIVE],
        settings: SETTINGS,
        storage,
        addMemberIds: ['m4'],
      }),
    ).rejects.toThrow(/not found among active members/);
  });

  it('strict-abort: a member failure rolls back the participant addition (nothing committed)', async () => {
    analyzeMock.mockResolvedValue({ action: 'continue', reasoning: '', consensusReached: false, confidence: 90 });
    // First member ok, the newcomer throws.
    runMemberMock.mockImplementation(async (o: { member: AdvisoryBoardMember }) => {
      if (o.member.id === 'm3') throw new Error('newcomer failed');
      return { response: mkResponse(o.member, 2), structured: { response: 'x' }, parseFallback: false, costUsd: 0, durationMs: 1 };
    });

    const discussion = mkDiscussion(['m1', 'm2']);
    const beforeIds = [...discussion.selectedMemberIds!];
    const beforeParticipants = discussion.participants!.length;
    const { storage, saved } = fakeStorage();

    await expect(
      addFollowUpQuestion({
        discussion,
        question: 'q',
        members: [ALICE, BOB, CLEO],
        settings: SETTINGS,
        storage,
        targetType: 'all',
        addMemberIds: ['m3'],
      }),
    ).rejects.toThrow(/newcomer failed/);

    // Rolled back: roster + participants unchanged, no new round saved.
    expect(discussion.selectedMemberIds).toEqual(beforeIds);
    expect(discussion.participants!.length).toBe(beforeParticipants);
    expect(discussion.rounds.length).toBe(1);
    // saveDiscussion was never called for a committed round (only the gate path
    // could save, but the gate returned continue without saving here).
    expect(saved.every((d) => d.rounds.length === 1)).toBe(true);
  });

  it('added-but-not-targeted member joins roster but does not respond this round', async () => {
    analyzeMock.mockResolvedValue({ action: 'continue', reasoning: '', consensusReached: false, confidence: 90 });
    runMemberMock.mockImplementation(async (o: { member: AdvisoryBoardMember }) => ({
      response: mkResponse(o.member, 2),
      structured: { response: 'x' },
      parseFallback: false,
      costUsd: 0,
      durationMs: 1,
    }));

    const discussion = mkDiscussion(['m1', 'm2']);
    const { storage } = fakeStorage();
    // Add Cleo but target only Alice.
    await addFollowUpQuestion({
      discussion,
      question: 'q',
      members: [ALICE, BOB, CLEO],
      settings: SETTINGS,
      storage,
      targetType: 'specific',
      selectedMemberId: 'm1',
      addMemberIds: ['m3'],
    });

    const calledMembers = runMemberMock.mock.calls.map((c) => (c[0] as { member: AdvisoryBoardMember }).member.id);
    expect(calledMembers).toEqual(['m1']); // only Alice responded
    // Cleo joined the roster for future rounds.
    expect(discussion.selectedMemberIds).toContain('m3');
    const p = discussion.participants!.find((x) => x.memberId === 'm3');
    expect(p?.joinedAtRound).toBe(2);
    // No catch-up recorded yet (didn't speak).
    expect(p?.catchUpMode).toBeUndefined();
  });

  it('summary catch-up uses an existing discussion.summary (no summarize call) and feeds empty history', async () => {
    analyzeMock.mockResolvedValue({ action: 'continue', reasoning: '', consensusReached: false, confidence: 90 });
    runMemberMock.mockImplementation(async (o: { member: AdvisoryBoardMember }) => ({
      response: mkResponse(o.member, 2),
      structured: { response: 'x' },
      parseFallback: false,
      costUsd: 0,
      durationMs: 1,
    }));

    const discussion = mkDiscussion(['m1']);
    discussion.summary = {
      keyPoints: ['KP'],
      consensus: [],
      disagreements: [],
      actionableInsights: [],
      participationBreakdown: [],
      overallQuality: 70,
      generatedAt: '',
    };
    const { storage } = fakeStorage();
    await addFollowUpQuestion({
      discussion,
      question: 'q',
      members: [ALICE, CLEO],
      settings: SETTINGS,
      storage,
      targetType: 'all',
      addMemberIds: ['m3'],
      catchUpMode: 'summary',
    });

    expect(summarizeMock).not.toHaveBeenCalled();
    // The newcomer (Cleo) got priorRoundsSummary + empty history.
    const cleoCall = runMemberMock.mock.calls.find((c) => (c[0] as { member: AdvisoryBoardMember }).member.id === 'm3');
    const cleoArgs = cleoCall![0] as { conversationHistory: Response[]; priorRoundsSummary?: string; joinCatchUpMode?: string };
    expect(cleoArgs.conversationHistory).toEqual([]);
    expect(cleoArgs.priorRoundsSummary).toContain('KP');
    expect(cleoArgs.joinCatchUpMode).toBe('summary');
  });
});
