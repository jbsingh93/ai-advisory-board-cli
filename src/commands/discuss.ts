/**
 * `aab discuss start | continue | respond | follow-up | list | show | delete |
 *  archive | unarchive | summarize | export`
 *
 * Phase 1 surface: kick off a discussion, drive multi-round conversations,
 * answer the orchestrator's HITL questions, ask targeted follow-ups, list /
 * show / delete / archive saved discussions, summarize a concluded discussion,
 * and export it to markdown. Sparring comes next (Phase 3).
 */
import { Command } from 'commander';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeContext, openContext } from './_context.js';
import { c } from '../ui/colors.js';
import { spinner } from '../ui/spinner.js';
import { renderDiscussion, shortId } from '../ui/render-discussion.js';
import { renderDiscussionMarkdown, defaultExportFilename } from '../ui/render-discussion-markdown.js';
import { UserError } from '../core/errors.js';
import { formatDuration, formatUsd } from '../core/utils.js';
import {
  addFollowUpQuestion,
  continueDiscussion,
  respondToUserRequest,
  startDiscussion,
  type FollowUpTargetType,
  type StartProgressEvent,
} from '../core/discussion/conversation-flow.js';
import { summarizeDiscussion } from '../core/discussion/summarize.js';
import { memberAgentPath, memberAgentSlug } from '../agents/emit-member-agent.js';
import type { AdvisoryBoardMember, ConversationSummary, Discussion } from '../storage/types.js';

export function registerDiscussCommand(program: Command): void {
  const discuss = program.command('discuss').description('start, view, and manage advisory-board discussions');

  registerStart(discuss);
  registerContinue(discuss);
  registerRespond(discuss);
  registerFollowUp(discuss);
  registerList(discuss);
  registerShow(discuss);
  registerDelete(discuss);
  registerArchive(discuss);
  registerUnarchive(discuss);
  registerSummarize(discuss);
  registerExport(discuss);
}

function registerStart(parent: Command): void {
  parent
    .command('start <question>')
    .description('start a new advisory-board discussion (round 1)')
    .option('--members <names>', 'comma-separated subset of member names (default: all active)')
    .option('--max-turns <n>', 'override settings.maxTurnsPerDiscussion for this run', (v) => Number(v))
    .option('--agents-dir <path>', 'where .claude/agents/ lives (default: cwd)')
    .action(async (question: string, opts: { members?: string; maxTurns?: number; agentsDir?: string }) => {
      const ctx = await openContext(parent);
      try {
        const settings = await ctx.storage.loadSettings();
        if (opts.maxTurns) settings.maxTurnsPerDiscussion = opts.maxTurns;

        const allMembers = await ctx.storage.loadBoardMembers();
        const members = pickMembers(allMembers, opts.members);
        if (members.length === 0) {
          throw new UserError(
            opts.members
              ? `No active members matched: ${opts.members}`
              : 'No active board members. Run `aab init` to seed starters.',
          );
        }

        const projectRoot = opts.agentsDir ?? process.cwd();
        verifyAgentFiles(members, projectRoot);

        if (!ctx.json) {
          process.stdout.write(`\n${c.brand('AI Advisory Board')}  ${c.hint('· starting discussion')}\n`);
          process.stdout.write(c.hint(`  question: ${question}\n`));
          process.stdout.write(c.hint(`  members:  ${members.map((m) => m.name).join(', ')}\n\n`));
        }

        const sp = spinner('initializing...');
        sp.start();
        const result = await startDiscussion({
          question,
          members,
          settings,
          storage: ctx.storage,
          projectRoot,
          onProgress: progressHandler(sp),
        });
        sp.succeed(`Discussion ${shortId(result.discussion.id)} ready in ${formatDuration(result.totalDurationMs)} (${formatUsd(result.totalCostUsd)}).`);

        if (ctx.json) {
          process.stdout.write(JSON.stringify({ discussion: result.discussion, totalCostUsd: result.totalCostUsd }, null, 2) + '\n');
        } else {
          process.stdout.write(renderDiscussion(result.discussion));
          process.stdout.write('\n');
        }
      } finally {
        await closeContext(ctx);
      }
    });
}

