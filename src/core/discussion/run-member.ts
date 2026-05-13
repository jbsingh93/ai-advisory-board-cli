/**
 * Invoke one board member as a Claude Code sub-agent and parse their response
 * into a Response struct. Token usage from the JSON envelope is logged via
 * fireTokenUsage().
 */
import { extractText, runClaude, type ClaudeStreamEvent } from '../../llm/claude-code-runner.js';
import { logger } from '../logger.js';
import { generateUUID, nowIso } from '../utils.js';
import { safeParseJSONWithSchema } from '../parsing/safe-json.js';
import {
  type StructuredResponsePayload,
  structuredResponsePayloadSchema,
} from '../parsing/llm-response-schemas.js';
import { memberAgentSlug } from '../../agents/emit-member-agent.js';
import type {
  AdvisoryBoardMember,
  AppSettings,
  Response,
  StorageService,
  TokenUsageLog,
} from '../../storage/types.js';
import {
  buildMemberUserMessage,
  type BuildMessageOptions,
} from './build-user-message.js';

export interface RunMemberOptions extends BuildMessageOptions {
  settings: AppSettings;
  /** Where the .claude/agents/ directory lives. Default: process.cwd(). */
  projectRoot?: string;
  /** Optional storage to log token usage. */
  storage?: StorageService;
  /** Discussion id for token logs. */
  discussionId?: string;
  signal?: AbortSignal;
  /**
   * Live progress callback. Fires when the member uses a tool or starts
   * generating its final response. UI uses this to update the typing-dots
   * label ("searching the web…", "reading files…", etc.).
   */
  onActivity?: (activity: { activity: string; tool?: string; detail?: string }) => void;
}

export interface RunMemberResult {
  response: Response;
  /** What the member returned, parsed and validated. */
  structured: StructuredResponsePayload;
  /** True if we fell back to raw text after JSON parse failure. */
  parseFallback: boolean;
  /** Per-call cost in USD as reported by `claude --output-format json`. */
  costUsd: number;
  durationMs: number;
}

const DEFAULT_TOOLS = ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'];

export async function runMember(opts: RunMemberOptions): Promise<RunMemberResult> {
  const userMessage = buildMemberUserMessage(opts);
  const slug = memberAgentSlug(opts.member.name);
  const tools = opts.member.allowedTools ?? DEFAULT_TOOLS;

  logger.debug('[runMember] dispatch', { slug, round: opts.roundNumber, msgLen: userMessage.length });

  const result = await runClaude({
    prompt: userMessage,
    agent: slug,
    model: pickMemberModel(opts.settings),
    allowedTools: tools,
    maxTurns: 5,
    maxBudgetUsd: opts.settings.perCallBudgetUsd,
    cwd: opts.projectRoot,
    signal: opts.signal,
    onEvent: opts.onActivity ? makeActivityForwarder(opts.onActivity) : undefined,
  });

  const text = extractText(result);
  const parsed = safeParseJSONWithSchema(text, structuredResponsePayloadSchema);

  let structured: StructuredResponsePayload;
  let parseFallback = false;
  if (parsed.success) {
    structured = parsed.data as StructuredResponsePayload;
  } else {
    logger.warn(`[runMember] ${opts.member.name}: structured parse failed (${parsed.error}); using raw text.`);
    parseFallback = true;
    structured = { response: text } as StructuredResponsePayload;
  }

  // Build the Response record
  const order = (opts.previousResponsesInRound?.length ?? 0) + 1;
  const turnNumber = (opts.conversationHistory?.length ?? 0) + order;
  const response: Response = {
    memberId: opts.member.id,
    memberName: opts.member.name,
    content: structured.response.trim() || `[${opts.member.name} returned no substantive content]`,
    timestamp: nowIso(),
    order,
    roundNumber: opts.roundNumber,
    turnNumber,
    isFollowUp: opts.roundNumber > 1 || !!opts.followUpQuestion,
    referencedMembers: extractReferencedMembers(structured.response, opts.previousResponsesInRound ?? []),
    sentiment: 'constructive',
    topicTags: (structured.keyPoints ?? []).slice(0, 3),
    structuredData: {
      keyPoints: structured.keyPoints,
      questionsForOthers: structured.questionsForOthers,
      actionSteps: structured.actionSteps,
      confidence: structured.confidence,
    },
  };

  // Token usage telemetry
  const costUsd = result.json?.cost_usd ?? 0;
  if (opts.storage) {
    fireTokenUsage(opts.storage, {
      discussionId: opts.discussionId,
      roundNumber: opts.roundNumber,
      turnNumber,
      operationType: 'member_response',
      model: typeof opts.settings.primaryModel === 'string' ? opts.settings.primaryModel : 'inherit',
      usage: result.json?.usage,
      costUsd,
      metadata: {
        memberName: opts.member.name,
        memberSlug: slug,
        parseFallback,
      },
    });
  }

  return { response, structured, parseFallback, costUsd, durationMs: result.durationMs };
}

