/**
 * `aab principles` — Phase 2 principles surface.
 *
 *   aab principles list                              flat or --json; filters
 *   aab principles add                               interactive (title/desc/cat/priority/behavior/anti)
 *   aab principles edit <id|name>                    field-by-field interactive
 *   aab principles delete <id|name>                  with confirmation
 *   aab principles seed-starters                     re-seed 8 starters (no-op if any exist unless --force)
 *   aab principles explore [--principle <id|name>]   5-step Socratic wizard (behavior → anti → triggers → examples → priority)
 */
import { Command } from 'commander';
import { closeContext, openContext } from './_context.js';
import { c } from '../ui/colors.js';
import { askConfirm, askSelect, askText } from '../ui/prompts.js';
import { spinner } from '../ui/spinner.js';
import { generateUUID, nowIso } from '../core/utils.js';
import { UserError } from '../core/errors.js';
import { STARTER_PRINCIPLES } from '../starter/starter-principles.js';
import {
  EXPLORER_STEPS,
  applyStep,
  explorerReply,
  type ExplorerStep,
  type ExplorerTurn,
} from '../core/coach/principle-explorer.js';
import type { Principle, PrincipleCategory } from '../storage/types.js';

const CATEGORIES: PrincipleCategory[] = ['life', 'work', 'relationships', 'health', 'finance', 'meta'];