function registerContinue(parent: Command): void {
  parent
    .command('continue <idOrShort>')
    .description('drive the next round of an open discussion (orchestrator-gated)')
    .option('--agents-dir <path>', 'where .claude/agents/ lives (default: cwd)')
    .action(async (idOrShort: string, opts: { agentsDir?: string }) => {
      const ctx = await openContext(parent);
      try {
        const discussion = await resolveDiscussion(ctx.storage, idOrShort);
        const settings = await ctx.storage.loadSettings();
        const allMembers = await ctx.storage.loadBoardMembers();

        // Restrict to the originally-selected members so a continue doesn't
        // suddenly add a new face the discussion never had.
        const selectedIds = new Set(discussion.selectedMemberIds ?? allMembers.map((m) => m.id));
        const members = allMembers.filter((m) => selectedIds.has(m.id) && m.isActive);
        if (members.length === 0) {
          throw new UserError(
            'No active members from this discussion remain.',
            'Re-activate one with `aab members activate <name>` (coming in Phase 2) or start a new discussion.',
          );
        }

        const projectRoot = opts.agentsDir ?? process.cwd();
        verifyAgentFiles(members, projectRoot);

        if (!ctx.json) {
          process.stdout.write(`\n${c.brand('AI Advisory Board')}  ${c.hint('· continuing discussion ' + shortId(discussion.id))}\n`);
          process.stdout.write(c.hint(`  question: ${discussion.question}\n`));
          process.stdout.write(c.hint(`  members:  ${members.map((m) => m.name).join(', ')}\n`));
          process.stdout.write(c.hint(`  rounds:   ${discussion.rounds.length} so far · ${discussion.totalTurns}/${discussion.maxTurns} turns\n\n`));
        }

        const sp = spinner('orchestrator deciding...');
        sp.start();
        const result = await continueDiscussion({
          discussion,
          members,
          settings,
          storage: ctx.storage,
          projectRoot,
          onProgress: progressHandler(sp),
        });

        if (result.gated) {
          sp.warn('Orchestrator wants more input from you before continuing.');
          if (ctx.json) {
            process.stdout.write(JSON.stringify({ discussion: result.discussion, gated: true }, null, 2) + '\n');
          } else {
            process.stdout.write(renderDiscussion(result.discussion));
            process.stdout.write(
              `\n${c.warn('→')} reply with: ${c.bold(`aab discuss respond ${shortId(result.discussion.id)} "<your answer>"`)}\n`,
            );
          }
          return;
        }

        if (result.roundNumber == null) {
          sp.info('Discussion already at maxTurns — concluded.');
        } else {
          sp.succeed(
            `Round ${result.roundNumber} done in ${formatDuration(result.totalDurationMs)} (${formatUsd(result.totalCostUsd)})${result.concluded ? c.ok(' · concluded') : ''}.`,
          );
        }

        if (ctx.json) {
          process.stdout.write(
            JSON.stringify({ discussion: result.discussion, totalCostUsd: result.totalCostUsd, roundNumber: result.roundNumber, concluded: result.concluded }, null, 2) + '\n',
          );
        } else {
          process.stdout.write(renderDiscussion(result.discussion, { round: result.roundNumber ?? undefined }));
          process.stdout.write('\n');
        }
      } finally {
        await closeContext(ctx);
      }
    });
}

