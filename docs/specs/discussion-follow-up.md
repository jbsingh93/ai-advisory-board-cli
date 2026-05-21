# `docs/specs/discussion-follow-up.md` — Discussion: follow-up `all` / `specific` / `subset`

**Phase:** 1 (core follow-up) + 6.6 (test infrastructure)
**Surface:** Discussion chat view, follow-up composer.

**Endpoint:** `POST /api/discussions/:id/follow-up` with body
`{ question, targetType: 'all'|'specific'|'subset', selectedMemberId?, selectedMemberIds? }`.

**Engine:** `src/core/discussion/conversation-flow.ts:addFollowUpQuestion` — **strict**: if any targeted member fails the whole round aborts cleanly (no partial commit). Differs from `continueDiscussion`, which tolerates per-member failure.

## Pre-conditions
- An open (not concluded) discussion with ≥3 active members already in the chat-view.
- Settings `enableUserInteraction: false` so the orchestrator doesn't gate the follow-up round.

**`data-testid` references:** `discussion-continue`, `discussion-followup-open`,
`discussion-followup-input`, `discussion-followup-send`,
`member-message-<slug>-<turn>`, `orchestrator-decision-<round>`.

## Variant A — follow-up `all`
1. From the chat view, `browser_click discussion-followup-open`.
2. The composer slides in. `browser_wait_for { ref: discussion-followup-input }`.
3. All member chips render selected by default. Do **not** deselect any.
4. `browser_type` into `discussion-followup-input`:
   `Reconcile your positions and tell me which one ships this quarter.`
5. `browser_click discussion-followup-send`.
6. A user bubble labelled `Follow-up` appears on the right.
7. `browser_wait_for { ref: member-typing-<slug> }` for every active member.
8. `browser_wait_for { ref: member-message-<slug>-<turn> }` per member (turn increments by 1).
9. `browser_wait_for { ref: orchestrator-decision-<round+1> }`.

## Variant B — follow-up `specific` (one member)
1. `browser_click discussion-followup-open`.
2. In the chips row, `browser_click` each chip you want to deselect — leave exactly one chip selected.
3. `browser_type` into `discussion-followup-input`:
   `Push back on your last position — what's the strongest argument against it?`
4. `browser_click discussion-followup-send`.
5. The user bubble is labelled `Follow-up · targeted`.
6. **Only one** `member-typing-<slug>` bubble should appear, and **only one** `member-message-<slug>-<turn>` should land.

## Variant C — follow-up `subset` (2+ but not all)
1. Same as Variant B but leave 2 or 3 chips selected (less than the total).
2. The user bubble is labelled `Follow-up · subset`.
3. Exactly the selected members produce response bubbles.

## Expected observations
- The `chat-stream` retains all prior rounds; the follow-up appends.
- The `data-round` attribute on the new `member-message-*` nodes is `prevRoundNumber + 1`.
- Toast `Follow-up dispatched — board is responding…` appears after the POST resolves.

## Failure modes worth a screenshot
- Composer submit fires with no question — toast `Type a follow-up question first.` (intentional).
- All chips deselected — toast `Pick at least one member to answer.` (intentional).
- In Variant B/C, an unselected member produces a response bubble (engine regression — the engine should ignore unselected members).

## Pattern note
Run all three variants in a single MCP session by closing the composer (Cancel button) between runs. After each round lands, take a `browser_snapshot` and verify the round count matches expectations before continuing.
