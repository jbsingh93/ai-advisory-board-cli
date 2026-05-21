# Skill Planner — maximalist tier across ≥3 integrations

Verifies the depth-of-feature thesis: on an action with ≥3 detectable
integrations in the user's environment, the Planner surfaces a maximalist
tier with ≥3 distinct multi-tool orchestrations.

**Prereqs:**

- Workspace seeded per `PLAN/SKILL_CREATOR.md` §20a Recipe A (Elgato + Google
  Calendar MCP + Mads wiki entity) OR Recipe D (multi-MCP — Greenhouse +
  Calendar + Slack).
- `aab ui` running.

**`data-testid` references:** `plan-btn`, `planner-proposal-modal`,
`proposal-integration-row`, `proposal-integration-toggle`,
`proposal-stakeholder-row`.

## Steps

1. `browser_navigate http://localhost:3737`
2. Open the Action Board (`nav-actions`).
3. Click the `plan-btn` on the seeded action ("Record YouTube intro for Q3
   launch" for Recipe A; "Hire 2 SDRs for the DK market" for Recipe D).
4. Wait for the proposal modal.
5. `browser_verify_list_visible` — at least 3 elements with
   `data-testid="proposal-integration-row"`.
6. For each integration row, capture the `data-integration-id` attribute.
7. `browser_click` the `proposal-integration-toggle` on the first row → verify
   it deselects.
8. `browser_click` it again → verify it re-selects.
9. Verify the rendered integration kinds span ≥2 distinct values
   (e.g., `bash-curl` + `mcp-tool` + `write-artifact`). Look at the `.planner-kind`
   span text within each row.
10. (Recipe A only) Verify at least one stakeholder row exists
    (`proposal-stakeholder-row`) with the name "Mads Larsen".

## Expected observations

- The Planner's maximalist tier surfaces ≥3 integrations across ≥2 distinct
  surface types (`pc-app` + `mcp-server` + `wiki-entity` for Recipe A;
  `mcp-server` ×3 for Recipe D).
- Toggling integrations dynamically updates the granted-tools projection
  (server-side; not visually surfaced in v1, but the Accept handler honors it).
- The recommended tier is `maximalist`; the radio is pre-checked there.
