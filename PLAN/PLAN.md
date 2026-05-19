# aabclitool — AI Advisory Board CLI (Claude Code-native port)

A complete plan to port `nyaiadvisoryboard/sage-council` (React + Gemini) to a CLI tool that runs natively inside Claude Code, using Claude sub-agents (one per board member) instead of Gemini, and using Claude Code skills for action-board outputs.

---

## Part 1 — Deep dive: what the source app actually does

### 1.1 What it is

**Sage Council / "AI Advisory Board"** is a multi-agent advisory board simulator. The user defines a panel of advisors (Elon Musk, a CFO, a domain expert, custom personas, …), poses a business question, and the system runs a multi-round, orchestrated discussion with all of them. Outputs include:

1. **Discussions** — multi-turn group conversations with consensus/repetition/quality analysis.
2. **Sparring (1:1 deep dive)** — private follow-up with one specific board member.
3. **Action Board** — extracts action items from discussions, then runs a multi-agent pipeline that produces concrete deliverables (prompts, scripts, guides, configs, code, strategies, **and skill packages** for Claude Code / Claude Cowork / OpenClaw).
4. **Decision Coach** — Ray Dalio–style principle-based decision conversations.
5. **Principle Explorer** — Socratic wizard that helps the user articulate their own principles.

Stack today: React 18 + Vite + TanStack Query + shadcn-ui + Supabase (auth + edge functions + Postgres). LLM: Google Gemini (`gemini-3-pro-preview`, `gemini-3-flash-preview`, `gemini-2.5-*` family). Demo mode = browser localStorage; cloud mode = Supabase. The whole architecture is hidden behind a single `StorageService` interface so swapping persistence is one implementation away.

### 1.2 Source-tree map (what we care about)

```
sage-council/
├── src/
│   ├── App.tsx                       routing (public, /demo/*, protected /*)
│   ├── pages/
│   │   ├── Discussions.tsx           main board flow
│   │   ├── BoardMembers.tsx          CRUD board members
│   │   ├── ActionBoard.tsx           CRUD + solve action items
│   │   ├── DecisionCoach.tsx         principle-based coach
│   │   ├── Principles.tsx            CRUD principles
│   │   ├── Settings.tsx              API keys, models, business profile
│   │   └── ...
│   ├── lib/
│   │   ├── conversation-flow.ts      ConversationFlowManager (top orchestrator)
│   │   ├── orchestrator.ts           OrchestratorService (continue/conclude/redirect/request_user_input)
│   │   ├── gemini.ts                 GeminiService (model calls; this is what we replace with Claude)
│   │   ├── enhanced-analyzer.ts      structured response parsing + question analysis
│   │   ├── business-context-agent.ts BusinessContextAgent (extracts company/industry/goals/...)
│   │   ├── conversation-analyzer.ts  extracts action items from concluded discussions
│   │   ├── sparring-service.ts       1:1 deep dive sessions
│   │   ├── action-research-service.ts research pre-pass for an action item
│   │   ├── action-solver-orchestrator.ts Phase-1 multi-agent action solver
│   │   ├── deep-execution-orchestrator.ts Phase-2 deliverable execution + packaging
│   │   ├── solution-packager-service.ts produces ZIP-ready folder layout
│   │   ├── plan-edit-service.ts      edits to nextSteps/implementationPlan
│   │   ├── voice-guide.ts            ai-driven persona voice generation
│   │   ├── ai-enhancer.ts            persona enhancement (famous / expert / non-famous)
│   │   ├── fallback-voice-guides.ts  hardcoded backup voices
│   │   ├── model-config.ts           Gemini model registry + URL builders
│   │   ├── feature-flags.ts          runtime flags (skill-aware decomposition, llm control plane, …)
│   │   ├── secure-api-key.ts         resolves API key based on storageType
│   │   ├── network/retry-fetch.ts    timeouts + exponential backoff
│   │   ├── parsing/safe-json.ts      tolerant JSON extraction (fences, leading text, trailing commas)
│   │   ├── parsing/llm-response-schemas.ts zod schemas for every LLM contract
│   │   ├── prompts/
│   │   │   ├── default-prompts.ts        all advisory + principles prompt templates
│   │   │   ├── skill-generation-prompts.ts ~14 skill-pipeline prompts
│   │   │   ├── prompt-resolver.ts        custom-or-default rendering
│   │   │   ├── skill-operating-model.ts  shared "what is a skill" preamble
│   │   │   └── skill-creator-method-context.ts authoritative skill-creator method
│   │   ├── agents/
│   │   │   ├── base-agent.ts             abstract Agent
│   │   │   ├── action-classifier.ts      research|analysis|planning|creative|technical
│   │   │   ├── solution-validator.ts     score solution 0-100 across 6 dimensions
│   │   │   ├── orchestration/
│   │   │   │   ├── task-orchestrator-agent.ts   decomposes action item → subtasks
│   │   │   │   ├── agent-maker-agent.ts          creates dynamic agents per gap
│   │   │   │   ├── parallel-execution-engine.ts  groups by deps, runs in parallel
│   │   │   │   ├── smart-synthesizer-agent.ts    merges agent outputs
│   │   │   │   └── dynamic-agent-executor.ts     runs a single dynamic agent
│   │   │   ├── research-team/web-research-agent.ts
│   │   │   ├── analysis-team/{market,financial}-analysis-agent.ts
│   │   │   ├── planning-team/strategy-planning-agent.ts
│   │   │   ├── creative-team/content-strategy-agent.ts
│   │   │   ├── validation-team/risk-assessment-agent.ts
│   │   │   └── execution/
│   │   │       ├── task-classifier-agent.ts        prompt|script|guide|...|skill
│   │   │       ├── deep-execution-agent.ts         research → create → validate → package
│   │   │       ├── skill-builder-agent.ts          single-loop skill authoring (plan + tool turns)
│   │   │       ├── skill-composition-analyzer.ts   standalone | merged | chain | mixed
│   │   │       ├── skill-composition-override-agent.ts LLM override of composition
│   │   │       ├── skill-composition-platform-context.ts platform-aware context block
│   │   │       └── skill-md-enhancer-references.ts curated ref selection
│   │   ├── skill-platforms/
│   │   │   ├── types.ts                   PlatformAdapter interface
│   │   │   ├── adapter-registry.ts        registry by SkillTargetPlatform
│   │   │   └── adapters/{claude-code,claude-cowork,openclaw}-adapter.ts
│   │   └── storage/
│   │       ├── types.ts                   StorageService interface (~50 methods)
│   │       ├── local-storage-service.ts   demo mode
│   │       └── supabase-storage-service.ts cloud mode
│   ├── types/
│   │   ├── advisory.ts                    Discussion/Member/Round/Settings/...
│   │   ├── principles.ts                  Principle/DecisionSession + STARTER_PRINCIPLES
│   │   └── starter-board-members.ts       Elon, Julian, Alexandra
│   └── components/...                     all UI; not ported to CLI
└── supabase/
    ├── functions/
    │   ├── generate-response/             member response (Gemini, JWT-auth, JSON contract)
    │   ├── decision-coach/                SSE-streamed Dalio coach
    │   ├── principle-explorer/            wizard chat
    │   ├── process-discussion-kickoff/    async job that runs round 1
    │   ├── process-discussion-operation/  async job for continue/follow-up/respond
    │   ├── start-discussion-{kickoff,operation}/  job creators
    │   ├── get-api-key/                   secure key fetcher
    │   ├── delete-account/, admin-*/      not ported
    │   └── _shared/discussion-async-capacity.ts  global parallel-job cap
    └── migrations/                        Postgres schema
```

### 1.3 Core data model (`src/types/advisory.ts`)

- **`AdvisoryBoardMember`** — `{ id, name, title, expertise[], persona, voiceGuide?, avatar?, isActive }`. `persona` is a 3-6 paragraph in-character bio; `voiceGuide` is a separate behavioral instruction sheet. The Elon starter persona includes a 5-trait BFI-2 psychometric profile and a 4-step cognitive process (deconstruct → algorithm → idiot index → vector).
- **`Board`** — named group of 1-5 member IDs.
- **`Discussion`** — `{ id, question, selectedMemberIds, boardId, responses[], actionItems[], rounds[], orchestratorState, summary, totalTurns, maxTurns, pendingUserRequest, userResponses[] }`.
- **`ConversationRound`** — `{ roundNumber, responses[], orchestratorDecision, userInteractionRequest, userResponse, followUpQuestion, followUpTargetType, followUpSelectedMemberId(s) }`.
- **`OrchestratorState`** — `{ phase: initial|continuation|consensus|concluded, consensusLevel 0-100, topicExploration 0-100, repetitionDetected, shouldContinue, conversationQuality: poor|fair|good|excellent }`.
- **`OrchestratorDecision`** — `{ action: continue|conclude|redirect|request_user_input, reasoning, nextSpeaker?, suggestedDirection?, consensusReached, confidence, userInputRequest? }`.
- **`Response`** — `{ memberId, memberName, content, order, roundNumber, turnNumber, isFollowUp, referencedMembers[], sentiment, topicTags[], structuredData }`. `structuredData` carries `keyPoints`, `questionsForOthers`, `actionSteps`, `confidence`.
- **`UserInteractionRequest`** / **`UserResponse`** — orchestrator-driven HITL: when the panel needs clarification it asks the user a typed question (clarification|decision|preference|information) with optional `options[]`.
- **`ActionItem`** — `{ id, discussionId, title, description, priority, status, assignedTo?, dueDate? }`.
- **`BusinessContext`** — `{ id, category: company|industry|goals|challenges|team|market|product|strategy|tools, title, description, confidence 0-100, extractedFrom, relevantKeywords[], isActive }`. Pulled from every user message.
- **`AppSettings`** — API key, primary/research/fast model, `maxTurnsPerDiscussion`, `consensusThreshold`, `enableUserInteraction`, `clarificationThreshold`, budget settings.
- **`SparringSession`** — 1:1 anchored at a specific (member, round, turn) with its own message history.
- **`TokenUsageLog`** — every LLM call writes one async; per-feature totals + per-day rollup.

### 1.4 The discussion engine (the heart of the app)

`ConversationFlowManager` (`src/lib/conversation-flow.ts`) is the top orchestrator. It composes:

1. `BusinessContextAgent` — extracts contexts from every user message (3-attempt retry: primary → primary compact → fast compact, MAX_TOKENS detection, transient-failure isolation, category aliasing/normalization, char/item caps for prompt injection).
2. `EnhancedAnalyzer` — `enhanceQuestionExtraction` (certainty/type/keywords) and `parseStructuredResponse` (3 retry strategies + alternative parsers + ultimate AI fallback). Has aggressive `extractCleanResponse` regex to strip JSON wrappers that leak into displayed text.
3. `OrchestratorService` — calls Gemini with low temp (0.3, topK 20, topP 0.8) and a single decision prompt; computes `consensusLevel`, `topicExploration`, `repetitionDetected` (≥0.7 word-overlap Jaccard) deterministically per round.
4. `GeminiService` — every model call.

**Round flow** (replicate exactly in CLI):

```
startMultiTurnDiscussion(question, members):
  → enhanceQuestionExtraction(question)               // ~classify the question
  → loadBusinessContextFromStorage()
  → contextAgent.extractContextFromInput(question)    // save new contexts
  → executeInitialRound(question, activeMembers, discussion):
        for each active member sequentially:
          gemini.generateResponse(member, question, previousResponses, contextPrompt)
          enhancedAnalyzer.parseStructuredResponse(...)   // JSON: response, keyPoints, questions, actionSteps, confidence
          push Response{...}; previousResponses += "name: content"
  → orchestrator.analyzeConversation → decision (action/reasoning/nextSpeaker/.../userInputRequest)
  → orchestratorState = updateOrchestratorState(...)
  → return discussion (round.completedAt set)

continueDiscussion(discussion, members):
  // bail if maxTurns reached, concluded, or pendingUserRequest
  // rehydrate rounds from flat responses if loaded from DB
  // pre-round clarification gate (calls orchestrator first)
  // run executeFollowUpRound(discussion, activeMembers, nextRoundNumber):
  //    builds full conversationHistory, calls generateMultiTurnResponse for each speaker
  // re-run orchestrator → new decision → maybe summary

addFollowUpQuestion(discussion, question, members, targetType, selectedMemberId(s)):
  // targetType ∈ all|specific|subset
  // pre-round clarification gate
  // append "User Follow-up Question: …" to history
  // run target members through generateMultiTurnResponse
  // require 100% success across selected members (throws on partial)
  // log into discussion.userResponses with type=follow_up_question

respondToUserRequest(discussion, userResponse, members, selectedOption?):
  // when discussion.pendingUserRequest is set
  // also extracts business context from the user reply
  // creates a follow-up round with all active members responding to the user reply
  // type=advisory_board_requested

injectSparringInsight(discussion, insight, ...):
  // attaches a sparring deep-dive insight back into the main timeline
  // type=sparring_injection (no new round)

generateSummary(discussion, members):
  // schema-validated JSON: keyPoints, consensus, disagreements, actionableInsights,
  //                        participationBreakdown[], overallQuality
  // matches participants by id then by normalized name
```

**Critical invariants** the CLI must preserve:
- Round numbering is monotonically incremented; existing-round guard (`r.roundNumber === nextRoundNumber`) prevents duplicate execution.
- `discussion.totalTurns` accumulates `responses.length` per round.
- Orchestrator runs *after* the round responses, except for the **pre-round clarification gate** (it runs *before* a follow-up round if it returns `request_user_input`).
- On follow-ups with multiple selected members, partial failures are an error — no silent partial round.
- Reconstruction of `rounds[]` from a flat `responses[]` is a documented behavior (used after loading from DB).

### 1.5 Member-response prompt (the highest-leverage prompt)

`board_member_response` (default-prompts.ts and parallel buildContext in gemini.ts) — fields filled per call:

- `member_name`, `member_title`, `expertise` (joined)
- `voice_guide` (LLM-generated or fallback)
- `persona` (the long bio)
- `question` (original user question)
- `business_context` (rendered from BusinessContext bank, capped to `MAX_CONTEXT_PROMPT_CHARS = 3500` and `MAX_CONTEXT_PROMPT_ITEMS = 12`, sorted by confidence then recency, head/tail trimmed)
- `previous_responses` (joined `name: content`, separated by `\n\n---\n\n`)

The contract demands a strict JSON object with: `response` (2-4 paragraphs first-person), `keyPoints` (3-5), `questionsForOthers`, `actionSteps`, `confidence` (0-100), and optional `assumptions`, `tradeoffs`, `riskMitigations`, `firstPrinciplesApplied`, `sources` (when search was used). "Return ONLY raw JSON; no fences; start with `{`." Multi-turn version (`multi_turn_response`) adds `conversation_history`, `round_number`, and `is_follow_up` and lowers the depth requirement; uses Mustache-style `{{#is_follow_up}}…{{/is_follow_up}}` / `{{^is_follow_up}}` sections.

`generateResponse` config: `temperature 0.7, topK 40, topP 0.95, maxOutputTokens 10000`. Multi-turn follow-ups bump temp to `0.8`. Discussion timeouts: `20 s` standard, `60 s` premium-tier; **0 retries** at this layer (one shot per member); fallback path is "primary model → fast model → no-tools retry."

### 1.6 Orchestrator prompt

`orchestrator_decision` — fed `{ question, active_members, current_turn, max_turns, consensus_threshold, conversation_history }`. Asked to evaluate (1) consensus, (2) topic exploration, (3) repetition, (4) quality, (5) need for user input, (6) business-context certainty. Returns a JSON object with `action`, `reasoning`, `nextSpeaker`, `suggestedDirection`, `consensusReached`, `confidence (0-100)`, optional `userInputRequest{ type, question, context, requestingMembers, urgency, options? }`. Config: temp 0.3, topK 20, topP 0.8, **15 s timeout, 0 retries**, model fallback primary→fast.

The state-update math is deterministic and runs **after** the LLM decision: `phase` derived from action+consensus, `consensusLevel` from "agree/yes/exactly" word counts, `topicExploration` from unique long-word count, `repetitionDetected` via Jaccard ≥0.7, `conversationQuality` from a weighted score.

### 1.7 Conversation summary prompt

`conversation_summary` returns `{ keyPoints, consensus, disagreements, actionableInsights, participationBreakdown[{memberName, totalResponses, topicsCovered, influence}], overallQuality }`. Triggered when the orchestrator concludes and `settings.autoSummarization` is true.

### 1.8 Persona enhancement

Three template variants — `enhance_famous_person`, `enhance_top_expert`, `enhance_non_famous` — that take `{ member_name, member_title, expertise_text, current_persona? }` and return `{ persona, voiceGuide }`. Each template "identity-locks" to the named individual, captures profile-type-specific content (fame/peer-recognition/practitioner depth), and outputs a 4-6 paragraph persona plus a concise voiceGuide. `voice-guide.ts` runs additional voice-guide generation; `fallback-voice-guides.ts` carries hardcoded guides for first-load resilience.

### 1.9 1:1 Sparring deep dive

`sparring_deep_dive` prompt receives the member, their original board response (the "anchor"), the broader discussion, business context, and the running sparring history. The model is told this is a private 1:1 and must go significantly deeper, give concrete examples, state assumptions/tradeoffs, push back, cite data when possible, and use markdown headings + bullets (not a wall of text). It can also use Google Search.

### 1.10 Action Board pipeline (the most complex subsystem)

There are **two phases** wrapped together by `actionSolverOrchestrator.solveActionItem(actionItem, options)`.

#### Phase 1 — Solve the action item

```
ActionClassifier.classifyAction(actionItem)
   → category (research|analysis|planning|creative|technical), complexity (low|medium|high),
     requiredAgentTeams[], estimatedTime, confidence

contextIntelligenceService.analyzeContextRelevance(actionItem)
dataCollectionService.collectRelevantData(...)        → BusinessContext + relevant discussions
contextSummarizerService.summarizeForAction(...)      → discussionSummary, businessSummary, taskSummary, fullContextPrompt
loadAgentEnvironment(skillTargetPlatform)             → mcpServers/cliTools/envVariables (from BusinessProfile)

taskOrchestratorAgent.decompose(actionItem, ctx)
   → TaskDecomposition{ subtasks[], dependencies, complexity, researchFindings? }

agentMakerAgent.createAgentsForSubtasks(subtasks, complexity, contextSummaries)
   → { dynamicAgents: DynamicAgentSpec[], existingAgentAssignments[] }
   // existing agents: web-research, market-analysis, financial-analysis, strategy-planning, content-strategy, risk-assessment

parallelExecutionEngine.buildExecutionPlan(...)       // groups by deps
parallelExecutionEngine.executeWithParallelism(...)   // runs each group concurrently, streaming progress
   // dynamicAgentExecutor handles each dynamic agent: research→0.2 temp, planning→0.3, creative→0.5

smartSynthesizerAgent.synthesize(agentResults, ctx)
   → SynthesisResult{ executiveSummary, fullSolution, sections[], consolidatedNextSteps,
                      riskAnalysis, resourceRequirements, conflictsResolved }

solutionValidator.validateSolution(actionItem, agentResults, solution)
   → { passed, score 0-100, issues, suggestions }
   // refinement loop (up to maxRefinementAttempts=2) when score < qualityThreshold=75
```

The output is `ActionSolution{ solution, methodology, reasoning, nextSteps[], implementationPlan, confidence, sources[], agentTeams[], executionSummary{qualityScore,validationPassed,...}, decomposition?, decompositionResearch?, skillTargetPlatform? }`. Strong fallbacks for `implementationPlan` (planning agent → strategy agent → templated). Sources deduped on URL, capped at 25.

#### Phase 2 — Deep execution (turn next-steps into deliverables)

Triggered when the user picks "Solve" (artifacts mode) or "Create skill" (skill mode):

```
For each next-step:
  taskClassifierAgent.classify(step, parentActionItem)
     → ExecutionTask{ deliverableType: prompt|script|guide|template|config|code|strategy|checklist|copy|analysis|skill,
                      primaryFileType: md|json|txt|yaml|html, suggestedFilename, suggestedFolder,
                      estimatedTime, priority, agentExpertise[], researchQueries[], confidence,
                      stepQuality{isAtomic,isSkillWorthy,scopeIssues[],suggestedSplit[]} }

For non-skill deliverables: deepExecutionAgent runs research → create → validate → package phases.

For skill deliverables: skillBuilderAgent runs a single-loop authoring runtime:
  1. Plan: skill_generation.single_loop_planner → ordered atomic steps to build the package
  2. Loop tool turns: skill_generation.single_loop_tool_turn → exactly one of
     {list_files, read_file, create_file, update_file, write_file, rename_file, delete_file}
     until status=done
  3. Quality critique: skill_generation.skill_package_critic
     hard-gates: SKILL.md exists, frontmatter valid, no unverified-tool assumptions,
                 fallback path present, no schema-critical violations
     rubric: taskWorkflowFit, operationalClarity, progressiveDisclosure, outputContract,
             edgeCasesFallbacks, toolingSafety, validationLoop
  4. Repair loop: skill_generation.repair_pass on critical issues
  5. Master-prompter potency pass: skill_generation.master_prompter_potency_pass per file
  6. Security review: skill_generation.security_review
     → mode loose|strict, packageModeRecommendation loose|strict|defer
  7. Trigger evaluator: skill_generation.trigger_evaluator
     → 8-10 should-trigger queries + 8-10 should-not-trigger near-misses + precision/recall

skillCompositionAnalyzer (deterministic graph) +
optional skillCompositionOverrideAgent (LLM override gated by skill_generation.composition_critic)
   → SkillCompositionPlan{ compositionType: standalone|merged|chain|mixed, skillGroups[] }

solutionPackagerService produces a folder layout:
   00-executive-summary.md
   01-solution-overview.md
   <skill-name>/SKILL.md, references/, scripts/        per skill task
   <ordered-folder>/...                                 per artifact deliverable
   composition-plan.md, install-guide.md
```

