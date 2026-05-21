# Skill Creator — Agentic Skill Planner + orchestrator around Anthropic's `skill-creator` skill

> **Status:** authoritative design spec. Written 2026-05-20.
> **Supersedes:** the sage-council single-loop skill builder port (`"C:\Users\julia\Downloads\kode\sage-council\src\lib\agents\execution\skill-builder-agent.ts"`, ~3,816 LOC) and the 14-prompt skill-generation pipeline (`src/lib/prompts/skill-generation-prompts.ts`, ~1,043 LOC). Both were written for the web app, which had no agent harness, no `claude` binary, no real tool surface to grant. We do — the entire authoring pipeline collapses into a thin orchestrator around Anthropic's official `skill-creator` skill, and we redirect the saved engineering capacity into a **Skill Planner** that's the headline depth-of-feature.
> **Decisions baked in (confirmed by user 2026-05-20):**
> 1. **Thin orchestrator** wrapper around skill-creator for authoring (~400 LOC), augmented by an **agentic Skill Planner** for preflight depth (~800 LOC). Total ~1,200 LOC of bridge code; ~6,000 LOC of skill authoring delegated to Anthropic.
> 2. **Maximalist tool surface with user gating** — the Planner detects + reasons about everything available and asks the user to grant each capability; the emitted skill is as capable as the environment + user comfort allow.
> 3. **`skill-creator` is a hard prerequisite** with auto-offer-to-install. `aab doctor` and `aab actions solve` both gate on its presence.
> 4. **Headless invocation via `claude -p --append-system-prompt-file`** — the only non-interactive path until Anthropic ships a `--skill` CLI flag ([anthropics/claude-code#38505](https://github.com/anthropics/claude-code/issues/38505)).
> 5. **Broad auto-detect, opt-in grant** — the Skill Planner runs read-only recon across the user's PC (apps + CLI tools + MCP servers + browser extensions + env vars), the Knowledge Wiki (stakeholders + decisions + endorsed directions), and the live web (current best practice + tool recommendations); proposes ≥3 multi-tool orchestrations on the maximalist tier; user opts in per capability. No silent grants.
> 6. **Skills are agents, not prompt packs.** Per [Anthropic Engineering, Oct 2025](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills). The Planner's job is to design skills that *execute work end-to-end*, not skills that produce documentation about the work. The Elgato moment (§23) is the load-bearing example.

This document is intentionally long. It exists so any future coding agent (Claude Code, a teammate, or Future-You) can pick up the work cold and know **what skill-creator is, what the Skill Planner is, why we're using both instead of porting sage-council's pipeline, and how every piece fits**. Skim the table of contents and jump. §6 (Skill Planner) is the centerpiece — read it first if you're short on time.

---

## Table of contents

1. [What this is, in one paragraph](#1-what-this-is-in-one-paragraph)
2. [External references — read these before editing](#2-external-references--read-these-before-editing)
3. [The strategic reframe — why we don't port sage-council](#3-the-strategic-reframe--why-we-dont-port-sage-council)
4. [Skills are AI agents, not prompt packs](#4-skills-are-ai-agents-not-prompt-packs)
5. [The 8-step `aab actions solve` flow](#5-the-8-step-aab-actions-solve-flow)
6. [**Skill Planner — the depth feature**](#6-skill-planner--the-depth-feature) ⭐ centerpiece
7. [Brief assembly — what we send to skill-creator](#7-brief-assembly--what-we-send-to-skill-creator)
8. [skill-creator invocation — the headless pattern](#8-skill-creator-invocation--the-headless-pattern)
9. [Adapter pass — frontmatter normalization](#9-adapter-pass--frontmatter-normalization)
10. [Install + conflict handling](#10-install--conflict-handling)
11. [Persistence — `SkillGenerationRun` + `linkedSkill`](#11-persistence--skillgenerationrun--linkedskill)
12. [WebSocket event family](#12-websocket-event-family)
13. [CLI surface](#13-cli-surface)
14. [Web UI surface](#14-web-ui-surface)
15. [Security model — `allowed-tools` is a grant, not a sandbox](#15-security-model--allowed-tools-is-a-grant-not-a-sandbox)
16. [MCP integration in emitted skills](#16-mcp-integration-in-emitted-skills)
17. [Browser surfaces — Playwright MCP, Claude for Chrome, computer use](#17-browser-surfaces--playwright-mcp-claude-for-chrome-computer-use)
18. [Settings keys](#18-settings-keys)
19. [Build phasing — 6 chunks](#19-build-phasing--6-chunks)
20. [Testing strategy](#20-testing-strategy)
21. [Acceptance criteria (Phase 5)](#21-acceptance-criteria-phase-5)
22. [Future extensions](#22-future-extensions)
23. [Glossary](#23-glossary)

---

## 1. What this is, in one paragraph

`aab actions solve <id>` takes one Action Item from the Kanban (Phase 4) and produces one installed Claude Code skill at `.claude/skills/<name>/`. The skill is *as agentic as the user grants* — with the right tool allowlist (`Bash`, MCP servers like `mcp__stripe__create_charge`, `WebSearch`, `Write`, `Edit`, Playwright MCP, etc.) it becomes a full autonomous worker that does the action item end-to-end the next time the user invokes Claude Code. We do **not** author the skill ourselves. Anthropic's official `skill-creator` skill — the same one shipped at `claude-plugins-official` with ~117k weekly installs — does that, run headless via `claude -p --append-system-prompt-file .claude/skills/skill-creator/SKILL.md` against a real tempdir. Our value-add is the **bridge**, and the headline piece of that bridge is the **Skill Planner** (§6): an LLM-reasoning agent that does deep read-only recon across the user's PC (every installed desktop app, CLI tool, MCP server, browser extension, env var, existing skill), the Knowledge Wiki (every relevant page, stakeholder, decision, anti-pattern), and the live web (current best-practice patterns, recently-released tools, integration hints), then reasons creatively about *how far we can take the skill* to maximize user value — surfacing multi-tool orchestrations the user has the infrastructure for but might not realize they could compose. The Planner's structured proposal becomes the brief skill-creator authors against. The remaining 20% of the bridge is the adapter pass that normalizes frontmatter to the current Claude Code spec, the install + conflict handling, the `SkillGenerationRun` provenance ledger, and the Web UI surface. Approximately 1,200 LOC of agentic-reasoning + glue around ~6,000 LOC of Anthropic-maintained authoring logic that we never have to read or maintain.

---

## 2. External references — read these before editing

If you are picking this up for the first time, read at least items 1, 2, and 4. The rest are deep references for specific subsystems.

**Anthropic's positioning on skills as agents:**

1. **"Equipping agents for the real world with Agent Skills"** (Anthropic Engineering, Oct 16 2025). [anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills). Key framing: *"Building a skill for an agent is like putting together an onboarding guide for a new hire."* And: *"transforming general-purpose agents into specialized agents that fit your needs."*
2. **"Skills for organizations, partners, and the ecosystem"** (Anthropic blog, Dec 18 2025). [claude.com/blog/organization-skills-and-directory](https://claude.com/blog/organization-skills-and-directory). Announces the Skills Directory at [claude.com/connectors](https://claude.com/connectors), the open standard at [agentskills.io](https://agentskills.io), and the partner skills (Canva, Atlassian, Stripe, Vercel, Zapier, Cloudflare, Notion, Figma) — most concrete evidence that skills do real work via tools, not just text.
3. **Agent Skills open standard.** [agentskills.io](https://agentskills.io). The cross-platform spec.

**Claude Code skill mechanics:**

4. **"Extend Claude with skills"** (official Claude Code doc). [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills). Authoritative frontmatter spec — read this before touching the adapter.
5. **"MCP integration"** (official Claude Code doc). [code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp). Confirms the `mcp__<server>__<tool>` naming convention used in `allowed-tools`.
6. **"Discover and install prebuilt plugins"** (official Claude Code doc). [code.claude.com/docs/en/discover-plugins](https://code.claude.com/docs/en/discover-plugins). The `/plugin install` command we'll auto-offer for skill-creator.
7. **"Skills in the SDK"** (Claude API doc). [platform.claude.com/docs/en/agent-sdk/skills](https://platform.claude.com/docs/en/agent-sdk/skills). Confirms that `allowed-tools` in SKILL.md is honored by the **Claude Code CLI** but not by the Agent SDK — we use the CLI, so we're fine.
8. **GitHub issue #38505** — non-interactive skill invocation. [anthropics/claude-code#38505](https://github.com/anthropics/claude-code/issues/38505). Tracks the open feature request for a `--skill` flag on `claude -p`. Until it ships, the `--append-system-prompt-file` workaround is the canonical pattern.

**The `skill-creator` skill itself:**

9. **`anthropics/claude-plugins-official` — `plugins/skill-creator/`.** [github.com/anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official). The skill we orchestrate. Its `skills/skill-creator/SKILL.md` body defines four modes (create / modify / evaluate / benchmark) and the interview → draft → test → evaluate → iterate → optimize → package pipeline.
10. **`anthropics/skills` — public skills library.** [github.com/anthropics/skills](https://github.com/anthropics/skills). Reference shapes from Anthropic itself.

**Real-world "skills as agents" examples (study these to understand what a good v1 emit looks like):**

11. **Sentry Issue Fixer** — `getsentry/sentry-fix-issues`. End-to-end bug patching via Sentry MCP + Edit tools.
12. **GitHub PR Auto-Fix** — `openai/gh-fix-ci`. Debugs failing GH Actions via `gh` CLI in Bash.
13. **Playwright Interactive** — `openai/playwright-interactive`. Persistent browser session via Playwright MCP.
14. **Cloudflare Workers Deploy** — `openai/cloudflare-deploy`. Ships apps to production via Wrangler.
15. **Stripe MCP Skill** — [github.com/wrsmith108/stripe-mcp-skill](https://github.com/wrsmith108/stripe-mcp-skill). Charges, customers, subscriptions, refunds via Stripe MCP.
16. **Agent-Slack** — [github.com/stablyai/agent-slack](https://github.com/stablyai/agent-slack). Send / search / react / schedule.
17. **Awesome lists** for browsing more: [VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills), [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills).

**Browser surfaces:**

18. **"Piloting Claude in Chrome"** (Anthropic blog, Nov 2025; GA Dec 2025). [claude.com/blog/claude-for-chrome](https://claude.com/blog/claude-for-chrome). Chrome-only browser surface; integrates with Claude Code as a debug/verification companion. Direct skill-level invocation of the Chrome extension's surface is **not currently documented** — for in-skill browser work the established route is Playwright MCP.
19. **Computer Use API.** [docs.claude.com/en/docs/build-with-claude/computer-use](https://docs.claude.com/en/docs/build-with-claude/computer-use). Separate Anthropic SDK product. Invoking from inside a Claude Code skill is currently **unverified** — skills use Claude Code's tool registry, not the SDK's tool schema.

**In-repo references that this design touches:**

- `src/storage/types.ts:177-195` — `ActionItem.linkedSkill` already defined as the placeholder shape (`{name, runId, installedAt, installPath}`); Phase 4 left it nullable, Phase 5 populates it.
- `src/storage/types.ts:464-494` — `SkillGenerationRun` interface already defined with `files[]`, `metadata.{skillName, confirmedCapabilityProfile, criticScore, securityReview, triggerEvaluation, …}`. Phase 5 populates it from skill-creator's output + our adapter pass.
- `src/storage/types.ts:606-608` — `loadSkillRuns`, `saveSkillRun`, `getSkillRun` already in `StorageService` interface. `FsStorageService` provides the file-backed impl.
- `src/agents/emit-member-agent.ts` — existing emitter for `.claude/agents/<slug>.md` with `# AAB:GENERATED` marker. Mirror this pattern in `src/core/skill/install.ts` for the skill directory.
- `src/llm/claude-code-runner.ts` — `runClaude()`. Phase 5 adds a `cwd` option (so skill-creator can write to the tempdir) and an `appendSystemPromptFile` option.

---

## 3. The strategic reframe — why we don't port sage-council

The sage-council web app's skill builder (`src/lib/agents/execution/skill-builder-agent.ts`, 3,816 LOC) and 14 skill-generation prompts (~1,043 LOC) exist for one reason: **the web app has no agent harness.** It calls Gemini over HTTPS with `responseMimeType: 'application/json'` and gets a string back. To produce a multi-file SKILL.md package from a string-out model, sage-council had to invent:

- A virtual filesystem (`SkillPackagePayload = { files: [{path, content}] }`) so the model could "edit" without touching real disk.
- 7 internal "tools" (`list_files / read_file / create_file / update_file / write_file / rename_file / delete_file`) returned as JSON action objects per turn.
- A 60-turn loop with telemetry, convergence detection, and JSON-recovery fallbacks.
- A 7-dimension package critic + repair pass (max 2 attempts).
- A per-file master-prompter potency pass.
- A separate security review LLM call.
- A trigger-query evaluator (8-10 should-trigger / 8-10 should-not).
- A Mustache template resolver + master-gpt-prompter hardening preamble auto-applied to every render.
- Single-loop planner, composition analyzer, composition override agent, decomposition critic, skill-aware decomposition critic, atomic-composition flag, reflexion flag, critique-panel flag.

All of this exists because *Gemini can't write to disk*. **We can.** `claude` (the CLI) has `Write`, `Edit`, `Read`, `Glob`, `Bash` available out of the box. The official `skill-creator` skill *uses* those tools to author skills the way a human would, with internal critique loops Anthropic has tuned over months. Our job is to invoke it correctly, give it good context, and capture what it produces.

**What we keep from sage-council's design:**

- The two-stage **preflight wizard** idea (capability inference from action text + user confirmation per capability) — sharpened into a much lighter implementation (auto-detect + opt-in grant; no LLM-driven chat agent).
- The **`SkillCapabilityProfile`** shape — exactly the right contract for telling skill-creator "here's what the user has, here's what fallback mode applies for missing capabilities."
- The **`SkillGenerationRun`** ledger — provenance of every run, what was installed, critic scores, telemetry. Now populated from skill-creator's emitted output instead of our own pipeline.
- The **`ClaudeCodeAdapter`** frontmatter rewrite (§9) — defensive pass that validates emitted SKILL.md against current Claude Code spec.

**What we drop entirely** (these go from the sage-council port plan):

- All 14 skill-generation prompts and their `requiredVariables` / `requiredFragments` validators.
- The Mustache template resolver and `applyMasterPrompterHardening` wrap.
- `SkillBuilderAgent`, `executeSingleLoopToolAuthoringLoop`, `executeSingleLoopPlanLoop`, `applySingleLoopToolAction`, `recoverSingleLoopInvalidJson`, `enhanceSkillMdWithFailOpen`, `rewriteFallbackPlaceholderSkillsWithFailOpen`, `runMasterPrompterPotencyLoop`, `runSingleLoopAgenticRefinementLoop`, `recallSkillRepair`, `validateSkillQuality`.
- `runPackageCritiqueWithFailOpen` (the 7-dim rubric + hard gates) — skill-creator runs its own quality loop internally.
- `skillPackagePayloadSchema`, `singleLoopPlanPayloadSchema`, `singleLoopToolTurnPayloadSchema`, `filePotencyEnhancementPayloadSchema`, `skillMdEnhancementPayloadSchema`, `skillPackageCritiquePayloadSchema`, `skillSecurityReviewPayloadSchema`, `skillTriggerEvaluationPayloadSchema` — we don't validate any of this; skill-creator authors files we copy.
- `skill_generation_atomic_composition_v1`, `skill_generation_reflexion_v1`, `skill_generation_critique_panel_v1`, `skill_generation_composition_llm_override_v1`, `skill_generation_llm_control_plane_v1`, `skill_generation_web_grounding_v1` feature flags.
- `skill-composition-analyzer.ts`, `skill-composition-override-agent.ts`, `composition_critic` prompt — Part 6 already cut these.
- `skill-preflight-chat-agent.ts` (1,084 LOC, LLM-driven preflight chat) — replaced by an `enquirer` wizard.
- `decomposition_critic`, `skill_aware_decomposition_critic` — no critic at the decomposition layer.
- `taskClassifierAgent` — always `skill`.
- `solution-packager-service.ts` (4 layout modes) — skill-creator emits its own layout.

**Net diff vs. the sage-council port plan:** ~5,000 LOC removed; ~800 LOC added.

---

## 4. Skills are AI agents, not prompt packs

This section exists to align the design team on what a "good" v1 skill emit looks like. The sage-council web app could only emit text-based SKILL.md files because Gemini had no tools to grant. We have the full Claude Code tool surface. Anthropic's framing has shifted decisively to **skills as specialized workers**:

> *"Skills move Claude from figuring out a task to actively executing it … transforming general-purpose agents into specialized agents that fit your needs."* — [Anthropic Engineering, Oct 2025](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)

> *"Canva skills create full multi-platform campaigns, generate on-brand presentations, and translate content, all with a single, simple prompt."* … *"Atlassian skills turn specs into backlogs, generate status reports, surface company knowledge, and triage issues."* … *"Zapier runs [skills] at scale across thousands of apps."* — [Anthropic, Dec 2025](https://claude.com/blog/organization-skills-and-directory)

**What this means for `aab actions solve`:**

If the Action Item is "Send the Q3 launch campaign in DK", a v1 emit should not produce a SKILL.md that *describes how to send the campaign*. It should produce a SKILL.md with `allowed-tools` like:

```yaml
allowed-tools:
  - mcp__hubspot__send_campaign
  - mcp__hubspot__list_contacts
  - WebSearch
  - WebFetch
  - Read
  - Write
  - Bash(git status, git diff)
```

…and a body that *executes* the workflow: pull the contact list, compose the copy from `wiki/concepts/q3-launch.md` (the Knowledge Wiki page), draft the campaign payload, send via HubSpot MCP, log results back into the wiki, post a Slack message via Slack MCP. End-to-end. Human work, done.

**The five attributes of a good v1 emit:**

1. **Trigger-quality `description` + `when_to_use`** — Claude must route to it autonomously when the user mentions the work next time.
2. **Concrete `allowed-tools` allowlist** matching exactly what the user granted in preflight. No tool listed that the user didn't confirm.
3. **Body that *executes*, not *describes*** — explicit ordered steps using the granted tools, with output contracts and validation gates.
4. **Fallback behavior for unavailable capabilities** — if the user said "no" to Stripe MCP, the skill produces an artifact (e.g., a draft email with payment instructions) instead of failing.
5. **Provenance footer** linking back to the source action item (`> Source: action <short-id> from discussion <short-id>`) and the relevant `wiki/` pages.

The preflight wizard (§6) is what makes (2) and (4) possible. The brief assembly (§7) is what makes (1) and (3) precise. The adapter pass (§9) is the defensive net that catches anything skill-creator emits that doesn't match the current Claude Code spec.

---

## 5. The 8-step `aab actions solve` flow

```
aab actions solve <id> [flags]
  ├ 0. preconditions       skill-creator skill installed? action item exists? linked discussion (if any) loaded?
  ├ 1. SKILL PLANNER       four-phase agentic recon + reasoning (§6) — the headline feature:
  │     1a. PC scan        read-only walk: desktop apps, CLI tools, MCP servers, browser extensions, env vars
  │     1b. wiki recon     deep Knowledge Wiki query: relevant pages, stakeholders, decisions, vetoes
  │     1c. web research   WebSearch + WebFetch: current best practice, recently-released tools, integration hints
  │     1d. reasoning      Opus 4.7 proposes 3 ambition tiers (minimal/standard/maximalist) with multi-tool orchestrations
  │     1e. user review    interactive proposal acceptance: toggle integrations + stakeholders + tier; edit narrative
  ├ 2. brief assembly      action + discussion summary + accepted Planner proposal + target install path → JSON brief
  ├ 3. skill-creator       spawn claude headless with --append-system-prompt-file = skill-creator's SKILL.md
  │                        cwd = ~/.aabcli/<ws>/skill-runs/<runId>/workspace/
  │                        user message = the JSON brief (including the FULL Planner proposal verbatim)
  │                        allowed-tools = Write,Edit,Read,Glob,Bash (skill-creator needs these to author)
  │                        stream stdout → TTY + WS; timeout 20 min; capture telemetry
  ├ 4. adapter pass        validate emitted SKILL.md against current Claude Code spec (§9)
  │                        inject the user-accepted `allowed-tools` if skill-creator didn't already
  │                        ensure description includes "Use when …" trigger language
  │                        fold any non-Claude-Code-spec keys into body sections
  ├ 5. dry-run preview     show emitted SKILL.md + tool surface + install path; require explicit accept (default y)
  ├ 6. install             cp -r workspace/ → .claude/skills/<name>/
  │                        conflict handling: overwrite | rename "<name>-2" | abort
  ├ 7. persist             write SkillGenerationRun JSON (with Planner proposal in metadata); update ActionItem.linkedSkill
  └ 8. WS broadcast        skill_planner_* / skill_run_* events throughout; refresh GUI
```

**Total LLM-call cost:** ~3 calls (wiki recon Sonnet + web research Sonnet + Planner Opus) + 1 skill-creator (Sonnet, loops internally) = ~$2.20/run typical. **Spawn count:** 4. **Wall-clock:** 5–14 min typical, 25 min hard cap. **Compared to sage-council:** ~2× cost, similar wall-clock, ~85% less code we maintain — and produces meaningfully more capable skills because the Planner sees the full environment.

**Flags:**

| Flag | Default | Effect |
|---|---|---|
| `--no-planner` | — | Skip the Skill Planner entirely (§6.8). Falls back to inferred-only minimal-tier profile. Faster + cheaper but produces minimal-tier skills. |
| `--planner-tier <tier>` | `maximalist` | Cap the Planner's ambition tier (`minimal` \| `standard` \| `maximalist`). Lower tiers reduce the integration surface the Planner proposes. |
| `--planner-no-web` | — | Skip the web research phase (§6.4). Useful when offline or when the action is internal-only. |
| `--planner-no-pc-scan` | — | Skip the PC scan (§6.2). Useful when running on a sandboxed/ephemeral machine. |
| `--skill-name <name>` | — | Override the auto-derived skill name (slug of action title). |
| `--no-install` | — | Build the skill but don't `cp -r` into `.claude/skills/`. Useful for inspection. |
| `--zip <path>` | — | Also produce a portable ZIP at `<path>` for sharing. |
| `--install-path <path>` | `.claude/skills/<name>/` (project) | Override install target. `--scope user` → `~/.claude/skills/<name>/`. |
| `--budget-cap-usd <n>` | settings | Abort if projected cost (Planner + skill-creator) exceeds. |
| `--single-loop-max-turns <n>` | 60 | Hint passed to skill-creator (it may or may not honor). |
| `--debug` | — | Verbose logs of every model call + skill-creator's tool calls + emitted files. |
| `--json` | — | Machine-readable progress + final result. |
| `--yes` / `-y` | — | Auto-accept the Planner proposal (recommended tier) + dry-run preview + auto-overwrite on conflict. CI mode. |

---

## 6. Skill Planner — the depth feature

> **This section is the heart of the entire spec.** A naive preflight ("ask the user if they have Stripe installed") produces naive skills ("here's a markdown checklist for sending an invoice"). A *Skill Planner* — an LLM-reasoning agent with deep recon across the user's PC, the Knowledge Wiki, and the live web — produces **agentic skills that orchestrate every tool the user already has to do the work end-to-end**. This is the difference between [Anthropic's framing of skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) ("specialized worker, like onboarding a new hire") and a glorified prompt library.
>
> **The pattern is domain-neutral.** The actions that come out of an advisory-board discussion span every domain — strategic decisions, technical refactors, hiring loops, legal reviews, financial models, operational comms, creative production, research deep-dives. The Planner has to design maximalist skills for ALL of them. The architectural decisions below — recon scope, ambition tiers, integration discovery, stakeholder touchpoints — apply identically whether the action is "record a YouTube intro" or "refactor the auth module" or "decide Q3 pricing."
>
> The canonical concrete illustration, in the user's own words, happens to be a creative-production case:
>
> > *"Instead of just making a 2-page markdown file with a script for a YouTube video, the Skill Planner should reason with itself about how can we else design this skill to maximize the value the user will get. Like: 'I can see the user has the Elgato Teleprompter app installed on their PC — why not create the YouTube scripts and insert them as scripts inside the Elgato Teleprompter app. Also I can see they have Google Calendar MCP installed on Claude — why not try to book time-slots in their calendar to remember to practice the scripts and to record the video. And I can see in the LLM Wiki that Person X is their video editor — why not draft the user an email they can send to Person X asking if they have time to edit the video, and attach the script as a brief of the task.' And so on."*
>
> The Elgato example is **one concrete shape** of the pattern; §6.5b walks through three more (a strategic-research case, a technical-refactor case, and an operational-hiring case) to make the domain-neutrality explicit. Every example surfaces ≥3 multi-tool orchestrations from different recon surfaces — but the surfaces themselves and the orchestrations themselves vary wildly by domain. Read all four before editing this section.

### 6.1 Mental model

The Skill Planner is **an LLM agent**, not an `enquirer` wizard. It's the most thinking-intensive call in the whole pipeline. We run it on **`researchModel` (Opus 4.7, 1M context)** because (a) the recon is long (we feed it the entire wiki slug-map + a 100-app PC inventory + 10–30 web sources), and (b) the reasoning is creative-ambition reasoning — "how far can we take this?" — which is exactly where Opus dominates.

The Planner runs in **four phases**:

1. **Recon (parallel, mostly deterministic Node-side).**
   - **PC scan** — read-only walk of installed desktop applications + CLI tools + browser extensions + MCP servers + env vars (§6.2).
   - **Wiki recon** — deep Knowledge Wiki walk via the Phase 1.5 query agent: find every page that mentions the action's domain, every entity that could be a stakeholder, every concept that's load-bearing (§6.3).
   - **Web research** — `WebSearch` + `WebFetch` to find: how this task is being done in 2026, what tools the world is using, what best-practice patterns exist, what integrations Anthropic / others have shipped recently (§6.4).
2. **Reasoning ("how far can we take it?").**
   - Single Opus call with all three recon outputs + the action item + linked discussion summary in context.
   - Explicit prompt instructions: *"propose three ambition tiers (minimal / standard / maximalist), and for the maximalist tier, surface every multi-tool orchestration opportunity you can see across this user's environment."*
   - Output: a structured **Skill Design Proposal** (§6.5).
3. **User review (interactive).**
   - Render the proposal in the GUI (or `enquirer` in CLI). Per-capability accept / reject / fallback. Per-integration accept / reject. Ambition-tier dial.
   - User can edit the proposal narrative before submit.
4. **Handoff.**
   - The accepted proposal becomes the brief (§7). skill-creator receives a much richer input than "here's an action item and a tool list."

**This is the dial that turns the whole CLI from "generates docs about your work" into "ships a skill that does your work."**

### 6.2 PC scan — read-only deep recon

Strictly read-only. The Planner agent itself never gets `Bash`; we gather the data Node-side and feed it as structured input. This is a hard architectural rule — see §15.

Platform-specific implementation (`src/core/skill/recon/pc-scan.ts`):

**Windows (primary target — this is Julian's platform):**

| Surface | How we read it | What we get |
|---|---|---|
| Installed desktop apps | PowerShell `Get-StartApps` + `Get-ItemProperty HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*` + `Get-AppxPackage` | App display names, publishers, install paths. Filter to user-relevant subset (skip system components). |
| User-installed programs | Walk `%LOCALAPPDATA%\Programs\`, `C:\Program Files\`, `C:\Program Files (x86)\` for top-level dirs | Belt + braces for apps not registered in startmenu / registry. |
| CLI tools | `where git, gh, stripe, hub, …` (extended list — see §6.6) + best-effort `<tool> --version` | Versioned CLI tool inventory. |
| Browser installs | Detect Chrome / Edge / Firefox via well-known paths + read installed extensions from `User Data\Default\Extensions\` (name + manifest.json only, never extension data) | Extension list for Chrome-driven workflows; Claude for Chrome auth presence (file existence only). |
| Default file associations | `reg query HKEY_CLASSES_ROOT` for top extensions | What handles `.docx`, `.psd`, `.fig`, etc. — clue to creative tools installed. |
| Background services | `Get-Service` filtered to known dev-tool service names (Docker Desktop, Postgres, Redis, etc.) | Currently-runnable infra. |

**macOS:**

| Surface | How |
|---|---|
| Apps | walk `/Applications/`, `~/Applications/`; `mdfind kMDItemKind == 'Application'` |
| CLI tools | `which`-style |
| Browser extensions | walk `~/Library/Application Support/Google/Chrome/Default/Extensions/` |
| LaunchAgents | `~/Library/LaunchAgents/` listing |

**Linux:**

| Surface | How |
|---|---|
| Apps | `/usr/share/applications/*.desktop`, `~/.local/share/applications/`, `flatpak list`, `snap list` |
| CLI tools | `which`-style |
| Browser extensions | `~/.config/google-chrome/Default/Extensions/` |
| systemd units | `systemctl --user list-unit-files` (read-only) |

**Universal (all platforms):**

- **MCP servers** — parse `~/.claude/.mcp.json` + `<projectRoot>/.mcp.json`; run `claude mcp list` if available. Capture server name + transport + tool catalog (if the server exposes it; many do via `mcp.list_tools`).
- **Env vars** — `process.env` keys matching ~80 patterns (`STRIPE_*, HUBSPOT_*, SLACK_*, GOOGLE_*, NOTION_*, LINEAR_*, OPENAI_*, ANTHROPIC_*, AWS_*, GCP_*, AZURE_*, DATABASE_URL, GITHUB_TOKEN, FIGMA_*, CANVA_*, ELGATO_*, OBS_*, …`). Names only, values redacted.
- **Existing Claude Code skills** — enumerate `.claude/skills/` + `~/.claude/skills/` + plugin scopes. Each one is a *callable capability* the new skill can compose with (the new skill can say "delegate to the `linear-sync` skill for ticket creation"). See [Anthropic docs on preloading skills into subagents](https://code.claude.com/docs/en/sub-agents#preload-skills-into-subagents).
- **Playwright** — `npx playwright --version` + `~/.cache/ms-playwright/` presence.
- **Claude for Chrome** — best-effort: presence of the extension dir + existence of an auth cookie file in the Chrome User Data dir. We can't fully verify auth state from CLI but we can confirm "the user has installed it." Sets `ReconResult.chrome: true|false`. Used by the Planner to gate `invocationHint.kind='chrome-extension'` proposals (§17).
- **Computer-use availability** — best-effort: presence of `ANTHROPIC_COMPUTER_USE_*` env vars OR `claude version --json` reports computer-use access enabled on the user's plan tier OR a local computer-use-compatible setup (e.g., `anthropic-quickstarts/computer-use-demo` directory in `~/`). Sets `ReconResult.computerUseAvailable: true|false`. Used by the Planner to gate `invocationHint.kind='computer-use'` proposals (§17).

**Hard rule:** nothing in `pc-scan.ts` writes a file, modifies a registry key, calls a network endpoint, or invokes anything that has side effects on the user's machine. The Planner agent never gets a tool that can change state. The recon module is unit-testable as a pure function: `recon(filesystemHandle, processEnv) → ReconResult`.

**Browser extensions as runtime aids, not `allowed-tools` entries (T3.2).** Detected browser extensions surface in the proposal as *manual-handoff fallbacks* the emitted skill body references in instructions ("press the LinkedIn extension button to do X"), not as `allowed-tools` strings (which require a corresponding Claude Code tool, which most browser extensions don't have). The Claude for Chrome extension is the one exception — but per §17 we treat it as a runtime user aid the skill instructs the user to invoke, not a tool the skill calls programmatically.

**Caching (T1.6) — critical for second-run UX.** First-run PC scan on a Windows machine with 200+ apps + 80 CLI tools (each polled for `--version`) takes 15–30 s. We cache:

- **Path:** `~/.aabcli/<ws>/.cache/pc-scan-<platform>-<env-hash>.json`. Platform is `win32|darwin|linux`. `env-hash` is `sha256(sorted process.env keys + node version + claude binary path)` truncated to 8 chars — so a new MCP server install or env-var change invalidates the cache without us tracking those mutations explicitly.
- **TTL:** 24 h. The cache file's `cachedAt` field is checked; older than TTL → re-scan.
- **Keyword sort happens AFTER cache load.** The cache stores the full inventory; the action-keyword-relevance sort runs per-invocation against the cached data (microseconds, no I/O). Same cache file serves every action item in the workspace.
- **Invalidation triggers:** the cache is force-invalidated when `aab init` adds an MCP server, when `aab doctor` notices `claude` binary path changed, or when the user runs `aab actions plan <id> --planner-refresh-pc-scan`.
- **`aab doctor` cache check:** info-level — surfaces cache age + a suggestion to refresh if >24 h. Warn-level if cache file is corrupt (parse failure).
- **Pure-function contract preserved:** `pc-scan.ts` exports both `scan(handles)` (always fresh) and `cachedScan(handles, cacheStore)` (cache-aware) — tests use `scan`, production uses `cachedScan`.

**Cap sizes:**
- App list ≤200 (sorted by recency + relevance to action keywords; rest truncated)
- CLI tools ≤80
- MCP servers — all (rarely >20)
- Env vars ≤100 (names only)
- Existing skills — all
- Each entry's metadata ≤200 chars

Total recon JSON ≤80 KB.

### 6.3 Wiki recon — the user's operating brain, not a stakeholder address book

**Reframe (added 2026-05-21 after the real Q3 YouTube end-to-end smoke):** The wiki is not an address book. It is the **user's accumulated operating knowledge** — the playbooks they've refined over multiple attempts at the same kind of work, the domain context only they have, the templates they've already proven, the post-mortems that document what bit them last time. Wiki recon's job is to find that knowledge and route it into the brief so skill-creator can **bake the user's actual operating procedures into the emitted skill body** — not invent a generic best-practice workflow that ignores what the user has already figured out.

The old shape (`stakeholders + endorsedDirections + vetoes + pastDecisions + relevantPages`) was tilted toward people-and-rules extraction. Four of five slots were about "who to involve" or "what not to do." The dumping-ground `relevantPages` slot held everything else as soft hints. **Skill-creator treated those hints as background reading rather than bake-into-the-skill material**, so emitted skills missed half the value the wiki could provide.

**The reframed `WikiContext` has nine first-class slots organized in three tiers** — knowledge tier (what the user has figured out), people tier (who's involved), and rules tier (what to do / what not to do):

```ts
interface WikiContext {
  // ─── Tier 1: KNOWLEDGE — what the user has figured out and we should BAKE IN ───

  // Playbooks: procedural pages documenting "how we do X." When present,
  // the skill body must EXECUTE these step-for-step verbatim — not paraphrase,
  // not invent alternatives, not soft-reference. The user already knows the
  // right way to do this.
  //
  // Heuristics for the recon agent to identify:
  //   - type: concept page whose title/body matches "how we ...", "our process for ...",
  //     "the way we ...", "X playbook", "X runbook", "X workflow"
  //   - body contains numbered/ordered steps that name the user's tools/stakeholders
  //   - body uses "we" or "our" (first-person plural) in describing a procedure
  //
  // Domain examples (deliberately spanning every action category):
  //   - Creative:    "Our 14-day YouTube launch playbook"
  //   - Technical:   "How we land OAuth changes (RFC → spike → staged rollout)"
  //   - Strategic:   "Our pricing-decision framework (value-mapping → comp set → CFO review)"
  //   - Operational: "How we run our SDR hiring loop (sourcing → ICR → loop → debrief)"
  //   - Financial:   "Our monthly investor-update process (close → P&L → narrative → send)"
  //   - Research:    "How we do competitive teardowns (mystery shop → feature matrix → quote pull)"
  //   - Legal:       "Our DPA review checklist (data flows → retention → subprocessor list)"
  playbooks: Array<{
    slug: string;
    title: string;
    body: string;  // FULL body — not summary. Skill body will embed verbatim steps.
    confidence: 'high' | 'medium' | 'low';  // how strong a signal this is a playbook
  }>;

  // Templates: pages that document a CONCRETE OUTPUT SHAPE the user uses
  // (email format, doc structure, slack message wording, code style, etc.).
  // When present, the skill must produce output in this shape, not in a
  // generic-best-practice shape.
  //
  // Heuristics:
  //   - type: concept page whose title contains "template", "format", "style",
  //     "structure", "shape", "example"
  //   - body contains a literal output sample (fenced code, indented block,
  //     "subject: ...\nbody: ..." pattern, etc.)
  //
  // Domain examples:
  //   - Creative:    "Our Danish SMB tone guide (casual-direct, no superlatives)"
  //   - Technical:   "Our PR description template (problem / approach / test plan / risk)"
  //   - Strategic:   "Our one-page decision-memo template"
  //   - Operational: "Our SDR job-description template"
  //   - Financial:   "Our monthly investor email template (cash → MRR → wins → asks)"
  //   - Comms:       "Our slack-message format for incident updates"
  templates: Array<{
    slug: string;
    title: string;
    body: string;        // FULL body
    exampleOutput?: string;  // literal sample if surfaceable (≤1500 chars)
  }>;

  // Domain knowledge: pages that carry facts, definitions, mental models,
  // framings, or constraints the skill should be AWARE of when making
  // decisions, even if no single "embed verbatim" instruction applies.
  //
  // Heuristics:
  //   - type: concept page that is descriptive (not procedural) — defines
  //     what something IS or means in the user's context
  //   - type: source-summary that captures distilled learnings
  //   - body uses declarative voice ("X is...", "Y means...", "the difference
  //     between X and Y is...")
  //
  // Domain examples:
  //   - Creative:    "Our brand voice principles" / "Danish SMB ICP definition"
  //   - Technical:   "Our session-cookie threat model" / "Latency budget targets"
  //   - Strategic:   "Our competitive landscape mental model" / "TAM/SAM/SOM for DK"
  //   - Operational: "Our team-size constraints" / "Our compensation philosophy"
  //   - Financial:   "Our gross-margin definition" / "Our cash-runway calculation"
  //   - Legal:       "Our GDPR posture" / "Our risk-tolerance principle"
  domainKnowledge: Array<{
    slug: string;
    title: string;
    summary: string;
    excerpt?: string;  // up to 1000 chars of body when highly relevant
  }>;

  // Past lessons: post-mortems, retrospectives, "what bit us last time"
  // pages. Feeds into the skill's veto/warning sections + the preflight
  // checks. The user has already paid for these learnings — make the skill
  // honor them.
  //
  // Heuristics:
  //   - type: source-summary or type: concept page whose title contains
  //     "lesson", "post-mortem", "retro", "what went wrong", "incident"
  //   - body uses past-tense narrative ("we tried...", "this broke when...")
  //   - body contains "next time we will..." / "we should always..." patterns
  pastLessons: Array<{
    slug: string;
    summary: string;     // ≤200 chars
    actionable: string;  // the concrete "next time" rule extracted, ≤200 chars
  }>;

  // ─── Tier 2: PEOPLE — who's involved (unchanged from the old shape) ───

  stakeholders: Array<{
    slug: string;
    name: string;
    role: string;
    contactHints?: string;  // email / Slack / phone captured in the entity page
  }>;

  // ─── Tier 3: RULES — what to do / not to do (kept from old shape) ───

  endorsedDirections: Array<{
    slug: string;
    statement: string;  // "We standardize on Postgres for all user-data storage"
  }>;

  vetoes: Array<{
    slug: string;
    statement: string;  // "Never send marketing emails on Mondays"
  }>;

  pastDecisions: Array<{
    slug: string;
    title: string;
    outcome: string;
  }>;

  // ─── Catch-all (last resort — anything that didn't fit a tier above) ───
  relevantPages: Array<{
    slug: string;
    type: 'concept' | 'entity' | 'decision' | 'source-summary' | 'comparison';
    title: string;
    summary: string;
    excerpt?: string;  // up to 500 chars
  }>;
}
```

**Recon prompt rewrite — fetch FULL bodies for Tier 1, summaries for Tier 2-3:**

The wiki recon is still a single Sonnet call with `Read/Grep/Glob` and `maxTurns: 12` (raised from 8 because Tier 1 pages need their bodies opened, not just summaries). The new prompt explicitly instructs the recon agent:

1. **First pass — tier classification.** Walk `wiki/index.md` and `wiki/KNOWLEDGE.md` to identify candidate pages. For each, classify by tier using the heuristics above. A single page can land in multiple tiers (e.g., a playbook page that also contains a template; both should be surfaced).
2. **Second pass — open Tier 1 bodies in full.** For every playbook, template, or high-confidence domain-knowledge page, `Read` the entire body and include it in the output JSON. Do NOT summarize. The Planner + skill-creator need the literal text to embed.
3. **Third pass — extract Tier 2-3 the old way.** Stakeholders, endorsed directions, vetoes, past decisions — summaries are sufficient; bodies only when highly relevant.
4. **Confidence scoring on playbooks.** A page with the title "Our X playbook" and 6 numbered first-person-plural steps is `high`. A page with "How I tend to do X" but no concrete steps is `medium`. A page that just describes X without prescribing process is `low` — surface as `domainKnowledge` instead.

**Anti-bias check baked into the prompt:** the prompt explicitly tells the agent *"do not over-weight stakeholder extraction — most pages in the wiki are not about people."* This corrects the old prompt's stakeholder-first orientation that biased the model to miss playbook + template signal.

**Cost impact:** opening full bodies for Tier 1 raises wiki recon from ~$0.09 to ~$0.15 typical. Well within the $0.20 per-recon-phase budget cap.

**Anti-domain-bias guarantee:** the schema fields above are deliberately **domain-agnostic**. None of them mention YouTube, OAuth, pricing, SDRs, or any other specific vertical. The heuristics are pattern-based ("matches 'how we ...' pattern", "uses first-person plural in a procedure description") not keyword-based. The 7 worked examples in §6.5b's few-shot library will be extended to show the new wiki-context shape in action across creative + strategic + technical + operational + financial + research + legal domains — proving the contract holds end-to-end regardless of action category.

**Downstream impact on the brief (§7):** the brief now embeds **full bodies of playbooks + templates** (not just slug + summary). Truncation priority extended: if the brief would exceed 60 KB, drop in this order — webResearch.recentInnovations → integration citations → webResearch.bestPracticePatterns sources → wiki.relevantPages bodies (catch-all) → wiki.pastDecisions outcomes (preserve playbooks + templates last; they're the most load-bearing).

**Downstream impact on the Planner system prompt (§6.5a `<orchestration_directives>`):** new directive added —

> *"If `wikiContext.playbooks[]` is populated for this action, the maximalist tier's workflow MUST execute each playbook step-for-step. Cite each playbook by slug in `valueRationale`. Do not invent alternative workflows when the user has documented theirs.*
> *If `wikiContext.templates[]` is populated, the skill's output-producing steps MUST use the template shape verbatim. Embed the template body in the relevant integration's invocationHint (for write-artifact kinds) or in the workflowSteps[] description.*
> *If `wikiContext.domainKnowledge[]` is populated, weave the relevant facts into the body where they inform a decision — do not just link to the wiki page.*
> *If `wikiContext.pastLessons[]` is populated, every actionable lesson MUST appear as either a veto entry or a preflight check in the proposal."*

**Schema validator (`validateProposalSemantics`) gets a new gate:** if any Tier 1 slot is non-empty AND the proposal's `valueRationale` does not cite at least one of those slugs by name, fail validation — re-run with stronger nudge. This forces the model to actually USE the knowledge it was given.

**On `role:` extraction for stakeholders — unchanged compatibility note (T1.7).** Phase 1.5's entity-page frontmatter declares `title`, `slug`, `aliases`, `type`, `summary`, `tags`, `sources`, `related`, `confidence`, `provenance`, `created`, `updated`, `userEdited` — but no `role:` field. The wiki-recon prompt still uses the dual-path extraction strategy (honor frontmatter `role:` if present; otherwise extract from the body's first paragraph). A future Phase 1.5.x amendment can add an optional `role:` field to the entity frontmatter contract and update the ingest agent prompt to populate it — that's still NOT a blocker.

### 6.4 Web research — what does the world know about this task?

**Two-pass design (T1.3).** Generic "how is this task done" research is not enough — the depth of the Planner comes from knowing *how to integrate with the specific apps the user has*. So `web-recon.ts` runs two passes, in order:

**Pass 1: general task research.** One Sonnet call with `WebSearch + WebFetch + maxTurns: 12`. Prompt: *"Research how this task is being done in 2026. What tools, integrations, and best-practice patterns exist? What's Anthropic's / the wider community's recommended approach? Surface 8–15 concrete sources, prioritizing recency and authority."* Output → `bestPracticePatterns`, `recentInnovations`, `warningsAndPitfalls`.

**Pass 2: per-detected-app integration-surface research.** This is the new piece. From the PC scan output, pick the **top 5 apps** whose category matches the action's domain (using the keyword-relevance sort already applied to the PC scan). For each one, one targeted Sonnet call (`WebSearch + WebFetch + maxTurns: 6`) with the prompt: *"The user has `<app-name>` (version `<x>`) installed. Find its integration surface: local HTTP API + port + endpoints, CLI binary + commands, URL scheme, file-system integration points, MCP server (if one exists), official SDK, automation guides. Cite Anthropic / vendor / community sources only. If no programmatic integration exists, say so explicitly and propose a Bash-based manual handoff."* Output → `appIntegrationSurfaces[]`.

This is how the Planner learns "Elgato Teleprompter has a local HTTP API at `http://localhost:9012` with a `POST /scripts` endpoint" — not from general task research, but from a targeted "what's Elgato's integration surface" query. Per-app budget cap: $0.08 × 5 apps = $0.40 added to the Planner cost (still under the $2.20 total target — see §6.9 updated table).

Output (structured JSON, extended):

```ts
interface WebResearchContext {
  taskDomain: string;  // e.g., "YouTube video production workflow"

  // Pass 1 — general task research
  bestPracticePatterns: Array<{
    pattern: string;     // e.g., "Use a teleprompter app for ≥3-minute scripts"
    rationale: string;
    sources: Array<{ title: string; url: string }>;
  }>;
  recommendedTools: Array<{
    name: string;
    category: 'cli' | 'desktop-app' | 'mcp-server' | 'web-service' | 'api';
    purpose: string;
    integrationHint: string;  // e.g., "Elgato Teleprompter has a local API on port 9012"
    sources: Array<{ title: string; url: string }>;
  }>;
  recentInnovations: Array<{
    name: string;
    summary: string;
    sources: Array<{ title: string; url: string }>;
  }>;
  warningsAndPitfalls: string[];

  // Pass 2 — per-detected-app integration-surface research (new in T1.3)
  appIntegrationSurfaces: Array<{
    appName: string;             // matches a ReconResult.cliTools[] or PC apps[] entry by name
    integrationKind: 'local-http' | 'cli' | 'url-scheme' | 'file-system' | 'mcp-server' | 'sdk' | 'none';
    invocationHint: {
      kind: 'bash-cmd' | 'bash-curl' | 'mcp-tool' | 'bash-script' | 'write-artifact' | 'manual-handoff';
      snippet?: string;          // literal snippet the emitted skill body should embed verbatim — e.g.,
                                 // 'curl -X POST http://localhost:9012/scripts -H "Content-Type: application/json" -d @script.json'
      tools: string[];           // allowed-tools entries this requires — e.g., ['Bash(curl *)']
    };
    workflow: string[];          // ordered steps describing the per-integration sub-workflow
    risks: string[];             // e.g., "Local port may collide with other services"
    sources: Array<{ title: string; url: string }>;
  }>;

  // Recon completeness — surfaced in proposal `warnings` if any phase degraded
  webPassesCompleted: { general: boolean; perAppCount: number };
}
```

This is where the Planner learns that "Elgato Teleprompter has a local HTTP API at port 9012 with a `POST /scripts` endpoint, callable via `Bash(curl ...)` from inside a skill." Pass 1 alone wouldn't yield this — generic web research returns generic patterns. The per-app pass is what makes the maximalist tier *actually maximalist* instead of "stuff I already knew."

### 6.5 The reasoning step — the Skill Design Proposal

Single `researchModel` (Opus 4.7) call. System prompt is the **Skill Planner prompt template** at `src/core/prompts/skill-planner.ts` (port-and-adapt-and-extend from sage-council's `decomposition` + `skill_task_research` prompts — but the actual planner prompt is new for this CLI). User message bundles:

- The action item + linked discussion summary
- `ReconResult` from §6.2 (PC scan)
- `WikiContext` from §6.3 (wiki recon)
- `WebResearchContext` from §6.4 (web research)
- Settings: max ambition tier (default `maximalist`), budget cap, install scope

Output (the proposal — a structured JSON the GUI renders as an editable form):

```ts
interface SkillDesignProposal {
  skillName: string;                    // kebab-case, derived from action
  skillSummary: string;                 // one-sentence "what this skill does"
  triggerLanguage: string;              // "Use when ..."

  // The crown jewel: ambition tiers, with maximalist front and center
  tiers: {
    minimal: SkillTier;        // just produce the obvious artifact
    standard: SkillTier;       // use the tools the user clearly wants
    maximalist: SkillTier;     // orchestrate everything detected — the "Elgato + Calendar + email-to-editor" tier
  };
  recommendedTier: 'minimal' | 'standard' | 'maximalist';  // Planner's pick

  // The integrations Planner identified across recon surfaces
  integrations: Array<{
    id: string;
    source: 'pc-app' | 'cli-tool' | 'mcp-server' | 'wiki-entity' | 'browser-extension' | 'web-service' | 'api';
    name: string;
    purpose: string;
    workflowSteps: string[];           // concrete steps using this integration

    // invocationHint — the load-bearing field added by T1.4. Tells skill-creator HOW the emitted
    // skill should actually call this integration. Without it, skill-creator emits instruction text
    // ("use Elgato Teleprompter to load the script") instead of an executable call.
    //
    // The 'chrome-extension' and 'computer-use' kinds (added when the user pointed out that
    // GUI-driving is a first-class integration surface, not a fallback) cover the case where an
    // external tool has NO programmatic surface — no MCP, no public API, no CLI. The skill body
    // emits explicit handoffInstructions the user (or Claude in a session with the right tool
    // enabled) executes. When Anthropic ships in-skill programmatic Chrome/computer-use access,
    // these kinds upgrade to direct invocation without proposal-shape changes.
    invocationHint: {
      kind: 'bash-cmd' | 'bash-curl' | 'mcp-tool' | 'bash-script'
          | 'write-artifact' | 'manual-handoff'
          | 'chrome-extension'           // GUI-driving via Claude Chrome — for sites/SaaS without APIs/MCPs
          | 'computer-use';              // GUI-driving native desktop apps — for apps without scripting surfaces
      tools: string[];                 // allowed-tools entries this requires — e.g., ['Bash(curl *)']
      snippet?: string;                // literal snippet the emitted SKILL.md body must embed verbatim.
                                       // The brief constraint instructs skill-creator: surround with
                                       // context as needed, but do NOT paraphrase the snippet (T2.5).
      // For 'write-artifact' kind: where the artifact goes.
      artifactPath?: string;           // e.g., 'references/email-to-person-x.md'

      // For 'chrome-extension' and 'computer-use' kinds — the literal user-handoff text the skill
      // body emits today, until in-skill programmatic invocation ships. Format: a self-contained
      // instruction block that names the target tool, the action sequence, the success criterion,
      // and the next skill step that runs after the user reports completion (or, in a future
      // version, after programmatic invocation returns).
      handoffInstructions?: string;    // e.g., "Open Claude Desktop with the Chrome extension enabled
                                       // and run this prompt: 'Navigate to https://www.linkedin.com/sales/...
                                       // and for each prospect in references/prospects.json, open their
                                       // profile, click Message, paste the template, and send. Confirm
                                       // sent for each one.' When done, return here to continue."
    };

    requiredTools: string[];           // RESULT of invocationHint.tools, used by the projection step
    fallbackIfMissing: string;
    confidence: number;                // 0-100 — how confident the Planner is this is the right call
    surfacedFrom: 'pc-scan' | 'wiki-recon' | 'web-research' | 'web-research-per-app' | 'inferred';
    citations?: Array<{ title: string; url: string }>;  // for web-research surfaces
  }>;

  // The workflow the maximalist skill should execute
  proposedWorkflow: Array<{
    step: string;
    integrations: string[];            // ids referencing entries above
    output: string;                    // what artifact / state change this step produces
  }>;

  // Stakeholders the skill should reference (from wiki recon)
  stakeholderTouchpoints: Array<{
    name: string;
    role: string;
    touchpointKind: 'draft-email' | 'slack-mention' | 'calendar-invite' | 'doc-share' | 'other';
    rationale: string;

    // T1.5 — concrete destination policy. Default 'artifact' produces a file inside the run's
    // references/ folder; 'send' upgrades to a real send via a granted MCP (Gmail/Slack/Calendar).
    produces: 'artifact' | 'send';
    artifactPath?: string;             // e.g., 'references/email-to-person-x.md' when produces='artifact'
    sendVia?: string;                  // e.g., 'mcp__gmail__send_message' when produces='send'
    artifactTemplate?: {
      subject?: string;                // for 'draft-email' kind — pre-rendered SUBJECT line
      body?: string;                   // pre-rendered BODY (Planner drafts this; skill-creator finalizes)
      attachments?: string[];          // file paths inside the skill workspace
    };
  }>;

  // Things to NOT do
  vetoes: string[];

  // Anticipated value delta — Planner's articulation of "why maximalist beats minimal"
  valueRationale: string;

  // T2.3 — degraded-recon visibility. Populated by the recon orchestrator before reasoning runs.
  // Surfaced in the GUI proposal modal as a yellow banner; printed to stderr by the CLI.
  warnings: Array<{
    phase: 'pc-scan' | 'wiki-recon' | 'web-research-general' | 'web-research-per-app';
    severity: 'info' | 'warn' | 'error';
    message: string;                   // e.g., "Web research failed (offline) — proposal may miss recent best-practice patterns"
  }>;

  // T2.4 — over-promise validation. After Planner reasoning, the projection step compares each
  // proposed integration's requiredTools against the actually-confirmed capability set. Any
  // integration that depends on an uninstalled MCP / missing CLI / unavailable surface gets
  // surfaced here so the user sees "Planner suggested Calendar MCP but you haven't installed it."
  mismatchedIntegrations: Array<{
    integrationId: string;
    reason: 'mcp-not-installed' | 'cli-not-found' | 'env-var-missing' | 'app-not-detected' | 'other';
    requiredTool: string;
    suggestion: string;                // e.g., "Install Calendar MCP: `claude mcp add google-calendar ...`"
  }>;

  // Cost + duration estimate for the solve run
  estimatedCostUsd: number;
  estimatedDurationMinutes: number;
}

interface SkillTier {
  name: string;
  description: string;          // e.g., "Generates a 2-page markdown script — no integrations"
  toolSurface: string[];        // allowed-tools entries
  workflow: string[];           // ordered steps
  produces: string[];           // artifacts / actions
  estimatedValueScore: number;  // 0-100
}
```

The Planner's job description, baked into its prompt:

> *"You are the Skill Planner. Your task is not to plan the minimum viable skill. Your task is to ask: given everything in this user's environment (PC scan), their accumulated knowledge (wiki), and current best-practice (web research), **how far can we take this skill** to maximize user value? Lean toward orchestration over artifact-production. Lean toward multi-tool composition over single-tool solutions. Lean toward involving the right stakeholders over solving everything in isolation. Concretely: for the maximalist tier, you must surface at least three distinct multi-tool orchestrations the user has the infrastructure for. If you cannot find three, the recon was insufficient — say so explicitly in `valueRationale` rather than padding."*

### 6.5a Planner prompt design — the most important prompt in the CLI (T1.1)

The Planner's quality lives or dies in this prompt. Sketch of the structure at `src/core/prompts/skill-planner.ts`:

```
<role>
You are the Skill Planner — an agent that designs Claude Code skills that ORCHESTRATE THE USER'S TOOLS
to do real work end-to-end, not skills that produce documents about work.
</role>

<skill_operating_model>
{{port verbatim from sage-council src/lib/prompts/skill-operating-model.ts —
 the 14-line "what is a skill" preamble: instruction-first, description-driven routing,
 progressive disclosure, no-unverified-tools, atomic steps}}
</skill_operating_model>

<master_gpt_prompter_hardening>
{{port verbatim from sage-council — the 25-line hardening block:
 <reasoning_model_guidance>, <tool_use_description>, <autonomy_description>, <self_verification>}}
</master_gpt_prompter_hardening>

<ambition_directive>
Propose THREE tiers of the skill, ordered by ambition:

- minimal:   just produce the obvious artifact (e.g., a markdown file). No integrations.
             Use case: user has no tools / wants quick output.
- standard:  use the tools the user clearly has and the action obviously needs.
             1-2 integrations. Use case: balanced power/simplicity.
- maximalist: orchestrate EVERYTHING in the user's environment that could plausibly help.
             ≥3 distinct multi-tool integrations across at least 2 different surfaces
             (PC apps, MCP servers, CLI tools, wiki stakeholders).

HARD GATE: if you cannot find ≥3 maximalist integrations, you MUST say so in valueRationale
("the user's environment has limited integration surface for this action") and recommend
'standard' as the recommendedTier. Do NOT pad the maximalist tier with weak integrations
just to hit the count. The schema validator will reject < 3.
</ambition_directive>

<orchestration_directives>
For each detected PC app whose category matches the action's domain:
- Consult appIntegrationSurfaces in the WebResearchContext.
- If the app has a programmatic surface (local HTTP API, CLI, URL scheme, scripting API),
  propose an integration that USES IT, with the EXACT invocationHint.snippet from the
  per-app research pass (don't paraphrase). Prefer kind='bash-curl' / 'bash-cmd' /
  'bash-script' / 'mcp-tool' as applicable.
- If the app has NO programmatic surface — propose an invocationHint.kind='computer-use'
  integration. Write handoffInstructions describing the GUI sequence Claude (running with
  computer-use enabled) must perform. Treat this as a FIRST-CLASS integration, NOT a
  fallback. Many real native apps (DaVinci Resolve, Sage accounting, Notion desktop on
  free tier, AutoCAD for non-enterprise users) only have GUI surfaces — computer-use is
  the bridge that makes them addressable.

For each detected MCP server:
- If the server has tools that match the action's domain, propose an integration with
  invocationHint.kind='mcp-tool' and invocationHint.tools=[mcp__<server>__<tool>, ...].

For external destinations the action implies but the user has no MCP/API for (e.g., a
SaaS portal, a vendor website, a third-party HR system without a public API):
- Check appIntegrationSurfaces for a per-app web-research hit naming the site.
- If no programmatic surface exists, propose an invocationHint.kind='chrome-extension'
  integration. Write handoffInstructions describing the navigation + form-fill + click
  sequence Claude (running with Chrome extension enabled) must perform. Like computer-use,
  treat this as FIRST-CLASS. The Claude Chrome extension is GA across Pro/Team/Enterprise
  since Dec 2025 and is the integration mechanism for sites without public APIs (LinkedIn
  Sales Nav, mid-market vendor portals, Productboard/Aha! roadmap tools, government
  filing sites, ATS for tier-restricted accounts, etc.).

For complex actions that touch multiple external systems:
- Don't shoehorn into one integration kind. PROPOSE A MIX: e.g., pull data via MCP, post
  results via Chrome to a portal that has no API, paste a derived figure into a desktop
  app via computer-use, draft stakeholder follow-ups as artifacts. The maximalist tier
  earns its name by chaining surfaces.

For each wiki entity that is a person (stakeholder):
- If their role is plausibly relevant to the action, propose a stakeholderTouchpoint.
- Default to produces='artifact' (file in references/) unless the user has a matching
  send-capable MCP granted (Gmail/Slack/Calendar) — then upgrade to produces='send'.
- DRAFT the artifact's content (subject + body) — don't leave it as a placeholder.

For each wiki decision/concept tagged as endorsed or veto:
- Endorsed: bake into the skill's default workflow (the skill should DO it the user's way).
- Veto: list in proposal.vetoes verbatim. The skill body must include "MUST NOT" rules.
</orchestration_directives>

<invocation_hint_directive>
EVERY integration MUST have a populated invocationHint. Without it, the emitted skill will
describe the work in prose instead of executing it. Examples spanning all kinds:

- Elgato Teleprompter local API (kind='bash-curl'):
  invocationHint = { kind: 'bash-curl', tools: ['Bash(curl *)'],
    snippet: 'curl -X POST http://localhost:9012/scripts -H "Content-Type: application/json" -d @script.json' }

- Google Calendar MCP (kind='mcp-tool'):
  invocationHint = { kind: 'mcp-tool',
    tools: ['mcp__google_calendar__create_event', 'mcp__google_calendar__list_events'] }

- Email draft to a stakeholder, no Gmail MCP (kind='write-artifact'):
  invocationHint = { kind: 'write-artifact', tools: ['Write'],
    artifactPath: 'references/email-to-person-x.md' }

- LinkedIn Sales Nav, no public API (kind='chrome-extension'):
  invocationHint = { kind: 'chrome-extension', tools: [],
    handoffInstructions: 'Open Claude with the Chrome extension enabled and run: "Navigate to https://www.linkedin.com/sales/. For each prospect in references/prospects.json, open their profile, click Message, paste references/templates/inbound-warm.md (substituting [[first_name]]), and send. After each send, append the result to references/outreach-log.json." Return to this skill when done — Step 4 will tally the log.' }

- DaVinci Resolve render, no usable scripting API (kind='computer-use'):
  invocationHint = { kind: 'computer-use', tools: [],
    handoffInstructions: 'Open Claude with computer-use enabled and run: "Open the DaVinci Resolve project at <path>. Set in/out points per references/render-marks.json. Add to Render Queue using preset \"YouTube 1080p\". Output to <path>/exports/. Click Start Render. Report completion." Return when done.' }

For chrome-extension and computer-use kinds, the handoffInstructions field is the contract —
it must be self-contained, specify the exact target, the exact action sequence, the success
criterion, and what the calling skill expects back. Skill-creator embeds it verbatim in the
SKILL.md body as the step that gates progression.
</invocation_hint_directive>

<output_contract>
Return ONLY a single JSON object matching the SkillDesignProposal schema. No markdown, no
fences. Start with `{`, end with `}`. Every required field present. Every integration has a
populated invocationHint. Every stakeholderTouchpoint has populated artifactTemplate when
produces='artifact'.
</output_contract>

<input>
<action>{{action_item_json}}</action>
<linked_discussion_summary>{{discussion_summary}}</linked_discussion_summary>
<recon>
  <pc_scan>{{recon_result_json}}</pc_scan>
  <wiki_context>{{wiki_context_json}}</wiki_context>
  <web_research>{{web_research_context_json}}</web_research>
</recon>
<settings>
  <max_tier>{{maxTier}}</max_tier>
  <budget_cap_usd>{{budgetCap}}</budget_cap_usd>
</settings>
{{#user_replan_feedback}}
<replan_feedback>{{user_replan_feedback}}</replan_feedback>
{{/user_replan_feedback}}
</input>

<few_shot_examples>
{{embed SEVEN worked examples spanning distinct action domains AND distinct integration kinds
 — see §6.5b for full text. The set deliberately covers all invocationHint.kind values
 (bash-cmd, bash-curl, mcp-tool, bash-script, write-artifact, chrome-extension, computer-use)
 so the Planner has a concrete reference for every shape it might need to propose.

 Examples 1-4 cover the primary domains × programmatic-surface cases:

 Example 1 — Creative/comms: "Record YouTube intro for Q3 launch"
   Recon surfaces: PC app (Elgato Teleprompter, local HTTP API) + MCP (Google Calendar)
                   + wiki stakeholder (video editor)
   Demonstrates: bash-curl (local API) + mcp-tool + write-artifact (stakeholder draft).

 Example 2 — Strategic/research: "Investigate pricing strategy for Q3 SMB launch"
   Recon surfaces: WebSearch + wiki concepts + MCP (Sheets) + wiki stakeholder (advisor)
   Demonstrates: zero PC apps; web-grounded; wiki write-back as artifact destination.

 Example 3 — Technical/code: "Refactor auth module to support OAuth2"
   Recon surfaces: codebase Read/Grep/Glob + CLI tools (gh, npm) + wiki decision page
   Demonstrates: codebase-as-recon; pure technical; no stakeholders; vetoes from wiki.

 Example 4 — Operational/people: "Hire 2 SDRs for the DK market"
   Recon surfaces: MCPs (ATS, Calendar, Slack) + wiki entities (ICP, team)
   Demonstrates: multi-MCP orchestration; artifact→send upgrade on Slack touchpoint.

 Examples 5-7 cover the NO-PROGRAMMATIC-INTEGRATION cases (GUI-driving + mixed):

 Example 5 — Browser-use only: "Run weekly LinkedIn outreach for the DK SDR pipeline"
   Recon surfaces: MCP (Sheets for prospects) + Claude Chrome detected + wiki templates
   Demonstrates: invocationHint.kind='chrome-extension'; user-handoff via Chrome-enabled
                 Claude session; site with no public API addressed via GUI-driving.

 Example 6 — Computer-use only: "Render the Q3 launch video edit timeline in DaVinci Resolve"
   Recon surfaces: PC app (DaVinci Resolve detected, no usable scripting surface) +
                   wiki project specs
   Demonstrates: invocationHint.kind='computer-use'; native desktop app with no
                 scripting API addressed via GUI-driving; handoffInstructions field.

 Example 7 — Mixed (the showpiece): "Close the books for May 2026 and send investor update"
   Recon surfaces: MCPs (Stripe, Mercury, Sheets) + Claude Chrome + computer-use +
                   wiki investor entities
   Demonstrates: ALL FIVE integration kinds in one skill — mcp-tool (financial data),
                 chrome-extension (Carta portal — no public API for free-tier users),
                 computer-use (Notion desktop paste — no API on free Notion),
                 write-artifact (6 personalized investor email drafts),
                 bash-cmd (final P&L PDF generation via pandoc).
                 This is the FULL agentic stack — the skill orchestrates 5 different
                 surfaces to close out monthly investor reporting end-to-end.

 For each example, the few-shot embed includes: (a) the action item JSON, (b) condensed
 ReconResult / WikiContext / WebResearchContext, (c) the resulting SkillDesignProposal
 with all integrations populated including invocationHint (and handoffInstructions for
 the chrome-extension/computer-use kinds), (d) a one-paragraph valueRationale contrasting
 minimal vs maximalist. The seven-example set is calibrated to teach the Planner that
 (i) the pattern is domain-neutral, (ii) lack of programmatic API is NOT a reason to drop
 to a lesser tier — chrome-extension and computer-use are first-class integration kinds,
 and (iii) complex actions deserve mixed multi-surface orchestration.
}}
</few_shot_examples>
```

**Why each section earns its place:**

- `<role>` — sets the ambition-bias up front (orchestration over artifacts). One sentence; can't be missed.
- `<skill_operating_model>` — the model needs to know what a skill actually IS in the Claude Code ecosystem before it can propose one. The 14-line preamble is calibrated.
- `<master_gpt_prompter_hardening>` — sage-council's prompt-hardening guardrail. The Planner reasoning quality drops measurably without it (sage-council learned this the hard way).
- `<ambition_directive>` — the three-tier framing + the hard gate on ≥3 maximalist integrations. The schema validator (`skillDesignProposalSchema` in `src/core/parsing/llm-response-schemas.ts`) re-asserts the gate; failure → re-run with a stronger nudge.
- `<orchestration_directives>` — the per-recon-surface instructions. Tells the model exactly how to consume PC scan, MCP list, wiki entities, wiki decisions/vetoes. Without these, the model treats recon as background reading and proposes generic stuff.
- `<invocation_hint_directive>` — T1.4 enforcement at the prompt level. Three worked invocationHint examples so the model knows the shape it must emit.
- `<output_contract>` — JSON-only contract; standard Claude-Code-CLI parser pattern.
- `<input>` — Mustache-style sections (consistent with Phase 1 prompt resolver). `user_replan_feedback` is the optional re-plan loop input (T2.1).
- `<few_shot_examples>` — three concrete examples are the single biggest quality lift for prompts of this shape. The Elgato example (§6.5b) is one; the prompt file embeds all three as `## Example N` sub-sections.

**Validation:** the prompt file is unit-tested in two dimensions. (1) Static — the rendered prompt contains every required directive (regex scan). (2) Dynamic — given canned recon inputs, the Planner output validates against `skillDesignProposalSchema` AND its maximalist tier surfaces ≥3 integrations spanning ≥2 surface types.

### 6.5b Worked examples across four action domains (T1.2)

This section walks through four examples — creative, strategic, technical, operational — to demonstrate that **the Planner's pattern is domain-neutral**. Each example exercises the same mechanisms (recon → ambition tiers → integrations with invocationHint → stakeholder touchpoints when relevant → schema validation), but the recon surfaces and orchestration shapes vary wildly. All four are embedded as few-shot examples in §6.5a's prompt. The Elgato example is the most-detailed; the other three are condensed because the reader has Elgato as the deep-dive template.

---

#### Example 1 — Creative/comms: "Record YouTube intro for Q3 launch"

This is the canonical worked example. It exercises local-HTTP-API integration, MCP integration, and stakeholder artifact production.

**Action item:**
```json
{
  "id": "a3f2",
  "title": "Record YouTube intro for the Q3 product launch",
  "description": "Need a 3-minute intro video for the Q3 launch landing page. Script, recording, editing.",
  "priority": "high",
  "linkedDiscussionId": "d7c1"
}
```

**Linked discussion summary (from Phase 1 `ConversationSummary`):**
- *Key points:* "Launch is in 3 weeks. Audience is Danish SMBs. Tone should be casual-but-credible. Length target 3 min. Hand off to Mads (video editor) for cut."

**ReconResult (PC scan output, condensed):**
```yaml
cliTools: [git@2.43, gh@2.40, node@22.11, ffmpeg@7.0]
apps:
  - { name: "Elgato Teleprompter", version: "1.4.2", category: "creative" }
  - { name: "OBS Studio", version: "30.1", category: "creative" }
  - { name: "DaVinci Resolve", version: "18.6", category: "creative" }
  - { name: "Slack", version: "4.x", category: "comms" }
mcpServers:
  - { name: "google-calendar", transport: "http", tools: ["create_event", "list_events"] }
  - { name: "obsidian", transport: "stdio", tools: ["read_note", "search"] }
envVars: ["YOUTUBE_API_KEY", "ELGATO_PROMPTER_PORT"]
chrome: true
playwright: false
existingSkills: ["wiki-ingest", "decision-coach"]
```

**WikiContext (wiki recon output, condensed):**
```yaml
relevantPages:
  - { slug: "q3-launch", type: "concept", summary: "Q3 product launch — Danish SMB focus, 3-week runway" }
  - { slug: "danish-smb-tone", type: "concept", summary: "Marketing copy tone: casual, direct, no hype" }
  - { slug: "mads-larsen", type: "entity", summary: "Video editor — works with us on YouTube content" }
stakeholders:
  - { slug: "mads-larsen", name: "Mads Larsen", role: "video editor",
      contactHints: "email: mads@example.dk; prefers briefs in PDF + script as .docx" }
endorsedDirections:
  - { slug: "q3-launch", statement: "Launch videos must hit Danish SMB tone — casual, direct, no hype" }
vetoes: []
```

**WebResearchContext (web research output, condensed):**
```yaml
bestPracticePatterns:
  - { pattern: "Use a teleprompter app for ≥3-min YouTube scripts", rationale: "Reduces re-takes 60%+",
      sources: [{ title: "...", url: "..." }] }
appIntegrationSurfaces:
  - { appName: "Elgato Teleprompter",
      integrationKind: "local-http",
      invocationHint: {
        kind: "bash-curl",
        tools: ["Bash(curl *)"],
        snippet: "curl -X POST http://localhost:${ELGATO_PROMPTER_PORT:-9012}/scripts -H 'Content-Type: application/json' -d @script.json"
      },
      workflow: ["1. POST the script as JSON to /scripts", "2. GET /scripts/<id> to confirm",
                 "3. App auto-loads the latest script on next teleprompter session"],
      risks: ["Local port may collide if multiple users on same machine"],
      sources: [{ title: "Elgato Teleprompter docs", url: "..." }] }
  - { appName: "OBS Studio",
      integrationKind: "cli",
      invocationHint: { kind: "manual-handoff", tools: [] },
      workflow: ["OBS has no CLI script-load API. Skill produces a session-prep checklist."],
      sources: [...] }
```

**SkillDesignProposal output (excerpted — key fields):**
```json
{
  "skillName": "record-q3-launch-intro",
  "skillSummary": "End-to-end YouTube intro production for Q3 launch — script → teleprompter → calendar → editor brief.",
  "triggerLanguage": "Use when the user wants to record the Q3 launch YouTube intro, or any short product-launch intro video for Danish SMB audiences.",
  "tiers": {
    "minimal": {
      "name": "minimal",
      "description": "Produces a markdown script file. User handles everything else manually.",
      "toolSurface": ["WebSearch", "WebFetch", "Read", "Write"],
      "workflow": ["1. Draft 3-min script in Danish SMB tone", "2. Write to references/script.md"],
      "produces": ["references/script.md"],
      "estimatedValueScore": 25
    },
    "standard": {
      "name": "standard",
      "description": "Script + teleprompter-ready JSON + practice calendar slot.",
      "toolSurface": ["WebSearch", "WebFetch", "Read", "Write", "Bash(curl *)",
                      "mcp__google_calendar__create_event"],
      "workflow": ["1. Draft script", "2. Load into Elgato via curl",
                   "3. Book 1-hr practice slot in Calendar"],
      "produces": ["references/script.md", "Elgato-loaded script", "Calendar event"],
      "estimatedValueScore": 70
    },
    "maximalist": {
      "name": "maximalist",
      "description": "Script + teleprompter + calendar (practice + recording) + drafted brief email to Mads (editor) with script attached.",
      "toolSurface": ["WebSearch", "WebFetch", "Read", "Write", "Edit", "Bash(curl *)",
                      "mcp__google_calendar__create_event", "mcp__google_calendar__list_events"],
      "workflow": [
        "1. Draft 3-min script in Danish SMB tone (consulting wiki/concepts/danish-smb-tone.md)",
        "2. POST script JSON to Elgato Teleprompter API",
        "3. Book 1-hr practice slot in Calendar (T-3 days from launch)",
        "4. Book 2-hr recording slot in Calendar (T-2 days from launch)",
        "5. Draft brief email to Mads with subject, body, and script attached"
      ],
      "produces": ["references/script.md", "references/script.json", "Elgato-loaded script",
                   "Calendar events ×2", "references/email-to-mads.md"],
      "estimatedValueScore": 95
    }
  },
  "recommendedTier": "maximalist",
  "integrations": [
    {
      "id": "elgato-load",
      "source": "pc-app",
      "name": "Elgato Teleprompter (local HTTP API)",
      "purpose": "Load the script into the teleprompter so user just hits record",
      "workflowSteps": ["POST script JSON to /scripts on the local Elgato API",
                        "Verify with GET /scripts/<id>"],
      "invocationHint": {
        "kind": "bash-curl",
        "tools": ["Bash(curl *)"],
        "snippet": "curl -X POST http://localhost:${ELGATO_PROMPTER_PORT:-9012}/scripts -H 'Content-Type: application/json' -d @references/script.json"
      },
      "requiredTools": ["Bash(curl *)"],
      "fallbackIfMissing": "If Elgato is not running, emit a manual-handoff note: 'Copy references/script.md into Elgato manually.'",
      "confidence": 90,
      "surfacedFrom": "web-research-per-app",
      "citations": [{ "title": "Elgato Teleprompter docs", "url": "..." }]
    },
    {
      "id": "calendar-practice",
      "source": "mcp-server",
      "name": "Google Calendar (practice slot)",
      "purpose": "Lock practice time so the script gets reps before recording",
      "workflowSteps": ["Create 1-hr event 3 days before launch", "Title: 'Practice Q3 launch intro'"],
      "invocationHint": {
        "kind": "mcp-tool",
        "tools": ["mcp__google_calendar__create_event"]
      },
      "requiredTools": ["mcp__google_calendar__create_event"],
      "fallbackIfMissing": "Emit a .ics file in references/ that the user can import manually.",
      "confidence": 95,
      "surfacedFrom": "pc-scan"
    },
    {
      "id": "calendar-record",
      "source": "mcp-server",
      "name": "Google Calendar (recording slot)",
      "purpose": "Lock recording time + alert",
      "workflowSteps": ["Create 2-hr event 2 days before launch"],
      "invocationHint": { "kind": "mcp-tool", "tools": ["mcp__google_calendar__create_event"] },
      "requiredTools": ["mcp__google_calendar__create_event"],
      "fallbackIfMissing": "Emit a .ics file in references/.",
      "confidence": 90,
      "surfacedFrom": "pc-scan"
    },
    {
      "id": "editor-brief-email",
      "source": "wiki-entity",
      "name": "Brief email to Mads Larsen (video editor)",
      "purpose": "Hand off the recording to the editor with a complete brief",
      "workflowSteps": ["Draft email with subject, body, and inline script",
                        "Include script.md + script.json as references"],
      "invocationHint": {
        "kind": "write-artifact",
        "tools": ["Write"],
        "artifactPath": "references/email-to-mads.md"
      },
      "requiredTools": ["Write"],
      "fallbackIfMissing": "(not applicable — Write is always available)",
      "confidence": 85,
      "surfacedFrom": "wiki-recon"
    }
  ],
  "stakeholderTouchpoints": [
    {
      "name": "Mads Larsen",
      "role": "video editor",
      "touchpointKind": "draft-email",
      "rationale": "Wiki says Mads handles our YouTube cuts. He prefers PDF briefs + script as .docx; we'll provide markdown for him to convert.",
      "produces": "artifact",
      "artifactPath": "references/email-to-mads.md",
      "artifactTemplate": {
        "subject": "Brief: Q3 launch intro video — script attached, due [launch-date]",
        "body": "Hi Mads,\n\nQ3 launch intro is ready for editing. The script is attached as references/script.md and references/script.json. Recording will happen [date]; raw footage will land in [shared drive].\n\nTone: Danish SMB casual-direct (see wiki/danish-smb-tone for ref).\nLength: 3 min target.\nDue: [launch-date].\n\nLet me know if you have capacity, or if I should plan around your schedule.\n\nThanks,\n[user]",
        "attachments": ["references/script.md", "references/script.json"]
      }
    }
  ],
  "vetoes": [],
  "valueRationale": "Minimal-tier (markdown only) delivers ~25% of the total work — the user still has to type the script into Elgato, set their own calendar reminders, and manually email Mads. Maximalist delivers ~95% — the only manual step is the actual recording. The user has all four integration surfaces ready (Elgato installed; Calendar MCP wired; Mads is in the wiki with contact hints; ffmpeg available for any post-processing). The web research surfaced Elgato's localhost:9012 API which the user may not have realized was available from a skill. Net: ~3-4 hours of orchestration work moves from manual to automatic.",
  "warnings": [],
  "mismatchedIntegrations": [],
  "estimatedCostUsd": 0.42,
  "estimatedDurationMinutes": 8
}
```

**What skill-creator emits given this brief (sketch of the resulting `.claude/skills/record-q3-launch-intro/SKILL.md`):**

```markdown
---
name: record-q3-launch-intro
description: Use when the user wants to record the Q3 launch YouTube intro, or any short product-launch intro video for Danish SMB audiences.
when_to_use: |
  Trigger conditions:
  - User says "let's record the Q3 launch intro"
  - User asks to prep a YouTube intro for a product launch
  - User mentions Elgato Teleprompter + Q3 launch in the same thought
allowed-tools:
  - WebSearch
  - WebFetch
  - Read
  - Write
  - Edit
  - Bash(curl *)
  - mcp__google_calendar__create_event
  - mcp__google_calendar__list_events
model: inherit
---

# Q3 Launch YouTube Intro — End-to-End

Mission: produce a teleprompter-ready 3-minute script, lock practice + recording time, and hand off a brief to Mads (video editor).

## Step 1 — Draft the script
Read `wiki/concepts/danish-smb-tone.md` for tone guidance. Draft a 3-min script (≈420-450 words). Write to `references/script.md` in markdown, AND `references/script.json` in `{ "title": "...", "lines": ["..."] }` shape for Elgato.

## Step 2 — Load into Elgato Teleprompter
```bash
curl -X POST http://localhost:${ELGATO_PROMPTER_PORT:-9012}/scripts \
  -H "Content-Type: application/json" \
  -d @references/script.json
```
Confirm with `GET /scripts/<id>`. If port unreachable: emit `references/elgato-manual-load.md` instructing the user to copy the script in manually.

## Step 3 — Book practice slot
Use `mcp__google_calendar__create_event` with title "Practice Q3 launch intro", duration 1h, T-3 days from launch date.

## Step 4 — Book recording slot
Same MCP, duration 2h, T-2 days from launch.

## Step 5 — Draft brief email to Mads
Write `references/email-to-mads.md` with the artifactTemplate from the brief. List `references/script.md` and `references/script.json` as attachments-to-send.

## Done state
- `references/script.md` exists and is 420-450 words in Danish SMB tone
- Elgato has the script loaded (or manual fallback emitted)
- 2 Calendar events created
- `references/email-to-mads.md` is ready to send

## Vetoes
None for this run.

## Provenance
> Generated by aab actions solve from action a3f2; planner tier maximalist; 4 integrations.
```

This is the depth the Planner is meant to deliver. The next three examples show the same pattern applied to very different action domains.

---

#### Example 2 — Strategic/research: "Investigate pricing strategy for Q3 SMB launch"

This example exercises **web-grounded research** + **wiki-grounded competitor context** + **decision-memo as wiki artifact** + **advisor stakeholder**. No PC apps involved — the entire skill runs on web tools and MCPs.

**Action:** `{ title: "Investigate pricing strategy for Q3 SMB launch", description: "Need a defensible pricing model for the Q3 launch. Compare against 3-5 competitors. Recommend a tier structure with rationale." }`

**Recon (condensed):**
- ReconResult: `mcpServers: [google-sheets, notion]`; `envVars: [SHEETS_KEY]`; no relevant PC apps; `cliTools: [git, gh]`
- WikiContext: `relevantPages: [pricing-strategy (concept), q3-launch (concept), competitor-acme (entity), competitor-acme-pricing-2025 (source-summary)]`; `stakeholders: [{slug: "alexandra-chen-cfa", role: "financial advisor", contactHints: "Slack: @alex"}]`; `endorsedDirections: ["Target Danish SMBs with 10-50 employees; usage-based pricing where possible"]`
- WebResearchContext: `bestPracticePatterns: [{pattern: "Three-tier SaaS pricing (free/pro/enterprise) is dominant in SMB 2026 ..."}, ...]`; `appIntegrationSurfaces: []` (no apps to research)

**SkillDesignProposal (key fields, maximalist tier):**
- `integrations`:
  1. **WebSearch + WebFetch competitor scrape** — `invocationHint: { kind: 'bash-cmd', tools: ['WebFetch', 'WebSearch'], snippet: '<scrape patterns: pricing pages for each competitor in wiki/entities/competitor-*.md>' }`. Surfaced from `pc-scan` (existing tools) + `wiki-recon` (which competitors to scrape).
  2. **Google Sheets MCP comparison sheet** — `invocationHint: { kind: 'mcp-tool', tools: ['mcp__google_sheets__create_spreadsheet', 'mcp__google_sheets__update_range'] }`. Creates a per-row competitor × per-column dimension comparison.
  3. **Wiki decision memo write-back** — `invocationHint: { kind: 'write-artifact', tools: ['Write'], artifactPath: 'wiki/decisions/2026-q3-pricing-tiers.md' }`. The memo follows Phase 1.5's `type: decision` frontmatter contract; lints clean against `aab knowledge lint`. **Compounding knowledge** — next quarter's pricing discussion starts from this decision page.
  4. **Advisor review ping** — `stakeholderTouchpoints: [{ name: "Alexandra Chen", role: "financial advisor", touchpointKind: "slack-mention", produces: "send" (if Slack MCP granted) or "artifact" → references/slack-msg-to-alex.md, artifactTemplate: { body: "@alex — Q3 pricing decision draft is at wiki/decisions/2026-q3-pricing-tiers.md. Tier structure summary: [3-line summary]. Could you sanity-check the enterprise-tier pricing against your CFO benchmark data? No rush — by Thursday EOD would be great." } }]`
- `valueRationale`: *"Minimal tier (write a memo from scratch with no competitive grounding) delivers ~30% — the user still has to scrape competitors, compare manually, get advisor input, and remember to file the decision. Maximalist delivers ~95% — the memo lands in the wiki with grounded competitor data, the advisor gets a ping with the right context, and next quarter's discussion compounds on this one. The wiki integration is the multiplier: this isn't just a one-time output, it's a permanent node in the knowledge graph."*

**Demonstrates:** zero PC apps; web-research-heavy; wiki write-back as a first-class artifact destination; stakeholder ping over Slack instead of email; the maximalist value comes from compounding into Phase 1.5's wiki rather than from local-app integration.

---

#### Example 3 — Technical/code: "Refactor auth module to support OAuth2"

This example exercises **codebase-as-recon-surface** + **CLI tool orchestration** (`gh`, `npm test`) + **no stakeholder touchpoints** (pure technical work) + **wiki decision page as authority**.

**Action:** `{ title: "Refactor auth module to support OAuth2", description: "Current auth uses session cookies. Need to add OAuth2 for the enterprise tier we're shipping in Q3. Reference the May decision page." }`

**Recon (condensed):**
- ReconResult: `cliTools: [git@2.43, gh@2.40, node@22.11, npm@10.5]`; `mcpServers: []`; relevant `existingSkills: [ "test-runner-helper" ]`; project type detected = TypeScript + Node (via `package.json` read by recon)
- WikiContext: `relevantPages: [auth-current (concept), 2026-may-oauth-decision (decision), session-cookie-pitfalls (concept)]`; `stakeholders: []` (no humans involved in this action); `endorsedDirections: ["Use 'jose' for JWT, not 'jsonwebtoken' — security review May 2026"]`; `pastDecisions: [{slug: "2026-may-oauth-decision", outcome: "Adopt OAuth2 PKCE flow for enterprise tier"}]`
- WebResearchContext: `bestPracticePatterns: [{pattern: "OAuth2 PKCE is the 2026 default for SPA + native clients"}]`; `appIntegrationSurfaces: []`

**SkillDesignProposal (key fields, maximalist tier):**
- `integrations`:
  1. **Codebase recon** — `invocationHint: { kind: 'bash-cmd', tools: ['Read', 'Grep', 'Glob'], snippet: '<find every session-cookie call site and every auth middleware import>' }`. Surfaced from `pc-scan` (Read/Grep/Glob always available).
  2. **Scaffold OAuth2 PKCE flow** — `invocationHint: { kind: 'bash-script', tools: ['Write', 'Edit'], snippet: '<create src/auth/oauth/{pkce-challenge,token-exchange,session-bridge}.ts with stub bodies>' }`. The skill body cites `wiki/decisions/2026-may-oauth-decision.md` as the authority.
  3. **Failing-test generation** — `invocationHint: { kind: 'bash-cmd', tools: ['Write', 'Bash(npm test *)'], snippet: 'npm test -- --reporter=json src/auth/oauth/*.test.ts' }`. Skill writes failing tests first; the user (or a future Claude session) fills the impl to make them pass. TDD shape baked into the skill.
  4. **Draft PR with wiki citation** — `invocationHint: { kind: 'bash-cmd', tools: ['Bash(gh pr create *)', 'Bash(git *)'], snippet: 'gh pr create --draft --title "auth: scaffold OAuth2 PKCE flow" --body-file references/pr-body.md' }`. PR body references the wiki decision page so reviewers have full context. **Veto baked in**: `vetoes: ["Do not use 'jsonwebtoken' npm package — use 'jose'. Reference: wiki/concepts/session-cookie-pitfalls.md"]`.
- `stakeholderTouchpoints: []` — this is a pure technical action; the wiki has no relevant humans, and the PR's reviewers come from the repo's CODEOWNERS file (out of the skill's scope).
- `valueRationale`: *"Minimal tier (write a refactor plan as markdown) delivers ~20% — the user still has to actually do the work. Maximalist delivers ~80% by scaffolding the file structure, writing failing tests, and opening a draft PR with the wiki decision cited. The remaining 20% is the actual logic implementation, which is correctly left to a Claude Code session running the failing tests — that's a separate composable skill (`test-runner-helper` exists in this user's environment). The wiki veto on `jsonwebtoken` ensures the skill won't regress the May security decision."*

**Demonstrates:** the recon surface is the user's codebase itself (Read/Grep/Glob); orchestrations are filesystem + git CLI + test runner + GitHub CLI; no MCPs needed; no stakeholders needed; wiki decisions become hard rules (`vetoes`) baked into the skill body. **An action with zero stakeholder touchpoints is a fully-valid maximalist tier as long as the integration count meets the ≥3 gate.**

---

#### Example 4 — Operational/people: "Hire 2 SDRs for the DK market"

This example exercises **stakeholder-heavy multi-channel comms** + **ATS integration via MCP** + **wiki-grounded targeting** + **no PC apps**.

**Action:** `{ title: "Hire 2 SDRs for the DK market", description: "Need 2 inside-sales hires for the Denmark expansion. Junior-mid level. 6-week hiring window." }`

**Recon (condensed):**
- ReconResult: `mcpServers: [google-calendar, slack, greenhouse]` (or a curl-against-ATS-API fallback if Greenhouse MCP isn't installed); `envVars: [GREENHOUSE_API_KEY, SLACK_BOT_TOKEN]`; no relevant PC apps
- WikiContext: `relevantPages: [icp-danish-smb (concept), sdr-role-template (concept), 2026-q2-hiring-loop (decision), team-roster (entity)]`; `stakeholders: [{slug: "julian-bent-singh", role: "founder/CEO", contactHints: "Slack: @julian"}, {slug: "team-roster", role: "hiring participants — see entity for full list"}]`; `endorsedDirections: ["DK hires must be native Danish speakers; remote-OK but Copenhagen-preferred"]`
- WebResearchContext: `bestPracticePatterns: [{pattern: "SDR pipelines for DK SMB: LinkedIn outreach + The Hub job board converts best in 2026"}]`; `appIntegrationSurfaces: []`

**SkillDesignProposal (key fields, maximalist tier):**
- `integrations`:
  1. **JD generation from ICP** — `invocationHint: { kind: 'write-artifact', tools: ['Write', 'Read'], artifactPath: 'references/sdr-jd-dk.md' }`. Skill reads `wiki/concepts/icp-danish-smb.md` + `wiki/concepts/sdr-role-template.md`, generates a tailored JD.
  2. **Post job via Greenhouse MCP** — `invocationHint: { kind: 'mcp-tool', tools: ['mcp__greenhouse__create_job', 'mcp__greenhouse__publish_to_board'] }`. Posts to internal Greenhouse + external job boards. **Fallback if MCP missing**: `fallbackIfMissing: "Emit references/job-board-post.md with copy-paste-ready text for LinkedIn / The Hub / Jobindex."`
  3. **Outreach templates for inbound + referrals** — `invocationHint: { kind: 'write-artifact', tools: ['Write'], artifactPath: 'references/outreach/{inbound-thank-you,referral-ask,linkedin-cold}.md' }`. Three templates, all Danish + English variants.
  4. **Intake-call slot blocking** — `invocationHint: { kind: 'mcp-tool', tools: ['mcp__google_calendar__create_event'] }`. Books 6 × 30-min intake slots over the hiring window. Title prefix "SDR intake — [name placeholder]" so the user can quickly identify them.
  5. **Team referral ask via Slack** — `stakeholderTouchpoints: [{ name: "Julian + team", touchpointKind: "slack-mention", produces: "send", sendVia: "mcp__slack__post_message", artifactTemplate: { body: "🇩🇰 Hiring 2 SDRs for DK expansion (junior-mid level, native DK speakers, Copenhagen-preferred-but-remote-OK). JD is at <link>. If anyone in your network would be a fit — please intro by DM or via the Greenhouse referral form. We're targeting decisions by [date+6weeks]." } }]`. 5 integrations on the maximalist tier; all from MCP + wiki + write-artifact surfaces.
- `valueRationale`: *"Minimal tier (write a JD only) delivers ~10% — there's still posting, sourcing, outreach, scheduling, team referral asks. Standard tier (JD + Greenhouse post) delivers ~40%. Maximalist delivers ~80% — the skill orchestrates the full kickoff: JD lands in references/, job posts go live via Greenhouse MCP, outreach templates are ready, intake slots are blocked in Calendar, and the team gets a Slack ping with the right context for referrals. The remaining 20% is candidate-specific work that compounds on this kickoff over the 6-week window."*

**Demonstrates:** zero PC apps, zero codebase recon; the skill is pure multi-MCP orchestration over Greenhouse + Calendar + Slack; wiki provides the targeting context (ICP + role template + DK-language directive); stakeholder touchpoint is "the team" via Slack rather than a single named person. **Demonstrates the upgrade path from `produces: 'artifact'` to `produces: 'send'` when matching MCP is granted.**

---

#### Example 5 — Browser-use only: "Run weekly LinkedIn outreach for the DK SDR pipeline"

This example exercises **GUI-driving via Claude Chrome extension** for a site (LinkedIn Sales Nav) that has no public API for individual users. Demonstrates `invocationHint.kind='chrome-extension'` + the user-handoff pattern via `handoffInstructions`.

**Action:** `{ title: "Run weekly LinkedIn outreach for the DK SDR pipeline", description: "Send personalized InMails to 25 prospects matching our DK ICP. Log who was contacted." }`

**Recon (condensed):**
- ReconResult: `mcpServers: [google-sheets]`; `chrome: true` (Claude Chrome extension detected installed + authed); no relevant PC apps; CLI tools standard
- WikiContext: `relevantPages: [icp-danish-smb (concept), outreach-templates (concept), do-not-contact-list (concept)]`; `vetoes: ["Never contact prospects from companies in do-not-contact-list"]`; no stakeholders
- WebResearchContext: `bestPracticePatterns: [{pattern: "LinkedIn rate-limits unsolicited InMail at ~100/week per account"}]`; `appIntegrationSurfaces: [{appName: "LinkedIn Sales Navigator", integrationKind: "none", invocationHint: { kind: "chrome-extension", tools: [], handoffInstructions: "<full sequence>" }, sources: [{title: "LinkedIn API: Sales Nav not in public surface 2026", url: "..."}] }]`

**SkillDesignProposal (key fields, maximalist tier):**
- `integrations`:
  1. **Pull prospect list from Sheets MCP** — `invocationHint: { kind: 'mcp-tool', tools: ['mcp__google_sheets__read_range'] }`. Reads `prospects-q3.xlsx!A2:E50`.
  2. **Filter against do-not-contact veto** — `invocationHint: { kind: 'bash-cmd', tools: ['Read', 'Write'], snippet: '<read wiki/concepts/do-not-contact-list.md; emit references/prospects-filtered.json>' }`. Pure transform; no external call.
  3. **GUI-driven outreach via Claude Chrome (the critical integration)** — `invocationHint: { kind: 'chrome-extension', tools: [], handoffInstructions: "Open Claude with the Chrome extension enabled and run: 'Navigate to https://www.linkedin.com/sales/. For each prospect in references/prospects-filtered.json, open their profile, click Message, paste references/templates/inbound-warm.md substituting [[first_name]] and [[company]], and send. After each send, write the result (sent/skipped/error) to references/outreach-log.json as a JSONL row. Stop after 25 sends or if LinkedIn shows a rate-limit warning.' Return to this skill when done — Step 4 will tally the log." }`.
  4. **Log results back to Sheets MCP** — `invocationHint: { kind: 'mcp-tool', tools: ['mcp__google_sheets__append_row'] }`. Reads `references/outreach-log.json`, appends to a "Sent" tab with timestamp.
- `stakeholderTouchpoints: []` (none — the prospects are the destination, not stakeholders).
- `valueRationale`: *"LinkedIn Sales Nav has no public API for individual users — without the Chrome extension, this is 100% manual (open 25 profiles, copy-paste 25 messages, log 25 results in a sheet — easily 90 min/week). With Chrome as the integration mechanism, the user delegates the GUI work to a Claude session running with the extension. Minimal tier (write templates only) delivers ~10%. Maximalist delivers ~85% — the only manual step is launching the Chrome-enabled Claude session and confirming it finished. Long-term: when Anthropic ships in-skill programmatic Chrome access, this same proposal upgrades to direct invocation with zero brief changes."*

**Demonstrates:** `chrome-extension` invocationHint with full `handoffInstructions` payload; integration with no programmatic API gets full first-class treatment (not a fallback); recon surface is the Chrome extension's presence + Sheets MCP + wiki vetoes; **mixed kinds in one skill** (mcp-tool + bash-cmd + chrome-extension + mcp-tool again — chained).

---

#### Example 6 — Computer-use only: "Render the Q3 launch video edit timeline in DaVinci Resolve"

This example exercises **GUI-driving native desktop apps via computer-use** for an app (DaVinci Resolve) whose scripting API exists but is impractical to drive from a skill. Demonstrates `invocationHint.kind='computer-use'`.

**Action:** `{ title: "Render the Q3 launch video edit timeline in DaVinci Resolve", description: "Project is at projects/q3-launch.drp. Need 1080p MP4 export to exports/q3-launch.mp4. Render after Mads finishes the edit pass." }`

**Recon (condensed):**
- ReconResult: `apps: [{name: "DaVinci Resolve", version: "18.6", category: "creative"}, {name: "Premiere Pro", version: "2024", category: "creative"}]`; computer-use availability detected (best-effort: Anthropic computer-use API enabled if user has the SDK); no MCPs relevant; CLI: `ffmpeg`
- WikiContext: `relevantPages: [q3-launch (concept), youtube-render-spec (concept)]`; `endorsedDirections: ["Always render YouTube at 1080p/60fps, H.264, 16Mbps target bitrate"]`; no stakeholders
- WebResearchContext: `appIntegrationSurfaces: [{appName: "DaVinci Resolve", integrationKind: "sdk", invocationHint: { kind: "computer-use", tools: [], handoffInstructions: "<full sequence>" }, workflow: ["DaVinci has a Python scripting API (DaVinciResolveScript) but requires Studio license + custom python env setup", "Computer-use is the practical surface for unattended renders"], sources: [...]}]`

**SkillDesignProposal (key fields, maximalist tier):**
- `integrations`:
  1. **Read render spec from wiki** — `invocationHint: { kind: 'bash-cmd', tools: ['Read'], snippet: 'Read wiki/concepts/youtube-render-spec.md' }`. Pulls the 1080p/60fps/16Mbps directive.
  2. **GUI-driven render via computer-use** — `invocationHint: { kind: 'computer-use', tools: [], handoffInstructions: "Open Claude Desktop with computer-use enabled and run: 'Open DaVinci Resolve. Open project at projects/q3-launch.drp. Switch to the Deliver page. Set Render Settings to: format=MP4, codec=H.264, resolution=1920×1080, framerate=60fps, bitrate=16000 (kbps target). Set output path to exports/q3-launch.mp4. Add to Render Queue. Click Start Render. Watch progress until the queue item shows Status: Complete. Report the final file size and any errors.' Return when done." }`.
  3. **Validate output via ffmpeg** — `invocationHint: { kind: 'bash-cmd', tools: ['Bash(ffmpeg -i *)'], snippet: 'ffmpeg -i exports/q3-launch.mp4 2>&1 | grep -E "Stream|Duration"' }`. Verifies the file matches the spec (resolution, fps, codec).
  4. **Generate handoff note for Mads** — `invocationHint: { kind: 'write-artifact', tools: ['Write'], artifactPath: 'references/render-handoff-mads.md' }`. Brief note for the editor with the file path, render specs, and a "ready for next pass" flag.
- `stakeholderTouchpoints: [{name: "Mads Larsen", role: "video editor", touchpointKind: "doc-share", produces: "artifact", artifactPath: "references/render-handoff-mads.md", artifactTemplate: {body: "Mads — Q3 launch render is at exports/q3-launch.mp4 (1080p/60fps, ~16Mbps). Validated via ffmpeg. Ready for your next pass."}}]`
- `valueRationale`: *"DaVinci's Python scripting API exists but requires DaVinci Studio license + a configured Python environment per machine — most users don't have either. The skill can absolutely encode the render workflow but can only EXECUTE it via computer-use today. Minimal tier (write a checklist of render settings) delivers ~5%. Maximalist with computer-use delivers ~80% — the user launches computer-use-enabled Claude once and the render runs unattended with validation. The wiki integration (auto-apply the 1080p/60fps spec from the endorsed direction) eliminates the manual-settings-lookup step that's the most error-prone part of unattended rendering."*

**Demonstrates:** `computer-use` invocationHint with full `handoffInstructions`; native desktop app with no usable scripting surface gets first-class integration treatment; wiki's endorsed directions become render-spec parameters; chain of (read spec → drive GUI → validate output → emit handoff note) shows that computer-use composes with other invocationHint kinds in the same skill.

---

#### Example 7 — Mixed (the showpiece): "Close the books for May 2026 and send investor update"

This example exercises **all five primary invocationHint kinds in one skill** — MCP, Chrome extension, computer-use, write-artifact, and bash-cmd. It's the spec's showcase of true agentic multi-surface orchestration for complex recurring workflows.

**Action:** `{ title: "Close the books for May 2026 and send investor update", description: "Monthly investor update: pull May revenue/cash position, populate the P&L sheet, post the update to Carta investor portal, paste numbers into the Notion investor doc, send personalized briefs to each of the 6 investors." }`

**Recon (condensed):**
- ReconResult:
  - `mcpServers: [stripe, mercury, google-sheets]` — financial data sources + the master spreadsheet
  - `apps: [{name: "Notion", version: "2.x", category: "productivity"}]` — Notion desktop installed, but the user is on the **free Notion plan which has no API for personal accounts**, so paste-via-computer-use is the bridge
  - `chrome: true` — Claude Chrome auth detected; needed for Carta (Carta's investor-update API is enterprise-tier only; the user is on the free founder plan)
  - `cliTools: [git, gh, pandoc]` — pandoc available for PDF generation
  - `envVars: [STRIPE_KEY, MERCURY_API_KEY]`
- WikiContext:
  - `relevantPages: [2026-q2-revenue-targets (decision), investor-list (entity), investor-john-doe (entity), investor-jane-smith (entity), ..., monthly-investor-update-format (concept)]`
  - `stakeholders: [{slug: "investor-john-doe", name: "John Doe", role: "Series A lead investor", contactHints: "email: john@acmevc.com; prefers concise briefs"}, ...×6]`
  - `endorsedDirections: ["Investor updates lead with cash runway, then MoM revenue growth, then top-3 wins, then asks"]`
- WebResearchContext: `bestPracticePatterns: [{pattern: "Monthly investor updates correlate with follow-on rounds — consistency > polish"}]`; `appIntegrationSurfaces: [{appName: "Carta investor portal", integrationKind: "none", invocationHint: {kind: "chrome-extension", ...}}, {appName: "Notion (free tier)", integrationKind: "none", invocationHint: {kind: "computer-use", ...}}]`

**SkillDesignProposal (key fields, maximalist tier — 8 integrations, the spec's most ambitious example):**

1. **Pull May revenue from Stripe MCP** — `kind: 'mcp-tool', tools: ['mcp__stripe__list_charges', 'mcp__stripe__report_revenue']`. Date range 2026-05-01 to 2026-05-31.
2. **Pull cash position from Mercury MCP** — `kind: 'mcp-tool', tools: ['mcp__mercury__get_balance', 'mcp__mercury__list_transactions']`. End-of-May balance + burn calc from May tx.
3. **Populate the P&L sheet via Sheets MCP** — `kind: 'mcp-tool', tools: ['mcp__google_sheets__update_range']`. Writes May columns into the existing investor P&L spreadsheet.
4. **Generate the master investor update PDF** — `kind: 'bash-cmd', tools: ['Bash(pandoc *)', 'Write'], snippet: "pandoc references/investor-update-may-2026.md -o references/investor-update-may-2026.pdf --pdf-engine=xelatex"`. Skill drafts the markdown first using the format from the wiki concept page + the cash/revenue numbers + the wiki's endorsed lead-with-runway directive.
5. **Post the update to Carta via Chrome extension** — `kind: 'chrome-extension', tools: [], handoffInstructions: "Open Claude with Chrome enabled and run: 'Navigate to https://app.carta.com/portfolio/<user-slug>/updates/new. Set title to "May 2026 monthly update". Paste the body from references/investor-update-may-2026.md (rendered text, not markdown). Attach references/investor-update-may-2026.pdf. Click Publish. Confirm the published URL appears.' Capture the published URL and write it to references/carta-published-url.txt."`. Carta's investor portal has no public API on founder plan tier — Chrome extension is the only bridge.
6. **Paste numbers into Notion investor doc via computer-use** — `kind: 'computer-use', tools: [], handoffInstructions: "Open Claude Desktop with computer-use enabled and run: 'Open Notion. Navigate to the page Monthly Investor Tracking → May 2026. Paste the values from references/may-numbers.json into the corresponding cells (Cash, MRR, Burn, Runway). Save (Notion auto-saves but confirm via the sync indicator). Take a screenshot for archive at references/notion-paste-archive.png.' Return when done."`. Notion's free tier has no API access — computer-use is the bridge.
7. **Draft 6 personalized investor emails** — `kind: 'write-artifact', tools: ['Write'], artifactPath: 'references/emails/<investor-slug>.md'` (one per investor). Each draft personalized using the wiki entity's contactHints (e.g., "prefers concise briefs" → shorter version for John Doe; "asks technical questions" → more detail on the engineering wins for Jane Smith). Attachment: link to the just-published Carta URL.
8. **Final delivery checkpoint** — `kind: 'bash-cmd', tools: ['Bash(ls -la references/*)'], snippet: 'ls -la references/emails/ references/investor-update-may-2026.pdf references/carta-published-url.txt'`. Self-verification that every artifact exists before reporting success.

- `stakeholderTouchpoints`: 6 entries, one per investor — each with `produces: 'artifact'` (the user reviews + sends manually because investor relations is high-stakes).
- `valueRationale`: *"This monthly workflow currently takes ~4 hours: gathering numbers (45 min), drafting the update (90 min), posting to Carta (15 min navigation), updating Notion (15 min), drafting 6 personalized emails (90 min). Minimal tier (write a template) delivers ~5%. Standard tier (numbers + draft) delivers ~40%. Maximalist delivers ~90% — every system gets touched in the right order, the wiki's lead-with-runway directive shapes the narrative, and each investor gets a personalized brief drawing on their wiki entity's documented preferences. The 10% the user keeps is the high-stakes review + send step on the 6 emails. **This is the showcase of mixed multi-surface orchestration:** 3 MCPs + 1 CLI tool + 1 Chrome-extension session + 1 computer-use session + 6 artifact drafts, all chained into one repeatable skill."*

**Demonstrates:** the full agentic stack composed in one skill — every primary invocationHint.kind is present; the recon surfaces are MCP + PC app + Chrome auth + wiki entities; the orchestration mixes programmatic (MCP, bash) + GUI-driven (Chrome, computer-use) + artifact (drafts); stakeholder touchpoints are high-volume (6 personalized emails); wiki provides BOTH the format directive AND the per-investor personalization data. **The maximalist integration count is 8 — well above the ≥3 gate — proving that for complex recurring workflows the maximalist tier can stretch far past the minimum.**

---

**Across all seven examples, the abstract pattern holds:**

| | Ex 1 Elgato | Ex 2 pricing | Ex 3 auth | Ex 4 SDR | Ex 5 LinkedIn | Ex 6 DaVinci | Ex 7 investor update |
|---|---|---|---|---|---|---|---|
| **Primary recon surface** | PC app (API) | Web + wiki | Codebase | MCPs | Chrome + MCP | PC app (no API) | MCPs + Chrome + computer-use |
| **PC apps used** | Elgato | none | none | none | none | DaVinci Resolve | Notion desktop |
| **MCPs used** | Calendar | Sheets | none | Greenhouse, Calendar, Slack | Sheets | none | Stripe, Mercury, Sheets |
| **Chrome extension used?** | no | no | no | no | **yes** (LinkedIn) | no | **yes** (Carta) |
| **Computer-use used?** | no | no | no | no | no | **yes** (DaVinci GUI) | **yes** (Notion paste) |
| **Stakeholders** | 1 (editor, email) | 1 (advisor, slack) | 0 | 1 (team, slack) | 0 | 1 (editor, doc-share) | 6 (investors, email) |
| **Wiki signal used** | tone concept | competitor entities + advisor | decisions + vetoes | ICP + role template | do-not-contact veto | render spec | endorsed format + per-investor prefs |
| **invocationHint kinds present** | bash-curl, mcp-tool, write-artifact | mcp-tool, write-artifact, send | bash-cmd, bash-script, mcp-tool-via-gh | mcp-tool ×3, write-artifact | mcp-tool, bash-cmd, **chrome-extension** | bash-cmd, **computer-use**, write-artifact | **all 5 kinds** + bash-cmd |
| **Maximalist integration count** | 4 | 4 | 4 | 5 | 4 | 4 | **8** |

The integration count consistently hits ≥3. The surfaces, orchestrations, integration kinds, and stakeholder shapes vary wildly. **The seven-example set is calibrated so the Planner learns three things at once:**

1. **The pattern is domain-neutral** (Examples 1-4 across creative/strategic/technical/operational).
2. **No-programmatic-integration is NOT a reason to drop tier** (Examples 5-6 — Chrome and computer-use are first-class integration kinds, not fallbacks).
3. **Complex workflows deserve mixed multi-surface orchestration** (Example 7 — five integration kinds chained in one skill).

If a Planner output for any new action ever proposes <3 maximalist integrations citing "the user has no API for X," the prompt has failed to internalize Examples 5+ and the few-shot library needs reinforcement.

### 6.6 User review — proposal acceptance

The Planner's proposal is rendered in two surfaces:

**CLI (`enquirer`):**

```
╭────────────────────────────────────────────────────────────────────────────╮
│ Skill Planner proposal: launch-dk-ad-campaign                              │
│ Tier recommendation: maximalist                                            │
│                                                                            │
│ Value rationale: "This action has three high-impact tools the user        │
│ already has — HubSpot MCP for the actual send, Google Calendar MCP for     │
│ practice/launch reminders, and Person X (your designer, per wiki) for     │
│ creative review. A minimal markdown checklist would deliver ~15% of the    │
│ total value; maximalist delivers ~95% by automating each handoff."        │
│                                                                            │
│ Integrations the Planner found:                                            │
│   [x] HubSpot MCP (mcp-server)         · send the campaign directly       │
│   [x] Google Calendar MCP (mcp-server) · book recording + practice slots  │
│   [x] Person X email draft (wiki)      · auto-draft brief for designer    │
│   [x] WebSearch                        · pull live competitor pricing     │
│   [ ] Elgato Teleprompter (pc-app)     · load the script (not relevant)   │
│   [x] Bash(git status, git diff)       · capture state for the brief      │
│                                                                            │
│ Stakeholders to touch:                                                     │
│   [x] Person X (designer) — draft email                                    │
│   [ ] Person Y (lawyer) — skip; no compliance ask                          │
│                                                                            │
│ Proposed workflow (12 steps) [view full]                                  │
│                                                                            │
│ Ambition tier: ( ) minimal  ( ) standard  (●) maximalist  ( ) custom      │
│                                                                            │
│ [Edit narrative]  [Accept and run]  [Reject and re-plan]  [Cancel]        │
╰────────────────────────────────────────────────────────────────────────────╯
```

User can:
- **Toggle integrations** on/off (each toggle removes/adds entries from the final `allowed-tools` allowlist + corresponding workflow steps).
- **Toggle stakeholder touchpoints** on/off.
- **Drop ambition tier** — `maximalist` → `standard` → `minimal` strips integrations down to the lower tier's set.
- **Edit narrative** — opens `$EDITOR` on the proposal's `valueRationale + proposedWorkflow + stakeholderTouchpoints` so the user can rewrite freely. Saved as `userNarrativeEdits`.
- **Reject and re-plan** — re-run §6.5 with the user's free-form feedback as additional input. Cap: 3 re-plans before forcing accept-or-cancel.

**Narrative edits vs re-plan feedback — important distinction (T2.1):**

These are two different verbs that look superficially similar. The spec distinguishes:

| Action | Cost | What happens | When to use |
|---|---|---|---|
| **Edit narrative** | **$0** — no LLM call | User's free-form markdown is APPENDED to the brief verbatim. Saved as `SkillCapabilityProfile.userNarrativeEdits`. skill-creator reads it as additional context on top of the Planner's proposal. Doesn't change `integrations[]`, `proposedWorkflow[]`, or `grantedTools`. | "I want to add a step where the skill also posts to LinkedIn after the video is up." — additive instruction the Planner already structured the proposal correctly, you just want to tack on. |
| **Re-plan with feedback** | **~$1.74** — full Planner re-run | The Planner re-runs §6.5 with the user's feedback string injected into the prompt as `<replan_feedback>`. Recon is reused (no re-scan; no re-research) but reasoning is fresh. Produces a new `SkillDesignProposal` that the user reviews again. | "The Planner missed that I want to publish to LinkedIn too — please reconsider." — structural change to the integration set or workflow that requires the Planner to reason fresh. |

**UI surface** mirrors this in both CLI (`Edit narrative` vs `Reject and re-plan` buttons) and Web UI (`narrative editor textarea` always-available; `Re-plan with feedback` button opens a separate modal that requires the user to type ≥10 chars before submit). The cost difference is shown next to each action.

**Web UI:** equivalent surface as a modal — see §14.

### 6.7 The final `SkillCapabilityProfile` + grant list

After user acceptance, the Planner's proposal collapses into the `SkillCapabilityProfile` shape (ported from sage-council's `action-solution-types.ts` and extended):

```ts
interface SkillCapabilityProfile {
  generatedAt: string;
  proposal: SkillDesignProposal;              // the FULL proposal — skill-creator sees this verbatim
  acceptedTier: 'minimal' | 'standard' | 'maximalist' | 'custom';
  acceptedIntegrationIds: string[];           // user's checkbox selections
  rejectedIntegrationIds: string[];
  acceptedStakeholderTouchpoints: string[];
  userNarrativeEdits?: string;                // free-form additions from the $EDITOR / textarea
  fallbackPlans: SkillCapabilityFallbackPlan[];  // {capabilityId, mode, preferredOutputFormat, instruction}

  detectedEnvironment: ReconResult;            // §6.2 raw recon (kept for provenance)
  wikiContext: WikiContext;                    // §6.3
  webResearch: WebResearchContext;             // §6.4

  grantedTools: string[];                      // final allowed-tools allowlist for the emitted skill
  notes?: string;
}
```

`grantedTools` is the deterministic projection of accepted integrations onto Claude Code tool entries. Example for the campaign case above: `WebSearch, WebFetch, Read, Grep, Glob, Bash(git status, git diff), mcp__hubspot__send_campaign, mcp__hubspot__list_contacts, mcp__google_calendar__create_event, mcp__google_calendar__list_events, Write, Edit`.

**Over-promise validation gate (T2.4) — keeps the Planner honest.** The Planner may propose an integration that depends on a tool the user doesn't actually have installed (e.g., suggests `mcp__google_calendar__create_event` based on web research, but the user hasn't actually wired Calendar MCP yet — only `STRIPE_*` env vars showed up in recon). The projection step runs a **per-integration validation pass** before producing `grantedTools`:

1. For each accepted integration, walk its `requiredTools[]`.
2. For each tool entry, check the recon evidence:
   - `mcp__<server>__<tool>` → check `ReconResult.mcpServers[]` contains `<server>` and the server's `tools[]` lists `<tool>`.
   - `Bash(<cmd> *)` → check `ReconResult.cliTools[]` contains `<cmd>` (or `<cmd>` is in the always-available set: `curl, ls, cat, grep, find, mkdir, mv, cp`).
   - `WebSearch, WebFetch, Read, Write, Edit, Glob, Grep` → always available.
3. If any tool is unbacked, append the integration to `proposal.mismatchedIntegrations[]` with the specific reason and a suggestion (e.g., "Install Calendar MCP: `claude mcp add google-calendar ...`"). Do NOT add its `requiredTools[]` to the projection.
4. Surface mismatches prominently in the user-review surface BEFORE accept — the user can install the missing tool and re-validate, or remove the integration, or accept the fallback.

This avoids the failure mode where a Planner-optimistic skill installs successfully but fails at runtime with "tool not found." Critical for trust.

**Degraded-recon visibility (T2.3).** The `proposal.warnings[]` array (populated by the recon orchestrator) surfaces in the user-review modal as a yellow banner before the proposal renders. CLI prints to stderr. Example warnings:

- `{phase: "web-research-general", severity: "warn", message: "Web research timed out after 12 turns — proposal may miss recent best-practice patterns. Re-plan to retry."}`
- `{phase: "wiki-recon", severity: "info", message: "Wiki has no entries about this domain — proposal is based on PC scan + web research only."}`
- `{phase: "pc-scan", severity: "error", message: "PC scan cache is stale (>24h) and refresh failed — using last known inventory."}`

### 6.7a Cost preview before the Planner runs (T2.2)

The Planner spends $1.74-ish per run; users shouldn't burn that money to discover the proposal is uninteresting. Before any LLM call fires, `aab actions solve` / `aab actions plan` runs a sub-second deterministic **scope estimation**:

```
$ aab actions solve a3f2
Skill Planner cost preview (no LLM calls yet):
  Recon scope:
    PC scan:        ~180 apps, 23 CLI tools (cached, <1s)
    Wiki recon:     ~12 candidate pages, est 8 turns         ~$0.10
    Web research:   general pass (12 turns) + per-app pass
                    on top 5 apps (×6 turns each)            ~$0.55
  Planner reasoning: Opus 4.7 1M, ~60k input + ~8k output    ~$1.50
                                                             ─────────
  Estimated total before solve:                              ~$2.15
  Budget cap (settings.skill.budgetCapUsdPerPlan):           $2.50

Continue? (y/N/--yes to skip this prompt)
```

The estimate uses fixed multipliers (cached per model in `src/llm/pricing.ts`) × predicted token counts based on recon scope (page count, app count, action text length). Within ±15% of actual in practice. Skipped entirely with `--yes` (CI mode).

**Budget cap enforcement:** if estimate exceeds `budgetCapUsdPerPlan`, abort with a clear hint pointing at the setting and the offending phase ("most of the cost is per-app web research × 5 apps; try `--planner-no-web` or `--planner-tier standard`"). If actual cost during run exceeds estimate by >25%, log a telemetry event but don't abort mid-run (we'd lose the partial work).

### 6.8 `--no-planner` mode

Skips the Planner entirely. Uses the **inferred-only** path (regex pattern matching from sage-council's `skill-preflight.ts` against action text → minimal-tier proposal). No PC scan beyond CLI tools, no wiki recon, no web research. Grant list defaults to the conservative set (`WebSearch, WebFetch, Read, Grep, Glob`). Logged warning: *"Planner skipped; emitted skill will be minimal-tier with no multi-tool orchestration. Re-run without `--no-planner` for the full agentic flow."*

CI use case + cost-conscious users. Default OFF — the Planner is the headline feature.

**Empty-recon fallback (T3.6).** If all three recon phases return empty (no PC apps detected, wiki has no relevant pages, web research fails or returns no useful hits), the Planner still produces a valid `SkillDesignProposal` — just one where the maximalist tier is identical to the standard tier (no ≥3 orchestrations available), `recommendedTier: 'minimal'`, and `valueRationale` explicitly states *"This action has no leverageable environment integrations the Planner could surface. The minimal-tier skill (text artifact) is the honest recommendation."* The schema validator's "≥3 integrations on maximalist" hard gate is relaxed in this specific path — empty-recon is a recognized degraded mode, not a re-plan trigger.

**Re-using a saved plan (T3.4).** `aab actions solve <id>` always re-runs the Planner by default (recon is fresh; environment may have changed since last plan). Flag `--reuse-plan <plan-id>` skips Planner re-run and uses a saved `SkillDesignProposal` from a previous `aab actions plan` invocation. Useful when: the user generated a plan, reviewed it, then `--no-install` solved it, and now wants to solve again with `--install` without re-burning the Planner cost.

### 6.9 Cost + duration

Per-solve Planner cost breakdown (Opus 4.7 + Sonnet, with prompt caching, updated for two-pass web research from T1.3):

| Phase | Model | Tokens (in/out) approx | Cost approx |
|---|---|---|---|
| PC scan (cached) | — (Node) | 0 | $0 |
| Wiki recon | Sonnet | 15k/3k | $0.09 |
| Web research pass 1 (general) | Sonnet (WebSearch) | 25k/5k | $0.15 |
| Web research pass 2 (per-app × 5) | Sonnet (WebSearch) | 10k/2k × 5 | $0.40 |
| Skill Planner reasoning | Opus 4.7 (1M) | 70k/10k | $1.70 |
| **Planner subtotal** | | | **~$1.74** |
| skill-creator authoring | Sonnet | varies (40k/15k typ.) | $0.45 |
| **Total per solve** | | | **~$2.20** |

Wall-clock: Planner 2–4 min, skill-creator 3–10 min, total 5–14 min. Hard cap 25 min (raised from 15 min in §5 since the Planner adds time).

Budget cap behavior: if projected Planner cost exceeds `settings.skill.budgetCapUsdPerRun`, abort before §6.5 with a clear error pointing at the cap.

---

## 7. Brief assembly — what we send to skill-creator

skill-creator's input is the user message of the `claude -p` call. The brief is **mostly the Planner's accepted proposal verbatim**, because the Planner has already done the deep reasoning — skill-creator's job is to execute on that vision, not to re-reason. We send a single JSON block:

```json
{
  "action": {
    "id": "<short-id>",
    "title": "<action title>",
    "description": "<action description>",
    "priority": "high",
    "linkedDiscussion": {
      "id": "<short-id>",
      "summary": "<full ConversationSummary payload>"
    }
  },
  "skillPlannerProposal": {
    /* The FULL SkillDesignProposal from §6.5, including:
       - skillName, skillSummary, triggerLanguage
       - acceptedTier (e.g., "maximalist")
       - integrations[] (only the user-accepted ones, each with workflowSteps + requiredTools + fallbackIfMissing + citations)
       - proposedWorkflow[] (the ordered steps the skill should execute)
       - stakeholderTouchpoints[] (the touch points the user accepted)
       - vetoes[]
       - valueRationale
       - userNarrativeEdits (free-form additions the user wrote in $EDITOR)
    */
  },
  "capabilityProfile": {
    /* SkillCapabilityProfile from §6.7 — just the post-acceptance summary:
       grantedTools, fallbackPlans, the detectedEnvironment subset relevant to granted tools */
  },
  "installTarget": {
    "scope": "project",
    "path": ".claude/skills/launch-dk-ad-campaign/",
    "skillName": "launch-dk-ad-campaign"
  },
  "constraints": {
    "frontmatter": "Claude Code spec; see when_to_use, allowed-tools, model, etc.",
    "allowedTools": "<final allowlist string>",
    "bodyMustExecute": "Encode the proposed workflow as ordered, executable steps using ONLY the tools in allowedTools. Do not produce a 'how-to guide' — produce an execution system prompt.",
    "invocationHintsAreLoadBearing": "For EACH integration in skillPlannerProposal.integrations[], the emitted SKILL.md body MUST include the literal invocationHint.snippet inside a code block (```bash or ```yaml as appropriate to invocationHint.kind). You MAY surround the snippet with context, validation logic, and follow-up steps — but you MUST NOT paraphrase, abbreviate, or rewrite the snippet. The snippet is the contract. (T2.5)",
    "fallbacks": "For each integration with fallbackIfMissing set, emit explicit fallback behavior.",
    "stakeholderHandoffs": "For each stakeholderTouchpoint where produces='artifact', write the artifact to artifactPath using the artifactTemplate verbatim (with placeholder substitution for [user], [launch-date], etc. — leave bracketed placeholders for runtime fill if values are unknowable at build time). For produces='send', use sendVia exactly as the mcp tool entry.",
    "bodySize": "≤500 lines for SKILL.md; everything else in references/ or scripts/.",
    "provenanceFooter": "Append: '> Generated by aab actions solve from action <short-id>; planner tier <tier>; <N> integrations.'",
    "vetoesAreMandatory": "For each entry in skillPlannerProposal.vetoes[], emit a 'MUST NOT' line in the SKILL.md body matching the veto exactly. These are user-asserted anti-patterns the skill must never violate at runtime."
  }
}
```

**Why the Planner's proposal is the brief's core, not a hint:** skill-creator is excellent at the *authoring* loop (write SKILL.md, write supporting files, self-critique, repair). It is not optimized for the *creative ambition* step ("notice the user has Elgato Teleprompter and Person X in the wiki and Google Calendar MCP — chain them"). That step is the Planner's job, and the Planner's output must reach skill-creator with full fidelity so the emitted skill orchestrates the integrations the Planner identified.

**Cap sizes:** total brief ≤60 KB (raised from 30 KB to accommodate the Planner proposal). The Planner's proposal can be up to ~30 KB on a maximalist tier with 10+ integrations + stakeholders + workflow steps. Truncation priority if over cap: `webResearch.recentInnovations` → `integrations[].citations` → `webResearch.bestPracticePatterns[].sources` → `userNarrativeEdits` (last; user authorship is precious).

---

## 8. skill-creator invocation — the headless pattern

```ts
// src/core/skill/invoke-skill-creator.ts (sketch)
const skillCreatorPath = await resolveSkillCreatorPath();  // checks .claude/skills/, ~/.claude/skills/, plugin scopes
if (!skillCreatorPath) throw new UserError('skill-creator skill not installed', {
  hint: 'Run `aab init --install-skill-creator` or `/plugin install skill-creator@claude-plugins-official` inside Claude Code.',
});

const runId = generateUUID();
const workspaceDir = paths.skillRunWorkspace(runId);  // ~/.aabcli/<ws>/skill-runs/<runId>/workspace/
await mkdirAtomic(workspaceDir);

const briefJson = JSON.stringify(brief);
const userMessage = `Author a Claude Code skill matching this brief. Write all files into the current working directory. When done, print a single line: SKILL_CREATOR_DONE: <skill-name>\n\nBrief:\n\`\`\`json\n${briefJson}\n\`\`\``;

const result = await runClaude({
  prompt: userMessage,
  appendSystemPromptFile: `${skillCreatorPath}/SKILL.md`,
  allowedTools: ['Write', 'Edit', 'Read', 'Glob', 'Bash'],
  cwd: workspaceDir,
  timeoutMs: 15 * 60_000,
  outputFormat: 'stream-json',
  model: settings.primaryModel,  // sonnet by default
  onEvent: (event) => {
    // emit WS broadcasts: skill_run_step, skill_run_tool_call, etc.
  },
});
```

**Why `--append-system-prompt-file`** (vs `--system-prompt`): the `--append` flag adds to Claude Code's default system prompt rather than replacing it. We want skill-creator's instructions PLUS the default Claude Code system prompt (which contains tool-use protocols, file-edit semantics, etc.). Verified pattern from skill-creator's own SKILL.md guidance.

**`outputFormat: 'stream-json'`** streams events as JSONL: `{type: 'tool_use', name: 'Write', input: {path, content}}` etc. We render these to TTY (`Turn 3: Write SKILL.md (1,847 chars)`) and broadcast over WS.

**Why `Bash` is in `allowedTools`:** skill-creator's own SKILL.md may run `bash` for scaffolding (`mkdir references/`, validate-frontmatter scripts, etc.). It's authoring inside a tempdir we own — safe.

**Timeout 15 min** is the hard cap. skill-creator's median run is ~5 min. If it exceeds, log telemetry, mark `SkillGenerationRun.status = 'failed'`, surface in the GUI.

**Failure modes:**

| Failure | Handling |
|---|---|
| Timeout (15 min) | Mark run failed; preserve workspace dir for post-mortem. |
| Non-zero exit | Mark run failed; capture stderr in run metadata. |
| No `SKILL.md` produced | Mark run failed with reason "skill-creator did not emit SKILL.md". |
| `SKILL.md` produced but missing required frontmatter | Pass to adapter (§9) which fixes if possible, else fails. |
| Capacity / 529 / 429 | Retry with exponential backoff (1s, 2s, 4s; cap 3 retries). |
| User Ctrl+C | Mark run cancelled; preserve workspace. |

---

## 9. Adapter pass — frontmatter normalization

skill-creator generally emits good frontmatter (it's Anthropic's own skill), but defense in depth matters. The adapter (`src/core/skill/adapter.ts`) runs after the workspace is authored:

1. **Parse `SKILL.md` frontmatter** with a YAML parser.
2. **Required fields present?**
   - `name`: kebab-case, ≤64 chars. If absent, derive from skill name.
   - `description`: includes "Use when …" trigger language. If absent, prepend `Use when ${action.title}. ${description}`.
3. **Combined `description + when_to_use` ≤ 1,536 chars** (the Claude Code listing cap). If over, truncate `when_to_use` with `…` marker.
4. **`allowed-tools` matches granted set.** If skill-creator added a tool not in `grantedTools`, log a warning and remove it. If skill-creator omitted a granted tool the skill body references, add it.
5. **Drop sage-council-style invented keys** if any leak through: `trigger_queries, dependencies, file_types, safety_mode, estimated_tokens, estimated_time_minutes, examples, notes` → fold their content into body sections (e.g., `trigger_queries[]` becomes a bulleted list inside `when_to_use:`).
6. **`model: inherit`** by default unless skill-creator picked a specific model with reason.
7. **`paths:` glob present?** If the action is scoped to a path subset (e.g., "fix all React components"), set `paths: 'src/**/*.{tsx,jsx}'` so the skill auto-activates only there.
8. **Reserved-name check (T3.7).** Skill names matching well-known Anthropic-shipped skills are refused: `skill-creator, master-gpt-prompter, wiki-ingest, wiki-query, wiki-lint`. The adapter throws with a hint pointing the user at `--skill-name <name>`.
9. **Diff preview** — log the diff between skill-creator's emit and the post-adapter result. Surface to user in dry-run preview (§5 step 5).

**Bonus checks:**

- SKILL.md body ≤500 lines (warn if over; suggest moving content to `references/`).
- All file paths in body match files in workspace (no dangling references).
- All MCP tool references in body match `allowed-tools` entries.

---

## 10. Install + conflict handling

```ts
// src/core/skill/install.ts (sketch)
const installPath = resolveInstallPath(opts);  // .claude/skills/<name>/ (project) or ~/.claude/skills/<name>/ (user)

if (existsSync(installPath)) {
  const action = opts.yes ? 'overwrite' : await askConflict(installPath);
  if (action === 'abort') throw new UserError('install aborted by user');
  if (action === 'rename') installPath = uniqueRename(installPath);  // <name>-2, <name>-3, ...
  if (action === 'overwrite') {
    await archiveExisting(installPath);  // mv → .snapshots/skills/<name>-<timestamp>/
  }
}

await cpRecursive(workspaceDir, installPath);
// Write a tiny .aab-source.json sidecar so future runs know provenance:
await writeJson(`${installPath}/.aab-source.json`, {
  actionItemId: action.id,
  runId,
  installedAt: nowIso(),
  generatedBy: 'aab actions solve',
});
```

**Why a `.aab-source.json` sidecar instead of an `# AAB:GENERATED` marker in SKILL.md:** SKILL.md's frontmatter is user-facing; we don't want to pollute it. A sidecar JSON file is invisible to Claude Code and unambiguous for future `aab actions runs` lookups. (Mirror the `# AAB:GENERATED` pattern in `emit-member-agent.ts` but in a sidecar.)

**Sidecar location (T3.9).** The sidecar lives at `~/.aabcli/<ws>/skill-runs/<runId>/installed-at.json` — NOT inside `.claude/skills/<name>/`. Putting it next to SKILL.md risks Claude Code loading it as a "support file" and possibly leaking the action item id / wiki references into the skill's context. Storing it under the workspace's `skill-runs/<runId>/` directory keeps provenance traceable without crossing into Claude Code's skill scope. `aab actions runs show <run-id>` reads it; `aab skills show <name>` can also look it up by reverse-mapping name → runId via the storage layer.

**`.snapshots/skills/<name>-<timestamp>/`** keeps the last N overwritten skills (default 5) so users can roll back via `aab skills restore <name> [--snapshot <ts>]`.

**No resume on retry (T3.10).** Failed or cancelled solve runs are abandoned. A user re-running `aab actions solve <id>` after a Ctrl+C starts a completely fresh run (new runId, new workspace, fresh Planner call). The previous run's workspace + telemetry is preserved per `preserveWorkspaceOnFailure` for post-mortem but never resumed from. This avoids the entire class of "partial state" bugs that the sage-council single-loop had to defend against.

**Concurrency (T3.8).** Two `aab actions solve` invocations on the same workspace serialize via the existing per-workspace mutex (`proper-lockfile`). Different action items in different workspaces run in parallel. Monthly budget cap is enforced workspace-globally — concurrent runs that would collectively exceed the cap fail the second-arriving run with a clear error.

---

## 11. Persistence — `SkillGenerationRun` + `linkedSkill`

Storage layout (already provisioned by Phase 4 storage interface):

```
~/.aabcli/<ws>/
├── skill-runs/
│   ├── <actionItemId>/
│   │   ├── <runId>.json          SkillGenerationRun metadata
│   │   ├── <runId>/telemetry.jsonl  per-step events from skill-creator
│   │   └── <runId>/workspace/    the live tempdir (preserved for post-mortem)
```

`SkillGenerationRun` shape (already at `src/storage/types.ts:464-494`):

```ts
{
  id: runId,
  actionItemId,
  status: 'completed',
  startedAt, completedAt,
  costUsd,         // from claude --output-format json envelope token usage
  cacheHitRate,    // from cache_read / cache_creation tokens
  durationMs,
  files: [{ path: 'SKILL.md', content, sizeBytes }, ...],  // full snapshot of emitted package
  installPath: '.claude/skills/launch-dk-ad-campaign/',
  metadata: {
    skillName,
    confirmedCapabilityProfile,  // full §6.4 shape
    agentEnvironment,            // detectedEnvironment from §6.4
    decompositionSubtaskCount,   // from skill-creator's plan, if extractable
    researchSourceCount,         // count of WebSearch citations in body
    singleLoopTurnCount,         // count of tool_use events
    criticScore,                 // skill-creator emits its own; capture if visible
    criticPassed,
    repairAttempts,
    securityReview: { mode, recommendation },
    triggerEvaluation: { precision, recall, shouldTrigger, shouldNotTrigger },
    potencyPassFileCount,
  },
}
```

Most `metadata.*` fields are best-effort (skill-creator may or may not emit them in a parseable form). Required: `skillName`, `confirmedCapabilityProfile`, `agentEnvironment`. Everything else is captured if present.

After successful run:

```ts
actionItem.linkedSkill = { name, runId, installedAt, installPath };
actionItem.skillRunHistory = [runId, ...(actionItem.skillRunHistory ?? [])];
actionItem.status = opts.completeOnInstall ? 'completed' : 'in-progress';  // default in-progress
await storage.saveActionItem(actionItem);
```

---

## 12. WebSocket event family

New events broadcast by `src/gui/server.ts` during a solve run:

| Event | Payload | When fired |
|---|---|---|
| `skill_run_started` | `{ runId, actionItemId, skillName, startedAt }` | After preflight, before skill-creator invoke |
| `skill_run_preflight_done` | `{ runId, profile: SkillCapabilityProfile }` | When wizard closes |
| `skill_run_step` | `{ runId, stepId, label, status: 'started'|'done' }` | Coarse progress (preflight / brief / authoring / adapter / install / persist) |
| `skill_run_tool_call` | `{ runId, turn, tool, inputSummary }` | Per skill-creator tool call (streamed from `--output-format stream-json`) |
| `skill_run_telemetry` | `{ runId, line }` | Per JSONL line written to telemetry.jsonl (for live tail) |
| `skill_run_adapter_diff` | `{ runId, diff }` | After adapter pass (for dry-run preview) |
| `skill_run_installed` | `{ runId, actionItemId, installPath, skillName, linkedSkill }` | After cp + persist |
| `skill_run_failed` | `{ runId, reason, errorMessage, telemetryPath }` | On any failure |
| `skill_run_cancelled` | `{ runId }` | On user Ctrl+C |
| `action_updated` | (existing event from Phase 4) | After `linkedSkill` write |

Mirrors the `member_thinking / member_response / orchestrator_decision` family from Phase 1 and the `sparring_thinking / sparring_message` family from Phase 3.

---

## 13. CLI surface

```
aab actions solve <id>                  Run Skill Planner → skill-creator → install for action <id>
  [--no-planner]                        Skip the Skill Planner; minimal-tier fallback (faster + cheaper)
  [--planner-tier minimal|standard|maximalist]   Cap Planner ambition (default maximalist)
  [--planner-no-web]                    Skip web research phase (§6.4)
  [--planner-no-pc-scan]                Skip PC scan (§6.2)
  [--skill-name <name>]                 Override auto-derived skill name
  [--no-install]                        Build but don't install
  [--zip <path>]                        Produce a portable ZIP at <path>
  [--install-path <path>]               Override install target
  [--scope project|user]                Default project (.claude/skills/), override to ~/.claude/skills/
  [--budget-cap-usd <n>]                Abort if projected cost exceeds
  [--single-loop-max-turns <n>]         Hint to skill-creator (default 60)
  [--debug]                             Verbose logs
  [--json]                              Machine-readable output
  [--yes|-y]                            Auto-accept Planner proposal + dry-run preview + overwrite on conflict

aab actions plan <id>                   Dry-run the Skill Planner only (no skill-creator invoke, no install)
  [--planner-tier minimal|standard|maximalist]
  [--planner-no-web] [--planner-no-pc-scan]
  [--json]                              Print the SkillDesignProposal as JSON
  [--out <path>]                        Save proposal markdown to <path>

aab actions runs <action-id>            List past skill-generation runs for one action
aab actions runs show <run-id>          View a run: status, files, planner proposal, telemetry, critic scores, security mode
aab actions runs export <run-id> --zip <path>   Export a run's skill package as a ZIP
aab actions runs delete <run-id>        Delete a run record (workspace + telemetry + metadata + proposal)

aab skills list                         Enumerate installed skills (.claude/skills/ + ~/.claude/skills/)
aab skills show <name>                  Pretty-print a skill's SKILL.md + sidecar metadata
aab skills test <name> "<input>"        Round-trip: dispatch the skill via Claude with the user input
aab skills uninstall <name>             Remove from .claude/skills/<name>/; archive to .snapshots/skills/
aab skills restore <name> [--snapshot <ts>]  Restore from .snapshots/skills/

aab init --install-skill-creator        Detect + install the official skill-creator skill (one-shot)
aab doctor                              Adds: skill-creator presence check + version; PC scan probe; web reachability probe
```

**`aab actions plan <id>` is a first-class command, not a debug flag.** Reasons: (a) users will want to see the Planner's proposal before committing to a solve (cheap discovery), (b) the proposal markdown is shareable on its own — paste into a team chat or git-commit it next to the action item before deciding to ship the skill, (c) it makes the Planner unit-testable end-to-end without spinning skill-creator.

**Already-shipped commands that gain Phase 5 awareness:** `aab init` adds an interactive "Install the official skill-creator skill?" step. `aab doctor` adds checks for `skill-creator` presence (errors if missing) and version (info if outdated).

---

## 14. Web UI surface

Mirrors Phase 4's pattern (`gui/app.js` + `gui/style.css` + `src/gui/server.ts` routes).

**New surfaces:**

| Surface | Where | What |
|---|---|---|
| **Solve button** | Action card detail panel (Kanban view) | Launches the solve pipeline |
| **Plan button** | Action card detail panel | Dry-runs the Skill Planner only (no skill-creator); opens proposal modal |
| **Planner progress pane** | Opens from Solve button | Live progress of the four-phase Planner: PC scan ▰▰▰▰▰▱▱▱ 5/8 apps, wiki recon ▰▰▰▱▱▱ 3 hits, web research ▰▰▰▰▰▰ 12 sources, reasoning ▰▰▰▰▰▰▰▰ done. Tool-call list streams over WS. |
| **Planner proposal modal** | Opens after Planner reasoning completes | The full `SkillDesignProposal` rendered as an interactive form: skill name + summary editable; integrations table with toggle-per-row + per-row "view workflow steps"; stakeholders table with toggle-per-row; ambition tier radio (minimal / standard / maximalist / custom); value rationale paragraph; cost estimate; **narrative editor** (textarea for free-form additions); **Accept and run** + **Re-plan with feedback** + **Reject** buttons |
| **Re-plan feedback modal** | Opens from "Re-plan with feedback" | Textarea: "what did the Planner miss? what should it lean harder into?"; submits a re-plan with the feedback appended to the recon input |
| **Run-detail view** | Opens after proposal accepted | Live telemetry pane (current step, turn count, tool-call list); adapter diff panel; install confirmation; abort button |
| **Runs list per action** | Action card detail panel | Past runs with timestamp + status pill + cost + planner tier + click-through |
| **Run export button** | Runs list row | Produces `.zip` download via `/api/skill-runs/:id/export` |
| **Proposal export button** | On run detail view + on plan modal | Produces a `.md` of the proposal — shareable in Slack / git |
| **Skill install confirmation panel** | After adapter pass, before install | Preview frontmatter diff (skill-creator emit vs adapter result) + final tool surface table + conflict handling (overwrite / rename / abort) |
| **Skills tab** | Sidebar (new) | List installed skills (project + user scope), test runner UI |

**New REST endpoints** (in `src/gui/server.ts`):

```
POST   /api/actions/:id/plan               Run the Skill Planner only; returns 202 + planId; SSE/WS streams progress + final proposal
POST   /api/plans/:planId/replan           Re-plan with user feedback; body = { feedback: string }
GET    /api/plans/:planId                  Get a plan + its proposal (also accepts ?as=md for markdown export)

POST   /api/actions/:id/solve              Start a solve run; body = accepted SkillDesignProposal; returns 202 + runId
GET    /api/actions/:id/runs               List runs for an action
GET    /api/skill-runs/:id                 Run detail (includes planner proposal in metadata)
GET    /api/skill-runs/:id/files/:path     Read a file from the run workspace
GET    /api/skill-runs/:id/telemetry       SSE stream of telemetry.jsonl
GET    /api/skill-runs/:id/export          Download .zip (includes proposal.md inside the bundle)
POST   /api/skill-runs/:id/abort           Cancel a running solve
DELETE /api/skill-runs/:id                 Delete a run record

GET    /api/skills                         List installed skills (project + user scope)
GET    /api/skills/:name                   Read a skill's SKILL.md + sidecar
POST   /api/skills/:name/test              Round-trip test with user input; returns SSE
DELETE /api/skills/:name                   Uninstall (archive)
POST   /api/skills/:name/restore           Restore from .snapshots

GET    /api/recon/environment              Run PC scan + MCP + env detection only; returns ReconResult (read-only; cheap; no LLM)
```

**New WebSocket events** (extend §12):

```
planner_started            { planId, actionItemId, tier }
planner_recon_progress     { planId, phase: 'pc-scan'|'wiki'|'web', completed, total, currentItem? }
planner_recon_done         { planId, phase, summary }   // e.g., { phase: 'pc-scan', apps: 47, cliTools: 23, mcp: 4 }
planner_reasoning_started  { planId, model: 'claude-opus-4-7' }
planner_reasoning_progress { planId, tokensIn, tokensOut, elapsed_ms }
planner_proposal_ready     { planId, proposal: SkillDesignProposal }
planner_failed             { planId, reason, errorMessage }
```

**New `data-testid` entries** (for Playwright MCP regression specs):

`solve-btn, plan-btn, planner-progress-pane, planner-phase-pc-scan, planner-phase-wiki, planner-phase-web, planner-phase-reasoning, planner-proposal-modal, proposal-skill-name, proposal-tier-radio, proposal-integration-row, proposal-integration-toggle, proposal-stakeholder-row, proposal-narrative-editor, proposal-accept-btn, proposal-replan-btn, proposal-reject-btn, proposal-export-btn, replan-feedback-modal, run-detail-view, run-telemetry-pane, run-tool-call-row, run-adapter-diff, run-install-preview, run-conflict-modal, run-abort-btn, runs-list, runs-row, run-export-btn, skills-tab, skills-list, skill-test-btn`.

---

## 15. Security model — `allowed-tools` is a grant, not a sandbox

**Critical to understand before designing the preflight UX:**

Per [Claude Code docs](https://code.claude.com/docs/en/skills) and confirmed by [GitHub issues #37683 and #14956](https://github.com/anthropics/claude-code/issues/37683), the `allowed-tools` frontmatter field is a **pre-approval grant**, not a runtime restriction:

- Tools listed in `allowed-tools` skip per-tool permission prompts while the skill is active.
- Tools NOT listed are still callable subject to `/permissions` (i.e., they'd prompt the user).
- With `--dangerously-skip-permissions` (the default in this repo per `src/llm/claude-code-runner.ts`), the skill effectively runs at whatever surface its body invokes.
- To **restrict** what a skill can do, use deny rules in `.claude/settings.json` or `Skill(<name>)` permission rules.

**Implications for the preflight wizard:**

1. The wizard's "grant" verb is honest — we are granting pre-approval, not sandboxing.
2. The wizard MUST surface this distinction to the user. The grant copy reads: *"Allow this skill to use HubSpot MCP without confirming each call?"* — not *"Restrict this skill to only HubSpot MCP."*
3. Skills authored by skill-creator should declare *only* tools they actually use. The adapter pass (§9) removes any tools in `allowed-tools` not referenced in the body.
4. The dry-run preview (§5 step 5) shows the final `allowed-tools` list prominently. Users must explicitly accept.
5. For maximum-stakes skills (e.g., one that calls `mcp__stripe__create_charge`), the SKILL.md frontmatter should set `disable-model-invocation: true` — meaning Claude won't auto-route to it; the user has to explicitly `/skill-name`. The preflight wizard adds an extra confirmation for any granted MCP tool whose name suggests destructive action (`*create*, *send*, *delete*, *charge*, *publish*, *deploy*`).

---

## 16. MCP integration in emitted skills

**Decided shape for v1: SKILL.md references `mcp__<server>__<tool>` in `allowed-tools`; user installs the MCP server out-of-band.**

This is the simpler of two paths Anthropic documents:

**Path A (v1):** SKILL.md only.
```yaml
---
name: launch-dk-ad-campaign
description: Use when the user wants to send a Q3 launch campaign to HubSpot contacts in Denmark.
allowed-tools:
  - mcp__hubspot__list_contacts
  - mcp__hubspot__send_campaign
  - WebSearch
  - Read
---
```
User must run `claude mcp add hubspot ...` before the skill can do anything. The skill itself can detect-and-prompt: *"This skill requires the HubSpot MCP server. Run `claude mcp add hubspot https://mcp.hubspot.com/...` and try again."*

**Path B (deferred to Phase 5.5):** Plugin packaging.
- Skill + `.mcp.json` bundled together
- One-step install via `/plugin install`
- Heavier — requires `plugin.json` + marketplace publishing
- Worth doing for high-traffic skill patterns; out of scope for v1

The preflight wizard surfaces this transparently: when the user grants an MCP tool, we mark whether the server is currently installed. If not, the emitted skill includes a body section that instructs the user how to install it (with the exact `claude mcp add` command).

---

## 17. Browser surfaces — Playwright MCP, Claude for Chrome, computer use

**Updated 2026-05-20:** Chrome and computer-use are **first-class invocationHint kinds**, not deferred fallbacks. Their *programmatic* invocation from inside a Claude Code skill is not yet documented by Anthropic, but the **user-handoff pattern** works today and Phase 5 builds for it explicitly. When Anthropic ships in-skill programmatic access, the same `SkillDesignProposal.integrations[].invocationHint` shape upgrades to direct invocation with zero brief-format changes.

Three integration mechanisms for skills that need browser or desktop GUI automation, in order of when each is the right pick:

**1. Playwright MCP** (`invocationHint.kind='mcp-tool'`). [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp). User installs: `claude mcp add playwright npx -- @playwright/mcp@latest`. Skill references via `mcp__playwright__browser_navigate, mcp__playwright__browser_click, mcp__playwright__browser_fill_form` etc. **Use when:** the workflow can be expressed as a deterministic browser sequence (load URL → fill form → click → assert). Programmatic from day one; no user handoff needed.

**2. Claude for Chrome** (`invocationHint.kind='chrome-extension'`). [claude.com/blog/claude-for-chrome](https://claude.com/blog/claude-for-chrome). GA across Pro/Team/Enterprise since Dec 2025. **Use when:** the workflow involves a site that has no public API (LinkedIn Sales Navigator, mid-market vendor portals, government filing sites, ATS tools on free tier, investor portals like Carta on founder-plan, etc.) AND the workflow is non-trivial enough that Playwright MCP would be brittle (auth-walled pages, MFA, captchas, dynamic content). **Today's invocation pattern:** the skill body emits `handoffInstructions` — explicit prose the user (or a Claude session running with the Chrome extension enabled) executes. **Tomorrow's pattern (when Anthropic documents in-skill programmatic Chrome access):** the same `handoffInstructions` payload becomes a direct tool call. Spec-shape doesn't change.

**3. Computer Use API** (`invocationHint.kind='computer-use'`). [docs.claude.com/en/docs/build-with-claude/computer-use](https://docs.claude.com/en/docs/build-with-claude/computer-use). **Use when:** the workflow involves a native desktop app with no scripting API (DaVinci Resolve unattended renders, AutoCAD on non-enterprise, Adobe Creative Suite for non-developers, legacy desktop accounting like Sage 50, specialty creative tools like Procreate, Notion desktop on free tier where there's no Notion API access, etc.) OR the workflow involves cross-app coordination (drag from app A, paste to app B). **Today's invocation pattern:** same as Chrome — `handoffInstructions` payload the user executes via Claude Desktop with computer-use enabled. **Tomorrow's pattern:** programmatic from inside the skill.

**Picking between Chrome and computer-use** when both could work: prefer Chrome for web destinations (faster, more reliable today, smaller security surface); prefer computer-use for native desktop apps + cross-app coordination. Mixed in one skill is normal — see Example 7 (§6.5b) which uses Chrome for the Carta web portal and computer-use for Notion desktop paste, in the same skill.

**Planner directive:** when reasoning about an action whose primary destination is a SaaS portal or native desktop app, the Planner MUST consider Chrome/computer-use rather than dropping to a lesser tier or stalling at "produce an artifact for the user to handle manually." The §6.5a prompt's `<orchestration_directives>` block enforces this explicitly. Examples 5-7 in §6.5b are the canonical few-shot for the model.

**Auto-detection in recon:** `ReconResult.chrome: true` indicates the Claude Chrome extension is installed (extension dir present + auth cookie file exists). `ReconResult.computerUseAvailable: true` indicates Anthropic computer-use access is configured (heuristic: `ANTHROPIC_COMPUTER_USE_*` env var present, OR the user's Claude plan tier supports it per `claude version --json`). If either is `false`, the Planner does NOT propose that invocation kind — instead it falls back to `write-artifact` + a `proposal.warnings[]` entry pointing the user at the relevant setup docs.

The preflight wizard detects Playwright (via `npx playwright --version`) and surfaces it. If detected + inferred from action text (e.g., "scrape competitor pricing"), it's pre-checked. If detected but not inferred, it's available but not pre-checked.

---

## 18. Settings keys

New keys under `Settings.skill` namespace (extend `src/storage/types.ts`):

```ts
skill: {
  // Install + workspace
  defaultInstallScope: 'project' | 'user';     // default 'project'
  budgetCapUsdPerRun: number;                  // default 5.00 — single-run cap (Planner + skill-creator combined)
  budgetCapUsdMonthly: number;                 // default 50.00 — workspace-monthly cap
  singleLoopMaxTurns: number;                  // default 60 — hint to skill-creator
  timeoutMinutes: number;                      // default 25 (15 for skill-creator + ~10 for Planner)
  autoOpenDryRunPreview: boolean;              // default true
  preserveWorkspaceOnSuccess: boolean;         // default false
  preserveWorkspaceOnFailure: boolean;         // default true
  snapshotRetentionCount: number;              // default 5
  recommendSkillCreatorInstall: boolean;       // default true
  destructiveToolConfirmRequired: boolean;     // default true — extra confirm for *create/send/delete/charge/publish/deploy* MCP tools
}

skillPlanner: {
  // Enable + defaults
  enabled: boolean;                            // default true — the agentic preflight is the headline; default OFF only for testing
  defaultTier: 'minimal' | 'standard' | 'maximalist';  // default 'maximalist'
  model: 'sonnet' | 'opus' | 'haiku' | string; // default 'opus-4-7' (claude-opus-4-7[1m]) — long context + creative reasoning
  reasoningTimeoutMinutes: number;             // default 10 — Planner reasoning phase
  budgetCapUsdPerPlan: number;                 // default 2.50 — Planner subtotal cap

  // PC scan
  pcScanEnabled: boolean;                      // default true
  pcScanIncludeBrowserExtensions: boolean;     // default true
  pcScanMaxApps: number;                       // default 200
  pcScanMaxCliTools: number;                   // default 80
  pcScanEnvVarAllowPatterns: string[];         // default see §6.2 (~80 patterns)

  // Wiki recon
  wikiReconEnabled: boolean;                   // default true (auto-disables if no wiki/ present)
  wikiReconMaxTurns: number;                   // default 8
  wikiReconMaxPagesReturned: number;           // default 20

  // Web research
  webResearchEnabled: boolean;                 // default true
  webResearchMaxTurns: number;                 // default 12
  webResearchMaxSources: number;               // default 15
  webResearchRecencyBiasDays: number;          // default 365 — prefer sources newer than this

  // User review
  maxReplansPerSolve: number;                  // default 3 — cap re-plan loops to avoid runaway
  requireExplicitTierAccept: boolean;          // default false — `--yes` accepts the Planner's recommendedTier
  proposalEditorEnabled: boolean;              // default true — open $EDITOR for narrative edits

  // Provenance + sharing
  exportProposalWithRuns: boolean;             // default true — proposal.md included in run .zip exports
  redactEnvVarValuesInProposal: boolean;       // default true — even values that leaked into recon never reach the proposal
}
```

All overridable via `aab settings set skill.<key> <value>` (the existing settings command from Phase 0). The Planner namespace is separate from `skill` because Planner-vs-no-Planner is a meaningful operating-mode toggle, not just a tuning knob.

---

## 19. Build phasing — 6 chunks

Each chunk is independently shippable; each gets a vitest pass + a live smoke run before tick (per the established Phase 1.5 / Phase 3 / Phase 4 pattern). The Skill Planner now occupies two chunks (recon + reasoning) because it's the largest single deliverable.

### Chunk 1 — skill-creator detection + install bootstrap
**Goal:** the prerequisite is reliably present.

- [ ] `src/core/skill/resolve-skill-creator.ts` — walks the skill scope priority order (project → user → plugin) to find `skill-creator/SKILL.md`; returns path or null
- [ ] `aab init --install-skill-creator` — surfaces the exact `/plugin install skill-creator@claude-plugins-official` command + opens Claude Code if possible (since `/plugin install` itself is interactive-only today)
- [ ] `aab doctor` adds: skill-creator presence + version check; PC scan probe; web reachability probe
- [ ] Live smoke: install skill-creator on the test workspace; verify resolver finds it; verify doctor passes
- [ ] Unit tests: scope walking; version extraction from SKILL.md frontmatter

### Chunk 2 — Skill Planner: recon (PC scan + wiki + web)
**Goal:** the read-only recon layer produces a deterministic, well-shaped `ReconResult + WikiContext + WebResearchContext` triple.

- [ ] `src/core/skill/recon/pc-scan.ts` — platform-dispatched read-only PC inventory (Windows / macOS / Linux) per §6.2. Pure functional shape: takes injected `os` + `fs` + `child_process` handles, returns `ReconResult`. Hard rule: no writes, no network. Lint-enforced via custom ESLint rule (`no-side-effects-in-recon`).
- [ ] `src/core/skill/recon/wiki-recon.ts` — reuse Phase 1.5's `aab knowledge query` engine. One Sonnet call with `Read/Grep/Glob/maxTurns:8`. Returns `WikiContext`.
- [ ] `src/core/skill/recon/web-recon.ts` — one Sonnet call with `WebSearch + WebFetch + maxTurns:12`. Returns `WebResearchContext`.
- [ ] `src/core/skill/recon/orchestrator.ts` — runs all three in parallel (Promise.allSettled), aggregates, handles partial failures (e.g., no wiki → empty WikiContext; offline → empty WebResearchContext; locked-down corp machine → degraded ReconResult). Each phase emits `planner_recon_progress` + `planner_recon_done` WS events.
- [ ] `aab actions plan <id> --recon-only --json` — debug command that runs recon, prints the triple, exits. Useful for testing without burning Opus tokens.
- [ ] Unit tests: PC scan with mocked child_process per OS; recon aggregation with all three phases erroring; budget enforcement; cap-size truncation; redaction of env var values.
- [ ] **Live smoke:** run recon-only against real action on real workspace; verify PC scan finds ≥20 apps + ≥10 CLI tools; wiki recon returns ≥3 pages for an action that has wiki coverage; web research returns ≥8 sources with citations.

### Chunk 3 — Skill Planner: reasoning + user review
**Goal:** the Opus reasoning call produces a high-quality `SkillDesignProposal` and the user can review + accept it.

- [ ] `src/core/prompts/skill-planner.ts` — the Planner system prompt template. **This is the most important prompt in the whole CLI.** Includes: skill operating model preamble + master-gpt-prompter hardening + the explicit "lean toward orchestration, surface ≥3 multi-tool integrations, propose three ambition tiers" directive.
- [ ] `src/core/skill/planner.ts` — orchestrates the reasoning call. Inputs: action + linked discussion summary + recon triple. Model: `researchModel` (Opus 4.7, 1M context). Output: validated `SkillDesignProposal` against a zod schema. Streams `planner_reasoning_progress` WS events.
- [ ] `src/core/parsing/llm-response-schemas.ts` — add `skillDesignProposalSchema` (zod), tolerant of partial outputs, validates: skillName kebab-case, tiers complete (minimal+standard+maximalist), ≥1 integration when tier ≥ standard, ≥3 integrations when tier === maximalist (hard gate — fail if violated, re-run with stronger nudge).
- [ ] `src/core/skill/planner-review.ts` — interactive review flow. CLI: `enquirer` multi-select per integration + stakeholder; tier radio; narrative editor via `$EDITOR`. Re-plan loop (max 3 per solve). Output: post-acceptance `SkillCapabilityProfile` with `grantedTools` derived deterministically from accepted integrations.
- [ ] `aab actions plan <id>` — first-class command. Runs Chunk 2 + Chunk 3, prints/saves proposal markdown, exits. Doesn't invoke skill-creator.
- [ ] Unit tests: prompt rendering, proposal schema validation, deterministic `grantedTools` projection from accepted integrations, re-plan-with-feedback merge, narrative-edit preservation.
- [ ] **Live smoke (the showcase):** run `aab actions plan` on a real maximalist-friendly action like "Record a YouTube intro for the Q3 launch" against a workspace with seed wiki + at least one MCP server + at least one detectable desktop app (Elgato Teleprompter, OBS, Adobe Premiere, etc.). Verify the Planner surfaces ≥3 multi-tool orchestrations spanning at least 2 of {PC apps, MCP servers, wiki stakeholders}. **This is the milestone where the user can feel the depth of the feature for the first time.**

### Chunk 4 — skill-creator invocation + adapter + install
**Goal:** the end-to-end happy path works — proposal → skill-creator → installed skill.

- [ ] `src/core/skill/build-brief.ts` — assembles JSON brief from action + discussion + accepted proposal per §7
- [ ] `src/core/skill/invoke-skill-creator.ts` — headless spawn with `--append-system-prompt-file`, stream events, capture telemetry
- [ ] `src/llm/claude-code-runner.ts` — add `appendSystemPromptFile`, `cwd`, `outputFormat: 'stream-json'`, `onEvent` options
- [ ] `src/core/skill/adapter.ts` — frontmatter normalization per §9
- [ ] `src/core/skill/install.ts` — `cp -r workspace → .claude/skills/<name>/`, conflict handling, `.aab-source.json` sidecar
- [ ] `src/core/skill/persist-run.ts` — write `SkillGenerationRun` with full proposal embedded in metadata, update `ActionItem.linkedSkill`, archive workspace
- [ ] `aab actions solve <id>` end-to-end (now chains Chunk 2 + 3 + 4)
- [ ] Unit tests: brief assembly with proposal embedding, frontmatter parse/serialize, adapter diff, conflict rename logic
- [ ] **Live smoke (the big one):** real action → Planner proposal accepted → skill-creator → install. Verify SKILL.md frontmatter valid, `linkedSkill` populated, `aab skills list` shows it, `aab skills test` round-trips, the emitted skill's `allowed-tools` exactly matches the user-accepted integrations.

### Chunk 5 — `aab actions runs` + `aab skills` commands
**Goal:** users can browse history, re-export proposals, and test skills.

- [ ] `aab actions runs <action-id>` — list past runs with tier + cost + status
- [ ] `aab actions runs show <run-id>` — pretty-print metadata + Planner proposal + files + telemetry tail
- [ ] `aab actions runs export <run-id> --zip <path>` — `jszip` bundle includes `proposal.md` + `SKILL.md` + supporting files + `telemetry.jsonl`
- [ ] `aab actions plan show <plan-id>` — re-render a saved plan (without re-running it)
- [ ] `aab skills list / show / test / uninstall / restore` per §13
- [ ] Unit tests: run listing, JSON export, snapshot rotation, proposal re-render
- [ ] Live smoke: solve → runs show → proposal export → skills test (round-trip the freshly-built skill against Claude with sample input)

### Chunk 6 — Web UI + WS events + Playwright MCP specs
**Goal:** the dashboard mirrors the CLI surface end-to-end with the agentic Planner front and center.

- [ ] REST endpoints per §14 (including the new `/api/actions/:id/plan` + `/api/plans/:id/replan` + `/api/recon/environment`)
- [ ] WS event family per §12 + §14 (planner_* events)
- [ ] `gui/app.js` — Plan button + Solve button on action card; **Planner progress pane** with per-phase progress bars + live tool-call stream; **Planner proposal modal** with interactive integration toggles + tier radio + stakeholder toggles + narrative editor; **Re-plan feedback modal**; run-detail view; runs list; run export; install confirmation; Skills tab
- [ ] `gui/style.css` — Planner progress pane, integration card styling, tier dial, ambition-tier color coding (minimal=neutral, standard=accent, maximalist=primary), adapter diff highlighting
- [ ] `data-testid` registry entries per §14
- [ ] Playwright MCP regression specs:
  - [ ] `specs/skill-plan-only.md` — dry-run planner via Plan button; verify proposal modal opens with all sections populated; verify export-to-md works
  - [ ] `specs/skill-planner-maximalist.md` — set planner tier to maximalist on a synthetic action that has ≥3 detectable integrations; verify proposal includes them; verify toggling each one off + on adjusts the final grantedTools list
  - [ ] `specs/skill-planner-replan.md` — accept partial proposal, click Re-plan, provide feedback ("you missed integration X"), verify the re-planned proposal includes X
  - [ ] `specs/skill-solve-happy-path.md` — full Plan → proposal accept → solve → install end-to-end
  - [ ] `specs/skill-run-telemetry.md` — live telemetry updates over WS during a solve
  - [ ] `specs/skill-install-conflict.md` — install same name twice → conflict dialog
  - [ ] `specs/skill-runs-history.md` — runs list + show + export (with proposal.md inside the .zip)
  - [ ] `specs/skills-tab.md` — list / show / test / uninstall
- [ ] Live Playwright MCP smoke on the test workspace

**Out of scope for v1 (deferred):**

- Plugin-packaged emitted skills with bundled `.mcp.json` (Path B from §16)
- `aab prompts list|edit|reset` user-customisable prompt overrides (including Planner prompt overrides)
- Critique panel / reflexion (skill-creator likely handles this internally if needed)
- Computer Use API surface
- Direct Claude for Chrome programmatic invocation from skills
- Planner that runs **autonomously across multiple Action Items** ("plan + solve every pending action in the Kanban tonight while I sleep")
- Cross-skill composition planner ("the Planner notices two related actions and proposes a single multi-step skill that covers both")

---

## 20. Testing strategy

**Unit tests** (vitest, mocked `runClaude` / `child_process`):

- **PC scan per platform** — mock `child_process` for Windows / macOS / Linux; verify deterministic `ReconResult` shape, cap-size truncation, env-var redaction, no-network-call assertion.
- **Recon orchestrator** — all-three-succeed, one-failed-two-succeeded (e.g., offline → no web research), all-three-failed (degraded ReconResult, never throws).
- **Capability pattern matching** — port sage-council's `CAPABILITY_PATTERNS` + `CAPABILITY_SIGNALS` tests verbatim, table-driven, ~30 cases.
- **Planner prompt rendering** — given inputs, prompt contains all required directives (3-tier proposal, ≥3 integrations on maximalist, citation requirement, veto pickup from wiki).
- **`SkillDesignProposal` schema validation** — accepts valid; rejects when maximalist tier has <3 integrations; rejects malformed tier names; tolerant of missing-but-optional fields.
- **`grantedTools` projection** — given an accepted proposal with a specific integration set, the deterministic projection produces an exact allowlist string.
- **Re-plan-with-feedback merge** — feedback text appears in the next Planner call's recon-extension input; round-tripping integrations the user added in feedback come through in the next proposal.
- **Brief assembly** — produces valid JSON ≤60 KB; truncation priority order honored (innovations → citations → patterns → narrative-edits).
- **Adapter** — frontmatter parse, missing-field injection, char-cap truncation, invented-key folding, allowed-tools diff vs grantedTools.
- **Install** — conflict resolution (overwrite / rename / abort), snapshot rotation, `.aab-source.json` write.
- **Persistence** — `SkillGenerationRun` round-trip with embedded proposal, `linkedSkill` update, atomic writes.

**Integration tests** (mocked `claude` binary returning canned outputs):

- End-to-end Plan → accept → solve, with stub Planner returning a maximalist 5-integration proposal and stub skill-creator returning a fixed SKILL.md package.
- Re-plan loop: user rejects, provides feedback, second Planner call includes the feedback; max-3 cap enforced.
- Conflict on existing skill name → rename path produces unique slug.
- Adapter catches invented frontmatter keys.
- WS event sequence matches the contracts in §12 + §14.

**Live smokes** (real `claude` calls, external test folder `C:\Users\julia\Downloads\kode\ai-advisoryboardclitestfolder`):

- **Planner showcase smoke (Chunk 3 milestone — cross-domain):** **at least two** §20a recipes pass (recommend A+C for the hardest cross-domain proof — A leans on a PC app + stakeholder, C has neither). Each passing recipe produces a maximalist proposal that surfaces ≥3 multi-tool orchestrations across at least 2 distinct recon surfaces. **This is the moment of truth for the depth-of-feature thesis: the Planner is provably domain-neutral, not over-fit to creative-production cases.**
- **Happy path:** real action → real Planner → user accepts → real skill-creator → real install → real `aab skills test` round-trip. Acceptance bar.
- **Conflict path:** solve twice with `--skill-name` collision → rename.
- **Abort path:** Ctrl+C mid-Planner-reasoning → `planner_failed` event, no SkillGenerationRun created; Ctrl+C mid-skill-creator → `SkillGenerationRun.status = 'cancelled'`, workspace preserved.
- **Degraded recon:** run with `--planner-no-web` → Planner still produces proposal but `valueRationale` explicitly notes the missing web-research input.
- **Missing skill-creator:** uninstall it → `aab actions solve` fails with clear hint pointing at `/plugin install skill-creator@claude-plugins-official` → reinstall → solve works.
- **Missing MCP server:** Planner proposes a `mcp__hubspot__*` integration; user accepts; emitted skill body includes the `claude mcp add hubspot ...` install instructions in its preamble (because we wrote `fallbackIfMissing` into the brief).
- **`--no-planner` regression:** with Planner disabled, solve completes faster + cheaper but produces a minimal-tier skill matching the inferred-only capability profile.

**Playwright MCP specs** per §19 Chunk 6.

### 20a. Seed workspace recipes for Phase 5 smoke testing (T3.11)

Reproducible setups for the Chunk 3 Planner showcase smoke. The smoke needs an environment rich enough that the maximalist tier can plausibly surface ≥3 multi-tool integrations — but **the depth-of-feature thesis must hold across multiple action domains, not just creative-production cases.** Run at least two of the recipes below (any two — they're each independent smokes that exercise the same Planner mechanisms via different recon surfaces).

**Common pre-requisites (all recipes):**

1. **Install `skill-creator`** (the prerequisite):
   ```
   /plugin install skill-creator@claude-plugins-official    # interactive Claude Code prompt
   ```
2. **External test folder** (per `PLAN/SMOKE_TESTING.md`): `C:\Users\julia\Downloads\kode\ai-advisoryboardclitestfolder` on Windows, `~/aab-smoke/` on macOS/Linux. Never smoke from the project root.
3. **Bootstrap a fresh workspace per smoke:** `aab init --non-interactive --home --name smoke-phase5-<recipe>-<yyyy-mm-dd>`

---

**Recipe A — Creative/comms smoke (Example 1 — Elgato YouTube intro)**

Pre-reqs:
- Install a detectable desktop app with a programmatic surface. Options: Elgato Teleprompter (https://www.elgato.com/prompter), OBS Studio (https://obsproject.com/), Figma desktop, Notion desktop.
- Install Google Calendar MCP (or equivalent): `claude mcp add google-calendar https://...`

Workspace:
```
aab knowledge ingest --paste "Mads Larsen is our video editor. He works with us on YouTube content. Email: mads@example.dk. He prefers briefs in PDF + script as .docx. Based in Copenhagen." --as-entity --slug mads-larsen

aab knowledge ingest --paste "Marketing copy tone for Danish SMB audience: casual, direct, no hype. We avoid superlatives and we never use exclamation marks in headlines." --as-concept --slug danish-smb-tone

aab actions add "Record YouTube intro for Q3 product launch" --description "3-minute intro for the Q3 launch landing page. Script, recording, editing. Hand off to Mads." --priority high
```

Acceptance: proposal surfaces ≥3 integrations including the PC app (bash-curl invocation hint), Calendar MCP, and Mads stakeholder touchpoint with drafted email artifactTemplate.

---

**Recipe B — Strategic/research smoke (Example 2 — Pricing investigation)**

Pre-reqs:
- Install Google Sheets MCP (or equivalent: Notion MCP, Airtable MCP).
- Optionally: Slack MCP for the advisor ping (downgrade gracefully to artifact-mode if not installed).

Workspace:
```
aab knowledge ingest --paste "Alexandra Chen is our fractional CFO and pricing advisor. Slack: @alex. She prefers proposals as one-page decision memos with a comparison table. Reachable Mon-Wed." --as-entity --slug alexandra-chen-cfa

aab knowledge ingest --paste "ACME Corp competitor: https://acme.example/pricing. They price per-seat at \$29/mo (starter), \$79/mo (pro), enterprise (custom). DK SMB focus." --as-entity --slug competitor-acme

aab knowledge ingest --paste "We endorse usage-based pricing where the unit of value is clear (API calls, GB stored, etc.). Per-seat is acceptable for collaboration tools only." --as-concept --slug pricing-strategy

aab actions add "Investigate pricing strategy for Q3 SMB launch" --description "Need a defensible pricing model for the Q3 launch. Compare against 3-5 competitors. Recommend a tier structure with rationale." --priority high
```

Acceptance: proposal surfaces ≥3 integrations across **zero PC apps** — must be web-research-grounded + wiki-grounded + Sheets MCP + Alexandra stakeholder. Decision memo destination is `wiki/decisions/...` (compounds into Phase 1.5 wiki). **This smoke specifically validates that the Planner doesn't depend on PC-app detection.**

---

**Recipe C — Technical/code smoke (Example 3 — Auth refactor)**

Pre-reqs:
- A small Node + TypeScript project initialized in the workspace dir with at least a `package.json`, a `src/auth/session.ts` file with session-cookie code, and `jest` or `vitest` installed.
- `git` + `gh` CLI authenticated (read-only ops are sufficient for the smoke).
- No MCP installs needed.

Workspace:
```
aab knowledge ingest --paste "May 2026: decided to adopt OAuth2 PKCE for the enterprise tier. Rationale: industry default for SPA + native; works with existing session-cookie flow as a parallel mechanism." --as-decision --slug 2026-may-oauth-decision

aab knowledge ingest --paste "Pitfall: do NOT use the 'jsonwebtoken' npm package — security review May 2026 flagged unsafe defaults. Use 'jose' instead." --as-concept --slug session-cookie-pitfalls

aab actions add "Refactor auth module to support OAuth2" --description "Current auth uses session cookies. Need to add OAuth2 for the enterprise tier we are shipping in Q3. Reference the May decision page." --priority high
```

Acceptance: proposal surfaces ≥3 integrations across **codebase recon (Read/Grep/Glob) + Bash CLI (git/gh/npm) + Write/Edit on scaffolded files** — and crucially, **zero stakeholderTouchpoints**. Vetoes from the wiki ('no jsonwebtoken') are baked into SKILL.md as MUST-NOT lines. **This smoke specifically validates that empty `stakeholderTouchpoints[]` is a valid maximalist tier as long as the integration count meets ≥3.**

---

**Recipe D — Operational/people smoke (Example 4 — SDR hire)**

Pre-reqs:
- Install at least two MCPs from: Greenhouse / Lever / Workable (ATS); Google Calendar; Slack. (Or fall back to one ATS + curl-based posting for the rest.)
- No PC app installs needed.

Workspace:
```
aab knowledge ingest --paste "ICP for Danish SMB: 10-50 employees, B2B SaaS or e-commerce, decision-maker is the COO or Head of Growth, average deal size 200-2000 EUR/mo, 30-60 day sales cycle." --as-concept --slug icp-danish-smb

aab knowledge ingest --paste "Standard SDR role template: 50% outbound (LinkedIn + cold email), 30% inbound qualification, 20% account research. KPIs: 30 meetings booked / month, 8 qualified opps / month. Native DK + business English." --as-concept --slug sdr-role-template

aab actions add "Hire 2 SDRs for the DK market" --description "Need 2 inside-sales hires for the Denmark expansion. Junior-mid level. 6-week hiring window." --priority high
```

Acceptance: proposal surfaces ≥3 integrations across **multiple MCPs (ATS + Calendar + Slack) + Write on outreach templates** — no PC apps, no codebase recon. The Slack stakeholder touchpoint upgrades from artifact-mode to `produces: 'send'` because Slack MCP is granted. **This smoke validates multi-MCP orchestration and the artifact→send upgrade path.**

---

**Recipe E — Browser-use smoke (Example 5 — LinkedIn outreach)**

Pre-reqs:
- **Claude Chrome extension installed and authed** in a Chrome profile. Verify via the extension's settings page (chrome://extensions → Claude → Details → enabled). The Phase 5 recon detects this best-effort via the extension dir + auth cookie file.
- Install Google Sheets MCP: `claude mcp add google-sheets ...`
- No PC desktop apps needed.

Workspace:
```
aab knowledge ingest --paste "ICP for Danish SMB outreach: 10-50 employees, B2B SaaS or e-commerce, COO or Head of Growth, located in Copenhagen-area." --as-concept --slug icp-danish-smb

aab knowledge ingest --paste "Standard inbound-warm outreach template: 'Hi [[first_name]], I noticed [[company]] is in the DK SMB space. We help similar companies cut their SDR pipeline cycle in half — would a 15-min chat next week be useful?'" --as-concept --slug outreach-templates

aab knowledge ingest --paste "Do not contact list: Acme Corp (already a customer), Beta Inc (in legal dispute), Gamma Ltd (former employee complaint)." --as-concept --slug do-not-contact-list

aab actions add "Run weekly LinkedIn outreach for the DK SDR pipeline" --description "Send personalized InMails to 25 prospects matching our DK ICP this week. Log who was contacted." --priority high
```

Acceptance: proposal surfaces ≥3 integrations including **at least one `invocationHint.kind='chrome-extension'`** with a populated `handoffInstructions` field that names LinkedIn Sales Nav explicitly. **This smoke specifically validates that Chrome extension is treated as a first-class integration kind, not a fallback.** Bonus check: re-run with `chrome: false` simulated in recon (set `--planner-no-chrome-detect`) and verify the Planner falls back to `write-artifact` + a warning, NOT silently drops the integration.

---

**Recipe F — Mixed multi-surface smoke (Example 7 — Investor update — the showcase)**

This is the most ambitious recipe and the definitive proof of the Planner's full agentic-stack capability. Pass this and you can confidently say the depth-of-feature thesis holds.

Pre-reqs:
- **Claude Chrome extension installed and authed** (for the Carta portal step).
- **Computer-use availability** — either Anthropic computer-use API access on the user's plan, OR a local computer-use-compatible setup. Best-effort detection in recon.
- Install Stripe MCP: `claude mcp add stripe ...`
- Install Mercury MCP (or equivalent banking MCP — Brex / Ramp / etc.): `claude mcp add mercury ...`
- Install Google Sheets MCP.
- Notion desktop app installed (free or paid tier — the test specifically exercises the free-tier no-API path so prefer free if you have a personal Notion account).
- `pandoc` available for PDF generation.

Workspace:
```
aab knowledge ingest --paste "Monthly investor update format: lead with cash runway, then MoM revenue growth, then top-3 wins for the month, then top-3 asks. Keep under 600 words. Always attach a one-page P&L PDF." --as-concept --slug monthly-investor-update-format

aab knowledge ingest --paste "John Doe is our Series A lead investor at Acme VC. Email: john@acmevc.com. He prefers concise briefs — never more than 400 words. He cares most about runway + sales velocity, less about engineering wins." --as-entity --slug investor-john-doe

aab knowledge ingest --paste "Jane Smith is on our board, invested at seed via Beta Capital. Email: jane@betacap.com. She asks technical questions and appreciates detail on engineering wins + the product roadmap." --as-entity --slug investor-jane-smith

# (seed 4 more investor entities similarly for the full ×6 stakeholder shape)

aab knowledge ingest --paste "Q2 2026 revenue target: $250k MRR by end of June. May 2026 actual: $187k. Burn target: <$80k/month. May actual: $72k." --as-decision --slug 2026-q2-revenue-targets

aab actions add "Close the books for May 2026 and send investor update" --description "Monthly investor update: pull May revenue/cash position, populate the P&L sheet, post the update to Carta investor portal, paste numbers into the Notion investor doc, send personalized briefs to each of the 6 investors." --priority high
```

Acceptance: proposal must surface **≥5 integrations across at least 3 different invocationHint kinds**, specifically including:
- ≥1 `mcp-tool` (Stripe / Mercury / Sheets)
- ≥1 `chrome-extension` (Carta portal step)
- ≥1 `computer-use` (Notion desktop paste step)
- ≥1 `write-artifact` (the 6 personalized investor emails)
- `valueRationale` explicitly contrasts the 4-hours-manual baseline against the maximalist orchestration

**This is the definitive Phase 5 acceptance smoke.** If Recipe F passes end-to-end (Planner → user accepts → skill-creator → install), the Planner is provably capable of designing skills that orchestrate the full agentic stack. **Schedule Recipe F as the final Chunk 6 acceptance gate.**

---

**Tear-down (all recipes):** The smoke workspaces are disposable; `aab workspace delete smoke-phase5-<recipe>-<yyyy-mm-dd>` removes them (archives to `.trash/` for 30 days per Phase 0).

**If a smoke fails to surface ≥3 maximalist integrations** for its domain, the diagnostic order is:
1. Verify the recon surfaces are actually present: `aab actions plan <id> --recon-only --json` and inspect `cliTools[]`, `mcpServers[]`, `appIntegrationSurfaces[]`, `wikiContext.relevantPages[]`, `webResearch.bestPracticePatterns[]`.
2. Verify the wiki was ingested correctly: `aab knowledge query "tell me about <topic>"` should return the seeded pages.
3. Check `proposal.warnings[]` for degraded recon phases (offline web, stale PC cache, empty wiki for the domain).
4. Inspect the Planner prompt rendering with `aab actions plan <id> --debug --dump-prompt` to verify the few-shot examples are present and the domain-neutral directive is intact.
5. Fix the root cause; re-run. If multiple smokes pass but one consistently fails, the Planner prompt has a domain bias — refine the few-shot library.

**Cross-domain validation:** the Chunk 3 milestone is considered passing when **at least two of recipes A-D** produce maximalist proposals that surface ≥3 distinct integrations. This proves the Planner pattern is genuinely domain-neutral.

**Integration-kind validation:** the Chunk 6 milestone (the spec's final acceptance gate) is considered passing when **Recipe E (chrome-extension) AND Recipe F (mixed multi-surface)** both pass end-to-end in addition to ≥2 of A-D. This proves the Planner is not just domain-neutral but also **kind-neutral** — Chrome and computer-use are treated as first-class integration surfaces, not deferred to a hypothetical future. The kind-neutrality is the hardest property to prove and is what unlocks the entire class of "SaaS without API" and "native desktop app without scripting" actions.

**Minimum coverage matrix for Phase 5 ship:**

| Smoke | Recon surface tested | invocationHint kind validated | Must pass for ship? |
|---|---|---|---|
| Recipe A (Elgato) | PC app + MCP + wiki stakeholder | bash-curl, mcp-tool, write-artifact | yes |
| Recipe B (pricing) | Web + wiki + MCP | mcp-tool, write-artifact (wiki/decisions/) | one of B/C must pass |
| Recipe C (auth refactor) | Codebase + CLI tools + wiki | bash-cmd, bash-script | one of B/C must pass |
| Recipe D (SDR hire) | Multi-MCP + wiki | mcp-tool ×3, write-artifact, produces='send' | yes |
| Recipe E (LinkedIn) | Chrome + MCP + wiki | **chrome-extension** | **yes — proves Chrome integration is real** |
| Recipe F (investor update) | All five kinds | **chrome-extension + computer-use + 3 MCPs + write-artifact + bash-cmd** | **yes — the showcase** |

Recipes A + D + E + F together exercise every invocationHint kind. B and C are additive coverage of the domain-neutrality property. Phase 5 does not ship until A, D, E, and F all pass on real Claude calls from the external test folder.

---

## 21. Acceptance criteria (Phase 5)

A workspace passes Phase 5 acceptance when **all** of these are true:

1. `aab doctor` reports `skill-creator: installed (v<x>)` ✅, PC scan probe OK, web reachability OK.
2. **Depth proof (cross-domain):** `aab actions plan <id>` on at least **two of the four §20a recipe domains** (creative, strategic-research, technical, operational) produces a `SkillDesignProposal` whose **maximalist tier surfaces ≥3 multi-tool orchestrations**, spanning at least 2 of {PC apps, MCP servers, codebase recon, wiki stakeholders, web research}. The proposal's `valueRationale` paragraph explicitly contrasts minimal vs. maximalist value delivery. **The two passing recipes must span different surfaces** (e.g., recipe A which leans on a PC app + recipe C which has no PC apps and no stakeholders) so the Planner is proven domain-neutral, not narrow-trained on creative-production cases.
3. `aab actions solve <id>` completes in ≤25 min (Planner + skill-creator combined) and produces a `.claude/skills/<name>/SKILL.md` whose frontmatter validates against the current Claude Code spec (`/skills` lists it without warnings).
4. The emitted SKILL.md's `allowed-tools` **exactly matches the user-accepted integrations from the Planner proposal** (no extra tools, no missing tools the body references). For each unavailable capability the user accepted with a fallback, the SKILL.md body contains explicit fallback behavior matching the chosen mode.
5. `aab skills test <name> "<sample input from action description>"` round-trips against Claude — the skill triggers and produces output consistent with the action.
6. **Stakeholder handoffs are concrete:** if the Planner proposal includes a `stakeholderTouchpoints` entry (e.g., "draft email to Person X"), the emitted SKILL.md contains a runnable artifact draft (e.g., the actual draft email body), not just an instruction to write one.
7. `actionItem.linkedSkill` is populated; `actionItem.skillRunHistory` carries the runId; `actionItem.status === 'in-progress'` (or `completed` if `--complete-on-install`).
8. `aab actions runs <action-id>` lists the run with cost + duration + planner tier + status; `runs show <run-id>` prints the embedded Planner proposal + telemetry + critic scores + security mode.
9. `aab actions runs export <run-id> --zip <path>` produces a bundle that includes `proposal.md` (rendered from `SkillDesignProposal`) alongside the SKILL.md package.
10. **Re-plan loop works:** rejecting an accepted proposal with explicit feedback ("you missed integration X") produces a second proposal containing X (or an explicit explanation of why X was excluded).
11. **Read-only PC scan invariant:** all `recon/pc-scan.ts` tests pass against a sandboxed filesystem + child_process mock that fails any write attempt. CI gates this assertion.
12. Web UI: Plan button + Solve button on the action card both work; Planner progress pane streams the four phases; Planner proposal modal renders all sections with toggleable integrations + tier dial + narrative editor; re-plan feedback modal works; run-detail view streams telemetry; install confirmation shows adapter diff; new skill appears in the Skills tab.
13. All Playwright MCP specs in Chunk 6 pass.
14. **Live CLI smoke "the showcase" passes (cross-domain)** from the external test folder: **at least two** §20a recipes (any combination — A+C is the easiest cross-domain proof since C has no PC apps and no stakeholders, exercising the abstraction hardest) produce maximalist proposals that surface ≥3 multi-tool integrations and install working skills, end-to-end, on the first try.
15. Total LOC under `src/core/skill/` ≤ 1,500 (the ~1,200 LOC budget + slack). Total LOC across all of Phase 5 ≤ 2,200 excluding tests + prompts. The Skill Planner prompt template itself can be up to 500 lines — this is allowed because prompt quality compounds.

---

## 22. Future extensions

Listed in rough priority order; all out of v1.

- **Plugin-packaged emits.** Bundle SKILL.md + `.mcp.json` + `plugin.json` so a generated skill installs in one step via `/plugin install`. Useful for high-traffic skill patterns or sharing across team workspaces.
- **`aab prompts edit`** — user-customisable overrides for the brief assembly templates. Phase 5.x.
- **Marketplace publish flow.** `aab actions solve --publish <marketplace-url>` — emit + push to a private/team marketplace.
- **Skill version management.** `aab skills upgrade <name>` — re-solve with the same action+capability profile, install as v2, archive v1.
- **A/B testing of emitted skills.** Solve twice with different model/effort settings, run both against the same input set, compare outputs.
- **Planner reads recent calendar + email context (T3.3).** With explicit user grant, the Planner could pull the last 30 days of email + calendar via MCP, find recurring patterns, and propose skills that fit the user's actual workflow rhythm. Significant privacy implications — explicit opt-in only.
- **PII redaction in shared exports (T3.5).** Setting `skillPlanner.redactPiiInProposal` (default off — wiki is the user's own data) sanitizes the proposal before `aab actions runs export` produces a shareable ZIP. Redacts: email addresses, phone numbers, named people in `stakeholderTouchpoints[]`.
- **Telemetry-driven prompt feedback.** When a solve produces a low-critic-score skill, surface the patterns and feed back into a fine-tuned brief template.
- **Computer Use API integration** once Anthropic documents the in-skill pattern.
- **Direct Claude for Chrome programmatic invocation** once Anthropic exposes the surface.
- **Cross-workspace skill sharing.** `aab skills export <name> --to-workspace <id>` — copy a generated skill to another workspace.

---

## 23. Glossary

| Term | Meaning |
|---|---|
| **skill-creator** | Anthropic's official meta-skill that authors Claude Code skills. Lives at `anthropics/claude-plugins-official/plugins/skill-creator/`. We invoke it as the authoring step of `aab actions solve` after the Planner has done its work. |
| **Skill Planner** | The four-phase agentic preflight that owns the depth of the feature (§6). Phase 1 (PC scan, read-only), Phase 2 (wiki recon), Phase 3 (web research), Phase 4 (Opus reasoning) → `SkillDesignProposal`. Phase 5 (user review, interactive) → accepted profile. Not a synonym for "preflight wizard" — the wizard was the old yes/no flow; the Planner replaces it with an LLM-reasoning agent that proposes multi-tool orchestrations. |
| **`SkillDesignProposal`** | The Planner's structured output. Includes skill name + trigger language + three ambition tiers (minimal / standard / maximalist) + list of integrations across recon surfaces + proposed workflow + stakeholder touchpoints + vetoes + value rationale. The maximalist tier surfaces ≥3 multi-tool orchestrations. Renders as the proposal modal in the GUI and as `enquirer` selectables in the CLI. |
| **ambition tier** | The Planner proposes three: `minimal` (just produce the obvious artifact), `standard` (use the tools the user clearly wants), `maximalist` (orchestrate everything detected). Default recommended tier is `maximalist`. User can dial down without re-running the Planner. |
| **integration** | One element of `SkillDesignProposal.integrations[]`. Sourced from a PC app, CLI tool, MCP server, wiki entity (stakeholder), browser extension, or web-research recommendation. Each has workflowSteps + requiredTools + fallbackIfMissing + confidence + citations. Toggleable in the user review step. |
| **stakeholder touchpoint** | A person from the Knowledge Wiki that the Planner thinks the emitted skill should produce a concrete artifact for (draft email, calendar invite, Slack message, doc share). The maximalist tier's "involve the right humans" axis. |
| **recon** | The three deterministic + LLM-driven information-gathering phases the Planner runs in parallel before the reasoning step: `pc-scan` (read-only OS-level enumeration of apps + CLI tools + MCP servers + browser extensions + env vars), `wiki-recon` (Knowledge Wiki query), `web-research` (WebSearch + WebFetch). Output: `ReconResult + WikiContext + WebResearchContext`. |
| **read-only PC scan** | Hard architectural rule: the recon module never writes a file, modifies a registry key, calls a network endpoint, or invokes anything with side effects on the user's machine. Lint-enforced (`no-side-effects-in-recon`); CI gates the invariant. |
| **value rationale** | The Planner's articulation of *why maximalist beats minimal* for this specific action — a paragraph of natural language inside `SkillDesignProposal`. Rendered prominently in the user review surface so the user sees the depth the Planner is proposing. |
| **re-plan loop** | If the user rejects the Planner's proposal, they can provide feedback ("you missed integration X") and the Planner re-runs with the feedback appended to its recon input. Cap: 3 re-plans per solve. |
| **brief** | JSON payload assembled from action + discussion summary + **the accepted `SkillDesignProposal` (verbatim)** + capability profile + install target. Passed to skill-creator as the user message. See §7. |
| **`SkillCapabilityProfile`** | Post-acceptance structured record. Holds the FULL Planner proposal (for provenance), the user's accepted integration IDs, the deterministic `grantedTools` allowlist projection, and the detected environment. The bridge from Planner to brief. |
| **`grantedTools`** | The deterministic projection of the user-accepted integrations onto the `allowed-tools` string that ends up in the emitted SKILL.md. Computed in JS, not by the LLM. Auditable. |
| **`SkillGenerationRun`** | Provenance ledger of one solve attempt — status, cost, duration, files, telemetry, embedded Planner proposal, critic scores, security mode, install path. Persisted under `~/.aabcli/<ws>/skill-runs/<actionItemId>/<runId>.json`. |
| **adapter pass** | Defensive normalization of skill-creator's emitted SKILL.md against the current Claude Code frontmatter spec. Catches invented keys, missing required fields, allowed-tools mismatches, char-cap overruns. |
| **`linkedSkill`** | Optional field on `ActionItem` populated after install: `{name, runId, installedAt, installPath}`. Lets the Kanban show "✓ skill: <name>" badges and click-through to runs. |
| **headless invocation** | `claude -p --append-system-prompt-file <skill-creator-path>` — the only non-interactive way to drive skill-creator today. See §8. |
| **`--append-system-prompt-file`** | Claude CLI flag that prepends file content to the default system prompt (vs. `--system-prompt` which replaces). Required because we want Claude Code's default tool-use protocols AND skill-creator's instructions. |
| **destructive tool** | A tool whose name matches `*create*, *send*, *delete*, *charge*, *publish*, *deploy*` (case-insensitive). Planner flags these; Wizard requires extra confirmation; emitted SKILL.md may set `disable-model-invocation: true` if multiple destructive tools are granted. |
| **single-loop** | (sage-council legacy term) The internal authoring loop inside the skill builder. Sage-council ran this loop in JS over a virtual workspace. **We delegate the entire loop to skill-creator** and only see the final emitted package. |
| **virtual workspace** | (sage-council legacy term) In-memory `{ files: [{path, content}] }` shape. **Not used in our spec** — skill-creator authors against a real tempdir. |
| **maximalist moment** | Shorthand for the depth the Planner is meant to deliver across any action domain: noticing that the user's environment offers multiple integration surfaces (PC apps + MCPs + wiki context + web research), then designing a skill that orchestrates them end-to-end rather than producing a single artifact. From the user's framing message that defined this spec's depth requirement. The four canonical illustrations (§6.5b): Elgato YouTube intro (creative), Q3 pricing investigation (strategic-research), OAuth2 refactor (technical), DK SDR hire (operational). Despite very different domains, all four hit the ≥3-integrations bar on the maximalist tier. |
| **Elgato moment** | Legacy alias for *maximalist moment*. Specifically refers to Example 1 in §6.5b (the creative-domain illustration) — kept as a recognizable label but explicitly NOT the only shape the pattern takes. |
