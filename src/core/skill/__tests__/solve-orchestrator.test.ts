/**
 * solve-orchestrator end-to-end test with stub mode.
 *
 * Verifies that --no-planner --stub --yes drives the full chain (preflight →
 * brief → stub skill-creator → adapter → install → persist) without hitting
 * any real Claude calls. The stub path is the same code path the GUI uses
 * once it has a pre-accepted Planner proposal, so this also covers that.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSolve, deriveSkillName } from '../solve-orchestrator.js';
import { FsStorageService } from '../../../storage/fs-storage-service.js';
import type { ResolvedWorkspace } from '../../../storage/paths.js';
import type { ActionItem, AppSettings } from '../../../storage/types.js';
import { DEFAULT_SETTINGS } from '../../../storage/types.js';

function fakeWorkspace(): ResolvedWorkspace {
  const dir = mkdtempSync(join(tmpdir(), 'aab-solve-'));
  return { id: 'test', root: dir, scope: 'home' };
}

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

describe('runSolve — stub mode (no real Claude calls)', () => {
  let ws: ResolvedWorkspace;
  let storage: FsStorageService;
  let projectRoot: string;

  beforeEach(() => {
    ws = fakeWorkspace();
    storage = new FsStorageService(ws);
    projectRoot = mkdtempSync(join(tmpdir(), 'aab-solve-project-'));
    // Seed a fake skill-creator at project scope so the precondition passes.
    const scDir = join(projectRoot, '.claude', 'skills', 'skill-creator');
    mkdirSync(scDir, { recursive: true });
    writeFileSync(
      join(scDir, 'SKILL.md'),
      '---\nname: skill-creator\nversion: 0.0.1-stub\n---\nstub',
    );
  });

  afterEach(() => {
    try { rmSync(ws.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* tmp leak on Windows EPERM is harmless */ }
    try { rmSync(projectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* same */ }
  });

  async function seedAction(): Promise<ActionItem> {
    const item: ActionItem = {
      id: 'action-id-12345678',
      title: 'Record YouTube intro for Q3 launch',
      description: 'Need a 3-min intro for the launch landing page',
      priority: 'high',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await storage.saveActionItem(item);
    return item;
  }

  function settings(): AppSettings {
    return { ...DEFAULT_SETTINGS };
  }

  it('runs --no-planner --stub --yes end-to-end and produces an installed skill', async () => {
    const action = await seedAction();
    const result = await runSolve({
      workspace: ws,
      settings: settings(),
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

  it('runs plan-only (no install, no skill-creator call) with the synthesized minimal profile', async () => {
    const action = await seedAction();
    const result = await runSolve({
      workspace: ws,
      settings: settings(),
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
    const action = await seedAction();
    const result = await runSolve({
      workspace: ws,
      settings: settings(),
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

  it('rejects when skill-creator is not installed in --solve (no --plan-only)', async () => {
    rmSync(join(projectRoot, '.claude'), { recursive: true, force: true });
    const action = await seedAction();
    await expect(
      runSolve({
        workspace: ws,
        settings: settings(),
        storage,
        action,
        noPlanner: true,
        stub: true,
        yes: true,
        projectRoot,
      }),
    ).rejects.toThrow(/skill-creator/);
  });
});
