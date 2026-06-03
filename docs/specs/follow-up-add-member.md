# `docs/specs/follow-up-add-member.md` — Follow-up: add a member mid-discussion + catch-up

**Phase:** 7 (Dynamic member targeting) · **Surface:** Discussion chat view, follow-up composer.

**Endpoint:** `POST /api/discussions/:id/follow-up` extended body
`{ question, targetType, selectedMemberId?, selectedMemberIds?, addMemberIds?, catchUpMode? }`.
The candidate pool is relaxed to the updated roster so newly-added ids are eligible. Added members append to `discussion.participants` (`joinedAtRound`, `catchUpMode`) + `selectedMemberIds`, recorded on `round.addedMemberIds`. Strict-abort: any targeted member failure rolls back the join.

**WS event:** `member_joined` (`id, name, joinedAtRound, catchUpMode`) → live "X joined the discussion".

**`data-testid` references:** `discussion-followup-open`, `discussion-followup-input`, `discussion-followup-send`, `followup-add-member-btn`, `followup-add-member-list`, `followup-add-member-option`, `followup-catchup-select`, `round-joined-badge`.

## Pre-conditions
- An open (not concluded) discussion whose roster excludes ≥1 active member (so there's someone to add).
- Settings `enableUserInteraction: false` so the orchestrator doesn't gate the follow-up round.

## Variant A — add a member who responds this round
1. From the chat view, `browser_click discussion-followup-open`.
2. The composer shows the discussion's current members as chips + a **`followup-add-member-btn`** ("+ Add member").
3. `browser_click followup-add-member-btn` → the **`followup-add-member-list`** reveals active members **not** in the discussion as `followup-add-member-option` buttons.
4. `browser_click` one option. It becomes a **visually-distinct dashed chip** (`chip-added`, label ends with `＋`) in the main chip row, and the **`followup-catchup-select`** appears (default "Full transcript").
5. (Optional) set `followup-catchup-select` to `Summary` or `Fresh start`.
6. `browser_type discussion-followup-input` → `How would a CFO view the margin impact?`.
7. `browser_click discussion-followup-send`.
8. A `member_joined` WS event lands → a system line `＋ <name> joined the discussion (caught up via <mode>)`.
9. The newcomer produces a `member-message-<slug>-<turn>` bubble alongside the returning members.
10. After the round, a **`round-joined-badge`** (`＋1 joined`, tooltip `<name> (<mode>)`) renders on the new round divider.

## Variant B — add but don't target (roster join only)
1. Add a member (Variant A steps 1-4), then **deselect** them in the chip row before sending, leaving another single member targeted.
2. Send. The added member does **not** produce a bubble this round but is in `selectedMemberIds` for future rounds (verify via `GET /api/discussions/:id`); no catch-up recorded yet.

## Variant C — remove an added chip
1. After adding a member, `browser_click` their dashed chip → it is removed and the catch-up selector hides (when no added members remain).

## Expected observations
- Adding a member already in the discussion is impossible (they're not offered in the add-list).
- `catchUpMode` defaults to `full`; `summary` triggers one `catchup_summary` token-usage log server-side.

## Failure modes worth a screenshot
- Dashed chip added but no catch-up selector → wiring broken.
- `round-joined-badge` missing after a join → `round.addedMemberIds` not persisted/rendered.
