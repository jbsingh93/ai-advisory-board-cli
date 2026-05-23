---
"ai-advisory-board": minor
---

Knowledge & discussion UI improvements:

- **Multi-source ingest** — the web UI Ingest panel now accepts multiple URLs (one per line) plus native file and folder pickers alongside pasted text. Picked files upload their content to the local server (browsers never expose absolute paths), are filtered to ingestible text/doc types with a 20 MB cap, and are ingested sequentially with per-item progress. New `ingestFileBuffer()` core function and a `file: { name, contentBase64 }` variant on `POST /api/knowledge/ingest`.
- **Markdown rendering in board-member answers** — member responses now render markdown (bold, headings, lists, inline code, code fences, blockquotes, and `[[wikilinks]]`) instead of showing raw markers.
- **Add action steps to the Action Board from a discussion** — each suggested action step now has a "+ Add" button that creates a linked action item (attributed to the advising member) without leaving the discussion view.
