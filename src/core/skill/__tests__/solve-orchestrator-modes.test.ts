/**
 * solve-orchestrator stub-mode tests (part 2 of 2): plan-only and --no-install.
 *
 * Split from `solve-orchestrator.test.ts` so neither file blocks its worker
 * long enough to trip Vitest's "onTaskUpdate" RPC timeout on slow CI runners.
 * Shared setup lives in `solve-orchestrator-fixtures.ts`.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { runSolve } from '../solve-orchestrator.js';
import {
  setupSolveEnv,
  teardownSolveEnv,
  seedAction,
  solveSettings,
  type SolveEnv,
} from './solve-orchestrator-fixtures.js';

describe('runSolve — stub mode (plan-only + no-install)', () => {
  let env: SolveEnv;

  beforeEach(() => {
    env = setupSolveEnv();
  });

  afterEach(() => {
    teardownSolveEnv(env);
  });

  it('runs plan-only (no install, no skill-creator call) with the synthesized minimal profile', async () => {
    const { ws, storage, projectRoot } = env;
    const action = await seedAction(storage);
    const result = await runSolve({
      workspace: ws,
      settings: solveSettings(),
      storage,
      action,
      noPlanner: true,
      planOnly: true,
      projectRoot,
    });
    expect(result.status).toBe('plan-only');
    expect(result.installPath).toBeUndefined();
    expect(result.proposal.skillName).toBe('record-youtube-intro-for-q3-launch');
    // No skill run was persisted
    const runs = await storage.loadSkillRuns(action.id);
    expect(runs.length).toBe(0);
  });

  it('--no-install builds but skips the cp step', async () => {
    const { ws, storage, projectRoot } = env;
    const action = await seedAction(storage);
    const result = await runSolve({
      workspace: ws,
      settings: solveSettings(),
      storage,
      action,
      noPlanner: true,
      stub: true,
      yes: true,
      noInstall: true,
      projectRoot,
    });
    expect(result.status).toBe('completed');
    expect(result.installPath).toBeUndefined();
    // run was persisted but linkedSkill is NOT set on the action.
    const updatedAction = (await storage.loadActionItems()).find((a) => a.id === action.id);
    expect(updatedAction?.linkedSkill).toBeUndefined();
  });
});
