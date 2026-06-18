# Decision Coach × Business Wiki — design spec

**Status:** shipped (2026-06-18) — implemented per this spec; live CLI smoke green (see `CHECKLIST.md`).
**Owner doc:** this file. Cross-refs: `docs/development/USER_INPUT_INGEST.md` (Phase 8 user-input ingest), `docs/specs/coach-chat.md` (coach happy path), `src/core/coach/decision-coach.ts` (engine).
**Date:** 2026-06-18

## Goal

Let the Decision Coach optionally draw on the user's **Knowledge Wiki** — their business facts *and their own ingested thoughts* — for additional context, **without diluting its principles-mirror focus**. The control is a **user-flipped toggle**, not an always-on injection: the human decides each session whether business context is in play. This puts the human at the gate, which is what keeps a verbose LLM from drifting into generic business-advisor mode.

## Design principles (the non-negotiables)

1. **Wiki is fuel for sharper questions, never subject matter the coach lectures on.** The coach still grounds everything in the user's stated **Principles**, still asks Socratic questions, still ends every turn on a reflection question. The wiki only makes those questions *specific to this user* (e.g. "Customer X is 40% of ARR" → a pointed **Embrace Reality** question instead of a generic one).
2. **Human-gated, not auto-injected.** When the toggle is OFF the coach is spawned exactly as it is today — zero wiki, hermetic. The default coach behavior is unchanged.
3. **On-demand retrieval, not pre-injection.** When ON, the coach gets wiki **read tools** (`Read`/`Grep`/`Glob`) + the compact catalog and pulls only what it needs for the current message. We deliberately do **not** reuse the member CLI pre-injection path (`retrieveWikiContext`) here — the user chose on-demand so the model fetches just-in-time rather than always having a fact-dump in front of it.
4. **Quality over cost.** On-demand tool retrieval re-introduces the uncapped-tool-turn cost the member-retrieval work moved away from. That is an accepted tradeoff here because (a) it's user-gated and (b) quality trumps cost for this product. **Do not "optimize" this back to CLI pre-injection** — that would break the on-demand model. (See memory `quality-trumps-cost`.)
5. **Bidirectional when ON.** The toggle wires the wiki to the coach *both ways*: the coach **reads** the wiki, and the user's coach messages get **ingested into** the wiki (their decision-thinking accumulates and feeds future context — arguably the most on-brand thing a Dalio coach can do).

## Behavior

### The toggle
- **Per-session, persisted, flippable mid-session.** New `DecisionSession.useBusinessWiki?: boolean` (default `false`). Flip it any turn; it sticks for the session until flipped again.
- **The per-session toggle is the SOLE control — no global opt-in.** Updated after first ship (the original `knowledgeWiki.exposeToCoach` global gate was removed): the user wanted the wiki toggle available *directly*, with no Settings step. The toggle is surfaced right in the **New Coach Session modal** (set it ON at creation) and in the **composer** (flip it any turn). Default OFF per new session keeps out-of-the-box behavior unchanged.

