# Whole-machine recon — MCP / connector / skill discovery

**Status:** ✅ shipped 2026-06-15
**Owner file:** `src/core/skill/recon/pc-scan.ts`
**Related:** `SKILL_CREATOR.md` §6.2 (PC scan spec), `CHECKLIST.md` Phase 5.2, `orchestrator.ts`, `src/commands/doctor.ts`

This document is the authoritative reference for **how `aab` inventories the user's
machine** for MCP servers / remote connectors, Claude Code skills, CLI tools,
desktop apps, browser extensions, and integration env vars. It exists because the
original scan badly under-counted (found 1 MCP and 0 skills on a machine with
~24 MCP servers and hundreds of skills) and was rewritten to cover every config
store on the box plus an optional full-disk crawl.

---

## 1. Why the original scan under-counted

The pre-2026-06-15 scanner (`scanMcpServers` + `scanExistingSkills`) looked in a
tiny, hard-coded set of locations and missed the places these things actually live:

### MCP servers — old behaviour
Read only three files:
- `{projectRoot}/.mcp.json`
- `~/.claude/.mcp.json`
- `~/.mcp.json`

Three problems:
1. **The real Claude Code store is `~/.claude.json`** — never opened. MCP servers
   live there under top-level `mcpServers` **and** per-project under
   `projects["<path>"].mcpServers` (one entry per folder the user has opened —
   44 projects on the reference machine).
2. **claude.ai remote connectors** (Canva, Context7, Figma, Gmail, Slack, the
   ToDo app, n8n, …) are OAuth connectors tracked in
   `~/.claude.json` → `claudeAiMcpEverConnected` (an array of display-name
   strings) and authed under `~/.mcp-auth/`. They are **not files** — no
   `.mcp.json` anywhere references them.
3. **Other MCP-aware clients were ignored** — Claude Desktop, Cursor, Windsurf,
   VS Code each keep their own config.

Plus a latent bug: the parser inferred transport from `cfg.transport`, but the
real field is `cfg.type` (e.g. `{"type":"http","url":...}`), so transport was
*never* populated even for the one server it did find.

### Skills — old behaviour
Walked `~/.claude/skills/<name>/SKILL.md` (fine) and **one level** of
`~/.claude/plugins/<plugin>/skills/<name>/SKILL.md`. But installed plugin skills
are 3–4 levels deeper:
```
~/.claude/plugins/marketplaces/<mp>/plugins/<plugin>/skills/<name>/SKILL.md
~/.claude/plugins/marketplaces/<mp>/external_plugins/<plugin>/skills/<name>/SKILL.md
~/.claude/plugins/cache/<mp>/<plugin>/<version>/skills/<name>/SKILL.md
```
The one-level walk matched none of these → 0 plugin skills.

Separately, `aab doctor`'s `quickPcScanProbe()` never counted MCP or skills at
all (only CLI tools + env vars), so the diagnostic couldn't surface the gap.

---

## 2. The fix — read every config store, then optionally crawl the disk

The scan now runs in three layers, cheapest first. Layers 1–2 are always on and
fast; layer 3 is opt-in (`deepScan`) and time-bounded.

### Layer 1 — known config stores (always on, ~milliseconds)

**MCP** (`collectMcpServers`) reads, in dedup order (first declaration of a name wins):

| Source tag       | Location(s) |
|------------------|-------------|
| `project`        | `{projectRoot}/.mcp.json` |
| `user`           | `~/.claude/.mcp.json`, `~/.claude.json` → `mcpServers` |
| `global`         | `~/.mcp.json` |
| `project`        | `~/.claude.json` → every `projects["<path>"].mcpServers` (configPath = the project path) |
| `claude.ai`      | `~/.claude.json` → `claudeAiMcpEverConnected[]` (remote OAuth connectors) |
| `claude-desktop` | `%APPDATA%\Claude\claude_desktop_config.json` (win) / `~/Library/Application Support/Claude/...` (mac) / `~/.config/Claude/...` (linux) |
| `cursor`         | `~/.cursor/mcp.json`, `{projectRoot}/.cursor/mcp.json` |
| `windsurf`       | `~/.codeium/windsurf/mcp_config.json` |
| `vscode`         | `<Code User dir>/mcp.json` (top-level `servers` key), `{projectRoot}/.vscode/mcp.json` |

