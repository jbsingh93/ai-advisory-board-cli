/**
 * Conversation Analyzer — extract action items from a concluded discussion.
 *
 * Ported from `../sage-council/src/lib/conversation-analyzer.ts` with two
 * deliberate deltas for the CLI port (per PLAN §6.5):
 *   1. The **structured-data fast path** is a *pure* deterministic transform:
 *      every `actionSteps[]` / `questionsForOthers[]` entry on the response
 *      becomes a candidate `ExtractedActionItem` with no LLM call. This keeps
 *      `aab actions extract` zero-cost when members emit structured payloads.
 *   2. The LLM fallback is a one-shot `claude -p` on `fastModel`, mirroring
 *      `summarize.ts` — no persona, `allowedTools: []`, `maxTurns: 1`.
 *
 * The analyzer NEVER throws on parse failure; it returns a fallback result with
 * `analysisConfidence === 0` and an explanation in `keyInsights[0]`, matching
 * the source's tolerant contract.
 */
import { runClaude, extractText } from '../../llm/claude-code-runner.js';
import { logger } from '../logger.js';
import { safeParseJSONWithSchema } from '../parsing/safe-json.js';
import { conversationAnalysisPayloadSchema } from '../parsing/llm-response-schemas.js';
import { nowIso, generateUUID } from '../utils.js';
import type {
  ActionItem,
  AppSettings,
  Discussion,
  Response,
  ResponseStructuredData,
} from '../../storage/types.js';

export type ActionPriority = 'low' | 'medium' | 'high';
export type ActionCategory =
  | 'strategic'
  | 'operational'
  | 'technical'
  | 'research'
  | 'financial'
  | 'other';

export interface ExtractedActionItem {
  title: string;
  description: string;
  priority: ActionPriority;
  category: ActionCategory;
  confidence: number; // 0-100
  sourceContext: string;
  sourceMemberId?: string;
  sourceMemberName?: string;
  suggestedAssignee?: string;
  suggestedDueDate?: string;
}

export interface AnalysisResult {
  actionItems: ExtractedActionItem[];
  keyInsights: string[];
  recommendedNextSteps: string[];
  analysisConfidence: number; // 0-100
  processingTimeMs: number;
  /** `'structured'` when no LLM call was made; `'llm'` when the fallback ran;
   *  `'fallback'` when both paths failed and we returned a deterministic stub. */
  method: 'structured' | 'llm' | 'fallback';
}

export interface ExtractActionItemsOptions {
  discussion: Discussion;
  settings: AppSettings;
  signal?: AbortSignal;
  /** Pluggable LLM runner — defaults to the real `runClaude`. Tests can pass
   *  a stub to exercise the LLM fallback path without spawning a process. */
  llm?: typeof runClaude;
}

/** Pure heuristic limits. */
const MAX_STRUCTURED_ITEMS_PER_RESPONSE = 8;
const TITLE_MAX_CHARS = 90;

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

export async function extractActionItems(opts: ExtractActionItemsOptions): Promise<AnalysisResult> {
  const startTime = Date.now();
  const { discussion } = opts;

  // Fast path: structured data on responses → pure transform, no LLM call.
  const structured = extractFromStructuredData(discussion);
  if (structured.length > 0) {
    const keyInsights = structured.slice(0, 5).map((it) => it.description);
    const recommendedNextSteps = structured
      .filter((it) => it.priority === 'high')
      .map((it) => it.title);
    const meanConfidence =
      structured.reduce((sum, it) => sum + it.confidence, 0) / structured.length;
    return {
      actionItems: structured,
      keyInsights,
      recommendedNextSteps:
        recommendedNextSteps.length > 0 ? recommendedNextSteps : ['Review extracted action items'],
      analysisConfidence: Math.min(90, Math.round(meanConfidence)),
      processingTimeMs: Date.now() - startTime,
      method: 'structured',
    };
  }

  // Fallback: ask the orchestrator (one-shot Haiku) to extract from raw text.
  try {
    const llm = opts.llm ?? runClaude;
    const prompt = buildAnalysisPrompt(discussion);
    const result = await llm({
      prompt,
      model: typeof opts.settings.fastModel === 'string' ? opts.settings.fastModel : 'haiku',
      allowedTools: [],
      maxTurns: 1,
      maxBudgetUsd: opts.settings.perCallBudgetUsd,
      signal: opts.signal,
      timeoutMs: 180_000,
    });
    const text = extractText(result);
    const parsed = parseAnalysisResult(text);
    return {
      ...parsed,
      processingTimeMs: Date.now() - startTime,
      method: 'llm',
    };
  } catch (err) {
    logger.warn('[actions] LLM extract fallback failed:', err instanceof Error ? err.message : err);
    return fallbackResult(discussion, Date.now() - startTime);
  }
}

/**
 * Convert an extracted candidate into a persistable ActionItem. Caller is
 * responsible for `await storage.saveActionItem(item)` when the user accepts.
 */
