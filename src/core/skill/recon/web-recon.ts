/**
 * Web recon — Phase 5 Skill Planner recon phase 3.
 *
 * Two passes per docs/development/SKILL_CREATOR.md §6.4:
 *
 *   Pass 1 — General task research. One Sonnet call with WebSearch + WebFetch
 *            (maxTurns: 12). Output: bestPracticePatterns, recommendedTools,
 *            recentInnovations, warningsAndPitfalls.
 *
 *   Pass 2 — Per-detected-app integration-surface research. For the top 5
 *            apps from the PC scan (sorted by action-keyword relevance), one
 *            targeted Sonnet call each (maxTurns: 6) asking specifically about
 *            local APIs, CLI binaries, URL schemes, file-system integration,
 *            MCP availability, SDKs. Output: appIntegrationSurfaces[].
 *
 * The per-app pass is what makes the maximalist tier actually maximalist —
 * generic web research doesn't surface "Elgato Teleprompter has a local
 * HTTP API on port 9012." Targeted per-app research does.
 *
 * Never throws on partial failure — returns an empty/degraded context with
 * a warning, and the recon orchestrator (`orchestrator.ts`) aggregates.
 */
import { runClaude, extractText } from '../../../llm/claude-code-runner.js';
import { safeParseJSON } from '../../parsing/safe-json.js';
import { logger } from '../../logger.js';
import type { AppSettings } from '../../../storage/types.js';
import type { DetectedApp } from './pc-scan.js';

export interface WebInvocationHint {
  kind: 'bash-cmd' | 'bash-curl' | 'mcp-tool' | 'bash-script' | 'write-artifact' | 'manual-handoff' | 'chrome-extension' | 'computer-use';
  tools: string[];
  snippet?: string;
}

export interface WebBestPracticePattern {
  pattern: string;
  rationale: string;
  sources: Array<{ title: string; url: string }>;
}

export interface WebRecommendedTool {
  name: string;
  category: 'cli' | 'desktop-app' | 'mcp-server' | 'web-service' | 'api';
  purpose: string;
  integrationHint: string;
  sources: Array<{ title: string; url: string }>;
}

export interface WebRecentInnovation {
  name: string;
  summary: string;
  sources: Array<{ title: string; url: string }>;
}

export interface WebAppIntegrationSurface {
  appName: string;
  integrationKind: 'local-http' | 'cli' | 'url-scheme' | 'file-system' | 'mcp-server' | 'sdk' | 'none';
  invocationHint: WebInvocationHint;
  workflow: string[];
  risks: string[];
  sources: Array<{ title: string; url: string }>;
}

export interface WebResearchContext {
  taskDomain: string;
  bestPracticePatterns: WebBestPracticePattern[];
  recommendedTools: WebRecommendedTool[];
  recentInnovations: WebRecentInnovation[];
  warningsAndPitfalls: string[];
  appIntegrationSurfaces: WebAppIntegrationSurface[];
  webPassesCompleted: { general: boolean; perAppCount: number };
  costUsd: number;
  warning?: string;
}

export interface WebReconOptions {
  settings: AppSettings;
  actionTitle: string;
  actionDescription?: string;
  apps: DetectedApp[];
  /** Skip the web phase entirely (offline or --planner-no-web). */
  skip?: boolean;
  /** Default 5 — cap per-app passes. */
  topAppCount?: number;
  /** Default 12 — pass 1 maxTurns. */
  generalMaxTurns?: number;
  /** Default 6 — pass 2 maxTurns. */
  perAppMaxTurns?: number;
  /** Workspace cwd (so Read/Glob aren't accidentally invoked outside it). */
  cwd?: string;
  /** Max concurrent `claude -p` web-research processes. Default 4 — balances
   *  wall-clock against subscription rate limits (parallel sessions share the
   *  same quota; too many → 429s). */
  concurrency?: number;
  /** Heartbeat callback — fires as each pass starts/finishes so the UI has a
   *  live signal during the (otherwise opaque) web phase. */
  onProgress?: (detail: string) => void;
  /** Cancellation — kills all in-flight `claude` children when aborted. */
  signal?: AbortSignal;
}

