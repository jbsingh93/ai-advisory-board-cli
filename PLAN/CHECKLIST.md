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

## Phase 1.5 — Knowledge Wiki (Karpathy-style LLM Wiki) ✅

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

- [x] `src/storage/paths.ts` adds `wiki`, `raw`, `manifest`, `outputs` paths
- [x] `src/core/knowledge/page.ts` — frontmatter parse/serialize (YAML, including `aliases:`), slug ↔ filename helpers, `[[wikilink]]` extraction (including block links `[[slug#section]]`), body kebab-case humanizer
- [x] `src/core/knowledge/manifest.ts` — load/save (atomic), dedup by hash, append entry, mark `userEditedPagesSkipped`
- [x] `src/core/knowledge/schema-emitter.ts` — emits `wiki/KNOWLEDGE.md` from a string template (per `KNOWLEDGE_WIKI.md` §12, including the slug-map resolver instructions and the no-transclusion/no-block-id rules)
- [x] **`src/core/knowledge/slug-map.ts`** — build slug-map (slug+aliases → path) from a wiki walk; render into `wiki/index.md` between `<!-- AAB:SLUG-MAP -->` and `<!-- /AAB:SLUG-MAP -->` sentinels; parse back from the rendered table (the latter is what query/lint use)
- [x] **`src/core/knowledge/rename.ts`** — atomic cross-file slug rewrite: file path, every `[[old]]` in every page body (including block-link forms `[[old#section]]`), every `related:` entry, every `aliases:` declaration on other pages, every `.manifest.json` `entries[*].producedPages` / `entries[*].updatedPages` / `userEditedPages[*].page` entry, and append a `renames[]` log entry (per `KNOWLEDGE_WIKI.md` §13). Uses workspace mutex. Returns a diff for `--dry-run`.
- [x] **`aab knowledge rename <old-slug> <new-slug>`** — `[--dry-run]` `[--auto-fix]` `[--reconcile]` (the last reconciles manifest with filesystem after a Foam-driven move; see `KNOWLEDGE_WIKI.md` §17 and §22)
- [x] **`aab knowledge show <slug>`** — pretty-prints `[[slug]]` references using the slug-map (`slug ("Target Title")` for resolved, `[[slug]] ⚠ unresolved` for unresolved)
- [x] `aab init` writes `wiki/KNOWLEDGE.md`, empty `wiki/index.md` **(with empty `<!-- AAB:SLUG-MAP -->` / `<!-- /AAB:SLUG-MAP -->` sentinels in place)**, empty `wiki/log.md`, empty `.manifest.json`, empty `outputs/` and `raw/{files,urls,pasted,discussions,summaries}/` dirs (idempotent — never overwrites existing)
- [x] `aab init`-emitted `.gitignore` template recommends `raw/` (sensitive sources) but NOT `wiki/` (committable curated knowledge)
- [x] **`aab init --foam`** writes `.vscode/extensions.json` recommending `foam.foam-vscode` (toggleable via `knowledgeWiki.recommendFoam`, default true)
- [x] **`aab doctor`** adds info-level check: if `wiki/` exists but no `.vscode/extensions.json` recommends Foam, suggest `aab init --foam`

### Chunk 2 — File / text / paste ingest

- [x] `src/core/prompts/skill-ingest.ts` — the ingest prompt template (per `KNOWLEDGE_WIKI.md` §15.1). Prompt instructs the agent to **read the slug-map in `wiki/index.md` first** so `[[wikilinks]]` it emits resolve correctly to existing pages.
- [x] `src/core/knowledge/ingest.ts` — orchestrates: hash → manifest dedup → write to `raw/<bucket>/` → run ingest agent → parse JSON output → **call `slug-map.ts:renderSlugMap()` to rebuild the `<!-- AAB:SLUG-MAP -->` section in `wiki/index.md`** (per `KNOWLEDGE_WIKI.md` §11.3 + §15.1 step 5) → atomic manifest update
- [x] `aab knowledge ingest <path>` — md, txt, pdf paths
- [x] `aab knowledge ingest --paste` — read from stdin
- [x] `aab knowledge ingest --force` — re-ingest even when hash already in manifest
- [x] `--json` output

### Chunk 3 — URL ingest

- [x] WebFetch → `raw/urls/<hash6>.md`
- [x] `raw/urls/<hash6>.meta.json` ({ url, fetchedAt, title, contentHash })
- [x] `aab knowledge ingest <url>` (auto-detected as URL by `http(s)://` prefix)
- [x] `--force` re-fetches and re-ingests

### Chunk 4 — Member + orchestrator integration

- [x] `src/agents/emit-member-agent.ts` appends the Knowledge Wiki stanza (per `KNOWLEDGE_WIKI.md` §14) to the AAB:GENERATED block of every member file. **The stanza tells members the slug-map lives in `wiki/index.md` between `<!-- AAB:SLUG-MAP -->` sentinels and how to resolve `[[wikilinks]]` (cheap-pass slug-map → Glob fallback).**
- [x] `src/core/discussion/orchestrator.ts:51` — `allowedTools = ['Read', 'Grep', 'Glob']`
- [x] Settings: `knowledgeWiki.exposeToMemberAgents: true`, `knowledgeWiki.exposeToOrchestrator: true`
- [x] `aab members sync-agents` regenerates with the new addendum (one-time op for existing workspaces)
- [x] Smoke test: a member call on a wiki-populated workspace shows `Read` / `Grep` tool calls in the stream-json events. The member's structured response `sources` field contains at least one resolved wiki slug.

### Chunk 5 — Auto-ingest hook on discussion conclude

- [x] `src/core/discussion/conversation-flow.ts` post-conclude: render transcript → `raw/discussions/<humanized>.md`, render summary → `raw/summaries/<humanized>.md`, run ingest agent
- [x] Wrapped in try/catch — failed ingest never blocks discussion completion (logs to `wiki/log.md` with `[ingest-failed]` prefix)
- [x] Settings: `knowledgeWiki.autoIngestDiscussions: true` (default)
- [x] User HITL responses (`aab discuss respond` bodies) auto-ingest as paste-style raw inputs (settings: `knowledgeWiki.autoIngestUserResponses: true`)
- [x] `aab knowledge backfill <discussion-id>` — manually run the hook for a past discussion

### Chunk 6 — Query + Lint + interlinking-maintenance commands

- [x] `src/core/prompts/skill-query.ts` — query prompt template (mirrors the §14 member addendum on slug-map resolution)
- [x] `src/core/knowledge/query.ts` — one-shot Sonnet call with Read/Grep/Glob, max 15 turns
- [x] `aab knowledge query "<question>"` — supports `--max-pages`, `--out`, `--save-as concept|entity|...`
- [x] `src/core/knowledge/lint.ts` — full procedure per `KNOWLEDGE_WIKI.md` §15.3:
  - Static checks: slug+alias uniqueness (global namespace), frontmatter completeness, broken `[[wikilinks]]`, broken `[[slug#header]]` anchors, **forbidden link forms** (path-prefixed `[[concepts/foo]]`, transclusion `![[slug]]`, block IDs `[[slug#^id]]`), broken `sources:`, orphans, **manifest drift** (entries pointing to deleted files → suggest `aab knowledge rename --reconcile`), **alias cap** (warn at 80, error past 100), **sentinel integrity** (both halves of `<!-- AAB:BACKLINKS -->` / `<!-- AAB:SLUG-MAP -->` present where expected)
  - LLM passes (`fastModel`): contradictions, stale claims, missing concepts (referenced ≥3×)
- [x] **Lint maintains the slug-map** in `wiki/index.md` between the `<!-- AAB:SLUG-MAP -->` sentinels (idempotent rebuild — same `renderSlugMap()` function ingest uses)
- [x] **Lint maintains per-page backlinks** between `<!-- AAB:BACKLINKS -->` sentinels in every page (regenerated each run; the only writer)
- [x] **Lint's allowed tools:** `Read, Grep, Glob, Write` — Write is restricted to slug-map section, backlinks sections, and `outputs/lint-<date>.md`. Lint MUST NOT touch page bodies outside sentinels.
- [x] `aab knowledge lint [--write]` — writes `outputs/lint-<yyyy-mm-dd>.md`, prints summary counts
- [x] **`aab knowledge unresolved [--json] [--suggest-fixes]`** — fast on-demand sibling of lint, no LLM call (~milliseconds); lists every `[[wikilink]]` whose target slug doesn't exist; `--suggest-fixes` fuzzy-matches against existing slugs
- [x] **`aab knowledge related <slug> [--depth N] [--out <path>]`** — link-graph walker (outgoing `[[wikilinks]]` + incoming backlinks; default depth 1, max 5). Used by the ingest agent before filing a page so it sees the local neighborhood.

### Chunk 7 — Migrate + retire BusinessContext

- [x] `src/core/knowledge/migrate.ts` — converts `BusinessContext` items + `BusinessProfile` blob into wiki pages per the mapping table at `KNOWLEDGE_WIKI.md` §19
- [x] `aab knowledge migrate [--dry-run] [--force-schema]` — idempotent
- [x] `loadBusinessContextSafe` returns `[]` when `wiki/` exists; falls back to `business-context.json` when not (transition window)
- [x] Delete inline business-context block from `src/core/discussion/build-user-message.ts:65-69, :103-123`
- [x] Rename `business-context.json` → `business-context.json.migrated.bak` after successful migrate
- [x] Drop `loadBusinessContext` / `saveBusinessContext` / `updateBusinessContext` / `deleteBusinessContext` from `src/storage/fs-storage-service.ts:165-186` after migrate
- [x] Delete `BusinessContext` and `BusinessProfile` types from `src/storage/types.ts:242-276`

### Chunk 8 — Web UI: Knowledge tab (with `[[slug]]` preprocessor as MVP)

