/**
 * Shared fixtures for the solve-orchestrator stub-mode tests.
 *
 * NOT a `*.test.ts` file (so Vitest never runs it as a suite). It exists so the
 * heavy stub-mode tests can be split across multiple test files without
 * duplicating setup — each file blocks its worker for ~30s instead of one file
 * blocking ~90s and tripping Vitest's worker "onTaskUpdate" RPC timeout on slow
 * CI runners. See PR #34 CI investigation (2026-06-15).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorageService } from '../../../storage/fs-storage-service.js';
import type { ResolvedWorkspace } from '../../../storage/paths.js';
import { DEFAULT_SETTINGS, type ActionItem, type AppSettings } from '../../../storage/types.js';

export interface SolveEnv {
  ws: ResolvedWorkspace;
  storage: FsStorageService;
  projectRoot: string;
}

export function fakeWorkspace(): ResolvedWorkspace {
  const dir = mkdtempSync(join(tmpdir(), 'aab-solve-'));
  return { id: 'test', root: dir, scope: 'home' };
}

/**
 * Fresh workspace + storage + a project root seeded with a stub skill-creator
 * so the precondition passes. Call in `beforeEach`.
 */
export function setupSolveEnv(): SolveEnv {
  const ws = fakeWorkspace();
  const storage = new FsStorageService(ws);
  const projectRoot = mkdtempSync(join(tmpdir(), 'aab-solve-project-'));
  const scDir = join(projectRoot, '.claude', 'skills', 'skill-creator');
  mkdirSync(scDir, { recursive: true });
  writeFileSync(join(scDir, 'SKILL.md'), '---\nname: skill-creator\nversion: 0.0.1-stub\n---\nstub');
  return { ws, storage, projectRoot };
}

/** Best-effort cleanup. Call in `afterEach`. Windows EPERM tmp leaks are harmless. */
export function teardownSolveEnv(env: SolveEnv | undefined): void {
  if (!env) return;
  try { rmSync(env.ws.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* tmp leak */ }
  try { rmSync(env.projectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* tmp leak */ }
}

export async function seedAction(storage: FsStorageService): Promise<ActionItem> {
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

export function solveSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS };
}