const GENERAL_PROMPT = `<role>
You are the Web Research agent for the Skill Planner. Research how this task is
being done in 2026 — what tools, integrations, and best-practice patterns exist?
What's Anthropic's / the wider community's recommended approach?
</role>

<action>
title: {{ACTION_TITLE}}
description: {{ACTION_DESCRIPTION}}
</action>

<instructions>
Use WebSearch + WebFetch. Prioritize recency (2026) and authority (Anthropic
docs > vendor docs > top-ranked community sources). Surface 8-15 sources total.
Avoid SEO content farms.
</instructions>

<output_contract>
Return ONLY a single JSON object — no fences, no prose. Schema:
{
  "taskDomain": "≤40 chars label, e.g. 'YouTube video production workflow'",
  "bestPracticePatterns": [{ "pattern": "...", "rationale": "≤200 chars",
                              "sources": [{ "title": "...", "url": "..." }] }],
  "recommendedTools":     [{ "name": "...", "category": "cli|desktop-app|mcp-server|web-service|api",
                              "purpose": "≤120 chars", "integrationHint": "≤200 chars",
                              "sources": [{ "title": "...", "url": "..." }] }],
  "recentInnovations":    [{ "name": "...", "summary": "≤200 chars",
                              "sources": [{ "title": "...", "url": "..." }] }],
  "warningsAndPitfalls":  ["≤120 chars each"]
}
</output_contract>`;

const PER_APP_PROMPT = `<role>
You are the App Integration Surface researcher for the Skill Planner. The user
has {{APP_NAME}} ({{APP_VERSION_OR_NONE}}) installed. Find every programmatic
integration surface it exposes — and if none exist, say so explicitly.
</role>

<action>
title: {{ACTION_TITLE}}
description: {{ACTION_DESCRIPTION}}
</action>

<instructions>
Use WebSearch + WebFetch. Look for: local HTTP API + port + endpoints,
CLI binary + commands, URL scheme, file-system integration, MCP server,
official SDK, automation guides. Cite vendor docs + Anthropic docs + top
community sources. If no programmatic integration exists, surface a
chrome-extension or computer-use handoff as a fallback.
</instructions>

<output_contract>
Return ONLY a single JSON object. Schema:
{
  "appName": "{{APP_NAME}}",
  "integrationKind": "local-http|cli|url-scheme|file-system|mcp-server|sdk|none",
  "invocationHint": {
    "kind": "bash-cmd|bash-curl|mcp-tool|bash-script|write-artifact|manual-handoff|chrome-extension|computer-use",
    "tools": ["allowed-tools entries — e.g. Bash(curl *)"],
    "snippet": "verbatim shell or curl snippet skill body should embed (omit for chrome/computer-use)"
  },
  "workflow": ["ordered steps"],
  "risks": ["e.g. local port collision"],
  "sources": [{ "title": "...", "url": "..." }]
}
</output_contract>`;

