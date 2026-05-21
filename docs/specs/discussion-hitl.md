# `docs/specs/discussion-hitl.md` — Discussion: orchestrator gates → HITL panel → respond → round 2

**Phase:** 1 (core HITL) + 6.6 (test infrastructure)
**Surface:** Discussion chat view with the orchestrator's pre-round clarification gate active.

**Endpoints:**
- `POST /api/discussions/:id/continue` → 202 when not gated; or returns `{ gated: true, pendingUserRequest }` and persists the prompt without spawning members.
- `POST /api/discussions/:id/respond` → 202 with `{ content, selectedOption? }`. Engine clears `pendingUserRequest` and re-runs `continueDiscussion` with `skipPreRoundGate: true`.
- WebSocket `discussion_gated` event carries the new `pendingUserRequest`.

**Engine:** `src/core/discussion/conversation-flow.ts:continueDiscussion` (pre-round gate) and `respondToUserRequest`.

## Pre-conditions
- Settings `enableUserInteraction: true`.
- A question that the orchestrator will plausibly want to clarify (e.g. with ambiguous scope: `What should we do about the new market opportunity?` — vague on purpose).
- ≥2 active members so the orchestrator has cause to harmonize.

**`data-testid` references:** `tab-discussions`, `discussion-row-<shortId>`,
`chat-stream`, `discussion-continue`, `hitl-prompt`, `hitl-panel`,
`hitl-option-<index>`, `hitl-reply-input`, `hitl-reply-submit`,
`member-message-<slug>-<turn>`, `orchestrator-decision-<round>`,
`discussion-concluded`.

## Steps
1. Open or start a discussion as in `discussion-happy-path.md` steps 1–10.
2. After round 1 lands, `browser_click discussion-continue`.
3. `browser_wait_for { ref: hitl-prompt }`. Verify the yellow `⚠ The board is asking you a question` bubble appears in `chat-stream`.
4. `browser_wait_for { ref: hitl-panel }`. The panel renders with `role="dialog" aria-modal="true"` in the chat footer.
5. `browser_snapshot`. Verify:
   - The question text from `pendingUserRequest.question` is rendered in bold inside `hitl-prompt`.
   - If the orchestrator supplied options, each appears as a `hitl-option-<index>` chip.
   - The reply textarea `hitl-reply-input` is present and labeled `"Reply to the board"`.
   - The submit button `hitl-reply-submit` is enabled.
6. `browser_click hitl-option-0` (or whichever option matches the user's preference).
   - Verify `hitl-option-0` gets the `.selected` class (or `aria-pressed`-style highlight).
7. `browser_type` into `hitl-reply-input`: a short reply paragraph (or leave empty if an option was chosen).
8. `browser_click hitl-reply-submit`.
9. The HITL panel disappears. `discussion-continue` should NOT reappear yet; the engine immediately runs round 2 with the user's response attached.
10. `browser_wait_for { ref: member-typing-<slug> }` then `member-message-<slug>-<turn>` per member (turn increments to 2).
11. `browser_wait_for { ref: orchestrator-decision-2 }`. Verify the decision card appears and is NOT `request_user_input` again (the engine sets `skipPreRoundGate: true` for the response → next round, so we cannot re-gate immediately).

## Expected observations
- The user's reply is rendered as a right-aligned user bubble labeled `Your reply` with the chosen option suffix (`↳ chose: <option>`).
- After conclusion (whenever that arrives — could be many rounds later), `discussion-concluded` is visible and `pendingUserRequest` is no longer surfaced (regression test for `hitl-after-maxturns.md`).

## Failure modes worth a screenshot
- `hitl-panel` shows but submit does not POST (network error swallowed, button stays disabled).
- `hitl-prompt` and `discussion-continue` both visible at the same time — they are mutually exclusive states.
- Submitting an empty reply with no option chosen flashes a `Type a reply or pick an option first.` toast (intentional).

## Pattern A note
Use Pattern A (exploratory smoke) verbatim from `docs/development/PLAYWRIGHT_MCP.md` §7 if you want Claude to drive this flow live and stop on the gate without responding. Use Pattern C to materialize it as `tests/e2e/discussion-hitl-flow.spec.ts` once `@playwright/test` is wired.
