/**
 * `aab board list | show | create | edit | add-member | remove-member |
 *  set-members | rename | delete | use | current`
 *
 * Phase 7 — boards are named, reusable groups of members. Members are the
 * source of truth; a board holds ordered *references* (member ids), never
 * copies. The active board (per-workspace, in settings.activeBoardId) gives
 * `aab discuss start` a default panel (kubectx-style ergonomics).
 */
import { Command } from 'commander';
import { closeContext, openContext } from './_context.js';
import { c, memberColor } from '../ui/colors.js';
import { askMultiSelect } from '../ui/prompts.js';
import { UserError } from '../core/errors.js';
import { generateUUID, nowIso } from '../core/utils.js';
import { resolveMemberToken } from './discuss.js';
import {
  boardSlug,
  ensureUniqueBoardSlug,
  resolveBoardToken,
  validateBoardFields,
} from '../core/boards/board-helpers.js';
import type { AdvisoryBoardMember, Board } from '../storage/types.js';

const ACTIVE_PREV_KEY = '__aab_prev_active_board__';

/**
 * Return a settings object with the active board changed to `nextId`, recording
 * the prior active id under {@link ACTIVE_PREV_KEY} so `aab board use -` can
 * toggle back (kubectx idiom). Any active-board change goes through here.
 */
function withActiveBoard<T extends { activeBoardId?: string }>(settings: T, nextId: string | undefined): T {
  const prev = settings.activeBoardId;
  return { ...settings, activeBoardId: nextId, [ACTIVE_PREV_KEY]: prev } as unknown as T;
}

export function registerBoardCommand(program: Command): void {
  const board = program.command('board').description('manage boards (named groups of members)');

  registerList(board);
  registerShow(board);
  registerCreate(board);
  registerEdit(board);
  registerAddMember(board);
  registerRemoveMember(board);
  registerSetMembers(board);
  registerRename(board);
  registerDelete(board);
  registerUse(board);
  registerCurrent(board);
}

// ----------------------------------------------------------------
// list
// ----------------------------------------------------------------
function registerList(parent: Command): void {
  parent
    .command('list')
    .description('list boards (name, slug, #members, active marker)')
    .option('--archived', 'include archived boards')
    .action(async (opts: { archived?: boolean }) => {
      const ctx = await openContext(parent, { lock: false });
      try {
        const settings = await ctx.storage.loadSettings();
        let boards = await ctx.storage.loadBoards();
        if (!opts.archived) boards = boards.filter((b) => !b.archivedAt);
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ boards, activeBoardId: settings.activeBoardId ?? null }, null, 2) + '\n');
          return;
        }
        if (boards.length === 0) {
          process.stdout.write(c.hint('  (no boards yet — run `aab board create "<name>" --members a,b,c`)\n'));
          return;
        }
        process.stdout.write(`\n${c.brand('Boards')}\n\n`);
        for (const b of boards) {
          const active = b.id === settings.activeBoardId ? c.ok(' *') : '  ';
          const arch = b.archivedAt ? c.dim(' [archived]') : '';
          process.stdout.write(
            `${active} ${c.bold(b.name)} ${c.hint('(' + b.slug + ')')} ${c.hint('· ' + b.memberIds.length + ' member' + (b.memberIds.length === 1 ? '' : 's'))}${arch}\n`,
          );
        }
        process.stdout.write('\n');
      } finally {
        await closeContext(ctx);
      }
    });
}

