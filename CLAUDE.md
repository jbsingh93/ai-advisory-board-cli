# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`aabclitool` (binary: `aab`) — a Node 20+ TypeScript **CLI port + improvement** of the React/Gemini/Supabase app at `C:\Users\julia\Downloads\kode\sage-council`. Same product (multi-agent advisory board, sparring, action board, decision coach, principle explorer), different surface: terminal + local web dashboard instead of a hosted SPA, Claude sub-agents instead of Gemini, Claude Code skills instead of Supabase edge functions, local filesystem instead of Postgres.

Convenes a panel of Claude sub-agents on a business question. Each "board member" is a real Claude Code sub-agent file at `.claude/agents/<slug>.md`. The CLI does **not** use the Anthropic SDK; it shells out to the local `claude` binary (`src/llm/claude-code-runner.ts`), so the user's Claude Max/Pro subscription is the LLM — no API key, no extra cost.

### Relationship to sage-council

When porting or adding features, treat the sage-council source as the authoritative reference for behavior — many files here are direct ports (e.g. `parsing/safe-json.ts`, `conversation-flow.ts`, `orchestrator.ts`, the zod schemas). Check the sibling repo before reinventing logic:

- `../sage-council/src/lib/conversation-flow.ts` — original `ConversationFlowManager`
- `../sage-council/src/lib/orchestrator.ts` — original orchestrator (consensus/repetition/quality math)
- `../sage-council/src/lib/parsing/` — schema + tolerant-JSON contracts to keep parity with
- `../sage-council/src/lib/prompts/default-prompts.ts` — advisory + principles prompt templates
- `../sage-council/src/lib/agents/` — the multi-agent action-solver pipeline we'll port in later phases