function pickMemberModel(settings: AppSettings): string {
  return typeof settings.primaryModel === 'string' ? settings.primaryModel : 'inherit';
}

function extractReferencedMembers(text: string, peers: Response[]): string[] {
  if (!text || peers.length === 0) return [];
  const names = [...new Set(peers.map((p) => p.memberName.trim()).filter(Boolean))];
  const out: string[] = [];
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu');
    if (re.test(text)) out.push(name);
  }
  return out;
}

interface FireTokenUsageInput {
  discussionId?: string;
  roundNumber?: number;
  turnNumber?: number;
  operationType: string;
  model: string;
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      }
    | undefined;
  costUsd: number;
  metadata?: Record<string, unknown>;
}

/**
 * Translate raw `claude --output-format stream-json` events into friendly
 * status strings the UI can display in the typing-dot bubble. We surface
 * tool-use events (searching the web, reading files, etc.) and the moment
 * the agent starts producing its final answer.
 */
function makeActivityForwarder(
  onActivity: (a: { activity: string; tool?: string; detail?: string }) => void,
): (event: ClaudeStreamEvent) => void {
  // Don't fire the same activity twice in a row.
  let lastActivity: string | null = null;
  const emit = (activity: string, tool?: string, detail?: string) => {
    if (activity === lastActivity) return;
    lastActivity = activity;
    onActivity({ activity, tool, detail });
  };

  return (event) => {
    if (event.type === 'system' && event.subtype === 'init') {
      emit('thinking…', undefined);
      return;
    }
    if (event.type !== 'assistant' || !event.message?.content) return;

    for (const block of event.message.content) {
      if (block.type === 'tool_use' && block.name) {
        const tool = block.name;
        const friendly = friendlyForTool(tool, block.input);
        emit(friendly.activity, tool, friendly.detail);
        return;
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
        emit('writing response…');
        return;
      }
    }
  };
}

function friendlyForTool(tool: string, input?: Record<string, unknown>): {
  activity: string;
  detail?: string;
} {
  const name = tool.toLowerCase();
  if (name === 'websearch') {
    const q = typeof input?.query === 'string' ? input.query : undefined;
    return { activity: 'searching the web…', detail: q };
  }
  if (name === 'webfetch') {
    const u = typeof input?.url === 'string' ? input.url : undefined;
    return { activity: 'reading a web page…', detail: u };
  }
  if (name === 'read') {
    const path = typeof input?.file_path === 'string' ? input.file_path : undefined;
    return { activity: 'reading files…', detail: path };
  }
  if (name === 'grep') {
    const pat = typeof input?.pattern === 'string' ? input.pattern : undefined;
    return { activity: 'searching the codebase…', detail: pat };
  }
  if (name === 'glob') {
    return { activity: 'searching the codebase…' };
  }
  return { activity: `using ${tool}…`, detail: undefined };
}

function fireTokenUsage(storage: StorageService, input: FireTokenUsageInput): void {
  const promptTokenCount =
    (input.usage?.input_tokens ?? 0) +
    (input.usage?.cache_creation_input_tokens ?? 0) +
    (input.usage?.cache_read_input_tokens ?? 0);
  const candidatesTokenCount = input.usage?.output_tokens ?? 0;
  const log: TokenUsageLog = {
    id: generateUUID(),
    discussionId: input.discussionId,
    roundNumber: input.roundNumber,
    turnNumber: input.turnNumber,
    feature: 'discussions',
    operationType: input.operationType,
    model: input.model,
    tokens: {
      promptTokenCount,
      candidatesTokenCount,
      cacheReadTokens: input.usage?.cache_read_input_tokens,
      cacheCreationTokens: input.usage?.cache_creation_input_tokens,
      totalTokenCount: promptTokenCount + candidatesTokenCount,
    },
    costUsd: input.costUsd,
    createdAt: nowIso(),
    metadata: input.metadata,
  };
  storage.appendTokenUsageLog(log).catch((err) => {
    logger.debug('[runMember] token-usage log failed (non-blocking):', err);
  });
}