// ----------------------------------------------------------------
// show
// ----------------------------------------------------------------
function registerShow(parent: Command): void {
  parent
    .command('show <board>')
    .description('show a board: description, ordered members, linked discussions')
    .action(async (token: string) => {
      const ctx = await openContext(parent, { lock: false });
      try {
        const settings = await ctx.storage.loadSettings();
        const boards = await ctx.storage.loadBoards();
        const board = requireBoard(boards, token);
        const members = await ctx.storage.loadBoardMembers();
        const byId = new Map(members.map((m) => [m.id, m]));
        const discussions = await ctx.storage.loadDiscussions();
        const linkedCount = discussions.filter((d) => d.boardId === board.id).length;
        const activeMemberCount = board.memberIds
          .map((id) => byId.get(id))
          .filter((m): m is AdvisoryBoardMember => !!m && m.isActive).length;

        if (ctx.json) {
          process.stdout.write(
            JSON.stringify({ board, linkedDiscussions: linkedCount, active: board.id === settings.activeBoardId }, null, 2) + '\n',
          );
          return;
        }

        process.stdout.write(`\n${c.bold(board.name)} ${c.hint('(' + board.slug + ')')}${board.id === settings.activeBoardId ? c.ok(' · active') : ''}\n`);
        process.stdout.write(`  ${c.hint('id:')} ${board.id}\n`);
        if (board.description) process.stdout.write(`  ${c.hint('description:')} ${board.description}\n`);
        process.stdout.write(`  ${c.hint('linked discussions:')} ${linkedCount}\n`);
        process.stdout.write(`\n${c.bold('Members')} ${c.hint('(in response order)')}\n`);
        for (const id of board.memberIds) {
          const m = byId.get(id);
          if (!m) {
            process.stdout.write(`  ${c.warn('?')} ${c.hint('(deleted member ' + id.slice(0, 8) + ')')}\n`);
            continue;
          }
          const status = m.isActive ? c.ok('active') : c.hint('inactive');
          process.stdout.write(`  ${memberColor(m.name)('●')} ${m.name} ${c.hint('· ' + m.title)} ${status}\n`);
        }
        if (activeMemberCount > settings.maxMembersPerDiscussion) {
          process.stdout.write(
            c.warn(
              `\n  ! This board has ${activeMemberCount} active members; max per discussion is ${settings.maxMembersPerDiscussion}.\n` +
                `    Convening it will be blocked — narrow with --members or raise settings.maxMembersPerDiscussion.\n`,
            ),
          );
        }
        process.stdout.write('\n');
      } finally {
        await closeContext(ctx);
      }
    });
}

// ----------------------------------------------------------------
// create
// ----------------------------------------------------------------
function registerCreate(parent: Command): void {
  parent
    .command('create <name>')
    .description('create a board (interactive member multi-select if --members omitted on a TTY)')
    .option('--description <text>', 'optional description (≤ 500 chars)')
    .option('--members <list>', 'comma-separated members (names/slugs/ids)')
    .option('--activate', 'set the new board active after creating it')
    .action(async (name: string, opts: { description?: string; members?: string; activate?: boolean }) => {
      const ctx = await openContext(parent);
      try {
        const allMembers = await ctx.storage.loadBoardMembers();
        const boards = await ctx.storage.loadBoards();
        const memberIds = await pickBoardMembers(allMembers, opts.members, []);

        const errors = validateBoardFields(
          { name, description: opts.description, memberIds },
          { existingBoards: boards, members: allMembers },
        );
        if (errors.length > 0) throw new UserError(`Cannot create board: ${errors.join('; ')}`);

        const slug = ensureUniqueBoardSlug(boardSlug(name), boards.map((b) => b.slug));
        const now = nowIso();
        const board: Board = {
          id: generateUUID(),
          name: name.trim(),
          slug,
          description: opts.description?.trim() || undefined,
          memberIds,
          createdAt: now,
          updatedAt: now,
        };
        await ctx.storage.saveBoard(board);

        if (opts.activate) {
          const settings = await ctx.storage.loadSettings();
          await ctx.storage.saveSettings(withActiveBoard(settings, board.id));
        }

        if (ctx.json) {
          process.stdout.write(JSON.stringify({ board, activated: !!opts.activate }, null, 2) + '\n');
          return;
        }
        process.stdout.write(
          `${c.ok('✓')} Created board ${c.bold(board.name)} ${c.hint('(' + board.slug + ', ' + memberIds.length + ' members)')}${opts.activate ? c.ok(' · active') : ''}\n`,
        );
      } finally {
        await closeContext(ctx);
      }
    });
}

