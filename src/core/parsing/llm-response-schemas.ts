/**
 * Zod schemas for every LLM contract the discussion engine relies on.
 * Subset of sage-council/src/lib/parsing/llm-response-schemas.ts — only the
 * pieces Phase 1 needs.
 */
import { z } from 'zod';

// ---------- shared preprocessors ----------

const numberFromUnknown = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return value;
}, z.number());

const boundedNumber = (min: number, max: number) =>
  z.preprocess((value) => {
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return value;
  }, z.number().min(min).max(max));

const stringArrayFromUnknown = z.preprocess((value) => {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value.trim() !== '') {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}, z.array(z.string()));

const booleanFromUnknown = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
  }
  return value;
}, z.boolean());

const sourceSchema = z
  .object({
    title: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

// ---------- structured member response ----------

export const structuredResponsePayloadSchema = z
  .object({
    response: z.string(),
    keyPoints: stringArrayFromUnknown.optional(),
    questionsForOthers: stringArrayFromUnknown.optional(),
    actionSteps: stringArrayFromUnknown.optional(),
    confidence: boundedNumber(0, 100).optional(),
    assumptions: stringArrayFromUnknown.optional(),
    tradeoffs: stringArrayFromUnknown.optional(),
    riskMitigations: stringArrayFromUnknown.optional(),
    firstPrinciplesApplied: stringArrayFromUnknown.optional(),
    sources: z.array(sourceSchema).optional(),
  })
  .passthrough();

export type StructuredResponsePayload = z.infer<typeof structuredResponsePayloadSchema>;

// ---------- orchestrator decision ----------

export const userInputRequestPayloadSchema = z
  .object({
    type: z.enum(['clarification', 'decision', 'preference', 'information']).optional(),
    question: z.string().optional(),
    context: z.string().optional(),
    requestingMembers: stringArrayFromUnknown.optional(),
    urgency: z.enum(['low', 'medium', 'high']).optional(),
    options: stringArrayFromUnknown.optional(),
  })
  .passthrough();

export const orchestratorDecisionPayloadSchema = z
  .object({
    action: z.enum(['continue', 'conclude', 'redirect', 'request_user_input']).optional(),
    reasoning: z.string().optional(),
    nextSpeaker: z.string().optional(),
    suggestedDirection: z.string().optional(),
    consensusReached: booleanFromUnknown.optional(),
    confidence: boundedNumber(0, 100).optional(),
    userInputRequest: userInputRequestPayloadSchema.optional(),
  })
  .passthrough();

export type OrchestratorDecisionPayload = z.infer<typeof orchestratorDecisionPayloadSchema>;

// ---------- conversation summary ----------

const summaryParticipantSchema = z
  .object({
    memberId: z.string().optional(),
    memberName: z.string(),
    totalResponses: numberFromUnknown.optional(),
    topicsCovered: stringArrayFromUnknown.optional(),
    influence: boundedNumber(0, 100).optional(),
    averageLength: numberFromUnknown.optional(),
  })
  .passthrough();

export const conversationSummaryPayloadSchema = z
  .object({
    keyPoints: stringArrayFromUnknown.optional(),
    consensus: stringArrayFromUnknown.optional(),
    disagreements: stringArrayFromUnknown.optional(),
    actionableInsights: stringArrayFromUnknown.optional(),
    participationBreakdown: z.array(summaryParticipantSchema).optional(),
    overallQuality: boundedNumber(0, 100).optional(),
  })
  .passthrough();

export type ConversationSummaryPayload = z.infer<typeof conversationSummaryPayloadSchema>;

// ---------- action item extraction (Phase 4) ----------

const PRIORITY_VALUES = ['low', 'medium', 'high'] as const;
const CATEGORY_VALUES = [
  'strategic',
  'operational',
  'technical',
  'research',
  'financial',
  'other',
] as const;

export const extractedActionItemSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    priority: z.enum(PRIORITY_VALUES).optional(),
    category: z.enum(CATEGORY_VALUES).optional(),
    confidence: boundedNumber(0, 100).optional(),
    sourceContext: z.string().optional(),
    suggestedAssignee: z.string().optional(),
    suggestedDueDate: z.string().optional(),
  })
  .passthrough();

export const conversationAnalysisPayloadSchema = z
  .object({
    actionItems: z.array(extractedActionItemSchema).optional(),
    keyInsights: stringArrayFromUnknown.optional(),
    recommendedNextSteps: stringArrayFromUnknown.optional(),
    analysisConfidence: boundedNumber(0, 100).optional(),
  })
  .passthrough();

