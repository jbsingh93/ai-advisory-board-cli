# `docs/specs/actions-kanban-dragdrop.md` — Action Board: drag card between columns

**Phase:** 4 (Action Board — Kanban)
**Surface:** `data-testid="actions-view"` → `data-testid="kanban-board"` with three columns `kanban-col-pending`, `kanban-col-in-progress`, `kanban-col-completed`.
**Endpoints:**
- `GET /api/actions` → `ActionItem[]`.
- `PATCH /api/actions/:id` → `ActionItem` (used to persist status changes); broadcasts `action_updated` over WS.
**Engine:** drag-drop is pure DOM (`gui/app.js:wireDropTarget`). Status persistence rides on the existing CRUD path through `FsStorageService.updateActionItem`.

## Pre-conditions
- A workspace with at least three action items, one in each column (use the CLI to seed: `aab actions add "Hire CRO" --priority high`, `aab actions add "Ship pricing test" --priority medium`, `aab actions add "Investigate competitor pricing"`, then `aab actions move <id> in-progress` / `... completed` on two of them).
- UI server running (`aab ui`); browser at `http://localhost:3737`.

## Steps
1. Click **Actions** in the sidebar.
2. Verify the kanban board renders (`data-testid="kanban-board"`).
3. Three columns are present with correct counts in the header chips.
4. Each `kanban-card` carries `data-action-id`, `data-priority`, `draggable="true"`, and `data-testid="kanban-card"`.
5. Drag the **Hire CRO** card from `kanban-col-pending` into `kanban-col-in-progress`.
6. The card's cell is removed from "pending" and inserted into "in-progress" immediately (optimistic update).
7. A `PATCH /api/actions/:id` fires with body `{"status":"in-progress"}` (verify in Network panel).
8. A WS broadcast of `{type:"action_updated", action:{...}, from:"pending", to:"in-progress"}` arrives — the client re-renders the kanban from the fresh state.
9. Toast appears: "Moved to in-progress".
10. Reload the page (`F5`). The card remains in "in-progress" — the change was persisted to `<workspace>/action-items.json`.
11. Drag the same card from "in-progress" into "completed". Repeat checks 6-9.
12. Drag a card from "completed" back to "pending" (regression on the reverse flow).

## Negative cases
- Drag a card onto its **own** column → no-op (`if (item.status === status) return`); no network call.
- Server returns 500 on PATCH (kill the server mid-drag) → client rolls back the optimistic update; toast "Move failed: …".
- Drop outside any `kanban-col` / `kanban-cards` zone → drag is cancelled, no status change.

## What this catches
- **Optimistic UI consistency**: the card moves *before* the PATCH lands; a failed PATCH must roll back the visible state (`gui/app.js:wireDropTarget` catch block).
- **WS-driven reconciliation**: when another tab/CLI moves the same card, the `action_updated` broadcast triggers `refreshState({silent:true})` + `navigate('actions')` so both tabs converge.
- **Status persistence**: `FsStorageService.updateActionItem` rewrites `<workspace>/action-items.json` atomically. A reload must show the new status, proving the write committed.
- **Status alias coercion**: PATCH body may arrive as `"in-progress"`, `"inprogress"`, `"in_progress"`, `"doing"` — server coerces to canonical `"in-progress"` (`src/gui/server.ts:coerceActionStatus`).
