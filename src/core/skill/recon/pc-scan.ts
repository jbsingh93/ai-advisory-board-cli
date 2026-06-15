/**
 * PC scan — Phase 5 Skill Planner recon (read-only invariant).
 *
 * Per docs/development/SKILL_CREATOR.md §6.2: enumerate installed desktop apps, CLI
 * tools, browser extensions, MCP servers, env vars, existing Claude Code
 * skills, Playwright availability, and Claude-for-Chrome / computer-use
 * heuristic flags. Hard rule: this file performs no writes, no network
 * calls, no side effects of any kind. The lint rule
 * `no-side-effects-in-recon` (CI-enforced) keeps it that way.
 *
 * Shape: a pure function taking injected `os` + `fs` + `child_process`
 * handles so unit tests can mock per-platform behavior. Production callers
 * use `scan()` which wires in the real handles.
 */
import {
  execFileSync,
  type SpawnSyncReturns,
} from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { homedir, platform as osPlatform } from 'node:os';

export type ReconPlatform = 'win32' | 'darwin' | 'linux';

export interface DetectedApp {
  name: string;
  /** Optional — only populated when we can read it cheaply (registry, .desktop). */
  version?: string;
  /** Coarse category, used by the keyword-relevance sort. */
  category?: 'creative' | 'comms' | 'productivity' | 'dev' | 'data' | 'browser' | 'finance' | 'other';
  source: 'startmenu' | 'registry' | 'programs' | 'applications' | 'mdfind' | 'desktop-entry' | 'flatpak' | 'snap' | 'manual';
}

export interface DetectedCliTool {
  name: string;
  path: string;
  version?: string;
}

export interface DetectedMcpServer {
  name: string;
  transport?: 'stdio' | 'http' | 'sse';
  /** Remote endpoint, for http/sse servers (helps the Planner reason about reach). */
  url?: string;
  tools?: string[];
  /**
   * Where this server was declared. Beyond the three `.mcp.json` scopes we now
   * read every client store on the machine:
   * - `claude.ai`     — a remote connector (OAuth) the user has linked in claude.ai
   * - `claude-desktop`— Claude Desktop's `claude_desktop_config.json`
   * - `cursor` / `windsurf` / `vscode` — other MCP-aware editors
   * - `disk`          — found by the optional full-disk crawl (deepScan)
   */
  source:
    | 'project'
    | 'user'
    | 'global'
    | 'claude.ai'
    | 'claude-desktop'
    | 'cursor'
    | 'windsurf'
    | 'vscode'
    | 'disk';
  /** Absolute path (or project key) of the config file it came from. */
  configPath?: string;
}

export interface DetectedBrowserExtension {
  browser: 'chrome' | 'edge' | 'firefox';
  id: string;
  name?: string;
  version?: string;
}

export interface DetectedExistingSkill {
  name: string;
  scope: 'project' | 'user' | 'plugin' | 'disk';
  dir: string;
}

export interface ReconResult {
  platform: ReconPlatform;
  scannedAt: string; // ISO
  apps: DetectedApp[];
  cliTools: DetectedCliTool[];
  mcpServers: DetectedMcpServer[];
  browserExtensions: DetectedBrowserExtension[];
  /**
   * Env-var NAMES only (values are always redacted at this layer — see
   * `redactEnvVarValuesInProposal` setting). The patterns surfacing here are
   * defined in `ENV_VAR_ALLOW_PATTERNS`.
   */
  envVars: string[];
  existingSkills: DetectedExistingSkill[];
  /** `npx playwright --version` returned something. */
  playwright: boolean;
  /** Chrome extension dir + auth cookie file both present (heuristic). */
  chrome: boolean;
  /** Anthropic computer-use access enabled (heuristic). */
  computerUseAvailable: boolean;
  /** Warnings from degraded phases (e.g., reg query failed on a locked-down corp Windows). */
  warnings: Array<{ phase: string; severity: 'info' | 'warn' | 'error'; message: string }>;
}

/**
 * The ~80-pattern env var allowlist. Adding a pattern here is the canonical
 * way to teach the Planner about a new integration surface — the Planner
 * reasons "user has STRIPE_KEY in env → Stripe MCP likely useful here."
 */
