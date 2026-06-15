/**
 * Domain types ported from sage-council with simplifications applied per
 * Part 6 of PLAN.md (Action Board scope cut: kanban + skill-only solve).
 */

// ============================================================
// Members & Boards
// ============================================================

export interface AdvisoryBoardMember {
  id: string;
  name: string;
  title: string;
  expertise: string[];
  persona: string;
  voiceGuide?: string;
  avatar?: string;
  isActive: boolean;
  /** Per-member tool override (Part 5.19). Null/undefined → use defaults. */
  allowedTools?: string[];
  disallowedTools?: string[];
  createdAt: string; // ISO-8601
  updatedAt: string;
}

export interface Board {
  id: string;
  name: string;
  /** Kebab-case, unique within the workspace; derived from name. CLI addressing. */
  slug: string;
  description?: string;
  /** Ordered references into members.json. */
  memberIds: string[];
  createdAt: string;
  updatedAt: string;
  /** Soft-delete: hidden from pickers, kept for history. */
  archivedAt?: string;
}

// ============================================================
// Discussions
// ============================================================

export interface Response {
  memberId: string;
  memberName: string;
  content: string;
  timestamp: string;
  order: number;
  roundNumber: number;
  turnNumber: number;
  isFollowUp: boolean;
  referencedMembers: string[];
  sentiment: 'positive' | 'neutral' | 'negative' | 'constructive';
  topicTags: string[];
  structuredData?: ResponseStructuredData;
}

export interface ResponseStructuredData {
  keyPoints?: string[];
  questionsForOthers?: string[];
  actionSteps?: string[];
  confidence?: number;
}

export interface OrchestratorState {
  phase: 'initial' | 'continuation' | 'consensus' | 'concluded';
  reasoning: string;
  consensusLevel: number;
  topicExploration: number;
  repetitionDetected: boolean;
  shouldContinue: boolean;
  nextSpeaker?: string;
  conversationQuality: 'poor' | 'fair' | 'good' | 'excellent';
}

export interface OrchestratorDecision {
  action: 'continue' | 'conclude' | 'redirect' | 'request_user_input';
  reasoning: string;
  nextSpeaker?: string;
  suggestedDirection?: string;
  consensusReached: boolean;
  confidence: number;
  userInputRequest?: UserInteractionRequest;
}

export interface UserInteractionRequest {
  id: string;
  type: 'clarification' | 'decision' | 'preference' | 'information';
  question: string;
  context: string;
  requestingMembers: string[];
  urgency: 'low' | 'medium' | 'high';
  createdAt: string;
  options?: string[];
}

export interface UserResponse {
  id: string;
  requestId: string;
  content: string;
  selectedOption?: string;
  timestamp: string;
  roundNumber: number;
  type?:
    | 'advisory_board_requested'
    | 'follow_up_question'
    | 'sparring_injection'
    | 'initial_question'
    | 'continuation';
  prompt?: string;
  targetType?: 'all' | 'specific' | 'subset';
  selectedMemberId?: string;
  selectedMemberIds?: string[];
  /** When type === 'sparring_injection', the round/turn the injected insight
   *  refers back to in the main timeline, plus the user's original sparring
   *  trigger input (the message that prompted the deep-dive). */
  sourceRoundNumber?: number;
  sourceTurnNumber?: number;
  sparringTriggerInput?: string;
  /** When type === 'sparring_injection', the SparringSession id that produced
   *  the insight. Useful for the UI to deep-link back to the original session. */
  sparringSessionId?: string;
}

export interface ConversationRound {
  roundNumber: number;
  responses: Response[];
  orchestratorDecision: OrchestratorDecision;
  startedAt: string;
  completedAt?: string;
  userInteractionRequest?: UserInteractionRequest;
  userResponse?: UserResponse;
  followUpQuestion?: string;
  followUpTargetType?: 'all' | 'specific' | 'subset';
  followUpSelectedMemberId?: string;
  followUpSelectedMemberIds?: string[];
  /** Members who joined the discussion in this round (mid-discussion adds). */
  addedMemberIds?: string[];
}

export interface ConversationSummary {
  keyPoints: string[];
  consensus: string[];
  disagreements: string[];
  actionableInsights: string[];
  participationBreakdown: ParticipationMetrics[];
  overallQuality: number;
  generatedAt: string;
}

export interface ParticipationMetrics {
  memberId: string;
  memberName: string;
  totalResponses: number;
  averageLength: number;
  topicsCovered: string[];
  influence: number;
}