`SkillTargetPlatform ∈ { claude-code, claude-cowork, openclaw }`. `claude-code` install path: `.claude/skills/<skill-name>/`. The current `ClaudeCodeAdapter.adapt` is identity (`return payload`); the abstraction is in place for future tweaks.

**SKILL.md frontmatter** (generated by skillBuilderAgent and validated by `skillPackagePayloadSchema`):

- `name`, `description` (must include "Use when …" trigger language), `trigger_queries[]`, `dependencies[]`, `tools[]` (must match confirmed capabilities), `file_types[]`, `safety_mode: loose|strict`, `estimated_tokens`, `estimated_time_minutes`, `examples[]`, `notes`.

The body must be an *execution system prompt* (not a doc): mission, workflow, decision rules, validation gates, output contract, fallbacks. Body should be deep — the master-prompter potency pass actively rewrites generic boilerplate.

### 1.11 Skill prompts (`src/lib/prompts/skill-generation-prompts.ts`)

Each prompt has explicit `requiredVariables` and `requiredFragments` and is validated by `validateAdminPromptTemplate`. The 14 prompts are: `skill_md_enhancer`, `security_review`, `trigger_evaluator`, `repair_pass`, `decomposition_critic`, `skill_aware_decomposition_critic`, `composition_critic`, `skill_package_critic`, `single_loop_creator`, `single_loop_planner`, `single_loop_tool_turn`, `master_prompter_potency_pass`, `task_classifier`, `composition_override`, `skill_task_research`. They share the `<skill_operating_model>` preamble (instruction-first, description-driven routing, progressive disclosure, no-unverified-tools, atomic steps).

### 1.12 Decision Coach + Principle Explorer

- **Decision Coach** — `decision_coach_system` prompt: identifies relevant principles by name, surfaces principle-vs-emotion conflicts, asks Socratic questions, references anti-patterns, weighs by stated `priority` (1-10). Tone: direct, radical-transparency, warm, principle-grounded. Streamed (SSE) responses.
- **Principle Explorer** — `principle_explorer_system` + 5 step prompts (`behavior`, `antipattern`, `triggers`, `examples`, `priority`). Each step takes ≤2 exchanges and converges to `**Suggested X:** ...` synthesis. Cross-step context is mandatory ("ACKNOWLEDGE specific examples the user shared").
- **Principle data**: 8 starter principles seeded from Ray Dalio (Embrace Reality, Pain + Reflection, Disagree and Commit, …); category palette `life|work|relationships|health|finance|meta`.

### 1.13 Edge functions (server-side responsibilities)

Their behavior must move client-side in the CLI:

- `generate-response` — single-member response (Gemini, JWT-validated, JSON contract).
- `decision-coach` — SSE streamed, principles injected.
- `principle-explorer` — wizard chat.
- `process-discussion-kickoff` and `process-discussion-operation` — async job runners; queue, capacity (per-user + global), heartbeat, stale-job watchdog (`MAX_PARALLEL_DISCUSSION_JOBS_GLOBAL`, `DISCUSSION_ASYNC_STALE_RUNNING_TIMEOUT_MS`), retry with exponential backoff on Gemini 429/503.
- `start-discussion-{kickoff,operation}` — job creators.
- `get-api-key` — secure key resolution.

### 1.14 StorageService surface (~50 methods)

Members, Boards, Discussions (paged + by-id + lifecycle: archive/unarchive/delete), Action Items, Settings, BusinessContext, BusinessProfile, Prompts (user overrides), ResearchHistory, GeneratedRuns, Principles, DecisionSessions, SparringSessions+Messages, TokenUsageLogs+Summary, Kickoff/Operation/SkillGeneration jobs (start/load/trigger/cancel) and `getStorageType(): 'local' | 'cloud'`. Every service goes through this; nothing else touches persistence directly.

### 1.15 Critical reliability machinery to preserve

- **Tolerant JSON parsing** — code-fence stripping, leading/trailing-text removal, brace-balance scan, single→double-quote, unquoted-key fix, trailing-comma fix, then schema-validate with zod, then a permissive parse, then keyword-fallback. Without this the JSON-only contract breaks whenever the LLM includes ``` ``` fences or chatter.
- **MAX_TOKENS detection** — read `candidates[0].finishReason`; if MAX_TOKENS, retry with shorter prompt (compactMode on BusinessContextAgent).
- **Transient failure handling** — `isGeminiTransientCapacityErrorMessage` (429/503/"high demand") downgrades log severity and triggers fallback model.
- **Token usage logging** — `fireAndForgetTokenLog(storage, { discussionId, operationType, tokenUsage, …})`.
- **Feature flags** — `skill_generation_skill_aware_decomposition_v1`, `skill_generation_llm_control_plane_v1`, `action_board_v3_ui_v1`. The CLI keeps the flag system but defaults the LLM-first variants on (Claude is strong enough).
- **Prompt hardening guardrail** (CLAUDE.md): every authored/edited prompt must go through `master-gpt-prompter` before shipping; placeholders and JSON contract fragments must not be lost. The CLI inherits this rule.

---

## Part 2 — The CLI port

### 2.1 Goal in one sentence

Reproduce the entire Sage Council product as a Node CLI that a user runs inside Claude Code, where (a) every Gemini call becomes either a direct `Anthropic` SDK call **or** a Claude Code sub-agent invocation, (b) board members are individual Claude sub-agents (`.claude/agents/<member>.md`), (c) action-board outputs are emitted as Claude Code skills (`.claude/skills/<skill-name>/SKILL.md`), and (d) all data lives on disk (no Supabase, no browser).

### 2.2 Two execution modes the CLI supports

**Mode A — Headless (default).** The CLI binary runs the entire orchestration in-process using the **Anthropic SDK** (`@anthropic-ai/sdk`) with API-key auth. Board members are simulated via separate `messages.create` calls per member, each with a system prompt assembled from that member's persona/voiceGuide/expertise. This works whether or not the user is inside Claude Code.

**Mode B — Claude Code-native.** When the CLI detects it is being run *inside* Claude Code (env hint: presence of `CLAUDE_CODE_*` vars, or explicit `--mode=cc`), it switches to *agent-orchestrator* style: it generates board-member sub-agents on the fly under `.claude/agents/`, then uses the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) to dispatch member responses *as sub-agents* (`Task` tool). Each sub-agent inherits Claude Code's tool surface (WebSearch, WebFetch, Read, Grep, …) so members can search the web, read files in the user's project, etc. — fulfilling the "they will also have all kinds of tools like WebSearch" requirement.

Mode A is fast and cheap (one shared process). Mode B is richer and more agentic. The CLI ships both and the user picks per-command via `--mode`. Default = `auto` (detect).

### 2.3 Tech choices

- **Runtime:** Node 20+, TypeScript (port lib code as-is where possible).
- **CLI framework:** `commander` (battle-tested, small) for command tree; `enquirer` for interactive prompts (board picker, follow-up question typing); `ora` for spinners; `chalk` for color; `cli-table3` for tables.
- **Markdown rendering in TTY:** `marked` + `marked-terminal`.
- **LLM:** `@anthropic-ai/sdk` (Mode A) and `@anthropic-ai/claude-agent-sdk` (Mode B). Default model for everything: `claude-sonnet-4-5` (fast, smart, supports tool use). Fallback "fast" model: `claude-haiku-4-5-20251001`. Heavy-research model: `claude-opus-4-7`.
- **Storage:** filesystem JSON under `~/.aabcli/<workspace>/` by default, overridable per-project via `./.aabcli/`. SQLite (better-sqlite3) only if we hit perf/cardinality issues — start with JSON.
- **Parsing:** keep `safeParseJSONWithSchema` and zod schemas verbatim. Anthropic's tool-use mode and `response_format` give us a much cleaner contract than Gemini, but we keep the fallback parser anyway.
- **Web search in Mode A:** Anthropic's built-in `web_search_20250305` server tool. Keep the existing "no-tools fallback" path.
- **Streaming output to TTY:** Anthropic SDK supports streaming; render member tokens as they arrive.

### 2.4 Repository layout for `aabclitool`

```
aabclitool/
├── package.json
├── tsconfig.json
├── bin/
│   └── aab.ts                          // shebang entry
├── src/
│   ├── cli.ts                          // commander setup + global flags
│   ├── commands/
│   │   ├── init.ts                     // bootstrap workspace, write starter members/principles
│   │   ├── settings.ts                 // get/set API key, models, business profile
│   │   ├── members/                    // list, add, edit, delete, enhance, sync-agents
│   │   ├── principles/                 // list, add, explore (wizard), seed-starters
│   │   ├── coach.ts                    // decision coach REPL
│   │   ├── discuss/
│   │   │   ├── start.ts                // new discussion
│   │   │   ├── continue.ts             // continue existing
│   │   │   ├── follow-up.ts            // single/specific/subset/all
│   │   │   ├── respond.ts              // answer pendingUserRequest
│   │   │   ├── spar.ts                 // 1:1 deep dive
│   │   │   ├── inject.ts               // sparring → main timeline
│   │   │   ├── summarize.ts
│   │   │   ├── show.ts                 // pretty-print rounds
│   │   │   └── export.ts               // md or pdf
│   │   ├── actions/
│   │   │   ├── extract.ts              // discussion → action items
│   │   │   ├── list.ts
│   │   │   ├── solve.ts                // Phase 1
│   │   │   └── deep-execute.ts         // Phase 2 (artifacts | skill)
│   │   └── usage.ts                    // token usage summary
│   ├── llm/
│   │   ├── client.ts                   // unified ClaudeService (Mode A/B switch)
│   │   ├── claude-direct.ts            // Anthropic SDK wrapper (replaces gemini.ts)
│   │   ├── claude-agents.ts            // Claude Agent SDK wrapper for sub-agents (Mode B)
│   │   ├── tools.ts                    // web search etc.
│   │   ├── retry.ts                    // ported from network/retry-fetch.ts
│   │   └── token-usage.ts
│   ├── core/
│   │   ├── conversation-flow.ts        // ported, calls ClaudeService instead of GeminiService
│   │   ├── orchestrator.ts             // ported as-is
│   │   ├── enhanced-analyzer.ts        // ported
│   │   ├── business-context-agent.ts   // ported
│   │   ├── conversation-analyzer.ts    // ported
│   │   ├── sparring-service.ts         // ported
│   │   ├── voice-guide.ts              // ported
│   │   ├── ai-enhancer.ts              // ported
│   │   ├── action/
│   │   │   ├── action-classifier.ts
│   │   │   ├── action-research-service.ts
│   │   │   ├── action-solver-orchestrator.ts
│   │   │   ├── deep-execution-orchestrator.ts
│   │   │   ├── solution-packager-service.ts
│   │   │   └── plan-edit-service.ts
│   │   ├── agents/                     // entire src/lib/agents/ tree, ported
│   │   ├── prompts/                    // entire src/lib/prompts/ tree, ported
│   │   └── parsing/                    // safe-json + llm-response-schemas, ported
│   ├── storage/
│   │   ├── types.ts                    // unchanged StorageService interface
│   │   ├── fs-storage-service.ts       // NEW: filesystem-backed implementation
│   │   ├── job-runner.ts               // in-process job runner (replaces edge functions)
│   │   └── paths.ts                    // resolves workspace root, file layout
│   ├── platforms/
│   │   ├── claude-code-adapter.ts      // emits .claude/skills/<name>/...
│   │   ├── claude-cowork-adapter.ts    // ported (still emits .claude/skills/...)
│   │   ├── openclaw-adapter.ts         // ported (~/.openclaw/skills/...)
│   │   └── adapter-registry.ts
│   ├── ui/
│   │   ├── render-discussion.ts        // pretty round/Response printing
│   │   ├── render-progress.ts          // ora-based progress for long ops
│   │   ├── render-skill.ts             // SKILL.md preview pretty-print
│   │   └── prompts.ts                  // enquirer wrappers
│   ├── env/
│   │   └── detect-claude-code.ts       // mode auto-detection
│   └── starter/
│       ├── starter-board-members.ts    // ported (Elon, Julian, Alexandra, +)
│       └── starter-principles.ts       // ported
├── .claude/                            // optional, generated by `aab init`
│   ├── agents/                         // one .md per board member (Mode B)
│   ├── skills/                         // generated skill packages
│   └── commands/                       // optional convenience slash commands
└── PLAN/                               // this directory
```

### 2.5 The Claude port of `GeminiService` (`src/llm/claude-direct.ts`)

Same five public methods, same signatures, same JSON contract:

```ts
generateResponse(member, question, previousResponses[], businessContext?)
generateMultiTurnResponse(member, question, conversationHistory[], roundNumber, isFollowUp, businessContext?)
generateOrchestratorDecision(context)
generateWithSearchGrounding(prompt, settings?)        // → web_search_20250305 tool
generateConversationSummary(question, allResponses[], members[])
```

Implementation notes:

- **System vs user split.** Anthropic separates `system` and `messages`. Move the per-member identity block (`# IDENTITY & ROLE` + voice + persona + tools + format rules) into `system`. Move `# DISCUSSION CONTEXT` (question, business context, previous responses) into a single `user` message. This is more cache-friendly and the model treats it as expected.
- **Prompt caching.** Every member's system prompt is stable across rounds. Mark it `cache_control: { type: 'ephemeral' }`. The persona block is large; this saves real money over a 5-round discussion.
- **Tools in Mode A.** Enable `web_search_20250305` for member responses *only* (mirroring the Gemini search-tools flag). Orchestrator and summary calls don't need tools. Keep the "no-tools retry" path.
- **JSON contract.** Anthropic supports tool-use forced JSON, but the existing prompts already produce a JSON object. Easiest port: keep the JSON-string-out contract and feed through the existing `parseStructuredResponse`. Optionally upgrade to a `respond_with_json` tool (an empty `input_schema` matching the contract) for guaranteed structured output — `keyPoints`, `questionsForOthers`, `actionSteps`, `confidence`, `assumptions`, `tradeoffs`, `riskMitigations`, `firstPrinciplesApplied`, `sources`. This is a strict win; the existing fallback parser stays as belt-and-braces.
- **Temperature parity.** Member: 0.7 (initial), 0.8 (follow-up). Orchestrator: 0.3. Summary: 0.4. Search-grounded: 0.3. Same `max_tokens` 10000 ceiling.
- **Timeouts and retries.** Same numbers as gemini.ts: 20 s standard, 60 s for premium model, 0 retries inside the discussion call (we want fast failure → fallback model). The model-fallback chain becomes: `primaryModel: claude-sonnet-4-5` → `fastModel: claude-haiku-4-5-20251001`. `researchModel: claude-opus-4-7` for `generateWithSearchGrounding` heavy lifts.
- **Token usage.** Map Anthropic `usage` → existing `TokenUsageEntry`: `promptTokenCount = input_tokens + cache_creation_input_tokens`, `candidatesTokenCount = output_tokens`, `thoughtsTokenCount` unused (Claude does not expose), `totalTokenCount = sum`. Continue logging via `fireAndForgetTokenLog`.

### 2.6 The Claude **sub-agent** port (Mode B) — board members as sub-agents

This is the part the user asked about most explicitly: "FOR ADVISORY BOARD MEMBERS THERE WILL BE CREATED SEPERAT[E] CLAUDE AGENTS THAT WILL BE PROMPTED THE EXACT SAME WAY."

#### 2.6.1 Where the agent files live

Project-scoped under `.claude/agents/<slug>.md`. Slug is `slugify(member.name)` (e.g., `elon-musk.md`, `alexandra-chen-cfa.md`). Project agents take precedence over `~/.claude/agents/`, so per-board overrides are natural. Whenever a member is created/edited via `aab members add|edit|enhance`, we regenerate that file. Whenever a member is deleted, the agent file is deleted. `aab members sync-agents` rewrites all of them in one shot.

#### 2.6.2 Frontmatter contract

```yaml
---
name: elon-musk
description: Use when the user asks for Elon Musk's perspective on a business question, when running an advisory board discussion, when seeking first-principles engineering input, or when a board member named "Elon Musk" is selected.
tools: WebSearch, WebFetch, Read, Grep, Glob
model: sonnet
---
```

`description` matters — Claude Code routes to the agent based on it. We pack it with the same trigger language Claude Code uses elsewhere ("Use when …"). `tools` is an explicit, narrow allowlist — board members get **read/web only** by default (no Edit/Write/Bash) so a member's response can never mutate the user's project. `model: sonnet` is the default; users can switch to opus per-member in Settings.

#### 2.6.3 Body = the existing `board_member_response` system prompt

Body of the .md file is the *system prompt* the sub-agent uses on every invocation. We render the existing template with the member's identity block fully baked in (no `{{question}}` placeholder — the question arrives in the user message). Concretely:

```markdown
# IDENTITY & ROLE
You are {{member_name}}, {{member_title}}. You are participating in a high-stakes advisory board discussion.

## YOUR EXPERTISE
{{expertise}}

## YOUR VOICE & BEHAVIOR GUIDE
<user_voice_guide>
{{voice_guide}}
</user_voice_guide>

## YOUR PERSONA & APPROACH
<user_persona>
{{persona}}
</user_persona>

# AVAILABLE TOOLS
- **WebSearch**: search the public web when you need current data, market info, or anything past your training.
- **WebFetch**: read a specific URL when you've found a relevant one.
- **Read / Grep / Glob**: read files in the user's project when context is needed.
Use search proactively, but cite sources you actually relied on under "sources".

# RESPONSE REQUIREMENTS
## Core Principles:
- Apply first-principles thinking …  (verbatim from default-prompts.ts)
- …

## CRITICAL FORMAT INSTRUCTIONS:
- Return ONLY the raw JSON object below — no markdown, no fences, no commentary.
- Start with `{` and end with `}`.

## Response Structure (pure JSON, no markdown):
{
  "response": "Your main response as {{member_name}} (2-4 paragraphs, first person)",
  "keyPoints": [...],
  "questionsForOthers": [...],
  "actionSteps": [...],
  "confidence": <0-100>,
  "assumptions": [...],
  "tradeoffs": [...],
  "riskMitigations": [...],
  "firstPrinciplesApplied": [...],
  "sources": [{"title": "...", "url": "..."}]
}

## Voice Requirements:
- Sound distinctly like {{member_name}}…
```

The placeholders are filled at **agent-generation time**, not at invocation time. This is the only safe approach because Claude Code's `Task` tool doesn't let us re-template the body per call. The runtime user-message carries the per-call payload (question + business context + previous responses + round number + is-follow-up flag).

#### 2.6.4 Multi-turn variant

Two options, both viable; we pick **(a)** for simplicity:

(a) **Single agent, two prompt modes baked into the body.** The body says: "If the user message starts with `[ROUND: N | IS_FOLLOW_UP: true]\n…` apply the multi-turn rules: respond to or build on others, less depth, more conversational." We feed the conversation history in the user message. This matches Sage Council's behavior (one persona, two prompt variants) and avoids agent-file proliferation.

(b) Two agents per member (`elon-musk` and `elon-musk-followup`). More files, no benefit.

#### 2.6.5 How rounds are dispatched

In Mode B, `ConversationFlowManager.executeInitialRound` becomes:

```
for each active member sequentially:
   await taskTool.invoke({
     subagent_type: member.slug,
     description: `${member.name}: round ${roundNumber}`,
     prompt: buildUserMessage(question, previousResponses, businessContext, roundNumber, isFollowUp)
   })
```

The CLI doesn't have access to the `Task` tool directly — the Claude Agent SDK exposes the same agent-routing as a programmatic API. We construct an outer agent that has a single tool: `delegate_to_member(memberSlug, payload)`. That tool is implemented client-side; under the hood it does exactly the per-member call described above. This keeps tool-use semantics intact (the model "uses" the delegation tool, but execution is local).

Why not have the orchestrator agent autonomously fan out? Because the existing orchestrator logic is deterministic enough (selection, history truncation, structured-data extraction) that doing it programmatically is cheaper and more predictable. The LLM is reserved for the actual reasoning steps: business context, member responses, orchestrator decision, summary.

#### 2.6.6 What about the orchestrator?

The orchestrator stays a direct LLM call (Mode A internals) even in Mode B. It doesn't need tools, it returns a small JSON, and putting it behind a sub-agent file would make iteration painful. We do *not* generate a `.claude/agents/orchestrator.md`. Same for `business-context-agent`, `enhanced-analyzer`, `conversation-summary`. They all stay as `claude-direct.ts` calls.

(We *could* generate an `.claude/agents/aab-orchestrator.md` so the user can also drive a discussion conversationally inside Claude Code itself — see Bonus features in §2.13.)

### 2.7 Business context, sparring, principles — direct ports

> **⚠ Superseded for BusinessContext (2026-05-10):** the flat-JSON `BusinessContext` / `BusinessContextAgent` plan below is replaced by the **Knowledge Wiki** (Karpathy-style LLM Wiki). See **Part 7** of this file and the dedicated spec at `PLAN/KNOWLEDGE_WIKI.md`. Sparring, principles, and the rest of §2.7 still apply as written.

