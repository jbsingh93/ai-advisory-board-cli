# Skill Solve — happy path end-to-end

Full Plan → Accept → skill-creator → Install end-to-end from the Web UI.

**Prereqs:**

- `skill-creator` installed (run `/plugin install skill-creator@claude-plugins-official`
  inside Claude Code; verify via `aab doctor`).
- Workspace seeded per `PLAN/SKILL_CREATOR.md` §20a Recipe A.
- `aab ui` running.
- Real Claude calls authorized — this smoke spends ~$2.20 ($1.74 Planner +
  $0.45 skill-creator).

**`data-testid` references:** `plan-btn`, `solve-btn`, `planner-proposal-modal`,
`proposal-accept-btn`, `kanban-card`.

## Steps

1. `browser_navigate http://localhost:3737` and open the Action Board.
2. Click `solve-btn` on the Recipe-A action ("Record YouTube intro for Q3 launch").
   The Solve button calls `launchSkillPlan` → opens the planner-progress-pane.
3. Wait for the proposal modal (≤8 min).
4. `browser_click` the `proposal-accept-btn`.
5. Wait for the toast "Skill installed at …" (≤10 min — skill-creator authoring
   adds 3-10 min to the Planner phase).
6. Verify the action card refreshes and shows a `🧠 skill: <name>` indicator
   in its meta row.
7. Open a terminal: `aab skills list` should now show the new skill at
   project scope.
8. `aab skills show <name>` should pretty-print a valid SKILL.md with
   `allowed-tools` matching the accepted integrations.

## Expected observations

- `actionItem.linkedSkill` is populated (`.name`, `.runId`, `.installedAt`,
  `.installPath`).
- `actionItem.status` flips to `in-progress` (default; `completed` if
  `--complete-on-install` is set).
- `actionItem.skillRunHistory` carries the new runId.
- The emitted SKILL.md is at `.claude/skills/<name>/SKILL.md` with
  `name: <name>`, `description:` starts with "Use when ...",
  `allowed-tools:` is the deterministic projection of accepted integrations,
  `model: inherit` (unless skill-creator specified otherwise).
- The sidecar `~/.aabcli/<ws>/skill-runs/<runId>/installed-at.json` exists.
- `aab actions runs <action-id>` lists the run with cost + duration + status.