/**
 * Snapshot of a discussion participant's identity, captured at join time. Lets
 * historical transcripts render correctly even after the underlying member is
 * renamed or deleted. Append-only (LangGraph-style history integrity).
 */
export interface DiscussionParticipant {
  memberId: string;
  /** Snapshot at join time. */
  name: string;
  /** Snapshot — drives agent dispatch even if the member is later renamed. */
  slug: string;
  /** Snapshot for display. */
  title: string;
  /** 1 for founding members; N for mid-discussion joins. */
  joinedAtRound: number;
  /** Set for mid-discussion joins — how the newcomer was brought up to speed. */
  catchUpMode?: 'full' | 'summary' | 'fresh';
  /** Optional: if a member is dropped from later rounds. */
  removedAtRound?: number;
}

export interface Discussion {
  id: string;
  question: string;
  /**
   * Optional human-friendly display name. When set, UIs/CLI show this instead
   * of the (immutable) original `question`. Renaming a discussion sets this —
   * we never mutate `question`, since it's the prompt members were actually
   * asked and is replayed as context on continue/follow-up.
   */
  title?: string;
  selectedMemberIds?: string[];
  boardId?: string;
  boardName?: string;
  /** Authoritative, append-only participant snapshot (see {@link DiscussionParticipant}). */
  participants?: DiscussionParticipant[];
  responses: Response[];
  rounds: ConversationRound[];
  orchestratorState: OrchestratorState;
  summary?: ConversationSummary;
  totalTurns: number;
  maxTurns: number;
  pendingUserRequest?: UserInteractionRequest;
  userResponses: UserResponse[];
  createdAt: string;
  completedAt?: string;
  archivedAt?: string;
}

// ============================================================
// Action Board (kanban + skill-only solve, per Part 6)
// ============================================================

/**
 * Snapshot of the discussion context an action item was born from. Captured at
 * "add to action board" time so the Skill Planner / skill-creator get the
 * member's actual reasoning — not just the one-line step title — and so the UI
 * can link back to the source discussion. All fields optional + the whole
 * object optional: items added without a discussion (manual `aab actions add`)
 * carry no sourceContext, and older items predate the field.
 */
export interface ActionItemSourceContext {
  /** The original business question the discussion was convened on. */
  discussionQuestion?: string;
  /** The board member who suggested this step. */
  memberId?: string;
  memberName?: string;
  /** Member's role/title (e.g. "CFA, capital allocation") for planner context. */
  memberTitle?: string;
  /** Excerpt of the member's full response — the "why/how" behind the step. */
  memberReasoning?: string;
  /** Key points from the same response (structuredData.keyPoints). */
  relatedKeyPoints?: string[];
  /** Round the suggestion came from. */
  roundNumber?: number;
}

