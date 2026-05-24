---
"ai-advisory-board": patch
---

fix(ui): live discussion view no longer shows false "No response" after a streaming glitch. When a live `member_response` event failed to match its typing bubble, the view left a perpetual-"No response" orphan in place and appended a misplaced duplicate of the real answer further down. `finalizeChat` now rebuilds the chat stream from the authoritative discussion record the server sends with `discussion_completed` / `discussion_gated`, so the live view matches exactly what a page reload renders.
