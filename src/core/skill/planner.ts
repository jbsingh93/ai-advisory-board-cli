/**
 * Skill Planner — Phase 5 reasoning engine (Chunk 3).
 *
 * Per PLAN/SKILL_CREATOR.md §6.5: runs ONE researchModel call (Opus 4.7,
 * 1M context) with the four-section input bundle (action + recon triple +
 * settings + optional replan feedback), gets back a `SkillDesignProposal`,
 * validates against schema + semantic gates, and re-runs once with stronger
 * nudges if the validator rejects.
 */
import { runClaude, extractText } from '../../llm/claude-code-runner.js';
import { safeParseJSON } from '../parsing/safe-json.js';
import {
  skillDesignProposalSchema,
  validateProposalSemantics,
  type SkillDesignProposal,
} from '../parsing/llm-response-schemas.js';
import { logger } from '../logger.js';
import { ContractError, ModelError } from '../errors.js';
import { renderSkillPlannerPrompt } from '../prompts/skill-planner.js';
import type { AppSettings, ActionItem, ConversationSummary } from '../../storage/types.js';
import type { ReconTriple } from './recon/orchestrator.js';
import type { ProposalIntegration } from '../parsing/llm-response-schemas.js';
import type { ResolvedWorkspace } from '../../storage/paths.js';

export interface RunPlannerOptions {
  workspace: ResolvedWorkspace;
  settings: AppSettings;
  action: ActionItem;
  discussionSummary?: ConversationSummary;
  recon: ReconTriple;
  maxTier?: 'minimal' | 'standard' | 'maximalist';
  /** When provided, this Planner run is a re-plan; feedback is injected into the prompt. */
  userReplanFeedback?: string;
  /** Override default model — useful for tests + cheap dry-runs. */
  modelOverride?: string;
  /** Streaming event sink (planner_reasoning_*). */
  onEvent?: (event: { type: 'tokens'; tokensIn?: number; tokensOut?: number; elapsedMs?: number }) => void;
}

export interface RunPlannerResult {
  proposal: SkillDesignProposal;
  costUsd: number;
  attempts: number;
  /** Semantic-gate errors that fired across attempts (last successful attempt's pass = empty). */
  attemptErrors: string[][];
  durationMs: number;
}

const MAX_ATTEMPTS = 2;