- [x] Sidebar item: **Knowledge** (graph icon)
- [x] Default view: graph (force-directed; nodes = pages by type, edges = wiki-links; hover for `summary:`)
- [x] Page list view (sortable table; type/orphan filter chips)
- [x] Page detail view (rendered markdown + frontmatter sidebar + sources links + backlinks list + edit button)
- [x] **`gui/wikilinks.js` — MVP `[[slug]]` preprocessor** (per `KNOWLEDGE_WIKI.md` §18.1): turns resolved `[[slug]]` into `<a href="#/wiki/slug" title="<summary>">Title</a>`; unresolved `[[foo]]` renders as `<span class="wiki-unresolved">[[foo]]</span>` (red); `[[slug|Display]]` honors display text; `[[slug#section]]` block links scroll to the matching `<h2 id>` anchor; `![[slug]]` renders literal with deferred-feature tooltip
- [x] Slug-map fetched from `GET /api/knowledge/state`, cached client-side, **invalidated on `wiki_ingest_done` WS event**
- [x] Backlinks panel in page-detail sidebar reads the `<!-- AAB:BACKLINKS -->` section from the page file (no re-computation — the file is source of truth)
- [x] Raw sources list view (table + filter)
- [x] Ingest panel (drag-drop file zone + URL input + paste textarea; streams progress over WS)
- [x] Query panel (textarea + answer with clickable citations)
- [x] Lint panel (run-now + render latest report)
- [x] WS events: `wiki_ingest_started`, `wiki_ingest_page_written`, `wiki_ingest_done`, `wiki_query_started`, `wiki_query_done`, `wiki_lint_done`
- [x] REST endpoints: `/api/knowledge/{state,pages,pages/:slug,ingest,ingest/discussion/:id,query,lint,graph,raw,raw/:hash}`. `state` response includes the slug-map for client-side caching.

### Cross-cutting (this phase)

- [x] `aab knowledge list [--type ...] [--orphans] [--user-edited]`
- [x] `aab knowledge show <slug>` (rendered: frontmatter + body + backlinks; `[[slug]]` references pretty-printed via slug-map)
- [x] `aab knowledge edit <slug>` (opens `$EDITOR`, marks `userEdited: true`; preserves content inside `<!-- AAB:BACKLINKS -->` and `<!-- AAB:SLUG-MAP -->` sentinels verbatim)
- [x] `aab knowledge open <slug>` (prints absolute path)
- [x] `aab knowledge stats` (page counts by type, total raw sources, last ingest, total ingest cost, slug count + alias count)
- [x] `aab knowledge graph [--out <path>]` (DOT format link graph)
- [x] **`aab knowledge rename <old> <new> [--dry-run] [--auto-fix]`** (chunk 1)
- [x] **`aab knowledge related <slug> [--depth N] [--out <path>]`** (chunk 6)
- [x] **`aab knowledge unresolved [--json] [--suggest-fixes]`** (chunk 6)
- [x] Settings namespace: `knowledgeWiki.{enabled, autoIngestDiscussions, autoIngestUserResponses, ingestModel, queryModel, lintStaleDays, maxAgentPagesPerCall, pageBodySoftCap, summarySoftCap, exposeToMemberAgents, exposeToOrchestrator, recommendFoam, slugMapInIndex, maxAliasesGlobal}` — all overridable via `aab settings set`
- [x] `src/storage/types.ts:300` adds `knowledgeWiki` to `AppSettings` with seeded defaults
- [x] `aab init [--foam]` flag (chunk 1) and `aab doctor` Foam check (chunk 1)
- [x] Tests: unit (`page.test.ts`, `manifest.test.ts`, `slug.test.ts`, **`slug-map.test.ts`** for sentinel render/parse round-trip, **`rename.test.ts`** for atomic cross-file rewrite, **`wikilinks.test.js`** for the Web UI preprocessor), integration (mocked Claude — `ingest-file.test.ts`, `auto-ingest.test.ts`, `migrate.test.ts`, `lint.test.ts`), golden-file (`skill-ingest.golden.md`, `skill-query.golden.md`)
- [x] Live test (`AAB_LIVE_TEST=1`): real PDF + URL + discussion conclude → manifest grows, agent answers wiki-grounded query, slug-map in `wiki/index.md` reflects every page, `aab knowledge rename` round-trip leaves zero broken links

---

## Phase 2 — Members + Principles + Coach ✅

### Members CRUD

- [x] `aab members list` — flat or `--json` output; `--active` / `--inactive` filters
- [x] `aab members show <name>` — full persona / voice / tools (resolves by id, short-id, or partial name)
- [x] `aab members add` — interactive (name, title, expertise, persona OR `--enhance <type>`)
- [x] `aab members edit <id|name>` — interactive field-by-field edit (also accepts flag-only edits for scripting)
- [x] `aab members enhance <id> [--type famous|expert|non-famous] [--keep-voice]` — AI-fill persona + voiceGuide via `claude -p`
- [x] `aab members delete <id> [--yes]` — also removes `.claude/agents/<slug>.md`
- [x] `aab members sync-agents [--agents-dir <path>] [--all]` — regenerate all agent files (preserving `# AAB:GENERATED` marker)
- [x] `aab members tools <id> [--allow ... | --deny ... | --reset]` — per-member tool allowlist override
- [x] `aab members regenerate-voice <id> [--keep-old]` — voice-guide-only refresh

#### Members UI (`gui/`; basic CRUD already shipped in 6.5)

- [x] "Enhance with AI" button in member edit modal — opens type selector (famous / expert / non-famous), streams generation over WS (`member_enhance_started|_progress|_done|_failed`), fills persona + voiceGuide fields on completion
- [x] Per-member tool allowlist editor — chip-based add/remove for `WebSearch`, `WebFetch`, `Read`, `Grep`, `Glob`; saves to member record + rewrites `.claude/agents/<slug>.md` `tools:` frontmatter. Empty selection coerced to `undefined` server-side so the default palette applies.
- [x] "Regenerate agent files" button in members header — calls `POST /api/members/sync-agents`; toast confirmation with count
- [x] "Regenerate voice" button per member card — calls voice-only refresh; preview-before-save dialog (browser `confirm()`)

#### Members MCP regression specs (`specs/`)

- [x] `specs/members-enhance.md` — open edit modal → click "Enhance with AI" → choose type → wait for streamed completion → fields populated → save → reload → persisted
- [x] `specs/members-tools-allowlist.md` — open member → add a tool chip → save → reopen → persisted → on disk `.claude/agents/<slug>.md` frontmatter `tools:` line reflects the change
- [x] `specs/members-sync-agents.md` — click "Regenerate agent files" → toast confirmation → `.claude/agents/` directory listing matches active member count

### Persona generation

- [x] `src/core/members/ai-enhancer.ts` — three template variants (`famous` / `expert` / `non-famous`) calling `runClaude` (no Gemini), tolerant JSON parsing with regex fallback, BFI-2 + Cognitive Process suffix on famous variant
- [x] `src/core/members/voice-guide.ts` — voice-only generator on the fast model (default Haiku), schema-validated, hardcoded fallback on parse/spawn failure
- [x] `src/core/members/fallback-voice-guides.ts` — hardcoded fallback voices keyed by first name (Elon, Jobs, Bezos, Buffett, Graham/Reid → distinct prompts; otherwise generic with expertise context)
- [x] `src/core/parsing/persona-schemas.ts` — zod schemas (`enhancementPayloadSchema`, `voiceGuidePayloadSchema`)

### Principles

- [x] `aab principles list [--category ...] [--active|--inactive]`
- [x] `aab principles show <id|title>` — full detail with description / behavior / anti-pattern / triggers / examples
- [x] `aab principles add` — interactive
- [x] `aab principles edit <id|title>` — interactive (and flag-only non-interactive)
- [x] `aab principles delete <id|title> [--yes]`
- [x] `aab principles seed-starters [--force]` — re-seed 8 starters into existing workspace
- [x] `aab principles explore [--principle <id>]` — Socratic 5-step wizard (behavior → anti-pattern → triggers → examples → priority); `--auto-accept` for non-interactive; `--save-as-new` to clone a refined draft

#### Principles UI (`gui/`; basic CRUD already shipped in 6.5)

- [x] "🔎 Explore" button per principle card — opens `#explorer-modal` 5-step Socratic wizard (behavior → anti-pattern → triggers → examples → priority); the working-draft preview updates as steps are accepted; cross-step context posted to `/api/principles/explore-step`
- [x] "🌱 Seed starters" button in principles header — disabled when principles already exist; one-click seeds the 8 Dalio-inspired starters via `POST /api/principles/seed-starters`

#### Principles MCP regression specs (`specs/`)

- [x] `specs/principles-explore-wizard.md` — click "Explore" on a principle → step 1 renders → answer → step 2 references step 1 answer → ... → step 5 → "Save" persists wizard output back into principle body
- [x] `specs/principles-seed-starters.md` — empty workspace → "Seed starters" button visible and enabled → click → 8 cards appear → button disabled on second visit

### Decision Coach

- [x] `aab coach [--situation <text>] [--title <text>] [--resume <id>]` — REPL session with persisted state
- [x] `aab coach send <sessionId> <message>` — one-shot non-interactive turn (used by smokes)
- [x] `aab coach show [<sessionId>]` — list past sessions or show one
- [x] `aab coach delete <session> [--yes]`
- [x] `aab coach decide <session> <decision>` — record a recorded decision + flip status to `decided`
- [x] `src/core/coach/decision-coach.ts` — `buildDecisionCoachSystemPrompt` injects user's principles ordered by priority desc; `coachReply` builds transcript, calls `runClaude`, persists turns, extracts referenced principle ids
- [x] `src/core/coach/principle-explorer.ts` — 5-step explorer flow with cross-step context (`renderCrossStepContext` groups by step), `extractSuggested` regex per step, `applyStep` merges synthesized text into the working draft
- [x] DecisionSession persistence — `loadDecisionSessions / loadDecisionSessionById / saveDecisionSession / updateDecisionSession / deleteDecisionSession` added to `StorageService` interface; one JSON file per session under `decision-sessions/`; updated-desc sort for list display

#### Decision Coach UI (`gui/`)

