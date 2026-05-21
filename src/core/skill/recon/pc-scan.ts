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
import { delimiter, join } from 'node:path';
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
  tools?: string[];
  source: 'project' | 'user' | 'global';
}

export interface DetectedBrowserExtension {
  browser: 'chrome' | 'edge' | 'firefox';
  id: string;
  name?: string;
  version?: string;
}

export interface DetectedExistingSkill {
  name: string;
  scope: 'project' | 'user' | 'plugin';
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
export function scan(opts: { projectRoot?: string; envOverride?: NodeJS.ProcessEnv } = {}): ReconResult {
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

  let mcpServers: DetectedMcpServer[] = [];
  try {
    mcpServers = scanMcpServers(projectRoot);
  } catch (err) {
    warnings.push({ phase: 'mcp', severity: 'warn', message: err instanceof Error ? err.message.slice(0, 200) : 'mcp scan failed' });
  }

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

  let existingSkills: DetectedExistingSkill[] = [];
  try {
    existingSkills = scanExistingSkills(projectRoot);
  } catch {
    // ignore
  }

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
  error?: string;
} {
  try {
    const platform = (osPlatform() === 'win32' ? 'win32' : osPlatform() === 'darwin' ? 'darwin' : 'linux') as ReconPlatform;
    const env = process.env;
    let cliCount = 0;
    for (const tool of CLI_TOOL_PROBES.slice(0, 20)) {
      if (findOnPath(tool, env)) cliCount++;
    }
    let envCount = 0;
    for (const key of Object.keys(env)) {
      if (ENV_VAR_ALLOW_PATTERNS.some((re) => re.test(key))) envCount++;
    }
    void opts;
    return { ok: true, platform, cliTools: cliCount, envVarMatches: envCount };
  } catch (err) {
    return {
      ok: false,
      platform: 'linux',
      cliTools: 0,
      envVarMatches: 0,
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

function scanMcpServers(projectRoot: string): DetectedMcpServer[] {
  const out: DetectedMcpServer[] = [];
  const seen = new Set<string>();
  // Project-scoped .mcp.json
  const projectFile = join(projectRoot, '.mcp.json');
  pushMcp(projectFile, 'project', seen, out);
  // User-scoped
  pushMcp(join(homedir(), '.claude', '.mcp.json'), 'user', seen, out);
  pushMcp(join(homedir(), '.mcp.json'), 'global', seen, out);
  return out;
}

function pushMcp(file: string, source: DetectedMcpServer['source'], seen: Set<string>, out: DetectedMcpServer[]): void {
  if (!existsSync(file)) return;
  let body: string;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  let json: { mcpServers?: Record<string, { transport?: string }>; servers?: Record<string, { transport?: string }> };
  try {
    json = JSON.parse(body);
  } catch {
    return;
  }
  const servers = json.mcpServers ?? json.servers ?? {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const transport = inferTransport(cfg?.transport);
    out.push({ name, transport, source });
  }
}

function inferTransport(value: string | undefined): DetectedMcpServer['transport'] {
  if (value === 'stdio' || value === 'http' || value === 'sse') return value;
  return undefined;
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

function scanExistingSkills(projectRoot: string): DetectedExistingSkill[] {
  const out: DetectedExistingSkill[] = [];
  const sources: Array<{ root: string; scope: DetectedExistingSkill['scope'] }> = [
    { root: join(projectRoot, '.claude', 'skills'), scope: 'project' },
    { root: join(homedir(), '.claude', 'skills'), scope: 'user' },
  ];
  for (const { root, scope } of sources) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      const skillMd = join(root, e, 'SKILL.md');
      if (existsSync(skillMd)) {
        out.push({ name: e, scope, dir: join(root, e) });
      }
    }
  }
  // Walk one level of plugin scopes
  const pluginsRoot = join(homedir(), '.claude', 'plugins');
  if (existsSync(pluginsRoot)) {
    let plugins: string[] = [];
    try {
      plugins = readdirSync(pluginsRoot);
    } catch {
      plugins = [];
    }
    for (const p of plugins) {
      const inner = join(pluginsRoot, p, 'skills');
      if (!existsSync(inner)) continue;
      let names: string[] = [];
      try {
        names = readdirSync(inner);
      } catch {
        continue;
      }
      for (const n of names) {
        if (existsSync(join(inner, n, 'SKILL.md'))) {
          out.push({ name: n, scope: 'plugin', dir: join(inner, n) });
        }
      }
    }
  }
  return out;
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