export interface ActionItem {
  id: string;
  discussionId?: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  status: 'pending' | 'in-progress' | 'completed';
  assignedTo?: string;
  dueDate?: string;
  /** Discussion provenance snapshot — see {@link ActionItemSourceContext}. */
  sourceContext?: ActionItemSourceContext;
  linkedSkill?: {
    name: string;
    runId: string;
    installedAt: string;
    installPath: string;
  };
  skillRunHistory?: string[];
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Principles & Decision Coach
// ============================================================

export type PrincipleCategory =
  | 'life'
  | 'work'
  | 'relationships'
  | 'health'
  | 'finance'
  | 'meta';

export interface Principle {
  id: string;
  category: PrincipleCategory;
  title: string;
  description: string;
  behavior: string;
  antiPattern?: string;
  triggerQuestions?: string[];
  priority: number;
  examples?: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  principlesReferenced?: string[];
  createdAt: string;
}

export interface DecisionSession {
  id: string;
  title?: string;
  situation: string;
  messages: DecisionMessage[];
  appliedPrinciples: string[];
  decision?: string;
  outcome?: string;
  reflection?: string;
  status: 'active' | 'decided' | 'reflected';
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Sparring (1:1 deep dive)
// ============================================================

export interface SparringSource {
  title: string;
  url: string;
}

export interface SparringMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  sources: SparringSource[];
  createdAt: string;
}

export interface SparringSession {
  id: string;
  discussionId: string;
  memberId: string;
  memberName: string;
  anchorRoundNumber: number;
  anchorTurnNumber: number;
  anchorResponsePreview: string;
  title?: string;
  messages: SparringMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface SparringInjectionContext {
  sourceRoundNumber?: number;
  sourceTurnNumber?: number;
  sparringTriggerInput?: string;
}

// ============================================================
// Business context
// ============================================================

export interface BusinessContext {
  id: string;
  category:
    | 'company'
    | 'industry'
    | 'goals'
    | 'challenges'
    | 'team'
    | 'market'
    | 'product'
    | 'strategy'
    | 'tools';
  title: string;
  description: string;
  confidence: number;
  extractedFrom: string;
  relevantKeywords: string[];
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
}

export interface BusinessProfile {
  companyName: string;
  industry: string;
  companySize: 'solo' | 'small' | 'medium' | 'large' | 'enterprise';
  stage: 'idea' | 'startup' | 'growth' | 'mature' | 'enterprise';
  products: string[];
  targetMarket: string;
  topGoals: string[];
  blockers: string[];
  tools: string[];
  customTools: string;
  completedAt?: string;
}

// ============================================================
// Settings
// ============================================================

export type ClaudeModel =
  | 'claude-opus-4-7'
  | 'claude-sonnet-4-6'
  | 'claude-sonnet-4-5'
  | 'claude-haiku-4-5-20251001';

export interface UsageBudgetSettings {
  monthlyBudgetUsd?: number;
  warningThresholdPercent: number;
}

/**
 * Aliases recognized by the `claude` CLI's --model flag. We default everything
 * to `inherit` so the user's parent Claude Code session model is used; specific
 * roles (research, fast) can opt into a different alias.
 */
export type ClaudeModelAlias = 'opus' | 'sonnet' | 'haiku' | 'inherit';

export interface KnowledgeWikiSettings {
  enabled: boolean;
  autoIngestDiscussions: boolean;
  autoIngestUserResponses: boolean;
  /**
   * Phase 8 master toggle: ingest EVERY user utterance (initial question,
   * follow-ups, HITL/board responses, 1:1 sparring messages) into the wiki via
   * the user-fact **merge** agent (`ingestUserFacts`). Dedups semantically,
   * per-fact, after reading the wiki — never via a deterministic gate. When
   * `true`, this supersedes `autoIngestUserResponses` for HITL replies (the
   * HITL reply becomes one `kind` among the four). Default true.
   * See `docs/development/USER_INPUT_INGEST.md`.
   */
  autoIngestUserInputs: boolean;
  ingestModel: ClaudeModelAlias | ClaudeModel;
  queryModel: ClaudeModelAlias | ClaudeModel;
  lintStaleDays: number;
  maxAgentPagesPerCall: number;
  pageBodySoftCap: number;
  summarySoftCap: number;
  exposeToMemberAgents: boolean;
  exposeToOrchestrator: boolean;
  recommendFoam: boolean;
  slugMapInIndex: boolean;
  maxAliasesGlobal: number;
  /**
   * When true, the CLI deterministically retrieves the most relevant wiki pages
   * (keyword overlap against slug/title/summary/tags) and injects short excerpts
   * into the member message *before* the agent runs. The agent still has
   * Read/Grep/Glob as a fallback. This makes the agent an advisor, not a wiki
   * search engine — fewer tool calls, lower latency, no `index.md` mega-reads.
   * Default true.
   */
  injectRetrievedContext: boolean;
  /** How many pages the CLI pre-fetches and injects per member call. Default 8. */
  retrievalMaxPages: number;
  /** Per-page excerpt cap (chars) for injected context. Default 2000. */
  retrievalExcerptChars: number;
  /**
   * Soft size ceiling (bytes) for `wiki/index.md`. Above this, `aab doctor` and
   * `aab knowledge lint` flag it — agents should never `Read` the full index.
   * Default 204800 (200 KB).
   */
  indexSizeWarnBytes: number;
}

export const DEFAULT_KNOWLEDGE_WIKI_SETTINGS: KnowledgeWikiSettings = {
  enabled: true,
  autoIngestDiscussions: true,
  autoIngestUserResponses: true,
  autoIngestUserInputs: true,
  ingestModel: 'haiku',
  queryModel: 'sonnet',
  lintStaleDays: 90,
  maxAgentPagesPerCall: 10,
  pageBodySoftCap: 4000,
  summarySoftCap: 200,
  exposeToMemberAgents: true,
  exposeToOrchestrator: true,
  recommendFoam: true,
  slugMapInIndex: true,
  maxAliasesGlobal: 100,
  injectRetrievedContext: true,
  retrievalMaxPages: 8,
  retrievalExcerptChars: 2000,
  indexSizeWarnBytes: 200 * 1024,
};

export interface AppSettings {
  boardTitle: string;
  maxMembersPerDiscussion: number;
  maxTurnsPerDiscussion: number;
  orchestratorPromptStyle: 'analytical' | 'creative' | 'balanced';
  autoSummarization: boolean;
  consensusThreshold: number;
  enableUserInteraction: boolean;
  userInteractionTimeout: number;
  clarificationThreshold: number;
  /** Default model for board members, orchestrator, summary, etc. */
  primaryModel: ClaudeModelAlias | ClaudeModel;
  /** Heavier model for research-grounded calls (skill task research, sparring). */
  researchModel: ClaudeModelAlias | ClaudeModel;
  /** Cheaper model for fast classification. */
  fastModel: ClaudeModelAlias | ClaudeModel;
  /** Per-call budget cap passed via --max-budget-usd. */
  perCallBudgetUsd?: number;
  budgetSettings?: UsageBudgetSettings;
  /** Locale for narrative-event messages and date formatting. */
  locale?: string;
  /** Knowledge Wiki (Phase 1.5) — replaces BusinessContext. */
  knowledgeWiki?: KnowledgeWikiSettings;
  /**
   * Active board id (Phase 7). When set, `aab discuss start` convenes this
   * board's roster by default. `undefined` ⇒ "All active members" (the
   * implicit default board). Per-workspace (lives in settings.json).
   */
  activeBoardId?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  boardTitle: 'AI Advisory Board',
  maxMembersPerDiscussion: 5,
  maxTurnsPerDiscussion: 10,
  orchestratorPromptStyle: 'balanced',
  autoSummarization: true,
  consensusThreshold: 75,
  enableUserInteraction: true,
  userInteractionTimeout: 30,
  clarificationThreshold: 60,
  primaryModel: 'sonnet',
  researchModel: 'opus',
  fastModel: 'haiku',
  perCallBudgetUsd: 5.0,
  budgetSettings: { warningThresholdPercent: 80 },
  locale: 'en',
  knowledgeWiki: { ...DEFAULT_KNOWLEDGE_WIKI_SETTINGS },
};

// ============================================================
// Skill generation runs (Action Board solve output)
// ============================================================

export interface SkillPackageFile {
  path: string;
  content: string;
}

export interface SkillCapabilityProfile {
  generatedAt: string;
  microSteps: Array<{ id: string; title: string; description: string; requiredCapabilities: string[] }>;
  requiredCapabilities: Array<{
    id: string;
    label: string;
    category: string;
    rationale: string;
    inferredTools?: string[];
    fallbackSummary?: string;
  }>;
  confirmedAvailableCapabilityIds: string[];
  unavailableCapabilityIds: string[];
  fallbackPlans: Array<{
    capabilityId: string;
    mode: 'artifact-draft' | 'manual-handoff' | 'ask-user-choice';
    preferredOutputFormat?: 'markdown' | 'docx' | 'txt' | 'json';
    instruction?: string;
  }>;
  notes?: string;
}

export interface AgentEnvironment {
  targetPlatform?: 'claude-code' | 'claude-cowork' | 'openclaw';
  mcpServers: string[];
  cliTools: string[];
  envVariables: string[];
  notes?: string;
}

export interface SkillGenerationRun {
  id: string;
  actionItemId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  costUsd: number;
  cacheHitRate: number;
  durationMs: number;
  files: SkillPackageFile[];
  installPath?: string;
  metadata: {
    skillName: string;
    confirmedCapabilityProfile?: SkillCapabilityProfile;
    agentEnvironment?: AgentEnvironment;
    decompositionSubtaskCount?: number;
    researchSourceCount?: number;
    singleLoopTurnCount?: number;
    criticScore?: number;
    criticPassed?: boolean;
    repairAttempts?: number;
    securityReview?: { mode: 'loose' | 'strict'; recommendation: 'loose' | 'strict' | 'defer' };
    triggerEvaluation?: {
      precision: number;
      recall: number;
      shouldTrigger: string[];
      shouldNotTrigger: string[];
    };
    potencyPassFileCount?: number;
  };
}

// ============================================================
// Token usage
// ============================================================

export interface TokenUsageLog {
  id: string;
  discussionId?: string;
  roundNumber?: number;
  turnNumber?: number;
  feature: string;
  operationType: string;
  model: string;
  tokens: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    totalTokenCount: number;
  };
  costUsd: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

// ============================================================
// User-customisable prompts
// ============================================================

export interface UserPrompt {
  id: string;
  promptKey: string;
  promptName: string;
  promptDescription: string;
  promptTemplate: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Storage interface (Phase 0 surface; expands per phase)
// ============================================================

export interface StorageService {
  // Settings
  loadSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;

