/**
 * `aab discuss start | continue | respond | follow-up | list | show | delete |
 *  archive | unarchive | summarize | export | spar | inject`
 *
 * Phase 1 surface: kick off a discussion, drive multi-round conversations,
 * answer the orchestrator's HITL questions, ask targeted follow-ups, list /
 * show / delete / archive saved discussions, summarize a concluded discussion,
 * and export it to markdown. Phase 3 adds `spar` (1:1 deep-dive) and `inject`
 * (write a sparring insight back to the main timeline).
 */
import { Command } from 'commander';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeContext, openContext } from './_context.js';
import { c } from '../ui/colors.js';
import { spinner } from '../ui/spinner.js';
import { askConfirm, askText } from '../ui/prompts.js';
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
import { resolveBoardMembers } from '../core/boards/resolve-board-members.js';
import {
  openSparringSession,
  sendSparringMessage,
} from '../core/sparring/sparring-service.js';
import { injectSparringInsight } from '../core/sparring/inject-insight.js';
import { memberAgentPath, memberAgentSlug } from '../agents/emit-member-agent.js';
import type {
  AdvisoryBoardMember,
  ConversationSummary,
  Discussion,
  SparringSession,
  StorageService,
} from '../storage/types.js';

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
  registerSpar(discuss);
  registerInject(discuss);
}

