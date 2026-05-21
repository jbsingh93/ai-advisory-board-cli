# Regression — `follow-up-strict-failure`

**Origin:** CLAUDE.md *"Two non-obvious invariants"* §2: *"Rounds keep a separate in-memory `round` object that's only pushed onto `discussion.rounds` after all member responses succeed (for strict follow-ups) — don't move that earlier or partial failures will persist half-rounds."*

**Fix landed in:** `src/core/discussion/conversation-flow.ts:addFollowUpQuestion`. When **any** targeted member fails, the whole round aborts cleanly — no partial round is committed to `discussion.rounds`, and the UI receives a `discussion_failed`-style WS event (or no completion event for the new round). The user can retry without seeing a half-empty round in the timeline.

This differs from `continueDiscussion`, which **tolerates** per-member failure and only aborts if *all* members fail.

## Repro pre-condition
- An open discussion with ≥3 active members in the chat view.
- A way to make one targeted member fail. The simplest mechanism is to use the `mock-claude.ts` fixture (Phase 6.6 chunk 5) and configure one member's response to throw. For an exploratory MCP run, you can temporarily edit `.claude/agents/<slug>.md` to declare a `tools:` allowlist that triggers a tool error, then revert after the test.

## Steps
1. From a chat view, note the current `discussion.rounds.length` (call this `N0`).
2. `browser_click discussion-followup-open`.
3. In the chip row, leave **three or more** chips selected and `browser_type` a follow-up question.
4. Trigger the fault: ensure one of the selected members is rigged to fail.
5. `browser_click discussion-followup-send`.
6. Wait until either:
   - The orchestrator-decision card for round N0+1 fails to appear within 60 s, OR
   - A failure toast surfaces: `Follow-up failed: …`
7. Reload the chat view via Back → click the discussion row again.

## Pass criteria
- After reload, `discussion.rounds.length` is **still** `N0`. No round N0+1 was persisted.
- The chat-stream contains no `member-message-*-<N0+1>` nodes.
- The chat footer is back to its default state (Continue + Follow up buttons), not stuck on a composer.

## Fail signal (regression returned)
- After reload, `discussion.rounds.length` is `N0+1` but with **only the responses from the successful members** — partial round persisted. The user sees an asymmetric round where only some members spoke.
- Or: the chat footer is stuck on the composer with the failure unrecoverable.

## Notes
This test is hardest to drive purely through MCP because we need a deterministic failure. Once `tests/fixtures/mock-claude.ts` (Phase 6.6 chunk 5) lands, the deterministic `@playwright/test` version is straightforward: configure mock-claude to make one member-id return a non-zero exit code, then assert the round count is unchanged.
