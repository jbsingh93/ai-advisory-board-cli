/**
 * `aab actions` — Phase 4 Action Board (kanban) surface.
 *
 *   aab actions add "<title>" [--description] [--priority] [--due]
 *   aab actions list                    [--status pending|in-progress|completed] [--priority high|medium|low]
 *   aab actions board                   3-column ANSI Kanban
 *   aab actions show <id>               full detail
 *   aab actions edit <id>               interactive
 *   aab actions move <id> <status>      pending | in-progress | completed
 *   aab actions delete <id> [--yes]
 *   aab actions extract <discussion-id> [--auto] [--max N] [--accept-all]
 *
 * Per Part 6 of PLAN.md: kanban tracking + skill-only solve. No multi-agent
 * pipeline. `aab actions solve` lives in Phase 5.
 */
import { Command } from 'commander';
import { closeContext, openContext } from './_context.js';
import { c } from '../ui/colors.js';
import { askConfirm, askSelect, askText } from '../ui/prompts.js';
import { spinner } from '../ui/spinner.js';
import { generateUUID, nowIso } from '../core/utils.js';
import { UserError } from '../core/errors.js';
import { shortId } from '../ui/render-discussion.js';
import {
  extractActionItems,
  toActionItem,
  type ExtractedActionItem,
} from '../core/actions/conversation-analyzer.js';
import type { ActionItem, Discussion, StorageService } from '../storage/types.js';

const PRIORITIES = ['low', 'medium', 'high'] as const;
type Priority = (typeof PRIORITIES)[number];

const STATUSES = ['pending', 'in-progress', 'completed'] as const;
type Status = (typeof STATUSES)[number];

