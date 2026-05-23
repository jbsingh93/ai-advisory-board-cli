---
"ai-advisory-board": minor
---

Board members now actually use the Knowledge Wiki, and ingest captures user facts:

- **Members read the wiki before answering.** Previously members were told to read `wiki/`, but that path doesn't resolve from their working directory (the wiki lives under the workspace root, not the project dir), so they silently fell back to web search. Member calls now receive the wiki's absolute path in their task, are granted access to it via `--add-dir`, and are instructed to consult it first and only use web search to fill genuine gaps. Their answers are now grounded in the user's own data instead of being generic.
- **Inline business context is no longer suppressed** when a wiki is present, so members always have baseline grounding even if their wiki pass is thin.
- **Ingest prioritizes durable facts about the user and their business** (goals, needs, ideas, decisions, constraints) and dedupes against existing pages instead of capturing only advisor opinion. Discussion transcripts now surface the user's own words (question, follow-ups, HITL replies) in a dedicated section so those facts get mined.

After updating, run `aab members sync-agents` to regenerate existing members' agent files with the improved wiki instructions.
