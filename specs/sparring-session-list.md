# `specs/sparring-session-list.md` — Sparring: per-discussion session list

**Phase:** 3 (Sparring — list / resume / delete)
**Surface:** Chat-view header → **⚔ Sparring** button (`data-testid="sparring-sessions-btn"`) → opens the sparring list modal (`data-testid="sparring-list-modal"`) containing `data-testid="sparring-session-list"`.
**Endpoints:**
- `GET /api/discussions/:id/sparring` → `{ sessions: SparringSession[] }` (sorted by `updatedAt` desc).
- `GET /api/sparring/:sessionId` → resume one.
- `DELETE /api/sparring/:sessionId` → 204.

**Storage:** `sparring/<discussionId>/<sessionId>.json` (one file per session).

## Pre-conditions
- At least 3 sparring sessions on the same discussion (run `specs/sparring-anchor-deepdive.md` three times: same discussion, three different members or three different (round, turn) anchors).

## Steps
1. Open a discussion with ≥ 3 sparring sessions in the chat view.
2. Click **⚔ Sparring** in the chat-view header.
3. The sparring list modal renders. Each row (`data-testid="sparring-session-row"`) shows:
   - `<member name> · round <anchorRoundNumber> · turn <anchorTurnNumber>`
   - `<messageCount> message(s) · <relative timestamp>`
   - (Optional) the user-supplied `title:` as a subtitle.
4. Rows are sorted by `updatedAt` desc — the most recently used session is at the top.
5. Click the middle row. The list modal closes, the sparring modal opens with the full transcript reloaded from disk.
6. Send one new message → the assistant replies → close the modal.
7. Re-open the sparring list modal — the session you just sent a message into is now at the top (its `updatedAt` advanced).
8. From the sparring panel header: when the user closes via the × icon, no `DELETE` request is sent (close ≠ delete; closing just hides the modal, the session remains on disk).
9. Open the CLI side and run `aab discuss spar list <discussion-id>` — the three sessions are listed with matching member names + anchors + message counts.
10. Run `aab discuss spar show <session-prefix>` (8-char short id) → the full transcript prints.

## Negative cases
- Open the list modal on a discussion that has zero sparring sessions → the body reads "No sparring sessions yet. Click ⚔ Spar on any response in the chat to start one." — no row list.
- The CLI's `aab discuss spar --resume <bad-id>` errors with "No sparring session matches "<id>" in discussion <short>".
- Deleting the only session via the CLI (no UI delete yet) → next `GET /api/discussions/:id/sparring` returns `{ sessions: [] }` and the list modal renders the empty state.
- Race: open the list modal, delete a session via the CLI, click the just-deleted row in the UI → server returns 404 with the friendly error message; the UI surfaces it as a toast and refetches.

## What this catches
- `FsStorageService.loadSparringSessionsForDiscussion` sort order (desc by `updatedAt`).
- Per-discussion sparring directory layout: `sparring/<discussionId>/<sessionId>.json` (multiple sessions per discussion are valid).
- `aab discuss spar list <discussion-id>` short-id resolution: a 4-char-or-longer prefix of either the discussion id or the session id is enough.
- WS reconciliation: `sparring_session_opened` / `sparring_session_deleted` events trigger the list modal to refetch when open (and silently no-op when closed).