- [x] Sidebar item: **🧠 Coach** opens chat view (`data-route="coach"`, `data-testid="nav-coach"`)
- [x] Coach chat view — message bubbles with principle-referenced footnotes (cross-referenced against `state.principles` to render readable names); "Coach thinking…" indicator while WS is in flight
- [x] Session list panel — past sessions sorted by recency; click to resume; delete button per row with confirm modal
- [x] "+ New session" button — opens the shared edit modal with `Title` + `Situation` fields; on save posts to `/api/coach/sessions` and auto-fires the opener turn via the WS event

#### Decision Coach MCP regression specs (`specs/`)

- [x] `specs/coach-chat.md` — open Coach → send message → streaming response renders → send follow-up → context preserved (response references prior turn)
- [x] `specs/coach-session-list.md` — multiple sessions exist → list shows all sorted by recency → click middle → resumes with full history → delete oldest → confirm → removed from list

### Tests

- [x] `src/core/members/__tests__/ai-enhancer.test.ts` (10 tests) — buildPrompt per type, extractEnhancement JSON / fenced / regex / fallback paths, cleanPersonaText, composeEnhancedPersona
- [x] `src/core/members/__tests__/fallback-voice-guides.test.ts` (5 tests) — name-based recognition + generic expertise fallback
- [x] `src/core/coach/__tests__/decision-coach.test.ts` (11 tests) — buildDecisionCoachSystemPrompt priority order + inactive skip + empty fallback, renderPrincipleForPrompt, newDecisionSession, extractReferencedPrincipleIds, mergeAppliedPrinciples, buildTranscript
- [x] `src/core/coach/__tests__/principle-explorer.test.ts` (23 tests) — system prompt + cross-step context, existing fields, extractSuggested per step (including anti-pattern hyphen variant + triggers numbered list), parseNumberedList, applyStep clamping
- [x] Live CLI smoke (2026-05-19) — `members tools/reset`, `members regenerate-voice "Alexandra"` (real Haiku call), `members enhance "Julian" --type non-famous --keep-voice` (real Sonnet/Opus call), `coach send` (real multi-turn Sonnet flow referencing **Pain + Reflection = Progress**, **Be Direct and Honest**, **Disagree and Commit** by name)
- [x] Live Playwright MCP smoke (2026-05-19) — `🧠 Coach` nav item visible; coach view renders session list + chat detail + composer; Principles tab renders all 8 starters with `🔎 Explore` button per card and **🌱 Seed starters** disabled; Members tab renders **↻ Regenerate agent files** header button + per-card **Edit / 🔊 Voice / Delete**

---

## Phase 3 — Sparring (1:1 deep dive) ✅

- [x] `src/core/sparring/sparring-service.ts` — port with truncation budgets (14k discussion / 8k history / 4k bcontext / 4k anchor). Truncation moved to dedicated `src/core/sparring/truncate.ts` for unit-testability; prompt builder is `src/core/sparring/build-sparring-prompt.ts`; inject-back logic is `src/core/sparring/inject-insight.ts`. Service uses researchModel (Opus) with the member's tool allowlist (default `WebSearch, WebFetch, Read, Grep, Glob`) and falls back to primaryModel (Sonnet) on failure. Token usage logged via `feature: 'sparring'`.
- [x] `aab discuss spar <id> --member <name> [--round N --turn M]` — opens REPL anchored to a response. Also accepts `--message <text>` for one-shot non-interactive mode (used by smokes), `--resume <sessionId>` to continue a saved session, `--title <text>` to label the new session.
- [x] `aab discuss inject <id> --from <session>` — write sparring insight back to main timeline as `sparring_injection`. Default insight = the latest assistant reply; overridable via `--insight "<text>"`; `--yes` skips confirmation prompt.
- [x] `aab discuss spar list <discussion-id>` — list sparring sessions for a discussion (sorted by `updatedAt` desc).
- [x] `aab discuss spar show <session-id>` — view a sparring session transcript (resolves by short-id prefix across all discussions).

### UI (mirrors in `gui/`)

- [x] "Spar" button on each response card in the discussion chat view — `data-testid="spar-btn"` on every `messageBubble`; opens a 1:1 panel anchored to that response's `(memberId, roundNumber, turnNumber)`.
- [x] Sparring panel/view — `data-testid="sparring-modal"` with the anchored response shown as a sticky banner (`data-testid="sparring-anchor"`), transcript area (`data-testid="sparring-transcript"`) with role-styled bubbles, sources sub-section under each assistant reply, typing indicator (`data-testid="sparring-typing"`), composer (`data-testid="sparring-input"` + `sparring-send-btn`, Cmd/Ctrl+Enter shortcut), "↩ Inject insight back" button in the header (`data-testid="sparring-inject-btn"`).
- [x] Sparring session list per discussion — accessed from chat-view header via "⚔ Sparring" button (`data-testid="sparring-sessions-btn"`); modal contains `data-testid="sparring-session-list"` with per-row `data-testid="sparring-session-row"` showing member · round · turn · message count · relative timestamp.
- [x] Inject-confirmation modal — `data-testid="sparring-inject-modal"` with editable textarea (`data-testid="sparring-inject-textarea"`) pre-filled with the latest assistant reply; confirm button `data-testid="sparring-inject-confirm"` posts to `/api/sparring/:id/inject`; on success the sparring_injection lands in the timeline as a user bubble labeled "Sparring insight injected (via <member name>)".

### REST + WS endpoints (`src/gui/server.ts`)

- [x] `GET /api/discussions/:id/sparring` → `{ sessions: SparringSession[] }` (sorted by updatedAt desc).
- [x] `POST /api/discussions/:id/sparring` → `{ session, reused }` — open or resume a session for (memberId, anchorRoundNumber, anchorTurnNumber); broadcasts `sparring_session_opened`.
- [x] `GET /api/sparring/:sessionId` → `{ session }`.
- [x] `DELETE /api/sparring/:sessionId` → 204; broadcasts `sparring_session_deleted`.
- [x] `POST /api/sparring/:sessionId/messages` → 202 + WS stream `sparring_thinking → sparring_activity → sparring_message` (or `sparring_error` on failure).
- [x] `POST /api/sparring/:sessionId/inject` → `{ discussion, injectedUserResponse }`; broadcasts `sparring_injected`.

### Storage

- [x] `SparringSession + SparringMessage + SparringSource + SparringInjectionContext` types added to `src/storage/types.ts`. `UserResponse` extended with `sparringSessionId` plus the existing `sourceRoundNumber / sourceTurnNumber / sparringTriggerInput` fields so `sparring_injection` rows carry full provenance.
- [x] `StorageService` grows `loadSparringSessionsForDiscussion / loadSparringSessionById / saveSparringSession / updateSparringSession / deleteSparringSession / saveSparringMessage`.
- [x] `FsStorageService` implements those — sessions land at `sparring/<discussionId>/<sessionId>.json` (one JSON file per session, atomic writes, sorted by `updatedAt` desc).

### Playwright MCP regression specs (`specs/`)

- [x] `specs/sparring-anchor-deepdive.md` — open discussion → click "Spar" on response (round 2, turn 1) → panel opens with anchor banner → send a message → response streams → close panel → reopen → state preserved.
- [x] `specs/sparring-inject-back.md` — sparring session → click "Inject insight back" → preview modal → confirm → main discussion shows a new bubble with `type: 'sparring_injection'` + full provenance fields.
- [x] `specs/sparring-session-list.md` — discussion with 3 spar sessions → list shows all three sorted by recency → click middle session → resumes with full history.

### Tests

- [x] `src/core/sparring/__tests__/truncate.test.ts` (7 tests) — caps match PLAN §4.3.15 verbatim, head/tail 70/30 split, label-in-marker, minimum-tail-80-chars clamp.
- [x] `src/core/sparring/__tests__/build-sparring-prompt.test.ts` (12 tests) — member identity headers, voice-guide section visibility, anchor framing, rounds rendering with turn numbers, sparring history role prefixes, pendingUserMessage append, giant-context + giant-anchor truncation, no-JSON-wrap directive.
- [x] `src/core/sparring/__tests__/inject-insight.test.ts` (10 tests) — empty-insight guard, no-rounds guard, anchor-round attachment, stale-anchor fallback to latest, provenance fields (`sparring_injection` type, sparringSessionId, sourceRoundNumber/Turn, prompt), `userResponses` append, source-round-userResponse no-clobber semantics, storage.updateDiscussion called once, `sourceRoundNumber` override.
- [x] `src/core/sparring/__tests__/sparring-service.test.ts` (14 tests) — `pickAnchorResponse` (no responses → undefined; exact match; latest-turn-in-round fallback; latest-across-rounds default), `extractSourcesFromText` (no URLs, md links with titles, dedupe, bare-URL fallthrough, 5-source cap, trailing punctuation strip), `openSparringSession` (throws when no anchor; new session creation; idempotency reuse; long-preview truncation with ellipsis).
- [x] Live CLI smoke (2026-05-19) — `aab discuss spar da720e41 --member "Elon Musk" --round 1 --turn 1 --message "Walk me through the unit economics…"` against the `smoke-kw-2026-05-19` workspace produced a real Opus deep-dive (~6kB markdown reply with tiered targets + cost-of-getting-it-wrong tables + "What I'd Actually Mandate in Your Q3 Plan" numbered list). `aab discuss spar list` showed the persisted session; `aab discuss inject <discussion> --from <session> --yes` wrote the `sparring_injection` UserResponse into the discussion with full provenance (sparringSessionId, selectedMemberId, sourceRoundNumber, sourceTurnNumber, prompt: "Injected from 1:1 Deep Dive with Elon Musk"). `aab discuss spar show` reloaded the transcript.
- [x] Live Playwright MCP smoke (2026-05-19) — chat view rendered ⚔ Spar buttons on each `messageBubble`, ⚔ Sparring header button, the injected insight as a user bubble labeled "Sparring insight injected (via Elon Musk)"; clicking ⚔ Spar opened the sparring modal with the anchored response banner, full transcript replay (user + assistant from disk), ↩ Inject insight back button, and the composer; clicking ⚔ Sparring opened the session list modal showing "Sparring sessions · 1" with the Elon Musk · round 1 · turn 1 row.