function registerRespond(parent: Command): void {
  parent
    .command('respond <idOrShort> <answer>')
    .description("answer the orchestrator's pending question and drive the next round")
    .option('--option <i>', '1-based index of one of the listed options', (v) => Number(v))
    .option('--agents-dir <path>', 'where .claude/agents/ lives (default: cwd)')
    .action(
      async (idOrShort: string, answer: string, opts: { option?: number; agentsDir?: string }) => {
        const ctx = await openContext(parent);
        try {
          const discussion = await resolveDiscussion(ctx.storage, idOrShort);
          if (!discussion.pendingUserRequest) {
            throw new UserError(
              'This discussion is not awaiting your input.',
              'Use `aab discuss continue <id>` to drive the next round.',
            );
          }

          let selectedOption: string | undefined;
          if (opts.option != null) {
            const options = discussion.pendingUserRequest.options ?? [];
            if (!Number.isFinite(opts.option) || opts.option < 1 || opts.option > options.length) {
              throw new UserError(
                `--option must be between 1 and ${options.length || 0}.`,
                'Run `aab discuss show <id>` to see the listed options.',
              );
            }
            selectedOption = options[opts.option - 1];
          }

          const settings = await ctx.storage.loadSettings();
          const allMembers = await ctx.storage.loadBoardMembers();
          const selectedIds = new Set(discussion.selectedMemberIds ?? allMembers.map((m) => m.id));
          const members = allMembers.filter((m) => selectedIds.has(m.id) && m.isActive);
          if (members.length === 0) {
            throw new UserError('No active members from this discussion remain.');
          }

          const projectRoot = opts.agentsDir ?? process.cwd();
          verifyAgentFiles(members, projectRoot);

          if (!ctx.json) {
            process.stdout.write(`\n${c.brand('AI Advisory Board')}  ${c.hint('· replying to discussion ' + shortId(discussion.id))}\n`);
            process.stdout.write(c.hint(`  request: ${discussion.pendingUserRequest.question}\n`));
            if (selectedOption) process.stdout.write(c.hint(`  option:  ${selectedOption}\n`));
            process.stdout.write(c.hint(`  answer:  ${answer}\n\n`));
          }

          const sp = spinner('saving your reply...');
          sp.start();
          const result = await respondToUserRequest({
            discussion,
            content: answer,
            selectedOption,
            members,
            settings,
            storage: ctx.storage,
            projectRoot,
            onProgress: progressHandler(sp),
          });

          if (result.roundNumber == null) {
            sp.info('Reply saved — discussion already at maxTurns.');
          } else {
            sp.succeed(
              `Round ${result.roundNumber} done in ${formatDuration(result.totalDurationMs)} (${formatUsd(result.totalCostUsd)})${result.concluded ? c.ok(' · concluded') : ''}.`,
            );
          }

          if (ctx.json) {
            process.stdout.write(
              JSON.stringify({ discussion: result.discussion, totalCostUsd: result.totalCostUsd, roundNumber: result.roundNumber, concluded: result.concluded }, null, 2) + '\n',
            );
          } else {
            process.stdout.write(renderDiscussion(result.discussion, { round: result.roundNumber ?? undefined }));
            process.stdout.write('\n');
          }
        } finally {
          await closeContext(ctx);
        }
      },
    );
}