// ----------------------------------------------------------------
// edit (name / description)
// ----------------------------------------------------------------
function registerEdit(parent: Command): void {
  parent
    .command('edit <board>')
    .description('edit a board name/description')
    .option('--name <name>')
    .option('--description <text>')
    .action(async (token: string, opts: { name?: string; description?: string }) => {
      const ctx = await openContext(parent);
      try {
        const boards = await ctx.storage.loadBoards();
        const board = requireBoard(boards, token);
        const allMembers = await ctx.storage.loadBoardMembers();

        const nextName = opts.name?.trim() ?? board.name;
        const nextDescription = opts.description !== undefined ? opts.description.trim() : board.description;
        const errors = validateBoardFields(
          { name: nextName, description: nextDescription, memberIds: board.memberIds },
          { existingBoards: boards, members: allMembers, excludeBoardId: board.id },
        );
        if (errors.length > 0) throw new UserError(`Cannot edit board: ${errors.join('; ')}`);

        let next: Board = { ...board, name: nextName, description: nextDescription || undefined };
        if (opts.name && boardSlug(nextName) !== board.slug) {
          next.slug = ensureUniqueBoardSlug(boardSlug(nextName), boards.filter((b) => b.id !== board.id).map((b) => b.slug));
        }
        await ctx.storage.updateBoard(next);
        emitBoardSaved(ctx.json, next, 'updated');
      } finally {
        await closeContext(ctx);
      }
    });
}

// ----------------------------------------------------------------
// add-member / remove-member / set-members
// ----------------------------------------------------------------
function registerAddMember(parent: Command): void {
  parent
    .command('add-member <board> <member>')
    .description('append a member to a board roster')
    .action(async (token: string, memberToken: string) => {
      const ctx = await openContext(parent);
      try {
        const boards = await ctx.storage.loadBoards();
        const board = requireBoard(boards, token);
        const allMembers = await ctx.storage.loadBoardMembers();
        const member = requireMember(allMembers, memberToken);
        if (board.memberIds.includes(member.id)) {
          throw new UserError(`${member.name} is already in board "${board.name}".`);
        }
        const next: Board = { ...board, memberIds: [...board.memberIds, member.id] };
        await ctx.storage.updateBoard(next);
        emitBoardSaved(ctx.json, next, 'updated', `added ${member.name}`);
      } finally {
        await closeContext(ctx);
      }
    });
}

function registerRemoveMember(parent: Command): void {
  parent
    .command('remove-member <board> <member>')
    .description('remove a member from a board roster')
    .action(async (token: string, memberToken: string) => {
      const ctx = await openContext(parent);
      try {
        const boards = await ctx.storage.loadBoards();
        const board = requireBoard(boards, token);
        const allMembers = await ctx.storage.loadBoardMembers();
        const member = requireMember(allMembers, memberToken);
        if (!board.memberIds.includes(member.id)) {
          throw new UserError(`${member.name} is not in board "${board.name}".`);
        }
        const next: Board = { ...board, memberIds: board.memberIds.filter((id) => id !== member.id) };
        await ctx.storage.updateBoard(next);
        if (!ctx.json && next.memberIds.length === 0) {
          process.stdout.write(c.warn(`  ! Board "${board.name}" is now empty — add members or delete it.\n`));
        }
        emitBoardSaved(ctx.json, next, 'updated', `removed ${member.name}`);
      } finally {
        await closeContext(ctx);
      }
    });
}

