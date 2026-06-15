import { homedir } from 'node:os';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import slugify from 'slugify';

const ROOT_HOME = '.aabcli';
const ROOT_PROJECT = '.aabcli';
const ACTIVE_FILE = '.active';

export interface ResolvedWorkspace {
  /** Slug id of the workspace. */
  id: string;
  /** Absolute path to the workspace root directory. */
  root: string;
  /** 'home' (under ~/.aabcli) or 'project' (./.aabcli mounted in cwd). */
  scope: 'home' | 'project';
}

export function homeRoot(): string {
  return join(homedir(), ROOT_HOME);
}

/**
 * Slugify a workspace identifier deterministically.
 */
export function slugifyWorkspaceId(input: string): string {
  const slug = slugify(input, { lower: true, strict: true });
  return slug || 'default';
}

/**
 * Read the active workspace id pointer (~/.aabcli/.active).
 */
export function getActiveWorkspaceId(): string | null {
  const p = join(homeRoot(), ACTIVE_FILE);
  if (!existsSync(p)) return null;
  try {
    const value = readFileSync(p, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Set the active workspace id pointer.
 */
export function setActiveWorkspaceId(id: string): void {
  const p = join(homeRoot(), ACTIVE_FILE);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, id, 'utf8');
}

/**
 * Resolve which workspace the CLI should use for this invocation.
 *
 * Order:
 *   1. Explicit override (--workspace flag, AAB_WORKSPACE env)
 *   2. Project-mounted workspace at ./.aabcli (if it exists)
 *   3. Active workspace pointer in ~/.aabcli/.active
 *   4. cwd-basename slug under ~/.aabcli/<slug>
 */
export function resolveWorkspace(options: {
  override?: string;
  cwd?: string;
} = {}): ResolvedWorkspace {
  const cwd = options.cwd ?? process.cwd();

  if (options.override) {
    const id = slugifyWorkspaceId(options.override);
    return { id, root: join(homeRoot(), id), scope: 'home' };
  }

  const envOverride = process.env.AAB_WORKSPACE;
  if (envOverride) {
    const id = slugifyWorkspaceId(envOverride);
    return { id, root: join(homeRoot(), id), scope: 'home' };
  }

  const projectMount = join(cwd, ROOT_PROJECT);
  if (existsSync(projectMount)) {
    const id = slugifyWorkspaceId(`project-${cwd.split(/[\\/]/).pop() ?? 'workspace'}`);
    return { id, root: resolve(projectMount), scope: 'project' };
  }

  const active = getActiveWorkspaceId();
  if (active) {
    return { id: active, root: join(homeRoot(), active), scope: 'home' };
  }

  const id = slugifyWorkspaceId(cwd.split(/[\\/]/).pop() ?? 'default');
  return { id, root: join(homeRoot(), id), scope: 'home' };
}

/**
 * List all workspaces under ~/.aabcli/.
 */
export function listHomeWorkspaces(): string[] {
  const root = homeRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

/**
 * Standard paths within a workspace.
 */
export function paths(root: string): {
  settings: string;
  members: string;
  boards: string;
  principles: string;
  decisionSessions: string;
  discussions: string;
  actionItems: string;
  prompts: string;
  businessContext: string;
  businessProfile: string;
  skillRuns: string;
  sparring: string;
  tokenUsage: string;
  jobs: string;
  snapshots: string;
  logs: string;
  versionFile: string;
  lockFile: string;
  // Knowledge Wiki (Phase 1.5)
  wiki: string;
  wikiKnowledge: string;
  wikiIndex: string;
  wikiLog: string;
  wikiConcepts: string;
  wikiEntities: string;
  wikiDecisions: string;
  wikiSources: string;
  wikiComparisons: string;
  raw: string;
  rawFiles: string;
  rawUrls: string;
  rawPasted: string;
  rawDiscussions: string;
  rawSummaries: string;
  rawUserInputs: string;
  outputs: string;
  manifest: string;
} {
  const wiki = join(root, 'wiki');
  const raw = join(root, 'raw');
  return {
    settings: join(root, 'settings.json'),
    members: join(root, 'members.json'),
    boards: join(root, 'boards.json'),
    principles: join(root, 'principles.json'),
    decisionSessions: join(root, 'decision-sessions'),
    discussions: join(root, 'discussions'),
    actionItems: join(root, 'action-items.json'),
    prompts: join(root, 'prompts.json'),
    businessContext: join(root, 'business-context.json'),
    businessProfile: join(root, 'business-profile.json'),
    skillRuns: join(root, 'skill-runs'),
    sparring: join(root, 'sparring'),
    tokenUsage: join(root, 'token-usage'),
    jobs: join(root, 'jobs'),
    snapshots: join(root, '.snapshots'),
    logs: join(root, 'logs'),
    versionFile: join(root, '.version'),
    lockFile: join(root, '.lock'),
    // Knowledge Wiki
    wiki,
    wikiKnowledge: join(wiki, 'KNOWLEDGE.md'),
    wikiIndex: join(wiki, 'index.md'),
    wikiLog: join(wiki, 'log.md'),
    wikiConcepts: join(wiki, 'concepts'),
    wikiEntities: join(wiki, 'entities'),
    wikiDecisions: join(wiki, 'decisions'),
    wikiSources: join(wiki, 'sources'),
    wikiComparisons: join(wiki, 'comparisons'),
    raw,
    rawFiles: join(raw, 'files'),
    rawUrls: join(raw, 'urls'),
    rawPasted: join(raw, 'pasted'),
    rawDiscussions: join(raw, 'discussions'),
    rawSummaries: join(raw, 'summaries'),
    rawUserInputs: join(raw, 'user-inputs'),
    outputs: join(root, 'outputs'),
    manifest: join(root, '.manifest.json'),
  };
}

/**
 * Ensure all expected workspace subdirectories exist.
 */
export function ensureWorkspaceDirs(root: string): void {
  const p = paths(root);
  for (const dir of [
    root,
    p.decisionSessions,
    p.discussions,
    p.skillRuns,
    p.sparring,
    p.tokenUsage,
    p.jobs,
    p.snapshots,
    p.logs,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/**
 * Ensure the wiki + raw + outputs directory tree exists (Phase 1.5).
 * Idempotent — never overwrites existing files.
 */
export function ensureWikiDirs(root: string): void {
  const p = paths(root);
  for (const dir of [
    p.wiki,
    p.wikiConcepts,
    p.wikiEntities,
    p.wikiDecisions,
    p.wikiSources,
    p.wikiComparisons,
    p.raw,
    p.rawFiles,
    p.rawUrls,
    p.rawPasted,
    p.rawDiscussions,
    p.rawSummaries,
    p.rawUserInputs,
    p.outputs,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
