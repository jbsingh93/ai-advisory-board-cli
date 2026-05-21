# `docs/specs/a11y-audit.md` — Per-tab accessibility audit

**Phase:** 6.6 (cross-cutting)
**Surface:** All sidebar tabs.

Implements Pattern D ("accessibility audit") from `docs/development/PLAYWRIGHT_MCP.md` §7. Each tab gets a snapshot + a list of any unlabeled interactive elements + a remediation note. Lives at `docs/specs/a11y-audit.md` so the next agent can re-run it and append a new audit block dated to the run.

## Pre-conditions
- `aab ui` running.
- Workspace with seeded members + principles + at least one ingested wiki page.

## Steps (run once per tab)
For each tab in `[discussions, actions, members, principles, coach, knowledge, skills, usage, settings]`:

1. `browser_click tab-<route>`.
2. `browser_snapshot` and capture the result.
3. Scan the snapshot for:
   - Buttons without a visible text label **and** without `aria-label`.
   - Images without `alt` (icon `<img>` should be `aria-hidden="true"` or have a meaningful `alt`).
   - Form inputs without an associated `<label>` or `aria-label`.
   - Decorative icons (emojis inside `<span class="nav-icon">`, status dots, `brand-mark`) that are missing `aria-hidden="true"`.
   - Live regions: typing-dot bubbles (`member-typing-<slug>`) should be `role="status" aria-live="polite"`; orchestrator decisions (`orchestrator-decision-<round>`) similarly.
   - Dialogs: the new-discussion modal, edit modal, confirm modal, HITL panel, sparring panel, principle explorer modal must be `role="dialog" aria-modal="true"`.
   - Keyboard-trap or focus-order problems: tab through the page; the order should follow visual reading order.

4. Record findings in the audit block below (append, don't overwrite).

## Audit log

### 2026-05-21 — baseline after Phase 6.6 chunk 2
- **Sidebar:** all nine `tab-<route>` buttons now have `data-testid` and visible labels; the `nav-icon` emoji spans carry `aria-hidden="true"`. Sidebar itself is `<aside aria-label="Navigation sidebar">`. The `brand-mark` and `status-dot` are `aria-hidden`. The `ws-label` is `role="status" aria-live="polite"`. The `<main>` is `role="main" data-testid="main"`. ✅ No unlabeled buttons.
- **Discussions tab:** `new-discussion` button has visible text; `discussion-list` is a labelled group; each `discussion-row-<shortId>` is `role="button" tabindex="0"` (keyboard reachable). The `chat-stream` is `role="log" aria-live="polite"`; per-member typing bubbles are `role="status"` with `aria-label="<member> is thinking"`; orchestrator decisions are `role="status"`. The HITL panel (`hitl-panel`) is `role="dialog" aria-modal="true"` with `aria-labelledby="hitl-reply-heading"`; `hitl-reply-input` has `aria-label="Reply to the board"`. The new-discussion modal is `role="dialog" aria-modal="true"`; member chips are `<button role="checkbox" aria-checked>` with `aria-label="Toggle <name>"`. ✅ No regressions.
- **Action board:** all CTAs (`actions-add-btn`, `kanban-card`, `plan-btn`, `solve-btn`, `extract-actions-btn`) already had testids in Phase 4. ⚠ Verify in next pass: drag-drop affordances may not be discoverable via keyboard; consider keyboard-move buttons as a future a11y improvement.
- **Members tab:** `members-sync-btn`, `members-add-btn`, `member-edit-btn`, `member-voice-btn`, `member-delete-btn` all labelled. Voice button uses an emoji prefix + text label (`🔊 Voice`) — readable.
- **Principles tab:** `principles-seed-btn`, `principles-add-btn`, `principle-explore-btn` all labelled.
- **Coach tab:** `coach-new-session-btn`, `coach-input` (with placeholder + visible context), `coach-send-btn`, `coach-delete-btn` all labelled.
- **Knowledge tab:** verify in next live MCP run — page rows + ingest/query/lint buttons. (Phase 1.5 ships its own `docs/specs/knowledge-tab.md`.)
- **Skills tab:** `skills-tab`, `skills-list`, `skill-show-btn`, `skill-test-btn` already labelled in Phase 5.
- **Usage tab:** `usage-view`, `usage-totals`, `usage-sparkline`, sparkline bars have hover tooltips via `title` attribute. ⚠ Bars are not keyboard-focusable — future a11y improvement.
- **Settings tab:** verify on next live MCP run.

### Top 3 highest-impact fixes (open)
1. Kanban drag-drop is not keyboard accessible — add a per-card move action menu or keyboard shortcuts.
2. Usage sparkline bars are mouse-only — make them `<button>` or add per-bar `tabindex` + key handlers.
3. The `confirm-modal` dialog should trap focus while open (verify; currently focus may escape to the underlying view).

## Pattern D prompt for re-running
```
Audit http://localhost:3737 for accessibility issues. For each tab in the sidebar
(tab-discussions, tab-actions, tab-members, tab-principles, tab-coach,
tab-knowledge, tab-skills, tab-usage, tab-settings):
1. Navigate, take a browser_snapshot.
2. List every interactive element that lacks a visible label or aria-label.
3. List every image without alt text.
4. List every form input without an associated label.
5. Report keyboard-trap or focus-order problems if any.

Append the findings as a new dated block under `## Audit log` in this file.
```
