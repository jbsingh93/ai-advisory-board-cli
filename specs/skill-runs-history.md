# Skill runs history — list, show, export

Verifies the run-history surface: listing past runs, showing a single run's
detail (including the embedded Planner proposal), and exporting a run bundle
that includes `proposal.md` alongside the SKILL.md package.

**Prereqs:**

- ≥1 completed skill run in the workspace (run `skill-solve-happy-path.md`
  first).

**CLI surface (no GUI in v1 for this view):**

- `aab actions runs <action-id>` — flat list with timestamp + status + cost
  + duration + skill name.
- `aab actions runs show <run-id>` — pretty-prints metadata + embedded
  Planner proposal (markdown render).
- `aab actions runs export <run-id> --zip <path>` — writes a directory with
  all emitted files + `proposal.md`.

## Steps

1. `aab actions runs list` — verify the list contains the recent run with
   correct cost (~$2.20) + status (`completed`) + skill name.
2. Pick the run id from the list output.
3. `aab actions runs show <run-id>` — verify the output contains:
   - The skill name + install path.
   - The Planner proposal section (with integrations table + value
     rationale + recommended tier).
4. `aab actions runs export <run-id> --zip ./exports/test-run` — verify
   the directory `./exports/test-run/` is created with:
   - `SKILL.md` (the emitted skill).
   - Any `references/` and `scripts/` files skill-creator wrote.
   - `proposal.md` rendered from the embedded `SkillDesignProposal`.
5. `aab actions runs delete <run-id> --yes` — verify the run JSON file is
   removed from `~/.aabcli/<ws>/skill-runs/<actionId>/`.

## Expected observations

- The runs list is sorted newest-first by `startedAt`.
- `runs show` re-renders the proposal markdown identically to the proposal
  modal's GUI render — verifies the persisted `metadata.plannerProposal`
  field is intact end-to-end.
- The export directory contains both the skill files AND the proposal,
  matching the spec's contract for "shareable bundle that includes the
  Planner's reasoning."
