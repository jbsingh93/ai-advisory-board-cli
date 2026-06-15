/**
 * solve-orchestrator end-to-end test with stub mode (part 1 of 2).
 *
 * Verifies that --no-planner --stub --yes drives the full chain (preflight →
 * brief → stub skill-creator → adapter → install → persist) without hitting
 * any real Claude calls. The stub path is the same code path the GUI uses
 * once it has a pre-accepted Planner proposal, so this also covers that.
 *
 * The stub-mode tests are split across two files (this one + `*-modes.test.ts`)
 * so no single test file blocks its worker long enough to trip Vitest's
 * "onTaskUpdate" RPC timeout on slow CI runners. Shared setup lives in
 * `solve-orchestrator-fixtures.ts`.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSolve, deriveSkillName } from '../solve-orchestrator.js';
import {
  setupSolveEnv,
  teardownSolveEnv,
  seedAction,
  solveSettings,
  type SolveEnv,
} from './solve-orchestrator-fixtures.js';

describe('deriveSkillName', () => {
  it('produces kebab-case ≤60 chars from a title', () => {
    expect(deriveSkillName('Record YouTube Intro for Q3 launch')).toBe('record-youtube-intro-for-q3-launch');
  });
  it('strips punctuation', () => {
    expect(deriveSkillName("Mads's brief: ship!")).toBe('madss-brief-ship');
  });
  it('falls back to "skill" on empty', () => {
    expect(deriveSkillName('   ')).toBe('skill');
  });
});

describe('runSolve — stub mode (install + preconditions)', () => {
  let env: SolveEnv;

  beforeEach(() => {
    env = setupSolveEnv();
  });

  afterEach(() => {
    teardownSolveEnv(env);
  });

  it('runs --no-planner --stub --yes end-to-end and produces an installed skill', async () => {
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
      projectRoot,
    });
    expect(result.status).toBe('completed');
    expect(result.installPath).toContain('.claude');
    expect(result.installPath).toContain('record-youtube-intro-for-q3-launch');
    // Installed SKILL.md exists and matches grantedTools
    expect(existsSync(join(result.installPath!, 'SKILL.md'))).toBe(true);
    const body = readFileSync(join(result.installPath!, 'SKILL.md'), 'utf8');
    expect(body).toContain('name: record-youtube-intro-for-q3-launch');
    expect(body).toContain('model: inherit');
    // Sidecar provenance — per T3.9 lives at <workspaceRoot>/skill-runs/<runId>/installed-at.json
    // (NOT inside the installed skill dir; NOT under the action id).
    expect(existsSync(join(ws.root, 'skill-runs', result.runId, 'installed-at.json'))).toBe(true);
    // SkillGenerationRun persisted + linkedSkill updated
    const runs = await storage.loadSkillRuns(action.id);
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe('completed');
    expect(runs[0]!.metadata.skillName).toBe('record-youtube-intro-for-q3-launch');
    const updatedAction = (await storage.loadActionItems()).find((a) => a.id === action.id);
    expect(updatedAction?.linkedSkill?.name).toBe('record-youtube-intro-for-q3-launch');
    expect(updatedAction?.skillRunHistory).toContain(result.runId);
  });

  it('rejects when skill-creator is not installed in --solve (no --plan-only)', async () => {
    const { ws, storage, projectRoot } = env;
    rmSync(join(projectRoot, '.claude'), { recursive: true, force: true });
    // Isolate HOME so the resolver doesn't walk into the real user's
    // ~/.claude/plugins/marketplaces/... and find a globally-installed
    // skill-creator. We point HOME at an empty tmp dir for the duration of
    // this test, then restore.
    const isolatedHome = mkdtempSync(join(tmpdir(), 'aab-solve-isolated-home-'));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;
    try {
      const action = await seedAction(storage);
      await expect(
        runSolve({
          workspace: ws,
          settings: solveSettings(),
          storage,
          action,
          noPlanner: true,
          stub: true,
          yes: true,
          projectRoot,
        }),
      ).rejects.toThrow(/skill-creator/);
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
      if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile; else delete process.env.USERPROFILE;
      try { rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* tmp leak */ }
    }
  });
});
