# `docs/specs/boards-start-discussion.md` — New discussion: board picker → convene → verify roster

**Phase:** 7 (Boards) · **Surface:** New-discussion modal.

**Endpoint:** `POST /api/discussions` with body `{ question, memberIds, boardId? }`. When `boardId` is set, the server stamps `discussion.boardId` + `boardName` and enforces `settings.maxMembersPerDiscussion`.

**`data-testid` references:** `new-discussion`, `new-discussion-modal`, `new-discussion-board-tab`, `new-discussion-board-card`, `new-discussion-member-<slug>`, `new-discussion-question`, `new-discussion-start`.

## Pre-conditions
- A seeded workspace with ≥2 boards of differing rosters and ≥3 active members.

## Variant A — pick a board (pre-fills members)
1. `browser_click tab-discussions` → `browser_click new-discussion`.
2. The modal opens. The **`new-discussion-board-tab`** group renders one pill per board (`<name> · <count>`); the active board is visually marked.
3. By default **all** member chips are checked (Individual mode).
4. `browser_click` a board pill whose roster is a strict subset (e.g. "Solo · 1").
5. The pill becomes active; the member chips re-check to **exactly** that board's members (others uncheck). This is the pre-fill.
6. (Optional) the user may still toggle individual `new-discussion-member-<slug>` chips before confirming — doing so clears the board-pill selection (it's no longer "the board").

## Variant B — convene + verify roster
1. With a board selected, `browser_type new-discussion-question` → `What should we prioritise this quarter?`.
2. `browser_click new-discussion-start`.
3. The chat view opens with typing bubbles for **exactly** the board's members (no more, no fewer).
4. After the round lands, the persisted discussion carries `boardId` + `boardName` (verify via `GET /api/discussions/:id`).

## Variant C — cap enforcement
1. Set `settings.maxMembersPerDiscussion` below a board's active-member count.
2. Select that board and start. The POST returns 400 with a "max per discussion" error; a toast surfaces it and no discussion is created.

## Expected observations
- Toggling a board pill off (clicking it again) returns to Individual mode without changing the current member selection.
- A board with 0 active members does not appear as a pill.

## Failure modes worth a screenshot
- Board pill selected but member chips unchanged → pre-fill wiring broken.
- Discussion convenes with all members despite a board pick → `boardId` not threaded into the POST.