function registerStart(parent: Command): void {
  parent
    .command('start <question>')
    .description('start a new advisory-board discussion (round 1)')
    .option('--members <names>', 'comma-separated subset of member names (default: active board / all active)')
    .option('--board <token>', 'convene a saved board by slug/id/name (mutually exclusive with --members)')
    .option('--max-turns <n>', 'override settings.maxTurnsPerDiscussion for this run', (v) => Number(v))
    .option('--agents-dir <path>', 'where .claude/agents/ lives (default: cwd)')
    .action(async (question: string, opts: { members?: string; board?: string; maxTurns?: number; agentsDir?: string }) => {
      const ctx = await openContext(parent);
      try {
        const settings = await ctx.storage.loadSettings();
        if (opts.maxTurns) settings.maxTurnsPerDiscussion = opts.maxTurns;

        // Resolve the panel via the Phase 7 precedence:
        //   --members > --board > AAB_BOARD env > settings.activeBoardId > all-active.
        const resolved = await resolveBoardMembers(ctx.storage, settings, {
          membersFlag: opts.members,
          boardToken: opts.board,
          resolveMemberToken,
        });
        const members = resolved.members;
        if (members.length === 0) {
          throw new UserError(
            resolved.board
              ? `Board "${resolved.board.name}" has no active members.`
              : opts.members
                ? `No active members matched: ${opts.members}`
                : 'No active board members. Run `aab init` to seed starters.',
          );
        }

        // Enforce the per-discussion cap when convening from a board (spec §1.7) —
        // block rather than silently truncate.
        if (resolved.board && members.length > settings.maxMembersPerDiscussion) {
          throw new UserError(
            `Board "${resolved.board.name}" has ${members.length} active members; max per discussion is ${settings.maxMembersPerDiscussion}.`,
            'Narrow with `--members a,b,c`, raise `settings.maxMembersPerDiscussion`, or trim the board.',
          );
        }

        const projectRoot = opts.agentsDir ?? process.cwd();
        verifyAgentFiles(members, projectRoot);

        if (!ctx.json) {
          const panelLabel = resolved.board ? `${resolved.board.name} — ${members.map((m) => m.name).join(', ')}` : members.map((m) => m.name).join(', ');
          process.stdout.write(`\n${c.brand('AI Advisory Board')}  ${c.hint('· starting discussion')}\n`);
          process.stdout.write(c.hint(`  question:  ${question}\n`));
          process.stdout.write(`  ${c.hint('Convening:')} ${c.bold(panelLabel)}\n\n`);
        }

        const sp = spinner('initializing...');
        sp.start();
        const result = await startDiscussion({
          question,
          members,
          settings,
          storage: ctx.storage,
          projectRoot,
          boardId: resolved.board?.id,
          boardName: resolved.board?.name,
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
    .description('ask a follow-up question (default: all members; --member/--members target; --add-member brings someone new in)')
    .option('--all', 'every active member from this discussion responds (default)')
    .option('--member <name>', 'exactly one member responds (name, slug, or id)')
    .option('--members <names>', 'comma-separated subset of member names, slugs, or ids')
    .option('--add-member <name>', 'add an active member not yet in this discussion (repeatable)', collectRepeat, [])
    .option('--add-members <names>', 'comma-separated members to add to this discussion')
    .option('--catch-up <mode>', 'how added members catch up: full | summary | fresh (default full)')
    .option('--agents-dir <path>', 'where .claude/agents/ lives (default: cwd)')
    .action(
      async (
        idOrShort: string,
        question: string,
        opts: {
          all?: boolean;
          member?: string;
          members?: string;
          addMember?: string[];
          addMembers?: string;
          catchUp?: string;
          agentsDir?: string;
        },
      ) => {
        const flagCount = [opts.all, opts.member, opts.members].filter(Boolean).length;
        if (flagCount > 1) {
          throw new UserError(
            '--all, --member, and --members are mutually exclusive.',
            'Pick one to control who answers.',
          );
        }
        const catchUpMode = normalizeCatchUp(opts.catchUp);

        const ctx = await openContext(parent);
        try {
          const discussion = await resolveDiscussion(ctx.storage, idOrShort);
          const settings = await ctx.storage.loadSettings();
          const allMembers = await ctx.storage.loadBoardMembers();
          const activeAll = allMembers.filter((m) => m.isActive);

          const selectedIds = new Set(discussion.selectedMemberIds ?? allMembers.map((m) => m.id));
          const existingPool = activeAll.filter((m) => selectedIds.has(m.id));
          if (existingPool.length === 0) {
            throw new UserError("No active members from this discussion's original board remain.");
          }

          // ---- Resolve members to add (against ALL active members) ----
          const addTokens = [
            ...(opts.addMember ?? []),
            ...(opts.addMembers ? opts.addMembers.split(',').map((t) => t.trim()).filter(Boolean) : []),
          ];
          const addMembers: AdvisoryBoardMember[] = [];
          for (const tok of addTokens) {
            const m = resolveMemberToken(activeAll, tok);
            if (!m) {
              throw new UserError(
                `No active member matched "${tok}" to add.`,
                `Active members: ${activeAll.map((x) => x.name).join(', ')}`,
              );
            }
            if (selectedIds.has(m.id)) {
              throw new UserError(`${m.name} is already in this discussion — use --member/--members to target them.`);
            }
            if (!addMembers.some((x) => x.id === m.id)) addMembers.push(m);
          }
          const addMemberIds = addMembers.length > 0 ? addMembers.map((m) => m.id) : undefined;

          // Targeting resolves against the effective pool = existing + newcomers.
          const effectivePool = [...existingPool, ...addMembers];

          let targetType: FollowUpTargetType = 'all';
          let selectedMemberId: string | undefined;
          let selectedMemberIdList: string[] | undefined;

          if (opts.member) {
            const match = resolveMemberToken(effectivePool, opts.member);
            if (!match) {
              // Soft hint: the member exists & is active but isn't in this discussion.
              const elsewhere = resolveMemberToken(activeAll, opts.member);
              if (elsewhere && !selectedIds.has(elsewhere.id)) {
                throw new UserError(
                  `${elsewhere.name} isn't in this discussion.`,
                  `Bring them in with: aab discuss follow-up ${shortId(discussion.id)} "${question}" --add-member "${elsewhere.name}"`,
                );
              }
              throw new UserError(
                `No member matched "${opts.member}" in this discussion.`,
                `Members: ${effectivePool.map((m) => m.name).join(', ')}`,
              );
            }
            targetType = 'specific';
            selectedMemberId = match.id;
          } else if (opts.members) {
            const tokens = opts.members.split(',').map((t) => t.trim()).filter(Boolean);
            const matched: AdvisoryBoardMember[] = [];
            const unmatched: string[] = [];
            for (const tok of tokens) {
              const m = resolveMemberToken(effectivePool, tok);
              if (m) {
                if (!matched.some((x) => x.id === m.id)) matched.push(m);
              } else unmatched.push(tok);
            }
            if (unmatched.length > 0) {
              throw new UserError(
                `No member matched: ${unmatched.join(', ')}`,
                `Members: ${effectivePool.map((m) => m.name).join(', ')}`,
              );
            }
            if (matched.length < 2) {
              throw new UserError('--members needs at least two distinct members. Use --member for one, or --all for everybody.');
            }
            targetType = 'subset';
            selectedMemberIdList = matched.map((m) => m.id);
          }

          const projectRoot = opts.agentsDir ?? process.cwd();
          // Verify agent files for the EXISTING members we'll spawn (the engine
          // emits missing files for newcomers).
          const willSpawnExisting =
            targetType === 'all'
              ? existingPool
              : targetType === 'specific'
                ? existingPool.filter((m) => m.id === selectedMemberId)
                : existingPool.filter((m) => selectedMemberIdList!.includes(m.id));
          verifyAgentFiles(willSpawnExisting, projectRoot);

          if (!ctx.json) {
            const willSpawnAll =
              targetType === 'all'
                ? effectivePool
                : targetType === 'specific'
                  ? effectivePool.filter((m) => m.id === selectedMemberId)
                  : effectivePool.filter((m) => selectedMemberIdList!.includes(m.id));
            const targetLabel =
              targetType === 'all'
                ? `all (${willSpawnAll.length})`
                : willSpawnAll.map((m) => m.name).join(', ');
            process.stdout.write(`\n${c.brand('AI Advisory Board')}  ${c.hint('· follow-up to ' + shortId(discussion.id))}\n`);
            process.stdout.write(c.hint(`  question: ${question}\n`));
            process.stdout.write(c.hint(`  target:   ${targetLabel}\n`));
            if (addMembers.length > 0) {
              process.stdout.write(`  ${c.hint('adding:')} ${c.bold(addMembers.map((m) => m.name).join(', '))} ${c.hint('(catch-up: ' + catchUpMode + ')')}\n`);
            }
            process.stdout.write(c.hint(`  rounds:   ${discussion.rounds.length} so far · ${discussion.totalTurns}/${discussion.maxTurns} turns\n\n`));
          }

          const sp = spinner('orchestrator deciding...');
          sp.start();
          const result = await addFollowUpQuestion({
            discussion,
            question,
            members: activeAll,
            settings,
            storage: ctx.storage,
            projectRoot,
            targetType,
            selectedMemberId,
            selectedMemberIds: selectedMemberIdList,
            addMemberIds,
            catchUpMode,
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

function registerSpar(parent: Command): void {
  const spar = parent
    .command('spar <idOrShort>')
    .description('open a 1:1 deep-dive sparring session with a board member')
    .option('--member <name>', 'name, slug, or id of the member to spar with (required unless --resume)')
    .option('--round <n>', '1-based round number the anchor lives in', (v) => Number(v))
    .option('--turn <n>', '1-based turn number within that round', (v) => Number(v))
    .option('--message <text>', 'send one message non-interactively and exit')
    .option('--resume <sessionId>', 'resume an existing sparring session (id or short id)')
    .option('--title <text>', 'optional title for a brand-new session')
    .option('--agents-dir <path>', 'where .claude/agents/ lives (default: cwd)')
    .action(
      async (
        idOrShort: string,
        opts: {
          member?: string;
          round?: number;
          turn?: number;
          message?: string;
          resume?: string;
          title?: string;
          agentsDir?: string;
        },
      ) => {
        const ctx = await openContext(parent);
        try {
          const discussion = await resolveDiscussion(ctx.storage, idOrShort);
          const settings = await ctx.storage.loadSettings();
          const allMembers = await ctx.storage.loadBoardMembers();
          const projectRoot = opts.agentsDir ?? process.cwd();

          let session: SparringSession;
          let member: AdvisoryBoardMember | undefined;

          if (opts.resume) {
            const found = await resolveSparringSession(ctx.storage, discussion.id, opts.resume);
            session = found;
            member = allMembers.find((m) => m.id === found.memberId);
          } else {
            if (!opts.member) {
              throw new UserError(
                'pass --member <name> to open a sparring session (or --resume <sessionId>).',
                `Available members: ${allMembers.filter((m) => m.isActive).map((m) => m.name).join(', ')}`,
              );
            }
            member = resolveMemberToken(allMembers, opts.member);
            if (!member) {
              throw new UserError(`No member matched "${opts.member}".`);
            }
            const opened = await openSparringSession({
              discussion,
              member,
              anchorRoundNumber: opts.round,
              anchorTurnNumber: opts.turn,
              title: opts.title,
              storage: ctx.storage,
            });
            session = opened.session;
            if (!ctx.json) {
              process.stdout.write(
                `\n${c.brand('AI Advisory Board')}  ${c.hint(opened.reused ? '· resumed sparring' : '· new sparring')}\n`,
              );
              process.stdout.write(c.hint(`  member:   ${member.name}\n`));
              process.stdout.write(c.hint(`  anchor:   round ${session.anchorRoundNumber} · turn ${session.anchorTurnNumber}\n`));
              process.stdout.write(c.hint(`  session:  ${session.id.slice(0, 8)}\n\n`));
            }
          }

          if (!member) {
            throw new UserError(`No member with id ${session.memberId} exists anymore — cannot continue this session.`);
          }
          verifyAgentFiles([member], projectRoot);

          // Replay existing messages so resumed sessions feel continuous.
          if (!ctx.json && !opts.resume) {
            renderAnchor(session);
          }
          if (session.messages.length > 0 && !ctx.json) {
            process.stdout.write(c.hint(`  (replaying ${session.messages.length} prior message${session.messages.length === 1 ? '' : 's'})\n\n`));
            for (const m of session.messages) renderSparringMessage(m.role, m.content);
          }

          // --message mode: send one shot and exit.
          if (opts.message) {
            const trimmed = opts.message.trim();
            if (!trimmed) throw new UserError('--message cannot be empty.');
            const result = await runSparringTurn({
              session,
              member,
              discussion,
              userMessage: trimmed,
              settings,
              storage: ctx.storage,
              projectRoot,
              json: ctx.json,
            });
            if (ctx.json) {
              process.stdout.write(JSON.stringify({ session: result.session, reply: result.assistant }, null, 2) + '\n');
            }
            return;
          }

          // Interactive REPL.
          process.stdout.write(
            c.hint(`  Type your message and press Enter. 'exit' or Ctrl+C to leave.\n  Type 'inject <insight>' to write the latest reply back to the main timeline.\n\n`),
          );
          let keepGoing = true;
          while (keepGoing) {
            const userInput = await askText('you', {});
            const trimmed = userInput.trim();
            if (!trimmed) continue;
            if (/^(exit|quit|bye)$/i.test(trimmed)) {
              keepGoing = false;
              break;
            }
            if (trimmed.toLowerCase().startsWith('inject ')) {
              const insight = trimmed.slice('inject '.length).trim();
              if (!insight) {
                process.stdout.write(c.warn('  ! pass the insight text after `inject`.\n'));
                continue;
              }
              await runInjectInline({
                discussion,
                session,
                insight,
                storage: ctx.storage,
              });
              continue;
            }
            await runSparringTurn({
              session,
              member,
              discussion,
              userMessage: trimmed,
              settings,
              storage: ctx.storage,
              projectRoot,
              json: false,
            });
          }
          process.stdout.write(c.hint(`Sparring session ${session.id.slice(0, 8)} saved.\n`));
        } finally {
          await closeContext(ctx);
        }
      },
    );

  // Subcommands of `discuss spar` — `spar list` and `spar show` — must be
  // attached *after* the action above; commander prefers the action variant
  // when the first positional arg is an id-like string but routes `spar list`
  // to the list subcommand because `list` is not a discussion id.
  spar
    .command('list <discussionIdOrShort>')
    .description('list sparring sessions attached to a discussion')
    .action(async (discussionIdOrShort: string) => {
      const ctx = await openContext(parent, { lock: false });
      try {
        const discussion = await resolveDiscussion(ctx.storage, discussionIdOrShort);
        const sessions = await ctx.storage.loadSparringSessionsForDiscussion(discussion.id);
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ discussionId: discussion.id, sessions }, null, 2) + '\n');
          return;
        }
        if (sessions.length === 0) {
          process.stdout.write(c.hint(`  (no sparring sessions yet — run \`aab discuss spar ${shortId(discussion.id)} --member "<name>"\`)\n`));
          return;
        }
        process.stdout.write(
          `\n${c.brand('AI Advisory Board')}  ${c.hint('· ' + sessions.length + ' sparring session(s) on ' + shortId(discussion.id))}\n\n`,
        );
        for (const s of sessions) {
          const ts = new Date(s.updatedAt).toLocaleString();
          process.stdout.write(
            `  ${c.cyan(s.id.slice(0, 8))} ${c.hint(ts)} ${c.bold(s.memberName)} ${c.hint(`(round ${s.anchorRoundNumber} · turn ${s.anchorTurnNumber} · ${s.messages.length} msg${s.messages.length === 1 ? '' : 's'})`)}\n`,
          );
          if (s.title) process.stdout.write(`    ${c.hint('title:')} ${s.title}\n`);
        }
      } finally {
        await closeContext(ctx);
      }
    });

  spar
    .command('show <sessionIdOrShort>')
    .description('print a sparring session transcript')
    .action(async (sessionIdOrShort: string) => {
      const ctx = await openContext(parent, { lock: false });
      try {
        const session = await resolveSparringSessionAnywhere(ctx.storage, sessionIdOrShort);
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ session }, null, 2) + '\n');
          return;
        }
        process.stdout.write(
          `\n${c.bold(session.title ?? `1:1 with ${session.memberName}`)} ${c.hint('· ' + session.id.slice(0, 8))}\n`,
        );
        process.stdout.write(`  ${c.hint('member:')} ${session.memberName}\n`);
        process.stdout.write(`  ${c.hint('anchor:')} round ${session.anchorRoundNumber} · turn ${session.anchorTurnNumber}\n`);
        process.stdout.write(`  ${c.hint('messages:')} ${session.messages.length}\n\n`);
        renderAnchor(session);
        for (const m of session.messages) renderSparringMessage(m.role, m.content);
      } finally {
        await closeContext(ctx);
      }
    });
}

function registerInject(parent: Command): void {
  parent
    .command('inject <discussionIdOrShort>')
    .description('write a sparring-deep-dive insight back into the main timeline')
    .option('--from <sessionIdOrShort>', 'sparring session id to source from (required)')
    .option('--insight <text>', 'override the insight text (default: latest assistant reply)')
    .option('--yes', 'skip confirmation')
    .action(async (discussionIdOrShort: string, opts: { from?: string; insight?: string; yes?: boolean }) => {
      const ctx = await openContext(parent);
      try {
        const discussion = await resolveDiscussion(ctx.storage, discussionIdOrShort);
        if (!opts.from) {
          throw new UserError(
            'pass --from <sparringSessionId>.',
            `Run \`aab discuss spar list ${shortId(discussion.id)}\` to see available sessions.`,
          );
        }
        const session = await resolveSparringSession(ctx.storage, discussion.id, opts.from);

        let insight: string;
        if (opts.insight) {
          insight = opts.insight.trim();
        } else {
          const lastAssistant = [...session.messages].reverse().find((m) => m.role === 'assistant');
          if (!lastAssistant) {
            throw new UserError(
              'No assistant reply in this session yet to inject.',
              'Send a message first, or pass --insight "<text>" explicitly.',
            );
          }
          insight = lastAssistant.content.trim();
        }
        if (!insight) throw new UserError('Insight text cannot be empty.');

        if (!opts.yes && !ctx.json) {
          process.stdout.write(`${c.bold('Insight preview:')}\n${insight.slice(0, 500)}${insight.length > 500 ? '\n…(truncated for preview)' : ''}\n\n`);
          const ok = await askConfirm(
            `Inject this back into discussion ${shortId(discussion.id)} at round ${session.anchorRoundNumber}?`,
            true,
          );
          if (!ok) {
            process.stdout.write(c.hint('  aborted.\n'));
            return;
          }
        }

        const result = await injectSparringInsight({
          discussion,
          session,
          insight,
          storage: ctx.storage,
        });

        if (ctx.json) {
          process.stdout.write(
            JSON.stringify(
              { discussionId: result.discussion.id, injected: result.injectedUserResponse },
              null,
              2,
            ) + '\n',
          );
        } else {
          process.stdout.write(
            `${c.ok('✓')} injected insight into ${shortId(result.discussion.id)} at round ${result.injectedUserResponse.roundNumber}.\n`,
          );
        }
      } finally {
        await closeContext(ctx);
      }
    });
}

interface RunSparringTurnArgs {
  session: SparringSession;
  member: AdvisoryBoardMember;
  discussion: Discussion;
  userMessage: string;
  settings: Awaited<ReturnType<StorageService['loadSettings']>>;
  storage: StorageService;
  projectRoot: string;
  json: boolean;
}

async function runSparringTurn(args: RunSparringTurnArgs): Promise<{ session: SparringSession; assistant?: string }> {
  if (!args.json) {
    renderSparringMessage('user', args.userMessage);
  }
  const sp = spinner(`${args.member.name} thinking...`);
  sp.start();
  try {
    const result = await sendSparringMessage({
      session: args.session,
      member: args.member,
      discussion: args.discussion,
      userMessage: args.userMessage,
      settings: args.settings,
      storage: args.storage,
      projectRoot: args.projectRoot,
      onActivity: (event) => {
        sp.text = `${args.member.name} ${event.activity}${event.detail ? ' (' + truncateActivityDetail(event.detail) + ')' : ''}`;
      },
    });
    if (result.error || !result.assistantMsg) {
      sp.fail(`${args.member.name}: ${result.error ?? 'no response'}`);
      return { session: args.session };
    }
    sp.succeed(
      `${args.member.name} replied in ${formatDuration(result.durationMs)} (${formatUsd(result.costUsd)})${result.fellBackToPrimary ? c.warn(' · fell back to primary model') : ''}`,
    );
    if (!args.json) {
      renderSparringMessage(result.assistantMsg.role, result.assistantMsg.content);
    }
    return { session: args.session, assistant: result.assistantMsg.content };
  } catch (error) {
    sp.fail(`${args.member.name}: ${error instanceof Error ? error.message : String(error)}`);
    return { session: args.session };
  }
}

async function runInjectInline(args: {
  discussion: Discussion;
  session: SparringSession;
  insight: string;
  storage: StorageService;
}): Promise<void> {
  try {
    const result = await injectSparringInsight({
      discussion: args.discussion,
      session: args.session,
      insight: args.insight,
      storage: args.storage,
    });
    process.stdout.write(
      `${c.ok('✓')} injected insight into ${shortId(result.discussion.id)} at round ${result.injectedUserResponse.roundNumber}.\n`,
    );
  } catch (error) {
    process.stdout.write(c.warn(`  ! inject failed: ${error instanceof Error ? error.message : String(error)}\n`));
  }
}

async function resolveSparringSession(
  storage: StorageService,
  discussionId: string,
  sessionIdOrShort: string,
): Promise<SparringSession> {
  const direct = await storage.loadSparringSessionById(sessionIdOrShort);
  if (direct && direct.discussionId === discussionId) return direct;
  const sessions = await storage.loadSparringSessionsForDiscussion(discussionId);
  const matches = sessions.filter((s) => s.id.startsWith(sessionIdOrShort));
  if (matches.length === 0) {
    throw new UserError(`No sparring session matches "${sessionIdOrShort}" in discussion ${shortId(discussionId)}.`);
  }
  if (matches.length > 1) {
    throw new UserError(`Multiple sparring sessions match "${sessionIdOrShort}". Use a longer prefix.`);
  }
  return matches[0]!;
}

async function resolveSparringSessionAnywhere(
  storage: StorageService,
  sessionIdOrShort: string,
): Promise<SparringSession> {
  const direct = await storage.loadSparringSessionById(sessionIdOrShort);
  if (direct) return direct;
  // Try discussion-by-discussion (no global short-id index — fine because the
  // sparring/ tree is small and this is only the CLI fallback).
  const discussions = await storage.loadDiscussions();
  for (const d of discussions) {
    const sessions = await storage.loadSparringSessionsForDiscussion(d.id);
    const match = sessions.find((s) => s.id.startsWith(sessionIdOrShort));
    if (match) return match;
  }
  throw new UserError(`No sparring session matches "${sessionIdOrShort}".`);
}

function renderSparringMessage(role: 'user' | 'assistant', content: string): void {
  if (role === 'user') {
    process.stdout.write(`${c.cyan('you:')}\n${content}\n\n`);
  } else {
    process.stdout.write(`${c.green('member:')}\n${content}\n\n`);
  }
}

function renderAnchor(session: SparringSession): void {
  process.stdout.write(`${c.bold('Anchor')} ${c.hint('· round ' + session.anchorRoundNumber + ' · turn ' + session.anchorTurnNumber)}\n`);
  process.stdout.write(`${c.hint(session.anchorResponsePreview)}\n\n`);
}

function truncateActivityDetail(detail: string): string {
  const t = detail.trim();
  return t.length > 60 ? t.slice(0, 57) + '…' : t;
}

// ---------------- helpers ----------------

/** commander accumulator for a repeatable option (`--add-member a --add-member b`). */
function collectRepeat(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function normalizeCatchUp(raw: string | undefined): 'full' | 'summary' | 'fresh' {
  if (raw === undefined) return 'full';
  const v = raw.trim().toLowerCase();
  if (v === 'full' || v === 'summary' || v === 'fresh') return v;
  throw new UserError(`Unknown --catch-up mode "${raw}".`, 'Use one of: full | summary | fresh.');
}

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

export function resolveMemberToken(pool: AdvisoryBoardMember[], token: string): AdvisoryBoardMember | undefined {
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