export async function runPlanner(opts: RunPlannerOptions): Promise<RunPlannerResult> {
  const started = Date.now();
  const model = opts.modelOverride ?? pickResearchModel(opts.settings);
  const maxTier = opts.maxTier ?? 'maximalist';
  const budgetCap = opts.settings.perCallBudgetUsd ?? 2.5;

  const actionItemJson = JSON.stringify(
    {
      id: opts.action.id,
      title: opts.action.title,
      description: opts.action.description,
      priority: opts.action.priority,
      discussionId: opts.action.discussionId,
    },
    null,
    2,
  );
  const discussionSummaryText = opts.discussionSummary
    ? buildDiscussionSummaryString(opts.discussionSummary)
    : '';
  const reconResultJson = JSON.stringify(summarizeRecon(opts.recon), null, 2);

  let attempts = 0;
  let costUsd = 0;
  const attemptErrors: string[][] = [];
  let replanFeedback = opts.userReplanFeedback;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    const prompt = renderSkillPlannerPrompt({
      actionItemJson,
      discussionSummary: discussionSummaryText,
      reconResultJson,
      wikiContextJson: JSON.stringify(opts.recon.wiki, null, 2),
      webResearchContextJson: JSON.stringify(opts.recon.web, null, 2),
      maxTier,
      budgetCapUsd: budgetCap,
      userReplanFeedback: replanFeedback,
    });

    logger.debug('[planner] attempt', { attempt: attempts, model, promptLen: prompt.length });

    let text: string;
    try {
      const result = await runClaude({
        prompt,
        model,
        allowedTools: [],
        maxTurns: 1,
        cwd: opts.workspace.root,
        maxBudgetUsd: budgetCap,
        timeoutMs: 10 * 60_000,
        onEvent: opts.onEvent
          ? (evt) => {
              opts.onEvent?.({
                type: 'tokens',
                tokensIn: evt.usage?.input_tokens,
                tokensOut: evt.usage?.output_tokens,
                elapsedMs: Date.now() - started,
              });
            }
          : undefined,
      });
      costUsd += result.json?.cost_usd ?? 0;
      text = extractText(result);
    } catch (err) {
      throw new ModelError(
        `Skill Planner LLM call failed on attempt ${attempts}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = safeParseJSON<Record<string, unknown>>(text);
    if (!parsed.success || !parsed.data) {
      attemptErrors.push(['Planner did not return parseable JSON']);
      replanFeedback = strongerNudge(attemptErrors[attemptErrors.length - 1]!, replanFeedback);
      continue;
    }

    const schemaResult = skillDesignProposalSchema.safeParse(parsed.data);
    if (!schemaResult.success) {
      const issues = schemaResult.error.issues.slice(0, 6).map((i) => `${i.path.join('.')}: ${i.message}`);
      attemptErrors.push(issues);
      replanFeedback = strongerNudge(issues, replanFeedback);
      continue;
    }

    const proposal = schemaResult.data;
    const semanticErrors = validateProposalSemantics(proposal);
    if (semanticErrors && semanticErrors.length > 0) {
      attemptErrors.push(semanticErrors);
      replanFeedback = strongerNudge(semanticErrors, replanFeedback);
      continue;
    }

    // Project + back-fill — derive requiredTools from invocationHint.tools when the
    // model didn't echo them explicitly (the schema makes the field optional;
    // downstream code needs it populated for grantedTools projection).
    proposal.integrations = proposal.integrations.map((int): ProposalIntegration => ({
      ...int,
      requiredTools: int.requiredTools && int.requiredTools.length > 0 ? int.requiredTools : (int.invocationHint.tools ?? []),
    }));

    attemptErrors.push([]); // last attempt clean
    return {
      proposal,
      costUsd,
      attempts,
      attemptErrors,
      durationMs: Date.now() - started,
    };
  }

  throw new ContractError(
    `Skill Planner failed validation across ${MAX_ATTEMPTS} attempts. Last errors: ${(attemptErrors[attemptErrors.length - 1] ?? []).join('; ')}`,
    'Re-run with --debug to see the raw Planner output. Add --planner-tier standard to relax the ≥3 maximalist integrations gate, or seed more wiki / MCP servers and re-run.',
  );
}

/**
 * Build a stronger replan-feedback nudge from validation errors. The Planner
 * prompt's `<replan_feedback>` block accepts free-form text; we surface the
 * schema/semantic failure verbatim so the model can self-correct.
 */
function strongerNudge(errors: string[], prior?: string): string {
  const lines = [
    '',
    'YOUR PREVIOUS ATTEMPT FAILED VALIDATION. Specific issues:',
    ...errors.map((e) => `  - ${e}`),
    '',
    'Re-emit the proposal with these problems fixed. In particular:',
    '  - skillName must be kebab-case (lowercase letters, digits, hyphens) ≤64 chars',
    '  - integrations[] must span ≥2 distinct source values',
    '  - maximalist tier must have ≥3 integrations OR recommendedTier must be minimal/standard',
    '    AND valueRationale must explicitly note the limited environment',
    '  - every integration MUST have a populated invocationHint with kind + tools',
    '  - return ONLY the JSON object, no fences, no prose',
  ];
  return [prior ?? '', lines.join('\n')].filter(Boolean).join('\n');
}

function pickResearchModel(settings: AppSettings): string {
  const v = settings.researchModel ?? 'opus';
  return typeof v === 'string' ? v : 'opus';
}

function buildDiscussionSummaryString(summary: ConversationSummary): string {
  const parts: string[] = [];
  if (summary.keyPoints?.length) parts.push(`key points: ${summary.keyPoints.slice(0, 6).join(' | ')}`);
  if (summary.consensus?.length) parts.push(`consensus: ${summary.consensus.slice(0, 4).join(' | ')}`);
  if (summary.disagreements?.length) parts.push(`disagreements: ${summary.disagreements.slice(0, 3).join(' | ')}`);
  if (summary.actionableInsights?.length) parts.push(`insights: ${summary.actionableInsights.slice(0, 4).join(' | ')}`);
  return parts.join('\n').slice(0, 4000);
}

/**
 * Compact the recon triple to fit the Planner's context window. Drops fields
 * the Planner doesn't use directly (raw warnings, scannedAt, etc.) and
 * truncates per-entity metadata.
 */
function summarizeRecon(recon: ReconTriple): Record<string, unknown> {
  return {
    platform: recon.pc.platform,
    apps: recon.pc.apps.slice(0, 60).map((a) => ({ name: a.name, version: a.version, category: a.category })),
    cliTools: recon.pc.cliTools.slice(0, 60).map((t) => ({ name: t.name, version: t.version })),
    mcpServers: recon.pc.mcpServers,
    envVars: recon.pc.envVars,
    existingSkills: recon.pc.existingSkills.map((s) => s.name),
    chrome: recon.pc.chrome,
    computerUseAvailable: recon.pc.computerUseAvailable,
    playwright: recon.pc.playwright,
  };
}

/**
 * Compute `grantedTools` as the deterministic projection of accepted
 * integrations + accepted stakeholders onto the Claude Code tool allowlist.
 * Pure function — exposed for unit tests + the user-review post-acceptance
 * step.
 */
export function projectGrantedTools(
  proposal: SkillDesignProposal,
  acceptedIntegrationIds: Set<string>,
  acceptedStakeholderNames: Set<string>,
): string[] {
  const tools = new Set<string>(['Read', 'Write', 'Glob', 'Grep']);
  for (const integration of proposal.integrations) {
    if (!acceptedIntegrationIds.has(integration.id)) continue;
    for (const t of integration.invocationHint.tools ?? []) tools.add(t);
    for (const t of integration.requiredTools ?? []) tools.add(t);
  }
  // Stakeholder send touchpoints contribute their sendVia tool.
  for (const s of proposal.stakeholderTouchpoints ?? []) {
    if (!acceptedStakeholderNames.has(s.name)) continue;
    if (s.produces === 'send' && s.sendVia) tools.add(s.sendVia);
  }
  return Array.from(tools).sort();
}
