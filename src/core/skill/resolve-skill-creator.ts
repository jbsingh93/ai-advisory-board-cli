/**
 * skill-creator resolver — Phase 5 Chunk 1.
 *
 * Walks the Claude Code skill scope priority order (project → user → plugin)
 * looking for an installed `skill-creator/SKILL.md`. Used by `aab doctor`,
 * `aab init --install-skill-creator`, and `aab actions solve` (which gates
 * on its presence per docs/development/SKILL_CREATOR.md §8).
 *
 * Returns `null` if not found; otherwise a `ResolvedSkill` with path + version
 * + scope so callers can surface where it lives and how to upgrade.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SkillScope = 'project' | 'user' | 'plugin';

export interface ResolvedSkill {
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** Absolute path to the skill directory. */
  dir: string;
  /** `project`, `user`, or `plugin`. */
  scope: SkillScope;
  /** Extracted from frontmatter `version:` if present. */
  version?: string;
  /** Extracted from frontmatter `name:`; falls back to dir name. */
  name: string;
}

export interface ResolveOptions {
  /** Project root to search for `.claude/skills/<name>/` — defaults to process.cwd(). */
  projectRoot?: string;
  /** Override for ~/.claude — useful in tests. */
  homeDir?: string;
}

/**
 * Resolve a skill by name across the Claude Code scope priority order.
 *
 * Priority (matches Claude Code's resolver behavior):
 *   1. `<projectRoot>/.claude/skills/<name>/SKILL.md` (project-scoped)
 *   2. `~/.claude/skills/<name>/SKILL.md` (user-scoped)
 *   3. `~/.claude/plugins/*​/skills/<name>/SKILL.md` (plugin-scoped)
 */
export function resolveSkill(name: string, opts: ResolveOptions = {}): ResolvedSkill | null {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const home = opts.homeDir ?? homedir();

  // 1. Project scope
  const projectPath = join(projectRoot, '.claude', 'skills', name, 'SKILL.md');
  if (existsSync(projectPath)) {
    return buildResolvedSkill(projectPath, 'project');
  }

  // 2. User scope
  const userPath = join(home, '.claude', 'skills', name, 'SKILL.md');
  if (existsSync(userPath)) {
    return buildResolvedSkill(userPath, 'user');
  }

  // 3. Plugin scope — walk under ~/.claude/plugins/ recursively (capped at 5
  // levels deep) for any path matching `*/skills/<name>/SKILL.md`. Covers the
  // real-world layout used by /plugin install:
  //   ~/.claude/plugins/marketplaces/<marketplace>/plugins/<plugin>/skills/<name>/SKILL.md
  // ...as well as flatter installs like:
  //   ~/.claude/plugins/<plugin>/skills/<name>/SKILL.md
  const pluginsRoot = join(home, '.claude', 'plugins');
  if (existsSync(pluginsRoot)) {
    const found = findPluginScopedSkill(pluginsRoot, name, 5);
    if (found) return buildResolvedSkill(found, 'plugin');
  }

  return null;
}

/**
 * Walk a directory tree up to maxDepth levels deep looking for any path that
 * ends in `skills/<name>/SKILL.md`. Returns the first hit (BFS — shallower
 * matches preferred over deeper ones).
 */
function findPluginScopedSkill(root: string, name: string, maxDepth: number): string | null {
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    // Direct hit at this level: `<path>/skills/<name>/SKILL.md`
    const candidate = join(path, 'skills', name, 'SKILL.md');
    if (existsSync(candidate)) return candidate;
    if (depth >= maxDepth) continue;
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const sub = join(path, entry);
      try {
        if (statSync(sub).isDirectory()) {
          queue.push({ path: sub, depth: depth + 1 });
        }
      } catch {
        // ignore unreadable entries
      }
    }
  }
  return null;
}

/**
 * Convenience wrapper specifically for the `skill-creator` skill, which is
 * Phase 5's hard prerequisite.
 */
export function resolveSkillCreator(opts: ResolveOptions = {}): ResolvedSkill | null {
  return resolveSkill('skill-creator', opts);
}

function buildResolvedSkill(skillMdPath: string, scope: SkillScope): ResolvedSkill {
  const dir = skillMdPath.replace(/[\\/]SKILL\.md$/i, '');
  let frontmatterName: string | undefined;
  let frontmatterVersion: string | undefined;
  try {
    const body = readFileSync(skillMdPath, 'utf8');
    const fm = extractFrontmatter(body);
    if (fm) {
      frontmatterName = fm.name;
      frontmatterVersion = fm.version;
    }
  } catch {
    // unreadable — fall through with defaults
  }
  // Derive name from dir if frontmatter didn't carry one.
  const dirName = dir.split(/[\\/]/).pop() ?? 'unknown';
  return {
    path: skillMdPath,
    dir,
    scope,
    name: frontmatterName ?? dirName,
    version: frontmatterVersion,
  };
}

interface MinimalFrontmatter {
  name?: string;
  version?: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Minimal YAML frontmatter extractor — we only need `name:` and `version:`.
 * Reuses the same hand-rolled approach as `src/core/knowledge/page.ts` so
 * we don't pull in a heavyweight YAML dep for two fields.
 */
export function extractFrontmatter(raw: string): MinimalFrontmatter | null {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return null;
  const block = m[1] ?? '';
  const out: MinimalFrontmatter = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    let value = (match[2] ?? '').trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    if (key === 'name') out.name = value;
    if (key === 'version') out.version = value;
  }
  return out;
}

/**
 * Install hint shown by `aab init --install-skill-creator` and `aab doctor`
 * when the skill is missing. `/plugin install` is interactive-only today so
 * we surface the exact command for the user to copy + paste into Claude Code.
 */
export function skillCreatorInstallHint(): string {
  return [
    'Install the official Anthropic skill-creator skill:',
    '',
    '  1. Open Claude Code in this directory',
    '  2. Run: /plugin install skill-creator@claude-plugins-official',
    '  3. Verify with: aab doctor',
    '',
    'Tracking: https://github.com/anthropics/claude-code/issues/38505 — when a',
    'non-interactive `--skill` flag ships, this becomes a one-shot CLI install.',
  ].join('\n');
}
