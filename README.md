# AI Advisory Board CLI

Convene a panel of Claude sub-agents on any business question — from your terminal or a local web dashboard. Each board member runs as a real Claude Code sub-agent with its own persona, voice, expertise, and a strict structured-output contract. The orchestrator decides when the discussion should continue, conclude, redirect, or ask **you** a clarifying question.

**No API key. No cloud. No extra cost.** The CLI shells out to your local `claude` binary, so it uses the Claude Max/Pro subscription you already have.

```bash
npm install -g ai-advisory-board
cd path/to/your/project
aab init
aab discuss start "Should we charge usage-based or per-seat for our new B2B tool?"
# or:
aab ui                              # opens a messaging-app dashboard at localhost:3737
```

---

## What you get

- **3 starter board members** seeded into your workspace — Elon Musk (visionary engineer), Julian Bent Singh (AI strategist), Alexandra Chen, CFA (capital allocator). Each one is a real Claude Code sub-agent at `.claude/agents/<slug>.md` you can also invoke directly inside a Claude Code session.
- **8 starter principles** (Ray Dalio inspired) for principle-based decision making.
- **Multi-member discussions** where members read each other's responses and build / challenge / extend them in character.
- **Strict JSON contract** per response — every member returns `response`, `keyPoints[]`, `questionsForOthers[]`, `actionSteps[]`, `confidence`, and optionally `assumptions`, `tradeoffs`, `riskMitigations`, `firstPrinciplesApplied`, `sources[]`.
- **Orchestrator HITL** — when the board needs more info from you to continue, the orchestrator surfaces a numbered-options question.
- **Web dashboard** — `aab ui` starts a localhost messaging-app UI with live typing-dot animations while members are responding, structured response cards, kanban view for action items, read-only browser of members / principles / settings.
- **Token-usage logging** — every `claude` call logs prompt / completion / cache tokens to `<workspace>/token-usage/<date>.jsonl`.

---

## Requirements

