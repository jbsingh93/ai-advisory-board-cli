# Skill Plan-only flow

Drive the Skill Planner via the Web UI without invoking skill-creator. Verifies
that the Plan button opens the proposal modal with all sections populated and
the markdown export works.

**Prereqs:**

- `aab ui` is running on `http://localhost:3737` against a workspace with at
  least one Action Item that has a populated `description`.
- The Knowledge Wiki has ≥1 page so the wiki-recon phase has something to find.
- `skill-creator` is NOT required for this flow (plan-only doesn't invoke it).

**`data-testid` references:** `nav-actions`, `plan-btn`, `planner-progress-pane`,
`planner-phase-pc-scan`, `planner-phase-wiki`, `planner-phase-web`,
`planner-phase-reasoning`, `planner-proposal-modal`, `proposal-skill-name`,
`proposal-tier-radio`, `proposal-integration-row`, `proposal-export-btn`,
`proposal-reject-btn`.

## Steps

1. `browser_navigate http://localhost:3737`
2. `browser_click` the `nav-actions` button (📋 Action Board).
3. `browser_verify_element_visible` an action card with `data-testid="kanban-card"`.
4. `browser_click` the `plan-btn` on the first card.
5. `browser_verify_element_visible` the `planner-progress-pane` modal.
6. `browser_wait_for` the `planner-phase-reasoning` element to have
   `data-status="done"` (≤14 min hard cap; Planner typical is 2-4 min).
7. `browser_verify_element_visible` the `planner-proposal-modal`.
8. `browser_verify_element_visible` at least one `proposal-integration-row`.
9. `browser_verify_element_visible` the `proposal-tier-radio` block.
10. `browser_verify_text_visible` "maximalist" (the recommended tier is
    rendered as a label).
11. `browser_click` the `proposal-export-btn` — verify a new tab opens with
    markdown content (the response from `/api/plans/:planId?as=md`).
12. `browser_click` the `proposal-reject-btn` — verify the proposal modal closes.

## Expected observations

- The four-phase Planner progress pane streams updates as the recon orchestrator
  walks PC scan → wiki recon → web research (parallel; the last-completing one
  flips the phase to `done`) → reasoning.
- The proposal modal renders the skill name, tier radio, integrations,
  stakeholders (if any), narrative editor textarea, and cost line.
- Reject closes the modal without persisting a `SkillGenerationRun` (verify via
  GET `/api/actions/:id/runs` returning the pre-flow run count).