export function registerPrinciplesCommand(program: Command): void {
  const p = program.command('principles').description('manage decision-making principles');

  // --------------------------------------------------------------
  // list
  // --------------------------------------------------------------
  p.command('list')
    .description('list all principles')
    .option('--category <cat>', 'filter by category: ' + CATEGORIES.join(' | '))
    .option('--active', 'only active principles')
    .option('--inactive', 'only inactive principles')
    .action(async (opts: { category?: string; active?: boolean; inactive?: boolean }) => {
      const ctx = await openContext(p, { lock: false });
      try {
        let principles = await ctx.storage.loadPrinciples();
        if (opts.category) {
          if (!CATEGORIES.includes(opts.category as PrincipleCategory)) {
            throw new UserError(
              `Unknown category "${opts.category}"`,
              `Pick one of: ${CATEGORIES.join(', ')}`,
            );
          }
          principles = principles.filter((pp) => pp.category === opts.category);
        }
        if (opts.active) principles = principles.filter((pp) => pp.isActive);
        if (opts.inactive) principles = principles.filter((pp) => !pp.isActive);

        if (ctx.json) {
          process.stdout.write(JSON.stringify({ principles }, null, 2) + '\n');
          return;
        }
        if (principles.length === 0) {
          process.stdout.write(c.hint('  (no principles match — run `aab principles seed-starters` to seed defaults)\n'));
          return;
        }
        principles.sort((a, b) => b.priority - a.priority);
        for (const pp of principles) {
          const status = pp.isActive ? c.ok('active') : c.hint('inactive');
          process.stdout.write(
            `  [${c.cyan(String(pp.priority).padStart(2))}] ${c.bold(pp.title)} ` +
              c.hint(`· ${pp.category}`) +
              ` ${status}\n`,
          );
          if (pp.description) process.stdout.write(c.hint(`        ${truncate(pp.description, 110)}\n`));
        }
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // show
  // --------------------------------------------------------------
  p.command('show <idOrTitle>')
    .description('show full principle detail')
    .action(async (idOrTitle: string) => {
      const ctx = await openContext(p, { lock: false });
      try {
        const principle = await resolvePrinciple(ctx.storage.loadPrinciples(), idOrTitle);
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ principle }, null, 2) + '\n');
          return;
        }
        renderPrincipleDetail(principle);
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // add
  // --------------------------------------------------------------
  p.command('add')
    .description('add a new principle (interactive)')
    .option('--title <title>')
    .option('--description <text>')
    .option('--category <cat>')
    .option('--priority <n>')
    .option('--behavior <text>')
    .option('--anti-pattern <text>')
    .action(
      async (opts: {
        title?: string;
        description?: string;
        category?: string;
        priority?: string;
        behavior?: string;
        antiPattern?: string;
      }) => {
        const ctx = await openContext(p);
        try {
          const title = opts.title ?? (await askText('Title', { required: true }));
          const description = opts.description ?? (await askText('Description', { required: true }));
          const categoryRaw =
            opts.category ??
            (await askSelect<PrincipleCategory>(
              'Category',
              CATEGORIES.map((cat) => ({ name: cat, message: cat })),
            ));
          const category = normalizeCategory(categoryRaw);
          const priorityRaw =
            opts.priority ??
            (await askText('Priority (1-10)', { initial: '5' }));
          const priority = clampPriority(priorityRaw);
          const behavior =
            opts.behavior ??
            (await askText('Behavior (when and how to apply this)', { required: true }));
          const antiPattern =
            opts.antiPattern ?? (await askText('Anti-pattern (what violating this looks like; optional)'));

          const now = nowIso();
          const principle: Principle = {
            id: generateUUID(),
            category,
            title,
            description,
            behavior,
            antiPattern: antiPattern || undefined,
            triggerQuestions: undefined,
            priority,
            examples: undefined,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          };
          await ctx.storage.savePrinciple(principle);
          if (ctx.json) {
            process.stdout.write(JSON.stringify({ principle }, null, 2) + '\n');
            return;
          }
          process.stdout.write(`${c.ok('✓')} Added principle ${c.bold(title)} (id ${principle.id.slice(0, 8)})\n`);
        } finally {
          await closeContext(ctx);
        }
      },
    );

  // --------------------------------------------------------------
  // edit
  // --------------------------------------------------------------
  p.command('edit <idOrTitle>')
    .description('interactively edit a principle')
    .option('--active <bool>')
    .option('--title <title>')
    .option('--description <text>')
    .option('--category <cat>')
    .option('--priority <n>')
    .option('--behavior <text>')
    .option('--anti-pattern <text>')
    .action(
      async (
        idOrTitle: string,
        opts: {
          active?: string;
          title?: string;
          description?: string;
          category?: string;
          priority?: string;
          behavior?: string;
          antiPattern?: string;
        },
      ) => {
        const ctx = await openContext(p);
        try {
          const principle = await resolvePrinciple(ctx.storage.loadPrinciples(), idOrTitle);
          const flagsTouched =
            !!opts.title ||
            !!opts.description ||
            !!opts.category ||
            !!opts.priority ||
            !!opts.behavior ||
            !!opts.antiPattern ||
            !!opts.active;

          let next: Principle = { ...principle };
          if (opts.title) next.title = opts.title;
          if (opts.description) next.description = opts.description;
          if (opts.category) next.category = normalizeCategory(opts.category);
          if (opts.priority) next.priority = clampPriority(opts.priority);
          if (opts.behavior) next.behavior = opts.behavior;
          if (opts.antiPattern) next.antiPattern = opts.antiPattern;
          if (opts.active) next.isActive = opts.active === 'true' || opts.active === '1';

          if (!flagsTouched) {
            next.title = await askText('Title', { initial: next.title, required: true });
            next.description = await askText('Description', { initial: next.description, required: true });
            const cat = await askSelect<PrincipleCategory>(
              'Category',
              CATEGORIES.map((c) => ({ name: c, message: c })),
              { initial: next.category },
            );
            next.category = cat;
            const pr = await askText('Priority (1-10)', { initial: String(next.priority) });
            next.priority = clampPriority(pr);
            next.behavior = await askText('Behavior', { initial: next.behavior, required: true });
            next.antiPattern = await askText('Anti-pattern', { initial: next.antiPattern ?? '' });
            next.isActive = await askConfirm('Active?', next.isActive);
          }
          next.updatedAt = nowIso();
          await ctx.storage.updatePrinciple(next);
          if (ctx.json) {
            process.stdout.write(JSON.stringify({ principle: next }, null, 2) + '\n');
            return;
          }
          process.stdout.write(`${c.ok('✓')} Updated ${c.bold(next.title)}\n`);
        } finally {
          await closeContext(ctx);
        }
      },
    );

  // --------------------------------------------------------------
  // delete
  // --------------------------------------------------------------
  p.command('delete <idOrTitle>')
    .description('delete a principle')
    .option('--yes', 'skip confirmation prompt')
    .action(async (idOrTitle: string, opts: { yes?: boolean }) => {
      const ctx = await openContext(p);
      try {
        const principle = await resolvePrinciple(ctx.storage.loadPrinciples(), idOrTitle);
        if (!opts.yes) {
          const ok = await askConfirm(`Delete principle "${principle.title}"?`, false);
          if (!ok) {
            process.stdout.write(c.hint('  aborted.\n'));
            return;
          }
        }
        await ctx.storage.deletePrinciple(principle.id);
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ deleted: principle.id }, null, 2) + '\n');
          return;
        }
        process.stdout.write(`${c.ok('✓')} Deleted ${principle.title}\n`);
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // seed-starters
  // --------------------------------------------------------------
  p.command('seed-starters')
    .description('seed 8 Dalio-inspired starters (skips by default if any principle exists)')
    .option('--force', 'add starters even if there are already principles in the workspace')
    .action(async (opts: { force?: boolean }) => {
      const ctx = await openContext(p);
      try {
        const existing = await ctx.storage.loadPrinciples();
        if (existing.length > 0 && !opts.force) {
          process.stdout.write(
            c.warn(
              `  ${existing.length} principle${existing.length === 1 ? '' : 's'} already exist — pass --force to add starters on top.\n`,
            ),
          );
          return;
        }
        const now = nowIso();
        let added = 0;
        for (const starter of STARTER_PRINCIPLES) {
          const principle: Principle = {
            id: generateUUID(),
            category: starter.category,
            title: starter.title,
            description: starter.description,
            behavior: starter.behavior,
            antiPattern: starter.antiPattern,
            triggerQuestions: starter.triggerQuestions,
            priority: starter.priority,
            examples: starter.examples,
            isActive: starter.isActive,
            createdAt: now,
            updatedAt: now,
          };
          await ctx.storage.savePrinciple(principle);
          added++;
        }
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ added }, null, 2) + '\n');
          return;
        }
        process.stdout.write(`${c.ok('✓')} Seeded ${added} starter principle${added === 1 ? '' : 's'}.\n`);
      } finally {
        await closeContext(ctx);
      }
    });

  // --------------------------------------------------------------
  // explore — 5-step Socratic wizard
  // --------------------------------------------------------------
  p.command('explore')
    .description('5-step Socratic wizard: behavior → anti-pattern → triggers → examples → priority')
    .option('--principle <idOrTitle>', 'principle to refine (default: pick interactively)')
    .option('--title <title>', 'start a new draft principle with this title')
    .option('--description <text>', 'description for a new draft')
    .option('--category <cat>', 'category for a new draft')
    .option('--auto-accept', 'accept synthesised answers without confirmation')
    .option('--save-as-new', 'save the explored draft as a new principle (default: overwrite if --principle given)')
    .action(
      async (opts: {
        principle?: string;
        title?: string;
        description?: string;
        category?: string;
        autoAccept?: boolean;
        saveAsNew?: boolean;
      }) => {
        const ctx = await openContext(p);
        try {
          const all = await ctx.storage.loadPrinciples();
          let working: Principle | (Omit<Principle, 'id' | 'createdAt' | 'updatedAt'> & { id?: string });
          let isExisting = false;
          if (opts.principle) {
            const target = await resolvePrinciple(Promise.resolve(all), opts.principle);
            working = { ...target };
            isExisting = true;
          } else if (opts.title) {
            working = {
              title: opts.title,
              description: opts.description ?? '',
              category: normalizeCategory(opts.category ?? 'work'),
              priority: 5,
              behavior: '',
              isActive: true,
            };
          } else if (all.length > 0) {
            const choice = await askSelect<string>(
              'Refine which principle?',
              [
                { name: '__new__', message: '(new draft)' },
                ...all.map((pp) => ({ name: pp.id, message: pp.title })),
              ],
            );
            if (choice === '__new__') {
              working = {
                title: await askText('Draft title', { required: true }),
                description: await askText('Draft description', { required: true }),
                category: normalizeCategory(
                  await askSelect<PrincipleCategory>(
                    'Category',
                    CATEGORIES.map((c) => ({ name: c, message: c })),
                  ),
                ),
                priority: 5,
                behavior: '',
                isActive: true,
              };
            } else {
              const found = all.find((pp) => pp.id === choice);
              if (!found) throw new UserError(`Principle ${choice} not found`);
              working = { ...found };
              isExisting = true;
            }
          } else {
            working = {
              title: await askText('Draft title', { required: true }),
              description: await askText('Draft description', { required: true }),
              category: normalizeCategory(
                await askSelect<PrincipleCategory>(
                  'Category',
                  CATEGORIES.map((c) => ({ name: c, message: c })),
                ),
              ),
              priority: 5,
              behavior: '',
              isActive: true,
            };
          }

          const settings = await ctx.storage.loadSettings();
          const history: ExplorerTurn[] = [];
          for (const step of EXPLORER_STEPS) {
            process.stdout.write(`\n${c.bold(c.cyan(`Step: ${step}`))}\n`);
            let userInput = '';
            let synthesised = false;
            let suggested: string | undefined;
            let firstIteration = true;
            // Up to 4 turns per step.
            for (let turn = 0; turn < 4 && !synthesised; turn++) {
              const sp = spinner('Coach thinking...');
              sp.start();
              let result;
              try {
                result = await explorerReply(
                  {
                    principle: working,
                    history,
                    step,
                    isFirstMessage: firstIteration,
                  },
                  userInput,
                  settings,
                );
                sp.stop();
              } catch (error) {
                sp.fail(`Coach failed: ${error instanceof Error ? error.message : String(error)}`);
                throw error;
              }
              process.stdout.write(`${c.gray('coach:')}\n${result.reply}\n\n`);
              if (userInput) {
                history.push({ step, role: 'user', content: userInput });
              }
              history.push({ step, role: 'assistant', content: result.reply });
              if (result.synthesised && result.suggested) {
                synthesised = true;
                suggested = result.suggested;
                break;
              }
              firstIteration = false;
              userInput = await askText('you', { required: true });
            }

            if (!suggested) {
              const finalInput = await askText(
                'Provide your own answer for this step (or press Enter to skip)',
              );
              if (finalInput.trim()) suggested = finalInput.trim();
            }

            if (suggested) {
              if (!opts.autoAccept) {
                const ok = await askConfirm(`Apply this ${step}?`, true);
                if (!ok) {
                  process.stdout.write(c.hint('  skipped.\n'));
                  continue;
                }
              }
              working = applyStep(working, step, suggested) as typeof working;
            }
          }

          if (!isExisting || opts.saveAsNew) {
            const now = nowIso();
            const principle: Principle = {
              id: generateUUID(),
              category: working.category,
              title: working.title,
              description: working.description,
              behavior: working.behavior ?? '',
              antiPattern: working.antiPattern,
              triggerQuestions: working.triggerQuestions,
              priority: working.priority ?? 5,
              examples: working.examples,
              isActive: working.isActive ?? true,
              createdAt: now,
              updatedAt: now,
            };
            await ctx.storage.savePrinciple(principle);
            if (ctx.json) {
              process.stdout.write(JSON.stringify({ principle, mode: 'created' }, null, 2) + '\n');
              return;
            }
            process.stdout.write(`\n${c.ok('✓')} Created principle ${c.bold(principle.title)}\n`);
          } else {
            const id = (working as Principle).id;
            const next: Principle = {
              ...(working as Principle),
              id,
              updatedAt: nowIso(),
            };
            await ctx.storage.updatePrinciple(next);
            if (ctx.json) {
              process.stdout.write(JSON.stringify({ principle: next, mode: 'updated' }, null, 2) + '\n');
              return;
            }
            process.stdout.write(`\n${c.ok('✓')} Updated ${c.bold(next.title)}\n`);
          }
        } finally {
          await closeContext(ctx);
        }
      },
    );
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function renderPrincipleDetail(p: Principle): void {
  process.stdout.write(
    `\n${c.bold(p.title)} ${c.hint(`· ${p.category} · priority ${p.priority}/10 · ${p.isActive ? 'active' : 'inactive'}`)}\n`,
  );
  process.stdout.write(`  ${c.hint('id:')} ${p.id}\n`);
  process.stdout.write(`\n${c.bold('Description')}\n${p.description}\n`);
  process.stdout.write(`\n${c.bold('Behavior')}\n${p.behavior}\n`);
  if (p.antiPattern) process.stdout.write(`\n${c.bold('Anti-pattern')}\n${p.antiPattern}\n`);
  if (p.triggerQuestions && p.triggerQuestions.length > 0) {
    process.stdout.write(`\n${c.bold('Trigger questions')}\n`);
    for (const q of p.triggerQuestions) process.stdout.write(`  - ${q}\n`);
  }
  if (p.examples && p.examples.length > 0) {
    process.stdout.write(`\n${c.bold('Examples')}\n`);
    for (const e of p.examples) process.stdout.write(`  - ${e}\n`);
  }
  process.stdout.write('\n');
}

