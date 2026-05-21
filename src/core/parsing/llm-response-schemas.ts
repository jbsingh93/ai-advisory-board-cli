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

const TOUCHPOINT_KINDS = ['draft-email', 'slack-mention', 'calendar-invite', 'doc-share', 'other'] as const;

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
    name: z.enum(TIER_NAMES),
    description: z.string().optional(),
    toolSurface: stringArrayFromUnknown.optional(),
    workflow: stringArrayFromUnknown.optional(),
    produces: stringArrayFromUnknown.optional(),
    estimatedValueScore: boundedNumber(0, 100).optional(),
  })
  .passthrough();

export const proposalIntegrationSchema = z
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
  .passthrough();

export const proposalStakeholderSchema = z
  .object({
    name: z.string(),
    role: z.string().optional(),
    touchpointKind: z.enum(TOUCHPOINT_KINDS).optional(),
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

export const skillDesignProposalSchema = z
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
  .passthrough();

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
 * Validate the proposal's hard semantic gates that go beyond shape:
 *   - skillName not reserved
 *   - maximalist tier has ≥3 integrations across ≥2 distinct sources
 *     (unless empty-recon honest-fallback: recommendedTier = minimal +
 *     rationale explicitly mentions "limited integration surface")
 *
 * Returns null on success; otherwise an array of human-readable failure
 * reasons that callers can feed back to the Planner as `<replan_feedback>`.
 */
export function validateProposalSemantics(p: SkillDesignProposal): string[] | null {
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
  return errors.length === 0 ? null : errors;
}
