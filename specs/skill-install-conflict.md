# Skill install conflict — name collision

Installing two skills with the same name back-to-back exercises the conflict
handler: overwrite (default in `--yes`/GUI), rename (`<name>-2`), or abort.

**Prereqs:**

- `skill-creator` installed.
- Workspace seeded per Recipe A.
- `aab ui` running.

**`data-testid` references:** `solve-btn`, `proposal-accept-btn`.

## Steps

### Variant A — overwrite (GUI default with `--yes` semantics)

1. Solve the Recipe-A action end-to-end (per `skill-solve-happy-path.md`).
2. Verify install at `.claude/skills/record-q3-launch-intro/`.
3. Re-solve the SAME action — click `solve-btn` again.
4. Wait for Plan → Accept → install.
5. Verify:
   - Install completes without prompting (`--yes` semantics).
   - The previous skill is archived to
     `.claude/.snapshots/skills/record-q3-launch-intro-<ts>/`.
   - The new install replaces the old at `.claude/skills/record-q3-launch-intro/`.

### Variant B — rename (CLI only)

1. From the terminal, run:
   ```
   aab actions solve <id>  # accepts conflict prompt → choose "rename"
   ```
2. Verify the install lands at `.claude/skills/record-q3-launch-intro-2/`.

### Variant C — abort (CLI only)

1. `aab actions solve <id>` → accept conflict prompt → choose "abort".
2. Verify the CLI exits with code 1 and a clear "Install aborted" message.
3. Verify no new files were written.

## Expected observations

- The `installSkillPackage` overwrite path archives via `rename` (same volume)
  or `cp + rm` (cross-volume) — both leave the archive intact for
  `aab skills restore`.
- Rename uses `<name>-2`, `<name>-3`, ... incrementing until a free slot.
- Snapshots are retained at most `snapshotRetentionCount` (default 5) — older
  entries are pruned silently.
