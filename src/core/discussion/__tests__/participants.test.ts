import { describe, expect, it } from 'vitest';
import { ensureParticipants, synthesizeParticipants, participantById } from '../participants.js';
import type { AdvisoryBoardMember, Discussion, Response } from '../../../storage/types.js';

function mkMember(id: string, name: string, title = 'T'): AdvisoryBoardMember {
  return { id, name, title, expertise: [], persona: 'p', isActive: true, createdAt: '', updatedAt: '' };
}

function mkResponse(memberId: string, memberName: string): Response {
  return {
    memberId,
    memberName,
    content: 'x',
    timestamp: '',
    order: 1,
    roundNumber: 1,
    turnNumber: 1,
    isFollowUp: false,
    referencedMembers: [],
    sentiment: 'constructive',
    topicTags: [],
  };
}

function mkDiscussion(overrides: Partial<Discussion> = {}): Discussion {
  return {
    id: 'd1',
    question: 'q',
    selectedMemberIds: overrides.selectedMemberIds,
    participants: overrides.participants,
    responses: overrides.responses ?? [],
    rounds: [],
    orchestratorState: {
      phase: 'initial',
      reasoning: '',
      consensusLevel: 0,
      topicExploration: 0,
      repetitionDetected: false,
      shouldContinue: true,
      conversationQuality: 'good',
    },
    totalTurns: 0,
    maxTurns: 10,
    userResponses: [],
    createdAt: '',
  };
}

const MEMBERS = [mkMember('m1', 'Alice', 'CEO'), mkMember('m2', 'Bob', 'CFO')];

describe('synthesizeParticipants', () => {
  it('builds from selectedMemberIds + live members, joinedAtRound 1', () => {
    const d = mkDiscussion({ selectedMemberIds: ['m1', 'm2'] });
    const ps = synthesizeParticipants(d, MEMBERS);
    expect(ps).toEqual([
      { memberId: 'm1', name: 'Alice', slug: 'alice', title: 'CEO', joinedAtRound: 1 },
      { memberId: 'm2', name: 'Bob', slug: 'bob', title: 'CFO', joinedAtRound: 1 },
    ]);
  });

  it('falls back to the response snapshot name for a deleted member', () => {
    const d = mkDiscussion({
      selectedMemberIds: ['m1', 'gone'],
      responses: [mkResponse('gone', 'Ghost Advisor')],
    });
    const ps = synthesizeParticipants(d, MEMBERS);
    expect(ps[1]).toEqual({
      memberId: 'gone',
      name: 'Ghost Advisor',
      slug: 'ghost-advisor',
      title: '',
      joinedAtRound: 1,
    });
  });

  it('synthesizes from responses when selectedMemberIds is absent', () => {
    const d = mkDiscussion({ responses: [mkResponse('m1', 'Alice'), mkResponse('m1', 'Alice'), mkResponse('m2', 'Bob')] });
    const ps = synthesizeParticipants(d, MEMBERS);
    expect(ps.map((p) => p.memberId)).toEqual(['m1', 'm2']);
  });
});

describe('ensureParticipants', () => {
  it('returns existing participants untouched (idempotent)', () => {
    const existing = [{ memberId: 'm1', name: 'Renamed', slug: 'renamed', title: 'X', joinedAtRound: 1 }];
    const d = mkDiscussion({ selectedMemberIds: ['m1'], participants: existing });
    const ps = ensureParticipants(d, MEMBERS);
    expect(ps).toBe(existing); // same reference — not regenerated
    expect(d.participants![0]!.name).toBe('Renamed');
  });

  it('mutates discussion.participants in place when absent (persists on next save)', () => {
    const d = mkDiscussion({ selectedMemberIds: ['m1'] });
    expect(d.participants).toBeUndefined();
    ensureParticipants(d, MEMBERS);
    expect(d.participants).toHaveLength(1);
    expect(d.participants![0]!.name).toBe('Alice');
  });
});

describe('participantById', () => {
  it('finds by member id', () => {
    const d = mkDiscussion({ participants: [{ memberId: 'm2', name: 'Bob', slug: 'bob', title: 'CFO', joinedAtRound: 3 }] });
    expect(participantById(d, 'm2')?.joinedAtRound).toBe(3);
    expect(participantById(d, 'nope')).toBeUndefined();
  });
});