Transport inference (`inferTransport`) now reads `type` **or** `transport`, and
falls back to `url ⇒ http`/`sse` and `command ⇒ stdio`. The `url` is recorded for
remote servers so the Planner can reason about reach.

**Skills** (`collectExistingSkills`):
- `{projectRoot}/.claude/skills` (project), `~/.claude/skills` (user) — bounded walk, depth 2.
- The **entire** `~/.claude/plugins` tree (plugin), bounded walk depth 8 — catches
  `marketplaces/*/{plugins,external_plugins}/*/skills/*` etc.
- Every `installPath` from `~/.claude/plugins/installed_plugins.json` (authoritative
  install manifest), bounded walk depth 4 — catches skills under `cache/` (which the
  generic tree walk prunes by name for speed).

### Layer 2 — known-project sweep (always on, fast)

`sweepKnownProjects` enumerates the project paths already listed in
`~/.claude.json` → `projects` (the folders the user has actually opened in Claude
Code) and, for each that still exists on disk, checks `.mcp.json`,
`.cursor/mcp.json`, `.vscode/mcp.json`, and `.claude/skills/`. This is the single
biggest win — it covers "any folder" the user works in **without** a disk crawl.
Capped at 300 projects.

### Layer 3 — full-disk crawl (opt-in via `deepScan`, time-bounded)

`deepScanDisk` walks the drive roots returned by `diskRoots()`:
- **Windows:** every existing fixed drive `C:\` … `Z:\`.
- **macOS/Linux:** `~`, `/Applications`, `/opt`, `/usr/local`, `/srv` (deliberately
  **not** `/`, to avoid `/proc`, `/sys`, network mounts).

It looks for stray `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
`claude_desktop_config.json`, and `SKILL.md` files outside the known locations
(tagged `source: 'disk'` / `scope: 'disk'`).

The walk (`walkDir`) is iterative (stack-based, no recursion limit), read-only,
never throws, and stops on **either** a wall-clock deadline (`diskBudgetMs`,
default 12 s) **or** an entry budget (3 M dirents). It prunes noise dirs
(`PRUNE_DIR_NAMES`: `node_modules`, `.git`, dep caches, `$RECYCLE.BIN`, `Windows`,
`winsxs`, temp, `dist`/`build`/`out`, OS pseudo-dirs, …) and skips unknown
dotfolders past depth 2 — but **always descends** into the dotfolders that hold
configs (`DESCEND_DOTDIRS`: `.claude`, `.cursor`, `.vscode`, `.config`,
`.codeium`). Symlinked dirs are not followed (no loops). If the crawl stops early
it pushes an **info** warning (`phase: 'deep-scan'`) — per the "no silent caps"
rule, truncation is always surfaced, never hidden.

---

## 3. Caps, dedup, ordering

- **MCP** dedup is by server **name** (global, first-wins) → distinct capabilities,
  not per-folder repeats. Capped at `MCP_CAP = 500`.
- **Skills** dedup is by absolute **dir path** (lower-cased) → same-named skills in
  different scopes/folders are kept (they are genuinely different). Capped at
  `SKILL_CAP = 500`.
- Both lists are `localeCompare`-sorted before return for stable output.

---

## 4. Public API

```ts
scan(opts?: {
  projectRoot?: string;
  envOverride?: NodeJS.ProcessEnv;
  deepScan?: boolean;          // layer 3 on/off (default off at the scan() level)
  diskBudgetMs?: number;       // default 12_000
  diskRoots?: string[];        // override the crawl roots
}): ReconResult
```

`ReconResult.mcpServers: DetectedMcpServer[]` and `.existingSkills:
DetectedExistingSkill[]` carry the new `source`/`scope` tags + `url`/`configPath`.