async function resolvePrinciple(
  loader: Promise<Principle[]>,
  idOrTitle: string,
): Promise<Principle> {
  const principles = await loader;
  const lower = idOrTitle.toLowerCase();
  const byId = principles.find((pp) => pp.id === idOrTitle);
  if (byId) return byId;
  const byShortId = principles.find((pp) => pp.id.startsWith(idOrTitle) && idOrTitle.length >= 4);
  if (byShortId) return byShortId;
  const byTitle = principles.find((pp) => pp.title.toLowerCase() === lower);
  if (byTitle) return byTitle;
  const byPartial = principles.filter((pp) => pp.title.toLowerCase().includes(lower));
  if (byPartial.length === 1 && byPartial[0]) return byPartial[0];
  if (byPartial.length > 1) {
    throw new UserError(
      `Ambiguous principle: "${idOrTitle}" matches ${byPartial.map((pp) => pp.title).join(', ')}`,
      'Use the full title or principle id.',
    );
  }
  throw new UserError(`No principle matches "${idOrTitle}"`, 'Run `aab principles list`.');
}

function normalizeCategory(raw: string): PrincipleCategory {
  const v = raw.toLowerCase().trim();
  if ((CATEGORIES as string[]).includes(v)) return v as PrincipleCategory;
  throw new UserError(`Unknown category "${raw}"`, `Pick one of: ${CATEGORIES.join(', ')}`);
}

function clampPriority(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new UserError(`Priority must be a number, got "${raw}"`);
  }
  return Math.max(1, Math.min(10, Math.round(n)));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

// Re-export so tsc's verbatim-module-syntax check is satisfied for the type import.
export type { ExplorerStep };
