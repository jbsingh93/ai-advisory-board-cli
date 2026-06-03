# Spec — Boards (member groups) & Dynamic member targeting in discussions

**Status:** Proposed · **Author:** drafted from codebase + sage-council + external research · **Date:** 2026-06-02

This spec covers two related, user-requested features:

1. **Boards** — named, reusable groups of board members (the sage-council "boards" concept), so a user can convene a specific panel (e.g. "Go-to-Market Board", "Technical Board") instead of always using every active member.
2. **Dynamic member targeting in follow-ups** — in an ongoing discussion, let the user (a) ask a follow-up to only a subset of members, and (b) **add a brand-new member into a live discussion** (one not in the original roster), with an explicit "catch them up" choice.

Both features share one design principle, drawn from CrewAI / Dust / LangGraph and the sage-council source: **members are the source of truth; boards and discussions hold _references_ to members, never copies.** A discussion additionally **snapshots** the identity of each participant so history never breaks when a member is later edited or deleted.

---

## 0. Why this is mostly "finish what's started", not "build from scratch"

A codebase audit shows the **board data layer already exists but has zero surface area**, and the **follow-up targeting modes already exist but are locked to the original roster**. This spec is largely about wiring, with two genuinely new pieces (mid-discussion join + the board picker UX).

What already exists today:

| Layer | What's present | Where |
|---|---|---|
| Board domain type | `Board { id, name, description?, memberIds, createdAt, updatedAt }` | `src/storage/types.ts:26-33` |
| Board storage methods | `loadBoards / saveBoard / updateBoard / deleteBoard` (atomic, snapshotted) | `src/storage/fs-storage-service.ts:110-131`; interface `src/storage/types.ts:576-580` |
| Board file path | `boards.json` resolved in workspace paths | `src/storage/paths.ts:153` |
| Discussion ↔ board link | `Discussion.boardId?`, `Discussion.boardName?` | `src/storage/types.ts:157-158` |
| Discussion roster | `Discussion.selectedMemberIds?` (drives every round) | `src/storage/types.ts:156` |
| Follow-up targeting | `addFollowUpQuestion` with `targetType: 'all' \| 'specific' \| 'subset'` | `src/core/discussion/conversation-flow.ts:672-921` |
| Follow-up CLI | `discuss follow-up --all / --member / --members` | `src/commands/discuss.ts:282-436` |
| Follow-up web | `POST /api/discussions/:id/follow-up` + chip picker | `src/gui/server.ts:1521-1636`, `gui/app.js:450-563` |

What is **missing** and this spec adds:

- No `aab board` CLI command; no board REST endpoints; no board UI; `boards.json` is never written.
- `init` seeds members but **no board**.
- `discuss start` cannot select members by board.
- Member delete does **not** prune `memberIds` from boards → orphan risk.
- Follow-up candidate pool is hard-restricted to `discussion.selectedMemberIds` (`conversation-flow.ts:716`, `server.ts:1565`, `app.js:465`), so **adding a new member mid-discussion is impossible**.
- Discussions store member *IDs* only, not a participant snapshot → deleting/renaming a member corrupts historical transcripts' display.

---

## 1. Feature 1 — Boards (member groups)

### 1.1 User stories

- As a user with 12 members, I create a **"Go-to-Market Board"** (5 members) and a **"Technical Board"** (4 members) so I can convene the right panel per question.
- I start a discussion **against a board** in one step instead of typing `--members a,b,c,d,e`.
- I set an **active board** so `aab discuss start "<q>"` uses it by default (kubectx-style ergonomics).
- I edit a board's roster, rename it, or delete it — and deleting a member it contains doesn't leave a dangling reference.

### 1.2 Data model

Keep the **existing** `Board` type as-is — it already mirrors sage-council exactly. Add only an optional `slug` for CLI addressing and an optional `archivedAt` for soft-delete parity with members.

```ts
// src/storage/types.ts — extend the existing interface (lines 26-33)
export interface Board {
  id: string;
  name: string;
  slug: string;            // NEW: kebab-case, unique, derived from name; CLI addressing
  description?: string;
  memberIds: string[];     // ordered references into members.json
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;     // NEW (optional): soft-delete; hidden from pickers, kept for history
}
```

