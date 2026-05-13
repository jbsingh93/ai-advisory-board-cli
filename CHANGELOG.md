# CHANGELOG — AI Advisory Board CLI

A chronological log of meaningful changes. Group by date; sub-section by topic. Each entry lists the user request that triggered it, the files touched, the why, and what was verified live.

The format is loosely "Keep a Changelog" but date-grouped — we're not yet versioned. Once we ship `aab@1.0.0`, switch to per-version sections.

---

## 2026-05-10

### Phase 1: multi-round discussions — `aab discuss continue` + `respond` + pre-round clarification gate

**Trigger:** "deep dive into PLAN/PLAN.md and PLAN/CHECKLIST.md and suggest the next step" → "YES PLEASE"

**What:** Closed the half-finished HITL loop. `aab discuss start` could produce a `pendingUserRequest`, but there was no way to reply or to drive round 2. Now there is.

**Engine** (`src/core/discussion/conversation-flow.ts`)
- `continueDiscussion({ discussion, members, settings, storage, ... })` — runs the **pre-round clarification gate** (one orchestrator call) before any model spawn. If the gate returns `request_user_input`, sets `pendingUserRequest`, saves, and returns `{ gated: true }` without burning member tokens. Otherwise generates round N+1, runs post-round orchestrator, persists.
- `respondToUserRequest({ discussion, content, selectedOption?, ... })` — appends a `UserResponse{type:'advisory_board_requested'}`, clears `pendingUserRequest`, then calls `continueDiscussion` with `skipPreRoundGate: true` (the orchestrator just asked for this exact reply — re-running it would loop forever) and the user's reply threaded as `userFollowUp.content`.
- Bonus: when a discussion concludes via `maxTurns`, any leftover `pendingUserRequest` is cleared so the UI never shows "done" alongside an unanswerable HITL prompt. Same fix in `startDiscussion` for round-1-ends-at-maxTurns.

**CLI** (`src/commands/discuss.ts`)
- `aab discuss continue <idOrShort> [--agents-dir <path>]`
- `aab discuss respond <idOrShort> <answer> [--option <i>] [--agents-dir <path>]` — `--option` is 1-based, validated against the actual `pendingUserRequest.options[]` list.
- Refactored `start`/`continue`/`respond` to share `verifyAgentFiles()` + `progressHandler()` helpers.
- Added `.warn()` to the TTY-fallback shim in `src/ui/spinner.ts` so cold-shell mode doesn't crash when we surface a gate decision.

**Web UI** (`src/gui/server.ts`, `gui/app.js`, `gui/style.css`)
- `POST /api/discussions/:id/continue` and `/respond` — same 202 + WS-broadcast pattern as `POST /api/discussions`. Returns `409 Conflict` when state forbids the action (already concluded, awaiting input, etc.).
- New `discussion_gated` WS event when the pre-round gate stops things short.
- Chat view footer now has: a **Continue button** when the discussion is open and not gated; an **inline reply form** (with option chips when the orchestrator listed any) when there's a pending HITL; "✓ Discussion concluded." line when done.

**Verified live (May 2026):**
- `start` → 3 members responded → orchestrator gated next round → `respond --option 1` with answer → 3 members responded round 2 → orchestrator asked again → maxTurns auto-concluded.
- Pre-round gate fires *before* any member spawn — confirmed zero member tokens spent when the orchestrator wants user input first.

**Docs:**
- `PLAN/CHECKLIST.md` — flipped 6 boxes to ✅; rewrote "What's running right now" with the live milestone.
- `README.md` — updated "Working today" + commands table; added the gate explanation.

---

### Phase 1: targeted follow-ups — `aab discuss follow-up`

**Trigger:** "YES PLEASE" (continue with the next sensible chunk)

**What:** Ask one specific board member, a subset of the board, or everyone — without the orchestrator deciding.

**Engine** (`src/core/discussion/conversation-flow.ts`)
- `addFollowUpQuestion({ discussion, question, members, targetType, ... })` with `targetType: 'all' | 'specific' | 'subset'`.
- Candidate pool restricted to the discussion's original `selectedMemberIds` — a follow-up can never pull in a member the discussion never had.
- Pre-round clarification gate fires here too, per PLAN §4.3.1.
- **Strict failure semantics**: any target-member error aborts the whole round. The user typed a specific question; partial responses would silently change the meaning. State is mutated only on full success — no half-baked saved rounds.
- Persists `round.followUpQuestion`, `followUpTargetType`, `followUpSelectedMemberId(s)`, plus a matching `UserResponse{type:'follow_up_question'}`.
- Exported new `FollowUpTargetType` type.

