# Skill Planner — re-plan with feedback

Verifies the Re-plan loop: rejecting a proposal with explicit feedback produces
a second proposal that addresses the feedback.

**Prereqs:**

- Workspace with a Recipe A or C action (seeded per `docs/development/SKILL_CREATOR.md`
  §20a).
- `aab ui` running.

**`data-testid` references:** `plan-btn`, `proposal-replan-btn`,
`replan-feedback-modal`, `replan-feedback-input`, `replan-feedback-submit`,
`planner-proposal-modal`.

## Steps

1. `browser_navigate http://localhost:3737` and open the Action Board.
2. Click `plan-btn` on the seeded action.
3. Wait for the proposal modal.
4. `browser_click` the `proposal-replan-btn`.
5. `browser_verify_element_visible` the `replan-feedback-modal`.
6. `browser_type` into the `replan-feedback-input`:
   > you missed that I want to also publish the recording link to LinkedIn after upload
7. `browser_click` the `replan-feedback-submit` button.
8. Wait for the planner-progress-pane to re-fire `reasoning` (≤3 min — recon
   is reused from the original plan, so this is faster than the first round).
9. Verify a NEW `planner-proposal-modal` opens.
10. Verify the new proposal includes the keyword "LinkedIn" in either a new
    integration, the `valueRationale`, or a stakeholder touchpoint
    (`browser_verify_text_visible` "LinkedIn").

## Expected observations

- The re-plan request reuses the original recon (no re-scan; no per-app web
  passes), so the wall-clock is ~Opus-only (~2 min).
- The feedback string appears in the new Planner prompt's `<replan_feedback>`
  block (verifiable via `aab actions plan <id> --debug --dump-prompt` post-hoc).
- Re-plans are capped at 3 per solve session; a fourth attempt fails with a
  clear error.
- The re-plan endpoint requires `feedback.length >= 10` (server-side guard).