---

## Phase 4 — Action Board (Kanban) ✅

(Per Part 6 scope cut: kanban tracking + skill-only solve. Multi-agent solve / artifact mode / deliverable types are NOT in scope.)

### Kanban CRUD

- [x] `aab actions add "<title>" [--description] [--priority high|medium|low] [--due YYYY-MM-DD]`
- [x] `aab actions list [--status pending|in-progress|completed] [--priority ...]`
- [x] `aab actions board [--watch] [--filter ...]` — 3-column ANSI Kanban view
- [x] `aab actions show <id>` — detail: title, description, status, linked discussion, linked skill runs
- [x] `aab actions edit <id>` — interactive
- [x] `aab actions move <id> pending|in-progress|completed`
- [x] `aab actions delete <id> [--cascade]`

### Auto-extract from discussions

- [x] `aab actions extract <discussion-id>` — structured-data fast path, LLM fallback when no `structuredData`
- [x] `src/core/actions/conversation-analyzer.ts` (port; Phase 1 noted it as supporting)

### UI (mirrors in `gui/`; replaces read-only kanban view)

- [x] Drag-drop columns (pending → in-progress → completed) — cards reorder + change status; persisted via `/api/actions/:id` PATCH; optimistic update + WS reconciliation
- [x] Add-action modal — title, description, priority chip, due-date picker; submits to `/api/actions`
- [x] Inline edit (click card → expand to detail panel) — fields editable, save persists, cancel reverts
- [x] "Extract actions" button on concluded discussions — runs analyzer, surfaces candidate actions in an accept/reject list; accepted candidates become kanban cards
- [x] Card detail panel — linked-discussion link (anchor to round), linked skill-runs list, "Solve" button (Phase 5 dependency)

### Playwright MCP regression specs (`specs/`)

- [x] `specs/actions-kanban-dragdrop.md` — drag card pending → in-progress → reload → status persisted
- [x] `specs/actions-add-edit.md` — open add modal → fill fields → submit → card appears in pending → click card → edit description → save → reload → persisted
- [x] `specs/actions-extract-from-discussion.md` — concluded discussion → click "Extract actions" → candidate list renders → accept 2 reject 1 → kanban shows the 2 accepted

---

## Phase 5 — Skill creator (the killer feature) ✅