function registerFollowUp(parent: Command): void {
  parent
    .command('follow-up <idOrShort> <question>')
    .description('ask a follow-up question (default: all members; --member or --members for targeted)')
    .option('--all', 'every active member from this discussion responds (default)')
    .option('--member <name>', 'exactly one member responds (name, slug, or id)')
    .option('--members <names>', 'comma-separated subset of member names, slugs, or ids')
    .option('--agents-dir <path>', 'where .claude/agents/ lives (default: cwd)')
    .action(
      async (
        idOrShort: string,
        question: string,
        opts: { all?: boolean; member?: string; members?: string; agentsDir?: string },
      ) => {
        const flagCount = [opts.all, opts.member, opts.members].filter(Boolean).length;
        if (flagCount > 1) {
          throw new UserError(
            '--all, --member, and --members are mutually exclusive.',
            'Pick one to control who answers.',
          );
        }

        const ctx = await openContext(parent);
        try {
          const discussion = await resolveDiscussion(ctx.storage, idOrShort);
          const settings = await ctx.storage.loadSettings();
          const allMembers = await ctx.storage.loadBoardMembers();

          const selectedIds = new Set(discussion.selectedMemberIds ?? allMembers.map((m) => m.id));
          const candidatePool = allMembers.filter((m) => selectedIds.has(m.id) && m.isActive);
          if (candidatePool.length === 0) {
            throw new UserError("No active members from this discussion's original board remain.");
          }

          let targetType: FollowUpTargetType = 'all';
          let selectedMemberId: string | undefined;
          let selectedMemberIdList: string[] | undefined;

          if (opts.member) {
            const match = resolveMemberToken(candidatePool, opts.member);
            if (!match) {
              throw new UserError(
                `No member matched "${opts.member}" in this discussion.`,
                `Active members: ${candidatePool.map((m) => m.name).join(', ')}`,
              );
            }
            targetType = 'specific';
            selectedMemberId = match.id;
          } else if (opts.members) {
            const tokens = opts.members.split(',').map((t) => t.trim()).filter(Boolean);
            const matched: AdvisoryBoardMember[] = [];
            const unmatched: string[] = [];
            for (const tok of tokens) {
              const m = resolveMemberToken(candidatePool, tok);
              if (m) {
                if (!matched.some((x) => x.id === m.id)) matched.push(m);
              } else unmatched.push(tok);
            }
            if (unmatched.length > 0) {
              throw new UserError(
                `No member matched: ${unmatched.join(', ')}`,
                `Active members: ${candidatePool.map((m) => m.name).join(', ')}`,
              );
            }
            if (matched.length < 2) {
              throw new UserError('--members needs at least two distinct members. Use --member for one, or --all for everybody.');
            }
            targetType = 'subset';
            selectedMemberIdList = matched.map((m) => m.id);
          }

          // The members the engine sees as "active candidates" — equals the
          // pool. The engine narrows to targets via targetType.
          const projectRoot = opts.agentsDir ?? process.cwd();
          // Verify only the agent files for the targets we'll actually spawn.
          const willSpawn =
            targetType === 'all'
              ? candidatePool
              : targetType === 'specific'
                ? candidatePool.filter((m) => m.id === selectedMemberId)
                : candidatePool.filter((m) => selectedMemberIdList!.includes(m.id));
          verifyAgentFiles(willSpawn, projectRoot);

          if (!ctx.json) {
            const targetLabel =
              targetType === 'all'
                ? `all (${candidatePool.length})`
                : targetType === 'specific'
                  ? willSpawn[0]!.name
                  : willSpawn.map((m) => m.name).join(', ');
            process.stdout.write(`\n${c.brand('AI Advisory Board')}  ${c.hint('· follow-up to ' + shortId(discussion.id))}\n`);
            process.stdout.write(c.hint(`  question: ${question}\n`));
            process.stdout.write(c.hint(`  target:   ${targetLabel}\n`));
            process.stdout.write(c.hint(`  rounds:   ${discussion.rounds.length} so far · ${discussion.totalTurns}/${discussion.maxTurns} turns\n\n`));
          }

          const sp = spinner('orchestrator deciding...');
          sp.start();
          const result = await addFollowUpQuestion({
            discussion,
            question,
            members: candidatePool,
            settings,
            storage: ctx.storage,
            projectRoot,
            targetType,
            selectedMemberId,
            selectedMemberIds: selectedMemberIdList,
            onProgress: progressHandler(sp),
          });

          if (result.gated) {
            sp.warn('Orchestrator wants more input from you before the follow-up.');
            if (ctx.json) {
              process.stdout.write(JSON.stringify({ discussion: result.discussion, gated: true }, null, 2) + '\n');
            } else {
              process.stdout.write(renderDiscussion(result.discussion));
              process.stdout.write(
                `\n${c.warn('→')} reply with: ${c.bold(`aab discuss respond ${shortId(result.discussion.id)} "<your answer>"`)}\n`,
              );
            }
            return;
          }

          if (result.roundNumber == null) {
            sp.info('Discussion already at maxTurns — concluded.');
          } else {
            sp.succeed(
              `Follow-up round ${result.roundNumber} done in ${formatDuration(result.totalDurationMs)} (${formatUsd(result.totalCostUsd)})${result.concluded ? c.ok(' · concluded') : ''}.`,
            );
          }

          if (ctx.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  discussion: result.discussion,
                  totalCostUsd: result.totalCostUsd,
                  roundNumber: result.roundNumber,
                  concluded: result.concluded,
                },
                null,
                2,
              ) + '\n',
            );
          } else {
            process.stdout.write(renderDiscussion(result.discussion, { round: result.roundNumber ?? undefined }));
            process.stdout.write('\n');
          }
        } finally {
          await closeContext(ctx);
        }
      },
    );
}

function registerList(parent: Command): void {
  parent
    .command('list')
    .description('list saved discussions')
    .option('--limit <n>', 'page size', (v) => Number(v), 20)
    .option('--offset <n>', 'page offset', (v) => Number(v), 0)
    .option('--archived', 'include archived discussions')
    .action(async (opts: { limit: number; offset: number; archived?: boolean }) => {
      const ctx = await openContext(parent, { lock: false });
      try {
        const page = await ctx.storage.loadDiscussionPage({
          limit: opts.limit,
          offset: opts.offset,
          includeArchived: opts.archived,
        });
        if (ctx.json) {
          process.stdout.write(JSON.stringify(page, null, 2) + '\n');
          return;
        }
        if (page.discussions.length === 0) {
          process.stdout.write(c.hint('  (no discussions yet — run `aab discuss start "<question>"`)\n'));
          return;
        }
        process.stdout.write(`\n${c.brand('AI Advisory Board')}  ${c.hint('· ' + page.totalCount + ' discussion(s)')}\n\n`);
        for (const d of page.discussions) {
          process.stdout.write(renderListRow(d) + '\n');
        }
        if (page.hasMore) {
          process.stdout.write(c.hint(`\n  more: aab discuss list --offset ${opts.offset + opts.limit}\n`));
        }
      } finally {
        await closeContext(ctx);
      }
    });
}

