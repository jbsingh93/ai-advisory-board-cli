# `docs/specs/sparring-anchor-deepdive.md` — Sparring: anchor → deep dive → resume

**Phase:** 3 (Sparring — 1:1 deep dive)
**Surface:** `data-testid="spar-btn"` (per response card in the chat view) → `data-testid="sparring-modal"` (the 1:1 panel).
**Endpoints:**
- `POST /api/discussions/:id/sparring` → `{ session, reused }` — opens or resumes a session for a (member, round, turn) triple.
- `GET /api/discussions/:id/sparring` → `{ sessions: SparringSession[] }`.
- `POST /api/sparring/:sessionId/messages` → `202 + { accepted: true }` (WS stream `sparring_thinking → sparring_activity → sparring_message`).
- `GET /api/sparring/:sessionId` → resume.
**Engine:** `src/core/sparring/sparring-service.ts:openSparringSession + sendSparringMessage`.

## Pre-conditions
- A finished discussion with at least one member round complete (the canonical fixture: the `phase3-smoke` workspace's "Should we ship the $50k pivot?" run from §Live smoke).
- `claude` CLI installed (sparring is a real LLM call — burns Opus/Sonnet tokens).

## Steps
1. Navigate to **Discussions** in the sidebar.
2. Open a discussion that has at least one `messageBubble` (any member response card with `data-testid="member-message-<slug>-<turn>"`, e.g. `member-message-elon-musk-1`; see also `data-testid-kind="response-card"` on the same node).
3. On round 2, turn 1's response card (Elon Musk or whichever member is present), click **⚔ Spar** (`data-testid="spar-btn"`).
4. Verify the sparring modal opens (`data-testid="sparring-modal"`).
5. The title shows `⚔ 1:1 with <member name>` (`data-testid="sparring-title"`).
6. The anchor banner (`data-testid="sparring-anchor"`) shows the response text the user is sparring on, with the label "Anchored response".
7. The transcript area (`data-testid="sparring-transcript"`) is empty with hint text "No messages yet — type your first sharper question below."
8. Type a sharper question into the composer (`data-testid="sparring-input"`), e.g. "Walk me through the math on why 40% of ARR isn't enough rationale".
9. Click **↳ Send** (`data-testid="sparring-send-btn"`) or Cmd/Ctrl+Enter.
10. A user bubble appears (`data-testid="sparring-msg-user"`) followed by a typing indicator (`data-testid="sparring-typing"`).
11. The WS event stream fires `sparring_thinking → sparring_activity ('thinking…' / 'writing response…' / etc.) → sparring_message`.
12. After 15–90 s (researchModel call — Opus by default), the assistant bubble (`data-testid="sparring-msg-assistant"`) appears with the member's deep-dive reply. The reply uses `##` / `###` headers and bullet lists.
13. Send a follow-up: "What's the second-order risk if we say no?".
14. New reply arrives, references the prior turn (must mention 40% of ARR or the customer X by name from turn 1).
15. Close the sparring modal (click × in the header).
16. From the chat-view header, click **⚔ Sparring** (`data-testid="sparring-sessions-btn"`). The sparring list modal opens.
17. The list (`data-testid="sparring-session-list"`) shows the session with the right member, anchor, and message count.
18. Click the row — the sparring modal reopens with the full transcript reloaded from disk.

## Negative cases
- Click **⚔ Spar** on the SAME response again → the server returns `reused: true` and the same session opens (no duplicate). Confirm by checking the message count is preserved.
- Send an empty composer message → toast "Type a message first." (form validation, no network call).
- `claude` CLI is missing → `sparring_error` WS event → toast "Sparring error: …" (session preserved; user can retry).
- Research model fails mid-call → server falls back to `primaryModel`; the response card carries a `· fell back to primary model` tag visible in console / WS payload.

## What this catches
- **Truncation budgets**: `MAX_DISCUSSION_CONTEXT_CHARS = 14_000`, `MAX_SPARRING_HISTORY_CHARS = 8_000`, `MAX_ANCHOR_RESPONSE_CHARS = 4_000`. A long discussion with > 14k char history must still produce a valid prompt with a `[Discussion context truncated to fit context window: omitted N chars]` marker (`src/core/sparring/truncate.ts`).
- **Session idempotency**: the (memberId, anchorRoundNumber, anchorTurnNumber) tuple is the natural key. Two clicks on the same Spar button must return the same session id, not a new one.
- **Cross-turn memory**: every call sends the full transcript via `buildSparringUserMessage`, not just the latest user message.
- **Storage**: `sparring/<discussionId>/<sessionId>.json` (atomic write per turn). Filesystem mutex via `proper-lockfile` is held only during the storage write — the LLM call runs lock-free.
- **WS event flow**: `sparring_thinking → sparring_activity → sparring_message` (assistant), or `sparring_error` on failure.
- **researchModel → primaryModel fallback**: when Opus/researchModel returns a 5xx or empty body, the service silently retries with `primaryModel` (default Sonnet). The user sees one assistant reply, not two.