- **Node 20+**
- **Claude Code CLI** on PATH — install once: `npm install -g @anthropic-ai/claude-code`
- A **Claude Max / Pro subscription** (or `ANTHROPIC_API_KEY` if you don't have a subscription — Claude Code handles the auth)

That's it. No `.env` file, no separate setup.

---

## Install

```bash
npm install -g ai-advisory-board
```

Or, to install from a local checkout:

```bash
git clone https://github.com/jbsingh93/ai-advisory-board-cli
cd ai-advisory-board-cli
npm install
npm run build
npm link              # exposes `aab` globally
```

Verify:

```bash
aab --version
aab doctor            # 9-check diagnostic
```

---

## First run

```bash
mkdir my-board && cd my-board
aab init
```

`aab init` will:

1. Detect Claude Code on PATH.
2. Ask whether the workspace should live at `~/.aabcli/<slug>/` (shared across projects) or `./.aabcli/` (project-mounted, travels with the repo).
3. Seed 3 starter members + 8 starter principles into the workspace.
4. Write `.claude/agents/<member-slug>.md` for each member with spec-compliant frontmatter (`name`, `description`, `tools: WebSearch, WebFetch, Read, Grep, Glob`, `model: inherit`, `permissionMode: default`, `maxTurns: 5`, `color`).

After init you can immediately use the members both ways:

- From `aab` (terminal or web UI) — they participate in advisory-board discussions.
- From inside Claude Code — say "use the elon-musk subagent and ask him whether we should pivot" and Claude Code will route to the agent file.

---

## Two ways to use it

### Terminal

```bash
aab discuss start "Should the team work on docs or onboarding flow this week?"
aab discuss list
aab discuss show <short-id>                          # pretty-print a saved discussion
aab discuss show <short-id> --round 1                # one round only
aab discuss show <short-id> --json                   # machine-readable (good for piping)
```

You'll see each member responding in real-time with structured output:

```
▸ Round 1

  ● Elon Musk · turn 1
    [response paragraphs]

    key points:
      • [3-5 insights]
    questions for others:
      ? [strategic challenges]
    action steps:
      → [concrete recommendations]
    confidence: 88%

  ● Julian Bent Singh · turn 2
    [building on Elon's points...]

  orchestrator → continue  (confidence 75%)
  reason: [orchestrator's reasoning]
```

If the orchestrator decides the board needs more info from you, it surfaces a `request_user_input` panel with numbered options. Reply with:

```bash
aab discuss respond <id> "Your answer here" --option 1   # --option is optional
aab discuss continue <id>                                 # drive the next round when no input is pending
aab discuss follow-up <id> "But what about X?"            # ask everyone a sharper question
aab discuss follow-up <id> "..." --member "Elon Musk"     # or push back on one specific member
aab discuss follow-up <id> "..." --members "Elon,Alexandra Chen"  # or a subset
```

The pre-round clarification gate runs the orchestrator *before* spawning members for round 2+, so if the board still needs input from you, no tokens are wasted on a round that would just ask the same question again. `follow-up` is strict: if any targeted member fails, the round aborts cleanly so you don't end up with a partial answer.

### Web dashboard

```bash
aab ui
```

Opens `http://127.0.0.1:3737` in your browser. The UI is messaging-app style:

- **Sidebar:** Discussions / Action Board / Members / Principles / Settings
- **Discussions tab:** click `+ New discussion`, type a question, toggle which members participate, click Start
- While Claude responds you see **animated typing-dot bubbles** per member
- When responses land, the typing bubble morphs into the full structured message with key-points / questions / action-steps / confidence-bar
- **Orchestrator decisions** appear as system messages
- **HITL prompts** show as a yellow `⚠ The board is asking you a question` panel with the options

Other tabs are read-only for now:

- **Action Board** — kanban view of action items (manual add / extract / solve coming with later phases)
- **Members** — persona browser
- **Principles** — card view of starter + custom principles
- **Settings** — read-only table of config (use `aab settings set <key> <value>` to edit)

### Run options

```bash
aab discuss start "..." --members "Elon Musk,Alexandra Chen, CFA"   # subset
aab discuss start "..." --max-turns 5                                # override
aab ui --port 4000                                                   # custom port
aab ui --no-open                                                     # don't auto-launch browser
aab --debug discuss start "..."                                      # verbose logs
aab --json discuss list                                              # JSON output
```

---

## Available commands

```
aab init                               Bootstrap workspace + seed starters + write .claude/agents/
aab doctor                             9-check diagnostic
aab settings get [key]                 View settings (JSON or table)
aab settings set <key> <value>         Update one setting (with type coercion + validation)

aab workspace list                     List workspaces under ~/.aabcli/
aab workspace new <id>                 Create + switch
aab workspace switch <id>              Set active pointer
aab workspace delete <id> [--yes]      Move to ~/.aabcli/.trash/

aab discuss start "<question>"         Round 1 — multi-member, structured JSON, orchestrator HITL
  [--members "name1,name2"]            Subset by member name
  [--max-turns N]                      Override settings.maxTurnsPerDiscussion
  [--agents-dir <path>]                Where .claude/agents/ lives (default: cwd)
aab discuss continue <id>              Drive the next round (orchestrator-gated)
aab discuss respond <id> "<answer>"    Answer the orchestrator's pending question
  [--option <i>]                       Pick a 1-based option from the listed choices
aab discuss follow-up <id> "<q>"       Ask a targeted follow-up question
  [--all]                              Default — every original member responds
  [--member <name>]                    Just one member (name, slug, or id)
  [--members <names>]                  Comma-separated subset
aab discuss list                       List saved discussions
aab discuss show <id> [--round N]      Pretty-print
aab discuss delete <id>

aab ui [--port 3737] [--bind 127.0.0.1] [--no-open]
                                       Start the local web dashboard
```

Everything supports `--workspace <id>`, `--json`, `--debug`, `--log-level <lvl>`, `--quiet`.

---

## Where data lives

```
~/.aabcli/<workspace-id>/                      home-scoped workspace (default)
./.aabcli/                                     project-scoped workspace (travels with repo)

  settings.json                                AppSettings
  members.json                                 AdvisoryBoardMember[]
  principles.json                              Principle[]
  business-context.json                        BusinessContext[]
  business-profile.json                        BusinessProfile
  action-items.json                            ActionItem[]
  prompts.json                                 user prompt overrides
  discussions/<discussion-id>.json             one file per discussion
  decision-sessions/<id>.json                  decision-coach sessions
  sparring/<discussion-id>/<session-id>.json   1:1 deep dives
  skill-runs/<action-item-id>/<run-id>.json    skill-generation runs
  token-usage/YYYY-MM-DD.jsonl                 per-day token + cost log
  jobs/<job-id>.json                           in-progress runs
  .snapshots/                                  rolling backups (last 20 per entity)
  .lock                                        per-workspace mutex
  .version                                     storage schema version
```

Atomic writes (`.tmp` + rename), per-workspace lock (proper-lockfile), automatic snapshots before settings/members/principles overwrite.

---

## How members work

Each board member is realized two ways simultaneously:

1. **A row in `members.json`** with `id, name, title, expertise[], persona, voiceGuide?, allowedTools?, isActive`.
2. **A file at `.claude/agents/<slug>.md`** with spec-compliant frontmatter and the persona pre-filled into the body.

When `aab discuss start` runs, the CLI spawns one `claude --agent <slug> -p "<round payload>"` per member, with `--output-format json --dangerously-skip-permissions --allowedTools "WebSearch,WebFetch,Read,Grep,Glob" --model <alias>`. Each member responds in their own isolated Claude Code session, returns a JSON envelope, and we parse out the structured response.

The agent files default to **read/web only tools**, so even with `--dangerously-skip-permissions` a member literally cannot `Edit`, `Write`, or `Bash` — it can only read your repo, search the web, and reason. That's why the dangerous flag is safe in this context.

The same agent files work natively from inside Claude Code itself — say "use the elon-musk subagent" and Claude Code routes to it.

---

## Status

This is a partial, in-progress implementation. The full design is in `docs/development/PLAN.md` (1700+ lines, six parts including two extreme-review addenda). Live progress against deliverables is tracked in `docs/development/CHECKLIST.md`.

**Working today:**

- ✅ `aab init`, `doctor`, `settings`, `workspace`
- ✅ `aab discuss start | continue | respond | follow-up | list | show | delete` — multi-round discussions with structured JSON, orchestrator HITL, pre-round clarification gate, token-usage logging
- ✅ `aab ui` web dashboard with messaging-app chat view, typing-dot animations, **Continue + Follow up buttons + inline HITL reply form** so the whole multi-round flow works in the browser, read-only browsers for Members / Actions / Principles / Settings
- ✅ Filesystem storage with atomic writes, snapshots, per-workspace locks
- ✅ `--dangerously-skip-permissions` so it works from any shell, not just inside a Claude Code session

**Coming next:**

- 🟡 Summary (`summarize`), markdown export (`export`), archive (`archive`/`unarchive`), 1:1 sparring (`spar`)
- ⬜ Members CRUD (`add` / `edit` / `enhance` / `sync-agents`)
- ⬜ Principles wizard + Decision Coach REPL
- ⬜ Action Board Kanban (full CRUD + extract from discussion)
- ⬜ Skill creator — turn one action point into an installed Claude Code skill (the headline feature)
- ⬜ UI editing flows (members / actions / principles / settings)
- ⬜ Token-usage / cost dashboard

---

## Troubleshooting

**`aab` not found after `npm install -g`** → restart your terminal so PATH refreshes.

**`aab init` says "claude CLI not found"** → run `claude --version`. If that fails, install Claude Code: `npm install -g @anthropic-ai/claude-code`.

**Discussion hangs at "asking <Member> (1/3)..."** → make sure you're on the latest build. The CLI now passes `--dangerously-skip-permissions` so cold shells don't block on trust prompts. Run with `aab --debug discuss start ...` to see the exact spawn args + stderr.

**One member fails / partial round** → other members keep going; only an all-failure aborts. Re-run with `--debug` to see what went wrong.

**JSON parse fallback warnings** → harmless. The CLI's tolerant parser tries 5 strategies (raw, fenced, balanced-brace, regex object, regex array) before giving up; the warning means it had to fall back to raw text and continued.

**Want to nuke everything and start over** → `rm -rf ~/.aabcli/<workspace-id>/` (or `./.aabcli/` for project-scoped). Re-run `aab init`.

---

## Architecture

The CLI is structured around a single `StorageService` interface (filesystem-backed) and a `ClaudeCodeRunner` that shells out to `claude`. Discussions flow through `ConversationFlowManager` → `runMember` (one spawn per member) → `analyzeConversation` (one orchestrator spawn) → persistence. The web UI (`src/gui/server.ts`) is an Express + WebSocket server that calls the same engine and broadcasts progress events to a vanilla-JS frontend in `gui/`.

See `docs/development/PLAN.md` for the full architecture, the multi-phase build plan, and the 27-zod-schema contract surface that every LLM call validates against.

---

## License

MIT
