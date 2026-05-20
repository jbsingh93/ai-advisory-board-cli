# `specs/actions-extract-from-discussion.md` — Auto-extract action items from a discussion

**Phase:** 4 (Action Board — Kanban)
**Surface:** `data-testid="extract-actions-btn"` (visible in the chat footer of a concluded discussion) → `data-testid="extract-actions-modal"`.
**Endpoints:**
- `POST /api/discussions/:id/actions/extract` (no body) → `{ candidates: ExtractedActionItem[], method: 'structured'|'llm'|'fallback', analysisConfidence: number, ... }`.
- `POST /api/discussions/:id/actions/extract` with `{ accept: [...] }` → `{ created: ActionItem[] }`; broadcasts `actions_extracted` + one `action_created` per accepted candidate.
**Engine:** `src/core/actions/conversation-analyzer.ts:extractActionItems` — structured-data fast path first (no LLM call), LLM fallback on `fastModel`.

## Pre-conditions
- A **concluded** discussion (`completedAt` is set) with ≥1 round of responses. The richest fixture is a discussion where members produced `structuredData` payloads — `aab discuss show <id> --json` should show `actionSteps: [...]` on at least one response.
- UI server running; browser at `http://localhost:3737`.

## Steps — structured-data fast path
1. Click **Discussions** in the sidebar.
2. Open the concluded discussion. The chat footer shows `✓ Discussion concluded.` and a **📋 Extract actions** button (`data-testid="extract-actions-btn"`).
3. Click the button. The extract modal opens (`data-testid="extract-actions-modal"`) titled "Extract action items".
4. The status line (`data-testid="extract-status"`) updates from "Running analyzer…" to e.g. `"5 candidates via structured (conf 82/100)"` within ~200ms (no LLM call).
5. The candidates list (`data-testid="extract-list"`) renders one `data-testid="extract-row"` per candidate, each with:
   - A checkbox (`data-testid="extract-checkbox"`) pre-selected.
   - Title, description, and a meta line: `priority · category · conf N`.
6. Deselect ≥1 row's checkbox; the **Accept selected** button (`data-testid="extract-accept-btn"`) updates its disabled state if 0 remain.
7. Click **Accept selected**.
8. Toast: `Created N action items` (where N is the number of checked rows).
9. Modal closes. Navigate to **Actions** — the new cards appear in the **pending** column with `discussionId` pointing back to the source discussion.
10. WS broadcasts: one `action_created` per accepted candidate + a final `actions_extracted` summary.

## Steps — LLM fallback path
11. Find or create a discussion where **none** of the responses carry `structuredData` (e.g. a one-round discussion where the parser fell back to raw text).
12. Click **📋 Extract actions**.
13. The status line shows `Running analyzer…` for 10-60s (one-shot Haiku call).
14. Once complete, the line updates to e.g. `"3 candidates via llm (conf 75/100)"`.
15. Continue from step 6 above.

## Steps — fallback (no signal) path
16. Find or create a discussion that is concluded but where members produced empty content (rare, e.g. an aborted discussion with no real LLM output).
17. Click **📋 Extract actions**.
18. Status line: `"0 candidates via fallback (conf 0/100)"`; an empty state appears: "No candidates — No structured signal — and the LLM fallback produced nothing actionable."
19. Close button works; **Accept selected** is disabled.

## Negative cases
- Click **📋 Extract actions** on a **non-concluded** discussion → button is not rendered (footer shows the Continue / Respond actions instead).
- Server returns 500 → status line shows `Extract failed: …`; user closes the modal and retries.
- Accept with 0 candidates checked → button is disabled; click is a no-op.
- Concurrent re-extract while a previous request is in flight → the second request still works (server is stateless re: extract; the analyzer is pure).

## What this catches
- **Structured-data fast path is pure** (no LLM call): the analyzer reads each `response.structuredData.actionSteps` and `.questionsForOthers`, deduplicates by normalized title, and bumps confidence when two members converge. `extractActionItems` must finish in < 500ms when structured data is present.
- **LLM fallback path** uses `fastModel` with `maxTurns: 1` and `allowedTools: []` (no persona) — mirrors `summarize.ts`. The JSON contract is `conversationAnalysisPayloadSchema` and parse failures degrade to confidence-0 fallback without throwing.
- **Accept-list contract**: server validates each accepted candidate has a non-empty `title`; coerces priority via `coerceActionPriority`; default status is `pending`; persists via `saveActionItem` + atomic write to `action-items.json`.
- **Provenance**: every created `ActionItem` carries `discussionId === discussion.id`, enabling the future "linked discussion" deep-link in the action detail panel.
- **WS reconciliation**: a second browser tab on the Actions view sees the new cards land via `action_created` + `actions_extracted` without manual reload.
