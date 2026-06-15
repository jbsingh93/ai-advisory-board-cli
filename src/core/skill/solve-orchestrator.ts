/**
 * `aab actions solve` orchestrator — Phase 5 Chunk 4 entry point.
 *
 * Chains the four pipeline phases:
 *   1. preconditions  (skill-creator installed; action exists; linked discussion if any)
 *   2. recon          (PC scan + wiki recon + web research — orchestrator.ts)
 *   3. planner        (Opus reasoning → SkillDesignProposal — planner.ts)
 *   4. review         (interactive CLI / GUI proposal acceptance — planner-review.ts)
 *   5. brief          (assemble JSON for skill-creator — build-brief.ts)
 *   6. skill-creator  (headless invocation — invoke-skill-creator.ts)
 *   7. adapter        (frontmatter normalization — adapter.ts)
 *   8. install        (cp → .claude/skills/<name>/ — install.ts)
 *   9. persist        (SkillGenerationRun + ActionItem.linkedSkill — persist-run.ts)
 *
 * Streams events for the WS broadcast layer + telemetry sink.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ActionItem,
  AppSettings,
  ConversationSummary,
  StorageService,
} from '../../storage/types.js';
import type { ResolvedWorkspace } from '../../storage/paths.js';
import { paths } from '../../storage/paths.js';
import { generateUUID, nowIso } from '../utils.js';
import { logger } from '../logger.js';
import { UserError, BudgetError, CancelledError } from '../errors.js';
import { resolveSkillCreator } from './resolve-skill-creator.js';
import { runRecon, type ReconTriple } from './recon/orchestrator.js';
import { runPlanner } from './planner.js';
import { reviewInteractive, acceptAll, type PlannerReviewResult, type ResolvedSkillCapabilityProfile } from './planner-review.js';
import { buildSkillCreatorBrief } from './build-brief.js';
import { invokeSkillCreator, stubSkillCreatorRun, type InvokeSkillCreatorResult } from './invoke-skill-creator.js';
import { adaptSkillPackage } from './adapter.js';
import { installSkillPackage } from './install.js';
import { persistSkillRun } from './persist-run.js';
import type { SkillDesignProposal } from '../parsing/llm-response-schemas.js';

export interface SolveEvent {
  type:
    | 'preflight'
    | 'planner_started'
    | 'planner_recon_progress'
    | 'planner_recon_done'
    | 'planner_reasoning_started'
    | 'planner_proposal_ready'
    | 'planner_failed'
    | 'review_replan'
    | 'skill_run_started'
    | 'skill_run_step'
    | 'skill_run_tool_call'
    | 'skill_run_adapter_diff'
    | 'skill_run_installed'
    | 'skill_run_failed'
    | 'skill_run_cancelled';
  payload?: Record<string, unknown>;
}

export interface SolveOptions {
  workspace: ResolvedWorkspace;
  settings: AppSettings;
  storage: StorageService;
  action: ActionItem;
  discussionSummary?: ConversationSummary;
  /** When true, accept the Planner's recommended tier + all integrations + dry-run preview. */
  yes?: boolean;
  /** Skip the Skill Planner entirely (--no-planner). */
  noPlanner?: boolean;
  plannerTierCap?: 'minimal' | 'standard' | 'maximalist';
  skipPcScan?: boolean;
  skipWiki?: boolean;
  skipWeb?: boolean;
  /** Opt-in full-disk crawl during the PC scan (blocks; default off). */
  pcDeepScan?: boolean;
  /** Skip the skill-creator headless call — useful for `aab actions plan`. */
  planOnly?: boolean;
  /** Stub the skill-creator emit (test mode). */
  stub?: boolean;
  skillName?: string;
  /** Default 'project'. */
  scope?: 'project' | 'user';
  installPath?: string;
  noInstall?: boolean;
  projectRoot?: string;
  budgetCapUsd?: number;
  onEvent?: (event: SolveEvent) => void;
  /** Inject a previously-accepted profile (e.g., when invoked from the GUI). */
  preAcceptedProfile?: ResolvedSkillCapabilityProfile;
  /** Custom run id (otherwise generated). */
  runId?: string;
  /** Cancellation — aborts recon/planner `claude` children and stops the
   *  pipeline at the next phase boundary (throws CancelledError). */
  signal?: AbortSignal;
}

export interface SolveResult {
  runId: string;
  proposal: SkillDesignProposal;
  capabilityProfile: ResolvedSkillCapabilityProfile;
  /** Present only when planOnly !== true. */
  skillRun?: InvokeSkillCreatorResult;
  installPath?: string;
  status: 'plan-only' | 'completed' | 'rejected' | 'failed';
  costUsd: number;
  durationMs: number;
}

