# `docs/specs/sparring-inject-back.md` — Sparring: inject insight back into the main timeline

**Phase:** 3 (Sparring — write-back to main timeline)
**Surface:** Inside the sparring modal — **↩ Inject insight back** (`data-testid="sparring-inject-btn"`). Opens the inject modal (`data-testid="sparring-inject-modal"`) with the prepared insight text (editable).
**Endpoint:** `POST /api/sparring/:sessionId/inject` → `{ discussion, injectedUserResponse }`.
**Engine:** `src/core/sparring/inject-insight.ts:injectSparringInsight`.

The injected entry lands in `discussion.userResponses` with `type: 'sparring_injection'` and the following provenance fields populated:

- `roundNumber: <anchor round>`
- `selectedMemberId: <member id>`
- `sourceRoundNumber: <anchor round>`
- `sourceTurnNumber: <anchor turn>`
- `sparringSessionId: <session id>`
- `prompt: "Injected from 1:1 Deep Dive with <member name>"`

If the target round has no `userResponse` set (the round wasn't triggered by an HITL reply or follow-up), the engine also attaches the injection to `round.userResponse` — matching the sage-council source behavior at `conversation-flow.ts:injectSparringInsight`.

## Pre-conditions
- Sparring session with at least one assistant reply (run `docs/specs/sparring-anchor-deepdive.md` first).
- The parent discussion is still loaded — sparring stores `discussionId` on the session.

## Steps
1. With the sparring modal open and at least one assistant message present, click **↩ Inject insight back** (`data-testid="sparring-inject-btn"`).
2. The inject modal opens (`data-testid="sparring-inject-modal"`).
3. The textarea (`data-testid="sparring-inject-textarea"`) is **pre-filled** with the latest assistant reply's full markdown content (not truncated; editable).
4. The modal subtitle reads: `Will land in discussion at round <anchorRoundNumber> as a sparring_injection user response.`
5. (Optional) Edit the textarea to summarize / shorten before injecting — the engine writes whatever the user keeps.
6. Click **↩ Inject** (`data-testid="sparring-inject-confirm"`).
7. Inject modal closes. Toast: "Insight injected into the main discussion."
8. WS event `sparring_injected` fires with `{ discussionId, sessionId, userResponse }`.
9. The chat view's underlying discussion is refreshed; a new user-style bubble appears in the timeline at the anchor round, labelled `Sparring insight injected (via <member name>)`.
10. Verify on disk: the discussion file under `discussions/<id>.json` now contains a `userResponses[]` entry whose `type === 'sparring_injection'`, `sparringSessionId` matches the session, and `selectedMemberId` matches the original member.

## Negative cases
- Click **↩ Inject** with the textarea blanked out → toast "Insight cannot be empty." (no network call).
- Click **↩ Inject insight back** before any assistant reply has arrived → toast "Send a message and get a reply first — there is nothing to inject."
- Inject when the parent discussion has 0 rounds (impossible by construction since you need a response to spar on, but the engine throws `Error: No discussion round available to attach injected insight` defensively).

## What this catches
- The `sparring_injection` UserResponse shape (provenance fields + `sparringSessionId` link).
- The round-attach idempotency: if the same anchor round already has a `userResponse` (e.g. an HITL reply), the injection is **still** appended to `userResponses[]` but does NOT clobber `round.userResponse`. This matches sage-council §1.9.
- Storage atomicity: `injectSparringInsight` calls `storage.updateDiscussion(discussion)` once — a single atomic write to the discussion file.
- Timeline rendering: `discussionTimeline()` in `gui/app.js` walks `userResponses` and emits a labeled user bubble at the anchor round so the user sees the injection in context, not as a standalone footnote.
- Deep-link: the UI can navigate from the injected bubble back to the spar session via `sparringSessionId` (verify by clicking the bubble in a later spec, once that affordance lands).
