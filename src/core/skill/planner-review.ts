/**
 * Planner-review — Phase 5 Chunk 3.
 *
 * Interactive review flow per PLAN/SKILL_CREATOR.md §6.6. CLI surface uses
 * `enquirer` (multi-select for integrations + stakeholders; select for tier
 * radio; confirm for accept). Web UI surfaces equivalent shapes via
 * `/api/actions/:id/plan` + the proposal modal.
 *
 * Output: `SkillCapabilityProfile` with `grantedTools` derived deterministically
 * from accepted integrations. Re-plan loop capped at 3 per solve.
 */
import type { SkillDesignProposal } from '../parsing/llm-response-schemas.js';
import type { ReconTriple } from './recon/orchestrator.js';
import { askConfirm, askMultiSelect, askSelect, askText } from '../../ui/prompts.js';
import { projectGrantedTools } from './planner.js';
import { c } from '../../ui/colors.js';
import { nowIso } from '../utils.js';

export interface PlannerReviewResult {
  status: 'accepted' | 'rejected' | 'replan';
  /** When status === 'accepted', a fully-resolved capability profile. */
  profile?: ResolvedSkillCapabilityProfile;
  /** When status === 'replan', the user's feedback text (≥10 chars). */
  replanFeedback?: string;
}

export interface ResolvedSkillCapabilityProfile {
  generatedAt: string;
  proposal: SkillDesignProposal;
  acceptedTier: 'minimal' | 'standard' | 'maximalist' | 'custom';
  acceptedIntegrationIds: string[];
  rejectedIntegrationIds: string[];
  acceptedStakeholderNames: string[];
  userNarrativeEdits?: string;
  grantedTools: string[];
  /** Carried through for provenance. */
  recon: ReconTriple;
}

export interface InteractiveReviewOptions {
  proposal: SkillDesignProposal;
  recon: ReconTriple;
  /** Set to true for `--yes` mode (accept Planner's recommendedTier + all integrations). */
  autoAccept?: boolean;
}

export async function reviewInteractive(opts: InteractiveReviewOptions): Promise<PlannerReviewResult> {
  const { proposal, recon } = opts;

  if (opts.autoAccept) {
    return acceptAll(proposal, recon);
  }

  printProposalSummary(proposal);

  // 1. Pick tier
  const tier = await askSelect<'minimal' | 'standard' | 'maximalist' | 'custom'>(
    'Ambition tier',
    [
      { name: 'maximalist', message: 'maximalist', hint: 'orchestrate everything — recommended' },
      { name: 'standard', message: 'standard', hint: 'balanced power + simplicity' },
      { name: 'minimal', message: 'minimal', hint: 'artifact only, no integrations' },
      { name: 'custom', message: 'custom', hint: 'pick integrations + stakeholders manually' },
    ],
    { initial: (proposal.recommendedTier as 'maximalist') ?? 'maximalist' },
  );

  // 2. Default-accepted integrations per tier
  const defaultAcceptedIds = defaultAcceptanceForTier(proposal, tier);
  const acceptedIntegrationIds = tier === 'custom'
    ? await askMultiSelect(
        'Integrations to include',
        proposal.integrations.map((i) => ({
          name: i.id,
          message: `${i.name} ${c.hint('(' + i.invocationHint.kind + ')')}`,
          hint: i.purpose ?? '',
          selected: defaultAcceptedIds.has(i.id),
        })),
      )
    : Array.from(defaultAcceptedIds);

  // 3. Stakeholders
  const stakeholders = proposal.stakeholderTouchpoints ?? [];
  const acceptedStakeholderNames = stakeholders.length === 0
    ? []
    : await askMultiSelect(
        'Stakeholders to touch',
        stakeholders.map((s) => ({
          name: s.name,
          message: `${s.name} ${c.hint('(' + (s.role ?? '?') + ' — ' + (s.touchpointKind ?? 'other') + ')')}`,
          hint: s.rationale ?? '',
          selected: true,
        })),
      );

  // 4. Narrative edits (free-form, optional)
  const wantEdits = await askConfirm('Edit narrative / add free-form context for skill-creator?', false);
  let userNarrativeEdits: string | undefined;
  if (wantEdits) {
    userNarrativeEdits = await askText('Narrative edits (free text — Enter to finish)', { initial: '' });
    if (!userNarrativeEdits.trim()) userNarrativeEdits = undefined;
  }

  // 5. Final accept / replan / reject
  const finalChoice = await askSelect<'accept' | 'replan' | 'reject'>(
    'What next?',
    [
      { name: 'accept', message: 'Accept and run', hint: 'invoke skill-creator with this proposal' },
      { name: 'replan', message: 'Re-plan with feedback', hint: 'send the Planner back to the drawing board (~$1.74)' },
      { name: 'reject', message: 'Cancel', hint: 'abort the solve' },
    ],
    { initial: 'accept' },
  );

  if (finalChoice === 'reject') {
    return { status: 'rejected' };
  }
  if (finalChoice === 'replan') {
    const feedback = await askText('What did the Planner miss? (≥10 chars)', { initial: '', required: true });
    if (feedback.trim().length < 10) {
      return { status: 'rejected' };
    }
    return { status: 'replan', replanFeedback: feedback.trim() };
  }

  return acceptWith(proposal, recon, tier, acceptedIntegrationIds, acceptedStakeholderNames, userNarrativeEdits);
}

