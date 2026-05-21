# Smoke testing — running live CLI smokes for `aab`

Authoritative reference for **live-smoking** the `aab` CLI: how to run the real binary against real Claude calls without polluting the project source tree. Read this before adding a new CLI verb, touching the `runClaude` spawn path, or claiming "Phase X works."

Companion to `docs/development/PLAYWRIGHT_MCP.md` (the UI side of the same testing discipline). Both files exist because **typecheck + build is not verification** — two stacked Windows runner bugs (silent `cmd.exe` newline truncation; Haiku ellipsis-cutoff prompt fragility) shipped through typecheck-only verification in May 2026 and were only caught by a live smoke. The fix flowed back into `src/llm/claude-code-runner.ts` and `src/core/discussion/summarize.ts` — see commit `80f07ab`.

---

## 1. TL;DR — the 60-second version

- **Test substrate**: an external folder at `C:\Users\julia\Downloads\kode\ai-advisoryboardclitestfolder` (Windows) or `~/aab-smoke/` (macOS/Linux). **Never the project folder**.
- **Why external**: `aab init` writes `.claude/agents/<slug>.md` into `cwd`. Running smoke in the project root pollutes the source tree with workspace files and (more dangerously) re-triggers project-mount detection in `resolveWorkspace()` so the next CLI invocation finds the smoke workspace instead of yours.
- **Invocation pattern**: from the test folder, run `node <projectRoot>\dist\bin\aab.js <args>`. No `npm link` needed. The binary's working directory is the test folder; the workspace data lands at `~/.aabcli/<slug>/`.
- **Required flags**: `aab init --non-interactive --home --name <slug>` so init doesn't prompt for the (false-positive) "claude CLI not found" question. Use a date-stamped slug (`smoke-2026-05-19`) so each smoke is isolated and disposable.
- **Run the smoke after every meaningful change** to `src/`. Especially anything touching `src/llm/claude-code-runner.ts`, `src/core/discussion/`, `src/agents/emit-member-agent.ts`, or `src/storage/paths.ts`. Memory note: [[feedback-always-smoke-and-mcp]].
- **Cost**: ~3 Claude calls per `discuss start` (1 per member + 1 orchestrator). ~1 Haiku call per `discuss summarize`. ~0.05-0.10 USD-equivalent in subscription credit per full smoke flow.

---

## 2. Why a separate test folder

Three concrete reasons:

1. **`.claude/agents/*.md` pollution.** `aab init` writes one `.claude/agents/<slug>.md` per starter member (Elon, Julian, Alexandra). If you smoke from the project root, those land alongside the source tree. They are agent files for the *starter members*, not for the project itself — committing them by accident would confuse anyone running Claude Code in this repo (it would expose three personas in `/agents`).

2. **Project-mount detection.** `resolveWorkspace()` in `src/storage/paths.ts:80-83` looks for `./.aabcli/` first. Smoking in the project root means subsequent `aab` invocations *from the project root* find the smoke workspace instead of your dev workspace. Surprises stack up fast.

3. **Workspace mutex collisions.** `proper-lockfile` acquires `<workspace>/.lock` for write commands. If you're debugging the CLI from two shells (one editing source, one smoking) they're both contending for the same lock if they both use the project root.

The test folder solves all three:
- Agent files land in the test folder's `.claude/agents/`, never the source tree.
- Workspace lives at `~/.aabcli/<slug>/` because there's no project mount in the test folder (assuming you don't run `aab init --here`).
- Each smoke gets its own `--name <slug>`, so workspace state is isolated.

**What goes in the test folder**: only `.claude/agents/<slug>.md` files (auto-created by `aab init`) and any artifacts you explicitly write there (markdown exports, debug logs). You do **not** need a `CLAUDE.md`, a `package.json`, or anything else. The CLI never reads from the test folder beyond looking up agent files.

---

## 3. Setup

### One-time, per dev machine

```powershell
# Windows
New-Item -ItemType Directory -Force "C:\Users\<you>\Downloads\kode\ai-advisoryboardclitestfolder" | Out-Null

# macOS / Linux
mkdir -p ~/aab-smoke
```

That's it. The folder can stay empty until the first smoke.

### Per-smoke prep

