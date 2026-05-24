---
"ai-advisory-board": minor
---

Skill Planner / Solve recon is faster, observable, and cancellable.

- **Live recon progress:** the planner progress modal no longer leaves Wiki recon and Web research on `queued` for the whole (multi-minute) parallel block. Each phase now reports `running` the moment it starts and `done` the moment IT settles (independently), with a live elapsed timer and a per-pass heartbeat (e.g. "researching 3 app(s) + general best-practices — 4 in parallel", "app 2/4 done").
- **Parallel web research:** the general + per-app web-research passes now run through a concurrency-capped pool (default 4 in flight) instead of sequentially. After evaluating Claude Code subagents and agent teams (sequential / lossy / experimental / interactive-only), N parallel `claude -p` processes were the right fit — each keeps its own structured JSON, timeout, and cost cap. Cuts the worst-case ~20 min recon to roughly the slowest 1–2 waves.
- **Cancel button:** the planner progress modal has a "Cancel plan" button. It aborts the run server-side, killing the in-flight recon/planner `claude` children so the token burn stops immediately.
- **Skip MCP startup tax:** recon + planner `claude` spawns now pass `--strict-mcp-config`, so they no longer load the user's configured MCP servers (Gmail, Slack, Google, …) on startup — those calls only need WebSearch/WebFetch/Read/Grep/Glob.
