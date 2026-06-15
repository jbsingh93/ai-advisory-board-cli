---
"ai-advisory-board": minor
---

Whole-machine recon — the PC scan now finds MCP servers / connectors and skills wherever they actually live, instead of the handful of fixed paths it checked before (which under-counted badly: 1 MCP and 0 skills on a machine with ~24 servers and hundreds of skills). See `docs/development/RECON_WHOLE_MACHINE_SCAN.md`.

- **MCP / connectors** are now read from every config store on the box: the three `.mcp.json` scopes, Claude Code's real `~/.claude.json` (top-level + per-project `mcpServers` + the `claudeAiMcpEverConnected` remote connectors), Claude Desktop, Cursor, Windsurf, and VS Code. Transport is inferred from `type` *or* `transport` (the old code read only `transport`, so it was never populated for `{"type":"http",...}` servers).
- **Skills** are discovered by a bounded recursive walk of the whole `~/.claude/plugins` tree plus every `installPath` in `installed_plugins.json` — the old one-level walk found zero plugin skills.
- **Known-project sweep** reads the folders the user has opened in Claude Code (from `~/.claude.json`) and checks each for `.mcp.json` / `.cursor` / `.vscode` / `.claude/skills` — covers "any folder you work in" with no disk crawl.
- **Optional full-disk crawl** (`scan({ deepScan: true })`, default on in the Planner recon) walks every fixed drive for stray configs/skills. Read-only, never throws, time-bounded (default 12s) with a dirent budget, prunes noise dirs, and surfaces an info warning if it truncates.
- `aab doctor`'s PC-scan probe now reports MCP-server and skill counts.