```powershell
# 1. Build the project (from the project root)
cd C:\Users\<you>\Downloads\kode\ai-advisory-board-cli
npm run build

# 2. Cache the binary path so we don't keep re-typing it
$AAB = "C:\Users\<you>\Downloads\kode\ai-advisory-board-cli\dist\bin\aab.js"

# 3. Switch to the test folder
Set-Location "C:\Users\<you>\Downloads\kode\ai-advisoryboardclitestfolder"

# 4. Bootstrap a fresh workspace
node $AAB init --non-interactive --home --name smoke-2026-05-19
```

Why `--non-interactive --home --name <slug>`:
- `--non-interactive` skips the "claude CLI not found on PATH" prompt. That prompt is a false positive on Windows because `detectClaudeCli()` doesn't yet handle `.cmd` / `.ps1` shims, but `runClaude` does (via `resolveCmdShimToExe`).
- `--home` forces `~/.aabcli/<slug>/` (workspace data isolated under home). Without it, `aab init` may prompt and pick project-mounted, which writes a `.aabcli/` folder right where you are.
- `--name <slug>` makes the workspace independently addressable. Use a date-stamped slug so successive smokes don't collide.

---

## 4. The canonical smoke flow

Runs every Phase 1 verb against a real discussion. ~3-4 minutes wall-clock, ~$0 on a Claude Max subscription, ~$0.10-0.20 in API-equivalent cost.

```powershell
$AAB = "C:\Users\<you>\Downloads\kode\ai-advisory-board-cli\dist\bin\aab.js"
Set-Location "C:\Users\<you>\Downloads\kode\ai-advisoryboardclitestfolder"

# 1. Sanity-check the workspace + claude binary
node $AAB doctor                                      # expect 9/9 green

# 2. Start a discussion (3 members, 1 round, max 4 turns to leave headroom)
#    NOTE: single-quote the prompt — PowerShell expands $foo inside "..."
node $AAB discuss start 'Should we focus on B2B SaaS or consumer apps in 2026?' --max-turns 4

# 3. Capture the id (short prefix works)
$disc = (node $AAB discuss list --json | ConvertFrom-Json).discussions[0].id

# 4. Continue the discussion (orchestrator-gated)
node $AAB discuss continue $disc

# 5. Respond to a HITL gate, if present
# node $AAB discuss respond $disc 'enterprise-first, $50k threshold' --option 1

# 6. Targeted follow-up
node $AAB discuss follow-up $disc 'What is the single biggest execution risk?' --member 'Elon Musk'

# 7. Summarize (one Haiku call)
node $AAB discuss summarize $disc --force

# 8. Export to markdown
node $AAB discuss export $disc --md --out smoke-export.md
Get-Content smoke-export.md | Select-Object -First 50    # eyeball the output

# 9. Archive / unarchive (no LLM)
node $AAB discuss archive $disc
node $AAB discuss list                                # disc is hidden
node $AAB discuss list --archived                     # disc reappears
node $AAB discuss unarchive $disc

# 10. Cleanup the discussion (keep the workspace for the next smoke)
node $AAB discuss delete $disc
```

For **non-Phase-1** smokes, add the relevant verbs (knowledge ingest, members CRUD, actions board, etc.) at the appropriate point. The setup + cleanup bookends stay the same.

---

## 5. Verifying the result

A smoke is "green" when **all** of these hold:

| Signal | What to check | Where it shows |
|---|---|---|
| Spawn works | `aab doctor` shows ✓ for `claude CLI`. Members respond with text, not `spawn EINVAL` | doctor output, member-response stream |
| Multi-line prompts arrive intact | Members reference specifics from the question, not "I don't see the discussion content" | the structured-response cards |
| Orchestrator parses | `orchestrator → continue/conclude (confidence X%)` — **NOT** `Fallback decision (orchestrator unavailable or output unparseable)` | end-of-round footer |
| Summarize parses | `Summary written (N key points, …)` with N ≥ 2 — **NOT** `Summary unavailable: LLM summary unparseable` | `aab discuss summarize` output |
| Export is self-contained | The markdown file opens cleanly, has frontmatter + summary + per-member sections | `Get-Content smoke-export.md` |
| Archive is idempotent | Second `unarchive` of an already-unarchived discussion says "not archived", exit code 0 | repeated invocations |
| `--debug` doesn't crash | `aab --debug discuss start "<q>"` produces the `[claude] spawn` and `[claude] result` debug envelopes | with `--debug` flag |

