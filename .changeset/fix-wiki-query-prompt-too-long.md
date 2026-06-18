---
"ai-advisory-board": patch
---

Fix wiki **Ask** failing with `Query LLM call failed: … "Prompt is too long"` on large wikis.

The query prompt inlined the wiki's `catalog.json` (and index). On a wiki with hundreds of pages (e.g. from email/Slack ingestion) that's ~700 KB+ → 170k+ tokens, overflowing the model's context window before the question is even answered. The query agent now **walks the wiki natively with Read/Grep/Glob** — exactly the approach documented in `KNOWLEDGE_WIKI.md` §15.2: `Grep wiki/` for the question's terms, resolve slugs via the compact catalog without reading it whole, and `Read` only the 1–3 relevant pages. Nothing from the wiki is inlined into the prompt, so it stays a fixed small size no matter how large the wiki grows. Answers are unchanged on small wikis; large wikis now work instead of erroring.