export async function runSolve(opts: SolveOptions): Promise<SolveResult> {
  const started = Date.now();
  const runId = opts.runId ?? generateUUID();
  const skillName = opts.skillName ?? deriveSkillName(opts.action.title);
  const projectRoot = opts.projectRoot ?? process.cwd();
  opts.onEvent?.({ type: 'preflight', payload: { runId, skillName } });

  // 0. preconditions
  if (!opts.planOnly) {
    const sc = resolveSkillCreator({ projectRoot });
    if (!sc) {
      throw new UserError(
        'skill-creator skill not installed',
        'Run `aab init --install-skill-creator` for instructions.',
      );
    }
  }

  // 1. recon — skip entirely when noPlanner + no preAcceptedProfile (the
  // minimal-fallback profile doesn't depend on recon). Also short-circuit
  // wiki + web phases to PC-only when a profile was pre-accepted (used by
  // the GUI when the proposal was generated separately).
  opts.onEvent?.({ type: 'planner_started', payload: { runId } });
  // Recon progress → WS. Emits 'running' when a phase starts, 'running' + detail
  // for sub-steps (web 'app 2/5'), and 'done' the moment each phase settles — so
  // the UI never leaves wiki/web on 'queued' for the whole parallel block.
  const reconCallbacks = {
    onPhaseStart: (phase: 'pc-scan' | 'wiki-recon' | 'web-research') =>
      opts.onEvent?.({ type: 'planner_recon_progress', payload: { runId, phase, status: 'running' } }),
    onPhaseProgress: (phase: 'pc-scan' | 'wiki-recon' | 'web-research', detail: string) =>
      opts.onEvent?.({ type: 'planner_recon_progress', payload: { runId, phase, status: 'running', detail } }),
    onPhaseDone: (phase: 'pc-scan' | 'wiki-recon' | 'web-research', summary: string) =>
      opts.onEvent?.({ type: 'planner_recon_progress', payload: { runId, phase, status: 'done', summary } }),
  };
  const reconNeeded = !opts.preAcceptedProfile && !opts.noPlanner;
  let recon: ReconTriple;
  if (!reconNeeded && opts.preAcceptedProfile) {
    recon = opts.preAcceptedProfile.recon;
  } else if (!reconNeeded) {
    // noPlanner without a pre-accepted profile — synthesize an empty triple.
    recon = await runRecon({
      workspace: opts.workspace,
      settings: opts.settings,
      actionTitle: opts.action.title,
      actionDescription: opts.action.description,
      skipPcScan: opts.skipPcScan,
      skipWiki: true,
      skipWeb: true,
      signal: opts.signal,
      ...reconCallbacks,
    });
  } else {
    recon = await runRecon({
      workspace: opts.workspace,
      settings: opts.settings,
      actionTitle: opts.action.title,
      actionDescription: opts.action.description,
      discussionSummary: opts.discussionSummary
        ? `${opts.discussionSummary.keyPoints?.join(' | ') ?? ''}`.slice(0, 2000)
        : undefined,
      skipPcScan: opts.skipPcScan,
      skipWiki: opts.skipWiki,
      skipWeb: opts.skipWeb,
      pcDeepScan: opts.pcDeepScan,
      signal: opts.signal,
      ...reconCallbacks,
    });
  }
  // Cancellation checkpoint — recon phases swallow an aborted claude into a
  // degraded result, so stop here before burning an Opus reasoning call.
  if (opts.signal?.aborted) throw new CancelledError('Plan cancelled by user.');
  opts.onEvent?.({ type: 'planner_recon_done', payload: { runId, recon: summarizeReconForEvent(recon) } });

  // 2. planner
  let capabilityProfile: ResolvedSkillCapabilityProfile;
  if (opts.preAcceptedProfile) {
    capabilityProfile = opts.preAcceptedProfile;
  } else if (opts.noPlanner) {
    // Fast path: synthesize a minimal-tier capability profile without Opus.
    capabilityProfile = synthesizeMinimalProfile(opts.action, recon, skillName);
  } else {
    opts.onEvent?.({ type: 'planner_reasoning_started', payload: { runId } });
    let replanFeedback: string | undefined;
    let attempts = 0;
    const MAX_REPLANS = 3;
    while (attempts <= MAX_REPLANS) {
      attempts++;
      if (opts.signal?.aborted) throw new CancelledError('Plan cancelled by user.');
      let plannerResult;
      try {
        plannerResult = await runPlanner({
          workspace: opts.workspace,
          settings: opts.settings,
          action: opts.action,
          discussionSummary: opts.discussionSummary,
          recon,
          maxTier: opts.plannerTierCap ?? 'maximalist',
          userReplanFeedback: replanFeedback,
          signal: opts.signal,
        });
      } catch (err) {
        // A cancelled run kills the Opus child mid-call → surfaces as an error.
        // Don't fire planner_failed for that; let the CancelledError propagate
        // so the caller reports a clean cancellation.
        if (opts.signal?.aborted) throw new CancelledError('Plan cancelled by user.');
        opts.onEvent?.({ type: 'planner_failed', payload: { runId, error: err instanceof Error ? err.message : String(err) } });
        throw err;
      }
      opts.onEvent?.({ type: 'planner_proposal_ready', payload: { runId, proposal: plannerResult.proposal } });
      const review: PlannerReviewResult = opts.yes
        ? acceptAll(plannerResult.proposal, recon)
        : await reviewInteractive({ proposal: plannerResult.proposal, recon, autoAccept: false });
      if (review.status === 'rejected') {
        return {
          runId,
          proposal: plannerResult.proposal,
          capabilityProfile: acceptAll(plannerResult.proposal, recon).profile!,
          status: 'rejected',
          costUsd: plannerResult.costUsd,
          durationMs: Date.now() - started,
        };
      }
      if (review.status === 'replan') {
        replanFeedback = review.replanFeedback;
        opts.onEvent?.({ type: 'review_replan', payload: { runId, attempts } });
        continue;
      }
      capabilityProfile = review.profile!;
      break;
    }
    if (!capabilityProfile!) {
      throw new UserError('Re-plan loop exhausted (max 3).', 'Accept a proposal or cancel.');
    }
  }

  // Budget cap enforcement on the projected total cost (Planner + skill-creator).
  const projectedTotal = (capabilityProfile.proposal.estimatedCostUsd ?? 2.2);
  if (opts.budgetCapUsd && projectedTotal > opts.budgetCapUsd) {
    throw new BudgetError(
      `Projected solve cost $${projectedTotal.toFixed(2)} exceeds budget cap $${opts.budgetCapUsd}.`,
      'Re-run with --planner-no-web or --planner-tier standard to reduce scope.',
    );
  }

  // Plan-only exit.
  if (opts.planOnly) {
    return {
      runId,
      proposal: capabilityProfile.proposal,
      capabilityProfile,
      status: 'plan-only',
      costUsd: recon.costUsd,
      durationMs: Date.now() - started,
    };
  }

  // 3. brief
  const workspacePaths = paths(opts.workspace.root);
  const workspaceDir = join(workspacePaths.skillRuns, opts.action.id, runId, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });

  const installTargetPath = opts.installPath ?? (opts.scope === 'user'
    ? join(homedir(), '.claude', 'skills', skillName)
    : join(projectRoot, '.claude', 'skills', skillName));
  const { brief } = buildSkillCreatorBrief({
    action: opts.action,
    capabilityProfile,
    discussionSummary: opts.discussionSummary,
    installTarget: {
      scope: opts.scope ?? 'project',
      path: installTargetPath,
      skillName,
    },
  });

  // 4. skill-creator
  opts.onEvent?.({ type: 'skill_run_started', payload: { runId, skillName } });
  let result: InvokeSkillCreatorResult;
  try {
    if (opts.stub) {
      result = stubSkillCreatorRun({ brief, workspaceDir });
    } else {
      result = await invokeSkillCreator({
        brief,
        workspaceDir,
        projectRoot,
        onEvent: (evt) => {
          if (evt.type === 'assistant' && evt.message?.content) {
            for (const part of evt.message.content) {
              if (part.type === 'tool_use') {
                opts.onEvent?.({ type: 'skill_run_tool_call', payload: { runId, tool: part.name, input: part.input } });
              }
            }
          }
        },
        onTelemetry: (line) => {
          const tlPath = join(workspacePaths.skillRuns, opts.action.id, runId, 'telemetry.jsonl');
          try {
            mkdirSync(join(workspacePaths.skillRuns, opts.action.id, runId), { recursive: true });
            writeFileSync(tlPath, JSON.stringify(line) + '\n', { flag: 'a' });
          } catch {
            // best-effort
          }
        },
      });
    }
  } catch (err) {
    opts.onEvent?.({ type: 'skill_run_failed', payload: { runId, error: err instanceof Error ? err.message : String(err) } });
    await persistSkillRun({
      storage: opts.storage,
      workspaceRoot: opts.workspace.root,
      action: opts.action,
      runId,
      status: 'failed',
      startedAt: new Date(started).toISOString(),
      costUsd: recon.costUsd,
      cacheHitRate: 0,
      durationMs: Date.now() - started,
      files: [],
      capabilityProfile,
      workspaceDir,
    });
    throw err;
  }

  if (!result.hasSkillMd) {
    opts.onEvent?.({ type: 'skill_run_failed', payload: { runId, reason: 'no SKILL.md emitted' } });
  }

  // 5. adapter
  const adapter = adaptSkillPackage({
    files: result.files,
    grantedTools: capabilityProfile.grantedTools,
    skillName,
    actionTitle: opts.action.title,
    actionDescription: opts.action.description,
  });
  opts.onEvent?.({ type: 'skill_run_adapter_diff', payload: { runId, diff: adapter.diff, warnings: adapter.warnings } });

  // 6. install
  let installPath: string | undefined;
  if (!opts.noInstall) {
    const inst = await installSkillPackage({
      files: adapter.files,
      skillName,
      scope: opts.scope,
      projectRoot,
      yes: opts.yes,
      workspaceRoot: opts.workspace.root,
      runId,
      actionItemId: opts.action.id,
    });
    installPath = inst.installPath;
    opts.onEvent?.({ type: 'skill_run_installed', payload: { runId, installPath, conflictAction: inst.conflictAction, archivedTo: inst.archivedTo } });
  }

  // 7. persist
  const totalCost = recon.costUsd + result.costUsd;
  await persistSkillRun({
    storage: opts.storage,
    workspaceRoot: opts.workspace.root,
    action: opts.action,
    runId,
    status: 'completed',
    startedAt: new Date(started).toISOString(),
    costUsd: totalCost,
    cacheHitRate: 0,
    durationMs: Date.now() - started,
    files: adapter.files,
    installPath,
    capabilityProfile,
    toolCallCount: result.toolCallCount,
    workspaceDir,
    retainWorkspace: opts.settings ? Boolean((opts.settings as unknown as { skill?: { preserveWorkspaceOnSuccess?: boolean } }).skill?.preserveWorkspaceOnSuccess) : false,
  });

  return {
    runId,
    proposal: capabilityProfile.proposal,
    capabilityProfile,
    skillRun: result,
    installPath,
    status: 'completed',
    costUsd: totalCost,
    durationMs: Date.now() - started,
  };
}