export function registerActionsCommand(program: Command): void {
  const a = program.command('actions').description('manage action items on the kanban board');

  // --------------------------------------------------------------
  // add
  // --------------------------------------------------------------
  a.command('add [title]')
    .description('add a new action item (interactive if title omitted)')
    .option('--description <text>', 'long-form description')
    .option('--priority <p>', 'low | medium | high (default medium)')
    .option('--due <yyyy-mm-dd>', 'due date')
    .option('--assignee <name>', 'who owns this')
    .option('--discussion <id>', 'link to an existing discussion id or short id')
    .action(
      async (
        title: string | undefined,
        opts: {
          description?: string;
          priority?: string;
          due?: string;
          assignee?: string;
          discussion?: string;
        },
      ) => {
        const ctx = await openContext(a);
        try {
          // If a positional title is given, treat as non-interactive: leave
          // optional fields blank unless their flags were passed. Otherwise
          // run a full interactive wizard.
          const interactive = !title;
          const finalTitle = (title ?? (await askText('Title', { required: true }))).trim();
          if (!finalTitle) throw new UserError('Title cannot be empty.');
          const description =
            opts.description ?? (interactive ? await askText('Description (optional)', { initial: '' }) : '');
          const priority = normalizePriority(
            opts.priority ??
              (interactive
                ? await askSelect<Priority>(
                    'Priority',
                    PRIORITIES.map((p) => ({ name: p, message: p })),
                    { initial: 'medium' },
                  )
                : 'medium'),
          );
          const dueDate = opts.due ?? '';
          const assignee = opts.assignee ?? '';
          let discussionId: string | undefined;
          if (opts.discussion) {
            const linked = await resolveDiscussion(ctx.storage, opts.discussion);
            discussionId = linked.id;
          }
          const now = nowIso();
          const item: ActionItem = {
            id: generateUUID(),
            discussionId,
            title: finalTitle,
            description: description || '',
            priority,
            status: 'pending',
            assignedTo: assignee || undefined,
            dueDate: dueDate || undefined,
            createdAt: now,
            updatedAt: now,
          };
          await ctx.storage.saveActionItem(item);
          if (ctx.json) {
            process.stdout.write(JSON.stringify({ action: item }, null, 2) + '\n');
            return;
          }
          process.stdout.write(
            `${c.ok('✓')} added action ${c.bold(item.title)} ${c.hint(`(${shortActionId(item.id)} · ${item.priority})`)}\n`,
          );
        } finally {
          await closeContext(ctx);
        }
      },
    );

  // --------------------------------------------------------------
  // list
  // --------------------------------------------------------------
  a.command('list')
    .description('flat list of action items (optionally filtered)')
    .option('--status <s>', 'pending | in-progress | completed')
    .option('--priority <p>', 'low | medium | high')
    .option('--discussion <id>', 'only items linked to this discussion')
    .action(
      async (opts: { status?: string; priority?: string; discussion?: string }) => {
        const ctx = await openContext(a, { lock: false });
        try {
          let items = await ctx.storage.loadActionItems();
          if (opts.status) items = items.filter((i) => i.status === normalizeStatus(opts.status!));
          if (opts.priority)
            items = items.filter((i) => i.priority === normalizePriority(opts.priority!));
          if (opts.discussion) {
            const d = await resolveDiscussion(ctx.storage, opts.discussion);
            items = items.filter((i) => i.discussionId === d.id);
          }
          items.sort(itemSortKey);
          if (ctx.json) {
            process.stdout.write(JSON.stringify({ actions: items }, null, 2) + '\n');
            return;
          }
          if (items.length === 0) {
            process.stdout.write(c.hint('  (no action items match)\n'));
            return;
          }
          for (const item of items) {
            process.stdout.write(renderListRow(item) + '\n');
          }
        } finally {
          await closeContext(ctx);
        }
      },
    );

  // --------------------------------------------------------------
  // board (ANSI kanban)
  // --------------------------------------------------------------
  a.command('board')
    .description('3-column ANSI kanban view')
    .option('--filter <q>', 'case-insensitive substring filter over title/description')
    .action(async (opts: { filter?: string }) => {
      const ctx = await openContext(a, { lock: false });
      try {
        let items = await ctx.storage.loadActionItems();
        if (opts.filter) {
          const q = opts.filter.toLowerCase();
          items = items.filter(
            (i) =>
              i.title.toLowerCase().includes(q) ||
              (i.description ?? '').toLowerCase().includes(q),
          );
        }
        if (ctx.json) {
          process.stdout.write(
            JSON.stringify(
              {
                pending: items.filter((i) => i.status === 'pending'),
                inProgress: items.filter((i) => i.status === 'in-progress'),
                completed: items.filter((i) => i.status === 'completed'),
              },
              null,
              2,
            ) + '\n',
          );
          return;
        }
        renderKanban(items);
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // show
  // --------------------------------------------------------------
  a.command('show <id>')
    .description('full detail for one action item')
    .action(async (id: string) => {
      const ctx = await openContext(a, { lock: false });
      try {
        const item = await resolveActionItem(ctx.storage, id);
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ action: item }, null, 2) + '\n');
          return;
        }
        renderActionDetail(item);
        if (item.discussionId) {
          const d = await ctx.storage.loadDiscussionById(item.discussionId);
          if (d)
            process.stdout.write(
              c.hint(`  linked discussion: ${shortId(d.id)} — "${ellipsis(d.question, 70)}"\n`),
            );
        }
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // edit
  // --------------------------------------------------------------
  a.command('edit <id>')
    .description('interactively edit an action item')
    .option('--title <text>')
    .option('--description <text>')
    .option('--priority <p>')
    .option('--status <s>')
    .option('--due <yyyy-mm-dd>')
    .option('--assignee <name>')
    .action(
      async (
        id: string,
        opts: {
          title?: string;
          description?: string;
          priority?: string;
          status?: string;
          due?: string;
          assignee?: string;
        },
      ) => {
        const ctx = await openContext(a);
        try {
          const item = await resolveActionItem(ctx.storage, id);
          const flagsTouched =
            !!opts.title ||
            !!opts.description ||
            !!opts.priority ||
            !!opts.status ||
            !!opts.due ||
            !!opts.assignee;

          const next: ActionItem = { ...item };
          if (opts.title) next.title = opts.title;
          if (opts.description !== undefined) next.description = opts.description;
          if (opts.priority) next.priority = normalizePriority(opts.priority);
          if (opts.status) next.status = normalizeStatus(opts.status);
          if (opts.due !== undefined) next.dueDate = opts.due || undefined;
          if (opts.assignee !== undefined) next.assignedTo = opts.assignee || undefined;

          if (!flagsTouched) {
            next.title = await askText('Title', { initial: next.title, required: true });
            next.description = await askText('Description', { initial: next.description ?? '' });
            next.priority = normalizePriority(
              await askSelect<Priority>(
                'Priority',
                PRIORITIES.map((p) => ({ name: p, message: p })),
                { initial: next.priority },
              ),
            );
            next.status = normalizeStatus(
              await askSelect<Status>(
                'Status',
                STATUSES.map((s) => ({ name: s, message: s })),
                { initial: next.status },
              ),
            );
            const due = await askText('Due date (YYYY-MM-DD, optional)', {
              initial: next.dueDate ?? '',
            });
            next.dueDate = due || undefined;
            const assignee = await askText('Assignee (optional)', {
              initial: next.assignedTo ?? '',
            });
            next.assignedTo = assignee || undefined;
          }

          next.updatedAt = nowIso();
          await ctx.storage.updateActionItem(next);
          if (ctx.json) {
            process.stdout.write(JSON.stringify({ action: next }, null, 2) + '\n');
            return;
          }
          process.stdout.write(`${c.ok('✓')} updated ${c.bold(next.title)}\n`);
        } finally {
          await closeContext(ctx);
        }
      },
    );

  // --------------------------------------------------------------
  // move
  // --------------------------------------------------------------
  a.command('move <id> <status>')
    .description('move an action to a new column: pending | in-progress | completed')
    .action(async (id: string, statusRaw: string) => {
      const ctx = await openContext(a);
      try {
        const item = await resolveActionItem(ctx.storage, id);
        const status = normalizeStatus(statusRaw);
        const prev = item.status;
        if (prev === status) {
          if (ctx.json) {
            process.stdout.write(JSON.stringify({ action: item, changed: false }, null, 2) + '\n');
            return;
          }
          process.stdout.write(c.hint(`  ${shortActionId(item.id)} already ${status}.\n`));
          return;
        }
        const next: ActionItem = { ...item, status, updatedAt: nowIso() };
        await ctx.storage.updateActionItem(next);
        if (ctx.json) {
          process.stdout.write(
            JSON.stringify({ action: next, changed: true, from: prev, to: status }, null, 2) + '\n',
          );
          return;
        }
        process.stdout.write(
          `${c.ok('✓')} ${c.bold(item.title)}: ${c.hint(prev)} → ${c.cyan(status)}\n`,
        );
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // delete
  // --------------------------------------------------------------
  a.command('delete <id>')
    .description('delete an action item')
    .option('--yes', 'skip confirmation prompt')
    .action(async (id: string, opts: { yes?: boolean }) => {
      const ctx = await openContext(a);
      try {
        const item = await resolveActionItem(ctx.storage, id);
        if (!opts.yes) {
          const ok = await askConfirm(`Delete action "${item.title}"?`, false);
          if (!ok) {
            process.stdout.write(c.hint('  aborted.\n'));
            return;
          }
        }
        await ctx.storage.deleteActionItem(item.id);
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ deleted: item.id }, null, 2) + '\n');
          return;
        }
        process.stdout.write(`${c.ok('✓')} deleted ${item.title}\n`);
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // extract
  // --------------------------------------------------------------
  a.command('extract <discussionIdOrShort>')
    .description('auto-extract action items from a concluded discussion')
    .option('--accept-all', 'persist every candidate without confirmation')
    .option('--max <n>', 'cap candidates accepted (top N by confidence)')
    .option('--dry-run', 'print candidates only — do not persist')
    .action(
      async (
        discussionIdOrShort: string,
        opts: { acceptAll?: boolean; max?: string; dryRun?: boolean },
      ) => {
        const ctx = await openContext(a);
        try {
          const discussion = await resolveDiscussion(ctx.storage, discussionIdOrShort);
          const settings = await ctx.storage.loadSettings();

          const sp = spinner('Extracting action items…');
          sp.start();
          let analysis;
          try {
            analysis = await extractActionItems({ discussion, settings });
            sp.succeed(
              `Extracted ${analysis.actionItems.length} candidate${analysis.actionItems.length === 1 ? '' : 's'} ` +
                `via ${analysis.method} path (confidence ${analysis.analysisConfidence}/100)`,
            );
          } catch (err) {
            sp.fail('extract failed');
            throw err;
          }

          let candidates = [...analysis.actionItems].sort((a, b) => b.confidence - a.confidence);
          if (opts.max) {
            const n = Number.parseInt(opts.max, 10);
            if (Number.isFinite(n) && n > 0) candidates = candidates.slice(0, n);
          }

          if (ctx.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  discussionId: discussion.id,
                  method: analysis.method,
                  candidates,
                  keyInsights: analysis.keyInsights,
                  recommendedNextSteps: analysis.recommendedNextSteps,
                  analysisConfidence: analysis.analysisConfidence,
                },
                null,
                2,
              ) + '\n',
            );
            return;
          }

          if (candidates.length === 0) {
            process.stdout.write(c.hint('  (no candidates)\n'));
            return;
          }

          for (const cand of candidates) {
            process.stdout.write(renderCandidate(cand) + '\n');
          }

          if (opts.dryRun) {
            process.stdout.write(c.hint('  --dry-run: nothing persisted.\n'));
            return;
          }

          const accepted: ActionItem[] = [];
          for (const cand of candidates) {
            const accept = opts.acceptAll
              ? true
              : await askConfirm(
                  `Accept "${cand.title}" (${cand.priority}, ${cand.category}, conf ${cand.confidence})?`,
                  true,
                );
            if (!accept) continue;
            const item = toActionItem(cand, discussion.id);
            await ctx.storage.saveActionItem(item);
            accepted.push(item);
          }
          process.stdout.write(
            `${c.ok('✓')} added ${accepted.length} action item${accepted.length === 1 ? '' : 's'} from ${shortId(discussion.id)}\n`,
          );
        } finally {
          await closeContext(ctx);
        }
      },
    );
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

export function shortActionId(id: string): string {
  return id.slice(0, 8);
}

export async function resolveActionItem(
  storage: StorageService,
  idOrShort: string,
): Promise<ActionItem> {
  const all = await storage.loadActionItems();
  const direct = all.find((i) => i.id === idOrShort);
  if (direct) return direct;
  const matches = all.filter((i) => i.id.startsWith(idOrShort));
  if (matches.length === 0)
    throw new UserError(`No action item found with id starting "${idOrShort}".`);
  if (matches.length > 1)
    throw new UserError(`Multiple action items match "${idOrShort}". Use a longer prefix.`);
  return matches[0]!;
}

async function resolveDiscussion(
  storage: StorageService,
  idOrShort: string,
): Promise<Discussion> {
  const direct = await storage.loadDiscussionById(idOrShort);
  if (direct) return direct;
  const all = await storage.loadDiscussions();
  const matches = all.filter((d) => d.id.startsWith(idOrShort));
  if (matches.length === 0)
    throw new UserError(`No discussion found with id starting "${idOrShort}".`);
  if (matches.length > 1)
    throw new UserError(`Multiple discussions match "${idOrShort}". Use a longer prefix.`);
  return matches[0]!;
}

export function normalizePriority(input: string): Priority {
  const v = input.trim().toLowerCase() as Priority;
  if (!(PRIORITIES as readonly string[]).includes(v))
    throw new UserError(`Unknown priority "${input}". Pick: ${PRIORITIES.join(' | ')}`);
  return v;
}

export function normalizeStatus(input: string): Status {
  const raw = input.trim().toLowerCase();
  const aliases: Record<string, Status> = {
    'in-progress': 'in-progress',
    inprogress: 'in-progress',
    'in_progress': 'in-progress',
    doing: 'in-progress',
    pending: 'pending',
    todo: 'pending',
    completed: 'completed',
    done: 'completed',
  };
  const v = aliases[raw];
  if (!v) throw new UserError(`Unknown status "${input}". Pick: ${STATUSES.join(' | ')}`);
  return v;
}

const STATUS_ORDER: Record<Status, number> = {
  'in-progress': 0,
  pending: 1,
  completed: 2,
};
const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

function itemSortKey(a: ActionItem, b: ActionItem): number {
  const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (s !== 0) return s;
  const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  if (p !== 0) return p;
  return (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999');
}

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------

function priorityBadge(p: Priority): string {
  if (p === 'high') return c.err('●');
  if (p === 'medium') return c.warn('●');
  return c.hint('●');
}

function statusBadge(s: Status): string {
  if (s === 'completed') return c.ok('✓');
  if (s === 'in-progress') return c.cyan('→');
  return c.hint('○');
}

function renderListRow(item: ActionItem): string {
  const parts = [
    `  ${priorityBadge(item.priority)} ${statusBadge(item.status)}`,
    c.bold(item.title),
    c.hint(`(${shortActionId(item.id)})`),
  ];
  if (item.dueDate) parts.push(c.hint(`· due ${item.dueDate}`));
  if (item.assignedTo) parts.push(c.hint(`· ${item.assignedTo}`));
  if (item.linkedSkill) parts.push(c.cyan(`· skill ${item.linkedSkill.name}`));
  return parts.join(' ');
}

function renderActionDetail(item: ActionItem): void {
  const out = process.stdout;
  out.write(`\n${c.bold(item.title)}  ${c.hint(`(${shortActionId(item.id)})`)}\n`);
  out.write(
    `  ${statusBadge(item.status)} ${item.status}  ${priorityBadge(item.priority)} ${item.priority}`,
  );
  if (item.dueDate) out.write(c.hint(`  · due ${item.dueDate}`));
  if (item.assignedTo) out.write(c.hint(`  · ${item.assignedTo}`));
  out.write('\n');
  if (item.description) out.write(`\n  ${item.description}\n`);
  if (item.linkedSkill) {
    out.write(`\n  ${c.cyan('skill:')} ${item.linkedSkill.name} ${c.hint(`(${item.linkedSkill.installPath})`)}\n`);
  }
  out.write(c.hint(`\n  created ${item.createdAt.slice(0, 19)}  · updated ${item.updatedAt.slice(0, 19)}\n`));
}

function renderCandidate(it: ExtractedActionItem): string {
  const lines: string[] = [];
  lines.push(`  ${priorityBadge(it.priority)} ${c.bold(it.title)} ${c.hint(`· ${it.category} · conf ${it.confidence}`)}`);
  if (it.description) lines.push(`    ${c.hint(it.description)}`);
  if (it.sourceContext) lines.push(`    ${c.hint('from: ' + it.sourceContext)}`);
  if (it.suggestedAssignee) lines.push(`    ${c.hint('assignee: ' + it.suggestedAssignee)}`);
  if (it.suggestedDueDate) lines.push(`    ${c.hint('due: ' + it.suggestedDueDate)}`);
  return lines.join('\n');
}

function renderKanban(items: ActionItem[]): void {
  const cols: Record<Status, ActionItem[]> = {
    pending: items.filter((i) => i.status === 'pending').sort(itemSortKey),
    'in-progress': items.filter((i) => i.status === 'in-progress').sort(itemSortKey),
    completed: items.filter((i) => i.status === 'completed').sort(itemSortKey),
  };
  const COL_W = 36;
  const header =
    `┌${'─'.repeat(COL_W)}┬${'─'.repeat(COL_W)}┬${'─'.repeat(COL_W)}┐\n` +
    `│ ${pad(c.bold(`PENDING (${cols.pending.length})`), COL_W - 1)}│ ${pad(c.bold(`IN-PROGRESS (${cols['in-progress'].length})`), COL_W - 1)}│ ${pad(c.bold(`COMPLETED (${cols.completed.length})`), COL_W - 1)}│\n` +
    `├${'─'.repeat(COL_W)}┼${'─'.repeat(COL_W)}┼${'─'.repeat(COL_W)}┤`;
  process.stdout.write('\n' + header + '\n');

  const rows = Math.max(cols.pending.length, cols['in-progress'].length, cols.completed.length);
  if (rows === 0) {
    const empty = `│ ${pad(c.hint('(empty)'), COL_W - 1)}│ ${pad(c.hint('(empty)'), COL_W - 1)}│ ${pad(c.hint('(empty)'), COL_W - 1)}│`;
    process.stdout.write(empty + '\n');
  }
  for (let r = 0; r < rows; r++) {
    const cellLines: string[][] = (['pending', 'in-progress', 'completed'] as Status[]).map((s) => {
      const item = cols[s][r];
      if (!item) return [pad('', COL_W - 1)];
      return formatKanbanCard(item, COL_W - 1);
    });
    const maxLines = Math.max(...cellLines.map((l) => l.length));
    for (let line = 0; line < maxLines; line++) {
      const left = cellLines[0]![line] ?? pad('', COL_W - 1);
      const mid = cellLines[1]![line] ?? pad('', COL_W - 1);
      const right = cellLines[2]![line] ?? pad('', COL_W - 1);
      process.stdout.write(`│ ${left}│ ${mid}│ ${right}│\n`);
    }
  }
  process.stdout.write(`└${'─'.repeat(COL_W)}┴${'─'.repeat(COL_W)}┴${'─'.repeat(COL_W)}┘\n`);
}

function formatKanbanCard(item: ActionItem, width: number): string[] {
  const titleLine = `${priorityBadge(item.priority)} ${ellipsis(item.title, width - 12)} ${c.hint('(' + shortActionId(item.id) + ')')}`;
  const metaParts: string[] = [];
  if (item.dueDate) metaParts.push('due ' + item.dueDate);
  if (item.assignedTo) metaParts.push(item.assignedTo);
  const meta = metaParts.length ? c.hint(ellipsis('  ' + metaParts.join(' · '), width)) : '';
  return [pad(titleLine, width), pad(meta, width)];
}

// chalk wraps strings with escape codes; we still pad based on visible width.
function pad(s: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = s.replace(/\x1B\[[0-9;]*m/g, '');
  const fill = Math.max(0, width - visible.length);
  return s + ' '.repeat(fill);
}

function ellipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}
