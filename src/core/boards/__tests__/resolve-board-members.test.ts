import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBoardMembers, boardMemberSet } from '../resolve-board-members.js';
import { resolveBoardToken } from '../board-helpers.js';
import type {
  AdvisoryBoardMember,
  AppSettings,
  Board,
  StorageService,
} from '../../../storage/types.js';

function mkMember(id: string, name: string, isActive = true): AdvisoryBoardMember {
  return { id, name, title: 't', expertise: [], persona: 'p', isActive, createdAt: '', updatedAt: '' };
}

function mkBoard(id: string, slug: string, name: string, memberIds: string[]): Board {
  return { id, name, slug, memberIds, createdAt: '', updatedAt: '' };
}

const MEMBERS = [mkMember('m1', 'Alice'), mkMember('m2', 'Bob'), mkMember('m3', 'Cleo', false)];
const BOARDS = [mkBoard('b1', 'gtm', 'GTM', ['m1', 'm2']), mkBoard('b2', 'tech', 'Tech', ['m2'])];

function fakeStorage(boards: Board[] = BOARDS, members: AdvisoryBoardMember[] = MEMBERS): StorageService {
  return {
    loadBoardMembers: vi.fn(async () => members),
    loadBoards: vi.fn(async () => boards),
  } as unknown as StorageService;
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { maxMembersPerDiscussion: 5, ...overrides } as AppSettings;
}

// A simple member-token resolver mirroring the CLI's.
function resolveMemberToken(pool: AdvisoryBoardMember[], token: string): AdvisoryBoardMember | undefined {
  const t = token.trim().toLowerCase();
  return pool.find((m) => m.id === token) ?? pool.find((m) => m.name.toLowerCase() === t);
}

afterEach(() => {
  delete process.env.AAB_BOARD;
  vi.restoreAllMocks();
});

describe('resolveBoardMembers precedence', () => {
  it('1. --members beats everything', async () => {
    const r = await resolveBoardMembers(fakeStorage(), settings({ activeBoardId: 'b1' }), {
      membersFlag: 'Alice',
      boardToken: undefined,
      resolveMemberToken,
    });
    expect(r.source).toBe('members-flag');
    expect(r.members.map((m) => m.id)).toEqual(['m1']);
    expect(r.board).toBeUndefined();
  });

  it('throws when --members and --board both set', async () => {
    await expect(
      resolveBoardMembers(fakeStorage(), settings(), {
        membersFlag: 'Alice',
        boardToken: 'gtm',
        resolveMemberToken,
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('2. --board beats env + active', async () => {
    process.env.AAB_BOARD = 'tech';
    const r = await resolveBoardMembers(fakeStorage(), settings({ activeBoardId: 'b2' }), {
      boardToken: 'gtm',
      resolveMemberToken,
    });
    expect(r.source).toBe('board-flag');
    expect(r.board?.id).toBe('b1');
    expect(r.members.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('3. AAB_BOARD env beats active', async () => {
    process.env.AAB_BOARD = 'gtm';
    const r = await resolveBoardMembers(fakeStorage(), settings({ activeBoardId: 'b2' }), {
      resolveMemberToken,
    });
    expect(r.source).toBe('env');
    expect(r.board?.id).toBe('b1');
  });

  it('4. settings.activeBoardId when no flag/env', async () => {
    const r = await resolveBoardMembers(fakeStorage(), settings({ activeBoardId: 'b2' }), {
      resolveMemberToken,
    });
    expect(r.source).toBe('active');
    expect(r.board?.id).toBe('b2');
    expect(r.members.map((m) => m.id)).toEqual(['m2']);
  });

  it('5. all-active fallback', async () => {
    const r = await resolveBoardMembers(fakeStorage(), settings(), { resolveMemberToken });
    expect(r.source).toBe('all-active');
    expect(r.members.map((m) => m.id)).toEqual(['m1', 'm2']); // m3 inactive
  });

  it('throws on unknown --board token', async () => {
    await expect(
      resolveBoardMembers(fakeStorage(), settings(), { boardToken: 'ghost', resolveMemberToken }),
    ).rejects.toThrow(/No board matched/);
  });

  it('ignores archived board referenced by activeBoardId, falls through to all-active', async () => {
    const archived = [mkBoard('b1', 'gtm', 'GTM', ['m1', 'm2'])];
    archived[0]!.archivedAt = '2026-01-01T00:00:00.000Z';
    const r = await resolveBoardMembers(fakeStorage(archived), settings({ activeBoardId: 'b1' }), {
      resolveMemberToken,
    });
    expect(r.source).toBe('all-active');
  });
});

describe('boardMemberSet', () => {
  it('preserves board order and drops inactive/deleted', () => {
    const board = mkBoard('b', 's', 'n', ['m3', 'm1', 'ghost', 'm2']);
    const set = boardMemberSet(board, MEMBERS);
    expect(set.map((m) => m.id)).toEqual(['m1', 'm2']); // m3 inactive, ghost missing
  });
});

describe('resolveBoardToken filters archived in resolver caller', () => {
  it('does not match archived board', () => {
    const archived = mkBoard('b1', 'gtm', 'GTM', ['m1']);
    archived.archivedAt = 'x';
    expect(resolveBoardToken([archived].filter((b) => !b.archivedAt), 'gtm')).toBeUndefined();
  });
});
