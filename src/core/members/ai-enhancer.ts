/**
 * AI persona enhancer — generates a comprehensive advisory-board persona +
 * voice-guide for a new or existing member. Three template variants:
 *
 *   - `enhance_famous_person` — wide public recognition; "in-the-room" board behavior.
 *   - `enhance_top_expert`    — top-1% specialist; technical mastery + methodology.
 *   - `enhance_non_famous`    — solid professional; practical, collaborative.
 *
 * Calls the local `claude` binary via `runClaude` (no API key — uses the
 * user's Claude Max/Pro subscription). Ported from
 * `sage-council/src/lib/ai-enhancer.ts` with the Gemini path replaced.
 */
import { runClaude, extractText, type ClaudeStreamEvent } from '../../llm/claude-code-runner.js';
import { safeParseJSONWithSchema } from '../parsing/safe-json.js';
import { enhancementPayloadSchema, type EnhancementPayload } from '../parsing/persona-schemas.js';
import { getFallbackVoiceGuide } from './fallback-voice-guides.js';
import { logger } from '../logger.js';
import type { AppSettings, ClaudeModelAlias, ClaudeModel } from '../../storage/types.js';
import { ModelError } from '../errors.js';

export type EnhancementType = 'famous' | 'expert' | 'non-famous';

export interface EnhancementResult {
  persona: string;
  voiceGuide: string;
}

export interface EnhanceOptions {
  /** Override the model (defaults to settings.researchModel). */
  model?: ClaudeModelAlias | ClaudeModel | string;
  /** Existing persona text (used by `non-famous` to refine instead of overwrite). */
  currentPersona?: string;
  /** External abort signal. */
  signal?: AbortSignal;
  /** Stream events from the underlying claude CLI (forwarded by callers wanting progress). */
  onEvent?: (event: ClaudeStreamEvent) => void;
  /** Per-call timeout (ms). */
  timeoutMs?: number;
}

/**
 * Enhance one member's persona + voiceGuide via the local `claude` CLI.
 * Returns the parsed result. Throws `ModelError` on spawn / non-JSON failure.
 */
export async function enhancePersona(
  args: {
    name: string;
    title: string;
    expertise: string[];
    type: EnhancementType;
  },
  settings: AppSettings,
  opts: EnhanceOptions = {},
): Promise<EnhancementResult> {
  const expertiseText = args.expertise.length > 0 ? args.expertise.join(', ') : 'general business';
  const prompt = buildPrompt(args.type, args.name, args.title, expertiseText, opts.currentPersona);
  const model = opts.model ?? settings.researchModel ?? 'sonnet';

  let raw: string;
  try {
    const result = await runClaude({
      prompt,
      model,
      // No --agent: this is a one-shot persona-generation call.
      allowedTools: ['WebSearch', 'WebFetch'],
      maxTurns: 3,
      timeoutMs: opts.timeoutMs ?? 5 * 60_000,
      signal: opts.signal,
      onEvent: opts.onEvent,
      maxBudgetUsd: settings.perCallBudgetUsd,
    });
    raw = extractText(result);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    logger.error('[ai-enhancer] claude CLI failed:', error);
    throw new ModelError(
      `Persona enhancement failed: ${error instanceof Error ? error.message : String(error)}`,
      'Check `aab doctor` and ensure the `claude` binary is on PATH.',
    );
  }

  return extractEnhancement(raw, args.name);
}

function buildPrompt(
  type: EnhancementType,
  name: string,
  title: string,
  expertiseText: string,
  currentPersona?: string,
): string {
  switch (type) {
    case 'famous':
      return buildFamousPersonPrompt(name, title, expertiseText);
    case 'expert':
      return buildTopExpertPrompt(name, title, expertiseText);
    case 'non-famous':
      return buildNonFamousPrompt(name, title, expertiseText, currentPersona);
  }
}