**Spec:** `PLAN/SKILL_CREATOR.md` (authoritative — read this first).
**Plan section:** `PLAN/PLAN.md` Part 6 (Action Board scope cut) with the 2026-05-20 redirect banner pointing back here.
**External references:** [Anthropic Engineering, "Equipping agents for the real world with Agent Skills" (Oct 2025)](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills); [Anthropic, "Skills for organizations, partners, the ecosystem" (Dec 2025)](https://claude.com/blog/organization-skills-and-directory); [`anthropics/claude-plugins-official` skill-creator skill](https://github.com/anthropics/claude-plugins-official); [Claude Code skills doc](https://code.claude.com/docs/en/skills); [Claude for Chrome (Dec 2025)](https://claude.com/blog/claude-for-chrome).

**Locked decisions (2026-05-20, do not renegotiate without fresh user input):**

1. **Thin orchestrator around Anthropic's official `skill-creator` skill** — the 14-prompt + single-loop + critic + repair + potency + security + trigger-evaluator pipeline from sage-council is **NOT ported**. Anthropic ships `skill-creator` with ~117k weekly installs and we delegate to it.
2. **The headline of Phase 5 is the agentic Skill Planner**, not the skill emit. The Planner runs read-only recon across PC + Wiki + Web, then reasons creatively about how to maximize user value via multi-tool orchestration (the "Elgato moment"). Without the Planner, the emit is uninteresting; with it, the emit is an autonomous worker.
3. **Maximalist tool surface with user gating** — Planner detects everything; user opts in per capability; granted tools become the emitted skill's `allowed-tools`. The Planner proposes ≥3 multi-tool orchestrations on the maximalist tier (hard schema gate).
4. **`skill-creator` is a hard prerequisite** with auto-offer-to-install (`aab init --install-skill-creator`; `aab doctor` check).
5. **Headless invocation via `claude -p --append-system-prompt-file`** — only non-interactive path today; tracking [anthropics/claude-code#38505](https://github.com/anthropics/claude-code/issues/38505).
6. **Broad auto-detect, opt-in grant** — full PC inventory + MCP servers + env vars + browser extensions + Playwright + Claude for Chrome; user accepts per integration in the Planner proposal modal.
7. **Read-only PC scan invariant** — the recon module never writes a file, modifies a registry key, calls a network endpoint, or invokes anything with side effects. Lint-enforced (`no-side-effects-in-recon`); CI-gated.
8. **Skills are agents, not prompt packs.** Emitted skills should execute work end-to-end, not produce documentation about the work. The proposed workflow + stakeholder touchpoints + integration list in the brief is what drives skill-creator toward agentic output.

### Chunk 1 — skill-creator detection + install bootstrap ✅

- [x] `src/core/skill/resolve-skill-creator.ts` — walks the skill scope priority order (project → user → plugin) to find `skill-creator/SKILL.md`; returns path + version + scope or null
- [x] `aab init --install-skill-creator` — surfaces the exact `/plugin install skill-creator@claude-plugins-official` command (since `/plugin install` itself is interactive-only today); see [GitHub issue #38505](https://github.com/anthropics/claude-code/issues/38505)
- [x] `aab doctor` adds: skill-creator presence + version check; PC scan probe; web reachability probe
- [x] Unit tests: scope walking; version extraction from SKILL.md frontmatter (12 tests)
- [x] Live smoke: external test folder doctor pass — skill-creator detection works against a stubbed skill-creator at `.claude/skills/skill-creator/`; PC scan probe surfaces platform + cli-tool count; web reachability returns latency to www.anthropic.com

### Chunk 2 — Skill Planner: recon (PC scan + Wiki + Web) ✅

- [x] `src/core/skill/recon/pc-scan.ts` — platform-dispatched read-only PC inventory (Windows / macOS / Linux) per SKILL_CREATOR.md §6.2; pure function (`os` + `fs` + `child_process` injected); never writes or hits the network
- [x] `src/core/skill/recon/wiki-recon.ts` — one Sonnet call with `Read/Grep/Glob/maxTurns:8`; returns `WikiContext` (relevantPages, stakeholders, endorsedDirections, vetoes, pastDecisions); dual-path role extraction (frontmatter `role:` if present, body extraction otherwise)
- [x] `src/core/skill/recon/web-recon.ts` — two-pass design (T1.3): general task research (`WebSearch + WebFetch + maxTurns:12`) + per-detected-app integration-surface research (top 5 apps × `maxTurns:6`); returns `WebResearchContext` with `appIntegrationSurfaces[]`
- [x] `src/core/skill/recon/orchestrator.ts` — runs all three in parallel via `Promise.allSettled`; aggregates; handles partial failures gracefully via per-phase warning slots; emits `planner_recon_progress` + `planner_recon_done` events
- [x] `src/core/skill/recon/web-probe.ts` — fast HEAD against anthropic.com for `aab doctor`
- [x] Unit tests: env-var allowlist (80+ patterns), quick probe, schema validation of wiki + web responses, top-app picker (19 tests across pc-scan, wiki-recon, web-recon)

### Chunk 3 — Skill Planner: reasoning + user review ✅

- [x] `src/core/prompts/skill-planner.ts` — the Planner system prompt template (**the most important prompt in the CLI**); embeds skill operating model preamble + master-gpt-prompter hardening (reasoning/tool/autonomy/self-verification blocks) + ambition directive (≥3 maximalist hard gate) + orchestration directives (chrome-extension + computer-use first-class) + invocation_hint_directive with 5 worked examples + JSON output contract + 3 condensed few-shot examples (Elgato + pricing + LinkedIn chrome-extension) inline
- [x] `src/core/skill/planner.ts` — orchestrates the Opus 4.7 1M-context reasoning call; inputs: action + linked discussion summary + recon triple; validates against `skillDesignProposalSchema` + semantic gates (kebab-case name, ≥3 integrations, ≥2 source types, reserved-name refusal); re-runs once with stronger nudge in `<replan_feedback>` on validation failure; streams token-progress events
- [x] `src/core/parsing/llm-response-schemas.ts` — added `skillDesignProposalSchema` (zod, passthrough) with full Integration / Stakeholder / Workflow / Warning / Mismatch sub-schemas + `validateProposalSemantics` for the hard gates that go beyond shape + `RESERVED_SKILL_NAMES` set
- [x] `src/core/skill/planner-review.ts` — interactive `enquirer` review flow: tier radio + multi-select per integration + per stakeholder + narrative editor + re-plan loop; deterministic `projectGrantedTools` projection from accepted integrations; `renderProposalMarkdown` for `--out`/export
- [x] `aab actions plan <id>` — first-class command; runs Chunks 2 + 3, prints/saves proposal markdown via `--out <path>`, exits without invoking skill-creator
- [x] Unit tests: prompt rendering covers all required directives (8 tests), proposal schema validation positive+negative (5 tests), semantic gates including empty-recon fallback (5 tests), grantedTools projection determinism + sort + dedup (3 tests), review acceptance helpers (3 tests) — 25 tests total

### Chunk 4 — skill-creator invocation + adapter + install ✅

- [x] `src/core/skill/build-brief.ts` — assembles JSON brief from action + discussion + **accepted Planner proposal verbatim** + capability profile + install target per SKILL_CREATOR.md §7; truncates over 60 KB in priority order (recentInnovations → integration citations → narrative edits last); `renderUserMessage` includes `SKILL_CREATOR_DONE:` sentinel for robust completion detection
- [x] `src/core/skill/invoke-skill-creator.ts` — headless spawn with `--append-system-prompt-file` pointing at skill-creator's SKILL.md; allowed-tools `Write,Edit,Read,Glob,Bash`; cwd = run workspace tempdir; default 20 min timeout; streams events via `outputFormat: 'stream-json'`; `walkWorkspace` collects EmittedFile[] for the install + adapter pipeline; `stubSkillCreatorRun` test path that writes a synthetic SKILL.md (used by `aab actions solve --stub`)
- [x] `src/llm/claude-code-runner.ts` — added `appendSystemPromptFile` + explicit `outputFormat` options to `RunOptions`
- [x] `src/core/skill/adapter.ts` — frontmatter normalization per SKILL_CREATOR.md §9; hand-rolled YAML parse/serialize (no heavy dep); auto-injects missing `name`/`description`/`Use when ...`; reconciles `allowed-tools` against `grantedTools` (logs diff); folds sage-council-invented keys into body; defaults `model: inherit`; reserved-name refusal; scaffolds SKILL.md if skill-creator emitted none
- [x] `src/core/skill/install.ts` — `cp -r workspace → .claude/skills/<name>/` (project) or `~/.claude/skills/<name>/` (user); conflict handling (overwrite-archives | rename `<name>-2` | abort); per T3.9 sidecar lives at `<workspaceRoot>/skill-runs/<runId>/installed-at.json` (NOT inside the installed skill dir); snapshot retention rotates to most recent N (default 5)
- [x] `src/core/skill/persist-run.ts` — writes `SkillGenerationRun` with **full Planner proposal embedded in `metadata.plannerProposal`**; updates `ActionItem.linkedSkill` + `skillRunHistory[]`; writes side-by-side `<runId>.proposal.md` artifact (`.md` filtered out of `loadSkillRuns`'s `*.json` glob); archives workspace per `preserveWorkspaceOnSuccess` setting
- [x] `src/core/skill/solve-orchestrator.ts` — top-level `runSolve` chains the four pipeline phases; emits typed `SolveEvent` stream the CLI + GUI both consume; handles `noPlanner` synthesis path, `preAcceptedProfile` (GUI re-entry), `planOnly` early-exit, `noInstall`, budget cap enforcement, stub mode
- [x] `aab actions solve <id>` end-to-end command with all SKILL_CREATOR.md §5 flags (`--no-planner`, `--planner-tier`, `--planner-no-web`, `--planner-no-pc-scan`, `--planner-no-wiki`, `--skill-name`, `--scope`, `--no-install`, `--budget-cap-usd`, `--stub`, `--yes`)
- [x] Unit tests: brief assembly with embedded proposal + 60KB truncation order (5 tests), frontmatter parse/serialize + adapter diff against grantedTools + reserved-name refusal + scaffold path (9 tests), install conflict resolution + sidecar location + snapshot rotation (3 tests), solve orchestrator end-to-end with `--no-planner --stub --yes` + plan-only + --no-install variants + skill-creator missing failure (7 tests) — 24 tests total
- [x] **Live smoke (the big one):** stub-mode `actions solve d525be59 --no-planner --stub --yes` on external test folder completed in 315ms end-to-end — produced a valid SKILL.md at `.claude/skills/phase-5-smoke-action/` matching the deterministic `grantedTools` projection (`Read, Write, Glob, Grep`); `linkedSkill` populated on the action item; `actions runs show <run-id>` renders the embedded Planner proposal; `skills list` shows it at project scope; `skills uninstall` archives it to `.snapshots/skills/phase-5-smoke-action-<ts>/`. Real-Claude live smoke against Recipe A/D/E/F left to the user — the orchestrator + brief + adapter + install + persist pipeline is verified to work without burning tokens via the stub path; the only difference at real invocation is the skill-creator authoring quality.

### Chunk 5 — `aab actions runs` + `aab skills` commands ✅

- [x] `aab actions runs list [actionId]` — flat list with shortId + status icon + skill name + linked action + cost + duration
- [x] `aab actions runs show <runId>` — pretty-prints metadata + embedded Planner proposal markdown render + cost + duration + install path + file count
- [x] `aab actions runs export <runId> [--zip <path>]` — writes the emitted SKILL.md + supporting files + a re-rendered `proposal.md` into a directory (v1 — `jszip` deferred to Phase 5.5)
- [x] `aab actions runs delete <runId>` — removes a single run record
- [x] `aab skills list` — enumerates installed skills across project + user + plugin scopes via the same scope walker as `resolveSkill`
- [x] `aab skills show <name>` — pretty-prints SKILL.md
- [x] `aab skills test <name> [input...]` — round-trip via `claude -p --append-system-prompt-file`; captures transcript
- [x] `aab skills uninstall <name>` — archives to `.snapshots/skills/<name>-<timestamp>/`
- [x] `aab skills restore <name> [--snapshot <ts>]` — restores from `.snapshots/skills/`
- [x] Live smoke: `actions runs show c47ee06b` rendered the full embedded proposal end-to-end; `skills list` enumerated both the user-installed skill and the stubbed skill-creator at project scope; `skills uninstall` archived cleanly

### Chunk 6 — Web UI + WS events + Playwright MCP specs ✅

- [x] REST endpoints per SKILL_CREATOR.md §14: `POST /api/actions/:id/plan` (returns 202 + planId; runs async, streams over WS), `GET /api/plans/:planId` (?as=md → proposal markdown), `POST /api/plans/:planId/replan`, `POST /api/actions/:id/solve` (accepts `planId` to reuse a previously-cached profile), `GET /api/actions/:id/runs`, `GET /api/skill-runs/:id`, `DELETE /api/skill-runs/:id`, `GET /api/recon/environment` (fast read-only PC scan), `GET /api/skills`, `GET /api/skills/:name`
- [x] WS event family per SKILL_CREATOR.md §12 + §14: `planner_started`, `planner_recon_progress`, `planner_recon_done`, `planner_reasoning_started`, `planner_proposal_ready`, `planner_failed`, `skill_run_started`, `skill_run_tool_call`, `skill_run_adapter_diff`, `skill_run_installed`, `skill_run_failed`, `skill_run_cancelled` — coerced via `coerceSolveEventForWs(evt, id)` so the planId/runId is always at the top level
- [x] `gui/app.js`:
  - [x] Plan button + Solve button on every action card (Solve calls `launchSkillPlan` then triggers `/solve` from the Accept handler — two-step UX so the user always reviews before burning tokens)
  - [x] **Planner progress pane** with 4-phase grid (pc-scan / wiki / web / reasoning) + live tool-call stream (last 20 rows)
  - [x] **Planner proposal modal** with tier radio (minimal/standard/maximalist) + per-integration toggle rows + per-stakeholder toggle rows + narrative editor textarea + cost line + Accept / Re-plan / Reject / Export-md buttons
  - [x] **Re-plan feedback modal** (textarea with ≥10 char guard + submit, server enforces max-3 cap)
  - [x] Run-detail modal (reused from Skills tab — shows SKILL.md body in a `<pre>` block)
  - [x] Skills tab in sidebar (🧠 Skills) — lists installed skills with show + test buttons; test copies an `aab skills test` command to clipboard rather than running it in-browser (the round-trip spawns a long-running `claude -p` call we don't want to surface mid-page)
- [x] `gui/style.css` — `.kanban-card-actions`, `.planner-phase` (color-coded by status), `.planner-stream`, `.planner-proposal`, `.planner-tier-row`, `.planner-rationale`, `.planner-integration-row`, `.planner-stakeholder-row`, `.planner-kind`, `.planner-cost`, `.skills-view`, `.skills-row`, `.skill-detail-body`
- [x] `data-testid` registry per SKILL_CREATOR.md §14: `nav-skills`, `solve-btn`, `plan-btn`, `planner-progress-pane`, `planner-phase-{pc-scan,wiki,web,reasoning}`, `planner-proposal-modal`, `proposal-skill-name`, `proposal-tier-radio`, `proposal-integration-row`, `proposal-integration-toggle`, `proposal-stakeholder-row`, `proposal-narrative-editor`, `proposal-accept-btn`, `proposal-replan-btn`, `proposal-reject-btn`, `proposal-export-btn`, `replan-feedback-modal`, `replan-feedback-input`, `replan-feedback-submit`, `run-detail-view`, `skills-tab`, `skills-list`, `skill-show-btn`, `skill-test-btn`
- [x] Playwright MCP regression specs (all 8 shipped):
  - [x] `specs/skill-plan-only.md` — Plan button → proposal modal → export-to-md
  - [x] `specs/skill-planner-maximalist.md` — Recipe A/D → ≥3 integrations across ≥2 surfaces → toggle behavior
  - [x] `specs/skill-planner-replan.md` — proposal modal → Re-plan → feedback ≥10 chars → new proposal mentions feedback keyword
  - [x] `specs/skill-solve-happy-path.md` — full Plan → Accept → solve → install end-to-end with `linkedSkill` populated
  - [x] `specs/skill-run-telemetry.md` — live WS streams `skill_run_tool_call` events → planner stream renders them
  - [x] `specs/skill-install-conflict.md` — overwrite-archives + rename + abort variants
  - [x] `specs/skill-runs-history.md` — list + show + export (with proposal.md inside the bundle)
  - [x] `specs/skills-tab.md` — list + show + test (clipboard copy) + uninstall + restore
- [x] Live Playwright MCP smoke on test workspace — verified end-to-end (2026-05-21): Skills tab + skill detail modal, Action Board Plan/Solve buttons, Plan kicks off `/api/actions/:id/plan` (202+planId), Planner progress pane renders with live `planner_recon_progress` WS events (PC scan: 35 apps + 6 CLI tools live-scanned; wiki recon + web research completed via real Sonnet calls; live stream populated with 3 phase summaries), proposal modal renders all sections correctly (verified via simulated event since the live Opus run on an empty workspace hit the schema-validation retry path and ran long). **Bug caught + fixed via this smoke**: `planner_failed` events fired a transient toast that auto-dismissed after 4.5s, leaving no proof of failure after a 10-min Opus wait. Fix in `gui/app.js`: keep the progress modal open on failure, mark the reasoning phase `data-status="failed"` (red), and render a sticky `<div class="planner-error-banner" data-testid="planner-error-banner">` inside the pane. Reject button + 10-char re-plan guard + close button all verified.

### Out of scope for v1 (deferred)

- [~] Plugin-packaged emitted skills with bundled `.mcp.json` (Path B from SKILL_CREATOR.md §16) — defer to Phase 5.5
- [~] `aab prompts list|edit|reset` user-customisable prompt overrides (including Planner prompt overrides) — defer to Phase 5.x
- [~] Critique panel / reflexion (skill-creator likely handles equivalents internally) — defer indefinitely
- [~] Computer Use API surface in emitted skills — defer until Anthropic documents in-skill pattern
- [~] Direct Claude for Chrome programmatic invocation from skills — defer until Anthropic exposes the surface; treat Chrome as runtime user aid for v1
- [~] Autonomous multi-action Planner ("plan + solve every pending action overnight") — defer to Phase 5.x
- [~] Cross-skill composition planner (Planner notices two related actions and proposes a single multi-step skill) — defer to Phase 5.x

---

## Phase 6.5 — Web UI (messaging-app dashboard) 🟡

**Scope clarified 2026-05-19:** feature-specific UI now lives in the **owning phase** (Phase 2-5 each carry their own `**UI**` subsection). Phase 6.5 is the **polish + cross-cutting + shipped-views index**: the dashboard shell, the views already shipped (Discussions / Members / Actions / Principles / Settings / Knowledge), and the polish backlog (light theme, mobile responsive, token-usage dashboard, per-member color from frontmatter). Stubs below that name a Phase 2-5 feature are kept here for the at-a-glance index but their **authoritative scope is in the owning phase**.

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
- [x] Action add / edit / move / delete UI (drag-drop kanban) _— scope: Phase 4 §UI_
- [x] Principle edit / add / delete UI (active toggle, category select, priority slider; click-to-edit cards)
- [x] Settings editing UI (full form: title, max turns/members, models, budget, locale, HITL toggle)
- [x] Discussion: continue + respond from the UI (Continue button + HITL reply form)
- [x] Discussion: follow-up from the UI (Follow up button + composer with member-chip selector)
- [ ] Discussion: spar from the UI _— scope: Phase 3 §UI_
- [x] Workspace card in sidebar showing scope (home/project), active/total member count, full root path
- [x] Loud empty-state in new-discussion modal when 0 active members (avoids the silent-empty-chips bug)
- [ ] Decision Coach chat view _— scope: Phase 2 §Decision Coach UI_
- [ ] Sparring 1:1 chat view (anchored to a response) _— scope: Phase 3 §UI_
- [ ] Skill-creator run-launch + telemetry + preflight-wizard UI _— scope: Phase 5 §UI_
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

**Scope (added 2026-05-19):** this chunk holds **Phase 1 + cross-cutting** specs only. Phase 2-5 feature specs live in their owning phase's `**Playwright MCP regression specs**` subsection (Phase 2 Members/Principles/Coach, Phase 3 Sparring, Phase 4 Action Board, Phase 5 Skill creator). They land as their feature phase ships — they are not pre-listed here.

- [ ] `specs/discussion-happy-path.md` — new-discussion modal → start with 3 members → wait for round 1 → continue → conclude. No HITL.
- [ ] `specs/discussion-hitl.md` — start → orchestrator gates → HITL panel appears with options → respond with `--option 1` equivalent → round 2 runs.
- [ ] `specs/discussion-follow-up.md` — follow-up `all` / `specific` / `subset` variants via member-chip selector.
- [ ] `specs/members-tab.md` — list / show / activate / deactivate (basic CRUD UI is already shipped in Phase 6.5).
- [ ] `specs/principles-tab.md` — equivalent CRUD coverage (basic CRUD UI is already shipped in Phase 6.5).
- [ ] `specs/knowledge-tab.md` — Phase 1.5 Knowledge tab: page list, page detail with `[[slug]]` resolution, ingest + query + lint panels, slug-map invalidation on `wiki_*` WS events.
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
- [ ] `CONTRIBUTING.md` sections: (a) "UI changes require a Playwright MCP smoke run; reference at `PLAN/PLAYWRIGHT_MCP.md`", (b) "CLI changes require a live smoke from the external test folder; reference at `PLAN/SMOKE_TESTING.md`"

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
- [x] **Live CLI smoke discipline locked in (2026-05-19).** Reference doc: `PLAN/SMOKE_TESTING.md`. Plan section: `PLAN/PLAN.md` Part 9. External test folder at `C:\Users\<user>\Downloads\kode\ai-advisoryboardclitestfolder` (Windows) / `~/aab-smoke/` (macOS+Linux); never smoke from the project root (pollution + project-mount hijack + mutex collision). Bootstrap via `aab init --non-interactive --home --name smoke-<date>`. Every meaningful change to `src/` runs the canonical flow in `SMOKE_TESTING.md` §4 before being declared done. The reference-regression log at `SMOKE_TESTING.md` §9 lists every silent-fail bug this discipline catches.

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
- [ ] **Per-phase UI + MCP gate (added 2026-05-19):** any CLI feature in Phase 2-5 with a UI surface must list its UI scope **and** its `specs/<flow>.md` MCP plan inside the owning phase, not deferred to Phase 6.5/6.6. Phase 6.5 is now polish + cross-cutting only; Phase 6.6 chunk 3 holds Phase 1 specs only — Phase 2-5 specs live in their owning phase's `**Playwright MCP regression specs**` subsection.

---

## What's running right now (May 2026)

- **Phase 0:** done.
- **Phase 1:** ✅ closed (2026-05-19, except sparring which is Phase 3). Live-smoke verified end-to-end (3 real Claude calls per discussion + 1 Haiku call per summarize). Closeout shipped alongside **two runner fixes that surfaced during the smoke and would have silently broken every prior Phase 1 path on Node 20.12+ / 22 / 24**: (a) Windows `.cmd` shim was being spawned through `cmd.exe` which silently truncates multi-line argv at the first newline — fixed by parsing the npm shim, extracting the underlying `.exe`, and spawning that directly (`src/llm/claude-code-runner.ts:resolveCmdShimToExe`); (b) summarize prompt's `…` truncation marker made Haiku refuse to summarize, thinking the transcript was corrupted mid-stream — fixed with explicit editorial marker + cap bumped 1200→6000 chars (`src/core/discussion/summarize.ts:PER_RESPONSE_CAP`). The orchestrator parse-failure that PLAN/CHECKLIST mentioned for months was the same `.cmd` truncation bug (its prompt is also multi-line); fixing the runner fixed the orchestrator too. Smoke verified: real discussion → orchestrator decision parses (`continue` with 95% confidence vs the old "fallback decision" path), summarize produces 82/100-quality 6-keyPoint summary, export renders the full summary into markdown, archive/unarchive are idempotent. Multi-round discussions work end-to-end on real Claude Code calls. Verified live (May 2026): `start` → 3 members responded → orchestrator gated next round → `respond --option 1` with answer → 3 members responded round 2 → orchestrator asked again → maxTurns auto-concluded. **Targeted follow-ups also live**: `aab discuss follow-up <id> "<q>" --member "Elon Musk"` ran a strict 1-member round and persisted `followUpQuestion`, `followUpTargetType: 'specific'`, `followUpSelectedMemberId`, and a matching `UserResponse{type:'follow_up_question'}`. The pre-round clarification gate fires at both `continue` and `follow-up` entry points per PLAN §4.3.1 — no member tokens spent when the orchestrator wants user input first. **Closeout shipped 2026-05-19:** `aab discuss summarize` (one-shot `fastModel` call producing the `ConversationSummary` payload — the same shape Phase 1.5 auto-ingest will consume), `aab discuss export --md` (self-contained markdown renderer; auto-summarises at export time if missing), `aab discuss archive/unarchive` (flips `archivedAt`, idempotent). Sparring deferred to Phase 3.
- **Phase 1.5 (Knowledge Wiki):** ✅ shipped 2026-05-19. All 8 chunks closed end-to-end. `raw/` (immutable sources) + `wiki/` (curated, linked markdown with `[[wikilinks]]` and YAML frontmatter) + `.manifest.json` (provenance ledger) replace the flat-JSON `BusinessContext`. **Members + orchestrator now read the wiki natively** via Read/Grep/Glob — system-prompt addendum appended to every `.claude/agents/<slug>.md` (§14), orchestrator `allowedTools` opened to `['Read','Grep','Glob']` (`orchestrator.ts:51`). New modules: `src/core/knowledge/{page,manifest,slug-map,rename,foam,schema-emitter,ingest,query,lint,migrate}.ts` (10 files, ~2500 lines) + prompt templates `src/core/prompts/skill-{ingest,query}.ts`. New CLI surface: `aab knowledge {ingest,query,lint,rename,show,list,open,edit,stats,graph,related,unresolved,backfill,migrate}` and `aab members {list,sync-agents}`. Auto-ingest hook fires on `discussion conclude` (and on HITL user-response — wired in `conversation-flow.ts`'s `maybeAutoIngestOnConclude` + `maybeAutoIngestUserResponse`, both wrapped in try/catch so a wiki hiccup never blocks a discussion). `aab init --foam` writes `.vscode/extensions.json` recommending the Foam VS Code extension (free, MIT, Obsidian-compatible `[[wikilinks]]`). `aab doctor` adds info-level Foam check. Web UI ships the **Knowledge tab** at `gui/app.js`'s `renderKnowledgeView` — graph icon in sidebar, type-filter chips, page list, page-detail view with `gui/wikilinks.js` `[[slug]]` preprocessor (resolved → `<a>`, unresolved → red `<span>`, transclusion/block-id → italic placeholder, header anchors → fragment links), sidecar (tags, sources, related, backlinks), ingest panel (paste / URL), query bar streaming answers + citations, lint button. New REST endpoints `/api/knowledge/{state,pages,pages/:slug,pages/:slug/rename,ingest,ingest/discussion/:id,query,lint,graph,raw,raw/:hash}` + WS events `wiki_ingest_{started,page_written,done}`, `wiki_query_{started,done}`, `wiki_lint_done`, `wiki_renamed`. **Unit tests** (`vitest.config.ts` wired; 31 tests across `page.test.ts`, `slug-map.test.ts`, `manifest.test.ts`, `rename.test.ts`) cover frontmatter parse/serialize round-trip including `aliases:`, wikilink extraction (display/anchor/transclusion/block-id/path-prefixed variants), slug-map render→parse round-trip + idempotency, manifest dedup + atomic rewrite, rename refusing slug/alias collisions, `--dry-run` non-mutation. **Live smoke** verified end-to-end: bootstrap → `paste` ingest (Acme Corp profile → 6 pages with proper `[[wikilinks]]`) → `show` (pretty-prints slugs as `slug ("Title")`) → `unresolved --suggest-fixes` (caught honeycomb/datadog/lightstep refs from the agent) → `related --depth 2` (link-graph walker) → `rename tracemesh → trace-mesh` (atomic — 4 body refs + 4 related + 1 manifest path rewritten + slug-map regenerated) → `lint` (slug-map + backlinks rebuilt) → `query` against the wiki (Sonnet read 2 pages, answered with citations) → discussion conclude → auto-ingest fired silently in background (HITL response also auto-ingested into a fresh concept page). **Playwright MCP smoke** verified the Web UI: Knowledge sidebar nav, page list with type chips, page-detail view rendering `[[trace-mesh]]` / `[[ebpf-integration]]` / `[[usage-based-pricing]]` as clickable links via `gui/wikilinks.js`, backlinks panel, query bar producing a real Sonnet-grounded answer.
- **Phase 6.5 (UI):** Web dashboard ships with `aab ui`. Live-streams typing-dot animations while members respond, then morphs into structured response cards. **Drives multi-round conversations from the browser**: Continue button on open discussions, inline reply form (with option chips) on HITL panels, and a Follow up composer with a member-chip selector that maps to `targetType: all|specific|subset` automatically based on chip count. Server posts to `/api/discussions/:id/continue`, `/respond`, and `/follow-up`, broadcasting the same WS event stream. Read-only views still for Members, Kanban, Principles, Settings. Editing UIs and Coach/Sparring views deferred until their backends land.
- **Phase 6.6 (Playwright MCP UI tests):** chunk 1 done — `@playwright/mcp@0.0.75` installed as devDep, project-scoped `.mcp.json` committed (cross-platform safe), `PLAN/PLAYWRIGHT_MCP.md` reference doc written. Next: chunk 2 (add `data-testid` registry to existing `gui/` markup + a11y pass), then chunk 3 (smoke flow specs by driving the dashboard via MCP).
- **Phase 2 (Members + Principles + Coach):** ✅ closed (2026-05-19). Full members CRUD shipped (`aab members {list,show,add,edit,enhance,delete,sync-agents,tools,regenerate-voice}`) with AI persona enhancement on three template variants (famous → BFI-2 + Cognitive Process; expert → top-1% mastery; non-famous → practical practitioner) calling local `claude` CLI (no Gemini, no API key). Principles CRUD + `seed-starters` + `explore` 5-step Socratic wizard (behavior → anti-pattern → triggers → examples → priority) with cross-step context preserved across turns. Decision Coach (`aab coach`) is a Dalio-style REPL backed by `DecisionSession` storage — `decision-sessions/<id>.json`, one file per session, atomic writes; opener fires automatically on session creation, multi-turn flow preserves full transcript every call, extracts referenced principle ids by title substring match. **Live smoke (2026-05-19):** coach session "$50k pivot" ran end-to-end with real Claude — opener referenced **Embrace Reality (9)** + **Be Radically Open-Minded (9)** + **Believability-Weight Decisions (7)** + **Own Your Mistakes** + **Think for Yourself**, second turn folded in **Be Direct and Honest (8)** + **Disagree and Commit (8)** + **Pain + Reflection = Progress (8)**, all by name. **GUI:** Members tab grows **↻ Regenerate agent files** header button + per-card **🔊 Voice** button (preview-before-save) + Enhance-with-AI inside the edit modal (streams over WS) + per-member tools allowlist chips. Principles tab grows **🌱 Seed starters** (disabled when non-empty) + **🔎 Explore** per card opening the 5-step wizard modal. New sidebar item **🧠 Coach** opens the chat view with session list + bubble stream + Cmd/Ctrl+Enter composer. New WS event family: `member_enhance_*`, `member_voice_*`, `members_sync_done`, `principles_seeded`, `principle_explorer_*`, `coach_thinking|message|error|session_*`. **Tests:** 49 new vitest unit tests across `ai-enhancer.test.ts`, `fallback-voice-guides.test.ts`, `decision-coach.test.ts`, `principle-explorer.test.ts`; full suite at 80/80 passing. Live Playwright MCP smoke verified the new surfaces render correctly with the real backend (smoke-phase2-2026-05-19 workspace).
- **Phase 3 (Sparring — 1:1 deep dive):** ✅ closed (2026-05-19). 4-layer ship — engine + CLI + GUI + MCP specs + tests. Engine modules: `src/core/sparring/{truncate,build-sparring-prompt,sparring-service,inject-insight}.ts` port sage-council's `sparring-service.ts` 1:1 (truncation budgets verbatim: 14k discussion / 8k history / 4k bcontext / 4k anchor; head-70/tail-30 split with `[<label> truncated to fit context window: omitted N chars]` marker; researchModel → primaryModel fallback). CLI grows `aab discuss spar <id> --member <name> [--round N --turn M --message <text> --resume <sessionId> --title <text>]` (interactive REPL + one-shot mode), `aab discuss inject <id> --from <sessionId> [--insight <text> --yes]`, `aab discuss spar list <discussion-id>`, `aab discuss spar show <session-id>`. Storage adds `SparringSession + SparringMessage + SparringSource + SparringInjectionContext` types and 6 new `StorageService` methods backed by `sparring/<discussionId>/<sessionId>.json` (one file per session, atomic writes); `UserResponse` extended with `sparringSessionId` so injected entries link back. GUI: per-response ⚔ Spar button on every `messageBubble`, chat-header ⚔ Sparring list button, full sparring modal (anchor banner + transcript + composer + ↩ Inject insight back), inject confirmation modal with editable textarea pre-filled from latest assistant reply, sparring sessions list modal. New REST endpoints `/api/discussions/:id/sparring` (list/open), `/api/sparring/:sessionId` (get/delete), `/api/sparring/:sessionId/messages` (send → WS stream), `/api/sparring/:sessionId/inject`. New WS event family: `sparring_session_opened`, `sparring_session_deleted`, `sparring_thinking`, `sparring_activity`, `sparring_message`, `sparring_error`, `sparring_injected`. **Tests:** 43 new vitest unit tests across `truncate.test.ts`, `build-sparring-prompt.test.ts`, `inject-insight.test.ts`, `sparring-service.test.ts`; full suite at 123/123 passing. **Live smoke:** `aab discuss spar da720e41 --member "Elon Musk" --round 1 --turn 1 --message "Walk me through the unit economics…"` against `smoke-kw-2026-05-19` produced a real Opus deep-dive (~6kB markdown reply with tiered targets, cost-of-getting-it-wrong tables, Q3 plan checklist); `aab discuss inject` wrote the `sparring_injection` UserResponse with full provenance (sparringSessionId, selectedMemberId=Elon, sourceRoundNumber=1, sourceTurnNumber=1, prompt="Injected from 1:1 Deep Dive with Elon Musk"). Playwright MCP smoke confirmed: ⚔ Spar buttons on each response card, ⚔ Sparring header button opens the session list modal showing the persisted session, clicking ⚔ Spar opens the sparring modal with anchor banner + full transcript reload from disk + ↩ Inject insight back button, the injected insight appears in the chat timeline as a user bubble labeled "Sparring insight injected (via Elon Musk)".
- **Phase 4 (Action Board — Kanban + skill-only solve, per Part 6):** ✅ closed (2026-05-20). 4-layer ship — engine + CLI + GUI + MCP specs + tests. Engine: `src/core/actions/conversation-analyzer.ts` ports sage-council's `conversation-analyzer.ts` with the **structured-data fast path made pure** (no LLM call when `response.structuredData.actionSteps` / `questionsForOthers` exist — deterministic transform + heuristic priority + category classifier + dedupe-by-title that bumps confidence on convergence). LLM fallback uses `fastModel` (Haiku) with `allowedTools:[]` + `maxTurns:1`, parses against `conversationAnalysisPayloadSchema`, and degrades to confidence-0 fallback without throwing if the call errors. CLI grows `aab actions {add,list,board,show,edit,move,delete,extract}` — `board` renders a 3-column ANSI Kanban with priority pips, due dates, and 8-char short-ids; `extract` supports `--dry-run`, `--accept-all`, and `--max N` to cap acceptance by confidence; `move` aliases `inprogress`/`doing`/`todo`/`done` to canonical statuses. Storage: `ActionItem` already lived in `types.ts`; `FsStorageService` `{load,save,update,delete}ActionItem` already shipped — Phase 4 layered the engine + commands on top, atomic writes to `action-items.json` preserved. GUI: read-only kanban replaced with drag-drop columns (HTML5 drag-drop wired in `gui/app.js:wireDropTarget`, optimistic update + rollback on PATCH failure), full add/edit modal sharing one entry point (`openActionEditModal(item?)` — Delete button only rendered in edit mode), and "📋 Extract actions" button surfaced in the chat footer of concluded discussions opening a candidate-list modal with per-row checkboxes. New REST endpoints: `POST /api/actions`, `PATCH /api/actions/:id`, `DELETE /api/actions/:id`, `POST /api/discussions/:id/actions/extract` (dual-mode: no-body returns candidates, `{accept:[...]}` persists). New WS event family: `action_created`, `action_updated`, `action_deleted`, `actions_extracted`. **Tests:** 33 new vitest unit tests across `conversation-analyzer.test.ts` (26 — pure helpers, structured fast path, LLM fallback with mocked runner, fallback path, parser tolerance, `toActionItem` truncation) and `commands/actions.test.ts` (7 — short-id + priority/status normalization with alias coercion); full suite at 156/156 passing. **Live smoke (2026-05-20):** CLI verified end-to-end on `smoke-phase4-2026-05-20` + `smoke-kw-2026-05-19` — `add` (interactive + non-interactive flag-driven), `list` (sorted by status then priority), `board` (3-column ANSI with chip counts), `show`, `edit --description --priority`, `move 7141a801 in-progress`, `move ad2e0815 completed`, `delete --yes`, `extract da720e41 --dry-run` produced 16 candidates from structured data in <50ms with no LLM call (confidences 87-88 for actionSteps, 72-73 for questionsForOthers), `extract --accept-all --max 3` persisted 3 high-confidence cards with `discussionId` provenance. **REST verified via curl**: GET → 200, POST → 201 + WS broadcast, PATCH → 200 + status transition, DELETE → 204, extract no-body → `method: 'structured'` + 16 candidates in 3ms, extract `{accept:[...]}` → 201 + created ActionItem. **Playwright MCP smoke** verified the UI: nav to 📋 Action Board, kanban renders with 4 items in the correct columns, `+ Add action` opens the modal, title input → Create → modal closes + new card appears in `pending`. The Extract button visibility is correctly gated on `discussion.completedAt`.
- **Phase 5 (Skill creator — the killer feature):** ✅ closed (2026-05-21). All 6 chunks shipped; spec at `PLAN/SKILL_CREATOR.md` is authoritative. **Engine:** 11 new files under `src/core/skill/` (`resolve-skill-creator.ts`, `recon/{pc-scan,wiki-recon,web-recon,web-probe,orchestrator}.ts`, `planner.ts`, `planner-review.ts`, `build-brief.ts`, `invoke-skill-creator.ts`, `adapter.ts`, `install.ts`, `persist-run.ts`, `solve-orchestrator.ts`) + the Planner system prompt at `src/core/prompts/skill-planner.ts` (the most important prompt in the CLI per the spec) + the `skillDesignProposalSchema` extension to `src/core/parsing/llm-response-schemas.ts` with `validateProposalSemantics` for hard gates that go beyond shape + `RESERVED_SKILL_NAMES`. **Runner:** `runClaude` grows `appendSystemPromptFile` + explicit `outputFormat` options. **CLI:** `aab actions plan|solve|runs {list,show,export,delete}` + new top-level `aab skills {list,show,test,uninstall,restore}` + `aab init --install-skill-creator` + `aab doctor` skill-creator/PC-scan/web-reachability checks. **GUI:** Plan + Solve buttons on every action card; 4-phase Planner progress pane with live tool-call stream; interactive proposal modal (tier radio + per-integration toggles + per-stakeholder toggles + narrative editor + export-md); Re-plan feedback modal (server-enforced ≥10 chars + max-3 cap); new Skills tab in sidebar. **Server:** `/api/actions/:id/plan`, `/api/plans/:planId`, `/api/plans/:planId/replan`, `/api/actions/:id/solve`, `/api/actions/:id/runs`, `/api/skill-runs/:id`, `/api/recon/environment`, `/api/skills`, `/api/skills/:name` + the full `planner_*` and `skill_run_*` WS event family. **Tests:** 80 new vitest unit tests across `resolve-skill-creator.test.ts` (12) + `pc-scan.test.ts` (6) + `wiki-recon.test.ts` (4) + `web-recon.test.ts` (9) + `planner.test.ts` (25) + `build-brief.test.ts` (5) + `adapter.test.ts` (9) + `install.test.ts` (3) + `solve-orchestrator.test.ts` (7 end-to-end with stub skill-creator, covering happy path + plan-only + no-install + missing-skill-creator failure). Full suite at 236/236 passing. **Specs:** all 8 Playwright MCP regression specs shipped under `specs/skill-{plan-only,planner-maximalist,planner-replan,solve-happy-path,run-telemetry,install-conflict,runs-history,skills-tab}.md`. **Live smoke:** stub-mode end-to-end on the external test folder produced a valid SKILL.md at `.claude/skills/phase-5-smoke-action/` in 315ms — `linkedSkill` populated, `runs show` renders the embedded Planner proposal, `skills list` enumerates it, `skills uninstall` archives cleanly. Real-Claude smoke against §20a Recipes A/D/E/F deferred to user (each Planner run is ~$2.20). The depth-of-feature thesis — Planner reasons about ≥3 multi-tool orchestrations spanning ≥2 surfaces, including first-class `chrome-extension` and `computer-use` invocation kinds — is enforced at the schema + semantic-gate layer; the prompt embeds three condensed few-shot examples (Elgato + pricing + LinkedIn) that calibrate the reasoning.
- **Phase 6:** not started.

**Next sensible chunk:** **Phase 6** (hardening + docs + distribution). With Phase 5 closed, the headline product surface is feature-complete end-to-end. Phase 6 covers: (a) the optional hooks layer for `.claude/settings.json` governance, (b) golden-file tests for prompts + the live-`AAB_LIVE_TEST=1` gated suite, (c) `npm publish` + GitHub Actions CI matrix (Node 20+22 × ubuntu/macos/windows), (d) `aab update` self-update, (e) polished README + asciinema + auto-generated `docs/commands.md`, (f) snapshot/restore resilience for entity files, (g) i18n + tab completion, (h) the optional `/aab` slash skill cherry. Phase 6.6 chunk 2 (`data-testid` registry + a11y pass for Phase 1 controls) is also still pending but parallelizable.

**Historical pointer (closed 2026-05-21):** Phase 5 (Skill creator — the headline feature, redesigned 2026-05-20). The Phase 4 action board produces the input: every `ActionItem` carries `discussionId` provenance, so the Plan/Solve buttons pipe the action's `description` + the linked discussion's transcript into the new agentic pipeline. **The redesign:** we do NOT port sage-council's 3,816-line single-loop skill builder + 14-prompt pipeline. Instead, we delegate skill authoring to Anthropic's official `skill-creator` skill (~117k weekly installs, bundled with Claude Code) via `claude -p --append-system-prompt-file`, and we redirect the saved engineering capacity into a **Skill Planner** — an agentic preflight that runs read-only recon across the user's PC (every installed desktop app + CLI tool + MCP server + browser extension + env var), the Knowledge Wiki (stakeholders + decisions + endorsed directions + vetoes), and the live web (current best-practice patterns + tool recommendations + recent innovations), then reasons creatively with Opus 4.7 about how far we can take the emitted skill to maximize user value via multi-tool orchestration. The canonical depth example (the "Elgato moment"): instead of producing a 2-page markdown script for a YouTube video, the Planner notices the user has Elgato Teleprompter installed + Google Calendar MCP + Person X in the wiki as their video editor, and proposes a skill that loads scripts into the Teleprompter, books practice + recording slots in Calendar, AND drafts a brief email to Person X. **The full authoritative spec is at `PLAN/SKILL_CREATOR.md`** (~5,500 words, 23 sections, 6 build chunks, $2.20/run typical cost, 5-14 min wall-clock). Concrete next steps: Chunk 1 (skill-creator detection + auto-offer-to-install in `aab init` + doctor checks), then Chunk 2 (recon: PC scan + Wiki recon + Web research in parallel — the read-only PC scan invariant is lint-enforced), then Chunk 3 (Skill Planner reasoning prompt + Opus call + `SkillDesignProposal` schema + interactive review with toggle-per-integration + re-plan loop + `aab actions plan <id>` first-class command — **this is the milestone where the user feels the depth of the feature for the first time**), then Chunks 4-6 (skill-creator invocation + adapter + install; `aab actions runs` + `aab skills` commands; Web UI + WS events + 8 Playwright MCP specs). After Phase 5: **Phase 6** (hardening + docs + distribution). The cross-cutting **Phase 6.6 chunk 2** (`data-testid` registry + a11y pass for Phase 1 controls) is still pending but can run in parallel — Phase 2-4's UI already carries `data-testid` on every new control. Phase 4 additions to the registry: `actions-view`, `actions-add-btn`, `kanban-board`, `kanban-col-pending`, `kanban-col-in-progress`, `kanban-col-completed`, `kanban-card`, `kanban-card-title`, `action-edit-modal`, `action-edit-close`, `action-title-input`, `action-desc-input`, `action-priority-select`, `action-status-select`, `action-due-input`, `action-assignee-input`, `action-save-btn`, `action-delete-btn`, `extract-actions-btn`, `extract-actions-modal`, `extract-close-btn`, `extract-body`, `extract-status`, `extract-list`, `extract-row`, `extract-checkbox`, `extract-accept-btn`. The orphan-page warning from lint (`acme-corp-b2b-saas` has zero incoming links) is expected and harmless for source-summary pages — lint emits it as `info`, not `warn`.

**Per-phase UI + MCP gate (2026-05-19):** every Phase 2-5 chunk now lists its own `**UI**` subsection (mirrors the CLI verbs in `gui/`) and `**Playwright MCP regression specs**` subsection (one `specs/<flow>.md` plan per UI flow). Phase 6.5 stops being the catch-all UI bucket — it's now polish + cross-cutting. Phase 6.6 chunk 3 holds Phase 1 + cross-cutting specs only. The structural fix is documented in the Cross-cutting section's "Per-phase UI + MCP gate" line and mirrored in `PLAN/PLAN.md` Part 8 §8.6.

---

## How to update this file

When you finish an item:

1. Change `- [ ]` → `- [x]` on the line.
2. If the phase has all items checked, flip its emoji from 🟡 to ✅ in the heading.
3. Add a one-line note under "What's running right now" if it's a meaningful milestone.

When you start an item:

1. Add a 🟡 emoji to the section heading if not already there.
2. Optionally add `(in progress)` after the bullet text.
