/**
 * Zod schemas for the persona enhancement + voice-guide LLM contracts.
 *
 * Kept separate from `llm-response-schemas.ts` so the Phase 1 discussion
 * engine doesn't pull in persona-specific shapes. Mirrors
 * `sage-council/src/lib/parsing/llm-response-schemas.ts` (enhancement +
 * voice-guide payload shapes).
 */
import { z } from 'zod';

const stringArrayFromUnknown = z.preprocess((value) => {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value.trim() !== '') {
    return value.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}, z.array(z.string()));

export const enhancementPayloadSchema = z
  .object({
    persona: z.string(),
    voiceGuide: z.string().optional(),
    psychometricProfile: stringArrayFromUnknown.optional(),
    cognitiveProcess: z.string().optional(),
  })
  .passthrough();

export type EnhancementPayload = z.infer<typeof enhancementPayloadSchema>;

export const voiceGuidePayloadSchema = z
  .object({
    voiceGuide: z.string(),
  })
  .passthrough();

export type VoiceGuidePayload = z.infer<typeof voiceGuidePayloadSchema>;
