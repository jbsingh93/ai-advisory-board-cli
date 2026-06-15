# Continuous user-input wiki ingest — design, context, and rationale

> **Status:** design locked, not yet built (as of 2026-06-15).
> **Owning plan section:** `PLAN.md` Part 11. **Owning checklist phase:** `CHECKLIST.md` Phase 8.
> **Parent system:** the Knowledge Wiki (`KNOWLEDGE_WIKI.md`). Read §15 (ingest workflow) and §16 (auto-ingest hook) there first — this document extends them.

This is the **canonical context document** for the feature. It captures everything: the problem, the current behaviour, the approaches we *rejected* (and exactly why), the locked design, the open questions, and every file reference needed to build it. If you are a future coding agent picking this up, you should be able to implement the whole thing from this document plus the four files it points at. Nothing here is summarised for brevity — that is intentional.

---

## 1. The idea, in the user's words

> "I was thinking that it might be better to do an LLM wiki ingest of all the user's input. However the user could enter redundant information that's already in the wiki. For example, the user could mention the company name, its market and customer many times, so we will only overwrite when the information is actually new/missing from the LLM wiki (to make it even smarter). This should happen at all user inputs (start of discussion, follow-up questions, a HITL/board question response, and in the 1:1's)."

And the critical refinement, after an initial wrong turn (see §4):

> "NO you can't do a direct slug check, because I can name my company name and bring some new nuances/information to the table, maybe some updated information, that's why we need to ingest the input every time!"

The product intent in one sentence: **every word the user types into the system should be given to a wiki-ingest agent that compares it against the existing wiki and merges in only what is genuinely new or changed — never duplicating, never skipping a real update.**

---

## 2. Why this is worth doing

The wiki is what makes advisory-board answers specific to *this* user instead of generic. Today the wiki only learns from:

1. Documents the user explicitly ingests (`aab knowledge ingest <path|url|--paste>`).
2. Whole concluded-discussion transcripts (auto, on conclude).
3. HITL replies ≥ 40 chars (auto, on `respond`).

But the highest-signal, purest source of user/business facts is **the user's own words as they type them** — their question, their follow-ups, their clarifications, their sparring messages. That stream is currently captured only partially and only as a side effect of *transcript* ingest (which mixes the user's voice with advisor opinions). Capturing it directly, every time, turns the wiki into genuine compounding memory: the more the user talks to their board, the more the board knows them.

The "smarter" the user keeps emphasising is **reconciliation**: the wiki should notice that "Acme" is already an entity and, on the tenth mention, only record the *new* fact ("...we just pivoted Acme to APAC enterprise") — updating the existing page rather than creating `acme-2.md`.

---

## 3. Current state — exactly what exists today

### 3.1 The two existing auto-ingest paths

Both live in `src/core/discussion/conversation-flow.ts`:

| Trigger | Function | What it ingests | Settings gate |
|---|---|---|---|
| Discussion concludes | `maybeAutoIngestOnConclude` (`conversation-flow.ts:274`) | the **whole transcript** (`renderDiscussionMarkdown`) + summary, via `ingestDiscussionRaw` | `knowledgeWiki.autoIngestDiscussions` |
| HITL reply | `maybeAutoIngestUserResponse` (`conversation-flow.ts:315`) | the reply text, **only if `.trim().length >= 40`**, via `ingestPaste` | `knowledgeWiki.autoIngestUserResponses` |

Call sites today:
- `startDiscussion` → `maybeAutoIngestOnConclude` at `conversation-flow.ts:244` (only fires if round 1 concluded immediately).
- `continueDiscussion` → `maybeAutoIngestOnConclude` at `conversation-flow.ts:589-591` (only when `concluded`).
- `addFollowUpQuestion` → `maybeAutoIngestOnConclude` at `conversation-flow.ts:1055-1057` (only when `concluded`).
- `respondToUserRequest` → `void maybeAutoIngestUserResponse(trimmed, ...)` at `conversation-flow.ts:655` (fire-and-forget, not awaited).

