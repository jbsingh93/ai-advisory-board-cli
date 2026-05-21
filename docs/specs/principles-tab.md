# `docs/specs/principles-tab.md` — Principles: list / add / edit / explore / delete

**Phase:** 2 (Principles) + 6.6 (test infrastructure)
**Surface:** `data-testid="tab-principles"` sidebar → principles view.

**Endpoints:**
- `GET /api/principles`
- `POST /api/principles`
- `PATCH /api/principles/:id`
- `DELETE /api/principles/:id`
- `POST /api/principles/seed` (seed starters)
- `POST /api/principles/explore` (Principle Explorer wizard turn — see `docs/specs/principles-explore-wizard.md`)

**Engine:** `src/storage/fs-storage-service.ts` (atomic write + snapshot); `src/core/principles/principle-explorer.ts`.

## Pre-conditions
- Workspace bootstrapped via `aab init`.

**`data-testid` references:** `tab-principles`, `principles-seed-btn`, `principles-add-btn`,
`principle-explore-btn`, `edit-modal`, `explorer-modal-body`.

## Steps
1. `browser_click tab-principles`.
2. `browser_snapshot`. Verify view title `Principles` and a list of cards (one per principle) — or the empty-state with `principles-seed-btn` if none.
3. **Seed starters** (only if empty): `browser_click principles-seed-btn`. Confirm in the confirm-modal. Verify 8 principle cards land (the starter set).
4. **Add a principle:**
   - `browser_click principles-add-btn`. Edit modal opens.
   - Fill Title = `Ship the smallest thing that works`. Fill Body = `Bias to action: a half-working v0 beats a fully-specced design doc on day one.`
   - Save. New card appears at the top of the list.
5. **Edit a principle:** click the card → modal opens with Title + Body prefilled → change Title → Save. Card updates in place.
6. **Explore a principle:** on any card, `browser_click principle-explore-btn`. The Principle Explorer wizard modal opens (`explorer-modal-body`). Confirm step 1 of 5 is rendered with `data-testid="explorer-step-<n>"`. (Full wizard coverage is in `docs/specs/principles-explore-wizard.md`.)
7. **Delete:** open Edit → click Delete in the modal footer → confirm. Card disappears; a snapshot is recorded under `<workspace>/.snapshots/principles/` (verify via filesystem).

## Expected observations
- Cards show the principle Title + a truncated body preview.
- Editing fires `PATCH /api/principles/:id` and the snapshot directory grows by one file per save.
- Seeding is idempotent against re-running (the engine should no-op if the starter set is already present, or merge — verify which is current behavior in the toast / network response).

## Failure modes worth a screenshot
- Edit modal save button stays disabled even after both fields have content (form-validation regression).
- A principle that was just edited renders the OLD body on the card (refresh-state miss).
- Seed button creates duplicates instead of being idempotent.