**CLI**
- `aab discuss follow-up <idOrShort> <question> [--all|--member <name>|--members <a,b,c>]`
- Mutually exclusive flags. Member token resolution by id, slug, exact name (case-insensitive), or unambiguous prefix. `--members` requires at least 2 distinct members (one is `--member`, all is `--all`).

**Web UI**
- `POST /api/discussions/:id/follow-up` — body `{ question, targetType, selectedMemberId?, selectedMemberIds? }`. Validates targetType + selection. Same WS broadcast pipeline.
- New chat-footer **Follow up** button. Click opens an inline composer with a textarea + a deselectable member-chip selector. Frontend infers `targetType` from chip count (all selected → `'all'`, exactly 1 → `'specific'`, in between → `'subset'`).

**Verified live:** `aab discuss follow-up <id> "..." --member "Elon Musk"` ran a strict 1-member round; saved discussion has the right metadata.

**Docs:** `PLAN/CHECKLIST.md` follow-up box flipped; `README.md` commands table + 3 follow-up examples.

---

### UI: workspace clarity, full CRUD, settings editing, visual polish

**Trigger:** "I CANT EVEN SELECT BOARD MEMBERS" (screenshot showing empty MEMBERS section in new-discussion modal) + "MAKE SURE THE UI ARE TOP TUNED"

**Root cause investigation:** Server returned 3 members fine via `/api/state`. The bug was the modal showing empty chips — caused by either (a) workspace resolution drift between `aab init` and `aab ui` cwd, or (b) a fresh modal opening before bootstrap had finished.

**Empty-state bug fix** (`gui/app.js`)
- New-discussion modal now shows a **loud yellow warning** when `state.members` is empty: prints workspace ID, full root path in monospace, and explicit instructions ("either run `aab init` here, or click Board members to add one"). Start button is disabled until at least one active member exists.
- `openNewDiscussionModal` is now `async` and refreshes state from server before opening — protects against stale state if the user just edited members in another tab.

**Workspace transparency** (`gui/index.html`, `gui/app.js`, `gui/style.css`)
- New **workspace card** in the sidebar above the nav with three rows: scope pill (`home`/`project`, color-coded cyan/green), member count (`N/M active`), and the full root path in monospace. Updates whenever members change.
- Server `/api/state` now returns `workspace.scope` and `workspace.projectRoot` (used by the card and by future "is this the right workspace?" checks).
- Added `getWorkspaceScope()` to `FsStorageService`.

**Members CRUD** — fully working from the UI
- Server: `POST /api/members`, `PATCH /api/members/:id`, `DELETE /api/members/:id`. CRUD also touches `.claude/agents/<slug>.md`:
  - On create: emits the agent file via `emitMemberAgentFile`.
  - On update: re-emits when name/persona/voice/expertise/tools changed; if name changed, deletes the old slug file (only if AAB-generated).
  - On delete: removes the agent file (only if AAB-generated — user-edited files preserved).
- Client: each member card has Edit + Delete buttons + an iOS-style switch for activate/deactivate. Inactive members fade to 55% opacity. "+ Add member" button on the view header opens a generic edit modal with name / title / expertise (comma-separated) / persona / voiceGuide.

**Principles CRUD**
- Server: `POST /api/principles`, `PATCH /api/principles/:id`, `DELETE /api/principles/:id`. `coerceCategory()` validates against the `PrincipleCategory` enum.
- Client: "+ Add principle" button. Edit form with title / description / behavior / category dropdown / priority. Click any card to edit. Inline switch for activate/deactivate.

**Settings editing**
- Server: `PATCH /api/settings` — merges with current settings, with type coercion for numeric fields that arrive as strings from the form.
- Client: 12-field form with proper input types — text fields, number fields with min/max, dropdowns for orchestrator style + model aliases (incl. specific Claude IDs), iOS-style switches for booleans (`autoSummarization`, `enableUserInteraction`), help text under tricky fields.

**Visual polish** (`gui/style.css`)
- Bumped contrast tokens: `--text` `#e6e9ef` → `#f1f3f7`, `--text-dim` `#98a3b8` → `#b4bccc`, `--text-faint` `#6b7689` → `#818a9d`, borders darker by ~10%. The "dim disabled-look" in the user's first screenshot is gone.
- New iOS-style `.switch` component with smooth slide animation.
- New `.btn-danger` (filled red) and `.btn-danger-ghost` (outlined red) for destructive actions.
- New confirm modal (`#confirm-modal`) for destructive actions with title + explanation message + reusable `openConfirmModal({title, message, okLabel, onOk})`.
- New `.workspace-card`, `.form-field`, `.settings-form` styles.
- View-header `gap: 16px` so action buttons (`+ Add member`) don't crowd the title.

