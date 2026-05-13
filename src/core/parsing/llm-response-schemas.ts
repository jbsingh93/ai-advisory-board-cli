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
