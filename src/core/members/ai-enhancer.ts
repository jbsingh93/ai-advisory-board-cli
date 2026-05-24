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
import { z } from 'zod';
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

/**
 * Research a member's areas of expertise via one web-grounded `claude` call.
 * Returns 3-6 short expertise tags. Used to auto-fill `expertise[]` when a user
 * lets AI fill out a new board member (the "extra call" in the add-member flow).
 *
 * `subject` is what we're researching expertise *for*:
 *   - famous:     the person's name (+ `context` = their title)
 *   - expert:     the field / domain itself
 *   - non-famous: the practitioner's role (+ `context` = their domain)
 *
 * Best-effort: on spawn / parse failure it returns `[]` rather than throwing,
 * so the caller can still proceed (expertise is non-critical and user-editable).
 */
export async function researchExpertise(
  args: { subject: string; context?: string; type: EnhancementType },
  settings: AppSettings,
  opts: EnhanceOptions = {},
): Promise<string[]> {
  const subject = args.subject.trim();
  if (!subject) return [];
  const ctx = args.context?.trim() ? ` (${args.context.trim()})` : '';
  const framing =
    args.type === 'famous'
      ? `the well-known person "${subject}"${ctx}`
      : args.type === 'expert'
        ? `a top 1% expert in the field of "${subject}"`
        : `an experienced practitioner working as "${subject}"${ctx}`;
  const prompt = `Identify the 3-6 most important, specific areas of expertise for ${framing}.
Use web search to ground this in reality where helpful.
Return ONLY a raw JSON array of short strings (2-4 words each), no commentary, no markdown, no fences. Start with \`[\` and end with \`]\`.
Example: ["AI strategy", "scaling startups", "product vision"]`;

  const model = opts.model ?? settings.researchModel ?? 'sonnet';
  try {
    const result = await runClaude({
      prompt,
      model,
      allowedTools: ['WebSearch', 'WebFetch'],
      maxTurns: 3,
      timeoutMs: opts.timeoutMs ?? 3 * 60_000,
      signal: opts.signal,
      onEvent: opts.onEvent,
      maxBudgetUsd: settings.perCallBudgetUsd,
    });
    const parsed = safeParseJSONWithSchema(extractText(result), z.array(z.string()));
    if (parsed.success) {
      return parsed.data
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, 6);
    }
    return [];
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    logger.warn('[ai-enhancer] expertise research failed (non-fatal):', error);
    return [];
  }
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
6. **Psychometric Profile (BFI-2 Expanded)**: Generate 5-7 first-person 'I-statements' that define their personality traits according to the Big Five framework (e.g., 'I am a person who is...'). This must replace generic adjectives to ensure precise behavioral simulation.
7. **Cognitive Architecture**: Define a strictly step-by-step internal reasoning process this person uses. For example: 'First, look for the downside (Inversion). Second, check the math. Third, simplify the message.' This creates the 'Reflective Meta-Prompting' layer

## TASK 2: VOICE & BEHAVIOR GUIDE
Create a concise voice guide that captures:
- Their distinctive communication patterns and decision-making style
- Key phrases, reasoning frameworks, and interaction style they're known for
- How they would behave in advisory board discussions

## OUTPUT FORMAT (CRITICAL):
Return ONLY a raw JSON object with this exact structure. No markdown, no fences, no commentary. Start with \`{\` and end with \`}\`.
{
  "persona": "A comprehensive 4-6 paragraph advisory board persona for ${name}, written in a professional manner that demonstrates intimate knowledge of their professional approach and advisory capabilities.",
  "psychometricProfile": [
    "I am a person who is [Specific BFI-2 Trait for Openness]...",
    "I am a person who is [Specific BFI-2 Trait for Conscientiousness]..."
  ],
  "cognitiveProcess": "Step 1: [Analysis Style] -> Step 2: [Self-Critique/Reflection] -> Step 3: [Decision]",
  "voiceGuide": "A concise but comprehensive voice and behavior guide that captures ${name}'s distinctive communication patterns, decision-making approach, and interaction style for AI persona simulation."
}

Remember: This is specifically for ${name} and must reflect their known characteristics accurately.`;
}

