# `docs/specs/coach-session-list.md` — Decision Coach: session list, resume, delete

**Phase:** 2 (Decision Coach)
**Surface:** `data-testid="coach-session-list"` (sidebar of coach view).
**Endpoints:**
- `GET /api/coach/sessions` → `{ sessions: DecisionSession[] }` (sorted by updatedAt desc).
- `GET /api/coach/sessions/:id` → resume.
- `DELETE /api/coach/sessions/:id` → 204.
**Storage:** `decision-sessions/<id>.json` (one file per session).

## Pre-conditions
- At least 3 coach sessions exist (run `coach-chat.md` 3× with different situations).

## Steps
1. Navigate to **Coach**.
2. The session list (`data-testid="coach-session-list"`) shows all 3 sessions, **sorted by recency** (most recently updated on top).
3. Each row (`data-testid="coach-session-row"`) shows: title (or truncated situation), message count, status (`active|decided|reflected`), and a relative timestamp.
4. Click the **middle row**. The right pane loads the full transcript from disk.
5. Verify message bubbles render in role order with content preserved. Principles-referenced footnotes show under coach replies when the message stored a non-empty `principlesReferenced` array.
6. Click **Delete** (`data-testid="coach-delete-btn"`) in the chat head. Confirm modal opens with "Delete this coach session?".
7. Confirm. Toast "Session deleted." WS `coach_session_deleted` fires.
8. The deleted row vanishes from the sidebar. The right pane reverts to the empty-state ("Pick a session, or start a new one").
9. Verify on disk: `<workspace>/decision-sessions/<id>.json` is gone.
10. Send a new message into one of the **remaining** sessions → its `updatedAt` advances → on next `GET /api/coach/sessions` it moves to the top of the list.

## Negative cases
- Delete a session that doesn't exist (race) → 404 with the friendly error.
- Click a stale row mid-fetch (network slow) → loading hint visible; final state is consistent with the server.

## What this catches
- `FsStorageService.loadDecisionSessions` sort order (desc by updatedAt).
- The cascade between WS events and the sidebar re-render (`aab-coach-event` listener).
- Short-id resolution: in the CLI counterpart `aab coach show <prefix>` accepts a partial id and finds the right session.