### 3.2 Coverage gaps (the four input points)

| Input point | Where it enters | Ingested today? |
|---|---|---|
| **Initial question** (`discuss start`) | `startDiscussion`, stored as `discussion.question` + `userResponses[0]` (`conversation-flow.ts:129-138`) | ❌ Only when the *whole discussion* later concludes (transcript ingest). The question is never ingested as a standalone user-fact source. |
| **Follow-up question** (`discuss follow-up`) | `addFollowUpQuestion`, stored as `UserResponse{type:'follow_up_question'}` (`conversation-flow.ts:989-1002`) | ❌ Never individually ingested. |
| **HITL / board-question response** (`discuss respond`) | `respondToUserRequest` (`conversation-flow.ts:619`) | 🟡 Yes, but gated at ≥40 chars and as a generic paste. |
| **1:1 sparring message** | `sendSparringMessage` in `src/core/sparring/sparring-service.ts` | ❌ **No wiki integration at all** — sparring touches the wiki nowhere. |

### 3.3 The ingest pipeline as it stands

`src/core/knowledge/ingest.ts` is the single pipeline. Public entry points: `ingestFile`, `ingestFileBuffer`, `ingestPaste`, `ingestUrl`, `ingestDiscussionRaw`. They all funnel into `runIngestCore` (`ingest.ts:81`), which:

1. Ensures wiki dirs + schema/index exist.
2. **Dedup check** (`ingest.ts:88-104`): `findEntryByHash(manifest, core.hash)` — an **exact SHA-256 content-hash** match. If found and not `force`, returns early with the prior run's pages and `alreadyIngested: true`. This catches *byte-identical* re-ingests only.
3. Builds the prompt via `buildIngestPrompt` (`src/core/prompts/skill-ingest.ts:23`).
4. Runs **one** `runClaude` call with `allowedTools: ['Read','Grep','Glob','Write','Edit','WebFetch']`, `maxTurns: 30`, `timeoutMs: 5 * 60_000`, `cwd: workspace.root`, model = `knowledgeWiki.ingestModel ?? fastModel` (haiku) (`ingest.ts:124-132`, `pickModel` at `ingest.ts:213`).
5. Parses the agent's JSON (`producedPages`/`updatedPages`/`skipped`/`notes`), with a `wiki/…md` path-scrape fallback (`ingest.ts:142-163`).
6. Rebuilds the slug-map in `wiki/index.md` (`buildSlugMap` + `writeSlugMapToIndex`, `ingest.ts:165-168`).
7. Appends a `ManifestEntry` (`ingest.ts:170-185`, `manifest.ts:newEntry`/`appendEntry`).

### 3.4 The semantic dedup ALREADY EXISTS — but only in the prompt

This is the single most important thing to understand before building. The ingest **agent** is already instructed to deduplicate semantically. From `src/core/prompts/skill-ingest.ts`:

- Line 59: *"**Do not duplicate** what the wiki already covers — if a page exists, update/extend it rather than creating a near-duplicate. If the source adds nothing new about the user, it is fine to produce only the audit-trail source page (step 5)."*
- Line 64: *"Identify the most important NEW information ... Skip anything the wiki already records."*
- Lines 67-68: *"Does a wiki page already exist for it? ... If yes AND its frontmatter does NOT have `userEdited: true`: update the page (merge new info; preserve `[[wikilinks]]`; flag contradictions in body with `^[ambiguous]`)."*

So the agent, in principle, already reads the slug-map, decides update-vs-create-vs-skip, and merges. **The dedup intelligence is semantic and lives in the LLM, not in code.** The code-level hash check is only an exact-match idempotency guard.

### 3.5 The one structural problem with reusing this pipeline for utterances

`skill-ingest.ts:70`, procedure step 5: *"**ALWAYS create exactly one `wiki/sources/<humanized-slug>.md` for this source** — even if the rest is small. This is the audit trail."*