function buildFamousPersonPrompt(name: string, title: string, expertiseText: string): string {
  return `# IDENTITY LOCK: ${name}
You are creating both a detailed advisory board persona AND a voice guide specifically for ${name}, who is ${title}.

## CRITICAL REQUIREMENTS:
- This is ONLY for ${name} - do not create content for anyone else
- Stay true to ${name}'s known characteristics, achievements, and leadership style
- Focus on their advisory capabilities, not just their fame

## MEMBER CONTEXT:
- Name: ${name}
- Title: ${title}
- Expertise: ${expertiseText}
- Type: FAMOUS person who is widely recognized in their field

## TASK 1: ADVISORY BOARD PERSONA
Generate a comprehensive advisory board persona that includes:

1. **Professional Stature & Recognition**: How their fame and public profile contributes to board credibility
2. **Advisory Board Value**: What unique value they bring specifically to advisory discussions
3. **Leadership Philosophy**: Their known approach to leadership and decision-making
4. **Strategic Approach**: Their methodology for tackling complex business challenges
5. **Board Dynamics**: How they typically interact in high-level strategic discussions

## TASK 2: VOICE & BEHAVIOR GUIDE
Create a concise voice guide that captures:
- Their distinctive communication patterns and decision-making style
- Key phrases, reasoning frameworks, and interaction style they're known for
- How they would behave in advisory board discussions

## OUTPUT FORMAT (CRITICAL):
Return ONLY a raw JSON object with this exact structure. No markdown, no fences, no commentary. Start with \`{\` and end with \`}\`.
{
  "persona": "A comprehensive 4-6 paragraph advisory board persona for ${name}, written in a professional manner that demonstrates intimate knowledge of their professional approach and advisory capabilities.",
  "voiceGuide": "A concise but comprehensive voice and behavior guide that captures ${name}'s distinctive communication patterns, decision-making approach, and interaction style for AI persona simulation.",
  "psychometricProfile": ["BFI-2 style first-person statement 1", "statement 2", "statement 3", "statement 4", "statement 5"],
  "cognitiveProcess": "Step 1: ... -> Step 2: ... -> Step 3: ... -> Step 4: ..."
}

Remember: This is specifically for ${name} and must reflect their known characteristics accurately.`;
}

function buildTopExpertPrompt(name: string, title: string, expertiseText: string): string {
  return `# IDENTITY LOCK: ${name}
You are creating both a detailed advisory board persona AND a voice guide specifically for ${name}, who is ${title}.

## CRITICAL REQUIREMENTS:
- This is ONLY for ${name} - do not create content for anyone else
- This is for a TOP 1% EXPERT who represents the absolute pinnacle of expertise
- Focus on their exceptional expertise and world-class capabilities

## MEMBER CONTEXT:
- Name: ${name}
- Title: ${title}
- Expertise: ${expertiseText}
- Type: TOP 1% EXPERT in their field

## TASK 1: ADVISORY BOARD PERSONA
Generate a comprehensive advisory board persona that includes:

1. **Technical Mastery**: Their deep, nuanced understanding and specialized knowledge
2. **Innovation Leadership**: How they've shaped or advanced their field
3. **Problem-Solving Approach**: Their unique methodology for tackling complex challenges
4. **Industry Standing**: Their reputation and influence among peers
5. **Advisory Excellence**: What makes their guidance invaluable to boards
6. **Strategic Insights**: How they identify opportunities others miss

## TASK 2: VOICE & BEHAVIOR GUIDE
Create a concise voice guide that captures:
- Their expert-level communication patterns and analytical approach
- How they leverage their deep expertise in discussions
- Their characteristic way of breaking down complex problems

## OUTPUT FORMAT (CRITICAL):
Return ONLY a raw JSON object with this exact structure. No markdown, no fences, no commentary. Start with \`{\` and end with \`}\`.
{
  "persona": "A comprehensive 4-6 paragraph advisory board persona for ${name}, demonstrating why they're considered among the very best in ${expertiseText} and how their world-class expertise translates to exceptional board-level value.",
  "voiceGuide": "A concise but comprehensive voice and behavior guide that captures ${name}'s expert-level communication patterns, analytical approach, and how they leverage their specialized knowledge in strategic discussions."
}

Remember: This is specifically for ${name} as a top 1% expert in their field.`;
}