  // Members
  loadBoardMembers(): Promise<AdvisoryBoardMember[]>;
  saveBoardMember(member: AdvisoryBoardMember): Promise<void>;
  updateBoardMember(member: AdvisoryBoardMember): Promise<void>;
  deleteBoardMember(id: string): Promise<void>;

  // Boards (member groups)
  loadBoards(): Promise<Board[]>;
  saveBoard(board: Board): Promise<void>;
  updateBoard(board: Board): Promise<void>;
  deleteBoard(id: string): Promise<void>;

  // Principles
  loadPrinciples(): Promise<Principle[]>;
  savePrinciple(principle: Principle): Promise<void>;
  updatePrinciple(principle: Principle): Promise<void>;
  deletePrinciple(id: string): Promise<void>;

  // Decision sessions (principle-based coaching)
  loadDecisionSessions(): Promise<DecisionSession[]>;
  loadDecisionSessionById(id: string): Promise<DecisionSession | null>;
  saveDecisionSession(session: DecisionSession): Promise<void>;
  updateDecisionSession(session: DecisionSession): Promise<void>;
  deleteDecisionSession(id: string): Promise<void>;

  // Sparring sessions (1:1 deep dive)
  loadSparringSessionsForDiscussion(discussionId: string): Promise<SparringSession[]>;
  loadSparringSessionById(sessionId: string): Promise<SparringSession | null>;
  saveSparringSession(session: SparringSession): Promise<void>;
  updateSparringSession(session: SparringSession): Promise<void>;
  deleteSparringSession(sessionId: string): Promise<void>;
  saveSparringMessage(sessionId: string, message: SparringMessage): Promise<void>;

