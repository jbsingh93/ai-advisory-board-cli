# Regression — `silent-empty-modal`

**Origin:** CHANGELOG.md 2026-05-15 (approx). The new-discussion modal used to render an empty `<div id="member-chips">` and a disabled submit button with no explanation when the workspace had **zero active members**. Users hit `New discussion`, saw nothing, and assumed the app was broken.

**Fix landed in:** `gui/app.js:openNewDiscussionModal()` — when `active.length === 0`, the chips container is filled with a loud `<div class="modal-empty">` block showing the workspace ID + root + remediation hint (`Click "Board members" in the sidebar to add one, or run \`aab init\` from this directory`).

## Repro pre-condition
- A workspace whose `members.json` contains zero `isActive: true` rows. The easiest way is to bootstrap a throwaway workspace via `aab init --non-interactive --home --name regression-empty-<date>` and then deactivate every seeded member via the Members tab.

## Steps
1. `browser_navigate http://localhost:3737`.
2. `browser_click tab-discussions`.
3. `browser_click new-discussion`.
4. `browser_wait_for { ref: new-discussion-modal }`.
5. `browser_snapshot`.

## Pass criteria
- The modal body contains:
  - `⚠ No active members in this workspace` heading.
  - `Workspace: <id>` text.
  - The workspace root path (monospace).
  - `Either this is the wrong workspace, or no members were seeded. Click "Board members" in the sidebar to add one, or run \`aab init\` from this directory.`
- The Start discussion button (`new-discussion-start`) is **disabled**.

## Fail signal (regression returned)
- The modal body has an empty `member-chips` div and **no** `modal-empty` block. User has no idea why nothing's happening.

## Notes
The `data-testid="new-discussion-modal"` and the `Start discussion` button being `disabled` (not just hidden) are the two stable hooks the test relies on. If the button is renamed or the wrapper div changes, update this spec and the wired test.
