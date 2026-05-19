/**
 * Orchestrator — decides what happens after a round.
 *
 * Implementation: a one-shot `claude -p` call (no sub-agent) carrying the
 * full orchestrator prompt. The prompt asks for a strict JSON contract that
 * we validate with `orchestratorDecisionPayloadSchema`. Deterministic
 * post-processing of consensus / repetition / topic exploration runs in JS
 * after the model decision — same as sage-council/src/lib/orchestrator.ts.
 */
import { runClaude, extractText } from '../../llm/claude-code-runner.js';
import { logger } from '../logger.js';
import { generateUUID, nowIso } from '../utils.js';
import { safeParseJSON, safeParseJSONWithSchema } from '../parsing/safe-json.js';
import { orchestratorDecisionPayloadSchema } from '../parsing/llm-response-schemas.js';
import type {
  AdvisoryBoardMember,
  AppSettings,
  ConversationRound,
  OrchestratorDecision,
  OrchestratorState,
  Response,
  StorageService,
  UserInteractionRequest,
} from '../../storage/types.js';

export interface AnalyzeOptions {
  question: string;
  rounds: ConversationRound[];
  members: AdvisoryBoardMember[];
  currentTurn: number;
  settings: AppSettings;
  storage?: StorageService;
  discussionId?: string;
  signal?: AbortSignal;
}

export async function analyzeConversation(opts: AnalyzeOptions): Promise<OrchestratorDecision> {
  const context = buildOrchestratorContext(opts);
  logger.debug('[orchestrator] analyzing', {
    rounds: opts.rounds.length,
    turn: opts.currentTurn,
    members: opts.members.length,
  });

  try {
    // Phase 1.5: open Read/Grep/Glob so the orchestrator can ground its
    // decision in the Knowledge Wiki when one is present. Settings flag
    // `knowledgeWiki.exposeToOrchestrator` defaults true; toggling false
    // collapses to the old empty-allowlist behaviour.
    const expose = opts.settings.knowledgeWiki?.exposeToOrchestrator !== false;
    const orchestratorTools = expose ? ['Read', 'Grep', 'Glob'] : [];
    const result = await runClaude({
      prompt: context,
      // No --agent: this is a one-shot orchestrator call without persona
      model: typeof opts.settings.fastModel === 'string' ? opts.settings.fastModel : 'haiku',
      allowedTools: orchestratorTools,
      maxTurns: 1,
      maxBudgetUsd: opts.settings.perCallBudgetUsd,
      signal: opts.signal,
      timeoutMs: 90_000,
    });

    const text = extractText(result);
    return parseDecision(text, opts);
  } catch (error) {
    logger.warn('[orchestrator] failed; using fallback decision:', error);
    return fallbackDecision(opts);
  }
}

export function buildOrchestratorContext(opts: AnalyzeOptions): string {
  const { question, rounds, members, currentTurn, settings } = opts;
  const activeMembers = members.filter((m) => m.isActive);

  const history: string[] = [];
  rounds.forEach((round, index) => {
    history.push(`### Round ${index + 1}`);
    for (const r of round.responses) {
      const preview = r.content.length > 240 ? `${r.content.slice(0, 240)}...` : r.content;
      history.push(`- **${r.memberName}**: ${preview}`);
    }
  });

  return [
    'You are an AI conversation orchestrator managing an advisory board discussion.',
    '',
    `## Original question`,
    `"${question}"`,
    '',
    `## Active members`,
    ...activeMembers.map((m) => `- ${m.name} (${m.title}): ${m.expertise.join(', ')}`),
    '',
    `## Progress`,
    `- Current turn: ${currentTurn}`,
    `- Maximum turns: ${settings.maxTurnsPerDiscussion}`,
    `- Consensus threshold: ${settings.consensusThreshold}%`,
    '',
    `## Conversation so far`,
    history.join('\n') || '(no rounds yet)',
    '',
    '## Your task',
    'Analyze the conversation and decide what should happen next. Consider:',
    '1. CONSENSUS — are members converging on key points?',
    '2. TOPIC EXPLORATION — are new valuable insights still emerging?',
    '3. REPETITION — are members starting to repeat themselves?',
    '4. QUALITY — is the discussion adding value?',
    '5. USER INPUT — does the board need clarification, a decision, or info from the user?',
    '',
    '## Output contract',
    'Return ONLY a raw JSON object — no fences, no commentary. Start with `{`, end with `}`.',
    '',
    '{',
    '  "action": "continue" | "conclude" | "redirect" | "request_user_input",',
    '  "reasoning": "Your detailed reasoning",',
    '  "nextSpeaker": "(optional) suggested next speaker name",',
    '  "suggestedDirection": "(optional) topic to redirect to",',
    '  "consensusReached": false,',
    '  "confidence": 75,',
    '  "userInputRequest": {',
    '    "type": "clarification|decision|preference|information",',
    '    "question": "What the board needs from the user",',
    '    "context": "Why",',
    '    "requestingMembers": ["member names"],',
    '    "urgency": "low|medium|high",',
    '    "options": ["A", "B"]',
    '  }',
    '}',
    '',
    'Only include `userInputRequest` if action is "request_user_input". Be decisive but thoughtful — quality discussions are better than long ones.',
  ].join('\n');
}

function parseDecision(text: string, opts: AnalyzeOptions): OrchestratorDecision {
  const strict = safeParseJSONWithSchema(text, orchestratorDecisionPayloadSchema);
  if (strict.success) return finalize(strict.data, opts);

  // Fall back to a permissive parse if the schema validate failed
  const loose = safeParseJSON<Record<string, unknown>>(text);
  if (loose.success && loose.data && typeof loose.data === 'object') {
    return finalize(loose.data, opts);
  }

  // Keyword fallback
  logger.warn(`[orchestrator] parse failed: ${strict.success ? '' : strict.error}; using keyword fallback.`);
  return fallbackDecision(opts, text);
}

