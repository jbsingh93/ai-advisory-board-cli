---
"ai-advisory-board": patch
---

Fix wiki **Ask** failing with `Query LLM call failed: … "Prompt is too long"` on large wikis.

The query prompt inlined the **entire** `catalog.json`. On a wiki with hundreds of pages (e.g. from email/Slack ingestion) that catalog can be ~700 KB+ (170k+ tokens), overflowing the model's context window before the question is even answered. The query now inlines a **relevance-ranked, size-bounded catalog digest** (the pages most related to the question, capped well under the context window) and the agent `Grep`/`Glob`s the wiki for anything not listed. `KNOWLEDGE.md` is capped too. Answers are unchanged on small wikis; large wikis now work instead of erroring.
