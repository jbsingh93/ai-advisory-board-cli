# Regression — `hitl-after-maxturns`

**Origin:** CLAUDE.md *"Two non-obvious invariants"* §1: *"When a discussion concludes via `maxTurns`, leftover `pendingUserRequest` is explicitly cleared so the UI never shows 'done' alongside an unanswerable HITL prompt."*

**Fix landed in:** `src/core/discussion/conversation-flow.ts` — when the engine reaches `maxTurns` it sets `completedAt` AND deletes `pendingUserRequest` before persisting. The UI then never has cause to render both `discussion-concluded` and `hitl-prompt`/`hitl-panel` at the same time.

## Repro pre-condition
- Settings `enableUserInteraction: true` and `maxTurns` set deliberately low (e.g. 2) via the Settings tab so we hit conclusion fast.
- A question phrased so the orchestrator wants clarification on the **last** round (e.g. a question with deliberate ambiguity).

## Steps
1. `browser_navigate http://localhost:3737`.
2. Open the Settings tab and set `maxTurns = 2`. Save.
3. `browser_click tab-discussions`. Open the New-discussion modal and start a discussion with a deliberately ambiguous question (`Should we pursue the new market opportunity?`).
4. Wait for round 1 to land (per-member messages + orchestrator decision).
5. `browser_click discussion-continue`. The orchestrator either runs round 2 or gates with `request_user_input`.
6. If gated: respond, which triggers round 2. If not gated: wait for round 2 to land naturally.
7. After round 2 lands, `browser_wait_for { ref: discussion-concluded }` (we've hit `maxTurns`).

## Pass criteria
- `data-testid="discussion-concluded"` is present.
- **No** `data-testid="hitl-prompt"` node anywhere in `chat-stream`.
- **No** `data-testid="hitl-panel"` node anywhere in `chat-footer`.
- The chat footer is either the conclusion row with the `Extract actions` button, or empty (depending on whether the discussion supports extraction).

## Fail signal (regression returned)
- `discussion-concluded` and `hitl-prompt` are both visible at the same time.
- The chat footer shows the HITL reply form even though the discussion is over (`hitl-reply-submit` is clickable but the engine will reject the request).

## Notes
The cleanup happens server-side. If you only see the regression in the UI, also check `<workspace>/discussions/<id>.json` — `pendingUserRequest` should be `undefined`/absent in the persisted record. If the persisted record still contains it, the regression is in `conversation-flow.ts`, not the UI.