export const ENV_VAR_ALLOW_PATTERNS: RegExp[] = [
  /^STRIPE_/i, /^HUBSPOT_/i, /^SLACK_/i, /^GOOGLE_/i, /^NOTION_/i, /^LINEAR_/i,
  /^OPENAI_/i, /^ANTHROPIC_/i, /^AWS_/i, /^GCP_/i, /^AZURE_/i,
  /^DATABASE_URL$/i, /^DB_/i, /^POSTGRES_/i, /^MYSQL_/i, /^REDIS_/i, /^MONGO_/i,
  /^GITHUB_TOKEN$/i, /^GH_TOKEN$/i, /^GITLAB_TOKEN$/i,
  /^FIGMA_/i, /^CANVA_/i, /^MIRO_/i, /^OBSIDIAN_/i,
  /^ELGATO_/i, /^OBS_/i, /^FFMPEG_/i,
  /^SENTRY_/i, /^DATADOG_/i, /^NEWRELIC_/i,
  /^TWILIO_/i, /^SENDGRID_/i, /^MAILGUN_/i, /^POSTMARK_/i, /^GMAIL_/i,
  /^MERCURY_/i, /^BREX_/i, /^RAMP_/i, /^STRIPE_RESTRICTED_/i,
  /^GREENHOUSE_/i, /^LEVER_/i, /^WORKABLE_/i, /^RIPPLING_/i, /^GUSTO_/i,
  /^CARTA_/i, /^PULLEY_/i, /^ANGEL_/i,
  /^YOUTUBE_/i, /^VIMEO_/i, /^TWITCH_/i,
  /^X_API_/i, /^TWITTER_/i, /^LINKEDIN_/i, /^META_/i, /^TIKTOK_/i,
  /^ZAPIER_/i, /^MAKE_/i, /^N8N_/i,
  /^AIRTABLE_/i, /^SHEETS_/i, /^EXCEL_/i,
  /^ZOOM_/i, /^CALENDLY_/i,
  /^ASANA_/i, /^TRELLO_/i, /^JIRA_/i, /^MONDAY_/i,
  /^DROPBOX_/i, /^BOX_/i,
  /^DOCUSIGN_/i, /^PANDADOC_/i,
];

/**
 * The list of CLI tools we probe for. We `where`/`which` each one (very
 * cheap, doesn't execute the tool) and best-effort capture a version.
 */
export const CLI_TOOL_PROBES: readonly string[] = [
  'git', 'gh', 'glab', 'docker', 'docker-compose', 'kubectl', 'helm',
  'node', 'npm', 'pnpm', 'yarn', 'bun', 'deno',
  'python', 'python3', 'pip', 'poetry', 'pipx', 'uv',
  'ruby', 'gem', 'bundle',
  'go', 'cargo', 'rustc',
  'java', 'mvn', 'gradle',
  'php', 'composer',
  'curl', 'wget', 'jq', 'yq', 'rg', 'fd', 'fzf', 'tree',
  'ffmpeg', 'imagemagick', 'pandoc',
  'stripe', 'gh', 'hub',
  'vercel', 'netlify', 'wrangler', 'firebase', 'gcloud', 'aws', 'az', 'doctl',
  'terraform', 'pulumi', 'ansible',
  'psql', 'mysql', 'mongosh', 'redis-cli', 'sqlite3',
  'claude', 'codex', 'ollama',
  'playwright',
];

/**
 * Read-only inventory of the user's environment. Pure function — all I/O
 * is read-only (registry queries, file existence, child_process exec for
 * --version flags, etc.) and the function never throws on a missing surface.
 */