  // Business context / profile
  loadBusinessContext(): Promise<BusinessContext[]>;
  saveBusinessContext(context: BusinessContext): Promise<void>;
  updateBusinessContext(context: BusinessContext): Promise<void>;
  deleteBusinessContext(id: string): Promise<void>;
  loadBusinessProfile(): Promise<BusinessProfile | null>;
  saveBusinessProfile(profile: BusinessProfile): Promise<void>;

  // Discussions
  loadDiscussions(): Promise<Discussion[]>;
  loadDiscussionPage(options?: { limit?: number; offset?: number; includeArchived?: boolean }): Promise<{
    discussions: Discussion[];
    totalCount: number;
    hasMore: boolean;
  }>;
  loadDiscussionById(id: string): Promise<Discussion | null>;
  saveDiscussion(discussion: Discussion): Promise<void>;
  updateDiscussion(discussion: Discussion): Promise<void>;
  deleteDiscussion(id: string): Promise<void>;
  archiveDiscussion(id: string): Promise<void>;
  unarchiveDiscussion(id: string): Promise<void>;

  // Action items (kanban)
  loadActionItems(): Promise<ActionItem[]>;
  saveActionItem(item: ActionItem): Promise<void>;
  updateActionItem(item: ActionItem): Promise<void>;
  deleteActionItem(id: string): Promise<void>;

  // Skill runs
  loadSkillRuns(actionItemId: string): Promise<SkillGenerationRun[]>;
  saveSkillRun(run: SkillGenerationRun): Promise<void>;
  getSkillRun(runId: string): Promise<SkillGenerationRun | null>;
  deleteSkillRun(runId: string): Promise<void>;

  // Token usage (append-only JSONL)
  appendTokenUsageLog(log: TokenUsageLog): Promise<void>;
  loadTokenUsageLogs(options?: { since?: string; limit?: number }): Promise<TokenUsageLog[]>;

  // User-customised prompts
  loadPrompts(): Promise<UserPrompt[]>;
  savePrompt(prompt: UserPrompt): Promise<void>;
  updatePrompt(prompt: UserPrompt): Promise<void>;
  deletePrompt(id: string): Promise<void>;

  // Workspace info
  getWorkspaceId(): string;
  getWorkspaceRoot(): string;
}
