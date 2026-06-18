---
"ai-advisory-board": minor
---

Decision Coach: web-grounded facts + rendered-markdown chat.

- **The coach can now search the web.** `coachReply` spawns with `allowedTools: ['WebSearch', 'WebFetch']` (+ `strictMcpConfig: true`) instead of `[]`, and the hard `maxTurns: 1` cap is removed — a 1-turn cap aborted the moment the coach took a search turn before answering (same lesson as the member/sparring calls). The per-call budget and wall-clock timeout remain the guardrails. The system prompt gained a **"GROUND FACTS IN REALITY"** section instructing the coach to verify time-sensitive/checkable facts (a company's public-vs-private status, prices, valuations, recent events, regulations) via the web and cite sources, rather than asserting them from a stale training cutoff. Fixes the coach calling a now-public company "private".
- **The web chat renders markdown.** Assistant coach bubbles now run through `renderWikiBody` into `innerHTML` (the same lightweight renderer member responses use) instead of `textContent`, so headings/bold/lists/blockquotes render instead of showing raw `##`/`**` source. User turns stay plain text. The renderer also learned **horizontal rules** (`---` → `<hr>`) and **markdown links** (`[text](url)` → clickable `<a target="_blank">`, restricted to `http(s)`/`mailto`/`#` schemes), which improves member responses too since they share the renderer.
