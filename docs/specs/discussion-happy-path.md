# `docs/specs/discussion-happy-path.md` — Discussion: round 1 → continue → conclude (no HITL)

**Phase:** 1 (core) + 6.6 (test infrastructure)
**Surface:** `data-testid="tab-discussions"` sidebar → discussions list → chat view.
**Endpoints:**
- `POST /api/discussions` → 202 + `{ discussion }`. Round 1 starts in the background.
- `POST /api/discussions/:id/continue` → 202. Round N+1 fires; orchestrator may conclude.
- WebSocket `/ws` streams `member_thinking`, `member_response`, `orchestrator_decision`, `discussion_completed`.

**Engine:** `src/core/discussion/conversation-flow.ts:startDiscussion` then `continueDiscussion`.

## Pre-conditions
- Workspace with ≥3 active members. The reference workspace `~/.aabcli/smoke-kw-2026-05-19/` is fine.
- Settings `enableUserInteraction: false` (or the chosen question deliberately avoids gating) so the orchestrator does not request user input.
- `claude` CLI installed; `aab ui` already running on http://localhost:3737.

**`data-testid` references:** `tab-discussions`, `new-discussion`, `new-discussion-modal`,
`new-discussion-question`, `new-discussion-member-<slug>`, `new-discussion-start`,
`discussion-list`, `discussion-row-<shortId>`, `chat-stream`,
`member-typing-<slug>`, `member-message-<slug>-<turn>`,
`orchestrator-decision-<round>`, `discussion-continue`, `discussion-concluded`.

## Steps
1. `browser_navigate http://localhost:3737`.
2. `browser_snapshot`. Verify the sidebar lists nine tabs and **Discussions** (`tab-discussions`) is selected.
3. `browser_click` the `new-discussion` button.
4. `browser_wait_for { ref: <new-discussion-modal> }` — verify the modal opens.
5. `browser_type` into `new-discussion-question`: `Should we ship the wiki phase 1 chunk 1 first or finish phase 1 closeout?`
6. `browser_snapshot`. Verify three or more `new-discussion-member-<slug>` chips render with `aria-checked="true"`.
7. `browser_click` the `new-discussion-start` button.
8. The modal closes and a chat view appears with the user's question bubble on the right.
9. `browser_wait_for { ref: member-typing-<slug> }` for each active member. Typing dots animate inside `chat-stream` (which carries `role="log" aria-live="polite"`).
10. `browser_wait_for { ref: member-message-<slug>-1 }` for each member — the typing bubble is replaced by a response card.
11. `browser_wait_for { ref: orchestrator-decision-1 }`. Verify the card shows the decision label (e.g. `CONTINUE — …`) and a confidence percentage.
12. `browser_verify_element_visible discussion-continue`.
13. `browser_click discussion-continue`.
14. `browser_wait_for { ref: member-typing-<slug> }` again — round 2 begins.
15. `browser_wait_for { ref: orchestrator-decision-2 }`. Verify it appears.
16. (Optional) Continue further rounds until the orchestrator emits `action: "conclude"`, or until `maxTurns` is hit. `browser_wait_for { ref: discussion-concluded }`.
17. `browser_verify_element_visible discussion-concluded` and verify `discussion-continue` is no longer in the snapshot.

## Expected observations
- Every member that was selected at step 6 produces a `member-message-<slug>-<turn>` node per round.
- The orchestrator decision card is the last bubble in each round (`orchestrator-decision-<round>` appears after the per-member messages).
- The `chat-stream` scrolls so the newest bubble is visible.
- No `data-testid="hitl-prompt"` ever appears in this flow.

## Failure modes worth a screenshot
- A member's typing bubble stays in the DOM after `discussion_completed` (orphan — see `finalizeChat` cleanup).
- The orchestrator card shows `confidence undefined%` (schema regression — `OrchestratorDecision.confidence` mis-parsed).
- The Continue button stays enabled but the click does nothing for >15 s (server lock or socket loss).

## Pattern C — generate a `@playwright/test` spec from this
Once the deterministic suite lands (`@playwright/test` installed), this markdown is the source-of-truth for `tests/e2e/discussion-happy-path.spec.ts`. Mock `claude` via the `mock-claude.ts` fixture so the test is hermetic.