export async function runWebRecon(opts: WebReconOptions): Promise<WebResearchContext> {
  if (opts.skip) {
    return emptyContext(opts.actionTitle, 'skipped via --planner-no-web');
  }
  const model = pickModel(opts.settings);
  const generalMaxTurns = opts.generalMaxTurns ?? 12;
  const perAppMaxTurns = opts.perAppMaxTurns ?? 6;
  const topAppCount = opts.topAppCount ?? 5;
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  let costUsd = 0;
  let warning: string | undefined;
  // `general` is mutated inside the pooled task below; held on an object so TS
  // doesn't narrow it to `null` (assignments in a closure don't widen a bare
  // `let` back to its declared union for later reads).
  const out: {
    general: Omit<WebResearchContext, 'appIntegrationSurfaces' | 'webPassesCompleted' | 'costUsd' | 'warning'> | null;
  } = { general: null };
  const surfaces: WebAppIntegrationSurface[] = [];

  // The general pass + each per-app pass are independent `claude -p` calls.
  // Per the subagent research (subagents run sequentially + return lossy
  // summaries; agent teams are experimental/interactive), the right model here
  // is N parallel OS processes with a concurrency cap — each yields its own
  // structured JSON, its own timeout, its own cost. We run them through a
  // simple pool so they overlap instead of summing wall-clock.
  const topApps = pickTopAppsForResearch(opts.apps, opts.actionTitle, opts.actionDescription, topAppCount);
  const total = 1 + topApps.length;
  let completed = 0;
  const tick = (label: string) => {
    completed++;
    opts.onProgress?.(`${label} (${completed}/${total} passes done)`);
  };
  opts.onProgress?.(`researching ${topApps.length} app(s) + general best-practices — ${Math.min(concurrency, total)} in parallel`);

  const tasks: Array<() => Promise<void>> = [];

  // General task-research pass.
  tasks.push(async () => {
    try {
      const prompt = GENERAL_PROMPT
        .replace('{{ACTION_TITLE}}', escapeForPrompt(opts.actionTitle))
        .replace('{{ACTION_DESCRIPTION}}', escapeForPrompt(opts.actionDescription ?? ''));
      const result = await runClaude({
        prompt,
        model,
        allowedTools: ['WebSearch', 'WebFetch'],
        maxTurns: generalMaxTurns,
        cwd: opts.cwd,
        maxBudgetUsd: opts.settings.perCallBudgetUsd,
        timeoutMs: 5 * 60_000,
        strictMcpConfig: true,
        signal: opts.signal,
      });
      costUsd += result.json?.cost_usd ?? 0;
      out.general = parseGeneral(extractText(result));
    } catch (err) {
      logger.debug('[web-recon] pass1 failed', { error: err instanceof Error ? err.message : String(err) });
      warning = `general web research failed: ${err instanceof Error ? err.message.slice(0, 160) : 'unknown'}`;
    } finally {
      tick('general best-practices');
    }
  });

  // Per-app integration-surface passes.
  for (const app of topApps) {
    tasks.push(async () => {
      try {
        const prompt = PER_APP_PROMPT
          .replace('{{ACTION_TITLE}}', escapeForPrompt(opts.actionTitle))
          .replace('{{ACTION_DESCRIPTION}}', escapeForPrompt(opts.actionDescription ?? ''))
          .replace(/{{APP_NAME}}/g, escapeForPrompt(app.name))
          .replace('{{APP_VERSION_OR_NONE}}', app.version ?? '');
        const result = await runClaude({
          prompt,
          model,
          allowedTools: ['WebSearch', 'WebFetch'],
          maxTurns: perAppMaxTurns,
          cwd: opts.cwd,
          maxBudgetUsd: opts.settings.perCallBudgetUsd,
          timeoutMs: 3 * 60_000,
          strictMcpConfig: true,
          signal: opts.signal,
        });
        costUsd += result.json?.cost_usd ?? 0;
        const surface = parseAppSurface(extractText(result), app.name);
        if (surface) surfaces.push(surface);
      } catch (err) {
        logger.debug('[web-recon] per-app pass failed', { app: app.name, error: err instanceof Error ? err.message : String(err) });
      } finally {
        tick(app.name);
      }
    });
  }

  await runWithConcurrency(tasks, concurrency);

  return {
    taskDomain: out.general?.taskDomain ?? opts.actionTitle.slice(0, 60),
    bestPracticePatterns: out.general?.bestPracticePatterns ?? [],
    recommendedTools: out.general?.recommendedTools ?? [],
    recentInnovations: out.general?.recentInnovations ?? [],
    warningsAndPitfalls: out.general?.warningsAndPitfalls ?? [],
    appIntegrationSurfaces: surfaces,
    webPassesCompleted: { general: out.general !== null, perAppCount: surfaces.length },
    costUsd,
    warning,
  };
}

/**
 * Run `tasks` with at most `limit` in flight at once. Each task owns its
 * try/catch (failures are logged inside, never rejected), so the pool always
 * drains — one wedged web pass can't sink the others.
 */
async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const idx = next++;
      await tasks[idx]!();
    }
  };
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
}

function emptyContext(actionTitle: string, warning: string): WebResearchContext {
  return {
    taskDomain: actionTitle.slice(0, 60),
    bestPracticePatterns: [],
    recommendedTools: [],
    recentInnovations: [],
    warningsAndPitfalls: [],
    appIntegrationSurfaces: [],
    webPassesCompleted: { general: false, perAppCount: 0 },
    costUsd: 0,
    warning,
  };
}

function pickModel(settings: AppSettings): string {
  const v = settings.researchModel ?? settings.primaryModel ?? 'sonnet';
  return typeof v === 'string' ? v : 'sonnet';
}

function escapeForPrompt(text: string): string {
  return text.replace(/<\/?action>/gi, '').replace(/<\/?instructions>/gi, '').slice(0, 4000);
}

/**
 * Pick the top N apps for the per-app research pass. Sorted by simple keyword
 * relevance against the action title + description; ties resolved by app
 * category preference.
 */