If any signal fails, **stop and investigate**. The bugs caught by this discipline (commit `80f07ab`) were both silent — exit code 0, fallback paths swallowed the failure, nothing surfaced in typecheck or build.

---

## 6. PowerShell + Bash gotchas

PowerShell is the default Windows shell used by Claude Code's `PowerShell` tool. Bash is also available via the `Bash` tool (MINGW on Windows). Quirks:

### PowerShell — must-know

- **Single-quote the prompt** when it contains `$`: `'Should we ship the $50k pivot?'`. Double-quoted strings expand `$50` as a variable and silently drop the `k`. Symptom: the question text seen by the CLI is `Should we ship the  pivot?`.
- **`2>&1` with native exes wraps stderr in NativeCommandError noise**. Don't redirect a native binary's stderr; the runner already captures it for you. If you must capture: use `*> file.log` instead (writes UTF-16 LE — re-encode with `Get-Content file.log -Encoding Unicode | Set-Content -Encoding UTF8`).
- **`Set-Location` resets after every PowerShell tool call.** Don't chain `Set-Location …; …; …` across calls — every PowerShell invocation starts fresh in the project root. Either cache `$AAB` at the top of every command, or do all your smoke work in one PowerShell call.
- **`&` call operator passes args via Windows CreateProcess argv.** Multi-line strings *via `&`* work fine for plain `.exe` files; they break when the target is a `.cmd` shim. Don't smoke through `.cmd` shims — invoke the underlying `.exe` directly. The runner's `resolveCmdShimToExe` does this automatically for `claude`. For other tools, run them once with `where <tool>` and find the real exe.

### Bash (MINGW on Windows) — must-know

- **`/c/Users/...` and `C:\Users\...` are interchangeable** inside the Bash tool, but `node $AAB` won't tab-complete the way it does in PowerShell. Use absolute paths.
- **`$AAB` set in one Bash call doesn't survive to the next.** Same shell-state-reset rule as PowerShell. Hardcode the path inline.

### Both shells

- **The `discuss list --json` trick is the canonical way to fetch the discussion id**: `$disc = (node $AAB discuss list --json | ConvertFrom-Json).discussions[0].id`. Don't try to parse the human-readable list output — formatting may change.
- **Use the short id (first 8 chars) where possible** — every `aab discuss <verb>` accepts it.

---

## 7. When to run smoke vs when typecheck/build is enough

| Change kind | Action |
|---|---|
| New CLI verb, anywhere | **Full smoke** of that verb against a real discussion |
| Touching `src/llm/claude-code-runner.ts` | **Full smoke** — the spawn path is the load-bearing point of failure |
| Touching `src/core/discussion/*` | **Full smoke** of the affected flow (start / continue / follow-up / summarize) |
| Touching `src/agents/emit-member-agent.ts` | **Full smoke** + verify the regenerated `.claude/agents/<slug>.md` body matches `AAB:GENERATED` marker rules |
| Touching `src/storage/paths.ts` | **Full smoke**, plus confirm `aab workspace list` and `aab doctor` resolve the right root |
| Touching `src/core/parsing/*` | Smoke + a hand-crafted edge case (malformed JSON, fence-wrapped, leading prose) |
| Touching `src/ui/render-discussion*.ts` | Smoke `discuss show` + `discuss export` |
| Touching `gui/` or `src/gui/server.ts` | **Playwright MCP smoke** (separate doc: `docs/development/PLAYWRIGHT_MCP.md`) |
| Refactor that doesn't change behavior | Typecheck + build is enough |
| Pure documentation edit (`docs/development/`, `CLAUDE.md`, `README.md`) | Typecheck + build (or nothing, if no `.ts` changed) |
| Renaming, comment-only edit | Nothing |

If you're unsure, **default to smoking**. Tokens are cheap; shipping a silently broken CLI is expensive (see commit `80f07ab` for the exemplar — would have shipped past typecheck-only verification, then silently broken every multi-line LLM call on Node 20.12+).

