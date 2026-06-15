---
"ai-advisory-board": minor
---

**Continuous user-input ingest into the Knowledge Wiki (Phase 8).** Every word you type into the board — your opening question, follow-ups, answers to the board's clarifying questions, and 1:1 sparring messages — now flows into the wiki automatically, so the board's knowledge of you compounds with every interaction.

- A dedicated **user-fact merge agent** reconciles each utterance against the existing wiki and records only what's genuinely new or changed. Dedup is semantic and per-fact (create / merge / skip) after the agent reads the wiki — so re-mentioning your company name a dozen times never creates duplicate pages, while a new detail in that same sentence still gets merged into the existing page (history preserved, `updated:` bumped).
- **1:1 sparring now contributes to the wiki** for the first time (previously zero integration).
- Hand-edited pages (`userEdited: true`) are never overwritten — they're skipped and recorded.
- Per-workspace **serialized + coalescing ingest queue** so concurrent inputs never race the wiki index/manifest; bursts batch into one pass.
- Conclude-time discussion ingest is re-scoped to advisor synthesis when user-input ingest is on, avoiding double-processing your own words.
- New setting `knowledgeWiki.autoIngestUserInputs` (default on); supersedes the old 40-char HITL-only paste path. Full design: `docs/development/USER_INPUT_INGEST.md`.