function registerSetMembers(parent: Command): void {
  parent
    .command('set-members <board> [members]')
    .description('replace a board roster wholesale (ordered comma list, or interactive)')
    .action(async (token: string, members: string | undefined) => {
      const ctx = await openContext(parent);
      try {
        const boards = await ctx.storage.loadBoards();
        const board = requireBoard(boards, token);
        const allMembers = await ctx.storage.loadBoardMembers();
        const memberIds = await pickBoardMembers(allMembers, members, board.memberIds);
        const errors = validateBoardFields(
          { name: board.name, description: board.description, memberIds },
          { existingBoards: boards, members: allMembers, excludeBoardId: board.id },
        );
        if (errors.length > 0) throw new UserError(`Cannot set members: ${errors.join('; ')}`);
        const next: Board = { ...board, memberIds };
        await ctx.storage.updateBoard(next);
        emitBoardSaved(ctx.json, next, 'updated', `${memberIds.length} members`);
      } finally {
        await closeContext(ctx);
      }
    });
}

// ----------------------------------------------------------------
// rename
// ----------------------------------------------------------------
function registerRename(parent: Command): void {
  parent
    .command('rename <board> <newName>')
    .description('rename a board (regenerates the slug)')
    .action(async (token: string, newName: string) => {
      const ctx = await openContext(parent);
      try {
        const boards = await ctx.storage.loadBoards();
        const board = requireBoard(boards, token);
        const allMembers = await ctx.storage.loadBoardMembers();
        const errors = validateBoardFields(
          { name: newName, description: board.description, memberIds: board.memberIds },
          { existingBoards: boards, members: allMembers, excludeBoardId: board.id },
        );
        if (errors.length > 0) throw new UserError(`Cannot rename board: ${errors.join('; ')}`);
        const slug = ensureUniqueBoardSlug(boardSlug(newName), boards.filter((b) => b.id !== board.id).map((b) => b.slug));
        const next: Board = { ...board, name: newName.trim(), slug };
        await ctx.storage.updateBoard(next);
        emitBoardSaved(ctx.json, next, 'renamed');
      } finally {
        await closeContext(ctx);
      }
    });
}

// ----------------------------------------------------------------
// delete
// ----------------------------------------------------------------
function registerDelete(parent: Command): void {
  parent
    .command('delete <board>')
    .description('delete a board (does NOT delete members)')
    .option('--yes', 'skip confirmation')
    .action(async (token: string, opts: { yes?: boolean }) => {
      const ctx = await openContext(parent);
      try {
        const boards = await ctx.storage.loadBoards();
        const board = requireBoard(boards, token);
        await ctx.storage.deleteBoard(board.id);
        // Clear the active pointer if it referenced this board.
        const settings = await ctx.storage.loadSettings();
        if (settings.activeBoardId === board.id) {
          await ctx.storage.saveSettings(withActiveBoard(settings, undefined));
        }
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ deleted: { id: board.id, name: board.name } }, null, 2) + '\n');
          return;
        }
        process.stdout.write(`${c.ok('✓')} Deleted board ${board.name} ${c.hint('(members untouched)')}\n`);
      } finally {
        await closeContext(ctx);
      }
    });
}

// ----------------------------------------------------------------
// use  (set active; `-` toggles to previous)
// ----------------------------------------------------------------
function registerUse(parent: Command): void {
  parent
    .command('use <board>')
    .description('set the active board; pass `-` to toggle back to the previous one')
    .action(async (token: string) => {
      const ctx = await openContext(parent);
      try {
        const settings = await ctx.storage.loadSettings();
        const boards = await ctx.storage.loadBoards();
        const prev = (settings as unknown as Record<string, unknown>)[ACTIVE_PREV_KEY] as string | undefined;

        let nextActiveId: string | undefined;
        let label: string;
        if (token === '-') {
          if (!prev) throw new UserError('No previous board to switch back to.');
          const board = boards.find((b) => b.id === prev);
          if (!board) throw new UserError('The previous board no longer exists.');
          nextActiveId = board.id;
          label = `${board.name} (${board.slug})`;
        } else {
          const board = requireBoard(boards, token);
          nextActiveId = board.id;
          label = `${board.name} (${board.slug})`;
        }

        await ctx.storage.saveSettings(withActiveBoard(settings, nextActiveId));

        if (ctx.json) {
          process.stdout.write(JSON.stringify({ activeBoardId: nextActiveId }, null, 2) + '\n');
          return;
        }
        process.stdout.write(`${c.ok('✓')} Active board → ${c.bold(label)}\n`);
      } finally {
        await closeContext(ctx);
      }
    });
}

