/**
 * Principle Explorer — 5-step Socratic wizard that helps the user articulate
 * a principle (behavior / anti-pattern / triggers / examples / priority).
 * Ported from `sage-council/src/lib/prompts/default-prompts.ts:principle_explorer_*`.
 *
 * Cross-step context is mandatory: every step's prompt includes the prior
 * turns so the LLM acknowledges them ("You mentioned [exact quote]...")
 * and avoids re-asking the user the same question.
 */
import { runClaude, extractText, type ClaudeStreamEvent } from '../../llm/claude-code-runner.js';
import { logger } from '../logger.js';
import { ModelError } from '../errors.js';
import type {
  AppSettings,
  ClaudeModelAlias,
  ClaudeModel,
  Principle,
  PrincipleCategory,
} from '../../storage/types.js';

export type ExplorerStep = 'behavior' | 'antipattern' | 'triggers' | 'examples' | 'priority';

export const EXPLORER_STEPS: readonly ExplorerStep[] = [
  'behavior',
  'antipattern',
  'triggers',
  'examples',
  'priority',
] as const;

export interface ExplorerTurn {
  step: ExplorerStep;
  role: 'user' | 'assistant';
  content: string;
}

export interface ExplorerContext {
  /** Working principle (may be new — no id required for the explorer). */
  principle: Pick<Principle, 'title' | 'description' | 'category'> & Partial<Principle>;
  /** Conversation history across all steps so far. */
  history: ExplorerTurn[];
  /** Step we're currently exploring. */
  step: ExplorerStep;
  /** True when this is the assistant's first message in this step. */
  isFirstMessage: boolean;
}

export interface ExplorerReplyOptions {
  signal?: AbortSignal;
  onEvent?: (event: ClaudeStreamEvent) => void;
  model?: ClaudeModelAlias | ClaudeModel | string;
  timeoutMs?: number;
}

export interface ExplorerReplyResult {
  reply: string;
  /** True when the reply contained a `**Suggested X:**` synthesis line. */
  synthesised: boolean;
  /** Best-effort extraction of the synthesised value for the current step. */
  suggested?: string;
}

/**
 * Build the system prompt for one step of the explorer.
 */
