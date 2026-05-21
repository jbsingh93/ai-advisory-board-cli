import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSkillPackage } from '../install.js';
import type { EmittedFile } from '../invoke-skill-creator.js';

describe('installSkillPackage', () => {
  let projectRoot: string;
  let workspaceRoot: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'aab-skill-install-'));
    projectRoot = join(base, 'project');
    workspaceRoot = join(base, 'ws');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot.replace(/[\\/]project$/, ''), { recursive: true, force: true });
  });

  const files = (): EmittedFile[] => [
    { path: 'SKILL.md', content: '---\nname: x\n---\nbody', sizeBytes: 22 },
    { path: 'references/script.md', content: '# Script', sizeBytes: 8 },
  ];

  it('installs files into .claude/skills/<name>/ on first run', async () => {
    const r = await installSkillPackage({
      files: files(),
      skillName: 'my-skill',
      scope: 'project',
      projectRoot,
      yes: true,
      workspaceRoot,
      runId: 'r1',
      actionItemId: 'a1',
    });
    expect(r.installPath).toBe(join(projectRoot, '.claude', 'skills', 'my-skill'));
    expect(r.filesWritten).toBe(2);
    expect(existsSync(join(r.installPath, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(r.installPath, 'references', 'script.md'))).toBe(true);
    // Sidecar in workspace, NOT inside installed dir (T3.9)
    expect(existsSync(join(workspaceRoot, 'skill-runs', 'r1', 'installed-at.json'))).toBe(true);
    expect(existsSync(join(r.installPath, 'installed-at.json'))).toBe(false);
  });

  it('archives existing on overwrite + cleans the install dir', async () => {
    const installDir = join(projectRoot, '.claude', 'skills', 'my-skill');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, 'OLD.md'), 'old');
    const r = await installSkillPackage({
      files: files(),
      skillName: 'my-skill',
      scope: 'project',
      projectRoot,
      yes: true,
      workspaceRoot,
      runId: 'r2',
      actionItemId: 'a1',
    });
    expect(r.conflictAction).toBe('overwrite');
    expect(r.archivedTo).toBeDefined();
    // archive contains OLD.md
    expect(existsSync(join(r.archivedTo!, 'OLD.md'))).toBe(true);
    // new install doesn't
    expect(existsSync(join(r.installPath, 'OLD.md'))).toBe(false);
    expect(readFileSync(join(r.installPath, 'SKILL.md'), 'utf8')).toContain('name: x');
  });

  it('writes sidecar with provenance fields', async () => {
    await installSkillPackage({
      files: files(),
      skillName: 'sidecar-test',
      scope: 'project',
      projectRoot,
      yes: true,
      workspaceRoot,
      runId: 'rabc',
      actionItemId: 'aaaa-bbbb',
    });
    const sidecar = JSON.parse(readFileSync(join(workspaceRoot, 'skill-runs', 'rabc', 'installed-at.json'), 'utf8'));
    expect(sidecar.runId).toBe('rabc');
    expect(sidecar.actionItemId).toBe('aaaa-bbbb');
    expect(sidecar.skillName).toBe('sidecar-test');
    expect(typeof sidecar.installedAt).toBe('string');
  });
});