---

## 8. Cleanup

### Between smoke runs (keep the workspace, drop the data)

```powershell
# Delete every discussion in the smoke workspace
$ids = (node $AAB discuss list --archived --json | ConvertFrom-Json).discussions.id
foreach ($id in $ids) { node $AAB discuss delete $id }

# Optional: wipe smoke artifacts
Remove-Item smoke-export.md, *.log -ErrorAction SilentlyContinue
```

### Retiring a smoke workspace entirely

```powershell
# Remove the workspace data
Remove-Item ~/.aabcli/smoke-2026-05-19 -Recurse -Force

# Remove the test folder contents (keeps the folder itself)
Remove-Item C:\Users\<you>\Downloads\kode\ai-advisoryboardclitestfolder\* -Recurse -Force
```

### What to keep between smokes

- `<test-folder>/.claude/agents/<slug>.md` (3 files, ~19 KB total) — cheap to regenerate but slow to re-init each time. Keep them. Subsequent `aab init` runs preserve them (idempotent — checks the `# AAB:GENERATED` marker before overwriting).

### What to never commit

- The test folder's contents — it's outside the project repo, so this is automatic for Windows. On other OSes, smoke under `~/aab-smoke/` (well outside the repo).
- Any debug logs that contain real Claude advisory-board responses — those can carry sensitive content from past smokes.

---

## 9. Reference smokes (the regressions this discipline caught)

These are the bugs that **would have shipped silently without a live smoke**. Add new entries here when a future smoke catches one.

### 2026-05-19 — Windows `.cmd` shim spawn breaks every multi-line LLM call

- **Symptom**: every LLM call returned prose "I don't see the discussion content" / "the transcript appears to be incomplete". Looked like Haiku unreliability.
- **Root cause**: Node 20.12+ / 24 rejects direct spawn of `.cmd` files (CVE-2024-27980). The intuitive cmd.exe wrapper silently truncates every argument at the first `\n` even with `windowsVerbatimArguments: true`. The orchestrator/summarize prompts arrived at Haiku with only `[ROUND: 1 | INITIAL]` — the body was dropped.
- **Why typecheck missed it**: typecheck doesn't spawn a binary.
- **Why build missed it**: build doesn't either.
- **Why the previous Phase 1 verification missed it**: that verification was on an older Node where direct `.cmd` spawn still worked.
- **Fix**: `src/llm/claude-code-runner.ts:resolveCmdShimToExe()` — parse the npm shim, extract the underlying `.exe`, spawn that directly.
- **Reference commit**: `80f07ab`. Memory: [[feedback-windows-npm-shims]].

### 2026-05-19 — Haiku reads bare `…` truncation marker as stream corruption

- **Symptom**: summarize prompt's 1200-char per-response cap + `…` marker → Haiku replied "transcript appears to be incomplete — it cuts off mid-sentence with 'That sa…'" and refused to emit JSON.
- **Root cause**: from Haiku's perspective, `…` at the end of arbitrary text is indistinguishable from a streaming-pipeline corruption. The conservative response is to ask for more data, not to comply with a JSON contract.
- **Why typecheck/build missed it**: same as above — no LLM in the verification loop.
- **Fix**: `src/core/discussion/summarize.ts:PER_RESPONSE_CAP = 6000` + explicit `[…truncated for summarization — full response in the raw discussion file…]` marker.
- **Reference commit**: `80f07ab`. Memory: [[feedback-haiku-truncation-ellipsis]].

---

## 10. Cross-references

- `docs/development/PLAYWRIGHT_MCP.md` — the UI-side equivalent of this doc. Every meaningful change to `gui/` or `src/gui/server.ts` gets a Playwright MCP smoke before being declared done.
- `docs/development/CHECKLIST.md` — live status. The "What's running right now" section reports verified-via-smoke flows.
- `CLAUDE.md` (project root) — the high-level "how to work in this repo" doc points at this file.
- Memory notes:
  - [[feedback-always-smoke-and-mcp]] — the general rule (CLI → smoke; UI → MCP)
  - [[feedback-windows-npm-shims]] — the spawn trap and how to avoid it
  - [[feedback-haiku-truncation-ellipsis]] — the prompt-truncation trap and how to avoid it