function buildNonFamousPrompt(
  name: string,
  title: string,
  expertiseText: string,
  currentPersona?: string,
): string {
  const personaContext = currentPersona ? `\n\nCURRENT PERSONA: ${currentPersona}` : '';
  return `# IDENTITY LOCK: ${name}
You are creating both a detailed advisory board persona AND a voice guide specifically for ${name}, who is ${title}.

## CRITICAL REQUIREMENTS:
- This is ONLY for ${name} - do not create content for anyone else
- This is for a NON-FAMOUS professional with solid expertise but not widely recognized
- Focus on their practical experience and reliable expertise

## MEMBER CONTEXT:
- Name: ${name}
- Title: ${title}
- Expertise: ${expertiseText}
- Type: NON-FAMOUS professional${personaContext}

## TASK 1: ADVISORY BOARD PERSONA
Generate a comprehensive advisory board persona that includes:

1. **Professional Background**: Their career journey and key achievements
2. **Advisory Approach**: How they provide practical, grounded insights
3. **Leadership Style**: Their collaborative and consensus-building approach
4. **Problem-Solving**: Their methodical approach to challenges
5. **Strategic Contributions**: What practical value they bring to discussions
6. **Working Style**: How they interact with other board members

## TASK 2: VOICE & BEHAVIOR GUIDE
Create a concise voice guide that captures:
- Their practical communication style and collaborative approach
- How they leverage their expertise to provide grounded insights
- Their methodical problem-solving patterns

## OUTPUT FORMAT (CRITICAL):
Return ONLY a raw JSON object with this exact structure. No markdown, no fences, no commentary. Start with \`{\` and end with \`}\`.
{
  "persona": "A comprehensive 4-6 paragraph advisory board persona for ${name}, written in a professional manner that conveys competence, reliability, and practical expertise in ${expertiseText}.",
  "voiceGuide": "A concise but comprehensive voice and behavior guide that captures ${name}'s practical communication style, collaborative approach, and methodical problem-solving patterns."
}

Remember: This is specifically for ${name} as a solid, dependable professional.`;
}

/**
 * Parse the enhancement response and assemble persona text. Falls back
 * gracefully on parse failure so the caller still gets *something* useful.
 */
export function extractEnhancement(response: string, name: string): EnhancementResult {
  const parseResult = safeParseJSONWithSchema(response, enhancementPayloadSchema);
  if (parseResult.success && parseResult.data.persona) {
    // zod3's `z.preprocess(..., z.array(z.string()))` infers as `unknown` rather
    // than `string[]` at the call site, but our preprocessor guarantees the
    // shape — cast through `string[]` to keep tsc happy.
    const profile = parseResult.data.psychometricProfile as string[] | undefined;
    const cognitive = parseResult.data.cognitiveProcess as string | undefined;
    const persona = composeEnhancedPersona(
      cleanPersonaText(parseResult.data.persona),
      profile,
      cognitive,
    );
    return {
      persona,
      voiceGuide: parseResult.data.voiceGuide
        ? cleanPersonaText(parseResult.data.voiceGuide)
        : getFallbackVoiceGuide(name),
    };
  }

  // Regex extraction fallback (handles JSON near-misses).
  const personaMatch = response.match(/"persona"\s*:\s*"([\s\S]*?)(?:"\s*,\s*"voiceGuide"|"\s*})/);
  const voiceGuideMatch = response.match(/"voiceGuide"\s*:\s*"([\s\S]*?)"\s*[,}]/);
  if (personaMatch && personaMatch[1]) {
    return {
      persona: cleanPersonaText(personaMatch[1]),
      voiceGuide: voiceGuideMatch && voiceGuideMatch[1]
        ? cleanPersonaText(voiceGuideMatch[1])
        : getFallbackVoiceGuide(name),
    };
  }

  // Last resort: treat the whole response as persona text.
  return {
    persona: cleanPersonaText(response),
    voiceGuide: getFallbackVoiceGuide(name),
  };
}

function cleanPersonaText(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\')
    .replace(/^\s*["'`]/, '')
    .replace(/["'`]\s*$/, '')
    .replace(/^{\s*"persona"\s*:\s*"/, '')
    .replace(/"\s*}$/, '')
    .replace(/^```(?:json)?\s*/gim, '')
    .replace(/```\s*$/gim, '')
    .trim();
}

function composeEnhancedPersona(
  basePersona: string,
  psychometricProfile?: string[],
  cognitiveProcess?: string,
): string {
  const normalizedPersona = basePersona.trim();
  const normalizedProfile = (psychometricProfile ?? [])
    .map((s) => cleanPersonaText(s).trim())
    .filter((s) => s.length > 0);
  const normalizedProcess = (cognitiveProcess ?? '').trim();

  if (normalizedProfile.length === 0 && normalizedProcess.length === 0) {
    return normalizedPersona;
  }

  const sections: string[] = [];
  if (normalizedPersona.length > 0) sections.push(normalizedPersona);
  if (normalizedProfile.length > 0) {
    sections.push(['Psychometric Profile (BFI-2):', ...normalizedProfile.map((s) => `- ${s}`)].join('\n'));
  }
  if (normalizedProcess.length > 0) {
    sections.push(`Cognitive Process:\n${normalizedProcess}`);
  }
  return sections.join('\n\n').trim();
}

/** Test-only export — kept exported so unit tests can hit the prompt body directly. */
export const __test = { buildPrompt, cleanPersonaText, composeEnhancedPersona };

/** Test-only payload alias re-export so consumers don't have to know the schema path. */
export type { EnhancementPayload };