**Verified live (curl):**
- `POST /api/members` → created Test Member, agent file `test-member.md` appeared in `.claude/agents/`
- `PATCH /api/members/:id` `{isActive: false}` → updated correctly
- `DELETE /api/members/:id` → returned 204, agent file was cleaned up
- `PATCH /api/settings` → updated boardTitle + maxTurns
- `POST /api/principles` + `PATCH` + `DELETE` → all 200/204

---

### Bug: all modals visible on page load (CSS specificity)

**Trigger:** Screenshot showing the confirm modal AND new-discussion modal both stacked on initial UI load.

**Root cause:** `.modal-backdrop { display: flex }` overrode the `[hidden]` UA-stylesheet rule. The HTML `hidden` attribute corresponds to `display: none` via the `[hidden]` UA rule, which has the same CSS specificity (0,0,1,0) as a class selector. Cascade tie → author rule wins → modal visible. Was always broken; only became visible when I added a 2nd and 3rd `.modal-backdrop` element (`#edit-modal`, `#confirm-modal`).

**Fix** (`gui/style.css` — one line at top of Modal block):
```css
[hidden] { display: none !important; }
```

Covers all `hidden` attribute usages, not just modals (also fixes a brief flash of the empty workspace card before bootstrap completed).

---

### User message bubbles + per-member streaming + live activity in typing dots

**Trigger:** "I want to display the user's message on the discussion as well, like it was a message app. Also display in the 3 dots animation what's happening — searching the web etc. If possible stream the answer or at least display the answers as the board members are done and not all shown at the end."

**(1) User messages as chat bubbles** (`gui/app.js`, `gui/style.css`)
- New `userBubble(text, label, selectedOption?)` renderer — right-aligned, brand-gradient color, asymmetric corners (`14px 14px 4px 14px`), 👤 avatar.
- New `discussionTimeline(discussion)` walker that interleaves user bubbles with member responses correctly:
  - Initial question (from `userResponses[type='initial_question']`) at the top
  - HITL replies (`type='advisory_board_requested'` with `roundNumber=N-1`) before round N
  - Follow-up questions (`round.userResponse` of `type='follow_up_question'`) before that round's responses
- `startNewChatView` injects the user's question as the first bubble in the live flow.
- `triggerRespond` and `triggerFollowUp` inject user bubbles + a fresh round divider immediately so the UI feels responsive.
- New `.message-user`, `.user-bubble`, `.avatar-user` styles.

**(2) Per-member streaming response broadcast**
- Engine extended `StartProgressEvent` union: `member_done` now carries `response: Response` and `roundNumber: number`. Added new `member_activity` and `orchestrator_decided` variants.
- All three runMember call sites (`startDiscussion`, `continueDiscussion`, `addFollowUpQuestion`) pass the response/roundNumber on `member_done` and emit `orchestrator_decided` after the post-round orchestrator call.
- Server: unified `broadcastRoundProgress` to broadcast `member_response` *immediately* on each `member_done` engine event (not in a post-hoc loop at end). `orchestrator_decided` → `orchestrator_decision` WS event mid-stream. Old "loop through every round at end and rebroadcast all responses" is gone.
- The `POST /api/discussions` handler now uses the same unified broadcaster (with empty `discussionId` for the initial round — client matches typing bubbles by `memberName`, not by discussionId).

**(3) Live activity in typing dots** (`src/llm/claude-code-runner.ts`, `src/core/discussion/run-member.ts`, `gui/app.js`, `gui/style.css`)
- `runClaude` got new `onEvent?: (event: ClaudeStreamEvent) => void` + `streaming?: boolean` options. When set, switches to `--output-format stream-json --verbose` and parses stdout line-by-line via a new `onLine` callback in `spawnRaw`. Final `{type:"result"...}` line is still extracted into `result.json` so token-usage logging keeps working.
- Added `parseLastResultLine()` helper.
- `runMember` got new `onActivity?` option. Internally creates `makeActivityForwarder()` that maps Claude stream events to friendly strings:
  - `tool_use:WebSearch` → `searching the web…` (detail = the query)
  - `tool_use:WebFetch` → `reading a web page…` (detail = URL)
  - `tool_use:Read` → `reading files…` (detail = path)
  - `tool_use:Grep` / `Glob` → `searching the codebase…`
  - First text block → `writing response…`
  - Dedupes consecutive identical activities so we don't spam.
