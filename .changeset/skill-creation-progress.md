---
"ai-advisory-board": minor
---

Live progress pane for skill creation from the Action Board.

After accepting a planner proposal, the skill-creator run was invisible — the kanban sat silent for the (often multi-minute) Opus run with no indication anything was happening. There is now a dedicated progress pane that opens the moment you accept and stays up until install/fail: it shows the skill name, a live elapsed timer, the streaming `skill-creator` tool activity, and "validating & installing…" before completion. Success auto-closes after a beat; failure surfaces a sticky banner with the real error (now tolerant of the orchestrator's `error`/`reason` payload shapes, not just `errorMessage`). A "Run in background" button hides the pane without cancelling the run.