function registerShow(parent: Command): void {
  parent
    .command('show <idOrShort>')
    .description('pretty-print one discussion')
    .option('--round <n>', 'show only one round', (v) => Number(v))
    .action(async (idOrShort: string, opts: { round?: number }) => {
      const ctx = await openContext(parent, { lock: false });
      try {
        const discussion = await resolveDiscussion(ctx.storage, idOrShort);
        if (ctx.json) {
          process.stdout.write(JSON.stringify(discussion, null, 2) + '\n');
        } else {
          process.stdout.write(renderDiscussion(discussion, { round: opts.round }));
          process.stdout.write('\n');
        }
      } finally {
        await closeContext(ctx);
      }
    });
}

function registerDelete(parent: Command): void {
  parent
    .command('delete <idOrShort>')
    .description('delete a discussion permanently')
    .option('--yes', 'skip confirmation')
    .action(async (idOrShort: string, _opts: { yes?: boolean }) => {
      const ctx = await openContext(parent);
      try {
        const discussion = await resolveDiscussion(ctx.storage, idOrShort);
        await ctx.storage.deleteDiscussion(discussion.id);
        process.stdout.write(`${c.ok('✓')} discussion ${shortId(discussion.id)} deleted.\n`);
      } finally {
        await closeContext(ctx);
      }
    });
}

function registerArchive(parent: Command): void {
  parent
    .command('archive <idOrShort>')
    .description('archive a discussion (hidden from `list` unless --archived)')
    .action(async (idOrShort: string) => {
      const ctx = await openContext(parent);
      try {
        const discussion = await resolveDiscussion(ctx.storage, idOrShort);
        if (discussion.archivedAt) {
          process.stdout.write(`${c.hint('—')} discussion ${shortId(discussion.id)} is already archived.\n`);
          return;
        }
        await ctx.storage.archiveDiscussion(discussion.id);
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ id: discussion.id, archived: true }, null, 2) + '\n');
        } else {
          process.stdout.write(`${c.ok('✓')} discussion ${shortId(discussion.id)} archived.\n`);
        }
      } finally {
        await closeContext(ctx);
      }
    });
}

function registerUnarchive(parent: Command): void {
  parent
    .command('unarchive <idOrShort>')
    .description('restore an archived discussion to the active list')
    .action(async (idOrShort: string) => {
      const ctx = await openContext(parent);
      try {
        const discussion = await resolveDiscussion(ctx.storage, idOrShort);
        if (!discussion.archivedAt) {
          process.stdout.write(`${c.hint('—')} discussion ${shortId(discussion.id)} is not archived.\n`);
          return;
        }
        await ctx.storage.unarchiveDiscussion(discussion.id);
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ id: discussion.id, archived: false }, null, 2) + '\n');
        } else {
          process.stdout.write(`${c.ok('✓')} discussion ${shortId(discussion.id)} unarchived.\n`);
        }
      } finally {
        await closeContext(ctx);
      }
    });
}