For documents, an unconditional source page is correct. But if every short user utterance is routed through this pipeline, **you get a `wiki/sources/*.md` page per utterance even when there is zero new knowledge.** Mention the company ten times → ten source pages. That is the redundancy bloat the user is worried about — and it comes from the *audit-trail* requirement, not from the entity/concept pages (those are already deduped by the agent's reasoning). **This is why per-utterance ingest cannot reuse `buildIngestPrompt`/`ingestPaste` as-is.**

### 3.6 Relevant settings today

`src/storage/types.ts:403` — `KnowledgeWikiSettings`:

```ts
enabled: boolean;                 // default true
autoIngestDiscussions: boolean;   // default true  — conclude → transcript ingest
autoIngestUserResponses: boolean; // default true  — respond bodies ≥40 chars → paste ingest
ingestModel: ... ;                // default 'haiku'
queryModel: ... ;                 // default 'sonnet'
// ...
```

Defaults at `types.ts:420` (`DEFAULT_KNOWLEDGE_WIKI_SETTINGS`).

---

## 4. The approach we REJECTED (and why) — do not re-introduce this

**Rejected idea:** a cheap deterministic pre-filter ("Tier 0") that skips ingestion when the utterance is redundant — via either:
- a normalized-content hash (lowercase + collapse whitespace, then `findEntryByHash`), or
- a slug/keyword-overlap check against existing page summaries in the slug-map.

**Why it is wrong (the user's exact objection):** the user can re-mention an existing entity ("Acme") *and bring new nuance or updated information in the same breath*. A normalized hash only matches near-identical strings, and a slug-overlap check matches on the *entity*, not on whether the *fact* is new. Either gate would therefore silently discard the user's most valuable input — the updates. The redundancy judgment is **semantic**, not lexical, and only an LLM that has read the current wiki state can make it correctly.

**The consequence for the design:** there is **no knowledge-level deterministic skip**. Every input is always sent to the merge agent. The dedup decision is made *per extracted fact, inside the agent*, after it has read the wiki. (The single narrow exception is a plumbing-only idempotency guard against the *same event* firing twice — see §5.5 — which is not a knowledge filter and never blocks a genuine re-mention.)

This reframes the unit of deduplication:

> Dedup is no longer "should we ingest this utterance?" It is "for each fact extracted from this utterance, is it **new**, an **update**, or **already known**?" — decided by the agent, after reading the wiki.

| Agent finds a fact that is… | Action |
|---|---|
| not represented in the wiki | **create** a page (or add to the right existing entity page) |
| about an existing entity, with new nuance / changed value | **update** — merge into the page, bump `updated:`, preserve prior context |
| in direct conflict with the page | **update + flag** `^[ambiguous]` (or supersede, recording provenance) |
| already fully captured | **skip that fact** — but the utterance was still processed |

"Company mentioned ten times" collapses naturally: nine mentions yield zero page changes (facts already present); the tenth, carrying the APAC pivot, produces a real update. Nothing valuable is ever gated out, because nothing is gated.

---

## 5. The locked design

Four load-bearing pieces. Build them in this order: prompt → ingest function → serialized queue → call-site wiring. The first two are testable in isolation; the queue is the concurrency-safety layer; the wiring turns it on.

### 5.1 A dedicated "user-fact merge" ingest path (NOT the document pipeline)

New module: `src/core/knowledge/ingest-user-facts.ts`.

```ts
ingestUserFacts(opts: {
  text: string;
  kind: 'initial_question' | 'follow_up' | 'hitl_response' | 'sparring_message';
  discussionId?: string;
  sparringSessionId?: string;
  workspace: ResolvedWorkspace;
  settings: AppSettings;
  storage?: StorageService;
}): Promise<IngestResult>
```

It mirrors `runIngestCore`'s plumbing (ensure dirs, run agent, parse JSON, rebuild slug-map, append manifest entry) but differs from the document pipeline in three deliberate ways:

1. **No mandatory source page.** If the agent finds nothing new, it writes **nothing** and returns `{ producedPages: [], updatedPages: [], skipped: [] }`. The redundancy-bloat source-page-per-utterance problem (§3.5) is eliminated here. *(Audit-trail alternative: optionally append one line to `wiki/log.md` or to a single rolling `raw/user-inputs/<yyyy-mm-dd>.md` so the raw stream is still recoverable without one page per utterance. See open question §7.1.)*
2. **Update-biased.** The prompt explicitly prefers extending an existing entity/concept page over creating a new one.
3. **Cheap budget.** `maxTurns: ~8` (vs the document pipeline's 30) and the haiku `ingestModel`. A one-sentence utterance does not need a 30-turn, 5-minute agent.

A new manifest `sourceType` should be added: `'user-input'` (extend `ManifestSourceType` in `src/core/knowledge/manifest.ts:14`). This keeps the provenance ledger honest and lets `aab knowledge` tooling distinguish utterance-ingests from document-ingests.

**Signal-quality bonus to preserve:** per-utterance ingest feeds the agent *pure user voice* — no advisor opinions mixed in. This is strictly higher-signal for user/business facts than transcript ingest (which interleaves the user's words with five advisors' analysis). Lean into this in the prompt: tell the agent the entire input is the user speaking in first person about themselves/their business.

### 5.2 The merge prompt (the load-bearing artifact)

New builder: `src/core/prompts/wiki-merge.ts` → `buildUserFactMergePrompt(input)`.

Since the agent runs on **every** input and must reconcile rather than duplicate, the prompt's reconciliation instructions are where "smarter" actually lives. Required elements:

- **Frame the input as pure user voice:** "The following is the user speaking, in their own words, about themselves and their business. Treat it as first-person ground truth about the user."
- **Mandate reading current state before deciding:** read `wiki/index.md` slug-map, then `Grep`/`Read` the candidate entity/concept pages, **before** any write. The agent must see the page's current contents to merge correctly.
- **Per-fact decision contract:** for each extracted fact, decide create / update / skip per the table in §4.
- **Merge, don't append-dump:** integrate new nuance into the relevant section of the existing page body — do not tack on a redundant paragraph that restates what's already there.
- **Conflict handling:** when the new statement contradicts the page, prefer the newer user statement, bump `updated:`, set `provenance: extracted`, and mark the superseded claim with `^[ambiguous]` (consistent with `skill-ingest.ts:67` and `KNOWLEDGE_WIKI.md` provenance discipline §12). Never silently discard the old value without a trace.
- **Respect `userEdited: true`:** never overwrite a page whose frontmatter has `userEdited: true`; record it in `skipped`. (Same contract as the document pipeline and the `isAabGenerated`/manifest `userEditedPages` machinery.)
- **Reuse the wiki-link + frontmatter contracts** from `skill-ingest.ts` verbatim (the `[[slug]]` rules, the full frontmatter block, "never write secrets", "do not touch the `<!-- AAB:SLUG-MAP -->` / `<!-- AAB:BACKLINKS -->` sections").
- **Output contract:** same JSON shape as the document ingest (`{ producedPages, updatedPages, skipped, notes }`) so `runIngestCore`'s parser/fallback can be shared — but **no mandatory source page**, and an empty result is a valid, expected outcome.

### 5.3 A single per-workspace serialized ingest queue

New module: `src/core/knowledge/ingest-queue.ts`.

**Why this is mandatory, not optional:** today `maybeAutoIngestUserResponse` is `void`-ed (`conversation-flow.ts:655`) — fired and not awaited. It runs the ingest **without holding the workspace lock**, and can outlive the command's `openContext` lock (which is released in the command's `finally`). With only HITL replies that is rarely a problem. But fanning ingest out to *every* utterance — especially rapid-fire sparring messages — means multiple ingest agents can run concurrently and **race on the shared `wiki/index.md` slug-map rebuild and the `.manifest.json` append.** Atomic writes prevent a half-written file but not a lost-update (agent A's slug-map rebuild clobbering agent B's new page).

The queue:
- Keyed per workspace root.
- Drains **one ingest at a time** (serialized). Enqueue returns immediately; callers never await the actual ingest.
- **Debounces/coalesces:** multiple utterances arriving within a short window (e.g. three follow-ups in 20s, or a burst of sparring messages) are batched into **one** merge pass over the concatenated text, rather than N separate agent runs. This cuts cost and gives the agent more context to reconcile against at once.
- Survives the command lifecycle: because the queue owns the work, it does not matter that the originating CLI command has closed its context. (Open question §7.3: in the CLI's short-lived process model, the queue must be drained before `process.exit` — decide whether to `await` a drain in `closeContext`, or accept that very-last-utterance ingest happens on the *next* invocation. The web server is long-lived so this is only a CLI concern.)

### 5.4 Wire all four input points

One enqueue call each. All fire **after** the relevant `saveDiscussion`/`saveSparringSession` so persistence is never blocked and a crash can't lose the user's actual answer:

| Point | File / location | Change |
|---|---|---|
| Initial question | `conversation-flow.ts`, after the `initialUserResponse` push (`:138`) and the round-1 `saveDiscussion` (`:241`) | enqueue `{ text: question, kind: 'initial_question', discussionId }` |
| Follow-up question | `conversation-flow.ts`, after the follow-up commit + `saveDiscussion` (`:1002` / `:1052`) | enqueue `{ text: trimmed, kind: 'follow_up', discussionId }` |
| HITL response | `conversation-flow.ts:655` | **replace** `maybeAutoIngestUserResponse` with the queue enqueue `{ text: trimmed, kind: 'hitl_response', discussionId }`; drop the 40-char gate (or keep ≥1 non-empty char) |
| Sparring message | `src/core/sparring/sparring-service.ts`, inside `sendSparringMessage` after the user message is persisted | enqueue `{ text: userMessage, kind: 'sparring_message', discussionId, sparringSessionId }` |

All gated behind the new settings flag (§5.6) and the existing `knowledgeWiki.enabled` + "wiki dirs exist" checks (mirror `maybeAutoIngestUserResponse`'s guards at `conversation-flow.ts:320-327`).

### 5.5 The one narrow deterministic check we keep (plumbing, not knowledge)

An **idempotency guard** against the *same event* firing twice — a double-click submit, a retried HTTP POST, a re-run of the same command. This is keyed on event identity (e.g. the `UserResponse.id`, or `discussionId + roundNumber + kind`), **not** on content similarity. It exists so we don't process the identical event object twice; it can never block a genuine re-mention of a fact in a new utterance. If in doubt, omit it and let the agent run — it is a cost optimisation, not a correctness requirement.

### 5.6 Settings

Add to `KnowledgeWikiSettings` (`src/storage/types.ts:403`) and `DEFAULT_KNOWLEDGE_WIKI_SETTINGS` (`:420`):

```ts
autoIngestUserInputs: boolean;   // default true — every user utterance → user-fact merge
```

This is the single master toggle for the whole feature. Keep `ingestModel: 'haiku'` for the merge agent. Consider (open question §7.4) whether the existing `autoIngestUserResponses` should be **subsumed** by `autoIngestUserInputs` (HITL responses become just one `kind`) or kept as an independent sub-toggle for backward compatibility.

### 5.7 Reconcile with conclude-time transcript ingest

If every utterance is now ingested as a user-fact source, the existing conclude-time `ingestDiscussionRaw` (`conversation-flow.ts:244/589/1055`) will **re-process the same user words** — and the manifest's exact-hash dedup will NOT catch it, because the transcript's hash differs from any single utterance's hash. Two same-entity writes will fight over the same pages.

**Resolution:** shift conclude-time ingest to capture **advisor synthesis, the orchestrator's consensus, and decisions** — i.e. the parts of the transcript that are *not* the user's raw voice — and let per-utterance ingest own the raw user facts. Concretely, this likely means a transcript-ingest prompt variant that says "the user's own facts are already captured; extract advisor conclusions, agreements, disagreements, and any decision the board converged on." The summary (`discussion.summary`, the `{keyPoints, consensus, disagreements, actionableInsights}` payload) is the natural input for that. This avoids double-processing while keeping the "discussions become permanent memory" property.

---

## 6. End-to-end flow (target state)

```
user types (CLI arg / HTTP body / sparring REPL)
  → engine records the UserResponse / sparring message, saveDiscussion (atomic)   [unchanged]
  → enqueue { text, kind, discussionId? , sparringSessionId? }  (fire-and-forget) [NEW]
        │
        ▼  (serialized, debounced, per-workspace)
  ingest-queue drains one job
  → ingestUserFacts()
       → buildUserFactMergePrompt(text, kind)
       → runClaude(haiku, tools: Read/Grep/Glob/Write/Edit, maxTurns ~8, cwd = workspace.root)
            → agent reads wiki/index.md slug-map
            → agent Greps/Reads candidate entity/concept pages   (sees CURRENT state)
            → per fact: create | update(+merge,bump updated) | update+^[ambiguous] | skip
            → writes NOTHING if nothing new (no mandatory source page)
       → parse { producedPages, updatedPages, skipped, notes }
       → rebuild slug-map in wiki/index.md
       → append ManifestEntry { sourceType: 'user-input', ... }
  (conclude-time transcript ingest now captures advisor synthesis only)            [reconciled]
```

---

## 7. Open questions (decide during build)

1. **Audit trail for utterances that produce no page.** Do we keep a raw copy of every user utterance somewhere (a rolling `raw/user-inputs/<date>.md`, or a `wiki/log.md` line) even when the merge yields zero pages? Pro: full recoverability / provenance. Con: a file that grows unboundedly. Leaning: one appended line in `wiki/log.md` per ingest (cheap, already the pattern), plus the raw text in `raw/user-inputs/` only when `producedPages ∪ updatedPages` is non-empty.
2. **Debounce window + batching key.** What window coalesces utterances (5s? 20s? until the next round starts?), and do we batch across discussions or only within one? Leaning: per-discussion, flush on a short idle timer or when the next engine operation for that discussion begins.
3. **CLI process lifetime vs. the async queue.** The CLI is short-lived; a fire-and-forget enqueue may not drain before `process.exit`. Decide: (a) `await` a best-effort drain in `closeContext`, (b) accept last-utterance-ingests-on-next-run, or (c) spawn a detached drainer. The web server (long-lived) is unaffected.
4. **`autoIngestUserResponses` fate.** Subsume into `autoIngestUserInputs` (one toggle, HITL is just a `kind`) or keep both? Subsuming is cleaner; keeping both is more backward-compatible for anyone who set the old flag.
5. **Cost ceiling.** Every utterance → one haiku call. For a chatty sparring session this adds up. Do we want a per-discussion or per-day soft budget that downgrades to "batch at conclude only" when exceeded? `perCallBudgetUsd` already caps a single call; a session-level cap would be new.
6. **Conflict policy precision.** "Prefer the newer user statement" is the default, but some facts are append-not-replace (e.g. "another competitor is X"). The prompt must distinguish *correction* (replace + `^[ambiguous]`) from *accumulation* (add to a list). This is a prompt-engineering detail to nail during the live smoke.

---

## 8. Testing & verification

Per `CLAUDE.md` "Verification — live smoke is mandatory": typecheck + build is necessary but not sufficient. This feature is LLM-behavioural, so it **must** be smoke-tested live from the external test folder (`C:\Users\julia\Downloads\kode\ai-advisoryboardclitestfolder` / `~/aab-smoke/`), never from the project root.

**The decisive smoke scenario** (this is the whole feature in one test):
1. Start a discussion mentioning the company by name with one fact ("Acme sells to SMB retailers").
2. Confirm a `wiki/entities/acme.md` (or similar) page exists with that fact.
3. Ask a follow-up that re-mentions Acme with **no new info** ("what should Acme do next quarter?"). → Confirm **no new page** and **no redundant edit** (manifest shows the utterance ingested with empty `producedPages`/`updatedPages`, or only a `log.md` line).
4. Ask a follow-up that re-mentions Acme **with new info** ("we just moved Acme upmarket to APAC enterprise"). → Confirm the **existing** `acme.md` is **updated** (new fact merged, `updated:` bumped), and **no** `acme-2.md` is created.
5. Send a sparring message with a brand-new fact → confirm it ingests (proving sparring is wired).
6. Hand-edit a page to `userEdited: true`, re-mention it with new info → confirm it is **skipped** and reported in `skipped`.

Also: a concurrency test — fire several utterances in quick succession and confirm the slug-map and manifest are consistent afterwards (no lost pages), proving the serialized queue works.

Unit tests (`*.test.ts`, vitest) for the deterministic pieces: the queue's serialization/debounce/coalesce logic, the idempotency guard, the settings gate, and the prompt builder's structure (snapshot the assembled prompt string).

---

## 9. File-change manifest (what to touch)

**New files:**
- `src/core/knowledge/ingest-user-facts.ts` — the user-fact merge ingest function (§5.1).
- `src/core/prompts/wiki-merge.ts` — `buildUserFactMergePrompt` (§5.2).
- `src/core/knowledge/ingest-queue.ts` — serialized, debounced, per-workspace queue (§5.3).
- Tests: `src/core/knowledge/__tests__/ingest-queue.test.ts`, `src/core/prompts/__tests__/wiki-merge.test.ts`.

**Edited files:**
- `src/storage/types.ts` — add `autoIngestUserInputs` to `KnowledgeWikiSettings` (`:403`) + default (`:420`).
- `src/core/knowledge/manifest.ts` — add `'user-input'` to `ManifestSourceType` (`:14`).
- `src/core/discussion/conversation-flow.ts` — enqueue at initial-question (`~:138/241`), follow-up (`~:1002/1052`), and replace HITL ingest (`:655`); reconcile conclude-time ingest (`:244/589/1055`).
- `src/core/sparring/sparring-service.ts` — enqueue in `sendSparringMessage`.
- `docs/development/KNOWLEDGE_WIKI.md` — extend §16 (auto-ingest hook) to reference this path; add `autoIngestUserInputs` to §23 settings keys.

**Reference-only (read, don't change unless reconciling):**
- `src/core/knowledge/ingest.ts` — `runIngestCore` is the template to mirror; share its parser/slug-map/manifest steps.
- `src/core/prompts/skill-ingest.ts` — reuse its frontmatter + wiki-link + secrets contracts verbatim.

---

## 10. One-paragraph summary for someone in a hurry

We will ingest **every** user utterance (initial question, follow-ups, HITL responses, sparring messages) into the Knowledge Wiki through a **new, dedicated user-fact merge agent** — separate from the document-ingest pipeline because that pipeline always writes an audit-trail source page, which would bloat the wiki on every redundant mention. There is **no deterministic dedup gate**: the user can re-mention a known entity while adding new nuance, so a hash/slug skip would throw away real updates. Instead, dedup happens **per fact, inside the agent**, after it reads the current wiki — create if new, merge+bump if updated, flag if conflicting, skip if already known. The agent runs on every input via a **serialized, debounced, per-workspace queue** (so concurrent ingests don't race the slug-map), fired async after persistence, behind one settings flag `autoIngestUserInputs` (default on). No Claude Code hook is involved — "forcing" the ingest just means calling it inline in the engine at each of the four points. Conclude-time transcript ingest is re-scoped to advisor synthesis so it doesn't double-process the user's own words.