- **BusinessContextAgent.** Port verbatim. Switch the `fetchWithRetry` URL to Claude. The 3-attempt retry strategy (primary normal → primary compact → fast compact) maps cleanly to (sonnet/full → sonnet/compact → haiku/compact). MAX_TOKENS detection becomes Claude's `stop_reason === 'max_tokens'`.
- **EnhancedAnalyzer.** Port verbatim. The aggressive `extractCleanResponse` regex stays — Claude is much better-behaved on JSON, but the regex is cheap insurance and keeps the same parsing path for both modes.
- **OrchestratorService.** Port verbatim. Deterministic post-processing (consensus/exploration/repetition) is unchanged.
- **ConversationFlowManager.** Port verbatim except for the `gemini` field which becomes `claude` (a `ClaudeService` that picks Mode A or Mode B).
- **SparringService.** Port verbatim. In Mode B, sparring uses the **same** sub-agent file as the discussion (the agent's body already has `sparring_deep_dive` baked in — actually, re-read §1.9: the sparring prompt is materially different from the round prompt). So we either (i) generate a sister agent file `<slug>-sparring.md` per member, or (ii) keep sparring as a direct LLM call (Mode A internals) even in Mode B. We pick **(ii)** — sparring is a private 1:1, the orchestration value of a sub-agent isn't there, and a direct call gives smoother streaming to the TTY.
- **DecisionCoach + PrincipleExplorer.** Direct LLM calls in both modes. We do generate a `.claude/agents/aab-decision-coach.md` so the user can also invoke the coach via "ask the decision-coach to help me with X" inside Claude Code.

### 2.8 Action Board → Claude Code skills

This is where the Claude Code-native angle pays off most.

#### 2.8.1 Pipeline mapping

| Sage Council piece | aabclitool implementation |
|---|---|
| `actionClassifier` | direct LLM call (Mode A) |
| `taskOrchestratorAgent.decompose` | direct LLM call |
| `agentMakerAgent` | direct LLM call returning `DynamicAgentSpec[]` |
| dynamic agents | **In Mode A:** in-process `dynamicAgentExecutor` calls. **In Mode B:** for each `DynamicAgentSpec` we materialize a *transient* sub-agent file under `.claude/agents/.aab-tmp-<id>.md`, dispatch via the delegation tool, then delete after the run. This gives the dynamic agent the full Claude Code tool surface (web search, file read) which directly improves research-heavy tasks. |
| pre-built agents (web-research, market, financial, …) | port as direct LLM functions in Mode A; *can* also be persistent sub-agent files (`.claude/agents/aab-web-research.md`, …) in Mode B. We default to direct calls for speed, with `--use-agents` to upgrade. |
| `parallelExecutionEngine` | port verbatim; uses `Promise.allSettled` over execution groups |
| `smartSynthesizerAgent` | direct LLM call |
| `solutionValidator` | direct LLM call |
| `taskClassifierAgent` | direct LLM call |
| `deepExecutionAgent` | direct LLM call(s) per phase |
| `skillBuilderAgent` (single-loop) | port verbatim — this loop already uses an internal "tool" abstraction (`list_files`/`read_file`/`create_file`/`update_file`/`write_file`/`rename_file`/`delete_file`) over a virtual workspace. Map those to **real** filesystem ops in a tempdir, then commit the package to `.claude/skills/<name>/` on success. |
| `skillCompositionAnalyzer` | port verbatim (deterministic) |
| `skillCompositionOverrideAgent` + `composition_critic` | direct LLM calls behind the same feature flag |
| `solutionPackagerService` | port verbatim, with one new layout mode: `claude-code-direct` (skip ZIP; install directly into `.claude/skills/<name>/`) |
| security review, trigger evaluator, master-prompter potency, repair pass, skill-package critic | direct LLM calls; preserve all hard gates and rubric scoring |

#### 2.8.2 SKILL.md emitted by the CLI

The current `ClaudeCodeAdapter.adapt` is identity. We make it real:

- Validate frontmatter has `name`, `description` (must include "Use when …"), and Claude-Code-required fields.
- Drop or rename non-Claude-Code fields if any (`safety_mode` stays informational; `tools` array intersected against Claude Code's known toolset).
- Ensure scripts/references are inside the skill directory and referenced by relative path.
- If `solveMode === 'skill'` and `--install`, copy the package to `.claude/skills/<name>/` and print "Skill installed; restart Claude Code or run `/agents` to refresh."

#### 2.8.3 Two install paths

- `aab actions deep-execute <id> --as=skill --install` → writes directly into the user's project `.claude/skills/`.
- `aab actions deep-execute <id> --as=skill --zip` → produces a ZIP under `~/.aabcli/<workspace>/runs/<run-id>.zip` for sharing.

### 2.9 Storage (filesystem)

`FsStorageService implements StorageService`. Layout:

```
~/.aabcli/<workspace-id>/
├── settings.json
├── members.json                    AdvisoryBoardMember[]
├── boards.json
├── prompts.json                    user-overridden templates
├── business-profile.json
├── business-context.json           BusinessContext[]
├── principles.json
├── decision-sessions/<id>.json
├── discussions/<id>.json           Discussion (rounds inline)
├── action-items.json
├── research-history/<actionItemId>/<id>.json
├── generated-runs/<actionItemId>/<runId>.json
├── sparring/<discussionId>/<sessionId>.json
├── token-usage/YYYY-MM-DD.jsonl    one log per line
└── jobs/<jobId>.json               KickoffJob/DiscussionOperationJob/SkillGenerationJob
```

Workspace ID is `slugify(cwd-basename)` or `--workspace` override. Discussions are stored as full Discussion objects with rounds inline (no rehydration ambiguity, but we keep the rehydration code as defense). Pagination uses `loadDiscussionPage` returning a sliced `discussions[] + totalCount + hasMore`. Lock files prevent concurrent writes (use `proper-lockfile`).

The file `.aabcli/` mirror at the project level is supported for users who want the workspace to live with the repo.

### 2.10 Job runner (replacing edge functions)

In-process: a `JobRunner` class reads job records, marks them `running`, executes the corresponding flow (`startDiscussionKickoff` / `continueRound` / `followUp` / `respond` / `solveSkill`), writes status + heartbeat, persists the result. The CLI streams progress to the TTY directly while the job runs. Jobs are still persisted so the user can `aab discuss show <id>` later and see status. We keep:

- Per-workspace parallel cap (default 1, overridable; mainly to avoid hammering the Anthropic rate limit).
- Stale-job watchdog (any job in `running` for >15 min on next CLI invocation is force-failed).
- Retry on 429/503 with exponential backoff (1s, 2s, 4s; cap 3 retries).

### 2.11 CLI surface (commands)

```
aab init                                  bootstrap workspace, write starter members + principles, create .claude/agents/
aab settings get|set <key> [value]        anthropic api key, models, business profile
aab settings business-profile             interactive profile setup (drives BusinessProfile → BusinessContext seeding)

aab members list
aab members add                           interactive (name, title, expertise, persona OR --enhance)
aab members edit <id|name>
aab members enhance <id> [--type famous|expert|non-famous]   runs ai-enhancer to fill persona+voiceGuide
aab members delete <id>
aab members sync-agents                   regenerate .claude/agents/<slug>.md for all members

aab principles list
aab principles add                        interactive
aab principles seed-starters
aab principles explore                    Socratic wizard (5 steps)
aab principles delete <id>

aab coach                                 REPL with the Decision Coach (streamed)
aab coach show <session>

aab discuss start "<question>" [--members ...] [--max-turns 5] [--mode auto|direct|cc]
aab discuss list
aab discuss show <id> [--round N]
aab discuss continue <id>
aab discuss follow-up <id> "<question>" [--all|--member <name>|--members a,b,c]
aab discuss respond <id> "<answer>" [--option <i>]   answer pendingUserRequest
aab discuss spar <id> --member <name> [--round N --turn M]
aab discuss inject <id> --from <sparring-session>
aab discuss summarize <id>
aab discuss export <id> [--md|--pdf] [--out path]
aab discuss delete|archive|unarchive <id>

aab actions extract <discussion-id>       runs ConversationAnalyzer, persists ActionItems
aab actions list [--status pending|in-progress|completed]
aab actions show <id>
aab actions solve <id>                    Phase 1 (multi-agent solve)
aab actions deep-execute <id> --as artifacts|skill [--platform claude-code|claude-cowork|openclaw]
                                          [--install|--zip] [--skill-name <name>] [--composition auto|standalone|merged|chain]
aab actions plan-edit <id> --field nextSteps|implementationPlan [--prompt "..."]

aab usage [--since YYYY-MM-DD] [--by feature|model|day]
aab prompts list
aab prompts edit <key>                    overrides default-prompts entry; validated by validateAdminPromptTemplate

aab ff list|enable|disable <flag>         feature flags
```

Global flags: `--workspace`, `--mode`, `--model <claude-sonnet-4-5|...>`, `--no-cache`, `--json` (machine-readable output), `--verbose`.

Exit codes: 0 success, 1 user error, 2 model/network error, 3 contract violation (JSON couldn't parse after all retries), 4 cancelled.

### 2.12 What changes vs. the source — a delta table

| Concern | Source (sage-council) | aabclitool |
|---|---|---|
| LLM provider | Google Gemini | Anthropic Claude (Opus/Sonnet/Haiku) |
| Model selection | `geminiModel` enum | Same shape — `primaryModel: claude-sonnet-4-5`, `fastModel: claude-haiku-4-5-20251001`, `researchModel: claude-opus-4-7` |
| Web search | Gemini `google_search` tool | Anthropic `web_search_20250305`; in Mode B, sub-agents inherit `WebSearch` tool |
| Persistence | Supabase (cloud) / localStorage (demo) | Filesystem JSON (single mode); `cloud` storageType is removed |
| Edge functions | 5+ Deno functions | In-process `JobRunner` |
| Auth | Supabase JWT | None (filesystem); Anthropic API key from settings/env |
| Streaming | SSE | Anthropic SDK streaming → TTY |
| UI | React | TTY (tables, progress, markdown); machine-readable `--json` |
| Members as agents | conceptual only | real `.claude/agents/<slug>.md` files (Mode B) |
| Skill platforms | abstraction in place; adapters near-identity | `claude-code-adapter` becomes substantive (validate, slim, install) |
| Prompts | unchanged | unchanged |
| Schemas (zod) | unchanged | unchanged |
| Reliability machinery | tolerant JSON, MAX_TOKENS detection, transient-failure handling | unchanged |
| Token logging | unchanged | unchanged (writes to `token-usage/YYYY-MM-DD.jsonl`) |
| Feature flags | runtime flags | runtime flags + CLI overrides |
| Prompt-hardening guardrail | mandatory pass through master-gpt-prompter | inherited; `aab prompts edit` validates required placeholders + fragments |

### 2.13 Bonus features that fall out of going Claude Code-native

These are not required by the user but are worth listing because they're cheap given the architecture:

1. `.claude/commands/aab.md` slash command auto-generated by `aab init` — lets the user run `/aab discuss start "..."` directly from inside Claude Code. The command body just shells out to `aab` with the args. (See Claude Code "slash commands" feature.)
2. `.claude/agents/aab-orchestrator.md` — a dispatcher sub-agent the user can talk to in natural language ("run a discussion on whether we should pivot"), which calls into the `aab` CLI under the hood. Optional; gated by `aab init --with-orchestrator-agent`.
3. Discussions whose answers reference files in the user's repo: because Mode B sub-agents have `Read/Grep/Glob`, a member can be asked "look at our `pricing.ts` and tell me what's wrong" and actually do it. Source app cannot do this.
4. Skill packages can include `references/` pulled live from the user's repo (`Read`-grounded), making generated skills genuinely tailored.

### 2.14 Risks and mitigations

- **Claude Code agent description routing collisions.** If the user has many board members, descriptions like "Use when discussing strategy" all collide. Mitigation: include the literal "Use when {{member_name}}" trigger phrase verbatim and have `aab discuss` always invoke by `subagent_type: <slug>` (not by description-routing).
- **Body templating happens at agent-generation time, not invocation time.** This means changing a member's persona requires `aab members sync-agents` to take effect. Mitigation: do that automatically on every `members add|edit|enhance|delete` — and also at the top of every `aab discuss start` (cheap; idempotent).
- **Tool surface for board members.** If we give them `Edit`/`Write`/`Bash` they can mutate the user's project. Mitigation: agent files default to `tools: WebSearch, WebFetch, Read, Grep, Glob`. Add `--allow-write` only for trusted use cases.
- **Prompt drift across modes.** The same `board_member_response` template feeds both the direct-call body in Mode A and the agent-file body in Mode B. We render from one source of truth (`default-prompts.ts`) every time so they cannot drift.
- **Cost.** Claude Sonnet 4.5 is meaningfully more expensive than Gemini Flash. Mitigation: prompt caching on the per-member system prompt across rounds; default `fastModel` for the orchestrator and summary; per-workspace monthly budget warning ported from `UsageBudgetSettings`.
- **Skill quality.** The single-loop authoring loop is the most fragile piece of the source app. Mitigation: keep the critique → repair → potency-pass → security-review → trigger-eval pipeline intact; do not weaken any hard gate; add a "dry-run preview" before installing into `.claude/skills/`.
- **Filesystem race conditions.** A user could run two `aab` commands concurrently. Mitigation: per-file locks via `proper-lockfile`; per-workspace global lock for kickoffs.

### 2.15 Implementation phasing

A reasonable build order, each phase shippable on its own.

**Phase 0 — Skeleton.** package.json, commander setup, `aab init`, `FsStorageService`, settings get/set, mode detection, Anthropic SDK client, Mode A only, no agents.

**Phase 1 — Discussions.** Port `default-prompts.ts`, `parsing/safe-json.ts`, `parsing/llm-response-schemas.ts`, `network/retry-fetch.ts` (HTTP fetch wrapper around the SDK), `claude-direct.ts`, `business-context-agent.ts`, `enhanced-analyzer.ts`, `orchestrator.ts`, `conversation-flow.ts`. Implement `aab discuss start|continue|follow-up|respond|show|summarize|export`. Token logging on. Starter members seeded. **Outcome: real multi-turn discussions with Claude.**

**Phase 2 — Members + Principles + Coach.** `members add|edit|enhance|delete|sync-agents`, `ai-enhancer.ts`, `voice-guide.ts`. Generate `.claude/agents/<slug>.md` files (Mode B prep, but discussions still run in Mode A). `principles add|edit|seed-starters|explore`, `coach` REPL. **Outcome: full roster + principles tooling + decision coach.**

**Phase 3 — Sparring.** `sparring-service.ts` + `aab discuss spar|inject`. **Outcome: 1:1 deep dives.**

**Phase 4 — Action Board Phase 1.** `action-classifier.ts`, `solution-validator.ts`, all pre-built agents (web-research, market-analysis, financial-analysis, strategy-planning, content-strategy, risk-assessment), `task-orchestrator-agent.ts`, `agent-maker-agent.ts`, `parallel-execution-engine.ts`, `smart-synthesizer-agent.ts`, `dynamic-agent-executor.ts`. Action item CRUD + `aab actions extract|solve`. **Outcome: action items get multi-agent solutions.**

**Phase 5 — Action Board Phase 2 (deliverables).** `task-classifier-agent.ts`, `deep-execution-agent.ts`, `solution-packager-service.ts`. `aab actions deep-execute --as artifacts`. **Outcome: artifact deliverables.**

**Phase 6 — Skills.** `skill-builder-agent.ts` + every skill prompt + composition analyzer + composition override + master-prompter potency pass + security review + trigger evaluator + skill package critic + repair pass. Real `ClaudeCodeAdapter`. `aab actions deep-execute --as skill --install`. **Outcome: the killer feature — generate Claude Code skills from advisory board discussions.**

**Phase 7 — Mode B and polish.** Wire delegation tool, switch discussions to sub-agent dispatch when `--mode=cc`. `.claude/commands/aab.md` slash command. `aab init --with-orchestrator-agent`. Per-workspace budget warnings. **Outcome: native Claude Code experience.**

**Phase 8 — Hardening.** Test parity against the source for the same input on a fixture set of questions. Add `--json` output. Document.

### 2.16 What's intentionally out of scope (not ported)

- All React UI (`src/pages`, `src/components`).
- Supabase auth, admin pages, edge functions for admin (`admin-prompts`, `admin-stats`, `admin-user-detail`, `admin-user-manage`, `admin-users`, `auth-email-hook`, `delete-account`).
- Lovable.dev integration (`lovable-tagger`).
- The Playwright e2e suite (replaced by a fresh CLI fixture suite in Phase 8).
- The `claude-cowork` and `openclaw` adapters can stay but `claude-code` is the only one we put real work into.
- PDF export via `jspdf`/`recharts` ⇒ replace with a simple `marked`-rendered HTML → `puppeteer-pdf` if anyone ever asks; markdown export is enough for v1.

### 2.17 The single thing that could derail this

The single-loop skill builder. Every other piece is "swap Gemini for Claude and reuse." The skill builder uses an internal tool-turn loop with strict hard-gates that were tuned against Gemini's specific behaviors. Claude is generally better at instruction-following, so the gates *should* still pass, but the ergonomics of "10-15 LLM round-trips per skill" mean cost and latency are real. Mitigation: cache the system prompt on every loop turn (`cache_control`); allow `--single-loop-max-turns` to cap; preserve repair-pass + critic gates.

---

## Part 3 — TL;DR

- The source app is a multi-agent advisory-board engine with a deep skill-generation pipeline. Its abstraction layers (`StorageService`, `PlatformAdapter`, prompt resolver) already anticipate non-browser, non-Gemini hosts.
- The CLI port keeps every piece of business logic intact and replaces three things: **(a)** Gemini → Anthropic Claude, **(b)** Supabase + edge functions → filesystem + in-process job runner, **(c)** React UI → commander/enquirer/ora TTY (with optional `.claude/commands/aab.md` so the user can also trigger it from inside Claude Code).
- Board members are realized as **Claude Code sub-agents** (`.claude/agents/<slug>.md`), one per member, body = the existing member-response system prompt with placeholders pre-filled, tools = read/web only by default. The CLI dispatches each round through a delegation tool so per-member calls retain orchestration discipline.
- Action-board outputs are realized as **Claude Code skills** (`.claude/skills/<name>/SKILL.md`) generated by porting `skill-builder-agent` and the 14 skill-generation prompts verbatim. The previously-empty `ClaudeCodeAdapter` becomes the install target.
- Discussion engine, orchestrator, business context extraction, persona enhancement, sparring, principles, decision coach all port one-for-one. Tolerant JSON parsing, retry/backoff, token logging, feature flags, and the prompt-hardening guardrail all stay.
- Recommended phasing: skeleton → discussions → members/principles/coach → sparring → action solve → deliverables → skills → Mode B → hardening. Each phase is shippable.

---

# Part 4 — Extreme review addendum (gaps, corrections, and details)

This part is a self-audit of Parts 1-3 after re-reading the source and verifying Claude Code's actual skill/agent contracts. It supersedes anything earlier that conflicts with it.

## 4.1 Material correction — Claude Code skill/agent frontmatter is **not** what the source app produces

I verified Claude Code's current skill and sub-agent file format against the official docs. The source app's `SKILL.md` carries a sage-council-invented frontmatter (`trigger_queries`, `dependencies`, `tools`, `file_types`, `safety_mode`, `estimated_tokens`, `estimated_time_minutes`, `examples`, `notes`). Claude Code itself ignores most of those keys. The CLI's `ClaudeCodeAdapter` must rewrite the frontmatter to Claude Code's actual contract.

**Authoritative SKILL.md frontmatter (Claude Code, current):** `name` (lowercase, hyphens, ≤64), `description` (used for automatic-invocation routing; combined with `when_to_use` capped at 1,536 chars), `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools` (allowlist), `model` (`sonnet`/`opus`/`haiku`/full id/`inherit`), `effort` (`low|medium|high|xhigh|max`), `context: fork`, `agent` (when forked), `hooks`, `paths` (glob activation gate), `shell` (`bash`|`powershell`).

**Authoritative sub-agent frontmatter (`.claude/agents/<name>.md`, current):** `name`, `description` (required, drives routing), `tools` (allowlist), `disallowedTools`, `model`, `permissionMode` (`default|acceptEdits|auto|dontAsk|bypassPermissions|plan`), `maxTurns`, `skills` (preloaded by name), `mcpServers`, `hooks` (PreToolUse/PostToolUse/Stop/SubagentStart/SubagentStop), `memory` (`user|project|local`), `background`, `effort`, `isolation: worktree`, `color`, `initialPrompt`. Body markdown becomes the agent's system prompt verbatim. The agent does **not** inherit Claude Code's full system prompt — only the body + a basic environment.

**Other facts from the verification:**

- **Task → Agent rename.** The Task tool was renamed to **Agent** in v2.1.63 (Task is kept as an alias). Plan references to "Task tool" should read "Agent tool". `subagent_type` is still the field name when programmatically dispatching.
- **Slash commands and skills are merged.** `.claude/commands/<x>.md` works as an alias of `.claude/skills/<x>/SKILL.md`. So the `.claude/commands/aab.md` shim mentioned in §2.13 should just be a project-level skill with `user-invocable: true`.
- **Agent SDK has no dynamic registration.** `@anthropic-ai/claude-agent-sdk` (Node) and `claude-agent-sdk` (Python) **cannot** create new agents at runtime; they dispatch to predefined ones from `.claude/agents/` or `~/.claude/agents/`. The escape hatch is the CLI's `--agents <json>` flag, which accepts agent definitions inline for the session only — the CLI can use this to inject transient dynamic agents (Phase-1 dynamic agents, transient skill-build helpers) without writing files to the user's repo.
- **Skill scopes (priority high → low):** Enterprise managed → Personal `~/.claude/skills/` → Project `.claude/skills/` → Plugin `<plugin>/skills/`.
- **Sub-agent scopes (priority high → low):** Managed → `--agents` CLI flag → Project `.claude/agents/` → User `~/.claude/agents/` → Plugin `agents/`.
- **Skill listing UX:** users can see and toggle skills with `/skills`; visibility persists in `.claude/settings.local.json`.
- **Body size guidance:** ≤500 lines for SKILL.md; everything else goes in `references/`, `scripts/`, `examples/`. Lazy-loaded — only counted against tokens when actually referenced.
- **Tool allowlist syntax:** comma-separated or YAML list (`tools: Read, Grep, Glob, Bash` or `tools: [Read, Grep, Glob]`). For the Agent tool itself, `Agent(worker, researcher)` restricts which sub-agent names the parent may dispatch.

### 4.1.1 Updated SKILL.md emission contract for `ClaudeCodeAdapter`

```yaml
---
name: <kebab-case-skill-name>
description: Use when <task trigger language>. <One-line purpose.>
when_to_use: |
  <Multi-line trigger context: which queries/situations should invoke this.>
allowed-tools: WebSearch, WebFetch, Read, Grep, Glob, Bash    # tightened per security review
model: inherit                                                 # default; override only if needed
---

# <Skill body — execution system prompt>
```

The CLI takes the source app's existing fields and maps them like so:

| Source field | Claude Code destination |
|---|---|
| `name` | `name` (slugified) |
| `description` | first sentence of `description` (must include "Use when …") |
| `trigger_queries[]` | folded into `when_to_use:` as a markdown bulleted list (NOT a frontmatter array — Claude Code doesn't read it) |
| `tools[]` | `allowed-tools` (intersected with Claude Code's known toolset) |
| `safety_mode: strict` | `permissionMode` is *agent-level*, not skill-level; for skills the strict mode just means tighter `allowed-tools` |
| `dependencies[]`, `file_types[]`, `estimated_tokens`, `estimated_time_minutes`, `examples[]`, `notes` | moved into the skill body (body has its own "Dependencies", "Examples", "Notes" sections) |

The adapter validates this output against the actual Claude Code spec and prints a human-readable diff before installing.

### 4.1.2 Updated sub-agent emission contract for board members

The `.claude/agents/<member-slug>.md` file the CLI generates:

```yaml
---
name: <member-slug>
description: Use when <member name>'s perspective is needed in an advisory board discussion or for first-principles input on <his/her domain>. The user references this member by name when running an advisory board.
tools: WebSearch, WebFetch, Read, Grep, Glob
model: sonnet
permissionMode: default
maxTurns: 5
color: <picked from a palette by member-type: famous=amber, expert=blue, non-famous=emerald>
---

# IDENTITY & ROLE
You are <member.name>, <member.title>. You are participating in a high-stakes advisory board discussion.

## YOUR EXPERTISE
<expertise joined>

## YOUR VOICE & BEHAVIOR GUIDE
<user_voice_guide>
<voice_guide>
</user_voice_guide>

## YOUR PERSONA & APPROACH
<user_persona>
<persona>
</user_persona>

# AVAILABLE TOOLS
- WebSearch / WebFetch — for current info or to verify claims (always cite under "sources").
- Read / Grep / Glob — read files in the user's project when context is needed.

# RESPONSE PROTOCOL
You receive a user message that begins with one of:
- `[ROUND: 1 | INITIAL]` — first round, no prior responses.
- `[ROUND: N | MULTI_TURN | IS_FOLLOW_UP: true|false]` — subsequent rounds.
- `[FOLLOWUP_QUESTION]` — user asked a follow-up of a specific subset; same JSON contract.

…then the contract verbatim from Part 1.5 (`board_member_response`) with placeholders pre-filled and `{{#is_follow_up}}` blocks resolved at render time.

# OUTPUT
Return ONLY the raw JSON object specified — start with `{`, end with `}`, no fences.
```

### 4.1.3 How the CLI actually dispatches a sub-agent (Mode B)

Two viable paths, both implemented:

**(a) Inside Claude Code (recommended).** When the user runs `aab` from a session inside Claude Code, the CLI uses `@anthropic-ai/claude-agent-sdk`'s `query()` against an outer agent context that has the member sub-agents available (because we wrote them to `.claude/agents/`). The CLI's outer agent issues an `Agent` tool call (`subagent_type: <member-slug>`, `prompt: <pre-built user message>`) per member and aggregates results. Each sub-agent runs as an isolated context with its own system prompt — exactly what we want.

**(b) Outside Claude Code (still useful).** When `aab` is invoked from a plain shell, we fall back to direct `@anthropic-ai/sdk` calls per member, loading the same agent .md file content as the system prompt. This is functionally identical to Mode A but reads from the agent files (single source of truth).

**Always-write strategy.** Member agent files are regenerated on every `aab discuss start` (cheap, idempotent) so persona edits in `members.json` always propagate. The `aab members sync-agents` command is also exposed for explicit syncs.

**Dynamic agents (action-board Phase 1 dynamic team) without polluting `.claude/agents/`.** We use the CLI `--agents` flag's inline JSON form so transient dynamic agents exist only for the session; they're never written to the user's repo. Pseudocode:

```ts
const dynamicAgents = await agentMakerAgent.createAgentsForSubtasks(...)
const agentsJson = dynamicAgents.reduce((acc, a) => ({ ...acc, [a.slug]: { description, tools, model, prompt: a.systemPrompt } }), {})
spawnClaude({ agentsInline: agentsJson, prompt: ... })
```

## 4.2 Anthropic SDK / model specifics that should be pinned

| Concern | Decision |
|---|---|
| SDK package | `@anthropic-ai/sdk` (Node) for direct calls; `@anthropic-ai/claude-agent-sdk` for Mode B dispatch. |
| Default models | `primaryModel = claude-sonnet-4-5` (or `claude-sonnet-4-6` once stable), `fastModel = claude-haiku-4-5-20251001`, `researchModel = claude-opus-4-7`. Map `getModelInfo(model).tier` to `premium\|standard\|economy` so the existing premium-timeout logic (60s vs 20s) carries over. |
| Web search | Server tool `web_search_20250305`. Enable for member responses + sparring + skill_task_research. Disable for orchestrator + summary + business-context. |
| Prompt caching | Mark each member's IDENTITY/voice/persona system block `cache_control: { type: 'ephemeral' }`. Cache TTL is 5 min; rounds typically run inside that window. The skill_operating_model preamble is also a hot cache target. |
| `max_tokens` | 10000 across the board (matches source `maxOutputTokens`). |
| Stop reason | Use `stop_reason === 'max_tokens'` as the equivalent of Gemini's `finishReason: 'MAX_TOKENS'` in the BusinessContextAgent compact-mode retry. |
| Tool use loop | When the model returns `stop_reason: 'tool_use'`, run the tool and append a `tool_result` block; loop until `stop_reason: 'end_turn'`. |
| Token usage | Map Anthropic `usage.input_tokens` (+ `cache_creation_input_tokens` + `cache_read_input_tokens`) → `promptTokenCount`; `output_tokens` → `candidatesTokenCount`; total = sum. `thoughtsTokenCount` stays unused. |
| JSON contract | Two strategies: (1) keep the "raw JSON in `text`" contract from sage-council and run through the existing tolerant parser (compatible, zero migration); (2) optionally upgrade to a forced-tool-use JSON via `tool_choice: { type: 'tool', name: 'respond_with_json' }`. Phase 1 uses (1); the upgrade is a v2 opt-in. |
| Retries / timeouts | Same numbers as gemini.ts: 20s standard / 60s premium for member calls, 0 retries inside the call, 15s for orchestrator, 3 retries with exponential backoff (1s, 2s, 4s) at the network layer for transient 429/529. Anthropic uses 529 for overload — port `isGeminiTransientCapacityErrorMessage` to recognize 429 + 529 + "overloaded". |
| Pricing table | Replace `model-pricing.ts` defaults with Anthropic numbers: opus-4-7 `$15 / $75 per M tokens`, sonnet-4-5 `$3 / $15`, haiku-4-5 `$1 / $5`. Cache reads are 10% of input cost; the cost calc must subtract `cache_read_input_tokens * 0.9 * input_price`. |

## 4.3 Things the original plan under-specified or omitted

### 4.3.1 Human-in-the-loop (HITL) loop in the CLI

The orchestrator can return `action: 'request_user_input'` with a `userInputRequest{ type: clarification|decision|preference|information, question, context, requestingMembers[], urgency, options? }`. The CLI must:

- **Render** the request (urgency-coloured panel, list of requesting members, the context, the question).
- **Block** further round generation until the user responds (we already know about `discussion.pendingUserRequest` — the runtime guard).
- **Collect** the response: `aab discuss respond <id> "<answer>"` or, if `options[]` is present, `enquirer` multiple-choice.
- **Persist** as `UserResponse{ type: 'advisory_board_requested', selectedOption?, content }`.
- **Re-extract business context** from the user's reply (the source does this — it's an easy thing to miss).
- **Then run** a follow-up round with all active members responding in light of the user's reply.

Pre-round clarification gate: before each follow-up round, the orchestrator runs first; if it returns `request_user_input`, we surface the question instead of generating responses. This timing matters — it must happen *before* model calls, not after, or the CLI burns tokens unnecessarily.

### 4.3.2 User-customisable prompts (`UserPrompt`) and the prompt resolver

Every prompt template in the source can be overridden by the user. The resolver order is **user override → admin-published (cloud only, dropped in CLI) → default**, and the rendered template gets a `master_gpt_prompter_hardening_v1` block prepended automatically for the action-board prompts (`board_member_response`, `multi_turn_response`, `orchestrator_decision`, `conversation_summary`, `action_item_extraction`, `enhance_*`, `sparring_deep_dive`, plus everything starting with `skill_generation.`). The hardening block is a fixed 25-line preamble (`<reasoning_model_guidance>`, `<tool_use_description>`, `<autonomy_description>`, `<self_verification>`).

CLI mapping:

- `aab prompts list` shows defaults vs overrides + `runtimeSource` (`user|default`).
- `aab prompts edit <key>` opens `$EDITOR` on the template; on save, runs `validateAdminPromptTemplate` against `requiredVariables` + `requiredFragments` and refuses to save invalid templates (prevents silent contract breakage).
- `aab prompts reset <key>` and `aab prompts reset-all` delete overrides.
- The `applyMasterPrompterHardening(key, template)` function is ported verbatim and wraps every render.
- The Mustache-style conditionals (`{{#var}}…{{/var}}`, `{{^var}}…{{/var}}`) and the bare `{{var}}` substitution are ported verbatim from `prompt-resolver.renderPrompt`.

### 4.3.3 Skill preflight + agent environment profile

I glossed over this — it's a real, mandatory step in the source's `--as=skill` flow.

**`skill-preflight.ts`** scans the action item's next-step text for capability requirements via regex `CAPABILITY_PATTERNS` (browser, API, MCP, shell, filesystem, git, cloud, third-party SaaS) and `CAPABILITY_SIGNALS` (Playwright, HubSpot, Stripe, Slack, Notion, Jira, n8n, Zapier, …). Each requirement gets a `category`, `rationale`, `inferredTools[]`, and a `fallbackSummary` describing what the skill should do if the capability is unavailable.

**`skill-preflight-chat-agent.ts`** then runs an interactive wizard that asks the user to confirm which capabilities are actually available. The user's answers form a `SkillCapabilityProfile { microSteps[], requiredCapabilities[], confirmedAvailableCapabilityIds[], unavailableCapabilityIds[], fallbackPlans[{capabilityId, mode: artifact-draft|manual-handoff|ask-user-choice, preferredOutputFormat, instruction}] }`.

**`agent-environment-profile.ts`** parses `BusinessProfile` (specifically the encoded `__agent_environment_profile_v1__` blob in `targetMarket` field) into `AgentEnvironmentProfile { accessItems[], existingSkills[{name,description}], automationPermissions{ coworkSchedule, openclawCron, openclawHeartbeat ∈ allow|ask|deny }, notes }`. From this it infers `mcpServers[]`, `cliTools[]`, `envVariables[]` for skill-builder's "confirmed capabilities" context.

CLI mapping:

- `aab actions deep-execute <id> --as skill` runs an interactive preflight wizard *first* (`enquirer` prompts) to confirm available capabilities, install paths, and fallback modes for unavailable ones. Skip with `--no-preflight` (uses inferred-only profile). 
- The CLI auto-detects environment: scans `~/.claude/skills/` for installed skills, scans `~/.claude/mcp.json` for MCP servers, runs `which <tool>` for CLI tools (git, gh, npm, docker, …), reads `process.env` for env vars; presents detected items as pre-checked in the wizard.
- Confirmed profile is persisted in `~/.aabcli/<workspace>/business-profile.json` so subsequent runs auto-load it.

### 4.3.4 Action solve modes — `artifacts` vs `skill`

Two end-to-end flows the plan only briefly mentioned:

- **`--as artifacts`** runs Phase 1 (solve) → Phase 2 deep-execution → packaging into a folder of files (`00-executive-summary.md`, …, `04-draft-system-prompt/prompt.md`, …) with optional ZIP. No `.claude/skills/` install.
- **`--as skill`** runs Phase 1 → preflight wizard → Phase 2 with skill deliverables → composition analysis (standalone/merged/chain/mixed) → composition critic → composition override (if flag enabled) → for each skill task, the single-loop skill builder runs (planner → tool turns → critic → repair → master-prompter potency pass → security review → trigger evaluator) → `ClaudeCodeAdapter.adapt` → install or ZIP.

The CLI also supports **`--as both`** (artifacts + skill in one run, common when the user wants the working files plus the installable skill).

### 4.3.5 Plan editing

`plan-edit-service.ts` lets the user rewrite either a single `nextSteps[i]` entry or the entire `implementationPlan` markdown via a chat turn:

```
aab actions plan-edit <id> --field nextSteps --index 2 "Make this more concrete; add a budget line."
aab actions plan-edit <id> --field implementationPlan "Add a 30-day rollout timeline."
```

The prompt is `buildEditPrompt(target, userInstruction, solution, researchFindings)` returning `{ revisedContent: string }`. Each edit appends to `solution.planEditHistory[{ editedAt, editType, fieldEdited, userInstruction }]`.

### 4.3.6 Research history and generated runs are persistent records

These are not transient — they are first-class storage entities that drive UX:

- **`ActionResearchHistory{ type: 'research'|'solve', title, content, sources, metadata{ solveMode, skillTargetPlatform, generationRunId, sourceSolveHistoryId, confidence, qualityScore, agentsUsed, executionTime, contextSummary } }`** — every research/solve run is appended; the user can re-open any past attempt.
- **`GeneratedRunRecord{ generationRunId, actionItemId, discussionId?, title, solveMode, skillTargetPlatform, status, files[], metadata{ solutionId, packageId, confidence, qualityScore, agentsUsed, executionTime, totalTasks, completedTasks, failedTasks, skippedTasks, confirmedCapabilityProfile, agentEnvironment } }`** — full per-run artifact bundle.

CLI mapping: `aab actions runs <action-id>`, `aab actions runs show <run-id>`, `aab actions runs export <run-id> [--out path]`. Storage layout under `~/.aabcli/<workspace>/research-history/<actionItemId>/` and `~/.aabcli/<workspace>/generated-runs/<actionItemId>/<runId>.json` (file blobs in `<runId>/files/`).

### 4.3.7 Async-job capacity and watchdog (ported even though we're in-process)

Constants from `_shared/discussion-async-capacity.ts`: `MAX_PARALLEL_DISCUSSION_JOBS_PER_USER = 3`, `DEFAULT_MAX_PARALLEL_DISCUSSION_JOBS_GLOBAL = 150`, `DEFAULT_DISCUSSION_ASYNC_STALE_RUNNING_TIMEOUT_MS = 15 * 60_000`, `STALE_WATCHDOG_ERROR_MESSAGE = "Marked failed by stale async watchdog (heartbeat timeout)."`

CLI mapping:

- Per-CLI-invocation parallelism cap (`AAB_MAX_PARALLEL_JOBS`, default 3) governs how many member-response calls fire concurrently. Discussions with >5 members will batch — this matches sage-council and avoids Anthropic 429s.
- Stale-job watchdog runs at the start of every `aab` invocation: any job whose `heartbeatAt` is older than 15 min and is in `running` is force-failed with that exact error message. This recovers from a previous CLI being killed mid-run.
- Heartbeat is written every 5s while a job is running.

### 4.3.8 Narrative-events stream (progress UX)

Both `KickoffNarrativeEvent` and `DiscussionOperationNarrativeEvent` are sequenced rows the source uses to render a humanised progress feed ("Now asking Elon Musk to weigh in…"). We must port the *idea* even though the table goes away.

- The `JobRunner` emits an event stream (`{ jobId, sequence, stage, memberName?, messageKey, messageParams }`) into an in-memory channel.
- `aab discuss start ...` subscribes and renders the stream to TTY via `ora`/`chalk` in real time.
- The events are also persisted to `~/.aabcli/<workspace>/jobs/<jobId>.events.jsonl` so `aab discuss show <id>` can later reconstruct what happened (handy for debugging stuck runs).
- `messageKey` strings are looked up in a CLI-side i18n table (locale defaults to `en`, comes from `--locale` or settings). The source's `locale` payload field in `StartDiscussion*Payload` is preserved.

### 4.3.9 Discussion attention + tab leader (skip)

`discussion-attention-signal.ts` and `tab-leader.ts` exist to coordinate multiple browser tabs of the same app. CLI does not need them. Document the omission.

### 4.3.10 Cancellation, resume, and idempotency

- **`AbortSignal` is already wired** through `gemini.generateOrchestratorDecision(context, signal)` and sparring (`options.signal`). Port it. CLI maps `Ctrl+C` → `controller.abort()` on the in-flight job; the job record gets `status: 'cancelled'`, `errorMessage: 'cancelled by user'`.
- **`idempotencyKey`** is part of every `Start*Payload` — used in cloud mode to dedupe job creation. CLI honours it: if a job with the same `idempotencyKey` already exists, returns the existing `jobId` instead of creating a new one. Prevents accidental duplicate runs from `aab` retries.
- **Resume after crash**: on next CLI start, surface "Job <id> was running when interrupted; mark as failed?" prompt for jobs in `running` state that the watchdog didn't already kill. `aab jobs list` and `aab jobs cancel <id>` are exposed.

### 4.3.11 Discussion input limits and settings bounds

`discussion-input-limits.ts` and `settings-bounds.ts` enforce `maxTurnsPerDiscussion ∈ [2, 50]`, `maxMembersPerDiscussion ∈ [1, 10]`, `consensusThreshold ∈ [0, 100]`, question length cap ~5000 chars, follow-up question cap, etc. Port verbatim. CLI rejects out-of-bounds values at flag parse time with friendly errors.

### 4.3.12 Voice guide regeneration triggers

`VoiceGuideService` is called when (a) creating a new member without a voiceGuide, (b) explicit `aab members enhance <id>`, (c) member.expertise changes (the field is part of the cache key). The CLI surfaces `aab members regenerate-voice <id>` and a `--auto` mode that regenerates whenever expertise is edited. The fallback (`fallback-voice-guides.ts`) carries hardcoded guides keyed by member name (Elon, Reid, Sara, Mark, Naval, Peter, etc. — fuzzy-matched on first name) so first-load before any LLM call still works.

### 4.3.13 Persona enhancement variants

Three templates pick by `memberType ∈ famous|expert|non-famous`:

- `enhance_famous_person` — assumes wide public recognition; emphasises stature + leadership philosophy + "in-the-room" board behavior.
- `enhance_top_expert` — top-1% specialist; emphasises technical mastery, innovation leadership, problem-solving methodology.
- `enhance_non_famous` — solid-professional; emphasises practical experience, collaborative style, methodical approach.

`aab members add` prompts for type; `aab members enhance <id> --type <t>` overrides. Output is `{ persona, voiceGuide }` — both saved.

### 4.3.14 Conversation analyzer's structured-vs-unstructured fallback

`ConversationAnalyzer.extractActionItems(discussion)` first walks `discussion.responses` and, for any with `structuredData`, calls `enhancedAnalyzer.extractActionItemsFromStructured` to derive `EnhancedActionItem[]` from `keyPoints | questionsForOthers | actionSteps`. **Only if no structured data exists** does it fall back to a single LLM call against the full transcript. This dual-path matters for cost — most discussions have structured data and won't trigger the expensive fallback. Port both paths.

### 4.3.15 Sparring service truncation budgets

Hard caps to preserve: `MAX_DISCUSSION_CONTEXT_CHARS = 14_000`, `MAX_SPARRING_HISTORY_CHARS = 8_000`, `MAX_BUSINESS_CONTEXT_CHARS = 4_000`, `MAX_ANCHOR_RESPONSE_CHARS = 4_000`, `TRUNCATION_MARKER_OVERHEAD = 120`. Truncation is deterministic head/tail with a marker — the user sees `[…trimmed N chars…]`. Port verbatim. Also: sparring uses `researchModel` (Opus) with web-search grounding by default and falls back to `primaryModel` on failure.

### 4.3.16 Data isolation between BusinessContext and BusinessProfile

The source maintains two distinct entities:

- **`BusinessContext`** (auto-extracted, growing collection) — many records, each with a confidence score, `category`, `extractedFrom`. Built incrementally from every user message.
- **`BusinessProfile`** (one record, user-managed) — the canonical company profile with `companyName, industry, companySize, stage, products[], targetMarket, topGoals[], blockers[], tools[], customTools, completedAt`.

`BusinessContext` is **derived in part** from `BusinessProfile` via `BusinessContextAgent.extractFromProfile(profile)` (deterministic — pushes one context per profile field). This runs at profile-save time, not at extraction time. The CLI's `aab settings business-profile` triggers this re-derive on save.

### 4.3.17 Context summarisation before agent execution

`ContextSummarizerService.summarizeForAction(actionItem, sourceDiscussion, businessContexts, existingSolution?)` produces three short summaries (`discussionSummary` ~100-150 words, `businessSummary` ~100-150 words, `taskSummary` ~50-100 words) plus a combined `fullContextPrompt` and a `tokenEstimate`. These summaries are **injected into dynamic-agent system prompts** so dynamic agents don't burn context window on raw discussions. Port verbatim — without it, dynamic-agent prompts blow past sane sizes.

### 4.3.18 Telemetry beyond token usage

`board-members-telemetry.ts` and `discussions-telemetry.ts` capture aggregate counters (member-response failure rates, follow-up failure modes, JSON-parse-fallback rates, orchestrator-decision distributions, …). Each is a thin module that writes structured events. Port them but redirect output to:

- `~/.aabcli/<workspace>/telemetry/YYYY-MM-DD.jsonl` (default).
- Or stdout when `AAB_TELEMETRY=stdout` (handy for debugging).
- Or off when `AAB_TELEMETRY=off` (privacy mode).

`aab telemetry tail` and `aab telemetry summary` round it out.

### 4.3.19 Feature flags — concrete names and CLI-side defaults

The source ships **17 feature flags**. The plan needs to be explicit about CLI defaults:

| Flag | Source default | CLI default | CLI flag |
|---|---|---|---|
| `discussions_async_board_start_panel_v1` | on | n/a (UI-only) | — |
| `discussions_async_kickoff_backend_v1` | on | always on (only mode) | — |
| `discussions_async_continue_backend_v1` | on | always on | — |
| `discussions_async_followup_backend_v1` | on | always on | — |
| `action_board_v3_ui_v1` | on | n/a (UI-only) | — |
| `skill_generation_admin_prompts_admin_ui_v1` | on | off (no admin) | — |
| `skill_generation_admin_prompts_runtime_v1` | on | off (no admin) | — |
| `skill_generation_composition_llm_override_v1` | off | off | `--composition-override` |
| `skill_generation_llm_control_plane_v1` | off | **on** (Claude is good enough) | `--no-llm-control-plane` |
| `skill_generation_single_loop_v1` | on | on | — |
| `skill_generation_single_loop_tool_authoring_v1` | on | on | — |
| `skill_generation_single_loop_async_runtime_v1` | off | off | — |
| `skill_generation_atomic_composition_v1` | off | off | `--atomic-composition` |
| `skill_generation_web_grounding_v1` | off | **on** (we have web_search_20250305) | `--no-web-grounding` |
| `skill_generation_reflexion_v1` | off | off | `--reflexion` |
| `skill_generation_critique_panel_v1` | off | off | `--critique-panel` |
| `skill_generation_skill_aware_decomposition_v1` | on | on | — |

`aab ff list|enable|disable <flag>` exposes the runtime overrides.

### 4.3.20 Master-GPT-prompter is mandatory and **automated** in the resolver

I described this as "mandatory pass before saving custom prompts" — that's wrong. The resolver applies hardening **at render time** (every call) for keys in `ACTION_BOARD_PROMPT_KEYS` and any key starting with `skill_generation.`. The user does not run a separate hardening step; the resolver wraps the template before substitution. The CLI ports `applyMasterPrompterHardening(key, template)` verbatim and the wrapper executes inside `getRenderedPrompt`. The marker `<master_gpt_prompter_hardening_v1>` makes the wrap idempotent — wrapping twice is a no-op.

This means `aab prompts edit` only validates structure (placeholders + required fragments); the hardening is invisible at edit time and applied at runtime. Document this clearly so the user does not duplicate the block.

## 4.4 Filesystem-storage details the plan glossed

### 4.4.1 Concurrency model

- One per-workspace lock file at `~/.aabcli/<workspace>/.lock` with `proper-lockfile`. Held for the whole CLI command. Prevents two `aab` invocations from corrupting the same JSON store.
- Per-entity write-through: every mutation reads the entity, mutates in memory, writes the whole file atomically (write to `.tmp` → `rename`).
- Token-usage logs are append-only JSONL, no lock needed (atomic append).
- Long-running jobs hold a per-job lock under `jobs/<jobId>.lock`; the watchdog inspects locks to distinguish "still running by another process" from "abandoned".

### 4.4.2 Encryption at rest (optional)

`settings.json` stores the Anthropic API key. Two options the CLI supports:

- Plain JSON (default; user's home is already a security boundary).
- OS keyring via `keytar` when `AAB_KEYRING=1` (macOS Keychain, Windows Credential Manager, GNOME/KWallet on Linux). The settings file then stores `apiKeyRef: "keytar:aabcli/anthropic"` instead of the raw key.

`AAB_ANTHROPIC_API_KEY` env var always wins over both.

### 4.4.3 Workspace migration

Schema-version field at `~/.aabcli/<workspace>/.version`. On open, if the on-disk version is older than the binary's expected version, run forward migrations from `migrations/v<N>-to-v<N+1>.ts`. Migrations are pure functions; they read all relevant files, transform, write atomically, then bump `.version`. This is the answer to "what happens when we change the storage shape later."

### 4.4.4 Importing data from sage-council

`aab import sage-council <export-path>` imports a JSON export of an existing sage-council install (members, principles, discussions, action items, business profile/context). This is a one-way migration aid — it lets a user keep their roster when moving from the web app to the CLI. Mapping is straight 1:1 since the CLI types match the source types verbatim.

## 4.5 Things deliberately not ported (explicit list, supersedes §2.16)

- All `src/components/`, `src/pages/`, `src/hooks/`, `src/integrations/supabase/`, `src/test/`.
- Supabase tables and migrations — replaced by filesystem schema.
- Edge functions for admin (`admin-prompts`, `admin-stats`, `admin-user-detail`, `admin-user-manage`, `admin-users`).
- `auth-email-hook`, `delete-account` (no auth in CLI).
- `src/lib/admin/` (admin-only UI logic).
- `tab-leader.ts`, `discussion-attention-signal.ts` (browser-only multi-tab coordination).
- Cloud-mode storage — `getStorageType()` always returns `'local'`.
- `e2e/` Playwright suite — replaced by CLI fixture tests.
- `lovable-tagger`, `pdf-export-service.ts` (jspdf), `discussion-export-service.ts` browser bits — markdown export is enough; PDF can be added later via `marked` → `puppeteer`.
- Recharts/visualisation in `Usage.tsx` — `aab usage` prints text tables.
- Demo-mode toggle — there is only one mode (filesystem).

## 4.6 Project files the CLI should ship by default

`aab init` writes:

- `~/.aabcli/<workspace>/{settings,members,principles,boards,...}.json` seeded with the 3 starter board members (Elon Musk, Julian Bent Singh, Alexandra Chen) + 8 starter principles + a default `AppSettings` object.
- `.claude/agents/<member-slug>.md` for each starter member (so Mode B works immediately inside Claude Code).
- `.claude/skills/aab/SKILL.md` — a meta-skill that gives Claude Code instructions on how to drive the `aab` CLI. Body: "When the user asks for an advisory board discussion, run `aab discuss start "<question>"`. When they ask for an action item solved, run `aab actions solve <id>`. …" This is the killer ergonomic — the user can just say "convene the board on whether we should pivot" and Claude Code handles the CLI calls.
- `.claude/skills/aab-board-member-template/` — a referenceable template a user can copy when creating new members manually.
- `CLAUDE.md` (project-level, only if not present) with the "AI Advisory Board" guardrails ported from sage-council's CLAUDE.md (changelog naming, prompt-hardening invariant, no-broken-imports rule).

## 4.7 Test strategy

### 4.7.1 Unit tests (vitest)

- Direct ports of the existing tests for: `safe-json`, `retry-fetch`, `orchestrator`, `conversation-flow`, `enhanced-analyzer`, `business-context-agent`, `secure-api-key`, `prompt-resolver`, `voice-guide`, `ai-enhancer`, all `parsing/llm-response-schemas`.
- New: `fs-storage-service.test.ts` covering every method of `StorageService`.
- New: `claude-direct.test.ts` mocking `@anthropic-ai/sdk` (intercept fetch like the source mocks `fetch` for Gemini).

### 4.7.2 Integration tests (vitest, mocked LLM)

- `discussion-one-round`: end-to-end with stub responses, asserts orchestrator decision, structured parsing, total turns, persistence.
- `discussion-three-rounds-followups`: mirrors the source's e2e mock test.
- `discussion-needs-more-info`: orchestrator returns `request_user_input`, CLI surfaces it, user responds, follow-up round runs.
- `sparring-deep-dive`.
- `actions-extract → solve → deep-execute --as artifacts`.
- `actions-deep-execute --as skill --install` end-to-end with skill builder loop running against fakes.
- `prompts-edit` validation: rejects templates missing required placeholders/fragments.

### 4.7.3 Golden-file tests for prompts

A `golden/<prompt-key>/<scenario>.txt` set of rendered prompts against known inputs. Any prompt change must regenerate the goldens (`AAB_UPDATE_GOLDENS=1 npm test`). This catches accidental contract regressions before they ship.

### 4.7.4 Live test (gated)

`AAB_LIVE_KEY=sk-ant-... npm run test:live` runs one short discussion, one solve, one skill build against the real Anthropic API. Mirrors the source's `discussions-live-cloud` test. Skipped by default in CI.

## 4.8 Distribution & install

- **npm:** `npm i -g aabclitool` — primary install path. Single binary `aab` on `$PATH`.
- **Homebrew (later):** `brew install aabclitool` once we have a tap.
- **Single-file binary (later):** `pkg` or Node SEA build for offline installs.
- **Self-update:** `aab update` runs `npm i -g aabclitool@latest` (with confirmation) and reports the diff.
- **Version pinning:** `aab --version` and `aab doctor` for diagnostics (`Anthropic key valid? ✓`, `Claude Code detected? ✓`, `.claude/agents/ writable? ✓`, `disk free? ✓`).

## 4.9 Ergonomics: the `/aab` slash skill

The most valuable single feature falling out of going Claude Code-native is **`/aab`** — a skill at `.claude/skills/aab/SKILL.md` that the user can invoke from inside Claude Code without touching the CLI directly. Its body teaches Claude Code how to drive the CLI:

```yaml
---
name: aab
description: Use when the user wants to convene an AI advisory board, run an advisory-board discussion, get advice from "the board", solve an action item with multiple agents, or generate a Claude Code skill from a discussion's action items. Recognises phrases like "ask the board", "what would Elon say", "generate a skill for X", "solve action item N".
when_to_use: |
  Invoke this skill when the user wants:
  - A multi-perspective answer to a business/strategy question (run `aab discuss start "<question>"`).
  - To follow up on a previous discussion (run `aab discuss follow-up <id> "..."`).
  - A 1:1 deep dive with a specific board member (run `aab discuss spar <id> --member "<name>"`).
  - To extract actions from a concluded discussion (run `aab actions extract <discussion-id>`).
  - To solve an action item with a multi-agent pipeline (run `aab actions solve <id>`).
  - To generate a Claude Code skill from an action item (run `aab actions deep-execute <id> --as skill --install`).
  - To talk to the principle-based decision coach (run `aab coach`).
allowed-tools: Bash, Read
---

# How to drive the `aab` CLI on the user's behalf
…
```

This is the realisation of "I want to build a CLI version of the advisory board that runs natively inside Claude Code" — the user types in natural language, Claude Code routes to `/aab`, and the skill orchestrates `aab` CLI calls (capturing stdout, surfacing errors, asking for missing args).

## 4.10 Risk register update

Adding to §2.14:

- **Frontmatter mismatch.** Source app emits a SKILL.md frontmatter that Claude Code mostly ignores. Mitigation: the new `ClaudeCodeAdapter` in §4.1.1 rewrites it to spec; we run a validation pass and fail loudly on unknown keys.
- **Sub-agent file rewrites on every `aab discuss start`.** Could clobber user hand-edits. Mitigation: detect a `# AAB:GENERATED` marker at the top of agent files; only auto-rewrite files that carry it. If the user removes the marker, treat the file as user-owned and skip.
- **Tool inheritance in Mode B.** When a sub-agent has `tools: WebSearch, WebFetch, Read, Grep, Glob`, those tools must actually be available in the parent Claude Code session. If the user has restricted `Bash` globally, the agent inherits the restriction. Document this.
- **Agent-SDK version drift.** `Task` → `Agent` rename, programmatic dispatch may evolve. Mitigation: pin `@anthropic-ai/claude-agent-sdk` minor version; gate Mode B behind a runtime version check.
- **Skill-builder cost in Claude tokens.** Sonnet at $3/$15 per M is 6× pricier than Gemini Flash. A single skill build = 10-15 LLM round-trips on multi-thousand-token prompts. Mitigation: prompt caching on the operating-model preamble + decomposition + master-prompter block; default `effort: low` on the master-prompter potency pass; expose a `--budget-cap-usd` flag that aborts if the run is projected to exceed it.

## 4.11 Things still up to user choice (not decided in this plan)

- Exact starter-member roster beyond the documented 3 (Elon, Julian, Alexandra). The source file appears to truncate at 3; production sage-council may ship more (Reid Hoffman, Sara Blakely, Mark Cuban, Naval Ravikant, Peter Thiel, …). Post Phase-2, do a quick audit of what the deployed app ships and import.
- Whether to expose Claude Cowork / OpenClaw skill generation in the CLI v1 or strip those adapters down to "use --platform claude-code". The source supports all three; the CLI defaults to `claude-code` and gates the others behind `--platform`.
- Whether to ship a `.claude/agents/aab-orchestrator.md` by default or only with `aab init --with-orchestrator-agent`.

## 4.12 Acceptance criteria (definition-of-done per phase)

Each phase ships only when its acceptance set passes. These are the contract for "Phase X is done":

- **Phase 1 (Discussions):** `aab init && aab discuss start "Should we expand to Europe?" --members "Elon Musk,Alexandra Chen, CFA"` produces a 1-3 round discussion with structured JSON parsing, an orchestrator decision per round, business context extracted to disk, token usage logged, and `aab discuss show <id>` renders the rounds in TTY markdown.
- **Phase 2 (Members/Principles/Coach):** `aab members add` interactively creates a member with AI-enhanced persona+voiceGuide; the corresponding `.claude/agents/<slug>.md` is written. `aab principles seed-starters` writes 8 principles. `aab coach` streams a Dalio-style response that references the user's principles.
- **Phase 3 (Sparring):** `aab discuss spar <id> --member "Elon Musk"` opens a streaming 1:1 with truncation budgets enforced; `aab discuss inject <id> --from <session>` writes a sparring_injection user response back into the main timeline at the correct round.
- **Phase 4 (Solve):** `aab actions extract <discussion-id>` produces ≥1 action item from structured-data path (no LLM call when structured data exists). `aab actions solve <id>` runs Phase 1 of the action board pipeline end-to-end with at least one dynamic agent created and validated `qualityScore ≥ 75`.
- **Phase 5 (Deliverables):** `aab actions deep-execute <id> --as artifacts` produces a folder with `00-executive-summary.md`, classified per-step deliverables, validation scores, and an optional ZIP.
- **Phase 6 (Skills):** `aab actions deep-execute <id> --as skill --install` runs preflight wizard → skill builder loop → critique → repair → potency pass → security review → trigger evaluator → adapter → installs to `.claude/skills/<name>/`. Generated SKILL.md passes Claude Code's actual frontmatter spec; `/skills` lists the new skill in Claude Code without warnings.
- **Phase 7 (Mode B):** With `--mode=cc` inside Claude Code, member responses are dispatched via the Agent tool against `.claude/agents/<slug>.md` files; transcripts persist under `~/.claude/projects/<project>/<sessionId>/subagents/`. Dynamic agents in Phase-1 solve are injected via `--agents` JSON, not written to disk.
- **Phase 8 (Hardening):** Golden-file tests pass, `aab doctor` reports clean, importing a sage-council export round-trips (`aab import sage-council <path>` → `aab discuss list` shows the imported discussions identical to source).

---

That's the gap-fill. The most material things I had wrong or missing:

1. **Claude Code's actual SKILL.md and sub-agent frontmatter** — Part 4.1 corrects this with the authoritative key list.
2. **The Agent SDK has no dynamic registration** — must use the `--agents` JSON inline flag for transient agents instead of writing to disk.
3. **The HITL `request_user_input` loop** including the pre-round clarification gate timing — Part 4.3.1.
4. **User-customisable prompts via `UserPrompt` + the resolver fallback chain + automatic `master_gpt_prompter_hardening_v1` wrapping** at render time — Parts 4.3.2 and 4.3.20.
5. **Skill preflight wizard + `AgentEnvironmentProfile`** as a real, mandatory step before skill generation — Part 4.3.3.
6. **Plan editing**, **research history**, **generated runs** as first-class entities — Parts 4.3.5, 4.3.6.
7. **Async-job capacity constants and stale watchdog** — Part 4.3.7.
8. **Conversation analyzer's structured-vs-unstructured dual path** — Part 4.3.14.
9. **All 17 feature flags with explicit CLI defaults** — Part 4.3.19.
10. **Encryption-at-rest, workspace migrations, sage-council import** — Parts 4.4.2-4.4.4.
11. **The `/aab` slash-skill** as the headline ergonomic — Part 4.9.
12. **Acceptance criteria per phase** — Part 4.12.

---

# Part 5 — Second extreme-review addendum

A second self-audit after re-reading the source's reliability layer, every zod schema, the full action-solver pipeline, the single-loop skill builder mechanics, the solution packager's layout modes, and the V3 discussion UI flow. This part adds concrete numbers and behaviors that Parts 1-4 left under-specified, plus engineering concerns (CI/CD, error taxonomy, performance budgets, MCP integration, multi-workspace) the plan needed.

## 5.1 Reliability layer — exact constants to port

These are not opinions; the CLI must match the source byte-for-byte to preserve behavior under partial failure.

**`retry-fetch.ts`** (port verbatim):
- Default `retryOnStatuses = [429, 500, 502, 503, 504]`.
- Default `timeoutMs = 60_000`; merges external `AbortSignal` with internal timeout via `AbortController`.
- Default `maxRetries = 3`, `initialDelayMs = 1000`, `backoffMultiplier = 2`, **`maxDelayMs = 30_000` cap**.
- **Honors `Retry-After` header** in seconds *or* RFC date; this overrides backoff math.
- `retryOnNetworkError = true` by default; aborted requests are *not* retried.
- `onRetry({ attempt, delayMs, reason, status })` callback fires before each retry — the CLI wires this to `ora` text updates.
- Anthropic returns **529 "Overloaded"** in addition to Gemini's set; add `529` to `retryOnStatuses` when calling Claude.

**`safe-json.ts`** (port verbatim):
- Tries candidates in this order: `raw → code_fence_stripped → balanced_extraction → regex_object → regex_array`.
- Balanced extraction tracks `{` / `[` depth and respects quoted strings (so `{ "x": "}" }` parses correctly).
- `safeParseJSONWithSchema(text, zodSchema)` returns `{ success: true, data, source }` or `{ success: false, error }` where error is path-joined (e.g., `"contexts[0].confidence: expected number"`).
- Returns the first successful candidate; never silently picks a worse parse over a better one.

**`gemini-error-handling.ts` → `claude-error-handling.ts`** (port with new triggers):
- `isAbortLikeErrorMessage(msg)`: `AbortError | cancelled`.
- `isAuthOrConfigErrorMessage(msg)`: `missing key | forbidden | 401 | 403`.
- `isTransientCapacityErrorMessage(msg)`: `503 | 529 | overloaded | rate limited | 429 | timeout | resource_exhausted | high demand`.
- Critically: **transient detection excludes abort and auth errors** (a 401 is permanent; don't retry it).
- The CLI surfaces transient errors with `"Claude is currently busy (high demand). Retrying in <delayMs>ms..."` and shows the retry counter.

**`logger.ts`** (port + adjust for Node):
- `debug` is dev-only (gated by `process.env.NODE_ENV !== 'production'` instead of the source's `import.meta.env.DEV`).
- `info` writes to stderr (so machine-readable stdout in `--json` mode stays clean).
- `warn`/`error` always on, prefixed `[aabcli]`.
- `redact(value, prefixChars=4)`: shows first N chars + `***`. Apply to API keys, raw model responses, BusinessContext extracted text in logs.

**`utils.ts`**:
- `generateUUID()`: `crypto.randomUUID()` if available (Node ≥19 has it), else manual v4 fallback.
- `normalizeConfidence(value, fallback=70)`: returns `value` if non-null (correctly handles `0`).

## 5.2 The exact zod-schema catalogue the CLI must port

Every LLM call has a schema in `parsing/llm-response-schemas.ts`. Listing them so a porter knows the contract surface:

| Schema | Used by | Critical fields |
|---|---|---|
| `structuredResponsePayloadSchema` | every member response | `response, keyPoints[], questionsForOthers[], actionSteps[], confidence, assumptions?, tradeoffs?, riskMitigations?, firstPrinciplesApplied?, sources?[{title,url}]` |
| `orchestratorDecisionPayloadSchema` | orchestrator | `action, reasoning, nextSpeaker?, suggestedDirection?, consensusReached, confidence, userInputRequest?` |
| `userInputRequestPayloadSchema` | orchestrator HITL | `type, question, context, requestingMembers[], urgency, options?[]` |
| `aiConversationSummarySchema` | summary | `keyPoints[], consensus[], disagreements[], actionableInsights[], participationBreakdown[{memberId?,memberName,totalResponses,topicsCovered[],influence,averageLength}], overallQuality` |
| `actionExtractionPayloadSchema` | analyzer | `actions[{title, description, priority, category, confidence, sourceContext, suggestedAssignee?, suggestedDueDate?}]` |
| `questionAnalysisPayloadSchema` | enhanced-analyzer | `certainty, businessContext[], questionType, keyTerms[], confidence` |
| `businessContextExtractionPayloadSchema` | BusinessContextAgent | `contexts[{category, title, description, confidence, relevantKeywords[], isActive}], reasoning, confidence` |
| `enhancementPayloadSchema` | ai-enhancer | `persona, voiceGuide` |
| `voiceGuidePayloadSchema` | voice-guide | `voiceGuide` |
| `actionClassificationPayloadSchema` | action-classifier | `category, subcategory, complexity, requiredAgentTeams[], estimatedTime, confidence, reasoning` |
| `validationPayloadSchema` | solution-validator | `passed, score, issues[], suggestions[], reviewer` |
| `decompositionPayloadSchema` | task-orchestrator | `subtasks[{id,title,objective,type,priority,requiredCapabilities[],inputsRequired[],outputsProduced[],dependsOn[],riskLevel}], dependencies[], qualityGate{6 scores}, complexity, reasoning` |
| `dynamicAgentPayloadSchema` | agent-maker | `dynamicAgents[{id,name,role,expertise[],capabilities[],systemPrompt}], reasoning` |
| `taskClassificationPayloadSchema` | task-classifier | `type, expertise[], queries[], stepQuality{isAtomic, isSkillWorthy, scopeIssues[], suggestedSplit[]}` |
| `singleLoopPlanPayloadSchema` | skill-builder planner | `steps[{id,title,goal}], rationale` |
| `singleLoopToolTurnPayloadSchema` | skill-builder tool turn | `status, stepId?, markStepCompleted?, rationale, action{tool, path?, targetPath?, content?}` |
| `skillPackagePayloadSchema` | skill-builder output | `skillName, files[{path, content}]` |
| `skillPackageCritiquePayloadSchema` | package critic | `overallScore, threshold, passed, hardGateFailures[], rubricScores{7 dimensions}, fileIssues[], schemaViolations[], canRepair, repairPriority[], warnings[]` |
| `skillSecurityReviewPayloadSchema` | security review | `mode, packageModeRecommendation, rationale, findings[], warnings[]` |
| `skillTriggerEvaluationPayloadSchema` | trigger evaluator | `shouldTriggerQueries[], shouldNotTriggerQueries[], estimatedPrecision, estimatedRecall, rationale, warnings[]` |
| `skillMdEnhancementPayloadSchema` | md enhancer | `skillMd` |
| `filePotencyEnhancementPayloadSchema` | master-prompter potency | `content` |
| `compositionCritiquePayloadSchema` | composition critic | `overallScore, threshold, passed, hardGateFailures[], coverageIssues[], criticalPathIssues[], parallelizationIssues[], riskGaps[], canRepair, repairPriority[]` |
| `compositionOverridePayloadSchema` | composition override | `compositionType, reasoning, warnings[], groups[{compositionPattern, taskIds[]}], executionGraph{criticalPathTaskIds[], parallelizableGroups[][], riskHotspots[]}, qualityGate{coverageComplete, dependencyConsistency, mergeSafety, warnings[]}` |
| `decompositionCritiquePayloadSchema` | decomposition critic | `overallScore, passed, hardGateFailures[], atomicityScore, subtaskIssues[], dependencyIssues[], criticalBlockers[], warnings[], canRepair, repairPriority[]` |
| `skillAwareDecompositionCritiquePayloadSchema` | skill-aware critic | adds `skillFitnessScore, researchAlignmentScore, platformFitnessScore` to the above |
| `planEditResponseSchema` | plan editor | `revisedContent` |

Common preprocessors used across schemas:
- `numberFromUnknown` — accepts string `"75"` or number, NaN → fallback.
- `stringArrayFromUnknown` — accepts CSV string or array, trims and filters empties.
- `booleanFromUnknown` — `"true"|"false"|"yes"|"no"|"on"|"off"|"1"|"0"` → bool.
- `lowercaseStringFromUnknown` — string → trim + lowercase.

Port these helpers verbatim — they make the system tolerant of model-output variations.

## 5.3 Action-solver pipeline — exact prompt and threshold port

Add to §1.10 / §2.8 the missing concrete numbers:

- **`actionClassifier`**: temp `0.3`, `maxOutputTokens 1000`. Fallback rule keywords: `research → research`, `plan → planning`, `create → creative`, default → research; fallback confidence 50-60.
- **`solutionValidator`**: temp `0.1` (low for consistency), `maxOutputTokens 10000`. Pass = `score ≥ 75 AND issues.filter(i => i.includes("critical")).length === 0`. Fallback score = `(successfulAgents/totalAgents) * 60 + avgConfidence * 0.4`.
- **`taskOrchestratorAgent.decompose`**: produces a 6-dimensional quality gate per decomposition: `atomicityScore, strategicCoherenceScore, executionReadinessScore, skillFitnessScore, platformFitnessScore, researchAlignmentScore` — all 0-100. Hard gates: ≥2 subtasks for non-simple complexity, atomic subtasks (one objective each), acyclic dependency graph, every subtask has a concrete `expectedOutput`. Threshold typically 80; gated by the *decomposition critic* below.
- **`agentMakerAgent`**: feature flag `skill_generation_skill_aware_decomposition_v1` forces dynamic-first mode. Without it, capability-coverage threshold is `40-70%` (varies by complexity) before creating a dynamic agent vs reusing existing.
- **`parallelExecutionEngine`**: groups run sequentially, agents within a group run via `Promise.all`. Group duration estimate: `15 + (5 if has dynamic agents) minutes`. Both successful and failed agent results are passed to the next group's `previousResults`.
- **`dynamicAgentExecutor` per-subtask temperatures**: `research 0.2 | analysis 0.3 | planning 0.3 | creative 0.7 | technical 0.2`. (Note: source planning is 0.3 here, not 0.5 as my Part 1 agent report claimed.) `maxOutputTokens 10000`. Confidence is heuristic from response length/structure (deterministic, not from model). 
- **`smartSynthesizerAgent`**: temp `0.3`, `maxOutputTokens 10000`. Output sections: Executive Summary (2-3 paragraphs), Conflict Resolution, Consolidation, Coherent Structure, Top 10 Action Items. Fallback when no API key: structural merge by `agentType` ordering — port this so the CLI degrades to a useful offline output.

Decomposition is gated by **two critics**, not one:

- **`decomposition_critic`** (general) — runs first, scores atomicity, dependency coherence, output-artifact specificity. Triggers a decomposition repair pass if `score < threshold` and `canRepair`.
- **`skill_aware_decomposition_critic`** (when skill mode and `skill_generation_skill_aware_decomposition_v1` enabled) — uses research findings as ground truth. **Critical rule from the source: do NOT reject tools/capabilities that appear in research findings just because the model is unfamiliar.** Adds `skillFitnessScore, researchAlignmentScore, platformFitnessScore`. Repair priority: `["hard-gate", "research-alignment", "atomicity"]`.

## 5.4 Single-loop skill builder — workspace + turn mechanics

The most fragile and most valuable piece. The source's runtime works like this; the CLI must mirror it:

1. **Plan phase** (`single_loop_planner`): produces `steps[{id, title, goal}]`. Saved to `metadata.singleLoopPlan` with status `pending|in_progress|completed|failed` per step.
2. **Tool turns** (`single_loop_tool_turn`, looped): each turn the model returns one of seven actions over a *virtual workspace* — `{list_files | read_file | create_file | update_file | write_file | rename_file | delete_file}`. A turn produces `{status: continue|done, stepId?, markStepCompleted?, rationale, action}`. Continues until `status: 'done'`.
3. **Workspace contract for the CLI**: each skill build runs in `~/.aabcli/<workspace>/runs/<runId>/workspace/`. The seven tools map 1:1 to filesystem ops there. **Cap turns at `maxTurns = 60`** by default (CLI flag `--single-loop-max-turns`). On `invalid_json` or `error` for ≥3 consecutive turns, abort the run and surface the telemetry log.
4. **Telemetry per turn** (`metadata.singleLoopTelemetry`): `{turn, tool, path?, targetPath?, status, observation?, stepId?, rationale?}`. Persist to `<runId>/telemetry.jsonl`.
5. **Critique phase** (`skill_package_critic`): hard gates: SKILL.md exists, parseable YAML frontmatter, frontmatter contract preserved, no unverified-tool assumptions, ≥1 explicit fallback path, no schema-critical violations. Rubric (each 0-100): `taskWorkflowFit, operationalClarity, progressiveDisclosure, outputContract, edgeCasesFallbacks, toolingSafety, validationLoop`. Threshold 80. Returns `canRepair, repairPriority[]`.
6. **Repair pass** (`repair_pass`): only runs if `critique.canRepair === true` and `score < threshold`. Receives `current_package_json` + `critical_issues + critique_payload`. Iterates until pass or **max 2 repair attempts**, then ships best-effort with warning.
7. **Master-prompter potency pass** (`master_prompter_potency_pass`): runs **per file** in the package (yes, every file). Rewrites for depth and reasoning clarity. Preserves YAML frontmatter on SKILL.md when present. Idempotent thanks to the hardening marker.
8. **Security review** (`security_review`): `mode ∈ {loose, strict}`, `packageModeRecommendation ∈ {loose, strict, defer}`. The CLI honours `defer` by surfacing it interactively (`enquirer` prompt to user).
9. **Trigger evaluator** (`trigger_evaluator`): generates 8-10 `shouldTriggerQueries` and 8-10 `shouldNotTriggerQueries`. Captures `estimatedPrecision`, `estimatedRecall` (0-1). Output stored on `metadata.triggerEvaluation`. Hard rule: 8-10 of each — fewer than 4 in either array fails the gate and triggers a regenerate.
10. **Adapter** (`ClaudeCodeAdapter.adapt`): rewrites frontmatter per §4.1.1, then `--install` copies `<runId>/workspace/` to `.claude/skills/<skill-name>/`.

**CRITICAL surprise from re-reading**: in the source, when feature flag `skill_generation_single_loop_v1` is on (it is by default), the deep-execution-orchestrator creates **one giant ExecutionTask** for the entire skill package — not per next-step. The single-loop runtime authors *the whole package* in one continuous run. Per-next-step deliverables are only produced for `--as artifacts` mode. Update §2.8.1 to reflect this:

| Source | CLI mode |
|---|---|
| `--as artifacts` | per-next-step `taskClassifier → deepExecutionAgent` (research/create/validate/package) loop |
| `--as skill` (single-loop on) | one single-loop run that authors all files for the skill package; per-next-step classification still happens but only to *inform* the skill builder's plan |
| `--as both` | runs both flows back-to-back |

## 5.5 Solution packager — four layout modes

The packager (`solution-packager-service.ts`) supports four layout modes; the CLI picks per-flag:

- **`legacy`** — flat folders per task (`01-research/`, `02-strategy/`, …) with all support files included. Default for `--as artifacts`.
- **`skill-semantic`** — folders organized by skill semantic role; *strips support files* that aren't directly invoked from SKILL.md. Used for skill-mode artifact bundles.
- **`upload-ready-master`** — single root `SKILL.md` at top + curated `references/` and `scripts/`; *strips internal support files*. Optimized for `claude.com/skills/upload`.
- **`single-loop-direct`** — flat layout with no per-task folders; the entire workspace authored by the single-loop runtime, taken verbatim. Used when `--single-loop-direct`.

CLI flag: `aab actions deep-execute <id> --as skill --layout legacy|skill-semantic|upload-ready-master|single-loop-direct` (default `single-loop-direct` when skill mode + single-loop is on, `legacy` otherwise).

**Merged-folder dedup**: when `SkillCompositionPlan.compositionType === 'merged'`, multiple skill tasks combine into one folder. The packager tracks `mergedSkillFolderByTaskId` so files aren't duplicated. Port this logic verbatim — losing it produces ZIPs with duplicate paths.

## 5.6 Skill composition — atomic, reflexion, critique-panel features explained

The source has six skill-generation feature flags that I listed but didn't define. Concretely:

- **`skill_generation_atomic_composition_v1`** (off by default) — when on, the composition planner emits *one skill per atomic subtask* (no merging). Useful when the user wants a library of small composable skills. CLI flag `--atomic-composition` mirrors it.
- **`skill_generation_reflexion_v1`** (off by default) — adds a "reflexion" pass after the package critic: the model reviews its own output a second time, looking for flaws the critic missed, and proposes refinements. Doubles cost; CLI exposes `--reflexion`.
- **`skill_generation_critique_panel_v1`** (off by default) — runs three independent critic instances (Sonnet + Opus + Haiku) and merges their critiques. Catches systematic blind spots of any single critic but triples critic cost. CLI flag `--critique-panel`.
- **`skill_generation_web_grounding_v1`** (off by default in source; **on by default in CLI** since Claude has `web_search_20250305`) — enables web search grounding on the skill_task_research prompt.
- **`skill_generation_composition_llm_override_v1`** (off) — lets the LLM override the deterministic composition graph when it can demonstrate measurable improvement. Gated by the composition critic.
- **`skill_generation_llm_control_plane_v1`** (off in source; **on by default in CLI**) — forces LLM-first task classification (vs heuristic-first). Claude is good enough that the LLM-first path wins reliability.

## 5.7 Discussion UI flow → CLI command mapping (V3)

Concrete event-to-call mapping from `Discussions.tsx` and `components/discussion/v3/`:

| UI event | Source call | CLI command |
|---|---|---|
| Submit initial question | `useDiscussionsController.startDiscussion()` → `KickoffJob` | `aab discuss start "<q>" [--members ...]` |
| "Continue Discussion" button | `controller.continueDiscussion(roundNumber, userInput)` | `aab discuss continue <id>` |
| Follow-up composer (mode: all\|specific\|subset) | `validateFollowUpQuestionInput()` (40k cap) → `controller.addFollowUpQuestion(targetType, selectedMemberIds)` | `aab discuss follow-up <id> "<q>" [--all\|--member <name>\|--members a,b,c]` |
| User answers `pendingUserRequest` | `controller.respondToRequest({content, selectedOption?})` | `aab discuss respond <id> "<a>" [--option <i>]` |
| MemberSparringSheet open | `getOrCreateSparringSession({discussionId, memberId, roundNumber, turnNumber})` → `sparringService.sendMessage()` | `aab discuss spar <id> --member <name> [--round N --turn M]` |
| Sparring-injection back to timeline | `controller.injectSparringInsight(insight, sourceMemberId, …)` | `aab discuss inject <id> --from <session> [--insight "..."]` |
| "Extract Actions" button | `triggerDiscussionAttentionSignal()` → navigate ActionBoard | `aab actions extract <discussion-id>` |

**V3 components** (the new redesign behind `action_board_v3_ui_v1`):
- `V3ActiveDiscussionLayout` — wrapper with header/content/composer slots.
- `V3DiscussionHeader` — title, member chips, timestamps. CLI maps to a header line + colored member chips on `aab discuss show`.
- `V3ChatStage` — renders `Message[]` with streaming UI. CLI streams to TTY incrementally.
- `V3BottomInputBar` — composer with mode selector. CLI: `enquirer` mode prompt when running `discuss follow-up` interactively.
- `V3IntelligencePanel` — extracted action steps, key points, questions on the side. CLI: optional `--panel` flag prints these inline after each round.
- `V3KickoffProgress` — progress bar / staged updates during kickoff. CLI: `ora` spinner with stage text from the narrative-events stream.
- `V3ColorUtils` — deterministic per-member avatar gradient. CLI: `chalk` deterministic color per member name (hash → palette).

## 5.8 Anthropic streaming and cache-hit reporting (TTY UX)

Concrete streaming plan:

- Use `anthropic.messages.stream({ ... })` for member responses (Mode A) — yields `MessageStreamEvent`s.
- For each event:
  - `content_block_delta` with `type: 'text_delta'` → append the delta to the *current member's* TTY buffer; print to a colored line prefixed with member name. Use carriage-return to rewrite the line if multi-line streaming would overflow.
  - `message_stop` → tally `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`.
- After all members have streamed, print a single "round complete" line with `tokens-in/out (cache hits %)` and elapsed ms.
- Aggregate cache-hit rate over the session — `aab usage --since now` prints "Cache hit rate: 73% (saved $0.42 vs uncached)".
- Streaming is opt-out via `--no-stream` (renders the whole response when complete; useful for `--json` mode where partial output corrupts JSON).

For sub-agent dispatch in Mode B, streaming comes from the `Agent` tool's progress events; render those identically.

## 5.9 Context-window awareness

Claude Sonnet 4.5/4.6 have a 200k context window; `claude-opus-4-7[1m]` has 1M. The CLI must be aware:

- Before each LLM call, sum `(systemPromptTokens + userMessageTokens + reservedOutput)` and compare against the model's window minus a 4k safety margin.
- If over, truncate `previous_responses` (drop oldest first) and `business_context` (lowest-confidence first) deterministically.
- For sparring, the source already has hard char caps (§4.3.15): port verbatim.
- For multi-round discussions, conversation history grows linearly. Enforce a soft cap of `10 × maxResponseTokens ≈ 100k input tokens` per request; above that, summarize older rounds into a single "earlier rounds summary" injected in the system prompt.
- Print a warning when truncation kicks in: `[aabcli] Context approaching limit; summarizing rounds 1-3.`

## 5.10 MCP integration (consume + emit)

Two directions matter:

**The CLI consumes MCP servers (optional power-user feature).** When `~/.claude/mcp.json` exists, `aab init` detects it and offers to expose the user's MCP tools to dynamic agents and the skill builder. Implementation: `--agents` JSON-injected dynamic agents include `mcpServers: ['<server-name>']` from the user's config. This lets a research agent pull from, e.g., a `gdrive` or `linear` MCP server during action solving.

**The CLI emits skills that reference MCP servers.** When the agent environment profile carries MCP server names, the skill builder's `confirmed_capabilities` block lists them; the generated SKILL.md frontmatter declares `mcpServers: [...]` (Claude Code recognizes this key on agents — for skills it's documented as the agent's responsibility, but worth surfacing in the body's "Tooling" section either way).

`aab mcp list` enumerates detected servers; `aab mcp add <name> <command> [args...]` writes to `~/.claude/mcp.json` (with confirmation, since this is shared state).

## 5.11 Multi-workspace support

`aab` supports many workspaces (one per project, one for personal):

- Default workspace ID: `slugify(basename(cwd))`. Override via `--workspace <id>` or `AAB_WORKSPACE`.
- `aab workspace list` — prints workspaces under `~/.aabcli/`.
- `aab workspace new <id>` — creates a fresh workspace with starter members/principles.
- `aab workspace switch <id>` — sets the active workspace via `~/.aabcli/.active`.
- `aab workspace delete <id>` — confirms + tarballs to `~/.aabcli/.trash/` for 30 days before permanent deletion.
- Project-mounted workspaces: a `./.aabcli/` directory in the cwd takes precedence over `~/.aabcli/<slug>/` so a workspace can travel with the repo.

## 5.12 Performance budgets (per command)

Target wall-clock (P50 on Sonnet 4.5 with prompt caching):

- `aab discuss start` (3 members, 1 round): **≤ 30 s**.
- `aab discuss continue` (3 members, 1 round): **≤ 25 s** (cache warm).
- `aab discuss spar` first message: **≤ 12 s**.
- `aab actions extract`: **≤ 5 s** (no LLM call when structured data exists), **≤ 20 s** with fallback.
- `aab actions solve`: **≤ 3 min** for moderate complexity.
- `aab actions deep-execute --as skill`: **≤ 8 min** end-to-end (single-loop turns dominate).
- `aab init`: **< 2 s**.

Print actual wall-clock and a `[over budget]` warning when exceeded — drives perf optimization with real signal.

## 5.13 Error taxonomy and exit codes (refined)

| Exit code | Class | Examples | User message style |
|---|---|---|---|
| 0 | success | — | — |
| 1 | user error | invalid args, unknown member, bad workspace ID | "❌ <msg>. Try `aab <cmd> --help`." |
| 2 | model error | API 401/403, persistent 429/529, content-policy refusal | "🤖 Claude error: <msg>. <hint>" |
| 3 | network error | DNS, connection refused, all retries exhausted | "🌐 Network error: <msg>. Check connectivity and retry." |
| 4 | parse/contract violation | tolerant parser failed all candidates after retries | "🧩 Could not parse model output (contract violation). Run with `--debug` to capture the response." |
| 5 | filesystem error | EACCES, ENOSPC, lock contention | "💾 Filesystem error: <msg>." |
| 6 | cancelled (Ctrl+C) | user aborted | "⏹ Cancelled." |
| 7 | budget exceeded | `--budget-cap-usd` triggered | "💰 Budget cap reached ($<x>). Run aborted." |

`--debug` prints the originating exception with stack to stderr; `--json` emits `{"ok": false, "code": <n>, "error": "<msg>", "hint": "<hint>"}`.

## 5.14 Logging & telemetry spec

- **Levels**: `silent | error | warn | info | debug | trace`. CLI flag `--log-level <lvl>`; env `AAB_LOG_LEVEL`. Default `warn` for stderr.
- **stdout vs stderr**: stdout is reserved for user-facing output (and `--json` payloads). All logs go to stderr. This makes pipelining safe: `aab discuss show <id> --json | jq` works.
- **File logging**: `--log-file <path>` redirects logs from stderr; or always-on rolling logs at `~/.aabcli/<workspace>/logs/YYYY-MM-DD.log` when `AAB_LOG_FILE=1`.
- **Redaction**: API keys → `sk-ant-***`. Persona text → first 80 chars. Full responses kept only with `--debug` and only in file logs (never stderr).
- **Telemetry events** (separate stream): `~/.aabcli/<workspace>/telemetry/YYYY-MM-DD.jsonl` for board-members + discussions counters (failure rates, parse-fallback rates, orchestrator-decision distribution). Disabled with `AAB_TELEMETRY=off`.

## 5.15 First-run UX

`aab init` flow when nothing exists:

1. Detects Claude Code: prints `Claude Code: detected ✓ (v<x>)` or `not detected`.
2. Prompts for Anthropic API key (or detects `ANTHROPIC_API_KEY` env). Validates with a `messages.count_tokens` round-trip. Optionally stores via `keytar`.
3. Asks workspace location: `current directory (./.aabcli/) | home (~/.aabcli/<slug>/)`.
4. Asks "Seed starter board members and principles? (Y/n)" — default Y.
5. Asks "Generate `.claude/agents/<member>.md` files for Mode B? (Y/n)" — default Y if Claude Code detected.
6. Asks "Install the `/aab` skill so you can drive me from inside Claude Code? (Y/n)" — default Y.
7. Prints next-step suggestions: try `aab discuss start "What should we focus on this quarter?"`.

`aab doctor` runs a non-destructive checkup at any time:
- Anthropic key valid? sanity round-trip
- Claude Code detected and version
- `.claude/agents/` writable?
- `.claude/skills/` writable?
- `proper-lockfile` healthy (no stale locks)?
- Disk space available
- Logs/telemetry directories writable
- Last 5 jobs status

## 5.16 Backups, resume, partial recovery

- **Backups**: on every settings/members write, the previous version is kept in `~/.aabcli/<workspace>/.snapshots/<entity>-<timestamp>.json` — last 20 snapshots per entity. `aab restore <entity> [--snapshot <ts>]` rolls back.
- **Resume**: jobs interrupted mid-run leave a `<jobId>.partial.json` checkpoint. On next run, the CLI offers `Resume job <id>?` — re-loads the discussion state and continues from the last completed round.
- **Partial discussion recovery**: if member 4 of 5 fails in a round, the round's `responses[]` keep the 3 successes. `aab discuss retry-member <id> --member <name>` re-invokes only the failed member with the same round context. (This is *not* in the source — sage-council throws on partial; the CLI is more forgiving by default. Add `--strict` to mirror source behavior.)

## 5.17 Help, tab completion, machine-readable output

- `aab help` and `aab <cmd> --help` powered by `commander`'s built-in help. Examples shown for each command.
- Tab completion: `aab completion bash|zsh|fish|powershell` prints a script the user sources from their shell rc.
- `--json` output: every command supports it; output schema is documented in `docs/json-schema.md` and stable across minor versions. Schema versioning via `"schemaVersion": "<n>"` in every payload.
- `--quiet` suppresses progress + warnings; useful in scripts.

## 5.18 i18n and time zones

- Storage timestamps: ISO-8601 UTC always (`new Date().toISOString()`).
- Display timestamps: locale-aware via `Intl.DateTimeFormat`, respects `--locale` or `LANG` env.
- Locale field already exists on `StartDiscussion*Payload`; CLI honours it for narrative-event messageKey lookups.
- Bundled locales: `en` (always), `da` (Julian Bent Singh's Danish — opt-in for the launch demographic), others as community contributions.
- All starter member personas, principles, and prompt templates are English-only by default; the resolver keeps the user-override path open for translations.

## 5.19 Member-specific tool overrides

The source's board members all share the same prompt; tools are uniform. The CLI extends `AdvisoryBoardMember` with optional `allowedTools?: string[]` and `disallowedTools?: string[]`:

- `members.json` per-member entry can declare `"allowedTools": ["WebSearch", "WebFetch", "Read", "Grep", "Glob"]` (the default).
- A "Web Designer" member can add `"WebFetch"` for design-references; a "Security Auditor" can drop `"WebSearch"` and rely only on local repo reading.
- `aab members tools <id> [--allow ... | --deny ...]` edits the per-member set; regenerates the agent .md file.

## 5.20 Skill execution from the CLI (for testing)

Round-trip your own skills without leaving the CLI:

- `aab skills list` — enumerates installed skills (`.claude/skills/` + plugin scopes).
- `aab skills test <name> "<input>"` — dispatches the skill via Claude Agent SDK with the user input; prints the run transcript. Useful for verifying a freshly-built skill before shipping.
- `aab skills uninstall <name>` — removes from `.claude/skills/<name>/`, archives to `.snapshots/skills/`.
- `aab skills export <name> [--zip path]` — produces a portable bundle.

## 5.21 CI/CD, versioning, npm publish

- **Repository:** monorepo not needed; single npm package `aabclitool`.
- **CI:** GitHub Actions matrix on Node 20 + 22, win/mac/linux. Steps: `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run build`. Live test (`npm run test:live`) gated by repository secret `ANTHROPIC_API_KEY` and a label.
- **Versioning:** semver. Major bumps for storage-schema breaks (with migrations). Minor bumps for new commands. Patch bumps for fixes. Changelog at `CHANGELOG.md`, named "**aabclitool changelog**" (not "Sage Council") — inheriting the source's naming guardrail.
- **Publishing:** `npm publish` from `main` only, gated by tag `vX.Y.Z`. `npm dist-tag latest` updated manually after a 24-hour soak with `--tag next`.
- **Pre-release:** every commit to `main` publishes `aabclitool@next` automatically.
- **Self-update:** `aab update` invokes `npm i -g aabclitool@latest`; reads `npm view aabclitool version` to print the diff.

## 5.22 Concrete dependency list per phase

To make the build order in §2.15 actionable:

- **Phase 0:** `commander`, `enquirer`, `chalk`, `ora`, `proper-lockfile`, `zod`, `@anthropic-ai/sdk`, `tsx`/`tsup`.
- **Phase 1:** add `marked`, `marked-terminal` (TTY markdown).
- **Phase 2:** add `slugify`.
- **Phase 3:** no new deps (sparring uses streaming already).
- **Phase 4:** add `p-limit` (concurrency cap), `cli-table3`.
- **Phase 5:** add `jszip`.
- **Phase 6:** add `@anthropic-ai/claude-agent-sdk` (SDK + agent dispatch).
- **Phase 7:** add `keytar` (optional keyring); behind dynamic import to keep optional.
- **Phase 8:** dev only — `vitest`, `@vitest/coverage-v8`, `nock` (mock Anthropic) or built-in fetch interception.

## 5.23 Documentation deliverables

Ship with:

- `README.md` — install, quick-start, command tour, link to docs.
- `docs/commands.md` — full command reference (auto-generated from `commander` definitions + handwritten examples).
- `docs/architecture.md` — abridged version of this PLAN for contributors.
- `docs/skills.md` — how the CLI generates Claude Code skills, the SKILL.md spec it produces, install paths.
- `docs/agents.md` — Mode B sub-agent contract.
- `docs/troubleshooting.md` — common issues (lock files, stale jobs, 401/529 errors, broken JSON output).
- `CHANGELOG.md` — entries grouped by date, user-facing only (inheriting the source's "AI Advisory Board" naming guardrail).
- `CONTRIBUTING.md` — prompt-hardening guardrail (any new prompt must pass through the master-gpt-prompter skill before merging), test gates (70% lines/branches on critical modules), commit format (`feat(scope): summary`).
- `CLAUDE.md` (project-level for the CLI's own repo) — instructs Claude Code on how to develop the CLI itself.

## 5.24 The `to-dos/` directory

The source ships a 16-folder `to-dos/` workspace of planning docs (`features/`, `research/`, `core-architecture/`, `bugs-and-fixes/`, `principles-*`, `action-board-*`, `discussions-*`, `DONE/`, …). The biggest doc is `Stability&RobustnessAnalysis.md` (~31 KB). Don't port; do skim during early implementation when context is needed for ambiguous behaviors. Keep an equivalent `to-dos/` in the CLI repo for ongoing planning, but seed it empty.

## 5.25 What's *still* not in the plan (final delta)

These are deliberately deferred or gated:

- **Cloud sync between workspaces** (e.g., Dropbox/iCloud-style auto-sync of `~/.aabcli/`). User can rsync manually; native sync is post-v1.
- **Team workspaces** with shared discussions across multiple users. Out of scope.
- **A web UI re-built on top of the CLI.** Plausible (the CLI's `--json` interface is API-shaped) but explicitly out of v1.
- **PDF export.** Markdown export only in v1; PDF is `marked` → `puppeteer` later.
- **Image avatars in TTY.** Members have an `avatar?: string` field; CLI shows the field but does not render images. Could integrate `terminal-image` if there's demand.
- **Voice-input mode.** Out of scope.
- **Recording a discussion to be replayed deterministically.** A trace mode (`--record <path>`) would dump every model request/response; deferred unless debugging proves it necessary.
- **Plugin system for custom platforms beyond claude-code/cowork/openclaw.** The adapter abstraction is in place; a runtime plugin loader is post-v1.
- **Telemetry "phone-home"** to a CLI maintainer endpoint. **Never** by default; explicit opt-in only, and disabled in privacy mode.

## 5.26 Final correctness self-check on Parts 1-4

Two corrections to earlier parts based on the new reads:

- **Part 1.6** said the orchestrator runs "after the round responses, except for the pre-round clarification gate." Correct, but adding: the pre-round clarification gate **also** runs before `addFollowUpQuestion`, not only before `continueDiscussion`. The CLI must wire the gate at both entry points.
- **Part 2.8.1** said "for skill deliverables: `skillBuilderAgent` runs a single-loop authoring runtime." That's half right — when the single-loop flag is on (default), the **deep-execution-orchestrator** itself creates one giant ExecutionTask and the single-loop runtime authors *the whole package*; per-next-step deliverables are not produced in skill mode. §5.4 / §5.5 above is the corrected version.

---

That closes the second extreme review. Material additions in Part 5 over Part 4:

1. **Exact retry/parsing/error-handling constants** (§5.1) — to port verbatim.
2. **Complete zod schema catalogue** (§5.2) — every contract surface, named.
3. **Action-solver pipeline thresholds and dual-critic gating** (§5.3) — including the corrected dynamic-agent temperatures.
4. **Single-loop skill builder workspace mechanics** (§5.4) — turn cap, telemetry, repair-pass max, file-by-file potency pass.
5. **Solution-packager 4 layout modes** (§5.5) — including the merged-folder dedup.
6. **Definitions for atomic-composition / reflexion / critique-panel** (§5.6) — what they actually do.
7. **V3 discussion UI → CLI command map** (§5.7) — including the V3 component breakdown.
8. **Anthropic streaming + cache-hit reporting** (§5.8) — concrete event handling.
9. **Context-window awareness with truncation policy** (§5.9).
10. **MCP integration both directions** (§5.10).
11. **Multi-workspace support** (§5.11).
12. **Performance budgets per command** (§5.12).
13. **Error taxonomy with refined exit codes** (§5.13).
14. **Logging spec with stdout/stderr separation** (§5.14).
15. **First-run UX, doctor, backups, resume, partial recovery** (§§5.15-5.16).
16. **Help, tab completion, JSON schema versioning** (§5.17).
17. **i18n + member-specific tool overrides + skill execution from CLI** (§§5.18-5.20).
18. **CI/CD + versioning + per-phase dependency list + documentation deliverables** (§§5.21-5.23).
19. **Final corrections to Parts 1-4** (§5.26).

---

# Part 6 — Action Board scope cut: Kanban + skill-only solve

User decision: the Action Board has **two responsibilities only** — (1) track action points like a Kanban board (pending / in-progress / completed) and (2) a single "Solve" action per item that generates and installs a Claude Code skill which handles that action point. No multi-agent artifact-style solve, no per-deliverable-type pipeline, no implementation-plan editing.

This part supersedes anything earlier that contradicts it.

## 6.1 New design doctrine in one paragraph

An action point is a small unit of work. The user wants two things from each: a place to see and move it across statuses, and a way to "press solve" and get back a Claude Code skill installed at `.claude/skills/<name>/` that is meant to *do* the work (or to guide doing the work) the next time the user invokes Claude Code. The skill is the deliverable. Nothing else.

## 6.2 What's kept, demoted, dropped

| Source piece | Status in CLI |
|---|---|
| `ActionItem` CRUD (title, description, priority, status, dueDate, assignedTo) | **Kept** — the core data model for the Kanban board. |
| `aab actions extract <discussion-id>` (ConversationAnalyzer with structured-data fast path + LLM fallback) | **Kept** — the natural bridge from a discussion to action items. |
| Manual `aab actions add` | **Kept** — for action points the user enters by hand. |
| Kanban view (new — not in source) | **New** — `aab actions board` renders a 3-column ANSI Kanban. |
| Single-loop **skill builder** (`skillBuilderAgent`) | **Kept verbatim** — this is the skill creator. All gates retained: planner, tool turns (60-turn cap), package critic, repair pass (max 2), per-file master-prompter potency, security review, trigger evaluator. |
| All 14 skill-generation prompts (`skill_generation.*`) | **Kept verbatim**. |
| `master_gpt_prompter_hardening_v1` automatic wrap | **Kept**. |
| `ClaudeCodeAdapter` (frontmatter rewrite per §4.1.1) | **Kept**. |
| Skill preflight wizard + `AgentEnvironmentProfile` (capability detection + user confirmation) | **Kept** — without it, skill quality drops sharply. |
| `taskOrchestratorAgent.decompose` | **Kept but demoted** — runs only as input prep for the skill builder's plan, never as a user-visible "solve". No separate quality gate at this layer; the skill builder's own critic does the gating. |
| Skill-task research (`skill_generation.skill_task_research`) with web grounding | **Kept** — provides workflow patterns / risk signals to the skill builder. |
| `actionSolverOrchestrator` (Phase-1 multi-agent solve) | **Dropped**. |
| `taskClassifierAgent` (deliverable-type classification: prompt/script/guide/template/…) | **Dropped** — deliverable type is always `skill`. |
| `deepExecutionAgent` research→create→validate→package phases | **Dropped** for non-skill flow; the single-loop runtime does this internally for skill flow. |
| Pre-built agent teams (web-research, market-analysis, financial-analysis, strategy-planning, content-strategy, risk-assessment) | **Dropped**. (Still ship the file scaffolds for sub-agent generation, but they aren't called from `actions solve`.) |
| `agentMakerAgent`, `parallelExecutionEngine`, `smartSynthesizerAgent`, `dynamicAgentExecutor`, `solutionValidator` | **Dropped**. |
| `ActionSolution`, `SynthesisResult`, `ValidationResult`, `RefinementResult`, `ConflictResolution`, `RiskItem`, `SolutionSection` types | **Dropped** from storage. |
| `--as artifacts`, `--as both` modes | **Dropped**. Only `--as skill` exists; the flag is implied — `aab actions solve <id>` always builds a skill. |
| `plan-edit-service` (rewrite nextSteps / implementationPlan) | **Dropped** — there's no plan to edit. (If the user wants to edit the action item itself, `aab actions edit <id>`.) |
| `ActionResearchHistory.type='research'` (separate research-only runs) | **Dropped**. |
| `GeneratedRunRecord` for non-skill artifact bundles | **Renamed** to `SkillGenerationRun` and trimmed to skill-only fields. |
| Solution packager layout modes `legacy | skill-semantic | upload-ready-master` | **Dropped**. Only `single-loop-direct` (the natural format for the single-loop runtime). |
| Skill composition (`skillCompositionAnalyzer`, override agent, composition critic) | **Dropped** — one action item produces one skill, always `compositionType: 'standalone'`. The composition prompts are not ported. |
| `skill_generation_atomic_composition_v1`, `skill_generation_composition_llm_override_v1`, `skill_generation_critique_panel_v1`, `skill_generation_reflexion_v1` flags | **Dropped from CLI** (composition flags are moot; reflexion/critique-panel can be added back later if quality issues arise). |
| `contextIntelligenceService`, `dataCollectionService`, `contextSummarizerService` | **Kept but trimmed** — only the path that feeds the skill builder's "business context" + "discussion context" injection. |

## 6.3 The Kanban view + actions commands

### 6.3.1 The board view

```
aab actions board

  AI Advisory Board — Action Board (workspace: nya-ai)

  ┌─ PENDING ─────────────┬─ IN PROGRESS ─────────┬─ COMPLETED ──────────┐
  │ ⬆ a1f3 Launch ad      │ → b2c4 Hire 2 SDRs    │ ✓ c5d6 Set up CRM    │
  │     campaign in DK    │     [skill: hire-sdr] │                      │
  │ • a2e7 Draft Q2 OKRs  │ → b8a9 Migrate billing│ ✓ c7e8 Pick agency   │
  │ ⬇ a4f1 Cleanup intern │   [skill: stripe-mig] │                      │
  │     access            │                       │                      │
  └───────────────────────┴───────────────────────┴──────────────────────┘
  3 pending  •  2 in progress  •  2 completed     [press ? for shortcuts]
```

- `⬆ ⬇ •` = priority high/low/medium.
- `[skill: <name>]` is shown when an action has a generated skill linked to it.
- Optional flags: `--filter <pending|in-progress|completed>`, `--priority <high|medium|low>`, `--linked-discussion <id>`, `--json`.
- `--watch` redraws on file change so you can see updates in real time.

### 6.3.2 Commands

```
aab actions add "<title>" [--description "..."] [--priority high|medium|low] [--due 2026-06-01]
aab actions list [--status ...] [--priority ...]                # flat list view
aab actions board [--watch] [--filter ...]                       # kanban view
aab actions show <id>                                            # detail: title, description, status, priority, linked discussion, linked skill runs
aab actions edit <id> [--title ...] [--description ...] [--priority ...] [--due ...]
aab actions move <id> pending|in-progress|completed              # change status
aab actions delete <id> [--cascade]                              # cascade also removes linked skill runs

aab actions extract <discussion-id>                              # auto-extract action items from a concluded discussion
aab actions solve <id>                                           # generate + install a Claude Code skill for this action
aab actions runs <id>                                            # list past skill-generation runs for this action
aab actions runs show <run-id>                                   # view the run: status, files, telemetry, critic scores
aab actions runs export <run-id> --zip <path>                    # export the skill package as a ZIP
```

`aab actions extract` keeps the source's structured-data fast path (no LLM call when responses already carry `structuredData`) and falls back to a single LLM call against the transcript when they don't. Output is one `ActionItem` per extracted item; deduped against existing items by title similarity.

## 6.4 The simplified `solve` flow

`aab actions solve <id>` is one command, one flow, end-to-end:

1. **Load** the action item + any linked discussion + business context bank + business profile.
2. **Preflight wizard** (`enquirer`):
   - Auto-detect installed CLI tools (`which git gh node npm pnpm bun docker …`), MCP servers (parse `~/.claude/mcp.json`), env vars relevant to the action's text.
   - Show capability requirements inferred by `skill-preflight.ts` patterns. Pre-check the ones we detected.
   - Ask the user to confirm: "Available? (yes / no / ask-user-at-runtime)" per requirement.
   - For unavailable capabilities, pick a fallback mode: `artifact-draft | manual-handoff | ask-user-choice`.
   - Skip with `--no-preflight` (uses inferred-only profile; quality may suffer).
3. **Light decomposition** (`taskOrchestratorAgent` ported but headless): runs once to produce 3-7 subtasks that become the *plan input* for the single-loop runtime. The user does not see these — they're internal scaffolding for skill builder quality. No quality gate at this layer.
4. **Skill task research** (`skill_generation.skill_task_research` with `web_search_20250305` enabled): produces workflow patterns, risk signals, tool routing signals, decomposition constraints. Output goes into the skill builder's context block.
5. **Single-loop skill builder** runs end-to-end:
   - Planner → tool turns (≤60) → package critic → repair (≤2 attempts) → master-prompter potency pass per file → security review → trigger evaluator.
   - All gates from Part 5.4 unchanged.
6. **Adapter**: `ClaudeCodeAdapter` rewrites the SKILL.md frontmatter to the real Claude Code spec (§4.1.1).
7. **Install**: copies to `.claude/skills/<skill-name>/`. Asks confirmation if a skill with that name already exists (`overwrite | rename | abort`).
8. **Link** the skill back to the action item: `actionItem.linkedSkill = { name, runId, installedAt }`.
9. **Status update**: by default move the action item to `in-progress` (the skill is now there to *help do* the work; user moves to `completed` when they're satisfied). Override with `--keep-status` or `--complete-on-install`.

Flags:
```
--no-preflight                 skip the capability wizard
--zip <path>                   also produce a portable ZIP at <path>
--no-install                   build the package but don't write to .claude/skills/
--skill-name <name>            override the auto-derived skill name
--budget-cap-usd <n>           abort if projected cost exceeds <n>
--single-loop-max-turns <n>    default 60
--reflexion                    optional extra critic pass (off by default)
--debug                        verbose logs of every model call
--json                         machine-readable progress + final result
```

Streamed progress to TTY:

```
$ aab actions solve a1f3
🛡  Preflight: detected 6 CLI tools, 2 MCP servers, 3 env vars. Confirm capabilities? (interactive)
   → confirmed: filesystem ✓ shell ✓ git ✓ stripe-mcp ✓
   → unavailable (fallback=artifact-draft): playwright

🧭  Decomposition (5 subtasks)
🔎  Skill task research (web search) … 12 sources retained
🛠  Single-loop skill builder
    Plan: 7 steps
    Turn  1/60  list_files               .          ✓
    Turn  2/60  create_file              SKILL.md   ✓
    Turn  3/60  create_file              references/playbook.md  ✓
    …
    Turn 22/60  done
🧪  Critic: score 84/100 ✓ pass
🔐  Security review: mode=loose, recommendation=loose
🎯  Trigger eval: precision 0.82, recall 0.78 ✓
🪄  Potency pass (3 files) … 3/3
📦  Adapter: frontmatter normalized ✓
✅  Installed at .claude/skills/launch-dk-ad-campaign/
   Action a1f3 → in-progress (linked skill: launch-dk-ad-campaign)

   Cost: $0.41 (cache hit 64%) · 4m 12s
   Run id: run-a1f3-20260509-143012
```

## 6.5 Storage shape changes

```
~/.aabcli/<workspace>/
├── settings.json
├── members.json
├── boards.json
├── prompts.json
├── business-profile.json
├── business-context.json
├── principles.json
├── decision-sessions/<id>.json
├── discussions/<id>.json
├── action-items.json                      ← simpler shape (see below)
├── skill-runs/<actionItemId>/<runId>.json ← NEW: replaces generated-runs
│   └── workspace/                         ← single-loop runtime workspace (live during build)
├── sparring/<discussionId>/<sessionId>.json
├── token-usage/YYYY-MM-DD.jsonl
└── jobs/<jobId>.json
```

Removed entirely: `generated-runs/`, `research-history/`, anything storing `ActionSolution`. The `ActionItem` shape is extended with two optional fields:

```ts
interface ActionItem {
  id: string
  discussionId?: string                   // null when manually added
  title: string
  description: string
  priority: 'low' | 'medium' | 'high'
  status: 'pending' | 'in-progress' | 'completed'
  assignedTo?: string
  dueDate?: Date
  createdAt: Date
  updatedAt: Date
  linkedSkill?: {                         // NEW
    name: string                          // e.g. "launch-dk-ad-campaign"
    runId: string                         // points to skill-runs/<actionId>/<runId>.json
    installedAt: Date
    installPath: string                   // e.g. ".claude/skills/launch-dk-ad-campaign/"
  }
  skillRunHistory?: string[]              // NEW: array of runIds (latest first)
}

interface SkillGenerationRun {            // replaces GeneratedRunRecord
  id: string
  actionItemId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: Date
  completedAt?: Date
  costUsd: number
  cacheHitRate: number
  durationMs: number
  files: SkillPackageFile[]
  installPath?: string                    // set when --install ran
  metadata: {
    skillName: string
    confirmedCapabilityProfile: SkillCapabilityProfile
    agentEnvironment: AgentEnvironment
    decompositionSubtaskCount: number
    researchSourceCount: number
    singleLoopTurnCount: number
    criticScore: number
    criticPassed: boolean
    repairAttempts: number
    securityReview: { mode: 'loose'|'strict'; recommendation: 'loose'|'strict'|'defer' }
    triggerEvaluation: { precision: number; recall: number; shouldTrigger: string[]; shouldNotTrigger: string[] }
    potencyPassFileCount: number
  }
  telemetry: SingleLoopToolTurnTelemetry[]   // <runId>/telemetry.jsonl is the source of truth
}
```

The simpler shape means smaller backups, faster lookups, and zero ambiguity about what a "run" means in the CLI.

## 6.6 Impact on the build phasing

The original 8-phase plan in §2.15 collapses around the action board:

| Phase | Original | New |
|---|---|---|
| 0 | Skeleton | unchanged |
| 1 | Discussions | unchanged |
| 2 | Members + Principles + Coach | unchanged |
| 3 | Sparring | unchanged |
| **4** | **Action Board Phase 1 (multi-agent solve)** | **REPLACED → "Action Board: Kanban + extract"**: ActionItem CRUD, `aab actions add/list/board/show/edit/move/delete`, `aab actions extract <discussion-id>`. Pure data + UX, no LLM calls beyond the existing extract path. |
| **5** | **Action Board Phase 2 (artifact deliverables)** | **REMOVED**. |
| **6** | **Skills** | **Now phase 5**: the skill creator, preflight, single-loop runtime, all gates, adapter, install. `aab actions solve <id>` ships here. |
| 7 | Mode B | now phase 6 |
| 8 | Hardening | now phase 7 |

So the build is **8 phases → 7 phases**, the heaviest two phases (multi-agent solve + deliverable typing) collapse into one Kanban-only phase, and the killer phase (skill creator) is unchanged.

Dependency-list impact (§5.22): drop the agent-team scaffolding from Phase 4. Phase 5 (skills) keeps everything: `jszip` for `--zip`, `@anthropic-ai/sdk`, the prompt resolver, the preflight wizard, `enquirer` interactive prompts.

## 6.7 Acceptance criteria (replaces §4.12 phases 4-6)

- **New Phase 4 (Kanban):** `aab actions add "Launch DK ad campaign" --priority high` creates an item; `aab actions board` renders a 3-column view with priority markers; `aab actions move <id> in-progress` updates status and the board reflects it on next render. `aab actions extract <discussion-id>` produces ≥1 action item from a concluded discussion (using the structured-data fast path when available, no LLM call required).
- **New Phase 5 (Skill creator):** `aab actions solve <id>` runs the preflight wizard, then the full single-loop pipeline; on success the skill installs at `.claude/skills/<name>/`, the action item carries `linkedSkill`, and `aab actions runs <id>` lists the run with critic score and trigger-eval precision/recall. The generated SKILL.md passes Claude Code's actual frontmatter spec (verified by `/skills` listing the new skill without warnings) and the `aab skills test <name> "<sample input>"` round-trip executes the skill against Claude.

## 6.8 Net effect

The CLI's surface area shrinks meaningfully without losing the killer feature. The Action Board becomes a thin Kanban over `action-items.json` plus one button — "solve" — that pipes the action point directly into the source's most polished subsystem (the single-loop skill builder with all its gates). Everything that was multi-agent / multi-deliverable / artifact-mode is gone. The mental model the user pitched holds end-to-end:

- **Discussions** → talk to the board.
- **Action Board** → track to-dos that came out of the board.
- **Solve** → turn one to-do into an installed Claude Code skill that handles it.

---

# Part 7 — Knowledge Wiki (Karpathy-style LLM Wiki)

User decision (2026-05-10): replace the flat-JSON `BusinessContext` / `BusinessProfile` storage with a **Karpathy-style LLM Wiki** — a persistent, interlinked, LLM-curated markdown knowledge base that every advisory-board member, the orchestrator, and (eventually) the Decision Coach can read natively via `Read`/`Grep`/`Glob` (the Claude Code-style codebase-walking pattern).

This part supersedes anything earlier that contradicts it (§2.7 BusinessContextAgent, §1.10 BusinessContext-fed contextSummarizerService, the entire `BusinessContext` data model in §1.3).

> **The full design spec lives in `PLAN/KNOWLEDGE_WIKI.md`.** That document is the authoritative source of truth for directory layout, frontmatter contracts, page-type taxonomy, naming rules, manifest format, the three workflows (ingest/query/lint), the auto-ingest hook, the CLI surface, the Web UI surface, the migration plan from `BusinessContext`, and the 8-chunk build phasing. This Part 7 is the high-level overview; for any detail not covered here, defer to `KNOWLEDGE_WIKI.md`.

## 7.1 Why we did this (one paragraph)

The current `BusinessContext` is a flat JSON array of `{category, title, description, confidence}` items injected verbatim into every member call (`src/core/discussion/build-user-message.ts:65-69, 103-123`), capped at 3.5k characters. It can't represent relationships, can't grow without truncation, can't carry per-claim provenance, and is JSON-behind-the-scenes (not human-curatable). The wiki gives us linked structure, no truncation pressure (agents pull what they need), per-claim provenance (every page traces back to a `raw/` source), and human-readable / human-editable markdown. Critically, every concluded discussion's summary auto-ingests back into the wiki — so round 50 of any future discussion benefits from every fact ever filed. **Knowledge compounds instead of recurring**.

## 7.2 The pattern in three sentences

Karpathy proposed (April 2026, [gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)) that LLMs should *maintain* a markdown knowledge base instead of *retrieving* fresh chunks on every query. The architecture is three layers: `raw/` (immutable sources), `wiki/` (LLM-curated markdown with `[[wikilinks]]` and YAML frontmatter), and a schema file (`wiki/KNOWLEDGE.md`) telling the LLM how to behave. The framing: *"Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase."*

## 7.3 Three locked design choices

Confirmed by user 2026-05-10:

1. **Wiki location: inside the workspace dir.** `~/.aabcli/<ws>/wiki/` for `home` scope; `<projectRoot>/wiki/` for `project` scope. Symmetric with how `.claude/agents/` already works. The `project` case lets users commit the wiki to git.
2. **Source-page filenames: humanized + footer reference to id.** A discussion with id `7a3f...` and question "Should we pivot Q3 pricing?" becomes `wiki/sources/q3-pricing-pivot.md`; the discussion id appears once in the page footer (`> Source: discussion 7a3f...`) so it stays traceable without polluting the filename.
3. **Wiki fully replaces `BusinessContext`.** No coexistence. A one-time `aab knowledge migrate` converts existing data; the old code path is deleted in the same release.

## 7.4 Architecture summary

Three layers (full spec at `KNOWLEDGE_WIKI.md` §5–§7):

```
raw/    — immutable sources (files, URLs, paste, discussions, summaries)
wiki/   — curated markdown, five page types:
          concept | entity | decision | source-summary | comparison
          plus index.md, log.md, KNOWLEDGE.md (the schema)
.manifest.json — provenance ledger (hash, timestamp, produced pages, costs)
outputs/ — dated lint reports
```

Three workflows (full spec at `KNOWLEDGE_WIKI.md` §15):

- **Ingest** — one `runClaude` call (Haiku/`fastModel`, tools = Read/Grep/Glob/Write/Edit/WebFetch, maxTurns 30). Fired by `aab knowledge ingest <path|url|--paste|--discussion>` and by the auto-ingest hook on conclude.
- **Query** — read-only walk of the wiki by member sub-agents, the orchestrator, or the user (`aab knowledge query`). Tiered retrieval: Grep summaries first, only open bodies when needed.
- **Lint** — static checks (slug uniqueness, broken links, orphans, missing frontmatter) + LLM passes (contradictions, stale claims). Output to `outputs/lint-<date>.md`.

## 7.5 Tool surface (the security boundary)

| Agent | Tools | Notes |
|---|---|---|
| Member sub-agent | `WebSearch, WebFetch, Read, Grep, Glob` | **Already correct** at `src/agents/emit-member-agent.ts:20`. No write access. New: a system-prompt addendum points them at `wiki/`. |
| Orchestrator | `Read, Grep, Glob` | **New** — currently `[]` at `src/core/discussion/orchestrator.ts:51`. Read-only. |
| Ingest agent | `Read, Grep, Glob, Write, Edit, WebFetch` | The only agent allowed to mutate `wiki/`. |
| Query agent | `Read, Grep, Glob` | Read-only. |
| Lint agent | `Read, Grep, Glob, Write` | Write only to `outputs/`. |

## 7.6 Auto-ingest hook (the killer feature)

When a discussion concludes, two things fire automatically (both already-decided defaults in seeded settings):

1. **Auto-summarize** (already `autoSummarization: true` at `src/storage/types.ts:328`) — Haiku call producing the `ConversationSummary` payload (already typed at `src/storage/types.ts:126-134`).
2. **Auto-ingest** — render the transcript to `raw/discussions/<humanized>.md`, render the summary to `raw/summaries/<humanized>.md`, run the ingest agent on both. Toggle: `knowledgeWiki.autoIngestDiscussions` (default true).

Wrapped in try/catch — a failed ingest never blocks discussion completion. User HITL responses (`aab discuss respond` bodies) also auto-ingest as paste-style raw inputs (`knowledgeWiki.autoIngestUserResponses`, default true) so the wiki learns the user's stated preferences and corrections.

This is why the wiki *grows itself*. The user does nothing; discussions compound into permanent linked memory.

## 7.7 What changes in existing code (concrete)

- `src/storage/types.ts:242-276` — `BusinessContext`/`BusinessProfile` types stay during transition (chunk 7 of phasing), then deleted.
- `src/storage/paths.ts:119, 139` — add `wiki`, `raw`, `manifest`, `outputs` paths.
- `src/storage/fs-storage-service.ts:165-186` — `loadBusinessContext` / `saveBusinessContext` / `updateBusinessContext` / `deleteBusinessContext` deleted after migrate.
- `src/core/discussion/build-user-message.ts:17, 28, 65-69, 103-123` — inline business-context block deleted; replaced by a one-line system-prompt addendum pointing at `wiki/`.
- `src/core/discussion/conversation-flow.ts:122, 148, 224-226, 379, 398, 706, 725` — `loadBusinessContextSafe` call sites retired; new `runAutoIngestSafe` hook added at the conclude path.
- `src/agents/emit-member-agent.ts` — append the §14-of-KNOWLEDGE_WIKI.md system-prompt addendum to every member's body inside the `AAB:GENERATED` block.
- `src/core/discussion/orchestrator.ts:51` — `allowedTools = ['Read', 'Grep', 'Glob']`.
- `src/storage/types.ts:300` — add `knowledgeWiki: { … }` settings namespace (full key list at `KNOWLEDGE_WIKI.md` §23).
- New code: `src/core/knowledge/{manifest,page,ingest,query,lint,migrate}.ts`, `src/core/prompts/skill-{ingest,query,lint}.ts`.
- New CLI: `src/commands/knowledge.ts` — `ingest|query|lint|list|show|edit|open|migrate|stats|graph|backfill`.
- New web endpoints: `src/gui/server.ts` — `/api/knowledge/*` plus WS events `wiki_ingest_*`, `wiki_query_*`, `wiki_lint_*`.

## 7.8 Build phasing — 8 chunks

Each independently shippable. Full deliverables at `KNOWLEDGE_WIKI.md` §24.

1. Wiki skeleton + manifest + schema emission on `aab init`.
2. File / text / paste ingest + dedup + atomic writes (PDF support via Read tool).
3. URL ingest via WebFetch + `.meta.json` cache.
4. Member + orchestrator integration (system-prompt addendum + orchestrator tool grant).
5. Auto-ingest hook on conclude + on user HITL response.
6. `aab knowledge query` + `aab knowledge lint` (static + LLM passes).
7. `aab knowledge migrate` + retire `BusinessContext` from runtime path.
8. Web UI Knowledge tab (graph, list, detail, ingest, query, lint).

Chunks 1-3 ship the wiki without changing any agent behavior (purely additive). Chunk 4 turns it on for discussions. Chunk 5 makes it self-feeding. 6-7 close the loop. 8 is UI polish.

## 7.9 Acceptance criteria (Phase 1.5)

- `aab knowledge ingest <path>` on a markdown source produces ≥1 wiki page, updates `wiki/index.md`, appends to `wiki/log.md`, and adds an entry to `.manifest.json`. Re-running with the same source is a no-op (manifest dedup); `--force` re-ingests.
- A 3-member discussion that concludes auto-fires summarize + auto-ingest. The resulting `wiki/sources/<humanized>.md` exists, has frontmatter `type: source-summary`, has `sources: [raw/discussions/<humanized>.md, raw/summaries/<humanized>.md]`, and at least one of `wiki/concepts/`, `wiki/entities/`, `wiki/decisions/` has a new or updated page that wiki-links back to it.
- A subsequent discussion (different question, same workspace) successfully Greps + Reads at least one wiki page during a member call (verified by checking the member's `sources` field in the structured JSON response).
- `aab knowledge migrate` on a workspace with N items in `business-context.json` produces ≥1 wiki page per item, marks them in manifest, leaves `business-context.json.migrated.bak` behind, and is idempotent.
- After migrate, `loadBusinessContextSafe` no longer injects content into `build-user-message.ts` — discussions still work, members get context from the wiki instead.
- `aab knowledge lint` on a wiki with a known-orphan page and a known-broken `[[wikilink]]` produces an `outputs/lint-<date>.md` listing both with severity `warn` / `error` respectively.

## 7.10 Net effect

The advisory board stops re-loading a 3.5k-char blob on every member call and starts walking a structured, linked, growing knowledge base — the same way Claude Code walks a codebase. Every discussion compounds. Every URL the user pastes, every PDF dropped in, every clarification answered becomes a permanent linked node. The user gets a human-readable, git-committable, auditable second brain that drives every advisory-board response.

---

# Part 8 — UI testing with Playwright MCP

User decision (2026-05-19): every meaningful change to the **Web UI** (`gui/` + `src/gui/server.ts`) **must** be exercised via Playwright MCP before being declared done. The CLI's headless commands have type-checking + (eventually) vitest as their safety net; the browser dashboard has neither, so we adopt **agent-driven black-box E2E** as the primary verification surface.

> **The full reference lives in `PLAN/PLAYWRIGHT_MCP.md`.** That document is the authoritative source for setup, the tool cheat sheet, snapshot-vs-vision mode, repo conventions (`data-testid` registry), prompt patterns, when to use MCP vs `@playwright/test`, configuration deep-dive, troubleshooting, Windows notes, and security. This Part 8 is the high-level rationale + the deliverable cuts; for any detail not covered here, defer to `PLAYWRIGHT_MCP.md`.

## 8.1 Why we did this

The dashboard touches the hot path: typing-dot streaming over WebSocket, structured response cards, the HITL panel, the Continue / Respond / Follow-up buttons, the kanban + members + principles views, and (Phase 1.5+) the Knowledge tab. None of that is reachable from CLI tests. Manual verification doesn't scale and missed two regressions in May 2026 alone (silent-empty new-discussion modal when 0 active members; HITL panel leaking onto concluded discussions — both flagged in CHANGELOG). Playwright MCP gives the discussion-driving AI agents in this repo a way to **test the UI the same way a user would**: navigate, observe the a11y tree, click by ref, wait on observable state changes, screenshot the failure.

## 8.2 Two-track testing

- **Playwright MCP** (project-scoped, in `.mcp.json`) — exploration, regression repro, ad-hoc accessibility audits, test authoring. Driven from Claude Code by the human or by an agent.
- **`@playwright/test`** *(deferred to Phase 6.6+, after Phase 1 closeout)* — the deterministic regression suite that runs in CI. Tests generated by MCP, reviewed by a human, committed to `tests/e2e/`, executed headlessly without an LLM.

The split is community consensus and is documented at length in `PLAYWRIGHT_MCP.md` §8. **Don't fuse them**: MCP burns ~3-4× the tokens per generated test compared to direct CLI use, fine for one-off authoring but wasteful for re-running 200 tests on every PR.

## 8.3 Three locked design choices

Confirmed by user 2026-05-19:

1. **Server: `@playwright/mcp` (Microsoft official).** Not the community fork. Pinned to `0.0.75` in `devDependencies`.
2. **Install method: project-scoped `.mcp.json`, committed.** Teammates inherit the server on `git pull`. Cross-platform — uses `node node_modules/@playwright/mcp/cli.js` directly to avoid the Windows + `npx` stdio pipe bug. Capabilities `core,testing,storage,devtools` enabled; `vision` and `network` left off by default.
3. **Locator policy: `data-testid` first.** The dashboard's interactive elements get an opaque `data-testid` from a registry maintained in `PLAYWRIGHT_MCP.md` §6. CSS classes are explicitly forbidden as locators.

## 8.4 What MCP is allowed to touch

- Origins: `http://localhost:*` and `http://127.0.0.1:*` only (enforced via `--allowed-origins`). The MCP cannot navigate to the public internet from this server, defensive against prompt-injection data exfil.
- File system: read-only by default. `--allowUnrestrictedFileAccess` not set.
- Test artifacts directory: `test-artifacts/playwright-mcp/`, gitignored. Screenshots and traces can contain real Claude responses (full advisory-board discussions) — never commit, never paste into public issues.
- The `browser_run_code_unsafe` tool ships in `core` and is **RCE-equivalent**. Deny it in `.claude/settings.json` when adding hooks (Phase 6) — see `PLAYWRIGHT_MCP.md` §12.

## 8.5 Repo conventions (summary; full list in `PLAYWRIGHT_MCP.md` §6)

- Every interactive element in `gui/` gets an opaque `data-testid` from the registry in `PLAYWRIGHT_MCP.md` §6.
- Every element needs a visible label or `aria-label`. Decorative icons → `aria-hidden="true"`.
- Live regions for typing bubbles and orchestrator decisions → `role="status"` `aria-live="polite"`.
- HITL panel → `role="dialog"` `aria-modal="true"`.
- Tests synchronize via `browser_wait_for({ text|testid })`, **never** `sleep`. If a state change isn't observable, the dashboard markup needs a `testid` or `aria-live` added.

## 8.6 Phasing — what gets tested when

The phasing is intentional so Playwright MCP doesn't block Phase 1 closeout.

### Now (immediate — Phase 6.6, scope kept tiny)

- Install `@playwright/mcp` as devDep, commit `.mcp.json`.
- Write `PLAN/PLAYWRIGHT_MCP.md` reference (this part is just the index pointer).
- Add the `data-testid` registry to existing UI elements as part of the next UI touch.
- Document the four canonical prompt patterns (smoke / regression / spec-generation / a11y audit) so any contributor can drive MCP-tested flows.

### Next (Phase 6.6 follow-up — after Phase 1 summarize/export/archive ship)

- Smoke MCP-driven flows for: new-discussion modal, round-1 happy path, HITL respond, follow-up (specific / subset / all), continue-to-conclude. Each captured as a markdown test plan in `specs/`.
- A11y audit per tab; backfill `aria-label` / `data-testid` gaps surfaced.

### Later (Phase 6.6 → 6.7 transition — wired with the rest of Phase 6 "Hardening")

- `@playwright/test` set up alongside MCP. First spec files committed (generated by MCP, reviewed by human).
- CI: GitHub Actions matrix (Node 20+22, win-mac-linux), running `@playwright/test` against a tempdir workspace + stubbed `claude` binary.
- Trace + screenshot + video artifacts uploaded on failure.
- Visual regression baselines for the principal views.

## 8.7 Acceptance criteria (Phase 6.6)

- `.mcp.json` ships at repo root with the project-scoped Playwright MCP server. `@playwright/mcp@0.0.75` is in `devDependencies`. A fresh `git clone && npm install && npx playwright install` followed by `claude` in the repo root surfaces `playwright` under `/mcp` with non-zero tool count.
- `PLAN/PLAYWRIGHT_MCP.md` exists, documents the tool surface, the `data-testid` registry, the prompt patterns, the snapshot-vs-vision mode trade-off, the MCP-vs-`@playwright/test` split, Windows notes, and security.
- At least one canonical smoke flow (new-discussion → round 1 → continue → conclude) is recorded as a markdown spec in `specs/discussion-happy-path.md`, written by driving the dashboard through Playwright MCP.
- The `data-testid` registry items (`PLAYWRIGHT_MCP.md` §6) exist on the current dashboard markup, verified by an MCP a11y-snapshot pass.
- A regression repro for the silent-empty-modal-when-0-active-members fix runs cleanly via MCP (no false positives).

## 8.8 Net effect

The dashboard stops being the unverified surface in this repo. Every UI change ships with at least one MCP-driven smoke flow demonstrating the change works in a real browser; significant changes ship with a committed `@playwright/test` spec the CI re-runs on every PR. The human-in-the-loop reduces to *reviewing AI-generated test code*, not *driving Click → Inspect → Click loops*. By the time Phase 5 (skill creator) lands, the dashboard's regression suite is the same shape as the CLI's: deterministic, mocked, parallelizable, fast.
