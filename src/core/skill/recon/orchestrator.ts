/**
 * Recon orchestrator — Phase 5 Skill Planner.
 *
 * Runs all three recon phases (PC scan + wiki recon + web recon) in parallel
 * via Promise.allSettled, aggregates results, and produces the
 * `ReconTriple` the Planner reasoning step consumes.
 *
 * Partial failures degrade gracefully — each phase has its own warning slot,
 * and the orchestrator's `warnings[]` aggregates them so the Planner prompt
 * (and the user-review modal) can surface "web research timed out" without
 * blocking the whole pipeline.
 */
import type { AppSettings } from '../../../storage/types.js';
import type { ResolvedWorkspace } from '../../../storage/paths.js';
import { scan as scanPc, type ReconResult } from './pc-scan.js';
import { runWikiRecon, type WikiContext } from './wiki-recon.js';
import { runWebRecon, type WebResearchContext } from './web-recon.js';

export interface ReconTriple {
  pc: ReconResult;
  wiki: WikiContext;
  web: WebResearchContext;
  /** Aggregated warnings from all three phases. */
  warnings: Array<{
    phase: 'pc-scan' | 'wiki-recon' | 'web-research-general' | 'web-research-per-app';
    severity: 'info' | 'warn' | 'error';
    message: string;
  }>;
  /** Sum of LLM cost across wiki + web phases (PC scan is free). */
  costUsd: number;
  /** Wall-clock for the slowest phase (since they run in parallel). */
  durationMs: number;
}

export interface ReconOptions {
  workspace: ResolvedWorkspace;
  settings: AppSettings;
  actionTitle: string;
  actionDescription?: string;
  discussionSummary?: string;
  skipPcScan?: boolean;
  skipWiki?: boolean;
  skipWeb?: boolean;
  /**
   * Run the full-disk crawl during the PC scan (finds MCP/skills outside known
   * config stores). Blocks for several seconds — default ON for thoroughness.
   */
  pcDeepScan?: boolean;
  /** Wall-clock budget for the deep disk crawl. Default 12_000ms. */
  pcDiskBudgetMs?: number;
  /** Cancellation — propagated to the wiki + web `claude` children. */
  signal?: AbortSignal;
  /** Default 5. */
  topAppCount?: number;
  /** Fires when a phase BEGINS — lets the UI show 'running' instead of leaving
   *  wiki/web on 'queued' for the whole (slow) parallel block. */
  onPhaseStart?: (phase: 'pc-scan' | 'wiki-recon' | 'web-research') => void;
  /** Fires for sub-steps within a phase (e.g. web 'app 2/5: Photoshop') so the
   *  UI has a live heartbeat during the long web pass. */
  onPhaseProgress?: (phase: 'pc-scan' | 'wiki-recon' | 'web-research', detail: string) => void;
  /** Streaming progress callback — fires when each phase completes. Each phase
   *  reports independently the moment IT settles (not after the slower one). */
  onPhaseDone?: (phase: 'pc-scan' | 'wiki-recon' | 'web-research', summary: string) => void;
}

