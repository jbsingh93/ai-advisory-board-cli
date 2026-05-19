# `specs/principles-seed-starters.md` — Principles: Seed starters button

**Phase:** 2 (Principles)
**Surface:** Principles tab header — `data-testid="principles-seed-btn"`.
**Endpoint:** `POST /api/principles/seed-starters` → `{ added, ids: [...] }`. 409 if already-seeded unless `{ force: true }`.
**Source:** `src/starter/starter-principles.ts` (8 Dalio-inspired starters).

## Pre-conditions
- For the happy path: workspace where `principles.json` is empty (or doesn't exist). Easiest: `aab init --non-interactive --home --name fresh-<date> --no-seed` followed by `--workspace fresh-<date>`.

## Steps (happy path)
1. Navigate to **Principles**. Empty state shows.
2. The **🌱 Seed starters** button (`data-testid="principles-seed-btn"`) is **enabled** (because `principles.length === 0`).
3. Click it. Button flips to "Seeding…".
4. After ~1 s: toast "Seeded 8 starter principles." Page re-renders.
5. 8 principle cards appear, sorted by priority (Embrace Reality (9) and Be Radically Open-Minded (9) at the top).
6. WS event `principles_seeded` is broadcast (informational; not user-visible).

## Steps (post-seed disabled)
1. After step 5, navigate to a different tab and back to **Principles**.
2. The **🌱 Seed starters** button is now **disabled** (tooltip: "Already seeded; disabled").
3. Direct API call: `curl -X POST /api/principles/seed-starters -H 'content-type: application/json' -d '{}'` → 409 with `{ error: '8 principle(s) already exist. Pass force=true to seed on top.' }`.
4. With `{ force: true }` → adds 8 more (total 16).

## What this catches
- The empty-workspace gating (UI disables the button when non-empty).
- The `force=true` opt-out for power users / fixtures.
- Atomic writes — 8 separate `savePrinciple` calls each take + release the mutex around `principles.json`.
- WS event broadcast is wired (subscribers can refresh their state).
