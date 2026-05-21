# `docs/specs/members-tab.md` — Board members: list / show / edit / activate / deactivate

**Phase:** 2 (Members) + 6.6 (test infrastructure)
**Surface:** `data-testid="tab-members"` sidebar → members view.

**Endpoints:**
- `GET /api/members`
- `POST /api/members`
- `PATCH /api/members/:id` (rename, edit description/voice/tools, set `isActive`)
- `DELETE /api/members/:id`
- `POST /api/members/sync-agents` (regenerate all `.claude/agents/<slug>.md`)

**Engine:** `src/storage/fs-storage-service.ts` for persistence; `src/agents/emit-member-agent.ts` for agent-file emission.

## Pre-conditions
- Workspace with at least the seeded members (Elon Musk, Julian Bent Singh, Alexandra Chen) or empty so we can verify Add.
- `claude` CLI installed (only required for the Voice button).

**`data-testid` references:** `tab-members`, `members-sync-btn`, `members-add-btn`,
`member-edit-btn`, `member-voice-btn`, `member-delete-btn`,
`enhance-type-select`, `enhance-with-ai-btn`, `member-tools-allowlist`.

## Steps
1. `browser_click tab-members`.
2. `browser_snapshot`. Verify the view title `Board members` and subtitle `<n> active · <m> total`.
3. Verify each existing member renders a card with avatar (with the frontmatter `data-color`), name, description preview, an Active/Inactive pill, and the Edit / Voice / Delete buttons.
4. **Add member:**
   - `browser_click members-add-btn`. Edit modal opens (`role="dialog" aria-modal="true"`).
   - Fill Name = `Test Member`. Fill Description = `A throwaway test member`.
   - `browser_click` Save.
   - Verify a new card appears for `Test Member` and the `.claude/agents/test-member.md` file is written (verify via `aab doctor` or by inspecting the workspace).
5. **Edit member:** click `member-edit-btn` on the Test Member card → change Description → Save. Card text updates; the agent file is regenerated (still has the `# AAB:GENERATED` marker).
6. **Activate / deactivate:** open Edit → toggle `isActive` switch → Save. The pill flips between `Active` and `Inactive` and the New-discussion modal's chip count reflects the change.
7. **Sync agents:** `browser_click members-sync-btn`. Verify the button transitions to `Regenerating…` then back to default text and a success toast appears.
8. **Delete:** `browser_click member-delete-btn` on Test Member → confirm in confirm-modal → card disappears.

## Expected observations
- The avatar colors come from each member's YAML frontmatter `color:` field (via `readMemberAgentColor()`), with the `colorForMember(name)` fallback only used when frontmatter is missing.
- The Edit modal renders the `enhance-type-select` dropdown plus `enhance-with-ai-btn` for `description` / `voiceGuide` / `searchKeywords` regeneration.
- The Tools allowlist (`member-tools-allowlist`) shows the chips matching the agent file's `tools:` frontmatter.

## Failure modes worth a screenshot
- Sync button stays in `Regenerating…` >30 s (FS lock or batch failure).
- Edit modal's `member-tools-allowlist` is empty even though the agent file has tools listed (regression in `enrichMembers()`).
- A hand-edited agent (missing `# AAB:GENERATED` marker) gets silently overwritten by Sync (regression in `isAabGenerated()`).
