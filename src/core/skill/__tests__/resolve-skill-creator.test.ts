import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractFrontmatter,
  resolveSkill,
  resolveSkillCreator,
  skillCreatorInstallHint,
} from '../resolve-skill-creator.js';

describe('extractFrontmatter', () => {
  it('returns null when no frontmatter present', () => {
    expect(extractFrontmatter('no frontmatter here')).toBeNull();
  });

  it('parses name + version with double quotes', () => {
    const raw = '---\nname: "skill-creator"\nversion: "0.4.1"\nfoo: bar\n---\nbody';
    expect(extractFrontmatter(raw)).toEqual({ name: 'skill-creator', version: '0.4.1' });
  });

  it('parses name + version with single quotes', () => {
    const raw = "---\nname: 'skill-creator'\nversion: '1.2.3'\n---\nbody";
    expect(extractFrontmatter(raw)).toEqual({ name: 'skill-creator', version: '1.2.3' });
  });

  it('parses without quotes', () => {
    const raw = '---\nname: skill-creator\nversion: 0.0.9\n---\n';
    expect(extractFrontmatter(raw)).toEqual({ name: 'skill-creator', version: '0.0.9' });
  });

  it('ignores unrelated keys', () => {
    const raw = '---\ndescription: foo\nallowed-tools: [Write]\nname: x\n---\n';
    expect(extractFrontmatter(raw)).toEqual({ name: 'x' });
  });
});

describe('resolveSkill — scope walking priority', () => {
  let workDir: string;
  let homeDir: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'aab-skill-resolve-'));
    workDir = join(base, 'project');
    homeDir = join(base, 'home');
    mkdirSync(workDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workDir)) rmSync(workDir.replace(/[\\/]project$/, ''), { recursive: true, force: true });
  });

  function seedSkill(
    root: string,
    relPath: string,
    name: string,
    version?: string,
  ): void {
    const dir = join(root, relPath, name);
    mkdirSync(dir, { recursive: true });
    const fm = ['---', `name: ${name}`, ...(version ? [`version: ${version}`] : []), '---', 'body'].join('\n');
    writeFileSync(join(dir, 'SKILL.md'), fm);
  }

  it('finds project-scoped skill first', () => {
    seedSkill(workDir, '.claude/skills', 'skill-creator', '0.5.0');
    seedSkill(homeDir, '.claude/skills', 'skill-creator', '0.9.0');
    const r = resolveSkill('skill-creator', { projectRoot: workDir, homeDir });
    expect(r).not.toBeNull();
    expect(r!.scope).toBe('project');
    expect(r!.version).toBe('0.5.0');
  });

  it('falls through to user scope when project missing', () => {
    seedSkill(homeDir, '.claude/skills', 'skill-creator', '0.9.0');
    const r = resolveSkill('skill-creator', { projectRoot: workDir, homeDir });
    expect(r).not.toBeNull();
    expect(r!.scope).toBe('user');
    expect(r!.version).toBe('0.9.0');
  });

  it('falls through to plugin scope when user missing', () => {
    seedSkill(homeDir, '.claude/plugins/claude-plugins-official/skills', 'skill-creator', '1.0.0');
    const r = resolveSkill('skill-creator', { projectRoot: workDir, homeDir });
    expect(r).not.toBeNull();
    expect(r!.scope).toBe('plugin');
    expect(r!.version).toBe('1.0.0');
  });

  it('returns null when not found anywhere', () => {
    expect(resolveSkill('does-not-exist', { projectRoot: workDir, homeDir })).toBeNull();
  });

  it('captures version even when frontmatter has extra keys', () => {
    const dir = join(workDir, '.claude/skills/skill-creator');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\ndescription: official\nname: skill-creator\nversion: 2.3.4\nallowed-tools:\n  - Write\n---\n# body',
    );
    const r = resolveSkill('skill-creator', { projectRoot: workDir, homeDir });
    expect(r!.version).toBe('2.3.4');
  });

  it('resolveSkillCreator is a thin alias', () => {
    seedSkill(workDir, '.claude/skills', 'skill-creator', '0.1.0');
    const r = resolveSkillCreator({ projectRoot: workDir, homeDir });
    expect(r!.name).toBe('skill-creator');
  });
});

describe('skillCreatorInstallHint', () => {
  it('mentions the install command and the tracking issue', () => {
    const hint = skillCreatorInstallHint();
    expect(hint).toContain('/plugin install skill-creator@claude-plugins-official');
    expect(hint).toContain('38505');
  });
});
