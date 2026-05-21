# `docs/specs/members-tools-allowlist.md` — Members: per-member tool allowlist

**Phase:** 2 (Members CRUD)
**Surface:** Member edit modal (`data-testid="member-tools-allowlist"`).
**Endpoint:** `PATCH /api/members/:id` (body: `allowedTools: string[]`).
**Engine:** `src/agents/emit-member-agent.ts:emitMemberAgentFile` — `tools:` frontmatter line reflects the override.

## Pre-conditions
- Workspace bootstrapped with at least one member.

## Steps
1. Navigate to **Members**.
2. Click **Edit** on a member card.
3. Locate the **Allowed tools (per-member override)** section in the modal.
4. By default the chips read `WebSearch`, `WebFetch`, `Read`, `Grep`, `Glob` — all checkboxes match `member.allowedTools` (empty = none checked = use workspace default).
5. Uncheck `WebSearch`. Check only `Read` + `Grep`.
6. Click **Save**.
7. Toast: "Member updated." Modal closes.
8. Inspect `.claude/agents/<slug>.md` on disk. The `tools:` frontmatter line should now read `tools: Read, Grep` (sorted insertion order from the palette).
9. Re-open the same member's edit modal. The chips for `Read` + `Grep` are checked; the rest unchecked.
10. Now uncheck all chips. Click **Save**.
11. Expected: server receives `allowedTools: []`, normalizes to `undefined` (line 290-ish in `src/gui/server.ts` PATCH handler). On-disk agent file falls back to the 5-tool DEFAULT_TOOLS palette in `emit-member-agent.ts`.

## Negative cases
- Checking a tool not in the palette (impossible via UI — chips are fixed). CLI counterpart: `aab members tools <id> --allow Bash` — verify storage layer accepts it but the agent emitter omits unknown tools.

## What this catches
- Regression in the GUI server's "empty array → undefined" coercion (the trap is that an empty `allowedTools` array would write `tools:` (empty) and break Claude Code's agent discovery).
- Agent-file frontmatter freshness — when tools change, `.claude/agents/<slug>.md` should be re-emitted with the new list. (See `shouldRegen` branch in the PATCH handler.)
