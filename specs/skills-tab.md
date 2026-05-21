# Skills tab — list / show / test / uninstall

Verifies the Skills sidebar tab surfaces every installed skill across project
+ user + plugin scopes, lets the user view a skill's SKILL.md, drives a test
invocation, and supports uninstall + restore.

**Prereqs:**

- ≥1 skill installed at project scope (from `skill-solve-happy-path.md`).
- `skill-creator` installed at plugin/user scope (so the list contains a
  reference plugin-scope entry).
- `aab ui` running.

**`data-testid` references:** `nav-skills`, `skills-tab`, `skills-list`,
`skill-show-btn`, `skill-test-btn`.

## Steps

1. `browser_navigate http://localhost:3737`.
2. `browser_click` the `nav-skills` button (🧠 Skills).
3. `browser_verify_element_visible` the `skills-tab` view.
4. `browser_verify_element_visible` the `skills-list` container.
5. Verify ≥2 rows are listed (the user's recently-installed skill + at
   least one plugin-scoped reference like `skill-creator`).
6. Each row shows: skill name (`<strong>`), scope chip (project / user /
   plugin), version (when present in frontmatter), and install dir.
7. `browser_click` the `skill-show-btn` on the user's installed skill.
8. `browser_verify_element_visible` the run-detail modal with title
   "Skill — <name>" and a `<pre>` containing the SKILL.md body.
9. `browser_click` the `skill-test-btn` on the same row.
10. A `prompt()` dialog appears asking for a test prompt — accept with a
    short string.
11. Verify a toast appears confirming the `aab skills test` command was
    copied to the clipboard (v1 surfaces this as a copy-friendly CLI
    invocation rather than running it in-browser, since the round-trip
    spawns a long-running `claude -p` call).

## Expected observations

- The skills list covers every scope walker hit (`project` → `user` → plugin).
- Each row's `data-skill-name` attribute matches the resolved skill name.
- `skill-show-btn` opens the run-detail modal (re-used from the skill-run
  surface) with the SKILL.md body in pre-formatted text.
- `skill-test-btn` copies a runnable CLI string to the clipboard.

## Uninstall (CLI verification)

1. `aab skills uninstall <name>` — confirm + verify archive at
   `.claude/.snapshots/skills/<name>-<ts>/`.
2. Reload the Skills tab — the uninstalled skill no longer appears.
3. `aab skills restore <name>` — verify the skill reappears at
   `.claude/skills/<name>/`.
