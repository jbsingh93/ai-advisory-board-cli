# `specs/actions-add-edit.md` — Action Board: add, inline edit, delete

**Phase:** 4 (Action Board — Kanban)
**Surface:** `data-testid="actions-add-btn"` → `data-testid="action-edit-modal"` (used for both add and edit).
**Endpoints:**
- `POST /api/actions` → `ActionItem` (201); broadcasts `action_created`.
- `PATCH /api/actions/:id` → `ActionItem`; broadcasts `action_updated`.
- `DELETE /api/actions/:id` → 204; broadcasts `action_deleted`.

## Pre-conditions
- UI server running; browser at `http://localhost:3737`.
- The Actions view is visible.

## Steps — add
1. Click **+ Add action** (`data-testid="actions-add-btn"`).
2. Verify the modal opens (`data-testid="action-edit-modal"`) titled "New action item".
3. Type "Ship the $50k pivot" into `data-testid="action-title-input"`.
4. Paste a longer body into `data-testid="action-desc-input"`: "Cut the ad budget on segment X, redirect to segment Y; target a 30-day learnings review."
5. Pick **high** in `data-testid="action-priority-select"`.
6. Leave **pending** as the default status (`data-testid="action-status-select"`).
7. Pick a due date in `data-testid="action-due-input"` (e.g. 2 weeks from today).
8. Enter "Growth team" in `data-testid="action-assignee-input"`.
9. Click **Create** (`data-testid="action-save-btn"`).
10. Modal closes; toast "Created" appears.
11. The card appears in the **pending** column with title, priority pip (red dot for `high`), due date, and assignee visible.
12. The WS broadcast `{type:"action_created", action:{...}}` arrives — second tab updates too.

## Steps — edit
13. Click the **Ship the $50k pivot** card. The modal reopens with title "Edit action" and all fields pre-populated.
14. Change the priority to **medium**. Click **Save**.
15. Modal closes; toast "Updated". The card's priority pip changes color (orange for medium).
16. Reload. Edit persists — `<workspace>/action-items.json` has the new priority.

## Steps — delete
17. Click the card again to re-open the edit modal.
18. Click **Delete** (`data-testid="action-delete-btn"`).
19. Confirm the native confirm dialog.
20. Toast "Deleted"; card disappears from the board.
21. WS broadcast `{type:"action_deleted", id:"..."}` — second tab refreshes.

## Negative cases
- Submit with an empty title → toast "Title is required."; no POST request fires.
- Server rejects with 409 (e.g. write collision) → toast "Save failed: …"; modal stays open with the user's input intact.
- Click outside the modal (on the backdrop) → modal closes without saving (matches the existing modal-backdrop pattern).
- Cancel button on add → modal closes; no POST.

## What this catches
- **POST contract**: server requires `title`; trims whitespace; coerces priority + status to canonical values via `coerceActionPriority` / `coerceActionStatus` (`src/gui/server.ts`).
- **PATCH merges**: only the fields present in the body are updated; the rest of the ActionItem is preserved. `updatedAt` always advances.
- **DELETE is idempotent against the UI** but the server returns 404 for unknown ids — the modal must surface a useful error.
- **WS event family**: `action_created`, `action_updated`, `action_deleted` cause `refreshState` + `navigate('actions')` only when the current route is `actions` (`gui/app.js:handleWsMessage`).
- **Edit and add share one modal**: the same `openActionEditModal(item?)` function. The `Delete` button is only rendered when `isEdit`.
