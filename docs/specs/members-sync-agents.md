# `docs/specs/members-sync-agents.md` — Members: Regenerate agent files button

**Phase:** 2 (Members CRUD)
**Surface:** Members tab header — `data-testid="members-sync-btn"`.
**Endpoint:** `POST /api/members/sync-agents` → JSON `{ written, skipped, total, skippedDetail }`.
**Engine:** `src/agents/emit-member-agent.ts:emitMemberAgentFile` (loops over active members).

## Pre-conditions
- Workspace with active members.
- The `.claude/agents/` directory exists (or will be created by the call).

## Steps
1. Navigate to **Members**.
2. (Setup) Manually delete one of the `.claude/agents/<slug>.md` files on disk (simulate a teammate's stale checkout). Note: leave the others intact.
3. Manually edit another `.claude/agents/<slug>.md` and remove its `# AAB:GENERATED` line (simulate a user customization).
4. Click **↻ Regenerate agent files** (`data-testid="members-sync-btn"`) in the header.
5. Expected: the button flips to "Regenerating…" briefly, then a toast: "Wrote N/total agent files (M skipped)." where:
   - N = active members − number whose existing file lacks the AAB:GENERATED marker.
   - M = number whose existing file lacked the marker (the customized one from step 3).
6. WS event `members_sync_done` fires.
7. Verify on disk: the file deleted in step 2 has been recreated; the file hand-edited in step 3 is **unchanged** (preserved).

## Negative cases
- Workspace with 0 active members → button click still succeeds with `{ written: 0, skipped: 0, total: N }`.
- `.claude/agents/` not writable → the underlying call throws, surfaced as toast "Sync failed: …".

## What this catches
- The `# AAB:GENERATED` marker contract (`isAabGenerated()`).
- The active-only default (passing `all=true` would include inactive — toggle hooks not implemented in UI but covered by CLI `aab members sync-agents --all`).
- That `data-testid` is in place for Playwright MCP locator stability.