function finalize(parsed: Record<string, unknown>, opts: AnalyzeOptions): OrchestratorDecision {
  const action =
    (typeof parsed.action === 'string' && ['continue', 'conclude', 'redirect', 'request_user_input'].includes(parsed.action)
      ? (parsed.action as OrchestratorDecision['action'])
      : opts.currentTurn >= opts.settings.maxTurnsPerDiscussion
        ? 'conclude'
        : 'continue');

  const decision: OrchestratorDecision = {
    action,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : 'No reasoning provided',
    nextSpeaker: typeof parsed.nextSpeaker === 'string' ? parsed.nextSpeaker : undefined,
    suggestedDirection: typeof parsed.suggestedDirection === 'string' ? parsed.suggestedDirection : undefined,
    consensusReached: parsed.consensusReached === true,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 50,
  };

  const rawReq = parsed.userInputRequest;
  if (decision.action === 'request_user_input' && rawReq && typeof rawReq === 'object') {
    const req = rawReq as Record<string, unknown>;
    decision.userInputRequest = {
      id: generateUUID(),
      type:
        typeof req.type === 'string' && ['clarification', 'decision', 'preference', 'information'].includes(req.type)
          ? (req.type as UserInteractionRequest['type'])
          : 'clarification',
      question: typeof req.question === 'string' ? req.question : 'The advisory board needs your input.',
      context: typeof req.context === 'string' ? req.context : 'Additional information is needed.',
      requestingMembers: Array.isArray(req.requestingMembers) ? req.requestingMembers.map(String) : [],
      urgency:
        typeof req.urgency === 'string' && ['low', 'medium', 'high'].includes(req.urgency)
          ? (req.urgency as UserInteractionRequest['urgency'])
          : 'medium',
      createdAt: nowIso(),
      options: Array.isArray(req.options) ? req.options.map(String) : undefined,
    };
  }

  return decision;
}

function fallbackDecision(opts: AnalyzeOptions, text?: string): OrchestratorDecision {
  const lower = (text ?? '').toLowerCase();
  const shouldConclude =
    lower.includes('conclude') || lower.includes('end the discussion') || opts.currentTurn >= opts.settings.maxTurnsPerDiscussion;
  return {
    action: shouldConclude ? 'conclude' : 'continue',
    reasoning: 'Fallback decision (orchestrator unavailable or output unparseable).',
    consensusReached: lower.includes('consensus'),
    confidence: 50,
  };
}

// --------------------------------------------------------------------
// Deterministic state derivation (post-processing after the LLM decision)
// --------------------------------------------------------------------

export function updateOrchestratorState(
  current: OrchestratorState,
  decision: OrchestratorDecision,
  round: ConversationRound,
): OrchestratorState {
  const consensus = analyzeConsensus(round.responses);
  const exploration = analyzeTopicExploration(round.responses);
  const repetition = detectRepetition(round.responses);
  return {
    phase: determinePhase(decision, current.phase),
    reasoning: decision.reasoning,
    consensusLevel: consensus,
    topicExploration: exploration,
    repetitionDetected: repetition,
    shouldContinue: decision.action === 'continue',
    nextSpeaker: decision.nextSpeaker,
    conversationQuality: assessQuality(consensus, exploration, repetition),
  };
}

function analyzeConsensus(responses: Response[]): number {
  if (responses.length === 0) return 0;
  const agreements = responses.filter((r) => {
    const c = r.content.toLowerCase();
    return c.includes('agree') || c.includes(' yes,') || c.includes('exactly');
  }).length;
  return Math.min(100, Math.round((agreements / responses.length) * 100));
}

function analyzeTopicExploration(responses: Response[]): number {
  const unique = new Set<string>();
  for (const r of responses) {
    for (const w of r.content.toLowerCase().split(/\s+/)) {
      if (w.length > 6) unique.add(w);
    }
  }
  return Math.min(100, unique.size * 10);
}

function detectRepetition(responses: Response[]): boolean {
  if (responses.length < 2) return false;
  const contents = responses.map((r) => r.content.toLowerCase());
  for (let i = 0; i < contents.length; i++) {
    for (let j = i + 1; j < contents.length; j++) {
      const a = contents[i];
      const b = contents[j];
      if (typeof a !== 'string' || typeof b !== 'string') continue;
      if (jaccard(a, b) > 0.7) return true;
    }
  }
  return false;
}

function jaccard(a: string, b: string): number {
  const wa = new Set(a.split(/\s+/));
  const wb = new Set(b.split(/\s+/));
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / new Set([...wa, ...wb]).size;
}

function determinePhase(
  decision: OrchestratorDecision,
  currentPhase: OrchestratorState['phase'],
): OrchestratorState['phase'] {
  if (decision.action === 'conclude') return 'concluded';
  if (decision.consensusReached) return 'consensus';
  if (currentPhase === 'initial') return 'continuation';
  return currentPhase;
}

function assessQuality(
  consensus: number,
  exploration: number,
  repetition: boolean,
): OrchestratorState['conversationQuality'] {
  const score = (consensus + exploration) / 2 - (repetition ? 20 : 0);
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  return 'poor';
}

export function createInitialOrchestratorState(): OrchestratorState {
  return {
    phase: 'initial',
    reasoning: 'Starting new multi-turn discussion.',
    consensusLevel: 0,
    topicExploration: 100,
    repetitionDetected: false,
    shouldContinue: true,
    conversationQuality: 'good',
  };
}
