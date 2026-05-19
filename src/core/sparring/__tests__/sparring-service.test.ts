import { describe, expect, it, vi } from 'vitest';
import { __test, openSparringSession } from '../sparring-service.js';
import type {
  AdvisoryBoardMember,
  Discussion,
  Response,
  SparringSession,
  StorageService,
} from '../../../storage/types.js';

const { pickAnchorResponse, extractSourcesFromText } = __test;

function resp(
  memberId: string,
  memberName: string,
  roundNumber: number,
  turnNumber: number,
  content = 'a response',
): Response {
  return {
    memberId,
    memberName,
    content,
    timestamp: '',
    order: turnNumber,
    roundNumber,
    turnNumber,
    isFollowUp: false,
    referencedMembers: [],
    sentiment: 'constructive',
    topicTags: [],
  };
}

function discussion(overrides: Partial<Discussion> = {}): Discussion {
  return {
    id: overrides.id ?? 'd-1',
    question: 'q?',
    responses: overrides.responses ?? [],
    rounds: overrides.rounds ?? [],
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
    userResponses: [],
    createdAt: '',
  };
}

function member(overrides: Partial<AdvisoryBoardMember> = {}): AdvisoryBoardMember {
  return {
    id: overrides.id ?? 'm-1',
    name: overrides.name ?? 'Elon Musk',
    title: overrides.title ?? 't',
    expertise: overrides.expertise ?? [],
    persona: overrides.persona ?? '',
    isActive: overrides.isActive ?? true,
    createdAt: '',
    updatedAt: '',
  };
}

function fakeStorage(opts: { existing?: SparringSession[] } = {}): StorageService & {
  saved: SparringSession[];
} {
  const saved: SparringSession[] = [];
  return {
    loadSparringSessionsForDiscussion: vi.fn(async () => opts.existing ?? []),
    saveSparringSession: vi.fn(async (s: SparringSession) => {
      saved.push(s);
    }),
    saved,
  } as unknown as StorageService & { saved: SparringSession[] };
}

describe('pickAnchorResponse', () => {
  it('returns undefined when the member has no responses', () => {
    const d = discussion({ responses: [resp('m-other', 'X', 1, 1)] });
    expect(pickAnchorResponse(d, 'm-1')).toBeUndefined();
  });

  it('returns the exact match when (round, turn) match a response', () => {
    const r = resp('m-1', 'Elon', 2, 1, 'exact');
    const d = discussion({ responses: [resp('m-1', 'Elon', 1, 1), r] });
    const out = pickAnchorResponse(d, 'm-1', 2, 1);
    expect(out).toBe(r);
  });

  it('falls back to the latest turn in the requested round when the exact turn is missing', () => {
    const r = resp('m-1', 'Elon', 2, 3, 'latest-in-round');
    const d = discussion({
      responses: [resp('m-1', 'Elon', 2, 1), resp('m-1', 'Elon', 2, 2), r],
    });
    // Ask for round 2 turn 99 — should pick highest-turn in round 2.
    expect(pickAnchorResponse(d, 'm-1', 2, 99)).toBe(r);
  });

  it('defaults to the latest response across rounds when no anchor is given', () => {
    const latest = resp('m-1', 'Elon', 3, 1, 'latest');
    const d = discussion({
      responses: [resp('m-1', 'Elon', 1, 1), resp('m-1', 'Elon', 2, 1), latest],
    });
    expect(pickAnchorResponse(d, 'm-1')).toBe(latest);
  });
});

describe('extractSourcesFromText', () => {
  it('returns [] when no URLs present', () => {
    expect(extractSourcesFromText('Just plain text, no links here.')).toEqual([]);
  });

  it('parses markdown links with titles', () => {
    const text = 'See [Companies House](https://companieshouse.gov.uk) for the filings.';
    const out = extractSourcesFromText(text);
    expect(out).toEqual([{ title: 'Companies House', url: 'https://companieshouse.gov.uk' }]);
  });

  it('dedupes by URL', () => {
    const text = 'first [A](https://x.example) and again [B](https://x.example).';
    const out = extractSourcesFromText(text);
    expect(out.length).toBe(1);
    expect(out[0]!.url).toBe('https://x.example');
  });

  it('falls through to bare URLs when no markdown links match', () => {
    const text = 'Read https://foo.example/path for details.';
    const out = extractSourcesFromText(text);
    expect(out.length).toBe(1);
    expect(out[0]!.url).toBe('https://foo.example/path');
    expect(out[0]!.title).toBe('Source');
  });

  it('caps at 5 sources', () => {
    const text = Array.from({ length: 10 }, (_, i) => `[t${i}](https://h${i}.example)`).join(' ');
    const out = extractSourcesFromText(text);
    expect(out.length).toBe(5);
  });

  it('strips trailing punctuation from bare URLs', () => {
    const text = 'Bare: https://q.example/x.';
    const out = extractSourcesFromText(text);
    expect(out[0]!.url).toBe('https://q.example/x');
  });
});

describe('openSparringSession', () => {
  it('throws when the member has no responses to anchor on', async () => {
    const d = discussion({ responses: [resp('m-other', 'X', 1, 1)] });
    const storage = fakeStorage();
    await expect(
      openSparringSession({ discussion: d, member: member({ id: 'm-1' }), storage }),
    ).rejects.toThrow(/No response from/);
  });

  it('creates a new session when no matching existing session exists', async () => {
    const d = discussion({ responses: [resp('m-1', 'Elon', 2, 1, 'anchor content')] });
    const storage = fakeStorage();
    const out = await openSparringSession({ discussion: d, member: member({ id: 'm-1' }), storage });
    expect(out.reused).toBe(false);
    expect(out.session.discussionId).toBe('d-1');
    expect(out.session.memberId).toBe('m-1');
    expect(out.session.anchorRoundNumber).toBe(2);
    expect(out.session.anchorResponsePreview).toContain('anchor content');
    expect(storage.saveSparringSession).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing session matching (memberId, round, turn)', async () => {
    const d = discussion({ responses: [resp('m-1', 'Elon', 2, 1)] });
    const existing: SparringSession = {
      id: 'existing-1',
      discussionId: 'd-1',
      memberId: 'm-1',
      memberName: 'Elon',
      anchorRoundNumber: 2,
      anchorTurnNumber: 1,
      anchorResponsePreview: 'old preview',
      messages: [],
      createdAt: '',
      updatedAt: '',
    };
    const storage = fakeStorage({ existing: [existing] });
    const out = await openSparringSession({ discussion: d, member: member({ id: 'm-1' }), storage });
    expect(out.reused).toBe(true);
    expect(out.session.id).toBe('existing-1');
    expect(storage.saveSparringSession).not.toHaveBeenCalled();
  });

  it('truncates a long anchor body in the preview with an ellipsis', async () => {
    const longContent = 'X'.repeat(500);
    const d = discussion({ responses: [resp('m-1', 'Elon', 2, 1, longContent)] });
    const storage = fakeStorage();
    const out = await openSparringSession({ discussion: d, member: member({ id: 'm-1' }), storage });
    expect(out.session.anchorResponsePreview.endsWith('…')).toBe(true);
    expect(out.session.anchorResponsePreview.length).toBeLessThan(longContent.length);
  });
});