export function pickTopAppsForResearch(
  apps: DetectedApp[],
  actionTitle: string,
  actionDescription: string | undefined,
  topN: number,
): DetectedApp[] {
  const haystack = `${actionTitle} ${actionDescription ?? ''}`.toLowerCase();
  const tokens = haystack.match(/[a-z0-9]+/g) ?? [];
  const scored = apps.map((app) => {
    const lower = app.name.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (t.length < 3) continue;
      if (lower.includes(t)) score += 5;
    }
    // Boost by category match against common action verbs.
    if (/(record|video|stream|edit|render|design|brand)/i.test(haystack) && app.category === 'creative') score += 3;
    if (/(meet|message|share|notify|invite)/i.test(haystack) && app.category === 'comms') score += 3;
    if (/(deploy|ship|build|refactor|debug)/i.test(haystack) && app.category === 'dev') score += 3;
    if (/(report|track|spreadsheet|kpi|chart)/i.test(haystack) && app.category === 'data') score += 3;
    if (/(invoice|charge|budget|cash|forecast)/i.test(haystack) && app.category === 'finance') score += 3;
    return { app, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, topN).map((s) => s.app);
}

export function parseGeneral(text: string): Omit<
  WebResearchContext,
  'appIntegrationSurfaces' | 'webPassesCompleted' | 'costUsd' | 'warning'
> | null {
  const parsed = safeParseJSON<Record<string, unknown>>(text);
  if (!parsed.success || !parsed.data || typeof parsed.data !== 'object') return null;
  const d = parsed.data;
  return {
    taskDomain: asString(d.taskDomain) ?? 'general',
    bestPracticePatterns: coerceArray(d.bestPracticePatterns).map(coercePattern).filter(nonNull),
    recommendedTools: coerceArray(d.recommendedTools).map(coerceTool).filter(nonNull),
    recentInnovations: coerceArray(d.recentInnovations).map(coerceInnovation).filter(nonNull),
    warningsAndPitfalls: coerceArray(d.warningsAndPitfalls).map((v) => asString(v) ?? '').filter(Boolean),
  };
}

export function parseAppSurface(text: string, fallbackName: string): WebAppIntegrationSurface | null {
  const parsed = safeParseJSON<Record<string, unknown>>(text);
  if (!parsed.success || !parsed.data || typeof parsed.data !== 'object') return null;
  const d = parsed.data;
  const kind = asInvocationKind(((d.invocationHint ?? {}) as Record<string, unknown>).kind);
  if (!kind) return null;
  const ih = (d.invocationHint ?? {}) as Record<string, unknown>;
  return {
    appName: asString(d.appName) ?? fallbackName,
    integrationKind: asIntegrationKind(d.integrationKind) ?? 'none',
    invocationHint: {
      kind,
      tools: coerceStringArray(ih.tools),
      snippet: asString(ih.snippet),
    },
    workflow: coerceStringArray(d.workflow),
    risks: coerceStringArray(d.risks),
    sources: coerceSources(d.sources),
  };
}

// ---------- coercion helpers ----------

function coerceArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function coerceStringArray(value: unknown): string[] {
  return coerceArray(value).map((v) => asString(v) ?? '').filter(Boolean);
}

function coercePattern(raw: unknown): WebBestPracticePattern | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pattern = asString(r.pattern);
  if (!pattern) return null;
  return { pattern, rationale: asString(r.rationale) ?? '', sources: coerceSources(r.sources) };
}

function coerceTool(raw: unknown): WebRecommendedTool | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = asString(r.name);
  if (!name) return null;
  return {
    name,
    category: asCategory(r.category) ?? 'web-service',
    purpose: asString(r.purpose) ?? '',
    integrationHint: asString(r.integrationHint) ?? '',
    sources: coerceSources(r.sources),
  };
}

function coerceInnovation(raw: unknown): WebRecentInnovation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = asString(r.name);
  if (!name) return null;
  return { name, summary: asString(r.summary) ?? '', sources: coerceSources(r.sources) };
}

function coerceSources(value: unknown): Array<{ title: string; url: string }> {
  return coerceArray(value)
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const r = raw as Record<string, unknown>;
      const title = asString(r.title);
      const url = asString(r.url);
      if (!title || !url) return null;
      return { title, url };
    })
    .filter(nonNull);
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function asCategory(value: unknown): WebRecommendedTool['category'] | null {
  if (typeof value !== 'string') return null;
  const v = value.toLowerCase();
  if (v === 'cli' || v === 'desktop-app' || v === 'mcp-server' || v === 'web-service' || v === 'api') return v;
  return null;
}

function asIntegrationKind(value: unknown): WebAppIntegrationSurface['integrationKind'] | null {
  if (typeof value !== 'string') return null;
  const v = value.toLowerCase();
  if (v === 'local-http' || v === 'cli' || v === 'url-scheme' || v === 'file-system'
   || v === 'mcp-server' || v === 'sdk' || v === 'none') return v;
  return null;
}

function asInvocationKind(value: unknown): WebInvocationHint['kind'] | null {
  if (typeof value !== 'string') return null;
  const v = value.toLowerCase();
  if (v === 'bash-cmd' || v === 'bash-curl' || v === 'mcp-tool' || v === 'bash-script'
   || v === 'write-artifact' || v === 'manual-handoff' || v === 'chrome-extension' || v === 'computer-use') return v;
  return null;
}

function nonNull<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}