export function toActionItem(
  extracted: ExtractedActionItem,
  discussionId: string,
): ActionItem {
  const now = nowIso();
  return {
    id: generateUUID(),
    discussionId,
    title: extracted.title.slice(0, TITLE_MAX_CHARS),
    description: extracted.description,
    priority: extracted.priority,
    status: 'pending',
    assignedTo: extracted.suggestedAssignee,
    dueDate: extracted.suggestedDueDate,
    createdAt: now,
    updatedAt: now,
  };
}

// ----------------------------------------------------------------------------
// Structured-data fast path (pure)
// ----------------------------------------------------------------------------

export function extractFromStructuredData(discussion: Discussion): ExtractedActionItem[] {
  const out: ExtractedActionItem[] = [];
  for (const response of discussion.responses) {
    if (!response.structuredData) continue;
    const fromResponse = extractFromOneResponse(response);
    for (const item of fromResponse) {
      out.push(item);
    }
  }
  // Dedupe by normalized title — multiple members often surface the same step.
  return dedupeByTitle(out);
}

function extractFromOneResponse(response: Response): ExtractedActionItem[] {
  const sd = response.structuredData as ResponseStructuredData | undefined;
  if (!sd) return [];
  const items: ExtractedActionItem[] = [];

  const baseConfidence =
    typeof sd.confidence === 'number' ? Math.max(50, Math.min(95, sd.confidence)) : 70;

  // Direct action steps — highest signal.
  for (const step of (sd.actionSteps ?? []).slice(0, MAX_STRUCTURED_ITEMS_PER_RESPONSE)) {
    const title = makeTitle(step);
    if (!title) continue;
    items.push({
      title,
      description: step,
      priority: inferPriority(step),
      category: inferCategory(step),
      confidence: baseConfidence,
      sourceContext: `actionSteps — ${response.memberName}`,
      sourceMemberId: response.memberId,
      sourceMemberName: response.memberName,
    });
  }

  // questionsForOthers → research / follow-up actions.
  for (const question of (sd.questionsForOthers ?? []).slice(0, MAX_STRUCTURED_ITEMS_PER_RESPONSE)) {
    const title = makeTitle(`Investigate: ${question}`);
    if (!title) continue;
    items.push({
      title,
      description: question,
      priority: 'medium',
      category: 'research',
      confidence: Math.max(50, baseConfidence - 15),
      sourceContext: `questionsForOthers — ${response.memberName}`,
      sourceMemberId: response.memberId,
      sourceMemberName: response.memberName,
    });
  }

  return items;
}

function makeTitle(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  // First sentence-ish; cap at TITLE_MAX_CHARS.
  const firstStop = trimmed.search(/[.!?]\s|$/);
  const head = firstStop > 0 ? trimmed.slice(0, firstStop) : trimmed;
  return head.length > TITLE_MAX_CHARS ? head.slice(0, TITLE_MAX_CHARS - 1).trimEnd() + '…' : head;
}

function inferPriority(text: string): ActionPriority {
  const t = text.toLowerCase();
  if (/\b(critical|urgent|asap|immediately|must|blocker|hotfix)\b/.test(t)) return 'high';
  if (/\b(should|important|priorit|high-impact|key)\b/.test(t)) return 'high';
  if (/\b(consider|explore|evaluate|nice|optional|eventually|down the road)\b/.test(t)) return 'low';
  return 'medium';
}

function inferCategory(text: string): ActionCategory {
  const t = text.toLowerCase();
  if (/\b(research|investigate|study|benchmark|survey|literature)\b/.test(t)) return 'research';
  if (/\b(deploy|build|implement|code|ship|refactor|integration|api|repo|test)\b/.test(t))
    return 'technical';
  if (/\b(budget|cost|revenue|pricing|raise|burn|runway|margin|p&l|cash)\b/.test(t)) return 'financial';
  if (/\b(strategy|positioning|market|brand|pivot|roadmap|vision|moat|partnership)\b/.test(t))
    return 'strategic';
  if (/\b(hire|onboard|process|ops|workflow|operations|sla|playbook)\b/.test(t)) return 'operational';
  return 'other';
}

function dedupeByTitle(items: ExtractedActionItem[]): ExtractedActionItem[] {
  const seen = new Map<string, ExtractedActionItem>();
  for (const it of items) {
    const key = it.title.trim().toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, it);
    } else {
      // Bump confidence slightly when multiple members converge on the same step.
      const prior = seen.get(key)!;
      prior.confidence = Math.min(99, Math.round(prior.confidence + 5));
    }
  }
  return Array.from(seen.values());
}

// ----------------------------------------------------------------------------
// LLM fallback prompt + parser
// ----------------------------------------------------------------------------

