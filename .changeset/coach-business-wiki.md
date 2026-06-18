---
"ai-advisory-board": minor
---

Decision Coach × Business Wiki: optionally wire the Knowledge Wiki to the Decision Coach, gated by a per-session "📚 Use Business Wiki" toggle.

When ON, the wiki is wired **both ways**: the coach reads your business facts and your own ingested thoughts on-demand (`Read`/`Grep`/`Glob` over the workspace, catalog-first), and your coach messages are ingested back into the wiki so your decision-thinking accumulates. The wiki is fuel for *sharper, principle-grounded questions specific to you* — never subject matter the coach lectures on. When OFF (the default), the coach is the same hermetic principles-mirror as before.

- Per-session toggle, flippable mid-session; opt-in globally via `knowledgeWiki.exposeToCoach` (default off).
- CLI: `aab coach --wiki` and `aab coach send … --wiki` (errors with a hint when the global opt-in is off).
- Web UI: composer toggle (gated on `exposeToCoach`) + a `📚 wiki` badge on turns where the coach consulted the wiki.
- New `PATCH /api/coach/sessions/:id` to flip the toggle.