function registerSummarize(parent: Command): void {
  parent
    .command('summarize <idOrShort>')
    .description('generate or refresh the ConversationSummary for a discussion')
    .option('--force', 'regenerate even if a summary already exists')
    .action(async (idOrShort: string, opts: { force?: boolean }) => {
      const ctx = await openContext(parent);
      try {
        const discussion = await resolveDiscussion(ctx.storage, idOrShort);
        if (discussion.rounds.length === 0) {
          throw new UserError(
            'Cannot summarize: discussion has no rounds yet.',
            'Run `aab discuss continue` first.',
          );
        }
        if (discussion.summary && !opts.force) {
          if (ctx.json) {
            process.stdout.write(JSON.stringify({ summary: discussion.summary, regenerated: false }, null, 2) + '\n');
          } else {
            process.stdout.write(`${c.hint('—')} summary already exists. Re-run with --force to regenerate.\n\n`);
            renderSummary(discussion.summary);
          }
          return;
        }

        const settings = await ctx.storage.loadSettings();
        const allMembers = await ctx.storage.loadBoardMembers();
        const memberMap = new Map(allMembers.map((m) => [m.id, m]));
        const memberIds =
          discussion.selectedMemberIds ?? Array.from(new Set(discussion.responses.map((r) => r.memberId)));
        const members = memberIds
          .map((id) => memberMap.get(id))
          .filter((m): m is AdvisoryBoardMember => !!m);

        const sp = spinner('summarizing discussion...');
        sp.start();
        const summary = await summarizeDiscussion({
          discussion,
          members,
          settings,
        });
        discussion.summary = summary;
        await ctx.storage.saveDiscussion(discussion);
        sp.succeed(`Summary written (${summary.keyPoints.length} key points, ${summary.consensus.length} consensus, ${summary.disagreements.length} disagreements).`);

        if (ctx.json) {
          process.stdout.write(JSON.stringify({ summary, regenerated: !!opts.force }, null, 2) + '\n');
        } else {
          renderSummary(summary);
        }
      } finally {
        await closeContext(ctx);
      }
    });
}

function registerExport(parent: Command): void {
  parent
    .command('export <idOrShort>')
    .description('export a discussion to a markdown file')
    .option('--md', 'render as markdown (default and only format in v1)')
    .option('--out <path>', 'output file path (default: <short-id>-<slug>.md in cwd)')
    .option('--no-summary', 'skip auto-generating a summary if one is missing')
    .action(async (idOrShort: string, opts: { md?: boolean; out?: string; summary?: boolean }) => {
      const ctx = await openContext(parent);
      try {
        const discussion = await resolveDiscussion(ctx.storage, idOrShort);

        // Auto-summarize once at export time if missing — keeps the markdown
        // self-contained without forcing the user to run two commands.
        const wantsSummary = opts.summary !== false;
        if (wantsSummary && !discussion.summary && discussion.rounds.length > 0) {
          const settings = await ctx.storage.loadSettings();
          const allMembers = await ctx.storage.loadBoardMembers();
          const memberMap = new Map(allMembers.map((m) => [m.id, m]));
          const memberIds =
            discussion.selectedMemberIds ?? Array.from(new Set(discussion.responses.map((r) => r.memberId)));
          const members = memberIds
            .map((id) => memberMap.get(id))
            .filter((m): m is AdvisoryBoardMember => !!m);

          const sp = spinner('summarizing before export...');
          sp.start();
          try {
            discussion.summary = await summarizeDiscussion({ discussion, members, settings });
            await ctx.storage.saveDiscussion(discussion);
            sp.succeed('Summary generated.');
          } catch (error) {
            sp.warn(`Summary generation failed: ${error instanceof Error ? error.message : String(error)}`);
            // Export proceeds without a summary — better than failing the export.
          }
        }

        const md = renderDiscussionMarkdown(discussion);
        const outPath = opts.out ?? join(process.cwd(), defaultExportFilename(discussion));
        writeFileSync(outPath, md, 'utf8');

        if (ctx.json) {
          process.stdout.write(JSON.stringify({ id: discussion.id, path: outPath, bytes: Buffer.byteLength(md, 'utf8') }, null, 2) + '\n');
        } else {
          process.stdout.write(`${c.ok('✓')} exported ${shortId(discussion.id)} → ${c.bold(outPath)}\n`);
        }
      } finally {
        await closeContext(ctx);
      }
    });
}

// ---------------- helpers ----------------

function verifyAgentFiles(members: AdvisoryBoardMember[], projectRoot: string): void {
  const missing: string[] = [];
  for (const m of members) {
    if (!existsSync(memberAgentPath(memberAgentSlug(m.name), projectRoot))) {
      missing.push(m.name);
    }
  }
  if (missing.length > 0) {
    throw new UserError(
      `Missing .claude/agents/<slug>.md for: ${missing.join(', ')}`,
      `Re-run \`aab init\` from a project directory, or copy the agent files to ${join(projectRoot, '.claude', 'agents')}/.`,
    );
  }
}