function buildTopExpertPrompt(name: string, title: string, expertiseText: string): string {
  return `# PERSONA LOCK: A top 1% expert in ${expertiseText}
You are creating both a detailed advisory board persona AND a voice guide for a TOP 1% EXPERT in ${expertiseText} — an archetypal authority representing the absolute pinnacle of capability in this field. This is a composite of the very best practitioners and thinkers in ${expertiseText}, not a specific named celebrity.

## CRITICAL REQUIREMENTS:
- Embody the deepest, most current expertise in ${expertiseText}
- Ground every trait in how genuine top-tier experts in this field actually reason and behave
- Focus on world-class capability and methodology, not fame or credentials

## MEMBER CONTEXT:
- Persona: ${name}
- Role: ${title}
- Field / Domain: ${expertiseText}
- Type: TOP 1% EXPERT (archetypal authority in their field)

## TASK 1: ADVISORY BOARD PERSONA
Generate a comprehensive advisory board persona that includes:

1. **Technical Mastery**: The deep, nuanced understanding and specialized knowledge that defines the top 1% in ${expertiseText}
2. **Innovation Leadership**: How the best in this field advance the state of the art
3. **Problem-Solving Approach**: The methodology a world-class ${expertiseText} expert uses on the hardest problems
4. **Industry Standing**: The reputation and influence such an expert commands among peers
5. **Advisory Excellence**: What makes their guidance invaluable in board-level discussions
6. **Psychometric Profile (BFI-2 Expanded)**: Generate 5-7 first-person 'I-statements' that define this expert's personality traits according to the Big Five framework (e.g., 'I am a person who is...'). This must replace generic adjectives to ensure precise behavioral simulation.
7. **Cognitive Architecture**: Define a strictly step-by-step internal reasoning process this expert uses. For example: 'First, decompose the problem to first principles. Second, stress-test against edge cases. Third, quantify the trade-offs.' This creates the 'Reflective Meta-Prompting' layer

## TASK 2: VOICE & BEHAVIOR GUIDE
Create a concise voice guide that captures:
- Their expert-level communication patterns and analytical approach
- How they leverage deep expertise in discussions
- Their characteristic way of breaking down complex problems

## OUTPUT FORMAT (CRITICAL):
Return ONLY a raw JSON object with this exact structure. No markdown, no fences, no commentary. Start with \`{\` and end with \`}\`.
{
  "persona": "A comprehensive 4-6 paragraph advisory board persona for a top 1% expert in ${expertiseText}, demonstrating world-class command of the field and how that expertise translates to exceptional board-level value.",
  "psychometricProfile": [
    "I am a person who is [Specific BFI-2 Trait for Openness]...",
    "I am a person who is [Specific BFI-2 Trait for Conscientiousness]..."
  ],
  "cognitiveProcess": "Step 1: [Analysis Style] -> Step 2: [Self-Critique/Reflection] -> Step 3: [Decision]",
  "voiceGuide": "A concise but comprehensive voice and behavior guide that captures this expert's communication patterns, analytical approach, and how they leverage specialized knowledge in strategic discussions."
}

Remember: This is an archetypal top 1% expert in ${expertiseText} — make them feel like the single most capable practitioner you could put in the room.`;
}

function buildNonFamousPrompt(
  name: string,
  title: string,
  expertiseText: string,
  currentPersona?: string,
): string {
  const personaContext = currentPersona ? `\n\nCURRENT PERSONA: ${currentPersona}` : '';
  return `# PERSONA LOCK: ${name}
You are creating both a detailed advisory board persona AND a voice guide for an experienced, hands-on practitioner: a ${name} (${title}). This is a seasoned real-world professional — not a famous figure — valued for practical, battle-tested judgment in ${expertiseText}.

## CRITICAL REQUIREMENTS:
- Embody a credible, senior practitioner with deep practical experience in ${expertiseText}
- Ground every trait in the day-to-day realities of the work, not theory or celebrity
- Focus on practical, dependable expertise and collaborative judgment

## MEMBER CONTEXT:
- Persona: ${name}
- Role: ${title}
- Expertise / Domain: ${expertiseText}
- Type: PRACTITIONER (experienced hands-on professional)${personaContext}

## TASK 1: ADVISORY BOARD PERSONA
Generate a comprehensive advisory board persona that includes:

1. **Professional Background**: A credible career arc and the kind of hard-won experience this role accrues
2. **Advisory Approach**: How they provide practical, grounded insights
3. **Leadership Style**: Their collaborative and consensus-building approach
4. **Problem-Solving**: Their methodical, pragmatic approach to challenges
5. **Strategic Contributions**: The practical value they bring to discussions
6. **Psychometric Profile (BFI-2 Expanded)**: Generate 5-7 first-person 'I-statements' that define this practitioner's personality traits according to the Big Five framework (e.g., 'I am a person who is...'). This must replace generic adjectives to ensure precise behavioral simulation.
7. **Cognitive Architecture**: Define a strictly step-by-step internal reasoning process this practitioner uses. For example: 'First, check what actually ships. Second, weigh the operational cost. Third, pick the pragmatic option.' This creates the 'Reflective Meta-Prompting' layer

## TASK 2: VOICE & BEHAVIOR GUIDE
Create a concise voice guide that captures:
- Their practical communication style and collaborative approach
- How they leverage their experience to provide grounded insights
- Their methodical problem-solving patterns

## OUTPUT FORMAT (CRITICAL):
Return ONLY a raw JSON object with this exact structure. No markdown, no fences, no commentary. Start with \`{\` and end with \`}\`.
{
  "persona": "A comprehensive 4-6 paragraph advisory board persona for ${name}, written in a professional manner that conveys competence, reliability, and practical expertise in ${expertiseText}.",
  "psychometricProfile": [
    "I am a person who is [Specific BFI-2 Trait for Openness]...",
    "I am a person who is [Specific BFI-2 Trait for Conscientiousness]..."
  ],
  "cognitiveProcess": "Step 1: [Analysis Style] -> Step 2: [Self-Critique/Reflection] -> Step 3: [Decision]",
  "voiceGuide": "A concise but comprehensive voice and behavior guide that captures ${name}'s practical communication style, collaborative approach, and methodical problem-solving patterns."
}

Remember: This is a solid, dependable senior practitioner — credible and grounded, not famous.`;
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