**Deliberate deltas from sage-council** (don't "fix" these back to match the original):
- Storage: single `FsStorageService` interface, no Supabase / no demo-localStorage split.
- LLM: one model path (Claude via `claude` CLI), not Gemini + storageType-conditional API key resolution.
- Action board: scoped down per `PLAN/PLAN.md` Part 6 — kanban + skill-only solve (no full ZIP packager, no plan-edit service in v1).
- Auth: none. Local-only by design.

Source-of-truth design docs live in `PLAN/PLAN.md` (long-form, includes the sage-council source-tree map and the port plan) and `PLAN/CHECKLIST.md` (live status). `README.md` is the user-facing surface. `CHANGELOG.md` is the dated narrative log.

## Common commands

```bash
npm run dev              # tsx bin/aab.ts — run CLI directly from source
npm run build            # tsup → dist/bin/aab.js (ESM, shebang banner)
npm run typecheck        # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm run test             # vitest watch
npm run test:run         # vitest run (one-shot)
npm run lint             # eslint .

# Local dogfood:
npm link                 # exposes `aab` globally for testing
aab doctor               # 9-check diagnostic (claude CLI, workspace, agents…)
aab --debug discuss start "<q>"   # see spawn args + stderr
```

Note: there are currently no test files (`*.test.ts` / `*.spec.ts`) checked in — `npm test` succeeds vacuously. Likewise no `eslint.config.*` is present; `npm run lint` requires one before it does anything useful. Don't claim "tests pass" or "lint clean" as verification.

## Verification — live smoke is mandatory

Typecheck + build is necessary but **not sufficient**. After every meaningful change to `src/`, run a live smoke against the real `aab` binary against real Claude calls. See **`PLAN/SMOKE_TESTING.md`** (authoritative reference, mirrors `PLAN/PLAYWRIGHT_MCP.md` for the UI side).

The non-negotiable rules:
- **CLI changes** → run a live CLI smoke from the external test folder at `C:\Users\julia\Downloads\kode\ai-advisoryboardclitestfolder` (Windows) / `~/aab-smoke/` (macOS+Linux). **Never smoke from the project root** — it pollutes the source tree with `.claude/agents/<slug>.md` files, triggers project-mount detection that hijacks the next invocation, and contends for the workspace mutex with your dev workspace.
- **UI changes** (anything in `gui/` or `src/gui/server.ts`) → run a Playwright MCP smoke (`PLAN/PLAYWRIGHT_MCP.md`).
- **Invocation**: `cd <test-folder>; node <projectRoot>/dist/bin/aab.js <args>`. Bootstrap once with `aab init --non-interactive --home --name smoke-<yyyy-mm-dd>` so the workspace lands under `~/.aabcli/<slug>/` (isolated, disposable). The test folder gets only `.claude/agents/*.md` written to it.
- **PowerShell prompt quoting**: single-quote prompts that contain `$` (e.g. `'Should we ship the $50k pivot?'`). Double quotes expand `$50` as a variable.
- **The reference smoke catches**: silent `cmd.exe` newline truncation on `.cmd` shims (commit `80f07ab`), Haiku ellipsis-cutoff prompt fragility, fallback-decision orchestrator failures, malformed JSON contracts. Typecheck catches none of these.

If you're unsure whether your change needs a smoke: smoke it. Tokens are cheap; shipping a silently broken CLI is expensive.

## Architecture — the big picture

### Execution model: shell out, not SDK

Every model call goes through `runClaude()` in `src/llm/claude-code-runner.ts`, which `spawn`s `claude` with `-p "<prompt>" --output-format json|stream-json` (+ `--agent <slug>` for member calls, omitted for orchestrator). Two consequences:

- **`--dangerously-skip-permissions` is the default** and is safe here because each `.claude/agents/<slug>.md` restricts `tools:` to a read/web allowlist (`WebSearch, WebFetch, Read, Grep, Glob`). The sub-agent literally cannot `Edit`/`Write`/`Bash`.
- **Windows shim resolution**: npm-installed `claude` lands as `.cmd`/`.ps1` shims on PATH. **The `.cmd` itself is unspawnable on Node 20.12+ / 22 / 24** — direct spawn throws EINVAL (CVE-2024-27980 hardening), and routing through `cmd.exe /c` silently truncates multi-line argv at the first newline (cmd.exe treats `\n` as a command separator even with `windowsVerbatimArguments: true`). Symptom is that an LLM "doesn't see the prompt body" — the body never reached it. `resolveCmdShimToExe()` parses the shim, extracts the underlying `.exe` path (typically `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`), and we spawn that directly via argv — binary-safe and multi-line-safe. `wrapForCmd()` still exists as a fallback for shims we can't parse, but anything going through that path will lose multi-line content. See memory note [[feedback-windows-npm-shims]].

When adding a new LLM call, prefer reusing `runClaude` over re-spawning manually — it handles streaming events, AbortSignal, timeouts, and stdin-close (the last avoids a 3s "no stdin" warning).

### Discussion flow (the hot path)

`src/core/discussion/conversation-flow.ts` exposes the three top-level operations every UI surface (terminal + web) drives through:

- `startDiscussion` — round 1: load context → one `runMember` per active member → one `analyzeConversation` (orchestrator) → persist.
- `continueDiscussion` — **runs a pre-round clarification gate** (one orchestrator call) *before* spawning any members. If the gate says `request_user_input`, persists `pendingUserRequest` and returns `{ gated: true }` without burning member tokens. Then generates round N+1 and re-orchestrates.
- `respondToUserRequest` — appends the user's reply to `userResponses`, clears `pendingUserRequest`, then calls `continueDiscussion` with `skipPreRoundGate: true` (the orchestrator just asked for this exact answer — re-gating would loop).
- `addFollowUpQuestion` — targeted follow-up (`all` / `specific` / `subset`). **Strict**: if any targeted member fails, the whole round aborts cleanly (no partial commit). This differs from `continueDiscussion`, which tolerates per-member failure and only aborts if *all* members fail.

Two non-obvious invariants:
- When a discussion concludes via `maxTurns`, leftover `pendingUserRequest` is explicitly cleared so the UI never shows "done" alongside an unanswerable HITL prompt.
- Rounds keep a separate in-memory `round` object that's only pushed onto `discussion.rounds` after all member responses succeed (for strict follow-ups) — don't move that earlier or partial failures will persist half-rounds.

### Members are realized two ways simultaneously

1. **A row in `members.json`** (`AdvisoryBoardMember`).
2. **A file at `.claude/agents/<slug>.md`** with frontmatter (`name, description, tools, model: inherit, permissionMode, maxTurns, color`) and a `# AAB:GENERATED` marker on line 1 of the body.

`isAabGenerated()` in `src/agents/emit-member-agent.ts` checks the marker — **if a user has hand-edited the file and removed the marker, future `aab` runs will not overwrite it**. Preserve this contract on any agent-file emitter changes.

### Storage layer

Single `StorageService` interface (`src/storage/types.ts`), one implementation: `FsStorageService` (filesystem-backed). All writes are atomic (`.tmp` + rename via `src/storage/io.ts`). Settings/members/principles snapshot the prior version into `.snapshots/` before overwrite. Token usage is JSONL-appended (`<workspace>/token-usage/YYYY-MM-DD.jsonl`). Per-workspace mutex via `proper-lockfile` — `openContext()` in `src/commands/_context.ts` acquires it; pass `{ lock: false }` for read-only commands like `doctor`.

### Workspace resolution

`resolveWorkspace()` in `src/storage/paths.ts` picks in this order:
1. `--workspace` flag
2. `AAB_WORKSPACE` env
3. `./.aabcli/` (project-mounted, travels with the repo)
4. Active pointer at `~/.aabcli/.active`
5. Slug of `cwd` basename under `~/.aabcli/`

Don't add a new resolver tier without updating this order — UI server and CLI both depend on it.

### Web UI

`src/gui/server.ts` — Express + `ws` WebSocket server, default port 3737. REST endpoints mirror the CLI verbs (`/api/discussions`, `…/continue`, `…/respond`, `…/follow-up`). WebSocket events on `/ws` stream live progress (`member_thinking`, `member_response`, `orchestrator_decision`, `discussion_gated`, `discussion_completed`). Static frontend lives at `gui/` in the package root (vanilla JS, no build step). Both surfaces drive the **same** `conversation-flow.ts` engine — don't fork business logic into the server.

### Strict JSON contract

Every member response and orchestrator decision is validated against a zod schema in `src/core/parsing/llm-response-schemas.ts`. The parser (`src/core/parsing/safe-json.ts`) tries 5 strategies in order: raw, fence-stripped, balanced-brace, regex-object, regex-array — then validates. On schema failure for member responses, `run-member.ts` falls back to using the raw text as `response` and logs a warning (non-fatal). Orchestrator failures fall back to a synthesized `continue` decision so a flaky orchestrator call doesn't kill a discussion.

### Errors and exit codes

`src/core/errors.ts` defines a typed hierarchy mapped to exit codes:

| Code | Class           | When                                    |
|------|-----------------|-----------------------------------------|
| 1    | `UserError`     | bad input, missing prerequisite         |
| 2    | `ModelError`    | claude CLI returned an error            |
| 3    | `NetworkError`  | timeout / abort / ETIMEDOUT             |
| 4    | `ContractError` | JSON/schema violation we can't recover  |
| 5    | `FsError`       | filesystem/lock failure                 |
| 6    | `CancelledError`| SIGINT (Ctrl+C)                         |
| 7    | `BudgetError`   | `--max-budget-usd` exceeded             |

Throw the right subclass — `src/cli.ts:handleError` formats them with `✗` + optional `hint`. A bare `Error` falls through to exit 1 with no hint, which is fine for genuinely unexpected failures but wrong for user-facing problems.

## Conventions worth knowing before you change things

- **Module system**: ESM (`"type": "module"`). Imports use `.js` extensions even from `.ts` files (e.g., `from './foo.js'`) because TypeScript's NodeNext resolution requires it. Don't strip the `.js`.
- **No re-exports through barrels** — files import from their own concrete paths. Keep it that way; the dependency graph is part of the design.
- **The orchestrator is a one-shot `claude -p` with no `--agent`** (no persona), `allowedTools: []`, `maxTurns: 1`, defaulting to the `fastModel` (`haiku`). Member calls use the `primaryModel` (`sonnet`). Don't conflate.
- **Token usage is logged via `fireTokenUsage`** in `run-member.ts` — fire-and-forget (`.catch(noop)`) so storage hiccups never break a discussion.
- **`shortId`** in `src/ui/render-discussion.ts` is what the CLI accepts in place of the full UUID — when adding a new `discuss` subcommand, resolve `idOrShort` the same way existing commands do.

## When you don't know which file to touch

- Adding a CLI subcommand → `src/commands/<feature>.ts`, then register in `src/cli.ts`.
- Changing what the LLM is asked → prompt builders in `src/core/discussion/build-user-message.ts` (members) or `orchestrator.ts` (gate / post-round).
- Changing a contract → update the zod schema in `src/core/parsing/llm-response-schemas.ts` AND the corresponding domain type in `src/storage/types.ts`.
- Web UI surface → `src/gui/server.ts` for routes/WS, `gui/app.js` for the frontend.
