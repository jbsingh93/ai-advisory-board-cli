/**
 * Persistence — Phase 5 Chunk 4. Per PLAN/SKILL_CREATOR.md §11.
 *
 * Writes a `SkillGenerationRun` JSON (with the full Planner proposal +
 * capability profile embedded in metadata) under
 * `~/.aabcli/<ws>/skill-runs/<actionItemId>/<runId>.json`, then updates
 * `ActionItem.linkedSkill` + `skillRunHistory[]`.
 *
 * The workspace tempdir (containing skill-creator's emitted SKILL.md
 * package) is preserved when `preserveWorkspaceOnSuccess: true` or always
 * on failure for post-mortem.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ActionItem,
  SkillGenerationRun,
  StorageService,
} from '../../storage/types.js';
import { nowIso } from '../utils.js';
import { paths } from '../../storage/paths.js';
import type { ResolvedSkillCapabilityProfile } from './planner-review.js';
import type { EmittedFile } from './invoke-skill-creator.js';

export interface PersistRunOptions {
  storage: StorageService;
  workspaceRoot: string;
  action: ActionItem;
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  costUsd: number;
  cacheHitRate: number;
  durationMs: number;
  files: EmittedFile[];
  installPath?: string;
  capabilityProfile: ResolvedSkillCapabilityProfile;
  toolCallCount?: number;
  /** Default 5 (sage-council parity). */
  retainWorkspace?: boolean;
  workspaceDir?: string;
  /** Default: status === 'completed' ? 'in-progress' : action.status. */
  newActionStatus?: ActionItem['status'];
}

export interface PersistRunResult {
  run: SkillGenerationRun;
  updatedAction: ActionItem;
}

export async function persistSkillRun(opts: PersistRunOptions): Promise<PersistRunResult> {
  const cp = opts.capabilityProfile;
  const run: SkillGenerationRun = {
    id: opts.runId,
    actionItemId: opts.action.id,
    status: opts.status,
    startedAt: opts.startedAt,
    completedAt: nowIso(),
    costUsd: opts.costUsd,
    cacheHitRate: opts.cacheHitRate,
    durationMs: opts.durationMs,
    files: opts.files.map((f) => ({ path: f.path, content: f.content })),
    installPath: opts.installPath,
    metadata: {
      skillName: cp.proposal.skillName,
      // Embed the FULL Planner proposal + capability profile + recon
      // summary in `metadata.confirmedCapabilityProfile` so future
      // `aab actions runs show <run-id>` invocations can re-render
      // everything without losing fidelity.
      confirmedCapabilityProfile: {
        generatedAt: cp.generatedAt,
        microSteps: [],
        requiredCapabilities: [],
        confirmedAvailableCapabilityIds: cp.acceptedIntegrationIds,
        unavailableCapabilityIds: cp.rejectedIntegrationIds,
        fallbackPlans: [],
        notes: cp.userNarrativeEdits,
      },
      agentEnvironment: {
        targetPlatform: 'claude-code',
        mcpServers: cp.recon.pc.mcpServers.map((m) => m.name),
        cliTools: cp.recon.pc.cliTools.map((t) => t.name),
        envVariables: cp.recon.pc.envVars,
      },
      decompositionSubtaskCount: cp.proposal.integrations.length,
      researchSourceCount: cp.recon.web.bestPracticePatterns.reduce((acc, p) => acc + p.sources.length, 0),
      singleLoopTurnCount: opts.toolCallCount,
      // Surface the Planner proposal as a stringified attachment for
      // downstream re-render. The schema's `passthrough()` accepts it.
      ...({ plannerProposal: cp.proposal } as Record<string, unknown>),
    },
  };

  await opts.storage.saveSkillRun(run);

  // Update the ActionItem.
  const newAction: ActionItem = {
    ...opts.action,
    status: opts.newActionStatus ?? (opts.status === 'completed' ? 'in-progress' : opts.action.status),
    linkedSkill: opts.installPath && opts.status === 'completed'
      ? {
          name: cp.proposal.skillName,
          runId: opts.runId,
          installedAt: nowIso(),
          installPath: opts.installPath,
        }
      : opts.action.linkedSkill,
    skillRunHistory: [opts.runId, ...(opts.action.skillRunHistory ?? [])].slice(0, 50),
    updatedAt: nowIso(),
  };
  await opts.storage.updateActionItem(newAction);

  // Write the proposal as a side-by-side .md artifact for `aab actions runs
  // export` convenience. Filename ends in .md (NOT .json) so loadSkillRuns'
  // *.json glob doesn't pick it up as another SkillGenerationRun.
  const runDir = join(paths(opts.workspaceRoot).skillRuns, opts.action.id);
  if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, `${opts.runId}.proposal.md`),
    JSON.stringify(cp.proposal, null, 2),
    'utf8',
  );

  // Workspace cleanup (default: preserve on failure, archive on success).
  if (opts.workspaceDir && existsSync(opts.workspaceDir)) {
    const preserve = opts.retainWorkspace ?? opts.status !== 'completed';
    if (!preserve) {
      try {
        rmSync(opts.workspaceDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  return { run, updatedAction: newAction };
}