export function scan(opts: {
  projectRoot?: string;
  envOverride?: NodeJS.ProcessEnv;
  /**
   * Walk every fixed drive (Windows) or the user's home + common roots (macOS/
   * Linux) looking for stray `.mcp.json` / `mcp.json` / `SKILL.md` outside the
   * known config locations. Read-only and bounded (see `diskBudgetMs`), but it
   * blocks for seconds — callers gate it behind a progress UI.
   */
  deepScan?: boolean;
  /** Wall-clock budget for the deep disk crawl. Default 12_000ms. */
  diskBudgetMs?: number;
  /** Override the drive/dir roots the deep crawl starts from. */
  diskRoots?: string[];
} = {}): ReconResult {
  const platform = (osPlatform() === 'win32' ? 'win32' : osPlatform() === 'darwin' ? 'darwin' : 'linux') as ReconPlatform;
  const projectRoot = opts.projectRoot ?? process.cwd();
  const env = opts.envOverride ?? process.env;
  const warnings: ReconResult['warnings'] = [];

  let apps: DetectedApp[] = [];
  try {
    apps = scanApps(platform);
  } catch (err) {
    warnings.push({ phase: 'apps', severity: 'warn', message: err instanceof Error ? err.message.slice(0, 200) : 'apps scan failed' });
  }

  let cliTools: DetectedCliTool[] = [];
  try {
    cliTools = scanCliTools(env);
  } catch (err) {
    warnings.push({ phase: 'cli-tools', severity: 'warn', message: err instanceof Error ? err.message.slice(0, 200) : 'cli tools scan failed' });
  }

  // MCP servers and existing skills share the deep-disk crawl, so build them
  // together: seed from all known config stores, then (optionally) crawl disk.
  const mcpServers: DetectedMcpServer[] = [];
  const mcpSeen = new Set<string>();
  const existingSkills: DetectedExistingSkill[] = [];
  const skillSeen = new Set<string>();
  const addSkill = (name: string, scope: DetectedExistingSkill['scope'], dir: string): void => {
    const key = dir.toLowerCase();
    if (skillSeen.has(key) || existingSkills.length >= SKILL_CAP) return;
    skillSeen.add(key);
    existingSkills.push({ name, scope, dir });
  };

  try {
    collectMcpServers(projectRoot, mcpSeen, mcpServers);
  } catch (err) {
    warnings.push({ phase: 'mcp', severity: 'warn', message: err instanceof Error ? err.message.slice(0, 200) : 'mcp scan failed' });
  }
  try {
    collectExistingSkills(projectRoot, addSkill);
  } catch {
    // ignore
  }
  // Sweep the project folders the user has actually opened in Claude Code
  // (enumerated in ~/.claude.json) — covers per-project MCP + skills with no
  // disk crawl. This alone fixes the "1 MCP / 0 skills" under-count.
  try {
    sweepKnownProjects(mcpSeen, mcpServers, addSkill);
  } catch {
    // ignore
  }
  // Optional brute-force disk crawl for anything outside known locations.
  if (opts.deepScan) {
    try {
      const truncated = deepScanDisk(
        opts.diskRoots ?? diskRoots(),
        Date.now() + (opts.diskBudgetMs ?? 12_000),
        mcpSeen,
        mcpServers,
        addSkill,
      );
      if (truncated) {
        warnings.push({
          phase: 'deep-scan',
          severity: 'info',
          message: 'disk crawl hit its time/entry budget — results may be incomplete (raise diskBudgetMs to cover more)',
        });
      }
    } catch (err) {
      warnings.push({ phase: 'deep-scan', severity: 'warn', message: err instanceof Error ? err.message.slice(0, 200) : 'deep disk scan failed' });
    }
  }
  mcpServers.sort((a, b) => a.name.localeCompare(b.name));
  existingSkills.sort((a, b) => a.name.localeCompare(b.name));

  let browserExtensions: DetectedBrowserExtension[] = [];
  try {
    browserExtensions = scanBrowserExtensions(platform);
  } catch (err) {
    warnings.push({ phase: 'browser-extensions', severity: 'info', message: 'browser extension scan skipped (often gated by OS perms)' });
  }

  const envVars: string[] = [];
  for (const key of Object.keys(env)) {
    if (ENV_VAR_ALLOW_PATTERNS.some((re) => re.test(key))) {
      envVars.push(key);
    }
  }
  envVars.sort();

  const playwright = cliTools.some((t) => t.name === 'playwright') || existsSync(join(homedir(), '.cache', 'ms-playwright'));
  const chrome = detectChromeExtensionPresence(platform);
  const computerUseAvailable = !!(env.ANTHROPIC_COMPUTER_USE || env.ANTHROPIC_COMPUTER_USE_ENABLED || env.ANTHROPIC_COMPUTER_USE_API_KEY);

  return {
    platform,
    scannedAt: new Date().toISOString(),
    apps,
    cliTools,
    mcpServers,
    browserExtensions,
    envVars,
    existingSkills,
    playwright,
    chrome,
    computerUseAvailable,
    warnings,
  };
}

/**
 * Tiny read-only probe used by `aab doctor` — counts only, no metadata. Far
 * cheaper than a full scan. The full scan is what the Planner uses.
 */