- Conversation-flow forwards `onActivity` from each `runMember` call to `onProgress({stage:'member_activity', ...})`.
- Server broadcasts `member_activity` over WS with `discussionId, memberName, memberId, activity, tool, detail`.
- Client `typingBubble` HTML restructured: activity label + animated dots in one bubble shape (so the shape doesn't shift when the label changes), plus a secondary `.typing-detail` line below for tool input (truncated at 80 chars, monospace font).
- Client `updateTypingActivity(memberName, activity, detail)` finds the label by `[data-activity-for="..."]` attribute and updates text in place.
- Added small `cssEscape()` helper for safe attribute selector building.

**(4) Race-condition fix: pre-create typing bubbles**
- Bug surfaced after (2)+(3): user clicked Submit, saw user bubble + Round 1 divider but no typing bubbles. Server WS events fired correctly (verified), but the browser was still awaiting the POST response when `member_thinking` arrived → `addTypingBubble` ran with no `#chat-stream` in DOM yet → silent no-op.
- `submitNewDiscussion` now opens the chat view *before* the fetch (synchronous DOM setup) and pre-creates a typing bubble for each selected member up front. The dedupe in `addTypingBubble` (`if (existing) return`) means subsequent server `member_thinking` events are no-ops once they arrive.
- On `discussion_gated` (pre-round gate fired, no members spawned), pending typing bubbles are cleaned up so they don't sit forever.
- In `finalizeChat`, any typing bubble that never got a matching `member_response` (silent member failure) gets replaced with a `✗ No response` system bubble — useful safety net for genuine failures, but it became the symptom of the next bug.

**Verified live (WS monitor):**
```
[ws] member_thinking · Elon Musk
[ws] member_activity · Elon Musk → searching the web…  (Bitcoin price today May 2026)
[ws] member_activity · Elon Musk → writing response…
[ws] member_response · Elon Musk      ← bubble lands HERE, not at end
[ws] member_thinking · Julian Bent Singh
…
[ws] orchestrator_decision: continue
[ws] discussion_completed
```

---

### Bug: orphan typing bubbles after responses arrive

**Trigger:** Screenshot showing pre-created typing bubbles still saying "writing response …" at the top of the stream while the actual responses appeared *below* them. Eventually `discussion_completed` fired and `finalizeChat` converted the orphans to "✗ No response — failed or timed out", which looked alarming.

**Root cause:** The WS `member_response` event had no top-level `memberName` field — only `msg.response.memberName`. But the client handler read:
```js
} else if (msg.type === 'member_response') {
  replaceTypingWithResponse(msg.memberName, msg.response);  // msg.memberName = undefined
}
```
`state.pendingTyping.get(undefined)` → undefined → else branch → `appendChild(responseBubble)` at the bottom. The pre-created typing bubble stayed orphaned.

**This bug was always there.** It was invisible before today's pre-creation work because typing bubbles only existed for the brief window between `member_thinking` and the end-of-round response broadcast — and even then, the response usually didn't replace, it just got `appendChild`'d underneath. With pre-creation, the typing bubble lives for the whole round, making the orphan behavior obvious.

**Fix — three layers, all additive (no regression):**

1. **Client handler reads the right field, with fallback** (`gui/app.js`):
   ```js
   const name = msg.memberName || msg.response?.memberName;
   replaceTypingWithResponse(name, msg.response);
   ```
   Handles both the new (top-level) and old (nested) shape.

2. **Server adds `memberName` + `memberId` at top-level of `member_response` event for symmetry** (`src/gui/server.ts`):
   ```js
   broadcast({
     type: 'member_response',
     discussionId,
     memberName: e.response.memberName,  // ← added
     memberId: e.response.memberId,       // ← added
     response: e.response,
     ...
   });
   ```
   Future code that reads `msg.memberName` for any event type now Just Works.

3. **`replaceTypingWithResponse` falls back to DOM search** (`gui/app.js`) — uses the existing `[data-typing-for="..."]` attribute on every typing bubble. If `state.pendingTyping` ever drifts out of sync (some future code path forgets to update it), the DOM is the source of truth and the bubble still gets replaced.

**Verified live (WS monitor):**
```
[member_response] msg.memberName= "Elon Musk"           · msg.response.memberName= "Elon Musk"
[member_response] msg.memberName= "Julian Bent Singh"   · msg.response.memberName= "Julian Bent Singh"
[member_response] msg.memberName= "Alexandra Chen, CFA" · msg.response.memberName= "Alexandra Chen, CFA"
[done] discussion_completed
```

---

## Conventions for future entries

- One section per user trigger ("Trigger: ...").
- List file paths verbatim — they're searchable later.
- Always include a "Verified live" sub-bullet with what was actually observed (WS log lines, curl output, etc.). Build-clean alone doesn't count.
- Bug entries get a "Root cause" sub-bullet — name the mechanism, not just the symptom.
- For bug fixes, note "additive / no regression" reasoning explicitly.
- When a fix is **3 layers deep** (e.g., client reads field A, server emits both A and B for symmetry, client falls back to DOM as ultimate safety net), document each layer and why the redundancy is intentional.
- Cross-reference `PLAN/PLAN.md` sections when the change implements a designed behavior (e.g., "per PLAN §4.3.1").
