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
  /** Default 5. */
  topAppCount?: number;
  /** Streaming progress callback — fires when each phase completes. */
  onPhaseDone?: (phase: 'pc-scan' | 'wiki-recon' | 'web-research', summary: string) => void;
}

export async function runRecon(opts: ReconOptions): Promise<ReconTriple> {
  const started = Date.now();
  const warnings: ReconTriple['warnings'] = [];

  // PC scan is sync + fast; run it inline so wiki + web have its output available
  // if we ever start cross-referencing (T1.3 already wires apps → per-app web pass).
  let pc: ReconResult;
  if (opts.skipPcScan) {
    pc = emptyPc('skipped via --planner-no-pc-scan');
  } else {
    try {
      pc = scanPc({ projectRoot: opts.workspace.root });
    } catch (err) {
      pc = emptyPc(err instanceof Error ? err.message.slice(0, 160) : 'pc scan failed');
    }
  }
  for (const w of pc.warnings) warnings.push({ phase: 'pc-scan', severity: w.severity, message: w.message });
  opts.onPhaseDone?.(
    'pc-scan',
    `${pc.apps.length} apps, ${pc.cliTools.length} CLI tools, ${pc.mcpServers.length} MCP, ${pc.envVars.length} env`,
  );

  // Wiki + web run in parallel.
  const wikiPromise = runWikiRecon({
    workspace: opts.workspace,
    settings: opts.settings,
    actionTitle: opts.actionTitle,
    actionDescription: opts.actionDescription,
    discussionSummary: opts.discussionSummary,
    skip: opts.skipWiki,
  });
  const webPromise = runWebRecon({
    settings: opts.settings,
    actionTitle: opts.actionTitle,
    actionDescription: opts.actionDescription,
    apps: pc.apps,
    skip: opts.skipWeb,
    topAppCount: opts.topAppCount,
    cwd: opts.workspace.root,
  });

  const [wikiSettled, webSettled] = await Promise.allSettled([wikiPromise, webPromise]);
  const wiki: WikiContext = wikiSettled.status === 'fulfilled'
    ? wikiSettled.value
    : {
        relevantPages: [],
        stakeholders: [],
        endorsedDirections: [],
        vetoes: [],
        pastDecisions: [],
        costUsd: 0,
        warning: wikiSettled.reason instanceof Error ? wikiSettled.reason.message : 'wiki recon failed',
      };
  if (wiki.warning) warnings.push({ phase: 'wiki-recon', severity: 'warn', message: wiki.warning });
  opts.onPhaseDone?.(
    'wiki-recon',
    `${wiki.relevantPages.length} pages, ${wiki.stakeholders.length} stakeholders, ${wiki.vetoes.length} vetoes`,
  );

  const web: WebResearchContext = webSettled.status === 'fulfilled'
    ? webSettled.value
    : {
        taskDomain: opts.actionTitle.slice(0, 60),
        bestPracticePatterns: [],
        recommendedTools: [],
        recentInnovations: [],
        warningsAndPitfalls: [],
        appIntegrationSurfaces: [],
        webPassesCompleted: { general: false, perAppCount: 0 },
        costUsd: 0,
        warning: webSettled.reason instanceof Error ? webSettled.reason.message : 'web recon failed',
      };
  if (!web.webPassesCompleted.general) {
    warnings.push({
      phase: 'web-research-general',
      severity: 'warn',
      message: web.warning ?? 'general web pass returned no parseable output',
    });
  }
  opts.onPhaseDone?.(
    'web-research',
    `${web.bestPracticePatterns.length} patterns, ${web.recommendedTools.length} tools, ${web.appIntegrationSurfaces.length} app surfaces`,
  );

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
