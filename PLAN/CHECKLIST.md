# AI Advisory Board CLI — Implementation Checklist

Live progress tracker. Each item is a concrete deliverable. Phase numbering matches `PLAN.md` (with the post-refactor adjustment that we're now claude-CLI-native end-to-end, so old "Mode A vs Mode B" splits collapsed into one mode).

**Legend:** `✅ done` · `🟡 in progress / partial` · `⬜ not started` · `🔵 deferred / nice-to-have`

---

## Phase 0 — Project skeleton ✅

- [x] `package.json` with bin, scripts, deps (commander, enquirer, chalk, ora, proper-lockfile, slugify, zod)
- [x] `tsconfig.json` strict + ESNext + paths
- [x] `tsup.config.ts` ESM build with shebang banner
- [x] `bin/aab.ts` entry → `runCli(argv)`
- [x] `.gitignore`
- [x] `README.md`
- [x] `src/core/utils.ts` — generateUUID, nowIso, formatDuration, formatUsd, clampInt
- [x] `src/core/logger.ts` — levels, redact, stderr-only
- [x] `src/core/errors.ts` — typed errors → exit codes 1-7
- [x] `src/storage/types.ts` — full domain types
- [x] `src/storage/paths.ts` — workspace resolution (override > env > project-mount > active > cwd-slug)
- [x] `src/storage/io.ts` — atomic JSON, snapshots, JSONL append
- [x] `src/storage/locks.ts` — proper-lockfile per-workspace
- [x] `src/storage/fs-storage-service.ts` — full StorageService impl
- [x] `src/llm/claude-code-runner.ts` — shells out to `claude` CLI (no Anthropic SDK)
- [x] `src/env/detect-claude-code.ts` — env hint detection
- [x] `src/agents/emit-member-agent.ts` — `.claude/agents/<slug>.md` emitter with AAB:GENERATED marker
- [x] `src/starter/starter-board-members.ts` — Elon, Julian, Alexandra
- [x] `src/starter/starter-principles.ts` — 8 Dalio-inspired principles
- [x] `src/ui/colors.ts` — chalk + deterministic per-member palette
- [x] `src/ui/prompts.ts` — enquirer wrappers
- [x] `src/ui/spinner.ts` — ora (TTY-aware)
- [x] `src/cli.ts` — commander root, global flags, error mapping
- [x] `src/commands/_context.ts` — workspace + lock helper
- [x] `src/commands/init.ts` — bootstrap: detect claude CLI, seed members + principles, write agent files
- [x] `src/commands/settings.ts` — get/set with type coercion
- [x] `src/commands/doctor.ts` — 9 diagnostic checks
- [x] `src/commands/workspace.ts` — list/new/switch/delete
- [x] Smoke-tested: `aab --version`, `aab init`, `aab doctor`, `aab settings`, `aab workspace`

---

## Phase 1 — Discussions ✅

### Core engine ✅

- [x] `src/core/parsing/safe-json.ts` — 5-strategy tolerant parser
- [x] `src/core/parsing/llm-response-schemas.ts` — structuredResponse, orchestratorDecision, summary schemas
- [x] `src/core/discussion/build-user-message.ts` — `[ROUND: N]` payload assembly with context truncation
- [x] `src/core/discussion/run-member.ts` — claude --agent invocation, JSON parse, token-usage log
- [x] `src/core/discussion/orchestrator.ts` — claude -p decision + deterministic state math (consensus / repetition / quality)
- [x] `src/core/discussion/conversation-flow.ts` — `startDiscussion` (round 1) end-to-end
- [x] Storage methods: saveDiscussion, loadDiscussionById, loadDiscussionPage, deleteDiscussion, archiveDiscussion
- [x] `src/ui/render-discussion.ts` — TTY render with colored member badges, structured data, HITL panel
- [x] Stdin closed on spawn (no `claude` CLI stdin warning)
- [x] Live smoke test: 3-member discussion, structured JSON parsed correctly, orchestrator decided `request_user_input` with options

### Commands ✅ (start/continue/respond/follow-up/list/show/delete/archive/unarchive/summarize/export) · 🟡 (spar)

- [x] `aab discuss start "<question>"` — round 1, members default to all active, `--members` filter, `--max-turns` override
- [x] `aab discuss list [--limit] [--offset] [--archived]`
- [x] `aab discuss show <idOrShort> [--round N]`
- [x] `aab discuss delete <idOrShort>`
- [x] `aab discuss continue <id>` — orchestrator-gated next round
- [x] `aab discuss respond <id> "<answer>" [--option <i>]` — answer pending `userInputRequest`
- [x] `aab discuss follow-up <id> "<q>" [--all|--member <name>|--members a,b,c]` — targeted follow-up round (strict: any member failure aborts the round)
- [x] `aab discuss summarize <id> [--force]` — one-shot `fastModel` call (`src/core/discussion/summarize.ts`), zod-validates against `conversationSummaryPayloadSchema`, persists `discussion.summary`. Participation breakdown computed deterministically from the transcript; LLM only fills `topicsCovered` and `influence`. Throws `ContractError` on empty payload, `ModelError` on spawn failure.
- [x] `aab discuss export <id> [--md] [--out <path>] [--no-summary]` — renders to markdown via `src/ui/render-discussion-markdown.ts`. Auto-summarises once at export time if missing (suppressible via `--no-summary`). Output is deterministic (no timestamps in body — only frontmatter) so it can be reused as a `raw/discussions/<short>.md` source for Phase 1.5's auto-ingest hook without hash drift.
- [x] `aab discuss archive <id>` / `aab discuss unarchive <id>` — flips `archivedAt`; idempotent (no-op + hint on repeat invocations).
- [x] Pre-round clarification gate (fires before `continue` AND `follow-up` per PLAN §4.3.1)

### Supporting services ⬜ (Phase 2 territory but listed here for completeness)

- [~] `src/core/discussion/business-context-agent.ts` — **SUPERSEDED by Phase 1.5 Knowledge Wiki.** The auto-extract-BusinessContext idea is replaced by the wiki's auto-ingest hook on discussion conclude. See `PLAN/KNOWLEDGE_WIKI.md` and Phase 1.5 below.
- [ ] `src/core/discussion/enhanced-analyzer.ts` — alternative parsers for malformed JSON, question certainty extraction
- [ ] `src/core/discussion/conversation-analyzer.ts` — extract action items from concluded discussions (structured-data fast path)
- [ ] `aab usage [--since YYYY-MM-DD] [--by feature|model|day]` — token usage summary

---

## Phase 1.5 — Knowledge Wiki (Karpathy-style LLM Wiki) ⬜

**Spec:** `PLAN/KNOWLEDGE_WIKI.md` (authoritative — read this first).
**Plan section:** `PLAN/PLAN.md` Part 7.
**External references:** [Karpathy's gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), [obsidian-wiki framework](https://github.com/Ar9av/obsidian-wiki), [second-brain](https://github.com/NicholasSpisak/second-brain).

**Locked decisions (2026-05-10, do not renegotiate without fresh user input):**
1. Wiki lives **inside the workspace dir** — `~/.aabcli/<ws>/wiki/` (home scope) or `<projectRoot>/wiki/` (project scope).
2. Source-page filenames are **humanized + footer reference to id** (e.g., `wiki/sources/q3-pricing-pivot.md` with `> Source: discussion 7a3f...` in footer).
3. Wiki **fully replaces** `BusinessContext` — `aab knowledge migrate` + `BusinessContext` runtime path retired in same release.
4. Auto-summarization stays **ON by default** (`autoSummarization: true` already at `src/storage/types.ts:328`).
5. Auto-ingest from concluded discussions is **ON by default** (`knowledgeWiki.autoIngestDiscussions: true`).
6. No vector DB / embeddings in v1 — markdown + Grep/Glob is the retrieval primitive.

**Added 2026-05-19 (interlinking design — full spec at `KNOWLEDGE_WIKI.md` §11):**
7. **Keep `[[slug]]` syntax; ship our own thin runtime** (slug-map in `wiki/index.md` + Glob fallback + Web UI `[[slug]]` preprocessor + lint-maintained backlinks sections). Don't bundle Obsidian. Don't write a custom VS Code extension — **recommend Foam** (free, MIT, Obsidian-compatible) instead.
8. **`aab knowledge rename` is the only sanctioned slug-rename path** — atomic cross-file rewrite of file + body + `related:` + `aliases:` + manifest, under the workspace mutex. Manual `mv` breaks links and is recoverable only via `aab knowledge rename --auto-fix`.
9. **Transclusion `![[slug]]` and block IDs `[[slug#^id]]` are NOT supported in v1.** Header anchors `[[slug#section]]` ARE supported. Path-prefixed links `[[concepts/foo]]` are NOT allowed — slug is canonical.
10. **Foam recommendation defaults ON** (`knowledgeWiki.recommendFoam: true`). `aab init --foam` writes `.vscode/extensions.json`; `aab doctor` adds an info-level check.

### Chunk 1 — Wiki skeleton + manifest + interlinking foundation

- [ ] `src/storage/paths.ts` adds `wiki`, `raw`, `manifest`, `outputs` paths
- [ ] `src/core/knowledge/page.ts` — frontmatter parse/serialize (YAML, including `aliases:`), slug ↔ filename helpers, `[[wikilink]]` extraction (including block links `[[slug#section]]`), body kebab-case humanizer
- [ ] `src/core/knowledge/manifest.ts` — load/save (atomic), dedup by hash, append entry, mark `userEditedPagesSkipped`
- [ ] `src/core/knowledge/schema-emitter.ts` — emits `wiki/KNOWLEDGE.md` from a string template (per `KNOWLEDGE_WIKI.md` §12, including the slug-map resolver instructions and the no-transclusion/no-block-id rules)
- [ ] **`src/core/knowledge/slug-map.ts`** — build slug-map (slug+aliases → path) from a wiki walk; render into `wiki/index.md` between `<!-- AAB:SLUG-MAP -->` and `<!-- /AAB:SLUG-MAP -->` sentinels; parse back from the rendered table (the latter is what query/lint use)
- [ ] **`src/core/knowledge/rename.ts`** — atomic cross-file slug rewrite: file path, every `[[old]]` in every page body (including block-link forms `[[old#section]]`), every `related:` entry, every `aliases:` declaration on other pages, every `.manifest.json` `entries[*].producedPages` / `entries[*].updatedPages` / `userEditedPages[*].page` entry, and append a `renames[]` log entry (per `KNOWLEDGE_WIKI.md` §13). Uses workspace mutex. Returns a diff for `--dry-run`.
- [ ] **`aab knowledge rename <old-slug> <new-slug>`** — `[--dry-run]` `[--auto-fix]` `[--reconcile]` (the last reconciles manifest with filesystem after a Foam-driven move; see `KNOWLEDGE_WIKI.md` §17 and §22)
- [ ] **`aab knowledge show <slug>`** — pretty-prints `[[slug]]` references using the slug-map (`slug ("Target Title")` for resolved, `[[slug]] ⚠ unresolved` for unresolved)
- [ ] `aab init` writes `wiki/KNOWLEDGE.md`, empty `wiki/index.md` **(with empty `<!-- AAB:SLUG-MAP -->` / `<!-- /AAB:SLUG-MAP -->` sentinels in place)**, empty `wiki/log.md`, empty `.manifest.json`, empty `outputs/` and `raw/{files,urls,pasted,discussions,summaries}/` dirs (idempotent — never overwrites existing)
- [ ] `aab init`-emitted `.gitignore` template recommends `raw/` (sensitive sources) but NOT `wiki/` (committable curated knowledge)
- [ ] **`aab init --foam`** writes `.vscode/extensions.json` recommending `foam.foam-vscode` (toggleable via `knowledgeWiki.recommendFoam`, default true)
- [ ] **`aab doctor`** adds info-level check: if `wiki/` exists but no `.vscode/extensions.json` recommends Foam, suggest `aab init --foam`

### Chunk 2 — File / text / paste ingest

- [ ] `src/core/prompts/skill-ingest.ts` — the ingest prompt template (per `KNOWLEDGE_WIKI.md` §15.1). Prompt instructs the agent to **read the slug-map in `wiki/index.md` first** so `[[wikilinks]]` it emits resolve correctly to existing pages.
- [ ] `src/core/knowledge/ingest.ts` — orchestrates: hash → manifest dedup → write to `raw/<bucket>/` → run ingest agent → parse JSON output → **call `slug-map.ts:renderSlugMap()` to rebuild the `<!-- AAB:SLUG-MAP -->` section in `wiki/index.md`** (per `KNOWLEDGE_WIKI.md` §11.3 + §15.1 step 5) → atomic manifest update
- [ ] `aab knowledge ingest <path>` — md, txt, pdf paths
- [ ] `aab knowledge ingest --paste` — read from stdin
- [ ] `aab knowledge ingest --force` — re-ingest even when hash already in manifest
- [ ] `--json` output

### Chunk 3 — URL ingest

- [ ] WebFetch → `raw/urls/<hash6>.md`
- [ ] `raw/urls/<hash6>.meta.json` ({ url, fetchedAt, title, contentHash })
- [ ] `aab knowledge ingest <url>` (auto-detected as URL by `http(s)://` prefix)
- [ ] `--force` re-fetches and re-ingests

### Chunk 4 — Member + orchestrator integration

- [ ] `src/agents/emit-member-agent.ts` appends the Knowledge Wiki stanza (per `KNOWLEDGE_WIKI.md` §14) to the AAB:GENERATED block of every member file. **The stanza tells members the slug-map lives in `wiki/index.md` between `<!-- AAB:SLUG-MAP -->` sentinels and how to resolve `[[wikilinks]]` (cheap-pass slug-map → Glob fallback).**
- [ ] `src/core/discussion/orchestrator.ts:51` — `allowedTools = ['Read', 'Grep', 'Glob']`
- [ ] Settings: `knowledgeWiki.exposeToMemberAgents: true`, `knowledgeWiki.exposeToOrchestrator: true`
- [ ] `aab members sync-agents` regenerates with the new addendum (one-time op for existing workspaces)
- [ ] Smoke test: a member call on a wiki-populated workspace shows `Read` / `Grep` tool calls in the stream-json events. The member's structured response `sources` field contains at least one resolved wiki slug.

### Chunk 5 — Auto-ingest hook on discussion conclude

- [ ] `src/core/discussion/conversation-flow.ts` post-conclude: render transcript → `raw/discussions/<humanized>.md`, render summary → `raw/summaries/<humanized>.md`, run ingest agent
- [ ] Wrapped in try/catch — failed ingest never blocks discussion completion (logs to `wiki/log.md` with `[ingest-failed]` prefix)
- [ ] Settings: `knowledgeWiki.autoIngestDiscussions: true` (default)
- [ ] User HITL responses (`aab discuss respond` bodies) auto-ingest as paste-style raw inputs (settings: `knowledgeWiki.autoIngestUserResponses: true`)
- [ ] `aab knowledge backfill <discussion-id>` — manually run the hook for a past discussion

### Chunk 6 — Query + Lint + interlinking-maintenance commands

- [ ] `src/core/prompts/skill-query.ts` — query prompt template (mirrors the §14 member addendum on slug-map resolution)
- [ ] `src/core/knowledge/query.ts` — one-shot Sonnet call with Read/Grep/Glob, max 15 turns
- [ ] `aab knowledge query "<question>"` — supports `--max-pages`, `--out`, `--save-as concept|entity|...`
- [ ] `src/core/knowledge/lint.ts` — full procedure per `KNOWLEDGE_WIKI.md` §15.3:
  - Static checks: slug+alias uniqueness (global namespace), frontmatter completeness, broken `[[wikilinks]]`, broken `[[slug#header]]` anchors, **forbidden link forms** (path-prefixed `[[concepts/foo]]`, transclusion `![[slug]]`, block IDs `[[slug#^id]]`), broken `sources:`, orphans, **manifest drift** (entries pointing to deleted files → suggest `aab knowledge rename --reconcile`), **alias cap** (warn at 80, error past 100), **sentinel integrity** (both halves of `<!-- AAB:BACKLINKS -->` / `<!-- AAB:SLUG-MAP -->` present where expected)
  - LLM passes (`fastModel`): contradictions, stale claims, missing concepts (referenced ≥3×)
- [ ] **Lint maintains the slug-map** in `wiki/index.md` between the `<!-- AAB:SLUG-MAP -->` sentinels (idempotent rebuild — same `renderSlugMap()` function ingest uses)
- [ ] **Lint maintains per-page backlinks** between `<!-- AAB:BACKLINKS -->` sentinels in every page (regenerated each run; the only writer)
- [ ] **Lint's allowed tools:** `Read, Grep, Glob, Write` — Write is restricted to slug-map section, backlinks sections, and `outputs/lint-<date>.md`. Lint MUST NOT touch page bodies outside sentinels.
- [ ] `aab knowledge lint [--write]` — writes `outputs/lint-<yyyy-mm-dd>.md`, prints summary counts
- [ ] **`aab knowledge unresolved [--json] [--suggest-fixes]`** — fast on-demand sibling of lint, no LLM call (~milliseconds); lists every `[[wikilink]]` whose target slug doesn't exist; `--suggest-fixes` fuzzy-matches against existing slugs
- [ ] **`aab knowledge related <slug> [--depth N] [--out <path>]`** — link-graph walker (outgoing `[[wikilinks]]` + incoming backlinks; default depth 1, max 5). Used by the ingest agent before filing a page so it sees the local neighborhood.

### Chunk 7 — Migrate + retire BusinessContext

- [ ] `src/core/knowledge/migrate.ts` — converts `BusinessContext` items + `BusinessProfile` blob into wiki pages per the mapping table at `KNOWLEDGE_WIKI.md` §19
- [ ] `aab knowledge migrate [--dry-run] [--force-schema]` — idempotent
- [ ] `loadBusinessContextSafe` returns `[]` when `wiki/` exists; falls back to `business-context.json` when not (transition window)
- [ ] Delete inline business-context block from `src/core/discussion/build-user-message.ts:65-69, :103-123`
- [ ] Rename `business-context.json` → `business-context.json.migrated.bak` after successful migrate
- [ ] Drop `loadBusinessContext` / `saveBusinessContext` / `updateBusinessContext` / `deleteBusinessContext` from `src/storage/fs-storage-service.ts:165-186` after migrate
- [ ] Delete `BusinessContext` and `BusinessProfile` types from `src/storage/types.ts:242-276`

### Chunk 8 — Web UI: Knowledge tab (with `[[slug]]` preprocessor as MVP)

- [ ] Sidebar item: **Knowledge** (graph icon)
- [ ] Default view: graph (force-directed; nodes = pages by type, edges = wiki-links; hover for `summary:`)
- [ ] Page list view (sortable table; type/orphan filter chips)
- [ ] Page detail view (rendered markdown + frontmatter sidebar + sources links + backlinks list + edit button)
- [ ] **`gui/wikilinks.js` — MVP `[[slug]]` preprocessor** (per `KNOWLEDGE_WIKI.md` §18.1): turns resolved `[[slug]]` into `<a href="#/wiki/slug" title="<summary>">Title</a>`; unresolved `[[foo]]` renders as `<span class="wiki-unresolved">[[foo]]</span>` (red); `[[slug|Display]]` honors display text; `[[slug#section]]` block links scroll to the matching `<h2 id>` anchor; `![[slug]]` renders literal with deferred-feature tooltip
- [ ] Slug-map fetched from `GET /api/knowledge/state`, cached client-side, **invalidated on `wiki_ingest_done` WS event**
- [ ] Backlinks panel in page-detail sidebar reads the `<!-- AAB:BACKLINKS -->` section from the page file (no re-computation — the file is source of truth)
- [ ] Raw sources list view (table + filter)
- [ ] Ingest panel (drag-drop file zone + URL input + paste textarea; streams progress over WS)
- [ ] Query panel (textarea + answer with clickable citations)
- [ ] Lint panel (run-now + render latest report)
- [ ] WS events: `wiki_ingest_started`, `wiki_ingest_page_written`, `wiki_ingest_done`, `wiki_query_started`, `wiki_query_done`, `wiki_lint_done`
- [ ] REST endpoints: `/api/knowledge/{state,pages,pages/:slug,ingest,ingest/discussion/:id,query,lint,graph,raw,raw/:hash}`. `state` response includes the slug-map for client-side caching.

### Cross-cutting (this phase)

- [ ] `aab knowledge list [--type ...] [--orphans] [--user-edited]`
- [ ] `aab knowledge show <slug>` (rendered: frontmatter + body + backlinks; `[[slug]]` references pretty-printed via slug-map)
- [ ] `aab knowledge edit <slug>` (opens `$EDITOR`, marks `userEdited: true`; preserves content inside `<!-- AAB:BACKLINKS -->` and `<!-- AAB:SLUG-MAP -->` sentinels verbatim)
- [ ] `aab knowledge open <slug>` (prints absolute path)
- [ ] `aab knowledge stats` (page counts by type, total raw sources, last ingest, total ingest cost, slug count + alias count)
- [ ] `aab knowledge graph [--out <path>]` (DOT format link graph)
- [ ] **`aab knowledge rename <old> <new> [--dry-run] [--auto-fix]`** (chunk 1)
- [ ] **`aab knowledge related <slug> [--depth N] [--out <path>]`** (chunk 6)
- [ ] **`aab knowledge unresolved [--json] [--suggest-fixes]`** (chunk 6)
- [ ] Settings namespace: `knowledgeWiki.{enabled, autoIngestDiscussions, autoIngestUserResponses, ingestModel, queryModel, lintStaleDays, maxAgentPagesPerCall, pageBodySoftCap, summarySoftCap, exposeToMemberAgents, exposeToOrchestrator, recommendFoam, slugMapInIndex, maxAliasesGlobal}` — all overridable via `aab settings set`
- [ ] `src/storage/types.ts:300` adds `knowledgeWiki` to `AppSettings` with seeded defaults
- [ ] `aab init [--foam]` flag (chunk 1) and `aab doctor` Foam check (chunk 1)
- [ ] Tests: unit (`page.test.ts`, `manifest.test.ts`, `slug.test.ts`, **`slug-map.test.ts`** for sentinel render/parse round-trip, **`rename.test.ts`** for atomic cross-file rewrite, **`wikilinks.test.js`** for the Web UI preprocessor), integration (mocked Claude — `ingest-file.test.ts`, `auto-ingest.test.ts`, `migrate.test.ts`, `lint.test.ts`), golden-file (`skill-ingest.golden.md`, `skill-query.golden.md`)
- [ ] Live test (`AAB_LIVE_TEST=1`): real PDF + URL + discussion conclude → manifest grows, agent answers wiki-grounded query, slug-map in `wiki/index.md` reflects every page, `aab knowledge rename` round-trip leaves zero broken links

---

## Phase 2 — Members + Principles + Coach ⬜

### Members CRUD

- [ ] `aab members list` — flat or `--json` output
- [ ] `aab members show <name>` — full persona / voice / tools
- [ ] `aab members add` — interactive (name, title, expertise, persona OR `--enhance`)
- [ ] `aab members edit <id|name>` — interactive field-by-field edit
- [ ] `aab members enhance <id> [--type famous|expert|non-famous]` — AI-fill persona + voiceGuide via claude -p
- [ ] `aab members delete <id>` — also removes `.claude/agents/<slug>.md`
- [ ] `aab members sync-agents [--agents-dir <path>]` — regenerate all agent files (preserving `# AAB:GENERATED` marker)
- [ ] `aab members tools <id> [--allow ... | --deny ...]` — per-member tool allowlist override
- [ ] `aab members regenerate-voice <id>` — voice-guide-only refresh

### Persona generation

- [ ] `src/core/members/ai-enhancer.ts` — three template variants (`enhance_famous_person`, `enhance_top_expert`, `enhance_non_famous`)
- [ ] `src/core/members/voice-guide.ts` — voice-only generator
- [ ] `src/core/members/fallback-voice-guides.ts` — hardcoded fallback voices keyed by first name

### Principles

- [ ] `aab principles list [--category ...] [--active|--inactive]`
- [ ] `aab principles add` — interactive
- [ ] `aab principles edit <id>` — interactive
- [ ] `aab principles delete <id>`
- [ ] `aab principles seed-starters` — re-seed 8 starters into existing workspace
- [ ] `aab principles explore [--principle <id>]` — Socratic 5-step wizard (behavior → anti-pattern → triggers → examples → priority)

### Decision Coach

- [ ] `aab coach` — REPL session with streaming responses
- [ ] `aab coach show <session>` — list past sessions or show one
- [ ] `aab coach delete <session>`
- [ ] `src/core/coach/decision-coach.ts` — uses `decision_coach_system` prompt with user's principles injected
- [ ] `src/core/coach/principle-explorer.ts` — 5-step explorer flow with cross-step context
- [ ] DecisionSession persistence (already in storage types, just need command wiring)

---

## Phase 3 — Sparring (1:1 deep dive) ⬜

- [ ] `src/core/sparring/sparring-service.ts` — port with truncation budgets (14k discussion / 8k history / 4k bcontext / 4k anchor)
- [ ] `aab discuss spar <id> --member <name> [--round N --turn M]` — opens REPL anchored to a response
- [ ] `aab discuss inject <id> --from <session>` — write sparring insight back to main timeline as `sparring_injection`
- [ ] `aab discuss spar list <discussion-id>` — list sparring sessions for a discussion
- [ ] `aab discuss spar show <session-id>` — view a sparring session

---

## Phase 4 — Action Board (Kanban) ⬜

(Per Part 6 scope cut: kanban tracking + skill-only solve. Multi-agent solve / artifact mode / deliverable types are NOT in scope.)

### Kanban CRUD

- [ ] `aab actions add "<title>" [--description] [--priority high|medium|low] [--due YYYY-MM-DD]`
- [ ] `aab actions list [--status pending|in-progress|completed] [--priority ...]`
- [ ] `aab actions board [--watch] [--filter ...]` — 3-column ANSI Kanban view
- [ ] `aab actions show <id>` — detail: title, description, status, linked discussion, linked skill runs
- [ ] `aab actions edit <id>` — interactive
- [ ] `aab actions move <id> pending|in-progress|completed`
- [ ] `aab actions delete <id> [--cascade]`

### Auto-extract from discussions

- [ ] `aab actions extract <discussion-id>` — structured-data fast path, LLM fallback when no `structuredData`
- [ ] `src/core/actions/conversation-analyzer.ts` (port; Phase 1 noted it as supporting)

---

## Phase 5 — Skill creator (the killer feature) ⬜

The "Solve" action: turn one action item into one installed Claude Code skill.

### Preflight + research

- [ ] `src/core/skill/preflight.ts` — capability pattern matching (browser, API, MCP, shell, filesystem, git, cloud, SaaS)
- [ ] `src/core/skill/preflight-wizard.ts` — interactive enquirer wizard, auto-detects CLI tools / MCP servers / env vars
- [ ] `src/core/skill/agent-environment-profile.ts` — parse `BusinessProfile` blob, normalize to `AgentEnvironment`
- [ ] `src/core/skill/skill-task-research.ts` — `skill_generation.skill_task_research` prompt with web search

### Single-loop skill builder

- [ ] `src/core/skill/single-loop-planner.ts` — `skill_generation.single_loop_planner` (steps[] from decomposition + plan)
- [ ] `src/core/skill/single-loop-tool-turn.ts` — `skill_generation.single_loop_tool_turn` runtime over a tempdir workspace
- [ ] `src/core/skill/workspace-fs.ts` — list_files / read_file / create_file / update_file / write_file / rename_file / delete_file in `~/.aabcli/<ws>/skill-runs/<run-id>/workspace/`
- [ ] Turn cap (default 60), 3-consecutive-error abort, telemetry to `<run-id>/telemetry.jsonl`

### Quality gates

- [ ] `src/core/skill/package-critic.ts` — `skill_generation.skill_package_critic` (7-dimension rubric, hard gates)
- [ ] `src/core/skill/repair-pass.ts` — `skill_generation.repair_pass` (max 2 attempts)
- [ ] `src/core/skill/master-prompter-potency.ts` — `skill_generation.master_prompter_potency_pass` per file
- [ ] `src/core/skill/security-review.ts` — `skill_generation.security_review` (loose | strict | defer)
- [ ] `src/core/skill/trigger-evaluator.ts` — `skill_generation.trigger_evaluator` (8-10 should / 8-10 should-not queries; precision/recall)

### Decomposition (lightweight, internal-only)

- [ ] `src/core/skill/task-orchestrator.ts` — `skill_generation.decomposition` headless decomposition for plan input
- [ ] (Skip skill-aware decomposition critic + composition critic per Part 6 scope cut)

### Adapter + install

- [ ] `src/core/skill/claude-code-adapter.ts` — frontmatter rewrite per Part 4.1.1 (real Claude Code spec: name, description, when_to_use, allowed-tools, model)
- [ ] Install to `.claude/skills/<skill-name>/`
- [ ] Conflict handling: `overwrite | rename | abort`

### Prompts

- [ ] `src/core/prompts/default-prompts.ts` — port advisory prompts (board_member_response is in agent files; orchestrator + summary + persona enhancers + decision-coach + sparring-deep-dive needed)
- [ ] `src/core/prompts/skill-generation-prompts.ts` — port all 14 skill prompts verbatim
- [ ] `src/core/prompts/master-gpt-prompter-hardening.ts` — port verbatim, auto-applied at render
- [ ] `src/core/prompts/prompt-resolver.ts` — user-override → default chain with Mustache-style conditionals
- [ ] `src/core/prompts/skill-operating-model.ts` — shared `<skill_operating_model>` preamble

### Run management

- [ ] `aab actions solve <id>` — full pipeline end-to-end
- [ ] `aab actions runs <action-id>` — list past runs
- [ ] `aab actions runs show <run-id>` — telemetry, critic scores, files, security mode
- [ ] `aab actions runs export <run-id> --zip <path>`
- [ ] Flags: `--no-preflight`, `--no-install`, `--zip <path>`, `--skill-name <name>`, `--single-loop-max-turns`, `--reflexion`, `--budget-cap-usd`

### User-customisable prompts

- [ ] `aab prompts list` — show defaults vs overrides
- [ ] `aab prompts edit <key>` — open `$EDITOR`, validate placeholders + required fragments
- [ ] `aab prompts reset <key>` / `reset-all`

---

## Phase 6.5 — Web UI (messaging-app dashboard) 🟡

### Server + bundled assets ✅

- [x] `src/gui/server.ts` — Express + WebSocket, REST endpoints (state / discussions / members / actions / principles), POST /api/discussions kicks off async with WS broadcast
- [x] `gui/index.html` — sidebar + main shell, new-discussion modal, toast container
- [x] `gui/style.css` — dark theme, message bubbles, typing-dots animation (`@keyframes typing-bounce`), kanban, principles cards, settings table
- [x] `gui/app.js` — vanilla JS router, WS client with auto-reconnect, view renderers
- [x] `aab ui [--port 3737] [--bind 127.0.0.1] [--no-open]` — start server + open browser
- [x] `gui/` shipped via `package.json` `files` field
- [x] Live smoke test: WS streams `member_thinking → member_response → orchestrator_decision → discussion_completed` with real Claude calls

### Views ✅ (read-only) · 🟡 (editing)

- [x] **Discussions** — list with status pills + new-discussion modal + chat view with typing dots + structured response cards (key points / questions / actions / confidence bar)
- [x] **Members** — grid of cards with avatars, expertise tags, persona preview (read-only)
- [x] **Actions** — 3-column kanban with priority marks, linked-skill badges (read-only)
- [x] **Principles** — grid of cards with category, description, priority bar (read-only)
- [x] **Settings** — read-only key/value table
- [x] Member edit / add / delete UI (with active toggle, expertise editing, persona/voiceGuide forms; auto-emits + cleans up `.claude/agents/<slug>.md`)
- [ ] Action add / edit / move / delete UI (drag-drop kanban)
- [x] Principle edit / add / delete UI (active toggle, category select, priority slider; click-to-edit cards)
- [x] Settings editing UI (full form: title, max turns/members, models, budget, locale, HITL toggle)
- [x] Discussion: continue + respond from the UI (Continue button + HITL reply form)
- [x] Discussion: follow-up from the UI (Follow up button + composer with member-chip selector)
- [ ] Discussion: spar from the UI
- [x] Workspace card in sidebar showing scope (home/project), active/total member count, full root path
- [x] Loud empty-state in new-discussion modal when 0 active members (avoids the silent-empty-chips bug)
- [ ] Decision Coach chat view
- [ ] Sparring 1:1 chat view (anchored to a response)
- [ ] Per-member color from the agent file's `color:` frontmatter (currently uses deterministic hash)
- [ ] Token-usage / cost dashboard view
- [ ] Light theme + theme toggle
- [ ] Mobile responsive sidebar

---

## Phase 6.6 — UI E2E tests with Playwright MCP 🟡

**Spec:** `PLAN/PLAYWRIGHT_MCP.md` (authoritative — read this first).
**Plan section:** `PLAN/PLAN.md` Part 8.
**External references:** [@playwright/mcp on GitHub](https://github.com/microsoft/playwright-mcp), [Claude Code MCP docs](https://code.claude.com/docs/en/mcp), [Playwright MCP getting started](https://playwright.dev/docs/getting-started-mcp).

**Locked decisions (2026-05-19, do not renegotiate without fresh user input):**
1. Server is **`@playwright/mcp`** (Microsoft / official), pinned to `0.0.75` in `devDependencies`. Not the community `@executeautomation/playwright-mcp-server`.
2. Install method is **project-scoped `.mcp.json`** committed at repo root. `command: "node"` + direct path to `node_modules/@playwright/mcp/cli.js` (NOT `npx`) to dodge the Windows stdio pipe bug.
3. Capabilities enabled: `core,testing,storage,devtools`. `vision` and `network` deliberately omitted.
4. Origin allowlist: `http://localhost:*;http://127.0.0.1:*` only. The MCP cannot navigate to the public internet.
5. Locator policy: `data-testid` first, then `role` + accessible name. CSS classes forbidden as locators.
6. Two-track testing: MCP for exploration + test authoring; `@playwright/test` (deferred to Phase 6.6 follow-up) for the deterministic CI suite.
7. **Every meaningful change to `gui/` or `src/gui/server.ts` must be exercised via Playwright MCP before being declared done.** Non-negotiable.

### Chunk 1 — Install + reference doc ✅

- [x] `npm install --save-dev @playwright/mcp@0.0.75`
- [x] `.mcp.json` at repo root with project-scoped server config (cross-platform safe — `node node_modules/@playwright/mcp/cli.js`)
- [x] `PLAN/PLAYWRIGHT_MCP.md` reference doc (setup, tool cheat sheet, snapshot vs vision, prompt patterns, MCP vs `@playwright/test`, troubleshooting, Windows notes, security)
- [x] `PLAN/PLAN.md` Part 8 — high-level rationale + phasing + acceptance
- [x] CHECKLIST entry (this section)

### Chunk 2 — Repo-wide UI hygiene (prereq for stable tests)

- [ ] Add `test-artifacts/` to `.gitignore`
- [ ] Add the `data-testid` registry entries from `PLAYWRIGHT_MCP.md` §6 to existing `gui/index.html` and `gui/app.js`-rendered elements: sidebar tabs, new-discussion modal, discussion-row, chat-view continue / follow-up / HITL controls, typing bubbles, message bubbles, orchestrator decision card, conclusion marker
- [ ] Accessibility pass: every interactive element has a visible label or `aria-label`; decorative icons → `aria-hidden="true"`; live regions on typing-dots and orchestrator decisions (`role="status"` `aria-live="polite"`); HITL panel → `role="dialog"` `aria-modal="true"`
- [ ] Verified live: run a Playwright MCP `browser_snapshot` over every tab and confirm zero unlabeled buttons / orphan inputs

### Chunk 3 — Smoke flow specs (markdown plans, not yet test code)

Each spec lives under `specs/<flow>.md` and is generated by driving the dashboard via Playwright MCP. Format: numbered steps + expected observations + `data-testid` references.

- [ ] `specs/discussion-happy-path.md` — new-discussion modal → start with 3 members → wait for round 1 → continue → conclude. No HITL.
- [ ] `specs/discussion-hitl.md` — start → orchestrator gates → HITL panel appears with options → respond with `--option 1` equivalent → round 2 runs.
- [ ] `specs/discussion-follow-up.md` — follow-up `all` / `specific` / `subset` variants via member-chip selector.
- [ ] `specs/members-tab.md` — list / show / activate / deactivate (when editing UI lands).
- [ ] `specs/principles-tab.md` — equivalent CRUD coverage when UI lands.
- [ ] `specs/a11y-audit.md` — per-tab snapshot, list of unlabeled elements, top 3 fixes.

### Chunk 4 — Regression repro library (one entry per CHANGELOG bug fix)

- [ ] `specs/regressions/silent-empty-modal.md` — 0 active members → new-discussion modal shows the loud empty-state, NOT silently empty.
- [ ] `specs/regressions/hitl-after-maxturns.md` — discussion concludes via `maxTurns` while orchestrator wanted user input → `pendingUserRequest` cleared, no HITL UI visible after `discussion-concluded` marker.
- [ ] `specs/regressions/follow-up-strict-failure.md` — when one targeted member fails, no partial round is committed (verify by reloading the discussion and confirming round count unchanged).
- [ ] Pattern: every fix in `CHANGELOG.md` from this date forward adds an entry here.

### Chunk 5 — `@playwright/test` deterministic suite (deferred — wires after Phase 1 closeout)

- [ ] `npm install --save-dev @playwright/test`
- [ ] `playwright.config.ts` at repo root (projects: chromium / firefox / webkit; trace on first retry; screenshot on failure; html reporter)
- [ ] `tests/e2e/` directory + first `.spec.ts` generated from `specs/discussion-happy-path.md` via the Pattern C prompt in `PLAYWRIGHT_MCP.md` §7
- [ ] `tests/fixtures/seeded-workspace.ts` — boots a tempdir workspace with starter members + principles
- [ ] `tests/fixtures/mock-claude.ts` — stubs the `claude` binary so tests don't burn real subscription tokens
- [ ] `npm run test:e2e` script + `test:e2e:ui` for the Playwright UI mode

### Chunk 6 — CI (Phase 6.6 → 6 boundary)

- [ ] GitHub Actions workflow: matrix on Node 20+22, ubuntu-latest + windows-latest + macos-latest
- [ ] `npx playwright install --with-deps` step
- [ ] `npm run test:e2e -- --shard ${{ matrix.shard }}/4` for parallelism
- [ ] Failure artifacts (trace + screenshot + video) uploaded as GitHub Actions artifacts
- [ ] Optional: `expect(page).toHaveScreenshot()` visual regression baselines for the principal views; gated `--update-snapshots` PRs only

### Cross-cutting (this phase)

- [ ] `.claude/settings.json` permission deny on `mcp__playwright__browser_run_code_unsafe` (RCE-equivalent — see `PLAYWRIGHT_MCP.md` §12)
- [ ] `aab doctor` adds a check: warn if `.mcp.json` exists but `node_modules/@playwright/mcp/cli.js` doesn't (teammate forgot `npm install`)
- [ ] `aab doctor` adds a check: warn if `node_modules/@playwright/mcp` exists but `~/.cache/ms-playwright/` is empty (teammate forgot `npx playwright install`)
- [ ] `CONTRIBUTING.md` section: "UI changes require a Playwright MCP smoke run; reference at `PLAN/PLAYWRIGHT_MCP.md`"

---

## Phase 6 — Hardening, docs, distribution ⬜

### Optional: hooks layer (aiagentorg-style governance)

- [ ] `.claude/settings.json` template hooks for project workspaces
- [ ] PostToolUse hook: append every tool call to `~/.aabcli/<ws>/telemetry/<date>.jsonl`
- [ ] PreToolUse hook on `.claude/skills/**` writes: run skill-package critic before allowing install
- [ ] PreToolUse hook on `.claude/agents/**` writes: warn on edits to AAB-generated files
- [ ] Hook config emitted by `aab init` (opt-in)

### Tests

- [ ] Vitest config + npm script
- [ ] Unit tests: safe-json, orchestrator state math, build-user-message, fs-storage-service, prompt-resolver
- [ ] Integration tests: discuss-one-round (mocked claude), discuss-needs-more-info, sparring, actions extract→solve
- [ ] Golden-file tests: every prompt key × representative inputs (`AAB_UPDATE_GOLDENS=1`)
- [ ] Live test (gated by `AAB_LIVE_TEST=1`): one short discussion, one solve

### Distribution

- [ ] `npm publish` workflow (manual)
- [ ] GitHub Actions CI: typecheck + lint + test on Node 20+22 / win-mac-linux
- [ ] Self-update: `aab update` runs `npm i -g aabclitool@latest` with confirmation
- [ ] Optional `keytar` integration for OS-keyring API key storage (not needed since we use `claude` CLI, but useful for any future per-call auth)

### Documentation

- [ ] Polish `README.md` with screenshots / asciinema
- [ ] `docs/commands.md` auto-generated from commander definitions
- [ ] `docs/architecture.md` (abridged from PLAN.md)
- [ ] `docs/skills.md` — what the CLI emits + Claude Code spec
- [ ] `docs/troubleshooting.md` — common failure modes (lock files, missing claude CLI, JSON parse fallbacks)
- [x] `CHANGELOG.md` (date-grouped session log; one entry per user trigger; root cause + verification + "no regression" reasoning per bug fix)
- [ ] `CONTRIBUTING.md` — prompt-hardening guardrail, test gates, commit format
- [ ] Project-level `CLAUDE.md` for the CLI's own repo

### Resilience

- [ ] Backups: snapshot every settings/members/principles write (already plumbed via `writeJsonAtomic` snapshotDir option)
- [ ] `aab restore <entity> [--snapshot <ts>]`
- [ ] Resume: `<jobId>.partial.json` checkpoints + "Resume job <id>?" prompt on next run
- [ ] Stale-job watchdog: jobs in `running` >15 min on next CLI invocation get force-failed
- [ ] Per-call budget cap honoured by all `runClaude` invocations (already wired)
- [ ] `aab discuss retry-member <id> --member <name>` — re-run one failed member without redoing whole round

### i18n + ergonomics

- [ ] Locale-aware date formatting via `Intl.DateTimeFormat`
- [ ] Bundled `en` strings file; opt-in `da` for Julian Bent Singh
- [ ] Tab completion: `aab completion bash|zsh|fish|powershell`
- [ ] `aab import sage-council <export-path>` — one-way migration helper

### Optional `/aab` slash skill (cherry on top)

- [ ] `aab init` writes `.claude/skills/aab/SKILL.md` so users can drive the CLI by natural language inside Claude Code
- [ ] Skill body teaches Claude Code which `aab` commands to run for which user phrases

---

## Cross-cutting (anywhere appropriate)

- [x] Exit-code error taxonomy (1 user / 2 model / 3 network / 4 parse / 5 fs / 6 cancelled / 7 budget)
- [x] `--json` output flag plumbed for read-only commands
- [x] `--json` output for `discuss start | continue | follow-up` (already plumbed via `openContext().json`; verified at `src/commands/discuss.ts:92, :169, :252, :399`)
- [ ] Cost reporting (running total + cache-hit %) printed at end of long-running commands
- [ ] Context-window awareness — truncate prior rounds / business context before exceeding `claude` model's window
- [x] Per-workspace lock file (proper-lockfile)
- [x] Atomic JSON writes with snapshot
- [x] Token-usage logging from `claude --output-format json` envelopes
- [x] Playwright MCP installed at project scope (`.mcp.json` + `@playwright/mcp@0.0.75` devDep) — every meaningful UI change must be exercised via MCP before being declared done (see Phase 6.6 + `PLAN/PLAYWRIGHT_MCP.md`)

---

## What's running right now (May 2026)

- **Phase 0:** done.
- **Phase 1:** ✅ closed (2026-05-19, except sparring which is Phase 3). Live-smoke verified end-to-end (3 real Claude calls per discussion + 1 Haiku call per summarize). Closeout shipped alongside **two runner fixes that surfaced during the smoke and would have silently broken every prior Phase 1 path on Node 20.12+ / 22 / 24**: (a) Windows `.cmd` shim was being spawned through `cmd.exe` which silently truncates multi-line argv at the first newline — fixed by parsing the npm shim, extracting the underlying `.exe`, and spawning that directly (`src/llm/claude-code-runner.ts:resolveCmdShimToExe`); (b) summarize prompt's `…` truncation marker made Haiku refuse to summarize, thinking the transcript was corrupted mid-stream — fixed with explicit editorial marker + cap bumped 1200→6000 chars (`src/core/discussion/summarize.ts:PER_RESPONSE_CAP`). The orchestrator parse-failure that PLAN/CHECKLIST mentioned for months was the same `.cmd` truncation bug (its prompt is also multi-line); fixing the runner fixed the orchestrator too. Smoke verified: real discussion → orchestrator decision parses (`continue` with 95% confidence vs the old "fallback decision" path), summarize produces 82/100-quality 6-keyPoint summary, export renders the full summary into markdown, archive/unarchive are idempotent. Multi-round discussions work end-to-end on real Claude Code calls. Verified live (May 2026): `start` → 3 members responded → orchestrator gated next round → `respond --option 1` with answer → 3 members responded round 2 → orchestrator asked again → maxTurns auto-concluded. **Targeted follow-ups also live**: `aab discuss follow-up <id> "<q>" --member "Elon Musk"` ran a strict 1-member round and persisted `followUpQuestion`, `followUpTargetType: 'specific'`, `followUpSelectedMemberId`, and a matching `UserResponse{type:'follow_up_question'}`. The pre-round clarification gate fires at both `continue` and `follow-up` entry points per PLAN §4.3.1 — no member tokens spent when the orchestrator wants user input first. **Closeout shipped 2026-05-19:** `aab discuss summarize` (one-shot `fastModel` call producing the `ConversationSummary` payload — the same shape Phase 1.5 auto-ingest will consume), `aab discuss export --md` (self-contained markdown renderer; auto-summarises at export time if missing), `aab discuss archive/unarchive` (flips `archivedAt`, idempotent). Sparring deferred to Phase 3.
- **Phase 1.5 (Knowledge Wiki):** spec-locked, not yet built. Replaces flat-JSON `BusinessContext` with a Karpathy-style LLM Wiki: `raw/` (immutable sources) + `wiki/` (curated, linked markdown with `[[wikilinks]]` and YAML frontmatter) + `.manifest.json` (provenance ledger). Members and orchestrator read it natively via Read/Grep/Glob (the same way Claude Code walks a codebase). Auto-summarization stays ON by default (Haiku/`fastModel`); concluded discussions auto-ingest summary + transcript so the wiki grows itself. Full spec at `PLAN/KNOWLEDGE_WIKI.md`; high-level overview at `PLAN/PLAN.md` Part 7. 8 build chunks queued.
- **Phase 6.5 (UI):** Web dashboard ships with `aab ui`. Live-streams typing-dot animations while members respond, then morphs into structured response cards. **Drives multi-round conversations from the browser**: Continue button on open discussions, inline reply form (with option chips) on HITL panels, and a Follow up composer with a member-chip selector that maps to `targetType: all|specific|subset` automatically based on chip count. Server posts to `/api/discussions/:id/continue`, `/respond`, and `/follow-up`, broadcasting the same WS event stream. Read-only views still for Members, Kanban, Principles, Settings. Editing UIs and Coach/Sparring views deferred until their backends land.
- **Phase 6.6 (Playwright MCP UI tests):** chunk 1 done — `@playwright/mcp@0.0.75` installed as devDep, project-scoped `.mcp.json` committed (cross-platform safe), `PLAN/PLAYWRIGHT_MCP.md` reference doc written. Next: chunk 2 (add `data-testid` registry to existing `gui/` markup + a11y pass), then chunk 3 (smoke flow specs by driving the dashboard via MCP).
- **Phase 2-6:** not started.

**Next sensible chunk:** **Phase 1.5 chunk 1** (Knowledge Wiki skeleton + manifest + slug-map + rename + `aab init` schema emission + `--foam` flag + doctor check) is the foundation for everything downstream — it unlocks chunks 2-8 in sequence and rewires how members get business context. `aab discuss summarize` already produces the `ConversationSummary` payload Phase 1.5 auto-ingest will consume, and `render-discussion-markdown.ts` already renders the deterministic transcript Phase 1.5 will drop into `raw/discussions/`. After that: Phase 6.6 chunk 2 (data-testid + a11y pass so Playwright MCP can catch regressions on the new Knowledge tab), then Phase 4 (Kanban CRUD + extract from discussion), then Phase 5 (skill creator, the headline feature).

---

## How to update this file

When you finish an item:

1. Change `- [ ]` → `- [x]` on the line.
2. If the phase has all items checked, flip its emoji from 🟡 to ✅ in the heading.
3. Add a one-line note under "What's running right now" if it's a meaningful milestone.

When you start an item:

1. Add a 🟡 emoji to the section heading if not already there.
2. Optionally add `(in progress)` after the bullet text.