export function acceptAll(proposal: SkillDesignProposal, recon: ReconTriple): PlannerReviewResult {
  const allIntegrationIds = proposal.integrations.map((i) => i.id);
  const allStakeholderNames = (proposal.stakeholderTouchpoints ?? []).map((s) => s.name);
  return acceptWith(proposal, recon, (proposal.recommendedTier as 'maximalist') ?? 'maximalist', allIntegrationIds, allStakeholderNames, undefined);
}

export function acceptWith(
  proposal: SkillDesignProposal,
  recon: ReconTriple,
  tier: 'minimal' | 'standard' | 'maximalist' | 'custom',
  acceptedIntegrationIds: string[],
  acceptedStakeholderNames: string[],
  userNarrativeEdits: string | undefined,
): PlannerReviewResult {
  const grantedTools = projectGrantedTools(
    proposal,
    new Set(acceptedIntegrationIds),
    new Set(acceptedStakeholderNames),
  );
  const rejectedIntegrationIds = proposal.integrations
    .map((i) => i.id)
    .filter((id) => !acceptedIntegrationIds.includes(id));
  return {
    status: 'accepted',
    profile: {
      generatedAt: nowIso(),
      proposal,
      acceptedTier: tier,
      acceptedIntegrationIds,
      rejectedIntegrationIds,
      acceptedStakeholderNames,
      userNarrativeEdits,
      grantedTools,
      recon,
    },
  };
}

function defaultAcceptanceForTier(proposal: SkillDesignProposal, tier: 'minimal' | 'standard' | 'maximalist' | 'custom'): Set<string> {
  if (tier === 'custom') return new Set();
  if (tier === 'minimal') {
    // Keep only write-artifact + read integrations.
    return new Set(
      proposal.integrations
        .filter((i) => i.invocationHint.kind === 'write-artifact' || (i.invocationHint.tools ?? []).every((t) => /^(Read|Write|Glob|Grep|WebSearch|WebFetch)/.test(t)))
        .map((i) => i.id),
    );
  }
  if (tier === 'standard') {
    // Top-2 by confidence.
    const ranked = [...proposal.integrations].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    return new Set(ranked.slice(0, 2).map((i) => i.id));
  }
  // maximalist: all
  return new Set(proposal.integrations.map((i) => i.id));
}

/**
 * Render a human-readable summary of the proposal for the CLI (or for the
 * `--out <path>` markdown export). Pure function — no I/O.
 */