export async function runRecon(opts: ReconOptions): Promise<ReconTriple> {
  const started = Date.now();
  const warnings: ReconTriple['warnings'] = [];

  // PC scan is sync + fast; run it inline so wiki + web have its output available
  // if we ever start cross-referencing (T1.3 already wires apps → per-app web pass).
  opts.onPhaseStart?.('pc-scan');
  let pc: ReconResult;
  if (opts.skipPcScan) {
    pc = emptyPc('skipped via --planner-no-pc-scan');
  } else {
    const deepScan = opts.pcDeepScan !== false; // default ON
    if (deepScan) opts.onPhaseProgress?.('pc-scan', 'crawling disk for MCP servers + skills…');
    try {
      pc = scanPc({ projectRoot: opts.workspace.root, deepScan, diskBudgetMs: opts.pcDiskBudgetMs });
    } catch (err) {
      pc = emptyPc(err instanceof Error ? err.message.slice(0, 160) : 'pc scan failed');
    }
  }
  for (const w of pc.warnings) warnings.push({ phase: 'pc-scan', severity: w.severity, message: w.message });
  opts.onPhaseDone?.(
    'pc-scan',
    `${pc.apps.length} apps, ${pc.cliTools.length} CLI tools, ${pc.mcpServers.length} MCP, ${pc.existingSkills.length} skills, ${pc.envVars.length} env`,
  );

  // Wiki + web run in parallel. Mark both 'running' up front so the UI doesn't
  // leave them on 'queued' for the (potentially many-minute) duration.
  opts.onPhaseStart?.('wiki-recon');
  opts.onPhaseStart?.('web-research');

  const wikiPromise = runWikiRecon({
    workspace: opts.workspace,
    settings: opts.settings,
    actionTitle: opts.actionTitle,
    actionDescription: opts.actionDescription,
    discussionSummary: opts.discussionSummary,
    skip: opts.skipWiki,
    signal: opts.signal,
  });
  const webPromise = runWebRecon({
    settings: opts.settings,
    actionTitle: opts.actionTitle,
    actionDescription: opts.actionDescription,
    apps: pc.apps,
    skip: opts.skipWeb,
    topAppCount: opts.topAppCount,
    cwd: opts.workspace.root,
    onProgress: (detail) => opts.onPhaseProgress?.('web-research', detail),
    signal: opts.signal,
  });

  // Track each phase independently so its 'done' fires the moment IT settles —
  // a fast wiki pass no longer waits behind a slow web pass before the UI
  // updates. Both run to completion either way (warnings aggregated below).
  const [wiki, web] = await Promise.all([
    (async (): Promise<WikiContext> => {
      let w: WikiContext;
      try {
        w = await wikiPromise;
      } catch (err) {
        w = {
          playbooks: [], templates: [], domainKnowledge: [], pastLessons: [],
          stakeholders: [], endorsedDirections: [], vetoes: [], pastDecisions: [],
          relevantPages: [],
          costUsd: 0,
          warning: err instanceof Error ? err.message : 'wiki recon failed',
        };
      }
      if (w.warning) warnings.push({ phase: 'wiki-recon', severity: 'warn', message: w.warning });
      opts.onPhaseDone?.(
        'wiki-recon',
        `${w.playbooks.length} playbooks, ${w.templates.length} templates, ${w.domainKnowledge.length} knowledge, ${w.stakeholders.length} stakeholders, ${w.vetoes.length} vetoes`,
      );
      return w;
    })(),
    (async (): Promise<WebResearchContext> => {
      let v: WebResearchContext;
      try {
        v = await webPromise;
      } catch (err) {
        v = {
          taskDomain: opts.actionTitle.slice(0, 60),
          bestPracticePatterns: [],
          recommendedTools: [],
          recentInnovations: [],
          warningsAndPitfalls: [],
          appIntegrationSurfaces: [],
          webPassesCompleted: { general: false, perAppCount: 0 },
          costUsd: 0,
          warning: err instanceof Error ? err.message : 'web recon failed',
        };
      }
      if (!v.webPassesCompleted.general) {
        warnings.push({
          phase: 'web-research-general',
          severity: 'warn',
          message: v.warning ?? 'general web pass returned no parseable output',
        });
      }
      opts.onPhaseDone?.(
        'web-research',
        `${v.bestPracticePatterns.length} patterns, ${v.recommendedTools.length} tools, ${v.appIntegrationSurfaces.length} app surfaces`,
      );
      return v;
    })(),
  ]);

  return {
    pc,
    wiki,
    web,
    warnings,
    costUsd: wiki.costUsd + web.costUsd,
    durationMs: Date.now() - started,
  };
}

function emptyPc(reason: string): ReconResult {
  return {
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    scannedAt: new Date().toISOString(),
    apps: [],
    cliTools: [],
    mcpServers: [],
    browserExtensions: [],
    envVars: [],
    existingSkills: [],
    playwright: false,
    chrome: false,
    computerUseAvailable: false,
    warnings: [{ phase: 'pc-scan', severity: 'warn', message: reason }],
  };
}
