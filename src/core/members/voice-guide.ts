/**
 * Voice-guide-only refresher.
 *
 * Used by `aab members regenerate-voice <id>` and the GUI's
 * "Regenerate voice" button. Cheaper than full persona enhancement —
 * single Haiku-class call, no web search.
 */
import { runClaude, extractText } from '../../llm/claude-code-runner.js';
import { safeParseJSONWithSchema } from '../parsing/safe-json.js';
import { voiceGuidePayloadSchema } from '../parsing/persona-schemas.js';
import { getFallbackVoiceGuide } from './fallback-voice-guides.js';
import { logger } from '../logger.js';
import type { AdvisoryBoardMember, AppSettings, ClaudeModelAlias, ClaudeModel } from '../../storage/types.js';

export interface VoiceGuideResult {
  voiceGuide: string;
  error?: string;
  /** True when the result came from the hardcoded fallback (LLM call failed or returned garbage). */
  fellBack: boolean;
}

export interface VoiceGuideOptions {
  model?: ClaudeModelAlias | ClaudeModel | string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function generateVoiceGuide(
  member: AdvisoryBoardMember,
  settings: AppSettings,
  opts: VoiceGuideOptions = {},
): Promise<VoiceGuideResult> {
  const expertiseText = member.expertise.length > 0 ? member.expertise.join(', ') : 'general business';
  const prompt = `# IDENTITY LOCK: ${member.name}
You are creating a Voice & Behavior Guide specifically for ${member.name}, ${member.title}.

## CRITICAL REQUIREMENTS:
- This guide is ONLY for ${member.name} - do not create content for anyone else
- Stay true to ${member.name}'s known characteristics, communication style, and approach
- Focus on how ${member.name} would communicate and behave in advisory board discussions

## MEMBER CONTEXT:
- Name: ${member.name}
- Title: ${member.title}
- Expertise: ${expertiseText}
- Persona: ${member.persona.slice(0, 4000)}

## VOICE GUIDE REQUIREMENTS:
Create a concise Voice & Behavior Guide that captures:

1. **Communication Patterns**: How ${member.name} typically speaks and expresses ideas
2. **Decision-Making Style**: Their approach to analyzing problems and making recommendations
3. **Behavioral Traits**: Their characteristic behaviors in professional discussions
4. **Thinking Frameworks**: The mental models and methodologies they use
5. **Interaction Style**: How they engage with others in advisory contexts

## OUTPUT FORMAT (CRITICAL):
Return ONLY a raw JSON object. No markdown, no fences, no commentary.
{
  "voiceGuide": "A comprehensive yet concise voice and behavior guide for ${member.name}. Focus on their distinctive communication patterns, decision-making approach, key phrases they might use, their typical reasoning process, and how they interact in high-level strategic discussions. Keep it practical and actionable for AI persona simulation."
}

## GUIDELINES:
- Be specific to ${member.name} - avoid generic advice
- Focus on practical communication and behavioral traits
- Keep it concise but comprehensive (3-5 sentences)
- Ensure it's directly applicable for AI persona simulation
- Stay true to ${member.name}'s known characteristics

Remember: This is specifically for ${member.name} and no one else.`;

  const model = opts.model ?? settings.fastModel ?? 'haiku';
  try {
    const result = await runClaude({
      prompt,
      model,
      allowedTools: [],
      maxTurns: 1,
      timeoutMs: opts.timeoutMs ?? 90_000,
      signal: opts.signal,
      maxBudgetUsd: settings.perCallBudgetUsd,
    });
    const raw = extractText(result);
    const parsed = safeParseJSONWithSchema(raw, voiceGuidePayloadSchema);
    if (parsed.success && parsed.data.voiceGuide?.trim()) {
      return { voiceGuide: parsed.data.voiceGuide.trim(), fellBack: false };
    }
    // Sometimes Claude wraps the entire response in a single line of prose without JSON.
    const trimmedRaw = raw.trim();
    if (trimmedRaw.length > 0 && trimmedRaw.length < 4000 && !trimmedRaw.startsWith('{')) {
      return { voiceGuide: trimmedRaw, fellBack: false };
    }
    return {
      voiceGuide: getFallbackVoiceGuide(member.name, { expertise: member.expertise }),
      fellBack: true,
      error: 'LLM response did not match the voiceGuide schema',
    };
  } catch (error) {
    logger.error('[voice-guide] claude CLI failed:', error);
    return {
      voiceGuide: getFallbackVoiceGuide(member.name, { expertise: member.expertise }),
      fellBack: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