export function buildExplorerSystemPrompt(ctx: ExplorerContext): string {
  const stepInstructions = STEP_INSTRUCTIONS[ctx.step];
  const stepLabel = STEP_LABELS[ctx.step];
  const existingFields = renderExistingFields(ctx.principle);
  const crossStepContext = renderCrossStepContext(ctx.history, ctx.step);

  const firstMessageBlock = ctx.isFirstMessage
    ? `\nIMPORTANT: This is the START of exploring "${stepLabel}". ${crossStepContext ? 'You MUST first acknowledge what the user shared in previous steps, then ' : ''}ask your first Socratic question OR provide synthesis if you have enough context. Don't wait for the user - YOU lead the conversation.\n`
    : '';

  return `You are a Principle Explorer inspired by Ray Dalio's approach at Bridgewater. Help users articulate their principles through direct, Socratic questioning.

PERSONA:
- Be direct and reality-focused like Dalio: "What specifically happens when..."
- Don't coddle - push for clarity and honesty
- Ask probing questions that reveal the true meaning of their principle
- Keep responses under 100 words - be concise
- Reference their exact words when synthesizing
- Build on previous insights rather than starting fresh each step

${crossStepContext ? `-----------------------------------\nCRITICAL: PREVIOUS STEP CONVERSATIONS (READ FIRST!)\n-----------------------------------\nThe user has already shared these insights. You MUST read and acknowledge them:\n\n${crossStepContext}\n\nMANDATORY RULES:\n1. ACKNOWLEDGE specific examples the user shared: "You mentioned [exact quote]..."\n2. DO NOT ask questions they already answered above\n3. If their previous answers provide enough for this step, SYNTHESIZE IMMEDIATELY\n4. BUILD on their exact words - don't start fresh\n5. For triggers/priority/examples: if context is sufficient, provide synthesis in your FIRST message\n-----------------------------------\n` : ''}

CURRENT STEP: ${stepLabel}

PRINCIPLE: "${ctx.principle.title}"
Category: ${ctx.principle.category}
Description: ${ctx.principle.description}
${existingFields}

INSTRUCTIONS FOR THIS STEP:
${stepInstructions}

RULES:
- Ask at most 1-2 focused questions
- Be direct like Dalio - "What specifically..." / "Give me a real example..."
- Keep responses under 100 words
- When you have enough info, provide your synthesis using the **Suggested X:** format
- Reference their exact words when synthesizing
- Don't repeat what they already said back to them unnecessarily
- Connect insights across steps: "Earlier you mentioned [X], which relates to..."${firstMessageBlock}`;
}

const STEP_LABELS: Record<ExplorerStep, string> = {
  behavior: 'Behavior',
  antipattern: 'Anti-Pattern',
  triggers: 'Trigger Questions',
  examples: 'Examples',
  priority: 'Priority',
};

const STEP_INSTRUCTIONS: Record<ExplorerStep, string> = {
  behavior: `You are exploring WHEN and HOW to apply this principle.
Ask 1-2 focused questions about specific situations where they would apply this.
After getting enough info (1-2 exchanges), provide a synthesis in this exact format:
**Suggested Behavior:** [Your 2-3 sentence actionable behavior description]`,
  antipattern: `You are identifying what VIOLATING this principle looks like.
Ask about warning signs, failure modes, and self-deception patterns.
If the user already described failure modes in previous steps, reference and build on them.
After getting enough info (1-2 exchanges), synthesize:
**Suggested Anti-Pattern:** [Your 2-3 sentence description of violation patterns]`,
  triggers: `Based on the FULL conversation history (including previous steps), generate 2-4 self-check questions.
These should be questions the user can ask themselves to know when this principle applies.
If previous conversations gave enough context, provide synthesis immediately without asking more questions.
Format:
**Suggested Trigger Questions:**
1. [Question 1]
2. [Question 2]
3. [Question 3]`,
  examples: `Ask for 1-2 real situations where they applied (or should have applied) this principle.
IMPORTANT: Check if the user already shared examples in previous steps - if so, use those directly.
Keep examples concrete and personal. Format:
**Suggested Examples:**
1. [Example 1]
2. [Example 2]`,
  priority: `Based on everything discussed across ALL steps, suggest a priority 1-10 with brief reasoning.
Consider: How often does this principle apply? How impactful is following it?
You should have enough context from previous steps to provide this immediately:
**Suggested Priority:** [X]/10 - [One sentence reasoning]`,
};

function renderExistingFields(p: ExplorerContext['principle']): string {
  const lines: string[] = [];
  if (p.behavior) lines.push(`Existing Behavior: ${p.behavior}`);
  if (p.antiPattern) lines.push(`Existing Anti-Pattern: ${p.antiPattern}`);
  if (p.triggerQuestions && p.triggerQuestions.length > 0) {
    lines.push(`Existing Trigger Questions: ${p.triggerQuestions.join(' | ')}`);
  }
  if (p.examples && p.examples.length > 0) {
    lines.push(`Existing Examples: ${p.examples.join(' | ')}`);
  }
  if (typeof p.priority === 'number') lines.push(`Existing Priority: ${p.priority}/10`);
  return lines.length === 0 ? '' : `\nALREADY-FILLED FIELDS:\n${lines.join('\n')}`;
}

function renderCrossStepContext(history: ExplorerTurn[], currentStep: ExplorerStep): string {
  const priorSteps = history.filter((t) => t.step !== currentStep);
  if (priorSteps.length === 0) return '';
  const grouped = new Map<ExplorerStep, ExplorerTurn[]>();
  for (const turn of priorSteps) {
    const arr = grouped.get(turn.step) ?? [];
    arr.push(turn);
    grouped.set(turn.step, arr);
  }
  const sections: string[] = [];
  for (const step of EXPLORER_STEPS) {
    const turns = grouped.get(step);
    if (!turns || turns.length === 0) continue;
    const block = turns.map((t) => `${t.role === 'user' ? 'USER' : 'COACH'}: ${t.content}`).join('\n');
    sections.push(`### Step: ${STEP_LABELS[step]}\n${block}`);
  }
  return sections.join('\n\n');
}

/**
 * Run one turn of the explorer. Returns the assistant's reply and a hint
 * about whether it contained a synthesis line.
 */
