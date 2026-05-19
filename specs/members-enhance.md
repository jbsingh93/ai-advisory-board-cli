# `specs/members-enhance.md` — Members: Enhance with AI flow

**Phase:** 2 (Members CRUD)
**Surface:** GUI `Members` tab; member edit modal.
**Endpoint:** `POST /api/members/:id/enhance` → 202 + WS event stream.
**Server module:** `src/gui/server.ts` (lines around `app.post('/api/members/:id/enhance', ...)`)
**Engine:** `src/core/members/ai-enhancer.ts:enhancePersona`

## Pre-conditions
- `aab init --non-interactive --home --name smoke-<yyyy-mm-dd>` has run from the external test folder.
- `claude` CLI is on PATH (`aab doctor` returns green).
- Seed members are present (Elon, Julian, Alexandra).

## Steps
1. Navigate to **Members** via the sidebar (`data-testid="nav-members"` — sidebar nav button).
2. Click **Edit** on a member card (`data-testid="member-edit-btn"`). Modal opens with persona / voice fields.
3. In the AI-enhance row inside the modal, set the dropdown (`data-testid="enhance-type-select"`) to one of:
   - `famous` (Elon Musk → web-search-grounded)
   - `expert` (Alexandra Chen, CFA → top-1% specialist tone)
   - `non-famous` (Julian Bent Singh → practical practitioner)
4. Click **Enhance with AI** (`data-testid="enhance-with-ai-btn"`).
5. Observe the button label flip to "Enhancing…" and the status text "Calling claude…".
6. Wait for the WS event `member_enhance_done` (typically 60–120 s with real Claude calls).
7. Expected: the modal's **Persona** textarea has been filled with 4–6 paragraphs + (for `famous`) a Psychometric Profile + Cognitive Process suffix. The **Voice guide** textarea has been filled with a 3–5 sentence guide.
8. Click **Save**. The modal closes.
9. Reload the dashboard. Re-open the same member's edit modal. The persona + voice guide persisted.
10. Verify on-disk: the corresponding `.claude/agents/<slug>.md` has the new persona body in the AAB:GENERATED block.

## Negative cases
- Click **Enhance with AI** with an empty name/title → toast "Set name + title before enhancing." (no API call).
- Click **Enhance with AI** while creating a brand-new (not-yet-saved) member → toast "Save the member first, then click 'Enhance with AI' from the edit modal."
- Kill `claude` mid-call → `member_enhance_failed` WS event, toast surfaces the error.

## What this catches
- Regression in `enhancePersona` JSON parsing fallbacks (`safeParseJSONWithSchema` → regex → raw).
- The WS event-broadcast pipeline (`member_enhance_started` / `_progress` / `_done` / `_failed`).
- Agent-file regeneration after PATCH `/api/members/:id` lands the new persona.
