/**
 * Decision Coach engine — principle-based decision conversations à la Ray
 * Dalio's Bridgewater. The coach helps the user make decisions guided by
 * their stated `Principles`, surfacing principle-vs-emotion conflicts,
 * asking Socratic questions, and referencing anti-patterns + trigger
 * questions.
 *
 * Single non-agent claude call per turn. The coach's "session" is one
 * `DecisionSession` row (messages[] + appliedPrinciples[]).
 */
import { join } from 'node:path';
import { runClaude, extractText, type ClaudeStreamEvent } from '../../llm/claude-code-runner.js';
import { logger } from '../logger.js';
import { ModelError } from '../errors.js';
import { generateUUID, nowIso } from '../utils.js';
import type {
  AppSettings,
  ClaudeModelAlias,
  ClaudeModel,
  DecisionMessage,
  DecisionSession,
  Principle,
} from '../../storage/types.js';

export interface CoachReplyOptions {
  signal?: AbortSignal;
  onEvent?: (event: ClaudeStreamEvent) => void;
  /** Override the model (default: settings.primaryModel). */
  model?: ClaudeModelAlias | ClaudeModel | string;
  timeoutMs?: number;
  /**
   * When true, wire the Knowledge Wiki to this turn: grant the coach
   * Read/Grep/Glob over the workspace and append the wiki-instruction block so
   * it can pull the user's business facts / own ingested thoughts on-demand.
   * Driven by the per-session `DecisionSession.useBusinessWiki` toggle.
   * See `docs/development/COACH_WIKI_CONTEXT.md`.
   */
  useWiki?: boolean;
  /**
   * Workspace root (the dir that contains `wiki/`). Required when `useWiki` so
   * the coach can reach the wiki via `--add-dir` (its spawn cwd is elsewhere).
   */
  workspaceRoot?: string;
  /** Absolute path to the `wiki/` directory. Defaults to `<workspaceRoot>/wiki`. */
  wikiDir?: string;
}

export interface CoachReplyResult {
  session: DecisionSession;
  reply: DecisionMessage;
}

/**
 * Build the Decision Coach system prompt with the user's principles injected.
 * Ported from `sage-council/src/lib/prompts/default-prompts.ts:decision_coach_system`.
 */
export function buildDecisionCoachSystemPrompt(principles: Principle[]): string {
  const activePrinciples = principles.filter((p) => p.isActive);
  const principlesBlock = activePrinciples.length === 0
    ? '(no principles defined yet — ask the user what principles guide them)'
    : activePrinciples
        .sort((a, b) => b.priority - a.priority)
        .map((p) => renderPrincipleForPrompt(p))
        .join('\n\n');

  return `You are a Principles-Based Decision Coach, inspired by Ray Dalio's approach at Bridgewater. Your role is to help the user make decisions based on their stated principles rather than emotional reactions.

## YOUR ROLE
You are a thoughtful, direct advisor who helps people think through decisions using their own stated principles. You don't make decisions for them - you help them discover what their principles suggest.

## GROUND FACTS IN REALITY (WEB SEARCH)
You have **WebSearch** and **WebFetch**. The user's "Embrace Reality" instinct applies to you too: never assert a time-sensitive or checkable fact from memory. Before stating anything about a company's status (public/private, listed/unlisted), current prices, valuations, recent events, regulations, or "as of my training" facts, **search the web first and rely on what you find**. Your training data has a cutoff and goes stale — a company that was private when you trained may have since IPO'd. When you use a source, cite it inline (e.g. the URL or outlet). If you genuinely cannot verify something, say so plainly rather than guessing.

## YOUR APPROACH
1. **Identify Relevant Principles**: When the user describes a situation, identify which of their principles are most relevant. Quote them directly.

2. **Highlight Principle-Emotion Conflicts**: If you notice the user's instinct conflicts with their stated principles, point this out directly but kindly. Example: "I notice your instinct is to avoid the conversation, but your 'Embrace Reality' principle suggests facing uncomfortable truths."

3. **Ask Socratic Questions**: Instead of telling them what to do, ask questions that help them see their situation through the lens of their principles:
   - "What would your [Principle Name] principle suggest here?"
   - "Is this decision aligned with who you want to be?"
   - "What reality might you be avoiding?"

4. **Reference Anti-Patterns**: If you see them falling into an anti-pattern they've defined, call it out. Example: "This sounds like the anti-pattern you identified - 'avoiding difficult conversations'."

5. **Use Trigger Questions**: Apply their own trigger questions back to them when relevant.

6. **Weigh by Priority**: When multiple principles conflict, consider their stated priorities (1-10 scale).

## YOUR TONE
- Be direct and honest (radical transparency)
- Don't coddle or sugarcoat
- Be warm but focused on truth
- Use their language and principle names
- Ground EVERYTHING in THEIR stated principles

## FORMAT
- Use markdown for structure
- Bold principle names when referencing them
- Use bullet points for questions to consider
- Keep responses focused and actionable
- Always end with a question or call to reflection

## IMPORTANT
- Never make the decision for them
- Always ground guidance in THEIR principles
- If they're being emotional, redirect to principle-based thinking
- Reference specific principles by name and priority
- If no principles seem relevant, say so and ask clarifying questions

USER'S PRINCIPLES:
${principlesBlock}`;
}