function buildAnalysisPrompt(discussion: Discussion): string {
  // Cap each response to keep the prompt focused — Haiku is decent at this when
  // the input is tight.
  const PER_RESPONSE_CAP = 4000;
  const allResponses = discussion.responses
    .map((r) => {
      const preview =
        r.content.length > PER_RESPONSE_CAP
          ? `${r.content.slice(0, PER_RESPONSE_CAP)}\n\n[…truncated for extraction…]`
          : r.content;
      return `${r.memberName} (round ${r.roundNumber} turn ${r.turnNumber}):\n${preview}`;
    })
    .join('\n\n');

  const summaryContext = discussion.summary
    ? [
        'EXISTING SUMMARY:',
        `Key Points: ${discussion.summary.keyPoints.join(', ')}`,
        `Consensus: ${discussion.summary.consensus.join(', ')}`,
        `Actionable Insights: ${discussion.summary.actionableInsights.join(', ')}`,
        '',
      ].join('\n')
    : '';

  return [
    'You are an expert action-item extractor. Read this advisory-board discussion and extract concrete, actionable items the organization should pursue.',
    '',
    `ORIGINAL QUESTION: "${discussion.question}"`,
    '',
    summaryContext,
    'FULL CONVERSATION:',
    allResponses || '(no responses)',
    '',
    'INSTRUCTIONS:',
    '1. Extract SPECIFIC, ACTIONABLE items only — skip vague suggestions.',
    '2. Assign realistic priority based on urgency + impact (high/medium/low).',
    '3. Categorize: strategic, operational, technical, research, financial, other.',
    '4. Provide a 0-100 confidence score based on how clearly the action was stated.',
    '5. Quote the source context (a short excerpt of the relevant line).',
    '6. Suggest assignees or due dates when explicitly mentioned.',
    '',
    'OUTPUT — return ONLY a raw JSON object, no fences, no commentary:',
    '{',
    '  "actionItems": [',
    '    {',
    '      "title": "Brief, clear action title (≤90 chars)",',
    '      "description": "Detailed description of what needs to be done",',
    '      "priority": "high|medium|low",',
    '      "category": "strategic|operational|technical|research|financial|other",',
    '      "confidence": 85,',
    '      "sourceContext": "Quote from discussion",',
    '      "suggestedAssignee": "Person/department or omit",',
    '      "suggestedDueDate": "Relative or absolute timeframe or omit"',
    '    }',
    '  ],',
    '  "keyInsights": ["Most important strategic takeaways"],',
    '  "recommendedNextSteps": ["Immediate next steps"],',
    '  "analysisConfidence": 90',
    '}',
    '',
    'Focus on maximum actionable value. Skip filler.',
  ].join('\n');
}

function parseAnalysisResult(
  response: string,
): Omit<AnalysisResult, 'processingTimeMs' | 'method'> {
  const parseResult = safeParseJSONWithSchema(response, conversationAnalysisPayloadSchema);
  if (parseResult.success) {
    const parsed = parseResult.data;
    return {
      actionItems: (parsed.actionItems ?? []).map((item): ExtractedActionItem => ({
        title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : 'Untitled Action',
        description: item.description ?? '',
        priority: (item.priority as ActionPriority | undefined) ?? 'medium',
        category: (item.category as ActionCategory | undefined) ?? 'other',
        confidence: typeof item.confidence === 'number' ? item.confidence : 60,
        sourceContext: item.sourceContext ?? 'Extracted by analyzer',
        suggestedAssignee: item.suggestedAssignee,
        suggestedDueDate: item.suggestedDueDate,
      })),
      keyInsights: Array.isArray(parsed.keyInsights) ? (parsed.keyInsights as string[]) : [],
      recommendedNextSteps: Array.isArray(parsed.recommendedNextSteps)
        ? (parsed.recommendedNextSteps as string[])
        : [],
      analysisConfidence:
        typeof parsed.analysisConfidence === 'number' ? parsed.analysisConfidence : 50,
    };
  }

  logger.warn(
    '[actions] failed to parse analysis result:',
    'error' in parseResult ? parseResult.error : 'unknown',
  );
  return {
    actionItems: [],
    keyInsights: [],
    recommendedNextSteps: [],
    analysisConfidence: 0,
  };
}

function fallbackResult(discussion: Discussion, processingTimeMs: number): AnalysisResult {
  // If the discussion has a summary, mine its actionable insights deterministically.
  const fallbackItems: ExtractedActionItem[] = [];
  if (discussion.summary?.actionableInsights) {
    for (const insight of discussion.summary.actionableInsights.slice(0, 3)) {
      fallbackItems.push({
        title: makeTitle(`Follow up: ${insight}`),
        description: insight,
        priority: 'medium',
        category: 'other',
        confidence: 50,
        sourceContext: 'Extracted from discussion summary',
        suggestedDueDate: '2 weeks',
      });
    }
  }
  return {
    actionItems: fallbackItems,
    keyInsights: discussion.summary?.keyPoints ?? [
      'Analysis failed — no structured data and LLM extraction errored. Review manually.',
    ],
    recommendedNextSteps: ['Review the discussion manually and add action items by hand.'],
    analysisConfidence: 0,
    processingTimeMs,
    method: 'fallback',
  };
}

// ----------------------------------------------------------------------------
// Test seam
// ----------------------------------------------------------------------------

export const __test = {
  extractFromStructuredData,
  extractFromOneResponse,
  makeTitle,
  inferPriority,
  inferCategory,
  dedupeByTitle,
  parseAnalysisResult,
  buildAnalysisPrompt,
};