> **Slug rationale:** members are addressed in the CLI by name/slug/id (`resolveMemberToken`, `discuss.ts:1098`). Boards need the same ergonomics (`aab discuss start --board gtm`). Generate with the same `slugify(name, { lower: true, strict: true })` used for members (`emit-member-agent.ts:25`). Enforce uniqueness on create/rename; on collision, suffix `-2`, `-3`, …

**No separate file or join table.** Boards live in the already-wired `boards.json` as `Board[]`. `memberIds` is a plain ordered array of member UUIDs (matches sage-council's `member_ids TEXT[]`, no pivot table).

### 1.3 Constraints (ported from sage-council `boundary-validation.ts`)

- `name`: required, trimmed, **1–100 chars**, unique (case-insensitive) within the workspace.
- `description`: optional, **0–500 chars**.
- `memberIds`: **1–N** (see note), deduplicated (`[...new Set(ids)]`), each must reference an existing member.
- **Max members:** sage-council caps at 5. We should cap at `settings.maxMembersPerDiscussion` (default 5) **as the discussion-time cap, not the board-definition cap.** Recommendation: allow a board to *hold* more than the cap, but warn, and when convening a discussion enforce the per-discussion cap (truncate-with-warning or block — see §1.7). This avoids the sage-council friction of "can't even save the panel I want."
- Ordering of `memberIds` is preserved and meaningful (defines render/response order).

### 1.4 Storage changes

`FsStorageService` already implements all four board methods. Add:

- `saveBoard` / `updateBoard`: validate slug uniqueness; snapshot `boards.json` to `.snapshots/` before overwrite (mirror the members.json snapshot behavior — currently boards use plain atomic write; upgrade to snapshotted for parity since boards are user-curated and worth versioning).
- **Cascade prune on member delete** (the orphan fix). Add to `deleteBoardMember` (and the UI/CLI delete paths): after removing the member, load boards, strip the id from every `board.memberIds`, and persist any board that changed. If a board becomes empty, **keep it but flag it** (don't auto-delete — the user may re-populate it); surface a warning. Implement as a small helper `pruneMemberFromBoards(storage, memberId): Promise<{ affected: Board[]; emptied: Board[] }>` so both CLI and web reuse it.

### 1.5 Active-board pointer (kubectx idiom)

Mirror the existing `~/.aabcli/.active` workspace pointer pattern (`paths.ts`). Store the active board **per workspace** so it travels with the workspace.

- New field on `AppSettings`: `activeBoardId?: string` (persisted in `settings.json`). Chosen over a separate pointer file because settings are already snapshotted and loaded on every command; one fewer file to manage. `undefined` ⇒ "All active members" (the implicit default board).
- New resolution helper `resolveBoardMembers(storage, settings, opts)` returns the member set for a discussion, with this precedence (extends the documented workspace-precedence philosophy in CLAUDE.md):
  1. `--members <names>` flag (explicit ad-hoc subset — highest, unchanged behavior)
  2. `--board <slug|id|name>` flag
  3. `AAB_BOARD` env var
  4. `settings.activeBoardId`
  5. **All active members** (today's default — fully backward compatible)
- **Always echo the resolved panel** in `discuss start` output ("Convening: Go-to-Market Board — Elon, Julian, Alexandra") so a user never convenes the wrong panel (kubectx's visual-indicator safety lesson). If the resolved set is empty after filtering inactive members, error with a hint.

### 1.6 CLI surface — new `aab board` command

New file `src/commands/board.ts`, registered in `src/cli.ts` next to `registerMembersCommand`.

```
aab board list                          # table: name, slug, #members, active marker (*)
aab board show <slug|id|name>           # name, description, ordered members (active/inactive), linked discussions count
aab board create <name> [--description "..."] [--members a,b,c] [--activate]
aab board edit <slug> [--name ...] [--description ...]
aab board add-member <slug> <member>    # append member (name/slug/id) to roster
aab board remove-member <slug> <member> # remove member from roster
aab board set-members <slug> a,b,c      # replace roster wholesale (ordered)
aab board rename <slug> <new-name>      # convenience for edit --name; regenerates slug
aab board delete <slug> [--yes]         # remove board (does NOT delete members)
aab board use <slug|->                  # set active board; `-` toggles to previous (kubectx)
aab board current                       # print active board (or "All active members")
```

Conventions to match the existing `members` command (`src/commands/members.ts`):
- Reuse `resolveMemberToken` (name/slug/id/prefix) for `<member>` args.
- Add an analogous `resolveBoardToken` (name/slug/id/prefix) for `<board>` args.
- `--json` global flag supported on `list`/`show`/`current`.
- Interactive multi-select for `create`/`set-members` when no `--members` given and stdin is a TTY: use `@inquirer/checkbox` (pre-check current members on edit; `Separator` for long lists). Non-interactive (`--members` or non-TTY) takes the comma list, matching `pickMembers` semantics (`discuss.ts:1111`).
- All writes go through `openContext(cmd)` (acquires the workspace mutex); read-only verbs use `{ lock: false }` like `members list`.

`discuss start` gains:
```
aab discuss start "<q>" [--board <slug|id|name>] [--members a,b,c] ...
```
`--board` and `--members` are mutually exclusive (error like the follow-up flag-count guard, `discuss.ts:296`). On start, set `discussion.boardId` and `discussion.boardName` (snapshot) when a board was used, and `selectedMemberIds` to the resolved set (existing field, `conversation-flow.ts:101`).

### 1.7 Discussion-time member cap

`settings.maxMembersPerDiscussion` (default 5) is currently **not enforced** at discussion start (only `--members` filters). When convening from a board larger than the cap:
- Default: **block** with a clear error + hint ("Board 'X' has 7 active members; max per discussion is 5. Narrow with `--members`, raise `settings.maxMembersPerDiscussion`, or trim the board."). Blocking is safer than silent truncation (avoids the "I didn't realize 2 advisors were dropped" failure).
- Document this in the board `show` output (warn when `#active members > cap`).

### 1.8 `init` seeding

`src/commands/init.ts` seeds 3 starter members but no board. Add: after seeding members, create a starter board **"Full Board"** containing all seeded members and set it active (`settings.activeBoardId`). This makes the feature discoverable from first run and gives the picker a non-empty state. (Matches the external recommendation to "ship a Default/All board so the empty state is never broken.")

### 1.9 Web surface — boards

**REST** (in `src/gui/server.ts`, mirroring the member endpoints at `:506-614`):
```
GET    /api/boards                      # list (enriched with member previews, like enrichOne)
POST   /api/boards                      # { name, description?, memberIds[] }
PATCH  /api/boards/:id                  # partial update (name/description/memberIds)
DELETE /api/boards/:id                  # delete board (not members)
POST   /api/boards/:id/activate         # set settings.activeBoardId
GET    /api/boards/active               # resolved active board (or null)
```
Validation mirrors §1.3; reuse the same zod-less guard style already in the members endpoints. On member delete (`DELETE /api/members/:id`, `server.ts:608`), call the shared `pruneMemberFromBoards` helper and include `affectedBoards` in the response so the UI can toast.

**Frontend** (`gui/app.js`): the nav is route-based (`.nav-item[data-route]`, dispatch at `app.js:204-215`). Two touch points:
1. **Boards management** — add a "Boards" section to the existing Members view (`renderMembersView`, `app.js:1271`) rather than a whole new route, since boards are just curated selections of the members shown right there. Render `BoardGroupCard`-style cards (name, description, overlapped member avatars with `+N` overflow, member count) — port the sage-council `BoardGroupCard` layout. Provide Create/Edit modal reusing the existing edit-modal shell (`#edit-modal`) with: name, description, and a member multi-select chip grid (reuse the chip pattern from the follow-up composer, `app.js:472`).
2. **New-discussion screen** — add a board picker. Port sage-council's `MemberSelectionDialog` two-mode UX: a **"Boards"** segment (pick a board → pre-fills its members, editable before confirm) and an **"Individual"** segment (ad-hoc member checkboxes, today's behavior). Selecting a board passes `{ boardId, boardName }` through to discussion creation.

### 1.10 What we deliberately do NOT port from sage-council

- Per-user RLS / `user_id` scoping — `aab` is local, single-user; workspace scoping replaces it.
- Supabase triggers for `updated_at` — handled by `nowIso()` in the storage layer already.

---

## 2. Feature 2 — Dynamic member targeting in follow-ups

### 2.1 Current behavior (baseline)

`addFollowUpQuestion` (`conversation-flow.ts:672`) already supports `all` / `specific` / `subset`, and both the CLI (`--all/--member/--members`) and web (chip picker) drive it. **But** the candidate pool is hard-restricted to the discussion's original roster:

```ts
// conversation-flow.ts:716 — the restriction we must relax for "add new member"
const allowedIds = new Set(discussion.selectedMemberIds ?? activeMembers.map((m) => m.id));
const candidatePool = activeMembers.filter((m) => allowedIds.has(m.id));
```

Same restriction in `server.ts:1565` and `app.js:465`. So **selecting among existing members already works**; the genuinely new capability is **adding a member who was never in the discussion.**

### 2.2 Scope of this feature

Two sub-features:

- **2A — Narrow targeting (already works; polish only):** ask a follow-up to a chosen subset. Minor improvements: clearer labels, keep the orchestrator's view global (§2.6).
- **2B — Add a new member mid-discussion (new):** bring an existing-but-not-in-this-discussion member into the discussion, OR create a brand-new member and add them — then optionally direct the follow-up to them.

### 2.3 The core question: context catch-up

External research (Slack's "include history?" prompt; the multi-agent failure taxonomy FM-1.4 "loss of context", FM-2.1 "unwanted restarts") makes the central design decision explicit: **when a member joins mid-discussion, what do they see?** This must be an explicit, recorded choice — never silent.

Offer three catch-up modes:

| Mode | What the new member receives | Cost | When |
|---|---|---|---|
| `full` (default) | The full prior-rounds transcript, same as a returning member would get via `build-user-message.ts` | High tokens | Default; most consistent |
| `summary` | The discussion's running summary (or an on-demand orchestrator summary of prior rounds) instead of the raw transcript | Low | Long discussions where full transcript over-anchors / risks "lost in the middle" |
| `fresh` | Only the current follow-up question + the original discussion question, no prior rounds | Lowest | When you want an uncontaminated take |

The chosen mode is persisted (see §2.4) so renders can show "joined round 3 (caught up via summary)" and so the actual context a member saw is reconstructable.

### 2.4 Data model changes

**Discussion participant snapshot (the orphan/robustness fix).** Today rounds reference members by id only; deleting/renaming a member corrupts historical display. Add a participant roster snapshot on the discussion:

```ts
// src/storage/types.ts — new type + field on Discussion
export interface DiscussionParticipant {
  memberId: string;
  name: string;            // snapshot at join time
  slug: string;            // snapshot — drives agent dispatch even if member renamed
  title: string;           // snapshot for display
  joinedAtRound: number;   // 1 for founding members; N for mid-discussion joins
  catchUpMode?: 'full' | 'summary' | 'fresh';  // set for mid-discussion joins
  removedAtRound?: number; // optional: if a member is dropped from later rounds
}

export interface Discussion {
  // ...existing fields...
  selectedMemberIds?: string[];   // KEEP for back-compat; remains the "current roster" id list
  participants?: DiscussionParticipant[];  // NEW: authoritative, append-only snapshot
}
```

- `participants` is **append-only** (LangGraph-style history integrity). Founding members get `joinedAtRound: 1`. Adding a member appends an entry and adds the id to `selectedMemberIds`.
- On any new discussion, populate `participants` from the founding members; keep `selectedMemberIds` in sync as the convenient id list (so existing pool logic at `conversation-flow.ts:716` keeps working).
- **Render layer** (`render-discussion.ts`, `app.js`) reads names/titles from `participants` (snapshot) rather than re-resolving live members → deleting a member never breaks an old transcript.
- `ConversationRound` already records `followUpTargetType` / `followUpSelectedMemberIds` (`types.ts:121-133`); extend the round to note a join event for timeline rendering:

```ts
// add to ConversationRound
addedMemberIds?: string[];       // members who joined in this round
```

### 2.5 Engine changes — `addFollowUpQuestion`

Add an optional input to the existing options interface (`conversation-flow.ts`, `AddFollowUpQuestionOptions`):

```ts
export interface AddFollowUpQuestionOptions {
  // ...existing...
  /** Members to add to the discussion before this round runs (existing member ids not yet in the discussion). */
  addMemberIds?: string[];
  /** How freshly-added members are brought up to speed. Default 'full'. */
  catchUpMode?: 'full' | 'summary' | 'fresh';
}
```

Behavior:
1. If `addMemberIds` present: validate each id is an **active** member that exists in `members.json` and is **not already** in the discussion. For each, ensure its `.claude/agents/<slug>.md` exists (call `emitMemberAgentFile` if missing — a member created via the UI/CLI always has one, but be defensive). Append to `discussion.participants` (with `joinedAtRound` = the round about to run and `catchUpMode`), and add to `selectedMemberIds`.
2. **Relax the candidate-pool restriction** so newly-added ids are eligible: compute the pool from the *updated* roster, not just the original `selectedMemberIds`. Concretely, the pool = active members whose id is in the (now-extended) `selectedMemberIds`.
3. Build the catch-up message per `catchUpMode` for newly-joined members:
   - `full` → existing `build-user-message.ts` path (full context), unchanged.
   - `summary` → if `discussion.summary` exists use it; else do one orchestrator call to summarize prior rounds, then feed that as the context block.
   - `fresh` → context block contains only the original question + the current follow-up.
   - Founding/returning members always get the normal full context regardless of `catchUpMode` (the mode only governs newcomers).
4. Targeting (`all`/`specific`/`subset`) then applies **over the updated pool**. Natural composition: "add Alexandra AND direct this follow-up only to her" = `addMemberIds: [alexandraId]` + `targetType: 'specific', selectedMemberId: alexandraId`.
5. **Strict abort preserved** (`conversation-flow.ts:810`): if any targeted member (including a newcomer) fails, the whole round aborts and nothing is committed — including the participant addition. Do the `participants`/`selectedMemberIds` mutation on the **in-memory** discussion and only persist on full success, exactly like the round object today (`conversation-flow.ts:776-886`).
6. Record `round.addedMemberIds` for timeline rendering.

> **Edge case — adding a member but not targeting them:** if `addMemberIds` is set with `targetType: 'all'`, the newcomer participates this round (gets caught up + responds). If `targetType: 'specific'`/`'subset'` excludes them, they are added to the roster (future rounds include them) but **do not respond this round** and receive no catch-up message yet — catch-up happens the first round they actually speak. Document this clearly; it's the Slack distinction between "add to channel" and "@mention."

### 2.6 Keep orchestration global (anti-pattern guard)

Per the multi-agent failure taxonomy (FM-2.4 info-withholding, FM-2.5 disregarding input): even when responses are scoped to a subset, the **orchestrator must still see the full transcript and full roster**. The orchestrator call (`orchestrator.ts`) already runs over `activeMembers` and the whole discussion; ensure adding/subsetting members does not narrow what the orchestrator sees — only narrows who *responds*. No change needed beyond not "optimizing" the orchestrator's input down to the subset.

### 2.7 CLI surface — follow-up additions

Extend `aab discuss follow-up` (`src/commands/discuss.ts:282`):

```
aab discuss follow-up <id> "<q>"
    [--all | --member <m> | --members a,b,c]      # existing targeting (unchanged)
    [--add-member <m>]                            # NEW: add an existing member to the discussion (repeatable)
    [--add-members a,b,c]                         # NEW: add several
    [--catch-up full|summary|fresh]              # NEW: default full
```

- `--add-member`/`--add-members` resolve via `resolveMemberToken` against **all active members** (not the restricted pool), erroring if the member is already in the discussion or inactive.
- A convenience: if a user does `--member "New Person"` where New Person is active but not in the discussion, offer a hint ("New Person isn't in this discussion. Use `--add-member` to bring them in.") rather than the current hard error (`discuss.ts:330`).
- For **creating a brand-new member then adding** in one go, do **not** overload follow-up. Direct users to `aab members add ...` then `aab discuss follow-up <id> "<q>" --add-member <new>`. (Keeps follow-up focused; member creation is already a rich interactive/`--enhance` flow.)

### 2.8 Web surface — follow-up additions

**REST** — extend `POST /api/discussions/:id/follow-up` body (`server.ts:1521`):
```jsonc
{
  "question": "…",
  "targetType": "all|specific|subset",
  "selectedMemberId": "…",
  "selectedMemberIds": ["…"],
  "addMemberIds": ["…"],          // NEW
  "catchUpMode": "full|summary|fresh"  // NEW, default "full"
}
```
Validate `addMemberIds`: each must be an active member, not already a participant. Expand the candidate pool to include them before applying targeting. Broadcast a new WS event `member_joined` (id, name, joinedAtRound, catchUpMode) so the live stream can show "Alexandra Chen joined the discussion."

**Frontend** (`gui/app.js`, follow-up composer `renderFollowUpComposer` at `:450`):
- Today the composer shows only the discussion's existing members as chips (`app.js:465`). Add an **"+ Add member"** affordance below the chip grid that opens a secondary list of *active members not already in the discussion*. Selecting one adds a (visually distinct, e.g. dashed-border) chip and, when chosen, reveals a small **catch-up selector** ("Catch up with: Full transcript · Summary · Fresh start", defaulting to Full) — directly porting Slack's "include history?" prompt.
- Submit logic extends the existing target-type computation (`app.js:512-523`): include `addMemberIds` for any newly-added chips and `catchUpMode` from the selector.
- The user bubble label already differentiates targeting (`app.js:357-376`); add a "+N joined" affordance on the round divider when `round.addedMemberIds` is non-empty.

---

## 3. Cross-cutting concerns

### 3.1 Orphan / referential integrity (the big one)

- **Member delete → prune boards** (§1.4): `pruneMemberFromBoards` removes the id from all boards; CLI/web surface a warning listing affected/emptied boards.
- **Member delete → discussions are safe by snapshot:** because rounds + `participants` snapshot name/slug/title, deleting a member never corrupts historical transcripts. Live/continuable discussions: a deleted member simply drops out of future rounds (the existing `&& m.isActive` filter at `conversation-flow.ts:397` already handles "member no longer active"). The snapshot ensures their *past* contributions still render with their name.
- **Soft-delete recommendation:** prefer marking members `isActive: false` (already supported) over hard delete when they appear in any discussion; reserve hard delete for never-used members. Do **not** wire cascade delete at the storage layer (external research: app-level cleanup only, so we can distinguish "remove from active boards" from "preserve in transcripts").
- **Board delete** never touches members or discussions; a discussion's `boardName` snapshot keeps the historical label even after the board is gone.

### 3.2 Backward compatibility / migration

- Existing discussions have no `participants`. On load, if `participants` is absent, **lazily synthesize** it from `selectedMemberIds` (or all active members) with `joinedAtRound: 1` — do this in a read-time normalizer, not a destructive migration, so old files keep working. Persist the synthesized form on next save.
- `boards.json` absent ⇒ `loadBoards()` already returns `[]` (`fs-storage-service.ts`). `activeBoardId` absent ⇒ "All active members."
- No breaking changes to any existing CLI flag or REST shape; all additions are optional.

### 3.3 Settings

- Add `activeBoardId?: string` to `AppSettings` + `DEFAULT_SETTINGS` (undefined). Document in `settings` command help.
- `maxMembersPerDiscussion` becomes *enforced* at discussion start (§1.7) — note in CHANGELOG as a behavior change (previously advisory).

### 3.4 Telemetry / token usage

- Mid-discussion `summary` catch-up adds one orchestrator call; log it via `fireTokenUsage` with `operationType: 'summary'` (or a new `'catchup_summary'`) so it's attributable.
- No new token cost for `full`/`fresh` beyond the member calls themselves.

---

## 4. Testing & verification

Per `CLAUDE.md`, typecheck+build is necessary but **not sufficient** — live smoke is mandatory for CLI and Playwright MCP for UI. Smoke from the external test folder, never the repo root.

**CLI smokes (from `C:\Users\julia\Downloads\kode\ai-advisoryboardclitestfolder`):**
- `board create` → `board list` shows it; `board use` sets active; `board current` confirms.
- `discuss start "<q>" --board <slug>` convenes exactly the board's members; output echoes the panel.
- `discuss follow-up <id> "<q>" --add-member <new> --catch-up summary` → new member responds; `discuss show` shows "joined round N".
- `members delete <m>` where `m` is in a board → board roster pruned, warning printed.
- Back-compat: open a pre-existing discussion (no `participants`) → renders correctly; follow-up still works.

**UI smokes (Playwright MCP):**
- Create a board via the Members view; start a discussion via the board picker; verify member set.
- In a live discussion, "+ Add member" → pick catch-up mode → send follow-up → verify the new member's bubble and the "joined" divider.

**Unit-level (vitest, once test infra lands):**
- `resolveBoardMembers` precedence table.
- `pruneMemberFromBoards` (member in 0/1/many boards; board emptied).
- `addFollowUpQuestion` with `addMemberIds`: pool expansion, strict-abort rollback of the participant addition, catch-up message selection.
- Participant-snapshot normalizer for legacy discussions.

---

## 5. Phasing (suggested PR breakdown)

Each phase is independently shippable and smoke-testable.

1. **Boards CLI + storage finish** — `slug`, snapshotting, `aab board` command, `resolveBoardMembers`, `--board` on `discuss start`, `pruneMemberFromBoards` on member delete, `init` seeds "Full Board", `activeBoardId` setting. *(No UI.)*
2. **Boards web** — REST endpoints, board management in Members view, board picker on new-discussion. Playwright smoke.
3. **Participant snapshot** — `DiscussionParticipant`, read-time normalizer, render layers read from snapshot. Pure robustness; no user-facing flag. *(Land before phase 4 so joins have somewhere to record.)*
4. **Dynamic member add (engine + CLI)** — `addMemberIds`/`catchUpMode` in `addFollowUpQuestion`, pool relaxation, catch-up modes, `--add-member`/`--catch-up` flags, strict-abort rollback.
5. **Dynamic member add (web)** — follow-up composer "+ Add member" + catch-up selector, `member_joined` WS event.

Each user-visible phase ⇒ a `changeset` (`npx changeset`) per the release pipeline in `CLAUDE.md`.

---

## 6. Open questions for product

1. **Board size vs. per-discussion cap (§1.7):** block, or truncate-with-warning, when a board exceeds `maxMembersPerDiscussion`? (Spec defaults to **block**.)
2. **Default catch-up mode:** `full` (consistent, costly) vs. `summary` (cheap, less anchoring)? (Spec defaults to **full**; revisit if token cost bites on long discussions.)
3. **Empty board on member delete:** keep-and-flag vs. auto-delete? (Spec: **keep and flag**.)
4. **Create-new-member-inside-follow-up:** spec routes this through `members add` first. Do we want an inline "create + add" in the web composer for a smoother flow? (Defer; revisit after phase 5.)
5. **Active board scope:** per-workspace (spec) vs. global pointer like `~/.aabcli/.active`? (Spec: **per-workspace**, via settings.)

---

## Appendix A — File-touch map

| Concern | Files |
|---|---|
| Board type + participant snapshot | `src/storage/types.ts` |
| Board slug/snapshot/prune, normalizer | `src/storage/fs-storage-service.ts`, `src/storage/io.ts` |
| Board members resolution | new `src/core/boards/resolve-board-members.ts` |
| Board CLI | new `src/commands/board.ts`, register in `src/cli.ts` |
| `discuss start --board`, follow-up `--add-member/--catch-up` | `src/commands/discuss.ts` |
| Engine: add-member + catch-up | `src/core/discussion/conversation-flow.ts`, `build-user-message.ts` |
| `init` seeds Full Board | `src/commands/init.ts` |
| Settings `activeBoardId` | `src/storage/types.ts` (DEFAULT_SETTINGS), `src/commands/settings.ts` |
| Boards REST + follow-up body + `member_joined` WS | `src/gui/server.ts` |
| Boards UI + follow-up composer add-member | `gui/app.js`, `gui/*.css` |
| Render from snapshot | `src/ui/render-discussion.ts`, `src/ui/render-discussion-markdown.ts`, `gui/app.js` |
| Docs | `docs/development/CHECKLIST.md`, `CHANGELOG.md`, `README.md` |

## Appendix B — Sources

- **sage-council** (authoritative behavior reference): `src/types/advisory.ts` (`Board`, `Discussion`), `supabase/migrations/*_boards.sql` (`member_ids TEXT[]`, no join table), `src/lib/storage/supabase-storage-service.ts` (board CRUD), `src/components/board/{CreateBoardDialog,BoardGroupCard}.tsx`, `src/components/discussion/MemberSelectionDialog.tsx` (Boards/Individual tabs), `src/lib/validation/boundary-validation.ts` (1–100 name, 0–500 desc, ≤5 members, dedup).
- **External patterns:** CrewAI crews & Dust spaces (members referenced, not owned); OpenAI Custom-GPTs-vs-Projects (avoid non-composable surfaces); AutoGen/AG2 `candidate_func` + Slack/Discord mention-vs-add & "include history?" (subset targeting & mid-thread join); kubectx/kubectl contexts (active-board idiom: `use`, `use -`, `current`, visible indicator); `@inquirer/checkbox`/fzf (multi-select); arXiv 2503.13657 "Why Do Multi-Agent LLM Systems Fail?" (FM-1.4 context loss, FM-2.1 restarts, FM-2.4/2.5 info-withholding → keep orchestration global, make catch-up explicit); Drupal/EF Core dangling-reference guidance (prune references in app code, snapshot history, no DB-level cascade).
