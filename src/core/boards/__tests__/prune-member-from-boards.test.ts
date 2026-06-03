import { describe, expect, it, vi } from 'vitest';
import { pruneMemberFromBoards } from '../prune-member-from-boards.js';
import type { Board, StorageService } from '../../../storage/types.js';

function mkBoard(id: string, memberIds: string[]): Board {
  return { id, name: id, slug: id, memberIds, createdAt: '', updatedAt: '' };
}

function fakeStorage(boards: Board[]): { storage: StorageService; updates: Board[] } {
  const updates: Board[] = [];
  const storage = {
    loadBoards: vi.fn(async () => boards),
    updateBoard: vi.fn(async (b: Board) => {
      updates.push(b);
    }),
  } as unknown as StorageService;
  return { storage, updates };
}

describe('pruneMemberFromBoards', () => {
  it('member in zero boards → no updates', async () => {
    const { storage, updates } = fakeStorage([mkBoard('b1', ['x', 'y'])]);
    const res = await pruneMemberFromBoards(storage, 'gone');
    expect(res.affected).toEqual([]);
    expect(res.emptied).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('member in one board → that board updated, id removed', async () => {
    const { storage, updates } = fakeStorage([mkBoard('b1', ['x', 'm']), mkBoard('b2', ['y'])]);
    const res = await pruneMemberFromBoards(storage, 'm');
    expect(res.affected.map((b) => b.id)).toEqual(['b1']);
    expect(res.emptied).toEqual([]);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.memberIds).toEqual(['x']);
  });

  it('member in many boards → all updated', async () => {
    const { storage, updates } = fakeStorage([
      mkBoard('b1', ['m', 'x']),
      mkBoard('b2', ['m']),
      mkBoard('b3', ['x']),
    ]);
    const res = await pruneMemberFromBoards(storage, 'm');
    expect(res.affected.map((b) => b.id).sort()).toEqual(['b1', 'b2']);
    expect(updates).toHaveLength(2);
  });

  it('board emptied → reported in emptied (kept, not deleted)', async () => {
    const { storage } = fakeStorage([mkBoard('b1', ['m'])]);
    const res = await pruneMemberFromBoards(storage, 'm');
    expect(res.emptied.map((b) => b.id)).toEqual(['b1']);
    expect(res.affected.map((b) => b.id)).toEqual(['b1']);
  });
});