```ts
quickPcScanProbe(opts?): {
  ok; platform; cliTools; envVarMatches;
  mcpServers;   // NEW — config-store count (no disk crawl)
  skills;       // NEW — config-store count (no disk crawl)
  error?;
}
```

### Call sites
- **Planner recon** (`orchestrator.ts`): `runRecon` exposes `pcDeepScan`
  (**opt-in, default off** — `const deepScan = opts.pcDeepScan === true`) +
  `pcDiskBudgetMs`. When on, it fires an `onPhaseProgress('pc-scan', 'crawling
  disk…')` heartbeat. The pc-scan done summary always includes the skill count.
- **CLI flag**: `aab actions plan|solve --planner-deep-scan` turns the crawl on
  (threaded `actions.ts → solve-orchestrator.ts → runRecon`). The GUI
  `/api/actions/:id/plan` accepts `plannerDeepScan` in the body. Default off
  everywhere.
- **`aab doctor`**: the "PC scan probe" line now reads
  `… N CLI tool(s), N MCP server(s), N skill(s), N env var(s) flagged`.

> **Caveat — why opt-in, not default-on:** `pc-scan.ts` is intentionally
> synchronous (injected `fs`/`child_process`, no async). With `deepScan` on,
> `scan()` blocks for up to `diskBudgetMs`. Defaulting it on froze every
> plan/solve for ~12 s **and** starved the vitest worker's RPC heartbeat in CI
> (`Error: [vitest-worker]: Timeout calling "onTaskUpdate"` — solve-orchestrator
> tests tripled 26 s→63 s on Linux/Windows runners; macOS, being faster, still
> passed, which is the tell-tale of a load/timing issue). Layers 1–2 are already
> comprehensive (20 MCP / 29 skills on the reference machine with **no** crawl),
> so the crawl is reserved for the explicit `--planner-deep-scan` opt-in.

---

## 5. Read-only invariant (unchanged)

Everything added here is still **read-only**: `existsSync` / `readFileSync` /
`readdirSync` / bounded `execFileSync --version`. No writes, no network, no
registry mutation. The CI-enforced `no-side-effects-in-recon` lint rule continues
to hold. The deep crawl only *reads* directory entries and parses JSON it finds.

---

## 6. Verified result (reference machine, 2026-06-15)

Run via `tsx` against the live machine that reported "1 MCP, 0 skills":

```
quickPcScanProbe (config stores only): { mcpServers: 20, skills: 29, cliTools: 11, … }

full scan deepScan=true (~13.7s, hit 12s budget → info warning):
  MCP servers: 24
    cursor:        @21st-dev/magic, brave-search, context7, CopilotKit MCP, github, memory, stripe, supabase
    claude.ai:     AG-UI + Pyndantic, Context7, Facebook Ads, Gmail, Google Calendar, Google Drive, Julian ToDo App, n8n-mcp, Slack
    claude-desktop: Context7
    project:       n8n-mcp (http)
    windsurf:      playwright
    disk:          discord, fakechat, imessage, telegram
  Skills: 500 (cap) — project / user / plugin / disk scopes all populated
```

Before: **1 MCP, 0 skills.** After: **24 MCP servers across 6 source kinds; skills
across all four scopes.** The `type`-vs-`transport` bug is fixed (transports now
populate).

---

## 7. Extending the scan

- **New MCP client?** Add a `pushMcpFile(<path>, '<source-tag>', seen, out)` line in
  `collectMcpServers` and a new value to `DetectedMcpServer['source']`.
- **New skill location?** Add a `collectSkillDirs(<root>, '<scope>', addSkill, <depth>)`
  call in `collectExistingSkills`.
- **New integration env var?** Add a pattern to `ENV_VAR_ALLOW_PATTERNS`.
- **Crawl too slow / too shallow?** Tune `diskBudgetMs`, the entry budget in
  `deepScanDisk`, `PRUNE_DIR_NAMES`, or `DESCEND_DOTDIRS`.

Whenever you change source tags or scopes, update the `validSources` assertion in
`__tests__/pc-scan.test.ts`.
