---
"ai-advisory-board": minor
---

Add rename + delete for discussions in the web dashboard (and CLI parity).

- Each discussion card in the UI now has rename (✎) and delete (🗑) actions. Rename sets a display `title` (the original `question` the board was asked is never mutated); delete confirms then removes the discussion.
- New REST endpoints: `PATCH /api/discussions/:id` (set/clear `title`) and `DELETE /api/discussions/:id`.
- New `title?` field on the `Discussion` type; the terminal renderer, `aab discuss list`, and the new `aab discuss rename <id> <title>` (`--clear` to revert) all honour it so a discussion renamed in the UI shows its name in the CLI too.
