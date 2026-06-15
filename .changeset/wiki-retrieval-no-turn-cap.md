---
"ai-advisory-board": minor
---

Fix board members failing with `max_turns` on a populated Knowledge Wiki, and make wiki retrieval cheaper and CLI-driven.

- **Removed the tool-turn cap on member + sparring calls.** They no longer pass `--max-turns` to `claude`; the Claude Code harness, `--max-budget-usd`, and the wall-clock timeout are the real guardrails. The old hardcoded `5` only produced spurious "Reached maximum number of turns" failures on agents doing Read/Grep/Glob retrieval. Emitted agent files no longer carry a `maxTurns` frontmatter line (re-run `aab members sync-agents` to refresh existing files).
- **CLI-side retrieval (the CLI finds context, the member advises on it).** Before spawning a member, the CLI now deterministically scores wiki pages by keyword overlap (slug/title/tags/summary), reads the top few, and injects short excerpts into the message. Members keep Read/Grep/Glob as a fallback. Tunable via `knowledgeWiki.injectRetrievedContext` / `retrievalMaxPages` / `retrievalExcerptChars`.
- **Rewrote the wiki instructions** in member prompts, emitted agent bodies, and the query prompt: never `Read index.md` in full (it can exceed 256 KB) — Grep first, prefer the compact catalog, `Read` 1–3 pages, answer within a finite tool budget.
- **Compact catalog** at `wiki/.aab/catalog.json` (`slug, type, title, summary, tags, path`), auto-written wherever the slug-map is rebuilt (ingest/lint/query/rename/migrate). CLI retrieval reads it as its fast index.
- **`aab doctor`** now fails the "Wiki index size" check when `index.md` exceeds `knowledgeWiki.indexSizeWarnBytes` (default 200 KB) with a concrete hint; `aab knowledge lint` emits the same `index-too-large` finding.