export function deriveSkillName(actionTitle: string): string {
  return actionTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'skill';
}

function synthesizeMinimalProfile(action: ActionItem, recon: ReconTriple, skillName: string): ResolvedSkillCapabilityProfile {
  const proposal: SkillDesignProposal = {
    skillName,
    skillSummary: action.title,
    triggerLanguage: `Use when ${action.title}`,
    tiers: {
      minimal: { name: 'minimal', description: 'Produce a markdown artifact only.', estimatedValueScore: 20 },
      standard: { name: 'standard', description: '(planner skipped)', estimatedValueScore: 0 },
      maximalist: { name: 'maximalist', description: '(planner skipped)', estimatedValueScore: 0 },
    },
    recommendedTier: 'minimal',
    integrations: [
      {
        id: 'write-md',
        source: 'wiki-entity',
        name: 'Write markdown artifact',
        invocationHint: { kind: 'write-artifact', tools: ['Write'], artifactPath: 'references/output.md' },
        requiredTools: ['Write'],
      },
    ],
    vetoes: [],
    valueRationale: '--no-planner used; minimal-tier fallback. Re-run without --no-planner for the agentic flow.',
  };
  return {
    generatedAt: nowIso(),
    proposal,
    acceptedTier: 'minimal',
    acceptedIntegrationIds: ['write-md'],
    rejectedIntegrationIds: [],
    acceptedStakeholderNames: [],
    grantedTools: ['Read', 'Write', 'Glob', 'Grep'],
    recon,
  };
}

function summarizeReconForEvent(recon: ReconTriple): Record<string, unknown> {
  return {
    apps: recon.pc.apps.length,
    cliTools: recon.pc.cliTools.length,
    mcpServers: recon.pc.mcpServers.length,
    wikiPages: recon.wiki.relevantPages.length,
    stakeholders: recon.wiki.stakeholders.length,
    webPatterns: recon.web.bestPracticePatterns.length,
    appSurfaces: recon.web.appIntegrationSurfaces.length,
    warnings: recon.warnings.length,
    costUsd: recon.costUsd,
    durationMs: recon.durationMs,
  };
}

// Silence unused
void logger;