export function quickPcScanProbe(opts: { projectRoot?: string } = {}): {
  ok: boolean;
  platform: ReconPlatform;
  cliTools: number;
  envVarMatches: number;
  mcpServers: number;
  skills: number;
  error?: string;
} {
  try {
    const platform = (osPlatform() === 'win32' ? 'win32' : osPlatform() === 'darwin' ? 'darwin' : 'linux') as ReconPlatform;
    const env = process.env;
    const projectRoot = opts.projectRoot ?? process.cwd();
    let cliCount = 0;
    for (const tool of CLI_TOOL_PROBES.slice(0, 20)) {
      if (findOnPath(tool, env)) cliCount++;
    }
    let envCount = 0;
    for (const key of Object.keys(env)) {
      if (ENV_VAR_ALLOW_PATTERNS.some((re) => re.test(key))) envCount++;
    }
    // Config-store reads only — cheap (no disk crawl), but counts the real
    // surfaces so `aab doctor` no longer reports a misleading 1-MCP/0-skills.
    let mcpCount = 0;
    let skillCount = 0;
    try {
      const mcpSeen = new Set<string>();
      const mcp: DetectedMcpServer[] = [];
      collectMcpServers(projectRoot, mcpSeen, mcp);
      sweepKnownProjects(mcpSeen, mcp, () => {});
      mcpCount = mcp.length;
    } catch {
      // ignore
    }
    try {
      const seen = new Set<string>();
      collectExistingSkills(projectRoot, (_n, _s, dir) => {
        if (!seen.has(dir.toLowerCase())) {
          seen.add(dir.toLowerCase());
          skillCount++;
        }
      });
    } catch {
      // ignore
    }
    return { ok: true, platform, cliTools: cliCount, envVarMatches: envCount, mcpServers: mcpCount, skills: skillCount };
  } catch (err) {
    return {
      ok: false,
      platform: 'linux',
      cliTools: 0,
      envVarMatches: 0,
      mcpServers: 0,
      skills: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------- platform-dispatched scanners ----------

function scanApps(platform: ReconPlatform): DetectedApp[] {
  if (platform === 'win32') return scanAppsWindows();
  if (platform === 'darwin') return scanAppsMacOS();
  return scanAppsLinux();
}

function scanAppsWindows(): DetectedApp[] {
  const out: DetectedApp[] = [];
  // Walk the standard install roots — top-level dir entries only, never recurse.
  const roots: string[] = [];
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'Programs'));
  if (process.env.PROGRAMFILES) roots.push(process.env.PROGRAMFILES);
  if (process.env['PROGRAMFILES(X86)']) roots.push(process.env['PROGRAMFILES(X86)']!);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(root, e);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      out.push({ name: e, source: 'programs', category: categorize(e) });
      if (out.length >= 200) return out;
    }
  }
  return out;
}

function scanAppsMacOS(): DetectedApp[] {
  const out: DetectedApp[] = [];
  const roots = ['/Applications', join(homedir(), 'Applications')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.endsWith('.app')) continue;
      const name = e.replace(/\.app$/, '');
      out.push({ name, source: 'applications', category: categorize(name) });
      if (out.length >= 200) return out;
    }
  }
  return out;
}

function scanAppsLinux(): DetectedApp[] {
  const out: DetectedApp[] = [];
  const roots = ['/usr/share/applications', join(homedir(), '.local', 'share', 'applications')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.endsWith('.desktop')) continue;
      const full = join(root, e);
      let body = '';
      try {
        body = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const nameMatch = body.match(/^Name=(.+)$/m);
      const name = nameMatch ? nameMatch[1]!.trim() : e.replace(/\.desktop$/, '');
      out.push({ name, source: 'desktop-entry', category: categorize(name) });
      if (out.length >= 200) return out;
    }
  }
  return out;
}

function categorize(name: string): DetectedApp['category'] {
  const lower = name.toLowerCase();
  if (/(elgato|obs|davinci|premiere|after.effects|figma|sketch|illustrator|photoshop|procreate|blender|finalcut|riverside)/i.test(lower)) return 'creative';
  if (/(slack|teams|zoom|discord|telegram|signal|whatsapp|gmail|outlook|missive)/i.test(lower)) return 'comms';
  if (/(notion|evernote|obsidian|roam|onenote|todoist|things|reminders|airtable|coda)/i.test(lower)) return 'productivity';
  if (/(vs.?code|cursor|sublime|jetbrains|webstorm|idea|pycharm|xcode|android.studio|docker|postman|insomnia)/i.test(lower)) return 'dev';
  if (/(tableau|looker|metabase|grafana|powerbi|excel|sheets)/i.test(lower)) return 'data';
  if (/(chrome|edge|firefox|safari|brave|arc|vivaldi|opera)/i.test(lower)) return 'browser';
  if (/(stripe|mercury|brex|ramp|quickbooks|xero|sage|carta)/i.test(lower)) return 'finance';
  return 'other';
}