export type ConversationAnalysisPayload = z.infer<typeof conversationAnalysisPayloadSchema>;

// ---------- Skill Planner (Phase 5) — SkillDesignProposal ----------

const INVOCATION_HINT_KINDS = [
  'bash-cmd', 'bash-curl', 'mcp-tool', 'bash-script',
  'write-artifact', 'manual-handoff',
  'chrome-extension', 'computer-use',
] as const;

const INTEGRATION_SOURCES = [
  'pc-app', 'cli-tool', 'mcp-server', 'wiki-entity',
  'browser-extension', 'web-service', 'api',
] as const;

const SURFACED_FROM_VALUES = [
  'pc-scan', 'wiki-recon', 'web-research', 'web-research-per-app', 'inferred',
] as const;

const TIER_NAMES = ['minimal', 'standard', 'maximalist'] as const;

// Open string by design (used as a display label only — downstream code
// doesn't switch on it). Opus often uses kebab-case variants like
// 'draft-slack-message' or 'send-calendar-invite' which are perfectly
// reasonable descriptors but were rejected by an over-strict enum in
// earlier revisions. Caught via real solve `bnxyfj460` on 2026-05-21.
const TOUCHPOINT_KINDS = ['draft-email', 'slack-mention', 'calendar-invite', 'doc-share', 'other'] as const;
void TOUCHPOINT_KINDS;

const sourceCitationSchema = z
  .object({ title: z.string().optional(), url: z.string().optional() })
  .passthrough();

export const invocationHintSchema = z
  .object({
    kind: z.enum(INVOCATION_HINT_KINDS),
    tools: stringArrayFromUnknown.optional(),
    snippet: z.string().optional(),
    artifactPath: z.string().optional(),
    handoffInstructions: z.string().optional(),
  })
  .passthrough();

export const skillTierSchema = z
  .object({
    // `name` is a human display label here — the canonical identity of the
    // tier is the parent key (`minimal`/`standard`/`maximalist`). Opus tends
    // to fill `name` with a descriptive headline like "End-to-end launch
    // pipeline with Chrome handoff", which is exactly what we want for the
    // proposal UI. Accept any string; don't force the enum.
    name: z.string().optional(),
    description: z.string().optional(),
    toolSurface: stringArrayFromUnknown.optional(),
    workflow: stringArrayFromUnknown.optional(),
    produces: stringArrayFromUnknown.optional(),
    estimatedValueScore: boundedNumber(0, 100).optional(),
  })
  .passthrough();

export const proposalIntegrationSchema = z
  .preprocess(
    // Real-Opus-output tolerance: synonyms the model tends to pick.
    //   - `name` synonyms: `title`, `label`, `displayName`
    //   - `id` synonyms: `key`, `slug`
    //   - `source` synonyms: `surface`, `sourceType`
    // We remap to the canonical shape before validating. Last fallback: if
    // `name` is still missing, derive it from `purpose` (truncated) or `id`.
    (raw) => {
      if (!raw || typeof raw !== 'object') return raw;
      const r = raw as Record<string, unknown>;
      const out = { ...r };
      if (!out.name) {
        out.name = r.title ?? r.label ?? r.displayName ??
          (typeof r.purpose === 'string' ? r.purpose.slice(0, 80) : undefined) ??
          (typeof r.id === 'string' ? r.id : undefined);
      }
      if (!out.id) out.id = r.key ?? r.slug;
      if (!out.source) out.source = r.surface ?? r.sourceType;
      return out;
    },
    z
      .object({
        id: z.string(),
        source: z.enum(INTEGRATION_SOURCES),
        name: z.string(),
        purpose: z.string().optional(),
        workflowSteps: stringArrayFromUnknown.optional(),
        invocationHint: invocationHintSchema,
        requiredTools: stringArrayFromUnknown.optional(),
        fallbackIfMissing: z.string().optional(),
        confidence: boundedNumber(0, 100).optional(),
        surfacedFrom: z.enum(SURFACED_FROM_VALUES).optional(),
        citations: z.array(sourceCitationSchema).optional(),
      })
      .passthrough(),
  );