export async function explorerReply(
  ctx: ExplorerContext,
  userMessage: string,
  settings: AppSettings,
  opts: ExplorerReplyOptions = {},
): Promise<ExplorerReplyResult> {
  const systemPrompt = buildExplorerSystemPrompt(ctx);
  const sameStepHistory = ctx.history.filter((t) => t.step === ctx.step);
  const trimmedUserMessage = userMessage.trim();
  const transcriptLines: string[] = [];
  for (const turn of sameStepHistory) {
    transcriptLines.push(`${turn.role === 'user' ? 'USER' : 'COACH'}: ${turn.content}`);
  }
  if (trimmedUserMessage) transcriptLines.push(`USER: ${trimmedUserMessage}`);
  if (transcriptLines.length === 0) {
    transcriptLines.push('(open the step — the user hasn\'t spoken yet)');
  }

  const prompt = `${systemPrompt}\n\n---\n\nCURRENT-STEP TRANSCRIPT:\n${transcriptLines.join('\n')}\n\nRespond now as the Principle Explorer. Stay under 100 words.`;
  const model = opts.model ?? settings.primaryModel ?? 'sonnet';

  let raw: string;
  try {
    const result = await runClaude({
      prompt,
      model,
      allowedTools: [],
      maxTurns: 1,
      timeoutMs: opts.timeoutMs ?? 3 * 60_000,
      signal: opts.signal,
      onEvent: opts.onEvent,
      maxBudgetUsd: settings.perCallBudgetUsd,
    });
    raw = extractText(result);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    logger.error('[principle-explorer] claude CLI failed:', error);
    throw new ModelError(
      `Principle Explorer reply failed: ${error instanceof Error ? error.message : String(error)}`,
      'Run `aab doctor` to verify the claude binary is reachable.',
    );
  }

  const reply = raw.trim();
  const suggested = extractSuggested(reply, ctx.step);
  return { reply, synthesised: !!suggested, suggested };
}

/**
 * Parse a `**Suggested X:**` line out of an explorer reply. Returns the
 * content after the colon (and after numbered list items, for triggers
 * and examples).
 */
export function extractSuggested(reply: string, step: ExplorerStep): string | undefined {
  const headers: Record<ExplorerStep, RegExp> = {
    behavior: /\*\*Suggested Behavior:\*\*\s*([\s\S]+?)(?:\n\n|$)/i,
    antipattern: /\*\*Suggested Anti-?Pattern:\*\*\s*([\s\S]+?)(?:\n\n|$)/i,
    triggers: /\*\*Suggested Trigger Questions:\*\*\s*([\s\S]+?)(?:\n\n|$)/i,
    examples: /\*\*Suggested Examples:\*\*\s*([\s\S]+?)(?:\n\n|$)/i,
    priority: /\*\*Suggested Priority:\*\*\s*([\s\S]+?)(?:\n\n|$)/i,
  };
  const m = reply.match(headers[step]);
  if (!m || typeof m[1] !== 'string') return undefined;
  return m[1].trim();
}

/**
 * Apply a synthesised step value back to a working principle draft.
 */
export function applyStep(
  base: Pick<Principle, 'title' | 'description' | 'category'> & Partial<Principle>,
  step: ExplorerStep,
  value: string,
): Pick<Principle, 'title' | 'description' | 'category'> & Partial<Principle> {
  switch (step) {
    case 'behavior':
      return { ...base, behavior: value };
    case 'antipattern':
      return { ...base, antiPattern: value };
    case 'triggers':
      return { ...base, triggerQuestions: parseNumberedList(value) };
    case 'examples':
      return { ...base, examples: parseNumberedList(value) };
    case 'priority': {
      const m = value.match(/(\d+)/);
      const n = m && m[1] ? Number(m[1]) : Number.NaN;
      const clamped = Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : base.priority ?? 5;
      return { ...base, priority: clamped };
    }
  }
}

function parseNumberedList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter((line) => line.length > 0);
}

export const __test = {
  renderCrossStepContext,
  renderExistingFields,
  parseNumberedList,
  STEP_LABELS,
  STEP_INSTRUCTIONS,
};

export type { PrincipleCategory };