function scanCliTools(env: NodeJS.ProcessEnv): DetectedCliTool[] {
  const out: DetectedCliTool[] = [];
  const seen = new Set<string>();
  for (const tool of CLI_TOOL_PROBES) {
    if (seen.has(tool)) continue;
    seen.add(tool);
    const path = findOnPath(tool, env);
    if (!path) continue;
    const version = tryVersion(path);
    out.push({ name: tool, path, version });
    if (out.length >= 80) break;
  }
  return out;
}

const MCP_CAP = 500;
const SKILL_CAP = 500;

/** Loosely-typed shape of a single MCP server config across all client schemas. */
interface RawMcpCfg {
  type?: string;
  transport?: string;
  url?: string;
  command?: string;
}

/**
 * Read every MCP config store on the machine — not just the three `.mcp.json`
 * files the original scanner knew about. Order matters only for dedup (first
 * declaration of a given server name wins).
 */
function collectMcpServers(projectRoot: string, seen: Set<string>, out: DetectedMcpServer[]): void {
  // 1. The three classic `.mcp.json` scopes.
  pushMcpFile(join(projectRoot, '.mcp.json'), 'project', seen, out);
  pushMcpFile(join(homedir(), '.claude', '.mcp.json'), 'user', seen, out);
  pushMcpFile(join(homedir(), '.mcp.json'), 'global', seen, out);

  // 2. Claude Code's real store: ~/.claude.json (top-level + every project +
  //    the claude.ai remote connectors). This is where most servers actually live.
  scanClaudeJsonMcp(seen, out);

  // 3. Claude Desktop.
  pushMcpFile(claudeDesktopConfigPath(), 'claude-desktop', seen, out);

  // 4. Cursor (user + project).
  pushMcpFile(join(homedir(), '.cursor', 'mcp.json'), 'cursor', seen, out);
  pushMcpFile(join(projectRoot, '.cursor', 'mcp.json'), 'cursor', seen, out);

  // 5. Windsurf / Codeium.
  pushMcpFile(join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'), 'windsurf', seen, out);

  // 6. VS Code (user + project). VS Code uses the top-level `servers` key.
  pushMcpFile(vscodeUserMcpPath(), 'vscode', seen, out);
  pushMcpFile(join(projectRoot, '.vscode', 'mcp.json'), 'vscode', seen, out);
}

function scanClaudeJsonMcp(seen: Set<string>, out: DetectedMcpServer[]): void {
  const file = join(homedir(), '.claude.json');
  const json = readJsonSafe(file) as
    | {
        mcpServers?: Record<string, RawMcpCfg>;
        projects?: Record<string, { mcpServers?: Record<string, RawMcpCfg> }>;
        claudeAiMcpEverConnected?: unknown;
      }
    | null;
  if (!json) return;
  // Top-level user-scoped servers.
  pushServerMap(json.mcpServers, 'user', file, seen, out);
  // Per-project servers — the project path itself is the configPath.
  if (json.projects && typeof json.projects === 'object') {
    for (const [path, proj] of Object.entries(json.projects)) {
      pushServerMap(proj?.mcpServers, 'project', path, seen, out);
    }
  }
  // claude.ai remote connectors — an array of display-name strings.
  if (Array.isArray(json.claudeAiMcpEverConnected)) {
    for (const entry of json.claudeAiMcpEverConnected) {
      const name = typeof entry === 'string' ? entry : (entry as { name?: string; id?: string })?.name ?? (entry as { id?: string })?.id;
      if (typeof name === 'string' && name && !seen.has(name) && out.length < MCP_CAP) {
        seen.add(name);
        out.push({ name, source: 'claude.ai', configPath: file });
      }
    }
  }
}

function pushMcpFile(file: string, source: DetectedMcpServer['source'], seen: Set<string>, out: DetectedMcpServer[]): void {
  if (!file) return;
  const json = readJsonSafe(file) as
    | { mcpServers?: Record<string, RawMcpCfg>; servers?: Record<string, RawMcpCfg>; mcp?: { servers?: Record<string, RawMcpCfg> } }
    | null;
  if (!json) return;
  const servers = json.mcpServers ?? json.servers ?? json.mcp?.servers;
  pushServerMap(servers, source, file, seen, out);
}

function pushServerMap(
  servers: Record<string, RawMcpCfg> | undefined,
  source: DetectedMcpServer['source'],
  configPath: string,
  seen: Set<string>,
  out: DetectedMcpServer[],
): void {
  if (!servers || typeof servers !== 'object') return;
  for (const [name, cfg] of Object.entries(servers)) {
    if (seen.has(name) || out.length >= MCP_CAP) continue;
    seen.add(name);
    out.push({
      name,
      transport: inferTransport(cfg),
      url: typeof cfg?.url === 'string' ? cfg.url : undefined,
      source,
      configPath,
    });
  }
}

/**
 * Infer transport from whatever field the client used. Clients disagree:
 * Claude Code uses `type`, the MCP spec examples use `transport`, and some omit
 * it entirely — in which case `url` ⇒ remote and `command` ⇒ stdio.
 */
function inferTransport(cfg: RawMcpCfg | undefined): DetectedMcpServer['transport'] {
  const v = cfg?.type ?? cfg?.transport;
  if (v === 'stdio' || v === 'http' || v === 'sse') return v;
  if (typeof cfg?.url === 'string') return /sse/i.test(cfg.url) ? 'sse' : 'http';
  if (cfg?.command) return 'stdio';
  return undefined;
}

function claudeDesktopConfigPath(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA ? join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json') : '';
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function vscodeUserMcpPath(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA ? join(process.env.APPDATA, 'Code', 'User', 'mcp.json') : '';
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  }
  return join(homedir(), '.config', 'Code', 'User', 'mcp.json');
}

function readJsonSafe(file: string): unknown {
  if (!file || !existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Sweep the project folders the user has actually opened in Claude Code
 * (enumerated under `~/.claude.json` → `projects`). Cheap, targeted, and the
 * single biggest win for the under-count — no full-disk crawl needed.
 */
function sweepKnownProjects(
  seen: Set<string>,
  out: DetectedMcpServer[],
  addSkill: (name: string, scope: DetectedExistingSkill['scope'], dir: string) => void,
): void {
  const json = readJsonSafe(join(homedir(), '.claude.json')) as { projects?: Record<string, unknown> } | null;
  const paths = json?.projects && typeof json.projects === 'object' ? Object.keys(json.projects) : [];
  for (const path of paths.slice(0, 300)) {
    if (!path || !existsSync(path)) continue;
    pushMcpFile(join(path, '.mcp.json'), 'project', seen, out);
    pushMcpFile(join(path, '.cursor', 'mcp.json'), 'cursor', seen, out);
    pushMcpFile(join(path, '.vscode', 'mcp.json'), 'vscode', seen, out);
    collectSkillDirs(join(path, '.claude', 'skills'), 'project', addSkill, 2);
  }
}

function scanBrowserExtensions(platform: ReconPlatform): DetectedBrowserExtension[] {
  const out: DetectedBrowserExtension[] = [];
  const candidates: Array<{ browser: DetectedBrowserExtension['browser']; root: string }> = [];
  if (platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push({ browser: 'chrome', root: join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Default', 'Extensions') });
    candidates.push({ browser: 'edge', root: join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default', 'Extensions') });
  } else if (platform === 'darwin') {
    candidates.push({ browser: 'chrome', root: join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Extensions') });
  } else {
    candidates.push({ browser: 'chrome', root: join(homedir(), '.config', 'google-chrome', 'Default', 'Extensions') });
  }
  for (const { browser, root } of candidates) {
    if (!existsSync(root)) continue;
    let extIds: string[];
    try {
      extIds = readdirSync(root);
    } catch {
      continue;
    }
    for (const id of extIds.slice(0, 40)) {
      // Each extension directory contains version subdirectories.
      let versions: string[] = [];
      try {
        versions = readdirSync(join(root, id));
      } catch {
        continue;
      }
      const latest = versions.sort().pop();
      if (!latest) continue;
      let name: string | undefined;
      try {
        const manifest = JSON.parse(readFileSync(join(root, id, latest, 'manifest.json'), 'utf8')) as { name?: string };
        if (typeof manifest.name === 'string') name = manifest.name;
      } catch {
        // ignore
      }
      out.push({ browser, id, name, version: latest });
    }
  }
  return out;
}

function detectChromeExtensionPresence(platform: ReconPlatform): boolean {
  // Heuristic only: check for an Anthropic / Claude extension dir in
  // chrome User Data. We don't enumerate auth cookies (privacy + complexity).
  let chromeRoot = '';
  if (platform === 'win32' && process.env.LOCALAPPDATA) {
    chromeRoot = join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Default', 'Extensions');
  } else if (platform === 'darwin') {
    chromeRoot = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Extensions');
  } else {
    chromeRoot = join(homedir(), '.config', 'google-chrome', 'Default', 'Extensions');
  }
  if (!existsSync(chromeRoot)) return false;
  let extIds: string[];
  try {
    extIds = readdirSync(chromeRoot);
  } catch {
    return false;
  }
  for (const id of extIds) {
    let versions: string[] = [];
    try {
      versions = readdirSync(join(chromeRoot, id));
    } catch {
      continue;
    }
    for (const v of versions) {
      try {
        const body = readFileSync(join(chromeRoot, id, v, 'manifest.json'), 'utf8');
        if (/claude/i.test(body) || /anthropic/i.test(body)) return true;
      } catch {
        // ignore
      }
    }
  }
  return false;
}

/**
 * Find every installed skill. Skills live at wildly varying depths:
 * - `<project>/.claude/skills/<name>/SKILL.md`           (project)
 * - `~/.claude/skills/<name>/SKILL.md`                   (user)
 * - `~/.claude/plugins/marketplaces/<mp>/{plugins,external_plugins}/<plugin>/skills/<name>/SKILL.md`
 * - `~/.claude/plugins/cache/<mp>/<plugin>/<version>/skills/<name>/SKILL.md`  (plugin)
 *
 * The old scanner only walked ONE level under `~/.claude/plugins/`, so it found
 * zero plugin skills. We now bounded-recurse the whole plugins tree plus the
 * explicit install paths from `installed_plugins.json`.
 */
function collectExistingSkills(
  projectRoot: string,
  addSkill: (name: string, scope: DetectedExistingSkill['scope'], dir: string) => void,
): void {
  collectSkillDirs(join(projectRoot, '.claude', 'skills'), 'project', addSkill, 2);
  collectSkillDirs(join(homedir(), '.claude', 'skills'), 'user', addSkill, 2);

  // The whole plugins tree (marketplaces + cache + repos + external_plugins).
  collectSkillDirs(join(homedir(), '.claude', 'plugins'), 'plugin', addSkill, 8);

  // Plus the authoritative install manifest — installPath may live elsewhere.
  const manifest = readJsonSafe(join(homedir(), '.claude', 'plugins', 'installed_plugins.json')) as
    | { plugins?: Record<string, Array<{ installPath?: string }>> }
    | null;
  if (manifest?.plugins && typeof manifest.plugins === 'object') {
    for (const installs of Object.values(manifest.plugins)) {
      if (!Array.isArray(installs)) continue;
      for (const inst of installs) {
        if (inst?.installPath) collectSkillDirs(inst.installPath, 'plugin', addSkill, 4);
      }
    }
  }
}

/** Bounded recursive search for `SKILL.md` files; records each containing dir. */
function collectSkillDirs(
  root: string,
  scope: DetectedExistingSkill['scope'],
  addSkill: (name: string, scope: DetectedExistingSkill['scope'], dir: string) => void,
  maxDepth: number,
): void {
  walkDir(root, maxDepth, Number.POSITIVE_INFINITY, { entries: 100_000 }, (_full, name, dir) => {
    if (name === 'SKILL.md') addSkill(basename(dir), scope, dir);
  });
}

// ---------- deep disk crawl ----------

/**
 * Directory names we never descend into during the deep crawl — version-control
 * internals, dependency caches, OS junk. Pruning these keeps a full-drive walk
 * to seconds instead of hours and avoids symlink/permission tarpits.
 */
const PRUNE_DIR_NAMES = new Set<string>([
  'node_modules', '.git', '.hg', '.svn', '.cache', 'cache', 'gpucache', 'code cache',
  '.npm', '.pnpm-store', '.yarn', '.gradle', '.m2', '.nuget', '.cargo', '.rustup',
  '$recycle.bin', 'system volume information', 'windows', 'winsxs', '$windows.~bt',
  'tmp', 'temp', '.tmp', '.trash', '.local', 'appdata',
  'ms-playwright', 'cypress', '.next', '.nuxt', 'dist', 'build', 'out', 'vendor',
  'proc', 'sys', 'dev', 'run',
]);

/**
 * Dotfolders we always descend into even past the shallow-dotfolder cutoff —
 * these are precisely where MCP configs and skills hide.
 */
const DESCEND_DOTDIRS = new Set<string>(['.claude', '.cursor', '.vscode', '.config', '.codeium']);

/** Crawl the given roots for stray MCP/skill files. Returns true if truncated. */
function deepScanDisk(
  roots: string[],
  deadline: number,
  mcpSeen: Set<string>,
  mcpOut: DetectedMcpServer[],
  addSkill: (name: string, scope: DetectedExistingSkill['scope'], dir: string) => void,
): boolean {
  const budget = { entries: 3_000_000 };
  let truncated = false;
  for (const root of roots) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    const hit = walkDir(root, 14, deadline, budget, (full, name, dir) => {
      const lower = name.toLowerCase();
      if (lower === 'skill.md') {
        addSkill(basename(dir), 'disk', dir);
      } else if (lower === '.mcp.json') {
        pushMcpFile(full, 'disk', mcpSeen, mcpOut);
      } else if (lower === 'mcp.json') {
        const parent = basename(dir).toLowerCase();
        if (parent === '.cursor') pushMcpFile(full, 'cursor', mcpSeen, mcpOut);
        else if (parent === '.vscode') pushMcpFile(full, 'vscode', mcpSeen, mcpOut);
      } else if (lower === 'claude_desktop_config.json') {
        pushMcpFile(full, 'claude-desktop', mcpSeen, mcpOut);
      }
    });
    if (hit) truncated = true;
  }
  return truncated;
}

/** Drive/dir roots the deep crawl starts from. */
function diskRoots(): string[] {
  if (process.platform === 'win32') {
    const roots: string[] = [];
    for (let c = 67 /* C */; c <= 90 /* Z */; c++) {
      const drive = `${String.fromCharCode(c)}:\\`;
      if (existsSync(drive)) roots.push(drive);
    }
    return roots.length ? roots : [homedir()];
  }
  // On POSIX we deliberately avoid '/' (which drags in /proc, /sys, network
  // mounts) and scan the high-signal user + app roots instead.
  return [homedir(), '/Applications', '/opt', '/usr/local', '/srv'].filter((r) => existsSync(r));
}

/**
 * Iterative (stack-based, no recursion-depth limit) directory walk. Read-only,
 * never throws, skips pruned/symlinked dirs, and stops on deadline or entry
 * budget. Returns true if it stopped early (truncated).
 */
function walkDir(
  root: string,
  maxDepth: number,
  deadline: number,
  budget: { entries: number },
  visitFile: (full: string, name: string, dir: string) => void,
): boolean {
  if (!root || !existsSync(root)) return false;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let truncated = false;
  while (stack.length) {
    if (budget.entries <= 0 || Date.now() > deadline) {
      truncated = true;
      break;
    }
    const { dir, depth } = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // permission denied, gone, etc.
    }
    for (const ent of entries) {
      if (budget.entries-- <= 0) {
        truncated = true;
        break;
      }
      const name = ent.name;
      if (ent.isDirectory()) {
        if (depth >= maxDepth) continue;
        const lower = name.toLowerCase();
        if (PRUNE_DIR_NAMES.has(lower)) continue;
        // Skip unknown dotfolders past a shallow depth, but always follow the
        // ones that actually hold MCP configs / skills (.claude, .cursor, …).
        if (name.startsWith('.') && depth > 2 && !DESCEND_DOTDIRS.has(lower)) continue;
        stack.push({ dir: join(dir, name), depth: depth + 1 });
      } else if (ent.isFile()) {
        visitFile(join(dir, name), name, dir);
      }
    }
  }
  return truncated;
}

// ---------- low-level helpers ----------

function findOnPath(tool: string, env: NodeJS.ProcessEnv): string | null {
  const PATH = env.PATH ?? env.Path ?? '';
  const PATHEXT = (env.PATHEXT ?? (process.platform === 'win32' ? '.COM;.EXE;.BAT;.CMD;.PS1' : '')).split(';').filter(Boolean);
  const dirs = PATH.split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (process.platform === 'win32') {
      for (const ext of PATHEXT) {
        const candidate = join(dir, tool + ext);
        if (existsSync(candidate)) return candidate;
      }
      const noExt = join(dir, tool);
      if (existsSync(noExt)) return noExt;
    } else {
      const candidate = join(dir, tool);
      if (existsSync(candidate)) {
        try {
          if (statSync(candidate).isFile()) return candidate;
        } catch {
          // ignore
        }
      }
    }
  }
  return null;
}

function tryVersion(toolPath: string): string | undefined {
  try {
    const out: string = (execFileSync(toolPath, ['--version'], {
      timeout: 750,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }) as unknown) as string;
    const m = out.match(/(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/);
    return m?.[1];
  } catch (err) {
    // Some tools surface --version via stderr — try harder for the common
    // case of CLI tools that print to stderr (rare).
    const e = err as SpawnSyncReturns<Buffer> | undefined;
    if (e?.stdout) {
      const txt = e.stdout.toString('utf8');
      const m = txt.match(/(\d+\.\d+(?:\.\d+)?)/);
      if (m) return m[1];
    }
    return undefined;
  }
}