export const proposalStakeholderSchema = z
  .object({
    name: z.string(),
    role: z.string().optional(),
    // Open string (kebab-case advisory): the Planner may use any descriptor
    // like 'draft-email', 'slack-mention', 'draft-slack-message',
    // 'calendar-invite', 'send-pr-review', etc. Display-only field.
    touchpointKind: z.string().optional(),
    rationale: z.string().optional(),
    produces: z.enum(['artifact', 'send']).optional(),
    artifactPath: z.string().optional(),
    sendVia: z.string().optional(),
    artifactTemplate: z
      .object({
        subject: z.string().optional(),
        body: z.string().optional(),
        attachments: stringArrayFromUnknown.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const proposalWorkflowStepSchema = z
  .object({
    step: z.string(),
    integrations: stringArrayFromUnknown.optional(),
    output: z.string().optional(),
  })
  .passthrough();

export const proposalWarningSchema = z
  .object({
    phase: z.enum(['pc-scan', 'wiki-recon', 'web-research-general', 'web-research-per-app']),
    severity: z.enum(['info', 'warn', 'error']),
    message: z.string(),
  })
  .passthrough();

export const proposalMismatchSchema = z
  .object({
    integrationId: z.string(),
    reason: z.enum(['mcp-not-installed', 'cli-not-found', 'env-var-missing', 'app-not-detected', 'other']),
    requiredTool: z.string(),
    suggestion: z.string().optional(),
  })
  .passthrough();

const SKILL_NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * Top-level synonym remap for the SkillDesignProposal. Real Opus output
 * varies field names from run to run — we maintain this table as a living
 * compatibility layer rather than fighting one synonym at a time. Each entry
 * is "if canonical is missing, look for these alternates in order; first hit
 * wins." Caught via the live solve cascade on 2026-05-21
 * (buhuld3ya/btpijn641/bgnyffj1k/bnxyfj460/bdeznap3h).
 *
 * Keep this table append-only — when a new live run surfaces another
 * synonym, add it here rather than relaxing the schema further.
 */
const TOP_LEVEL_SYNONYMS: Record<string, string[]> = {
  skillName: ['name', 'id', 'slug', 'skill_name'],
  skillSummary: ['summary', 'description', 'tagline', 'skill_summary', 'overview'],
  triggerLanguage: ['trigger', 'whenToUse', 'when_to_use', 'usage'],
  integrations: ['proposalIntegrations', 'integrationsList', 'proposedIntegrations', 'tools'],
  stakeholderTouchpoints: ['stakeholders', 'touchpoints', 'people'],
  proposedWorkflow: ['workflow', 'steps', 'pipeline'],
  vetoes: ['mustNot', 'must_not', 'antipatterns', 'forbidden'],
  valueRationale: ['rationale', 'why', 'justification', 'reasoning'],
  recommendedTier: ['recommended', 'tier', 'recommendedTierName'],
};

function remapTopLevelSynonyms(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  const out = { ...r };
  for (const [canonical, alternates] of Object.entries(TOP_LEVEL_SYNONYMS)) {
    if (out[canonical] !== undefined && out[canonical] !== null) continue;
    for (const alt of alternates) {
      if (r[alt] !== undefined && r[alt] !== null) {
        out[canonical] = r[alt];
        break;
      }
    }
  }
  // Special case: integrations may be nested inside tiers.maximalist.
  if (!Array.isArray(out.integrations) && r.tiers && typeof r.tiers === 'object') {
    const tiers = r.tiers as Record<string, unknown>;
    const max = tiers.maximalist as Record<string, unknown> | undefined;
    if (max && Array.isArray(max.integrations)) {
      out.integrations = max.integrations;
    }
  }
  // Defensive defaults — let downstream code call .length / .map() without
  // guards, and let the semantic validator surface a clean "≥3 integrations"
  // message rather than a cryptic "Required".
  if (!Array.isArray(out.integrations)) out.integrations = [];
  if (out.skillSummary === undefined && typeof out.skillName === 'string') {
    out.skillSummary = String(out.skillName);
  }
  return out;
}

export const skillDesignProposalSchema = z
  .preprocess(
    remapTopLevelSynonyms,
    z
      .object({
        skillName: z
          .string()
          .refine((s) => SKILL_NAME_RE.test(s), { message: 'skillName must be kebab-case ≤64 chars starting with a letter' }),
        skillSummary: z.string(),
        triggerLanguage: z.string().optional(),
        tiers: z.object({
          minimal: skillTierSchema,
          standard: skillTierSchema,
          maximalist: skillTierSchema,
        }),
        recommendedTier: z.enum([...TIER_NAMES, 'custom']),
        integrations: z.array(proposalIntegrationSchema),
        proposedWorkflow: z.array(proposalWorkflowStepSchema).optional(),
        stakeholderTouchpoints: z.array(proposalStakeholderSchema).optional(),
        vetoes: stringArrayFromUnknown.optional(),
        valueRationale: z.string().optional(),
        warnings: z.array(proposalWarningSchema).optional(),
        mismatchedIntegrations: z.array(proposalMismatchSchema).optional(),
        estimatedCostUsd: numberFromUnknown.optional(),
        estimatedDurationMinutes: numberFromUnknown.optional(),
      })
      .passthrough(),
  );

export type SkillDesignProposal = z.infer<typeof skillDesignProposalSchema>;
export type ProposalIntegration = z.infer<typeof proposalIntegrationSchema>;
export type ProposalStakeholder = z.infer<typeof proposalStakeholderSchema>;
export type InvocationHint = z.infer<typeof invocationHintSchema>;

// Reserved skill names that the adapter (§9) refuses.
export const RESERVED_SKILL_NAMES = new Set<string>([
  'skill-creator',
  'master-gpt-prompter',
  'wiki-ingest',
  'wiki-query',
  'wiki-lint',
]);

/**
 * Wiki Tier 1 knowledge slugs the Planner must cite when present. Passed
 * separately because the proposal schema doesn't carry the recon context.
 */
export interface WikiKnowledgeSlugs {
  playbooks: string[];
  templates: string[];
  domainKnowledge: string[];
  pastLessons: string[];
}

/**
 * Validate the proposal's hard semantic gates that go beyond shape:
 *   - skillName not reserved
 *   - maximalist tier has ≥3 integrations across ≥2 distinct sources
 *     (unless empty-recon honest-fallback: recommendedTier = minimal +
 *     rationale explicitly mentions "limited integration surface")
 *   - **Phase 5.1**: if wiki Tier 1 knowledge slugs are passed and non-empty,
 *     the proposal's valueRationale must cite at least one of them by slug —
 *     enforces the "use the wiki, don't decorate with it" contract.
 *
 * Returns null on success; otherwise an array of human-readable failure
 * reasons that callers can feed back to the Planner as `<replan_feedback>`.
 */
export function validateProposalSemantics(
  p: SkillDesignProposal,
  wikiKnowledge?: WikiKnowledgeSlugs,
): string[] | null {
  const errors: string[] = [];
  if (RESERVED_SKILL_NAMES.has(p.skillName)) {
    errors.push(`skillName "${p.skillName}" is reserved by Anthropic — choose a different name`);
  }
  const maximalistCount = (p.integrations ?? []).length;
  const uniqueSources = new Set(p.integrations.map((i) => i.source));
  const isEmptyReconFallback =
    p.recommendedTier !== 'maximalist' &&
    /limited integration surface|no leverageable|environment.*(limited|insufficient)/i.test(p.valueRationale ?? '');
  if (!isEmptyReconFallback) {
    if (maximalistCount < 3) {
      errors.push(`maximalist tier has ${maximalistCount} integrations; need ≥3 (or set recommendedTier to minimal/standard with an explicit limited-environment rationale)`);
    }
    if (uniqueSources.size < 2) {
      errors.push(`integrations span only ${uniqueSources.size} source type; need ≥2 distinct sources (pc-app/mcp-server/wiki-entity/...)`);
    }
  }

  // Phase 5.1 — wiki-as-brain citation gate.
  if (wikiKnowledge) {
    const allSlugs = [
      ...wikiKnowledge.playbooks,
      ...wikiKnowledge.templates,
      ...wikiKnowledge.domainKnowledge,
      ...wikiKnowledge.pastLessons,
    ];
    if (allSlugs.length > 0) {
      const rationale = String(p.valueRationale ?? '');
      const cited = allSlugs.filter((slug) => rationale.includes(slug));
      if (cited.length === 0) {
        const sampleSlugs = allSlugs.slice(0, 5).join(', ');
        errors.push(
          `valueRationale must cite at least one wiki Tier 1 slug (the user has documented their way of doing this — use it). Available slugs: ${sampleSlugs}${allSlugs.length > 5 ? ', …' : ''}`,
        );
      }
      // Also check: every playbook should appear in either valueRationale OR
      // the proposedWorkflow steps. Soft check — surface as a single error if
      // any playbook is completely ignored.
      const workflowJoined = JSON.stringify(p.proposedWorkflow ?? []);
      const integrationsJoined = JSON.stringify(p.integrations ?? []);
      const ignoredPlaybooks = wikiKnowledge.playbooks.filter(
        (slug) => !rationale.includes(slug) && !workflowJoined.includes(slug) && !integrationsJoined.includes(slug),
      );
      if (ignoredPlaybooks.length > 0) {
        errors.push(
          `wiki playbook(s) ignored entirely: ${ignoredPlaybooks.join(', ')}. Playbooks are the most load-bearing wiki tier — at least cite them in valueRationale, ideally execute step-for-step in proposedWorkflow.`,
        );
      }
    }
  }

  return errors.length === 0 ? null : errors;
}
