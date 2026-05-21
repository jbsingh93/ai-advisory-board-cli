# Contributing to `ai-advisory-board`

Thanks for taking the time to make this project better. This file is short on
purpose. The deeper design context lives in `docs/development/PLAN.md` and the per-area
references it links to.

## Getting set up

```bash
git clone https://github.com/jbsingh93/ai-advisory-board-cli
cd ai-advisory-board-cli
npm install                                # also installs @playwright/mcp + @playwright/test
npx playwright install --with-deps         # browser binaries (~500MB; first time only)
npm run build                              # builds dist/bin/aab.js
npm link                                   # exposes `aab` on your PATH
aab doctor                                 # 9+ checks — should all be ✓
```

If `aab doctor` complains about `Playwright MCP install` or `Playwright browsers`, follow
the hint in the failing row (`npm install` or `npx playwright install`).

## Test gates

There are **two** verification surfaces. Run the relevant one (or both) before
declaring a change done — neither is optional.

### 1. CLI changes — live smoke from the external test folder

Anything that touches the CLI (the bulk of `src/`) must be exercised against the
real `aab` binary, in a folder **outside the repo**, with real Claude calls.
The exact discipline lives in **`docs/development/SMOKE_TESTING.md`** — read it first.

- External test folder (Windows): `C:\Users\<you>\Downloads\kode\ai-advisoryboardclitestfolder`
- External test folder (macOS/Linux): `~/aab-smoke/`
- **Never smoke from the repo root.** It pollutes the source tree with
  `.claude/agents/<slug>.md` files and triggers project-mount detection that
  hijacks the next invocation.
- Bootstrap once per machine: `aab init --non-interactive --home --name smoke-<yyyy-mm-dd>`.

What a live smoke catches that typecheck + unit tests cannot:
- Windows `.cmd` shim newline-truncation (commit `80f07ab`).
- Haiku ellipsis-cutoff prompt fragility.
- Fallback-decision orchestrator failures.
- Malformed JSON contracts where the parser silently degrades.

### 2. UI changes — Playwright MCP smoke

Anything in `gui/` or `src/gui/server.ts` must be exercised via the Microsoft
Playwright MCP server. The complete reference is **`docs/development/PLAYWRIGHT_MCP.md`** —
read it first; the locator policy (`data-testid` → role+name → never CSS) and
prompt patterns are non-negotiable.

- The MCP server is project-scoped via `.mcp.json` at repo root. Type `/mcp`
  inside Claude Code to confirm `playwright` is connected.
- Use the patterns in `PLAYWRIGHT_MCP.md` §7 (exploratory smoke, regression repro,
  spec generation, a11y audit). Don't ad-lib.
- `mcp__playwright__browser_run_code_unsafe` is RCE-equivalent and is
  **denied** in `.claude/settings.json`. Don't add an `allow` for it.
- Specs that drive the MCP live under `docs/specs/`; deterministic CI tests
  generated from those specs live under `tests/e2e/` and run via
  `npm run test:e2e`. See **§8** of `PLAYWRIGHT_MCP.md` for the split.

### 3. The basics

```bash
npm run typecheck      # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm run test:run       # vitest run (one-shot)
npm run lint           # eslint . (requires an eslint config — currently a stub)
npm run test:e2e       # Playwright deterministic suite — boots a tempdir
                       # workspace + mock-claude shim; no real tokens consumed
```

## Commit format

- Short, present-tense subject line, ≤ 70 chars.
- One-line body explaining *why* (the *what* is in the diff).
- Co-author tag on assistant-authored commits: `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Reference the CHANGELOG.md entry if the change is user-visible.

## Prompt-hardening guardrails

If you touch anything that builds a Claude prompt (`src/core/discussion/build-user-message.ts`,
`orchestrator.ts`, agent SKILL templates):

- Never use the bare `…` character to mark editorial truncation in body that
  feeds Haiku — Haiku reads it as mid-stream cutoff. Use `[…]` or `(truncated)`.
- Never embed multi-line prompts via `cmd.exe` argv on Windows. Use the
  resolved `.exe` path that `resolveCmdShimToExe()` returns.
- Add a golden test (`tests/golden/`) for any new prompt key. Set
  `AAB_UPDATE_GOLDENS=1` once to commit the expected output, then drop the env
  var for subsequent runs.

## Asking for help

- File a GitHub issue with `aab doctor --json` output attached.
- Use `aab --debug discuss start "<q>"` to see spawn args + stderr from the
  `claude` binary — the most common failure mode is the Windows `.cmd` shim.
