---
"ai-advisory-board": minor
---

Action items now capture the discussion context they were born from. When you add an action step to the board (UI, the extract route, or `aab actions add --discussion`), the server snapshots a `sourceContext` onto the item: the original board question, the suggesting member's name + title/expertise, their actual reasoning behind the step, their related key points, and the round number. Previously an action carried only its one-line title plus "Suggested by <member>".

The Skill Planner now receives this as a dedicated, self-describing `<source_context>` prompt block (authoritative statement of intent — it designs the skill for what the advisor *meant*, not just the literal title), and the skill-creator brief carries it through as `action.sourceContext`. In the web UI, action cards show a "↩ From discussion" link and the edit modal gains a read-only **Source** section (question, member, reasoning, key points) that deep-links back to the originating discussion.
