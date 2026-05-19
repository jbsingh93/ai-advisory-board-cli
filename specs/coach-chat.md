# `specs/coach-chat.md` — Decision Coach: chat happy path

**Phase:** 2 (Decision Coach)
**Surface:** `data-testid="nav-coach"` sidebar → `coach-view` route.
**Endpoints:**
- `POST /api/coach/sessions` → 202 + `{ session }`. Opener turn fires in the background.
- `POST /api/coach/sessions/:id/messages` → 202. Reply arrives via WS `coach_message`.
- `GET /api/coach/sessions/:id` → resume.
**Engine:** `src/core/coach/decision-coach.ts:coachReply` (system prompt + transcript → claude → parse → persist).

## Pre-conditions
- Workspace with active principles (starter 8 are fine).
- `claude` CLI installed.

## Steps
1. Click **Coach** (`data-testid="nav-coach"`) in the sidebar.
2. The coach view renders: empty-state on the right, sessions list on the left (initially empty).
3. Click **+ New session** (`data-testid="coach-new-session-btn"`). Edit modal opens.
4. Fill **Title** (optional) and **Situation / decision to think through**.
   - Title: `Should we ship the $50k pivot?`
   - Situation: `Cash runway is 6 months. Major customer X wants a feature that conflicts with our product vision but represents 40% of ARR.`
5. Click **Save**. Toast: "Session started — coach is opening the conversation."
6. The session appears in the left sidebar (`data-testid="coach-session-row"`) and becomes the active row.
7. The right pane shows the chat-head, then "Coach thinking…" while the opener runs.
8. After 10–60 s (real claude call), the opener arrives. The coach should:
   - Quote one or more principles by **Title** in bold markdown.
   - Ask 1–2 Socratic questions.
   - End with a question or call to reflect.
9. Type a follow-up message into the composer (`data-testid="coach-input"`), Cmd/Ctrl+Enter or click **Send** (`data-testid="coach-send-btn"`).
10. The previous reply remains; "Coach thinking…" indicator appears.
11. New reply arrives. It must **reference the prior turn** (e.g., "Earlier you said the customer is 40% of ARR…").
12. Navigate away (to Discussions, say) and back. Click the session row — full history reloads from disk.

## Negative cases
- Empty situation → form validation error.
- Claude call fails → WS `coach_error` → toast surfaces the error; session is preserved.
- Send empty message → composer button no-ops.

## What this catches
- WS event flow: `coach_thinking → coach_message → coach_session_updated`.
- Persistence: `aab/decision-sessions/<id>.json` (atomic write per turn).
- Principles injection: the system prompt contains the user's principles, sorted by priority. (See `buildDecisionCoachSystemPrompt` unit test.)
- Cross-turn memory: every call sends the full transcript (`buildTranscript`), not just the latest message.
