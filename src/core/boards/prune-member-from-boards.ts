/**
 * Cascade-prune a deleted member from every board's roster (Phase 7 orphan
 * fix). App-level cleanup only — no storage-layer cascade — so the caller can
 * distinguish "removed from active boards" from "preserved in transcripts".
 *
 * Empty boards are KEPT and flagged (spec §1.4 / open-question #3), never
 * auto-deleted, so a user can re-populate them.
 */
import type { Board, StorageService } from '../../storage/types.js';

export interface PruneResult {
  /** Boards whose roster changed (member id removed). */
  affected: Board[];
  /** Subset of `affected` that became empty after the prune. */
  emptied: Board[];
}

export async function pruneMemberFromBoards(
  storage: StorageService,
  memberId: string,
): Promise<PruneResult> {
  const boards = await storage.loadBoards();
  const affected: Board[] = [];
  const emptied: Board[] = [];

  for (const board of boards) {
    if (!board.memberIds.includes(memberId)) continue;
    const nextIds = board.memberIds.filter((id) => id !== memberId);
    const updated: Board = { ...board, memberIds: nextIds };
    await storage.updateBoard(updated);
    affected.push(updated);
    if (nextIds.length === 0) emptied.push(updated);
  }

  return { affected, emptied };
}
