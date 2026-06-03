/**
 * Resolve the member set for a discussion, applying the Phase 7 precedence
 * (spec §1.5):
 *   1. `--members <names>` flag (explicit ad-hoc subset — highest)
 *   2. `--board <slug|id|name>` flag
 *   3. `AAB_BOARD` env var
 *   4. `settings.activeBoardId`
 *   5. All active members (today's default — fully backward compatible)
 *
 * Returns the ordered, active member set plus the board it resolved from (if
 * any) so callers can echo the panel and stamp `discussion.boardId/boardName`.
 */
import { UserError } from '../errors.js';
import { resolveBoardToken } from './board-helpers.js';
import type {
  AdvisoryBoardMember,
  AppSettings,
  Board,
  StorageService,
} from '../../storage/types.js';

export type BoardResolutionSource = 'members-flag' | 'board-flag' | 'env' | 'active' | 'all-active';

export interface ResolveBoardMembersOptions {
  /** Raw `--members` comma list (names/slugs/ids). Mutually exclusive with boardToken. */
  membersFlag?: string;
  /** Raw `--board` token (slug/id/name). */
  boardToken?: string;
  /** Resolver for a member token → matches name/slug/id/prefix. */
  resolveMemberToken: (pool: AdvisoryBoardMember[], token: string) => AdvisoryBoardMember | undefined;
}

export interface ResolveBoardMembersResult {
  /** Ordered, active members to convene. */
  members: AdvisoryBoardMember[];
  /** The board the set resolved from (undefined ⇒ ad-hoc / all-active). */
  board?: Board;
  source: BoardResolutionSource;
}

export async function resolveBoardMembers(
  storage: StorageService,
  settings: AppSettings,
  opts: ResolveBoardMembersOptions,
): Promise<ResolveBoardMembersResult> {
  if (opts.membersFlag && opts.boardToken) {
    throw new UserError(
      '--board and --members are mutually exclusive.',
      'Use --board to convene a saved panel, or --members for an ad-hoc subset.',
    );
  }

  const allMembers = await storage.loadBoardMembers();
  const active = allMembers.filter((m) => m.isActive);

  // 1. --members ad-hoc subset
  if (opts.membersFlag) {
    const tokens = opts.membersFlag.split(',').map((t) => t.trim()).filter(Boolean);
    const matched: AdvisoryBoardMember[] = [];
    const unmatched: string[] = [];
    for (const tok of tokens) {
      const m = opts.resolveMemberToken(active, tok);
      if (m) {
        if (!matched.some((x) => x.id === m.id)) matched.push(m);
      } else unmatched.push(tok);
    }
    if (unmatched.length > 0) {
      throw new UserError(
        `No active member matched: ${unmatched.join(', ')}`,
        `Active members: ${active.map((m) => m.name).join(', ') || '(none)'}`,
      );
    }
    return { members: matched, source: 'members-flag' };
  }

  const boards = await storage.loadBoards();

  // 2. --board flag
  if (opts.boardToken) {
    const board = resolveBoardToken(boards.filter((b) => !b.archivedAt), opts.boardToken);
    if (!board) {
      throw new UserError(
        `No board matched "${opts.boardToken}".`,
        boards.length > 0
          ? `Boards: ${boards.map((b) => b.slug).join(', ')}`
          : 'Create one with `aab board create "<name>" --members a,b,c`.',
      );
    }
    return { members: boardMemberSet(board, allMembers), board, source: 'board-flag' };
  }

  // 3. AAB_BOARD env
  const envBoard = process.env.AAB_BOARD?.trim();
  if (envBoard) {
    const board = resolveBoardToken(boards.filter((b) => !b.archivedAt), envBoard);
    if (board) return { members: boardMemberSet(board, allMembers), board, source: 'env' };
  }

  // 4. settings.activeBoardId
  if (settings.activeBoardId) {
    const board = boards.find((b) => b.id === settings.activeBoardId && !b.archivedAt);
    if (board) return { members: boardMemberSet(board, allMembers), board, source: 'active' };
  }

  // 5. All active members
  return { members: active, source: 'all-active' };
}

/**
 * Materialise a board's ordered roster into active member objects, preserving
 * board order and silently dropping members that are inactive or deleted.
 */
export function boardMemberSet(board: Board, allMembers: AdvisoryBoardMember[]): AdvisoryBoardMember[] {
  const byId = new Map(allMembers.map((m) => [m.id, m]));
  const out: AdvisoryBoardMember[] = [];
  for (const id of board.memberIds) {
    const m = byId.get(id);
    if (m && m.isActive) out.push(m);
  }
  return out;
}