/**
 * Wiki-instruction block appended to the coach's system prompt when the
 * per-session "Use Business Wiki" toggle is ON. Reuses the member-prompt framing
 * (catalog-first, don't read the mega-index, 1-3 pages) but adds the coach's
 * non-negotiable guardrail: the wiki is **fuel for sharper principle-grounded
 * questions, never subject matter to lecture on.** See
 * `docs/development/COACH_WIKI_CONTEXT.md`.
 */
export function buildCoachWikiInstruction(wikiDir: string): string {
  const dir = wikiDir.replace(/\\/g, '/');
  const lines: string[] = [];
  lines.push('## BUSINESS WIKI (on-demand context about THIS user)');
  lines.push(
    `The user has turned ON their Knowledge Wiki for this session. It lives at \`${dir}\` and holds what we know about them — their business, market, customers, goals, prior decisions, and their own ingested thoughts. Use it to make your principle-grounded questions **specific to this user** instead of generic.`,
  );
  lines.push('');
  lines.push('Retrieve from it on-demand, within your tool budget:');
  lines.push(`1. Start from the compact catalog \`${dir}/.aab/catalog.json\` — it lists every page (slug, title, summary, tags). Do NOT \`Read ${dir}/index.md\` in full (it can exceed 256 KB). \`Grep\` for key terms in the situation if the catalog isn't enough.`);
  lines.push('2. `Read` only the 1-3 most relevant pages before you respond. Pull just what this turn needs — do not browse.');
  lines.push('3. The wiki (internal, user-specific) is your default source for "who is this user / what is their business". Web search stays the fallback for generic external facts only — same rule as Embrace Reality.');
  lines.push('');
  lines.push('**CRITICAL — how to USE what you find:** the wiki is fuel for sharper questions, NEVER subject matter to lecture on. You are still a principles-mirror, not a business advisor. Do NOT summarize, quote at length, or give advice on the wiki\'s contents. Turn a fact into a pointed principle-grounded question — e.g. if you learn "Customer X is 40% of ARR", do not explain concentration risk; ask what their **Embrace Reality** principle says about depending on one customer. Stay Socratic, ground everything in THEIR principles, and end on a reflection question as always.');
  return lines.join('\n');
}

/**
 * Wrap the caller's onEvent so we can observe tool-use names (to flag wiki use)
 * while still forwarding every event to the original listener untouched.
 */
function makeCoachEventForwarder(
  passthrough: ((event: ClaudeStreamEvent) => void) | undefined,
  onTool: (toolLower: string) => void,
): (event: ClaudeStreamEvent) => void {
  return (event) => {
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          onTool(block.name.toLowerCase());
        }
      }
    }
    passthrough?.(event);
  };
}

function renderPrincipleForPrompt(p: Principle): string {
  const lines: string[] = [`**${p.title}** (priority ${p.priority}/10, ${p.category})`];
  lines.push(`Description: ${p.description}`);
  if (p.behavior) lines.push(`Behavior: ${p.behavior}`);
  if (p.antiPattern) lines.push(`Anti-pattern: ${p.antiPattern}`);
  if (p.triggerQuestions && p.triggerQuestions.length > 0) {
    lines.push(`Trigger questions: ${p.triggerQuestions.join(' | ')}`);
  }
  return lines.join('\n');
}

/**
 * Start a new decision session.
 */