### Read side (toggle ON)
- `coachReply` spawns with:
  - `allowedTools: ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob']` (adds the three read tools to today's web tools).
  - `addDirs: [workspaceRoot]` so the session can reach `wiki/` (which lives under the workspace root, not the spawn cwd — same reason members pass it).
  - A **wiki-instruction block** appended to the system prompt, reusing the member framing tone: consult `wiki/.aab/catalog.json` (the compact index) first, never `Read index.md` in full, `Read` 1–3 relevant pages, and — critically — **"use what you find to ask sharper principle-grounded questions; do NOT summarize, quote at length, or advise on the wiki's contents."**
  - **Layering:** wiki (internal, user-specific) is the default source for "who is this user / what's their business"; web search stays the fallback for generic external facts. Mirror the member-prompt rule ("web search is the fallback, not the default").
- Toggle OFF → spawned exactly as today (`allowedTools: ['WebSearch','WebFetch']`, no `addDirs`, no wiki block).

### Write side (toggle ON)
- After each **user** turn (not the opener, not assistant turns), fire-and-forget `ingestUserFacts({ text: userMessage, kind: 'coach_message', coachSessionId, workspace, settings })` so the user's thoughts land in the wiki via the Phase 8 merge agent (dedup-on-read, empty result is valid).
- Gated by `session.useBusinessWiki && settings.knowledgeWiki.autoIngestUserInputs`.
- **Fire-and-forget** (`.catch(noop)`), exactly like `fireTokenUsage` — a wiki hiccup must never break or delay a coach turn. Prefer routing through the existing **ingest-queue** (`createIngestQueue`) for the same idempotency/serialization discussions get, rather than calling `ingestUserFacts` inline.
- New `UserInputKind: 'coach_message'` with framing in `KIND_FRAMING`, e.g. *"This is the user thinking through a hard decision with their principles-based decision coach. It is candid, reflective, and high-signal about their real situation, values, and what they're weighing."*

### Transparency
- Detect on-demand wiki use from the stream (`onEvent` tool_use events for `Read`/`Grep`/`Glob`) and record `DecisionMessage.usedWiki?: boolean`.
- **Sources used (read side).** Capture *which* wiki pages the coach `Read` (and what it `Grep`/`Glob`'d for) into `DecisionMessage.wikiUsage = { sourcesRead[], queries[] }`. The web UI renders the **📚 wiki** badge as an **expandable disclosure** ("📚 wiki · N sources ▸") that lists the pages used (each links to the Knowledge view) and the search terms.
- **Ingested (write side).** The user-fact merge result for a turn is recorded onto that user message as `DecisionMessage.wikiIngest = { producedPages[], updatedPages[], notes? }` via the ingest-queue's `onResult` callback (awaited so the CLI persists it before exit; the server streams it live via a `coach_wiki_ingested` WS event). The UI shows a **📥 Added to your wiki (N)** note under the user turn (new / updated page chips), or "nothing new to add".

## Surfaces

### Web UI (`gui/`)
- **Toggle in the New Coach Session modal** (`openNewCoachSessionModal`): "📚 Use Business Wiki" checkbox; its state is sent as `useBusinessWiki` on `POST /api/coach/sessions`, so a session can start with the wiki already wired.
- **Toggle button** in the coach composer (`renderCoachChat`, near the Send button): "📚 Use Business Wiki" with on/off state, **always rendered** (no global gate). Reflects `currentSession.useBusinessWiki`.
- Flipping it `PATCH`es the session; the per-message POST also carries the current state so a flip + send in one go is atomic.
- New endpoint **`PATCH /api/coach/sessions/:id`** `{ useBusinessWiki: boolean }` (mirrors the discussions `PATCH`). Broadcast `coach_session_updated`.
- `📚 wiki` badge in the message stream as above.

### CLI (`src/commands/coach.ts`)
- **`aab coach --wiki`** — start a new session (or resume) with `useBusinessWiki: true`.
- **`aab coach send <id> <msg> --wiki`** — one-shot turn with the wiki on; persists the flag onto the session so it sticks.
- Optionally `aab coach wiki <on|off> <session>` to flip an existing session without sending. (Nice-to-have; `--wiki` on `send` covers the core need.)
- `--wiki` just sets `useBusinessWiki: true` on the session — no global opt-in to honor.

## Code touch-points (implementation checklist)

- `src/storage/types.ts`
  - `DecisionSession.useBusinessWiki?: boolean`.
  - `DecisionMessage.usedWiki?: boolean`.
  - (No global `exposeToCoach` setting — the per-session toggle is the sole control.)
- `src/core/coach/decision-coach.ts`
  - `CoachReplyOptions`: add `useWiki?: boolean`, `workspaceRoot?: string`, `wikiDir?: string`.
  - When `useWiki`, extend `allowedTools`, set `addDirs`, append the wiki-instruction block (new builder `buildCoachWikiInstruction()`), keep `strictMcpConfig: true`.
  - Track tool-use via `onEvent` → set `coachTurn.usedWiki`.
  - Keep the read side pure here; fire the **write-side** ingest in the *callers* (server + command), not in the engine.
- `src/core/prompts/wiki-merge.ts` — add `'coach_message'` to `UserInputKind` + `KIND_FRAMING`.
- `src/core/knowledge/ingest-user-facts.ts` — accept `coachSessionId?` for manifest provenance (alongside `discussionId` / `sparringSessionId`).
- `src/gui/server.ts` — `PATCH /api/coach/sessions/:id`; pass `useWiki`/workspace paths into `coachReply`; fire the gated user-fact ingest after a user turn; broadcast `coach_session_updated`.
- `src/commands/coach.ts` — `--wiki` on the default action + `send`; thread workspace paths + `useWiki` into `coachReply`; fire the gated ingest.
- `gui/app.js` — new-session-modal toggle + composer toggle (always shown), `PATCH` wiring, `📚 wiki` badge.
- `gui/style.css` — toggle + badge styling.

## Verification (when built)
- **Live CLI smoke** from the external test folder: a session with a wiki containing a relevant fact, toggle ON → the coach asks a *sharper, principle-grounded question* that reflects the fact **without lecturing on it**; toggle OFF → identical to today (no wiki tools, no ingest). Confirm a user turn with the toggle ON produced a wiki ingest (`wiki/log.md` / manifest entry, `kind: coach_message`).
- **Playwright MCP smoke**: toggle present in the new-session modal and the composer (no settings step); creating a session with it ON persists `useBusinessWiki: true`; flipping persists across reload; `📚 wiki` badge appears on turns that used the wiki.
- Unit test: `buildCoachWikiInstruction()` framing contains the "ask sharper questions, do not lecture" guardrail; `coachReply` adds the read tools + `addDirs` only when `useWiki`.

## Explicitly out of scope (v1)
- CLI-side pre-injection for the coach (we chose on-demand).
- Auto-relevance-scoring / always-on context (rejected — the human toggle is the gate).
- Ingesting the coach's *assistant* replies into the wiki (only the **user's** words are ground truth; same rule as Phase 8).