function progressHandler(sp: ReturnType<typeof spinner>): (e: StartProgressEvent) => void {
  return (e) => {
    if (e.stage === 'initializing') sp.text = 'initializing...';
    else if (e.stage === 'context') sp.text = 'loading business context...';
    else if (e.stage === 'generating') sp.text = `asking ${e.memberName} (${e.index}/${e.total})...`;
    else if (e.stage === 'member_done') {
      sp.info(`${e.memberName} responded in ${formatDuration(e.durationMs)} (${formatUsd(e.costUsd)})`);
      sp.start();
    } else if (e.stage === 'orchestrating') sp.text = 'orchestrator deciding next step...';
    else if (e.stage === 'finalizing') sp.text = `saving round ${e.round}...`;
  };
}

function resolveMemberToken(pool: AdvisoryBoardMember[], token: string): AdvisoryBoardMember | undefined {
  const t = token.trim().toLowerCase();
  if (!t) return undefined;
  // Exact id, exact slug, exact (case-insensitive) name, then prefix on name/slug.
  return (
    pool.find((m) => m.id === token) ??
    pool.find((m) => memberAgentSlug(m.name) === t) ??
    pool.find((m) => m.name.toLowerCase() === t) ??
    pool.find((m) => m.name.toLowerCase().startsWith(t)) ??
    pool.find((m) => memberAgentSlug(m.name).startsWith(t))
  );
}

function pickMembers(all: AdvisoryBoardMember[], filter?: string): AdvisoryBoardMember[] {
  if (!filter) return all.filter((m) => m.isActive);
  const wanted = new Set(filter.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  return all.filter(
    (m) =>
      m.isActive &&
      (wanted.has(m.name.toLowerCase()) ||
        wanted.has(memberAgentSlug(m.name)) ||
        wanted.has(m.id)),
  );
}

async function resolveDiscussion(
  storage: { loadDiscussions(): Promise<Discussion[]>; loadDiscussionById(id: string): Promise<Discussion | null> },
  idOrShort: string,
): Promise<Discussion> {
  const direct = await storage.loadDiscussionById(idOrShort);
  if (direct) return direct;
  const all = await storage.loadDiscussions();
  const matches = all.filter((d) => d.id.startsWith(idOrShort));
  if (matches.length === 0) throw new UserError(`No discussion found with id starting "${idOrShort}".`);
  if (matches.length > 1) throw new UserError(`Multiple discussions match "${idOrShort}". Use a longer prefix.`);
  return matches[0]!;
}

function renderSummary(s: ConversationSummary): void {
  const out = process.stdout;
  out.write(`\n${c.bold('Summary')} ${c.hint(`· quality ${s.overallQuality}/100 · ${s.generatedAt.slice(0, 10)}`)}\n`);
  if (s.keyPoints.length > 0) {
    out.write(`\n${c.bold('Key points:')}\n`);
    for (const p of s.keyPoints) out.write(`  • ${p}\n`);
  }
  if (s.consensus.length > 0) {
    out.write(`\n${c.bold('Consensus:')}\n`);
    for (const p of s.consensus) out.write(`  ${c.ok('✓')} ${p}\n`);
  }
  if (s.disagreements.length > 0) {
    out.write(`\n${c.bold('Disagreements:')}\n`);
    for (const p of s.disagreements) out.write(`  ${c.warn('!')} ${p}\n`);
  }
  if (s.actionableInsights.length > 0) {
    out.write(`\n${c.bold('Actionable insights:')}\n`);
    for (const p of s.actionableInsights) out.write(`  → ${p}\n`);
  }
}

function renderListRow(d: Discussion): string {
  const id = shortId(d.id);
  const status = d.completedAt ? c.ok('done') : d.pendingUserRequest ? c.warn('awaiting input') : c.cyan('open');
  const date = d.createdAt.slice(0, 10);
  const turns = `${d.totalTurns}t`;
  const rounds = `${d.rounds.length}r`;
  const arch = d.archivedAt ? c.dim(' [archived]') : '';
  const q = d.question.length > 80 ? d.question.slice(0, 80) + '…' : d.question;
  return `  ${c.bold(id)}  ${c.hint(date)}  ${rounds.padEnd(4)} ${turns.padEnd(5)} ${status.padEnd(20)}${arch}  ${q}`;
}