// ----------------------------------------------------------------
// current
// ----------------------------------------------------------------
function registerCurrent(parent: Command): void {
  parent
    .command('current')
    .description('print the active board (or "All active members")')
    .action(async () => {
      const ctx = await openContext(parent, { lock: false });
      try {
        const settings = await ctx.storage.loadSettings();
        const boards = await ctx.storage.loadBoards();
        const board = settings.activeBoardId ? boards.find((b) => b.id === settings.activeBoardId) : undefined;
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ active: board ?? null }, null, 2) + '\n');
          return;
        }
        if (!board) {
          process.stdout.write(`${c.hint('—')} active board: ${c.bold('All active members')} ${c.hint('(default)')}\n`);
          return;
        }
        process.stdout.write(`${c.ok('●')} active board: ${c.bold(board.name)} ${c.hint('(' + board.slug + ', ' + board.memberIds.length + ' members)')}\n`);
      } finally {
        await closeContext(ctx);
      }
    });
}

// ----------------------------------------------------------------
// helpers
// ----------------------------------------------------------------
function requireBoard(boards: Board[], token: string): Board {
  const board = resolveBoardToken(boards, token);
  if (!board) {
    throw new UserError(
      `No board matched "${token}".`,
      boards.length > 0 ? `Boards: ${boards.map((b) => b.slug).join(', ')}` : 'Create one with `aab board create`.',
    );
  }
  return board;
}

function requireMember(members: AdvisoryBoardMember[], token: string): AdvisoryBoardMember {
  const m = resolveMemberToken(members, token);
  if (!m) {
    throw new UserError(
      `No member matched "${token}".`,
      `Members: ${members.map((x) => x.name).join(', ') || '(none)'}`,
    );
  }
  return m;
}

/**
 * Resolve a comma list (or run an interactive multi-select on a TTY) into an
 * ordered, deduped member-id list. `preselected` pre-checks the boxes on edit.
 */
async function pickBoardMembers(
  allMembers: AdvisoryBoardMember[],
  membersArg: string | undefined,
  preselected: string[],
): Promise<string[]> {
  if (membersArg !== undefined) {
    const tokens = membersArg.split(',').map((t) => t.trim()).filter(Boolean);
    const out: string[] = [];
    const unmatched: string[] = [];
    for (const tok of tokens) {
      const m = resolveMemberToken(allMembers, tok);
      if (m) {
        if (!out.includes(m.id)) out.push(m.id);
      } else unmatched.push(tok);
    }
    if (unmatched.length > 0) {
      throw new UserError(
        `No member matched: ${unmatched.join(', ')}`,
        `Members: ${allMembers.map((m) => m.name).join(', ') || '(none)'}`,
      );
    }
    return out;
  }

  if (!process.stdin.isTTY) {
    throw new UserError('Pass --members a,b,c (non-interactive shell has no member picker).');
  }
  const pre = new Set(preselected);
  const choices = allMembers.map((m) => ({
    name: m.id,
    message: `${m.name} ${m.isActive ? '' : '(inactive)'}`.trim(),
    selected: pre.has(m.id),
  }));
  const picked = await askMultiSelect<string>('Members for this board', choices);
  if (picked.length === 0) throw new UserError('Pick at least one member.');
  return picked;
}

function emitBoardSaved(json: boolean, board: Board, verb: string, detail?: string): void {
  if (json) {
    process.stdout.write(JSON.stringify({ board }, null, 2) + '\n');
    return;
  }
  process.stdout.write(
    `${c.ok('✓')} Board ${verb}: ${c.bold(board.name)} ${c.hint('(' + board.slug + ')')}${detail ? c.hint(' · ' + detail) : ''}\n`,
  );
}
