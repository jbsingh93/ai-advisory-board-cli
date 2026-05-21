# `docs/specs/principles-explore-wizard.md` — Principles: 5-step Explore wizard

**Phase:** 2 (Principles)
**Surface:** Per-principle card `data-testid="principle-explore-btn"`; modal `#explorer-modal`.
**Endpoints:**
- `POST /api/principles/explore-step` → `{ reply, synthesised, suggested }`
- `POST /api/principles/apply-step` → `{ principle }` (merges value into draft)
- `PATCH /api/principles/:id` or `POST /api/principles` on completion.
**Engine:** `src/core/coach/principle-explorer.ts`

## Pre-conditions
- At least 1 active principle.
- `claude` on PATH; settings.primaryModel set.

## Steps
1. Navigate to **Principles**.
2. On any principle card, click **🔎 Explore** (`data-testid="principle-explore-btn"`).
3. Explorer modal opens. Title reads `Explore: <principle title> — Behavior`.
4. Step indicator shows 5 dots; first dot active. (`data-testid="explorer-step-behavior"`)
5. The transcript area auto-fires the opener turn → after a few seconds, an assistant message appears asking a Socratic question about WHEN/HOW to apply this principle.
6. Type a 1-sentence answer into the composer (`data-testid="explorer-input"`) and click **Send** (`data-testid="explorer-send"`).
7. The assistant replies — either with another probing question, or with a `**Suggested Behavior:** …` synthesis line.
8. When synthesis is detected (`synthesised: true` from the server), the **Next step** button becomes visible at the bottom of the modal.
9. Click **Next step**. The draft accumulates the synthesised value. The title flips to `… — Anti-pattern`. Cross-step context (the behavior turn) is included in the new step's system prompt.
10. Repeat for `antipattern → triggers → examples → priority`. The working-draft summary at the bottom of the modal updates after each apply.
11. On the final step (priority), clicking **Next step** triggers save:
    - For an existing principle → `PATCH /api/principles/:id` with the accumulated `behavior, antiPattern, triggerQuestions, examples, priority`.
    - For a new draft → `POST /api/principles` with the full payload.
12. Toast "Saved refined principle "<title>"." or "Created new principle "<title>".".
13. Modal closes; principles list shows the updated card.

## Negative cases
- Click **Skip this step** at any point → the pending synthesis is dropped and the wizard advances to the next step without applying.
- Close the modal mid-flow → no save (in-progress draft is lost).
- Coach call fails mid-step → toast "Coach failed: <message>"; user can retry.

## What this catches
- The cross-step context contract (`renderCrossStepContext` includes prior turns; each step's prompt acknowledges them).
- `extractSuggested` parsing for all 5 step formats (regex anchors `**Suggested Behavior:**`, `**Suggested Anti-Pattern:**`, etc.).
- `applyStep` correctly transforming free text into `triggerQuestions: string[]` / `examples: string[]` / `priority: number (1..10)`.
- Storage update mode: existing principle PATCH vs. new POST.
