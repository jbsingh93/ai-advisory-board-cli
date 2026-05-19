/**
 * `aab members` — minimal Phase 1.5 surface: `sync-agents` to regenerate
 * `.claude/agents/<slug>.md` for every active member (used after we append
 * the Knowledge Wiki stanza or change `emit-member-agent.ts`).
 *
 * Full members CRUD ships in Phase 2.
 */
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { closeContext, openContext } from './_context.js';
import { c } from '../ui/colors.js';
import { emitMemberAgentFile, memberAgentPath, memberAgentSlug } from '../agents/emit-member-agent.js';

export function registerMembersCommand(program: Command): void {
  const m = program.command('members').description('manage advisory-board members');

  m.command('list')
    .description('list all board members')
    .action(async () => {
      const ctx = await openContext(m, { lock: false });
      try {
        const members = await ctx.storage.loadBoardMembers();
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ members }, null, 2) + '\n');
          return;
        }
        if (members.length === 0) {
          process.stdout.write(c.hint('  (no members — run `aab init` to seed starters)\n'));
          return;
        }
        for (const member of members) {
          const status = member.isActive ? c.ok('active') : c.hint('inactive');
          process.stdout.write(`  ${c.bold(member.name)} ${c.hint('· ' + member.title)} ${status}\n`);
        }
      } finally {
        await closeContext(ctx);
      }
    });

  m.command('sync-agents')
    .description('regenerate .claude/agents/<slug>.md for every active member (preserves user-edited files)')
    .option('--agents-dir <path>', 'where .claude/agents/ should live (default: cwd)')
    .option('--all', 'include inactive members too')
    .action(async (opts: { agentsDir?: string; all?: boolean }) => {
      const ctx = await openContext(m);
      try {
        const members = await ctx.storage.loadBoardMembers();
        const projectRoot = opts.agentsDir ?? process.cwd();
        let written = 0;
        let skipped = 0;
        const skippedDetail: string[] = [];
        for (const member of members) {
          if (!opts.all && !member.isActive) continue;
          const slug = memberAgentSlug(member.name);
          const path = memberAgentPath(slug, projectRoot);
          const result = emitMemberAgentFile(member, { projectRoot });
          if (result.written) {
            written++;
          } else {
            skipped++;
            skippedDetail.push(`${slug} (${result.reason ?? 'unknown'})`);
          }
          if (!ctx.json) {
            process.stdout.write(`  ${result.written ? c.ok('✓') : c.warn('—')} ${slug} ${c.hint(path)}\n`);
          }
        }
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ written, skipped, skippedDetail, total: members.length }, null, 2) + '\n');
          return;
        }
        process.stdout.write(`\n${c.ok('✓')} sync complete: ${written} written, ${skipped} skipped\n`);
        if (skippedDetail.length > 0) {
          process.stdout.write(c.hint(`  ${skippedDetail.join('; ')}\n`));
        }
      } finally {
        await closeContext(ctx);
      }
    });
}

// Silence unused
void existsSync;
