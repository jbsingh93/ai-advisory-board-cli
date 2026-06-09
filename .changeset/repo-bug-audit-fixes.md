---
"ai-advisory-board": patch
---

Bug-audit fixes across the discussion engine, web server, and storage layer (full audit log in `docs/development/BUG_AUDIT_2026-06-09.md`):

- **Round 1 no longer dies on one flaky member.** `startDiscussion` now tolerates per-member failures like `continueDiscussion` always has — the discussion proceeds with the members that answered, and only fails if *all* of them do.
- **Follow-up rounds honor the orchestrator's `conclude` decision.** The pre-round gate in `aab discuss follow-up` previously dropped a `conclude` silently and ran the round anyway, burning tokens on a discussion the orchestrator had ended.
- **Web UI double-submits can't corrupt a discussion.** `/api/discussions/:id/{continue,respond,follow-up}` now reject a second request with 409 while a round is in flight, instead of racing two rounds against the same record (last-writer-wins data loss).
- **HITL replies are recorded against the round they drive**, not the previous round's number.
- **Business-context writes get rollback snapshots** in `.snapshots/`, like every other persistent entity.
- **Hand-edited agent files are safer:** a momentarily unreadable `.claude/agents/<slug>.md` is now treated as protected rather than overwritable by `sync-agents`.
- Correct `✗`-formatted user errors (instead of bare stack-trace errors) for no-active-members, all-members-failed, duplicate member ids, and board validation; `aab doctor` prints the agents path with the platform's separators; start-discussion failure events on the WebSocket are tagged `context: 'start_discussion'`.
