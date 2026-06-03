# `docs/specs/boards-manage.md` — Boards: create / edit / activate / delete + member-delete prune

**Phase:** 7 (Boards) · **Surface:** Board members view (Boards section), shared `#edit-modal`.

**Endpoints:** `GET/POST /api/boards`, `PATCH/DELETE /api/boards/:id`, `POST /api/boards/:id/activate`, `GET /api/boards/active`. Member delete (`DELETE /api/members/:id`) returns `{ affectedBoards, emptiedBoards }` and cascade-prunes the member from every board (`pruneMemberFromBoards`).

**WS events:** `board_created`, `board_updated`, `board_deleted`, `board_activated` → the client refreshes state and re-renders the Members view.

**`data-testid` references:** `boards-section`, `board-card`, `board-card-title`, `board-create-btn`, `board-name-input`, `board-desc-input`, `board-member-chip`, `board-save-btn`, `board-edit-btn`, `board-use-btn`, `board-delete-btn`.

## Pre-conditions
- A seeded workspace with ≥3 active members and ≥1 board (`aab init` seeds "Full Board").

## Variant A — create a board
1. `browser_click tab-members`. The **`boards-section`** renders below the member grid with one card per board (overlapped avatars `+N` overflow + member count + active `★` badge).
2. `browser_click board-create-btn`. The shared edit modal opens titled "Create board".
3. `browser_type board-name-input` → `UI Smoke Board`.
4. `browser_click` two `board-member-chip`s to select them.
5. `browser_click board-save-btn`.
6. A new `board-card` titled `UI Smoke Board` (2 members) appears; toast `Board "UI Smoke Board" created.`

## Variant B — activate a board
1. On a non-active board card, `browser_click board-use-btn` ("Set active").
2. The `★ active` badge moves to that card; its button becomes `✓ Active` (disabled). `GET /api/boards/active` now returns it.

## Variant C — edit a board (rename + roster)
1. `browser_click board-edit-btn` on a card. Modal opens titled `Edit <name>` with the name/description pre-filled and the board's members pre-checked (in order, first).
2. Change `board-name-input`, toggle a `board-member-chip`, `browser_click board-save-btn`.
3. The card reflects the new name + member count (the slug is regenerated server-side).

## Variant D — delete a board (members untouched)
1. `browser_click board-delete-btn` → confirm modal → confirm.
2. The card disappears; the member grid is unchanged (deleting a board never deletes members).

## Variant E — member delete prunes boards
1. Add a throwaway member to two boards (via the edit modal).
2. Delete that member (`member-delete-btn` → confirm).
3. Toast reads `… · pruned from N board(s)`. Affected board cards show a reduced member count; an emptied board is **kept** (not auto-deleted).

## Expected observations
- Validation: empty name, name > 100 chars, duplicate name (case-insensitive), or zero members → the modal Save surfaces a toast and the POST/PATCH returns 400.
- The active board is per-workspace (`settings.activeBoardId`); reloading the page preserves the `★` badge.

## Failure modes worth a screenshot
- Save succeeds but no card appears → WS `board_created` not handled / state not refreshed.
- Active badge on two cards at once → `board_activated` race.