export function renderProposalMarkdown(proposal: SkillDesignProposal): string {
  const lines: string[] = [];
  lines.push(`# Skill Planner proposal: ${proposal.skillName}`);
  lines.push('');
  lines.push(`**Summary:** ${proposal.skillSummary}`);
  if (proposal.triggerLanguage) lines.push(`**Trigger:** ${proposal.triggerLanguage}`);
  lines.push(`**Recommended tier:** ${proposal.recommendedTier}`);
  if (typeof proposal.estimatedCostUsd === 'number') {
    lines.push(`**Estimated cost:** $${proposal.estimatedCostUsd.toFixed(2)} · ~${Math.round(proposal.estimatedDurationMinutes ?? 0)}min`);
  }
  lines.push('');
  if (proposal.valueRationale) {
    lines.push(`## Why maximalist`);
    lines.push('');
    lines.push(proposal.valueRationale);
    lines.push('');
  }
  lines.push(`## Integrations (${proposal.integrations.length})`);
  lines.push('');
  for (const i of proposal.integrations) {
    lines.push(`- **${i.name}** (\`${i.invocationHint.kind}\`, ${i.source})`);
    if (i.purpose) lines.push(`  - Purpose: ${i.purpose}`);
    if (i.invocationHint.snippet) {
      lines.push('  - Snippet:');
      lines.push('    ```');
      lines.push(`    ${i.invocationHint.snippet.replace(/\n/g, '\n    ')}`);
      lines.push('    ```');
    }
    if (i.invocationHint.handoffInstructions) {
      lines.push(`  - Handoff: ${i.invocationHint.handoffInstructions.slice(0, 240)}${i.invocationHint.handoffInstructions.length > 240 ? '…' : ''}`);
    }
    if ((i.invocationHint.tools ?? []).length > 0) {
      lines.push(`  - Tools: ${(i.invocationHint.tools ?? []).join(', ')}`);
    }
    if (i.fallbackIfMissing) lines.push(`  - Fallback: ${i.fallbackIfMissing}`);
  }
  lines.push('');
  if ((proposal.stakeholderTouchpoints ?? []).length > 0) {
    lines.push('## Stakeholder touchpoints');
    lines.push('');
    for (const s of proposal.stakeholderTouchpoints ?? []) {
      lines.push(`- **${s.name}** (${s.role ?? '?'}) — ${s.touchpointKind ?? 'other'}, produces: ${s.produces ?? '?'}`);
      if (s.rationale) lines.push(`  - ${s.rationale}`);
      if (s.artifactTemplate?.subject) lines.push(`  - Draft subject: ${s.artifactTemplate.subject}`);
    }
    lines.push('');
  }
  if ((proposal.vetoes ?? []).length > 0) {
    lines.push('## Vetoes (MUST NOT)');
    for (const v of proposal.vetoes ?? []) lines.push(`- ${v}`);
    lines.push('');
  }
  if ((proposal.warnings ?? []).length > 0) {
    lines.push('## Warnings');
    for (const w of proposal.warnings ?? []) lines.push(`- (${w.severity}) ${w.phase}: ${w.message}`);
    lines.push('');
  }
  if ((proposal.mismatchedIntegrations ?? []).length > 0) {
    lines.push('## Mismatched (Planner asked for tools you don\'t have)');
    for (const m of proposal.mismatchedIntegrations ?? []) {
      lines.push(`- ${m.integrationId} (${m.reason}) — ${m.suggestion ?? ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function printProposalSummary(proposal: SkillDesignProposal): void {
  const out = process.stdout;
  out.write('\n' + c.bold(`Skill Planner proposal: ${proposal.skillName}`) + '\n');
  out.write(c.hint(`  Tier: ${proposal.recommendedTier} · ${proposal.integrations.length} integration(s)\n\n`));
  if (proposal.valueRationale) {
    out.write(`  ${c.bold('Why')}\n  ${proposal.valueRationale.slice(0, 600)}\n\n`);
  }
  out.write(`  ${c.bold('Integrations')}\n`);
  for (const i of proposal.integrations.slice(0, 12)) {
    out.write(`    - ${i.name} ${c.hint('(' + i.invocationHint.kind + ', confidence ' + (i.confidence ?? '?') + ')')}\n`);
  }
  out.write('\n');
}