export function newDecisionSession(situation: string, title?: string): DecisionSession {
  const now = nowIso();
  return {
    id: generateUUID(),
    title: title?.trim() || undefined,
    situation,
    messages: [],
    appliedPrinciples: [],
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Ask the coach to reply to the user's latest message. Appends both the
 * user message and the coach's reply to the session and returns the
 * updated session.
 *
 * If `userMessage` is empty (e.g. starting a brand-new session), the coach
 * is primed with the `situation` field and asked to open the conversation.
 */
export async function coachReply(
  session: DecisionSession,
  principles: Principle[],
  userMessage: string,
  settings: AppSettings,
  opts: CoachReplyOptions = {},
): Promise<CoachReplyResult> {
  const trimmed = userMessage.trim();
  const isOpener = session.messages.length === 0 && trimmed.length === 0;

  let userTurn: DecisionMessage | null = null;
  if (!isOpener) {
    if (trimmed.length === 0) {
      throw new ModelError('Cannot send an empty coach message after the session has started.');
    }
    userTurn = {
      id: generateUUID(),
      sessionId: session.id,
      role: 'user',
      content: trimmed,
      createdAt: nowIso(),
    };
  }

  // Read-side wiki wiring. When on, the coach gets read tools over the workspace
  // and a guardrailed instruction block telling it to pull the user's business
  // facts / own thoughts on-demand — as fuel for sharper principle-grounded
  // questions, NEVER as subject matter to lecture on.
  const useWiki = !!opts.useWiki;
  const wikiDir = opts.wikiDir ?? (opts.workspaceRoot ? join(opts.workspaceRoot, 'wiki') : undefined);

  const transcript = buildTranscript(session, userTurn, isOpener);
  const systemPrompt = buildDecisionCoachSystemPrompt(principles);
  const wikiBlock = useWiki && wikiDir ? `\n\n${buildCoachWikiInstruction(wikiDir)}` : '';
  const fullPrompt = `${systemPrompt}${wikiBlock}\n\n---\n\nCONVERSATION SO FAR:\n${transcript}\n\nRespond now as the Decision Coach. Use markdown. Reference principles by their **Title**. Always end with a question or call to reflection.`;

  const model = opts.model ?? settings.primaryModel ?? 'sonnet';
  // Track whether the coach actually opened the wiki this turn (Read/Grep/Glob)
  // so we can render the transparency badge. WebSearch/WebFetch don't count.
  let usedWiki = false;
  const onEvent = makeCoachEventForwarder(opts.onEvent, (tool) => {
    if (tool === 'read' || tool === 'grep' || tool === 'glob') usedWiki = true;
  });

  // When the wiki is on, the coach needs Read/Grep/Glob plus `--add-dir` access
  // to the workspace root (its spawn cwd is elsewhere). Otherwise it stays
  // exactly as today: web tools only, hermetic.
  const allowedTools = useWiki
    ? ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob']
    : ['WebSearch', 'WebFetch'];
  const addDirs = useWiki && opts.workspaceRoot ? [opts.workspaceRoot] : undefined;

  let raw: string;
  try {
    const result = await runClaude({
      prompt: fullPrompt,
      model,
      // The coach can ground time-sensitive facts (is a company public? current
      // price? recent events?) instead of asserting them from stale training
      // data. We deliberately do NOT set maxTurns — a low tool-turn cap produces
      // spurious `max_turns` failures the moment the model takes a search turn
      // before answering (same lesson as emit-member-agent.ts). The per-call
      // budget + wall-clock timeout are the real guardrails.
      allowedTools,
      addDirs,
      // Only WebSearch/WebFetch (+ optional wiki read tools) are needed — skip
      // the (slow / OAuth-stalling) startup of the user's configured MCP servers.
      strictMcpConfig: true,
      timeoutMs: opts.timeoutMs ?? 5 * 60_000,
      signal: opts.signal,
      onEvent,
      maxBudgetUsd: settings.perCallBudgetUsd,
    });
    raw = extractText(result);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    logger.error('[decision-coach] claude CLI failed:', error);
    throw new ModelError(
      `Decision Coach reply failed: ${error instanceof Error ? error.message : String(error)}`,
      'Run `aab doctor` to verify the claude binary is reachable.',
    );
  }

  const cleaned = raw.trim();
  if (cleaned.length === 0) {
    throw new ModelError('Decision Coach returned an empty reply.');
  }

  const referenced = extractReferencedPrincipleIds(cleaned, principles);
  const coachTurn: DecisionMessage = {
    id: generateUUID(),
    sessionId: session.id,
    role: 'assistant',
    content: cleaned,
    principlesReferenced: referenced.length > 0 ? referenced : undefined,
    usedWiki: usedWiki || undefined,
    createdAt: nowIso(),
  };

  const newMessages = [...session.messages];
  if (userTurn) newMessages.push(userTurn);
  newMessages.push(coachTurn);

  const newApplied = mergeAppliedPrinciples(session.appliedPrinciples, referenced);
  const updated: DecisionSession = {
    ...session,
    messages: newMessages,
    appliedPrinciples: newApplied,
    updatedAt: nowIso(),
  };

  return { session: updated, reply: coachTurn };
}

function buildTranscript(session: DecisionSession, userTurn: DecisionMessage | null, isOpener: boolean): string {
  const lines: string[] = [];
  lines.push(`SITUATION: ${session.situation}`);
  for (const m of session.messages) {
    lines.push(`${m.role === 'user' ? 'USER' : 'COACH'}: ${m.content}`);
  }
  if (userTurn) {
    lines.push(`USER: ${userTurn.content}`);
  } else if (isOpener) {
    lines.push('(no user messages yet — open the conversation based on the situation above)');
  }
  return lines.join('\n\n');
}

function extractReferencedPrincipleIds(text: string, principles: Principle[]): string[] {
  const lower = text.toLowerCase();
  const ids: string[] = [];
  for (const p of principles) {
    if (!p.title) continue;
    const t = p.title.toLowerCase();
    if (t.length < 3) continue;
    if (lower.includes(t)) ids.push(p.id);
  }
  return Array.from(new Set(ids));
}

function mergeAppliedPrinciples(existing: string[], newlyReferenced: string[]): string[] {
  const set = new Set(existing);
  for (const id of newlyReferenced) set.add(id);
  return Array.from(set);
}

/**
 * Test-only export — kept exported so the prompt body is unit-testable.
 */
export const __test = {
  buildTranscript,
  extractReferencedPrincipleIds,
  mergeAppliedPrinciples,
  renderPrincipleForPrompt,
  buildCoachWikiInstruction,
};
