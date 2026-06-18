---
"ai-advisory-board": patch
---

Decision Coach × Business Wiki: make the **"📚 Use Business Wiki" toggle directly available** — no Settings step.

The toggle now appears right in the **New Coach Session modal** (start a session with the wiki already wired) and in the **composer** (flip it any turn). The previous `knowledgeWiki.exposeToCoach` global opt-in has been removed — the per-session toggle is the sole control, default OFF per session. `aab coach --wiki` / `aab coach send … --wiki` just set the session flag (no opt-in to enable first).
