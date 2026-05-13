# Knowledge Wiki — Karpathy-style LLM Wiki for `aabclitool`

> **Status:** authoritative design spec. Written 2026-05-10.
> **Supersedes:** the `BusinessContext` / `BusinessProfile` flat-JSON storage (`src/storage/types.ts:242-276`) and its inline injection in `src/core/discussion/build-user-message.ts:65-69, :103-123`.
> **Decisions baked in (confirmed by user 2026-05-10):**
> 1. Wiki lives **inside the workspace dir** (`~/.aabcli/<workspace>/wiki/` for `home` scope; `<projectRoot>/wiki/` for `project` scope — symmetric with how `.claude/agents/` already works).
> 2. Source-page filenames are **humanized + footer reference to id** (e.g., `wiki/sources/q3-pricing-pivot.md` for discussion `7a3f...` — id appears once in the page footer, not in the filename).
> 3. Wiki **fully replaces** `BusinessContext`. Migration command provided. Old code path retired in the same release.
> 4. Auto-summarization is **ON by default** (already true at `src/storage/types.ts:328`). On `discussion concluded`, a summary fires (Haiku/`fastModel`) and the result *plus the full transcript* auto-ingest into the wiki.

This document is intentionally long. It exists so any future coding agent (Claude Code, a teammate, or Future-You) can pick up the work cold and know exactly **what the wiki is, why we built it, and how every piece fits** without having to re-read the gist commentary or trace blog posts. Skim the table of contents and jump.

---

## Table of contents

1. [What this is, in one paragraph](#1-what-this-is-in-one-paragraph)
2. [External references — read these before editing](#2-external-references--read-these-before-editing)
3. [The core idea: the inversion](#3-the-core-idea-the-inversion)
4. [Why this fits aabclitool perfectly](#4-why-this-fits-aabclitool-perfectly)
5. [Architecture — the three layers](#5-architecture--the-three-layers)
6. [Decided design choices (locked)](#6-decided-design-choices-locked)
7. [Directory layout — final](#7-directory-layout--final)
8. [Frontmatter contract](#8-frontmatter-contract)
9. [Page-type taxonomy](#9-page-type-taxonomy)
10. [File-naming rules](#10-file-naming-rules)
11. [Cross-reference / wiki-link syntax](#11-cross-reference--wiki-link-syntax)
12. [The schema file: `wiki/KNOWLEDGE.md`](#12-the-schema-file-wikiknowledgemd)
13. [The manifest: `.manifest.json`](#13-the-manifest-manifestjson)
14. [Tool surface for agents](#14-tool-surface-for-agents)
15. [The three workflows](#15-the-three-workflows)
16. [Auto-ingest hook (the killer feature)](#16-auto-ingest-hook-the-killer-feature)
17. [CLI surface](#17-cli-surface)
18. [Web UI surface](#18-web-ui-surface)
19. [Migration from `BusinessContext`](#19-migration-from-businesscontext)
20. [Performance, cost, and model selection](#20-performance-cost-and-model-selection)
21. [Privacy and security](#21-privacy-and-security)
22. [Edge cases and failure modes](#22-edge-cases-and-failure-modes)
23. [Settings keys](#23-settings-keys)
24. [Build phasing — 8 chunks](#24-build-phasing--8-chunks)
25. [Testing strategy](#25-testing-strategy)
26. [Future extensions](#26-future-extensions)
27. [Glossary](#27-glossary)

---

## 1. What this is, in one paragraph

The Knowledge Wiki is a **persistent, interlinked, LLM-curated markdown knowledge base** that replaces the flat `BusinessContext` JSON the CLI currently injects into every advisory-board discussion. Every advisory-board member sub-agent (Elon, Julian, Alexandra, plus any custom members) can natively `Read`, `Grep`, and `Glob` the wiki — they already have those tools (`src/agents/emit-member-agent.ts:20`) — the same way Claude Code reads a codebase. The orchestrator can do the same. New information enters the wiki through **ingestion**: a one-shot Claude call that reads a source (a file the user dropped in, a URL the user pasted, a paragraph they typed, or — most importantly — a discussion that just concluded) and writes/updates wiki pages with proper cross-references and provenance. Over time, the wiki **compounds**: round 50 of any discussion benefits from every claim, fact, and conclusion that was ever filed. We're modeling this directly on Andrej Karpathy's "LLM Wiki" pattern, which went viral on X in April 2026 and has multiple reference implementations.

---

## 2. External references — read these before editing

If you are picking this up for the first time, read at least the gist (1) and one of the framework-style implementations (2 or 4). The blog walkthroughs (3, 5, 6) are helpful but redundant once you have the gist.

1. **Karpathy's gist (canonical source).** [llm-wiki gist by Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Posted April 2026; ~5,000 stars within days. Defines the three-layer architecture (`raw/` → `wiki/` → schema), the three workflows (ingest / query / lint), and the philosophy of "compile knowledge once, maintain it incrementally, instead of rediscovering on every query."
2. **Reference framework: `Ar9av/obsidian-wiki`.** [github.com/Ar9av/obsidian-wiki](https://github.com/Ar9av/obsidian-wiki). Skill-based implementation aimed at Claude Code / Cursor / Codex / Gemini / Kiro. Defines the canonical skill set: `wiki-setup`, `wiki-ingest`, `wiki-query`, `wiki-lint`. Source of the **tiered retrieval** insight — agents read titles → tags → frontmatter `summary:` → page bodies, in cheapest-first order. Source of the **`.manifest.json`** pattern.
3. **Walkthrough: Starmorph blog.** [How to Build Karpathy's LLM Wiki](https://blog.starmorph.com/blog/karpathy-llm-wiki-knowledge-base-guide). Most concrete on directory structure, kebab-case naming, the `[[wikilinks]]` syntax, the four page types (`concept | entity | source-summary | comparison`), and the YAML frontmatter contract.
4. **Reference framework: `NicholasSpisak/second-brain`.** [github.com/NicholasSpisak/second-brain](https://github.com/NicholasSpisak/second-brain). LLM-maintained second brain for Obsidian. Useful as a second data point on schema conventions and ingest skills.
5. **MindStudio walkthrough.** [What Is Andrej Karpathy's LLM Wiki?](https://www.mindstudio.ai/blog/andrej-karpathy-llm-wiki-knowledge-base-claude-code). Practical walkthrough using Claude Code as the maintainer.
6. **Aimaker substack walkthrough.** [Built an AI-Powered Second Brain in Obsidian](https://aimaker.substack.com/p/llm-wiki-obsidian-knowledge-base-andrej-karphaty). Heavy on user workflow — "drag in a PDF, ask the AI to file it" — which is the model we want for our `aab knowledge ingest` UX.
7. **DAIR.AI primer.** [LLM Knowledge Bases](https://academy.dair.ai/blog/llm-knowledge-bases-karpathy). Short conceptual write-up.
8. **Karpathy quote (the mental model).** *"Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase."* This is the critical framing: **the agent navigates the wiki the same way Claude Code navigates a codebase.** Grep, glob, read, follow links. No vector DB. No special infrastructure.
9. **`rohitg00/2067ab416f7bbe447c1977edaaa681e2` (LLM Wiki v2).** [Extension of Karpathy's pattern](https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2) with lessons from building agent-memory systems. Good for understanding edge cases (staleness, contradiction handling, provenance).

In-repo references that this design touches:

- `src/storage/types.ts:242-276` — `BusinessContext` and `BusinessProfile` types (deprecated; replaced by wiki pages).
- `src/storage/types.ts:328` — `autoSummarization: true` default (already correct).
- `src/storage/paths.ts:119, :139` — old `businessContext` path (will become `paths.wiki`, `paths.raw`, `paths.manifest`).
- `src/storage/fs-storage-service.ts:165-186` — old CRUD methods on `BusinessContext` (will be deleted after migrate).
- `src/core/discussion/build-user-message.ts:17, :28, :65-69, :103-123` — inline business-context injection (will be replaced by a one-line system-prompt addendum pointing agents at `wiki/`).
- `src/core/discussion/conversation-flow.ts:122, :148, :224-226, :379, :398, :706, :725` — `loadBusinessContextSafe` call sites (all retired).
- `src/agents/emit-member-agent.ts:20, :74, :136-137` — `DEFAULT_TOOLS = ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob']`. **Already correct** — members can read the wiki today. The only change here is appending a "Knowledge Wiki" stanza to each member's body so they know **where** to look.
- `src/core/discussion/orchestrator.ts:51` — `allowedTools: []`. **Will change** to `['Read', 'Grep', 'Glob']` so the orchestrator can ground its decisions in the wiki.

---

## 3. The core idea: the inversion

Pre-LLM-wiki RAG-style apps work like this:

```
User question → embed → vector search over chunks → stuff top-k into context → LLM answers
```

Every query rediscovers knowledge from raw chunks. The LLM never *learns*; it only retrieves. The user maintains the knowledge base; the LLM is a search front-end.

Karpathy's inversion flips it:

```
New source → LLM ingests → updates linked wiki pages → manifest tracks provenance
User question → LLM walks the wiki (Read/Grep/Glob) → answer cites wiki pages
```

The LLM **maintains compiled knowledge**. The wiki is a curated, deduplicated, cross-referenced markdown corpus. Querying it is cheap because the wiki was *written* with retrieval in mind: pages are short, summary frontmatter sits at the top, related pages are wiki-linked, contradictions are flagged.

**Three high-level operations**:

| Operation | What | When it runs |
|---|---|---|
| **Ingest** | Read a new source. Discuss it. Update / create wiki pages. Cross-link them. Append to log. Update manifest. | On `aab knowledge ingest`, on URL paste, on **discussion conclude** (auto). |
| **Query** | Read `wiki/index.md`, follow `[[wikilinks]]`, synthesize an answer with citations. Optionally file the answer back as a new wiki page. | Every advisory-board member call. Every orchestrator call. Every `aab knowledge query`. |
| **Lint** | Scan for contradictions, orphan pages, stale claims, missing-but-referenced concepts. Write a dated report to `outputs/`. | On `aab knowledge lint`. Optionally cron-able. |

**The compounding effect.** Discussion summaries auto-ingest. So round 50 has access to round 1's conclusions. Files dropped in last quarter are still there. URLs the user pasted three months ago are still cited. The wiki is the **persistent memory** of the advisory board — something the current `BusinessContext` flat-JSON cannot offer (it doesn't link, doesn't grow without truncation pressure, doesn't carry provenance).

---

## 4. Why this fits aabclitool perfectly

Four reasons. Read them — they are the justification for the architectural change.

1. **Members already have the right toolbelt.** Every member sub-agent is emitted with `tools: WebSearch, WebFetch, Read, Grep, Glob` (`src/agents/emit-member-agent.ts:20`). That is *exactly* the Claude Code surface for reading a codebase. We don't need to invent a retrieval mechanism — agents will walk the wiki natively. The only thing missing today is a system-prompt addendum that says "here's the wiki, here's how to search it, cite what you read."

2. **The current `BusinessContext` is the wrong primitive.** It's a flat JSON array of `{category, title, description, confidence}` items, capped at 12 items and 3.5k characters when injected (`build-user-message.ts:35-36`). It can't represent relationships ("our pricing strategy ties to our unit economics ties to our competitor analysis"), can't grow past the 3.5k-char ceiling without losing the most recent additions, and can't be authored or audited by a human (it's JSON behind the scenes). The wiki gives us **linked structure**, **no truncation pressure** (agents pull what they need), **per-claim provenance**, and **human-readable / human-editable** markdown.

3. **Discussions naturally produce wiki content.** Every discussion is itself a high-signal source: members cite facts, push back on each other, the orchestrator distills consensus, the user adds clarifications. The discussion summary (the next item we are shipping under Phase 1 closeout) is *already* a structured `{keyPoints, consensus, disagreements, actionableInsights}` payload (`src/storage/types.ts:126-134`). Auto-ingesting it into the wiki turns every discussion into permanent memory — no extra work for the user.

4. **It's the foundation for Phase 2's Decision Coach and Phase 5's Skill Creator.** The Decision Coach REPL will benefit hugely from being able to cite the user's prior decisions ("you decided to focus on enterprise three months ago — see `wiki/decisions/2026-q1-focus-enterprise.md`"). The Skill Creator's `BusinessProfile` injection (`src/core/skill/agent-environment-profile.ts` per PLAN §4.3.3) becomes "here's the company's `wiki/entities/company.md`" — a single page, edited live, instead of a one-time wizard blob.

---

## 5. Architecture — the three layers

```
┌──────────────────────────────────────────────────────────┐
│ Layer 3: SCHEMA  (rules)                                 │
│   wiki/KNOWLEDGE.md — page types, naming, link syntax,   │
│                       provenance, ingest/query/lint      │
│                       procedures.                        │
│                       Tool-emitted; user can edit.       │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ Layer 2: WIKI  (curated, mutable)                        │
│   wiki/index.md       (the catalog — entry point)        │
│   wiki/log.md         (append-only ingest log)           │
│   wiki/concepts/*.md  (ideas, strategies, patterns)      │
│   wiki/entities/*.md  (companies, products, people, …)   │
│   wiki/decisions/*.md (a choice + rationale + sources)   │
│   wiki/sources/*.md   (1:1 condensation of one raw doc)  │
│   wiki/comparisons/*.md (side-by-side analyses)          │
│   Written and updated by the LLM during ingest.          │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ Layer 1: RAW  (immutable inputs)                         │
│   raw/files/<hash>-<name>.<ext>                          │
│   raw/urls/<hash>.html|md (snapshotted at ingest time)   │
│   raw/pasted/<id>.md                                     │
│   raw/discussions/<short>.md   ← rendered transcripts    │
│   raw/summaries/<short>.md     ← summary payloads        │
│   NEVER MODIFIED. The LLM only ever reads these.         │
└──────────────────────────────────────────────────────────┘

.manifest.json — provenance ledger:
  for every ingested raw source, records hash, timestamp,
  and which wiki pages were produced or updated.
```

**Why three layers?** Because each has a different mutability and provenance contract:

- **Raw is immutable.** This is the verification baseline. Any wiki claim should point back to a `raw/` file. If the wiki ever drifts, the raw layer is the truth.
- **Wiki is mutable but curated.** The LLM rewrites pages on every ingest. Pages are short, summary-prefixed, cross-linked. Humans can edit too — the LLM respects manual edits (manifest tracks `userEdited: true`).
- **Schema is mutable rules.** Tells the LLM how to behave. Auto-emitted on first init; the user can fork it for custom workflows.

---

## 6. Decided design choices (locked)

The user confirmed these on 2026-05-10. They are not up for renegotiation without a fresh user decision.

| # | Decision | Rationale |
|---|---|---|
| 1 | Wiki lives **inside the workspace dir**. | Symmetric with how the workspace already works (`src/storage/paths.ts`). For `home` scope: `~/.aabcli/<ws>/wiki/`. For `project` scope: `<projectRoot>/wiki/`. Travels with the workspace. The `project`-scope case lets users commit the wiki to git alongside their code. |
| 2 | Source-page filenames are **humanized + footer reference to id**. | E.g., `wiki/sources/q3-pricing-pivot.md` is human-readable and Glob-friendly. The discussion id (`7a3f...`) appears once in the page footer (`> Source: discussion 7a3f3c12-…`) so the page is still fully traceable. Filenames you can read at a glance > filenames you have to cross-reference. |
| 3 | Wiki **fully replaces** `BusinessContext`. | Coexisting would mean two sources of truth and inevitable drift. The migrate command preserves all existing data as wiki pages; old code path is deleted in the same release. |
| 4 | Auto-summarization stays **ON by default**. (Already the seeded default at `src/storage/types.ts:328`.) | Cheap (Haiku/`fastModel`) and the summary becomes the seed for auto-ingest into the wiki. Cost is bounded — one Haiku call per concluded discussion. |
| 5 | Auto-ingest from concluded discussions is **ON by default**. | Same reasoning — cheap, and the entire value of the wiki is that knowledge compounds. Toggle: `knowledgeWiki.autoIngestDiscussions`. |
| 6 | No vector DB / no embeddings in Phase 1. | Karpathy's pattern works with markdown + Grep/Glob. The obsidian-wiki framework adds optional QMD semantic search; we treat that as a future extension (§26). |

---

## 7. Directory layout — final

Resolved relative to the workspace root (call it `WS_ROOT` below). For `home` scope, `WS_ROOT = ~/.aabcli/<workspace-id>/`. For `project` scope, `WS_ROOT = <projectRoot>/.aabcli/` (or wherever `paths.ts` resolves to today).

```
WS_ROOT/
├── raw/                                    # IMMUTABLE — never write back
│   ├── files/
│   │   ├── 5f3c8e-pricing-q3-2026.pdf      # <hash6>-<original-name>.<ext>
│   │   ├── 91a2b4-competitor-deck.md
│   │   └── …
│   ├── urls/
│   │   ├── 7c3a91.md                       # <hash6>.md   (HTML→md via WebFetch)
│   │   ├── 7c3a91.meta.json                # { url, fetchedAt, title, contentHash }
│   │   └── …
│   ├── pasted/
│   │   ├── 2026-05-10-1547-quick-thoughts.md
│   │   └── …
│   ├── discussions/                        # auto-populated
│   │   ├── q3-pricing-pivot.md             # rendered transcript of discussion 7a3f...
│   │   └── …
│   └── summaries/                          # auto-populated
│       ├── q3-pricing-pivot.md             # the ConversationSummary payload, rendered
│       └── …
├── wiki/                                    # MUTABLE — LLM-curated
│   ├── KNOWLEDGE.md                        # the schema (rules); tool-emitted, user-editable
│   ├── index.md                            # the catalog — entry point for queries
│   ├── log.md                              # append-only ingest log
│   ├── concepts/
│   │   ├── pricing-strategy.md
│   │   ├── unit-economics.md
│   │   └── …
│   ├── entities/
│   │   ├── company.md                      # the user's own company (was BusinessProfile)
│   │   ├── elon-musk.md                    # board members get pages too (cross-link from agent file)
│   │   ├── tesla.md
│   │   └── …
│   ├── decisions/
│   │   ├── 2026-q1-focus-enterprise.md
│   │   └── …
│   ├── sources/                            # 1:1 source summaries (one per raw/ doc)
│   │   ├── q3-pricing-pivot.md             # ← summarizes raw/discussions/ + raw/summaries/
│   │   ├── pricing-q3-2026-pdf.md          # ← summarizes raw/files/5f3c8e-…
│   │   └── …
│   └── comparisons/
│       ├── stripe-vs-lemonsqueezy.md
│       └── …
├── outputs/                                # dated reports
│   └── lint-2026-05-10.md                  # output of `aab knowledge lint`
└── .manifest.json                          # provenance ledger (see §13)
```

**Why these specific subfolders under `wiki/`** — they map to the four Karpathy-canonical page types (concept, entity, source-summary, comparison) plus one we add for our domain (`decision`). Each subfolder gives the LLM a strong "where does this go?" signal during ingest. They also give the user a navigable structure when browsing in a text editor or the Web UI.

**`raw/` is sharded by source kind** (`files/`, `urls/`, `pasted/`, `discussions/`, `summaries/`) because each kind has different metadata needs and ingest pre-processing. PDFs need `Read --pages`; URLs need WebFetch + a `.meta.json` for revalidation; pasted text gets a date-based filename.

---

## 8. Frontmatter contract

Every wiki page must begin with this YAML frontmatter. The LLM emits it on creation; the LLM updates `updated:` and `sources:` on every change; the LLM never silently drops fields it doesn't understand.

```yaml
---
title: Pricing Strategy
slug: pricing-strategy                 # kebab-case, must match filename minus .md
type: concept                          # concept | entity | decision | source-summary | comparison
summary: One-sentence synopsis used by the cheap-pass tier of query (≤200 chars).
tags: [pricing, monetization, b2b]     # free-form; lint flags new tags vs. _meta/taxonomy.md (future)
sources:                               # provenance — every claim should trace to a raw/ file
  - raw/discussions/q3-pricing-pivot.md
  - raw/files/5f3c8e-pricing-q3-2026.pdf
  - raw/urls/7c3a91.md
related:                               # outgoing wiki-links; updated when body changes
  - "[[unit-economics]]"
  - "[[customer-segments]]"
  - "[[stripe-vs-lemonsqueezy]]"
confidence: high                       # high | medium | low — author's certainty
provenance: extracted                  # extracted | inferred | ambiguous
                                       #   extracted = stated explicitly in a source
                                       #   inferred  = LLM synthesis across sources (mark in body too)
                                       #   ambiguous = sources disagree (lint will flag)
created: 2026-05-10
updated: 2026-05-10
userEdited: false                      # true if a human last touched this file (manifest also tracks)
---

## Body

Plain markdown. Cross-link liberally with `[[wikilinks]]`. When you make an
inferred claim, prefix it with `^[inferred]`; when sources disagree, prefix
with `^[ambiguous]` and explain the disagreement.

> Source footer (for source-summary pages):
> Discussion `7a3f3c12-…` (May 2026), 3 rounds, members: Elon Musk, Julian
> Bent Singh, Alexandra Chen.
```

**Why each field is here**:

- `title` / `slug`: human title for display, slug for cross-linking. Slug must equal filename so `[[pricing-strategy]]` resolves to `wiki/concepts/pricing-strategy.md` deterministically.
- `type`: lets the lint and query passes filter ("show me all decisions").
- `summary`: the **single most important field** for cheap retrieval. Agents Grep summaries first. Keep ≤200 chars; one well-written sentence beats a paragraph.
- `tags`: free-form for now; a future `wiki/_meta/taxonomy.md` pass can normalize.
- `sources`: provenance back to `raw/`. If a page has no `sources`, lint flags it as orphan-of-truth.
- `related`: explicit outgoing links (also embedded in body as `[[wikilinks]]`). Lets us compute the link graph without parsing the body.
- `confidence` / `provenance`: explicit certainty + how the claim was derived. Critical for the user to know whether to trust a wiki claim.
- `created` / `updated`: lint uses these to flag stale-and-contradicted pages.
- `userEdited`: true after any manual edit (manifest tracks too). LLM warns before overwriting human work.

---

## 9. Page-type taxonomy

Five types. Each has a one-paragraph definition and a "what goes here" rule. Ingest must classify each new piece of knowledge into exactly one type.

### `concept`
**An idea, strategy, pattern, framework, or conceptual model.** Generally not tied to a specific company or person. Examples: `pricing-strategy.md`, `unit-economics.md`, `freemium-conversion-funnel.md`, `network-effects.md`, `lean-startup-method.md`.
**Rule of thumb:** if you can ask "what *is* X?" and the answer doesn't depend on a specific entity, it's a concept.

### `entity`
**A specific noun: a company, product, person, tool, market, or geography.** Examples: `company.md` (the user's own), `tesla.md`, `stripe.md`, `julian-bent-singh.md`, `denmark.md`, `obsidian.md`.
**Rule of thumb:** if you'd write a Wikipedia article about it, it's an entity. Each board member gets an entity page so members can cross-cite each other.

### `decision`
**A choice the user (or board) made, with rationale.** Always carries a date in the title and stable id in the footer. Examples: `2026-q1-focus-enterprise.md`, `2026-may-pause-paid-ads.md`.
**Rule of thumb:** if it's an irreversible commitment of resources (time, money, headcount, scope), it's a decision. Critical for audit ("why did we do that?") and for the Decision Coach (Phase 2).

### `source-summary`
**A 1:1 condensation of a single raw input.** One source-summary page per `raw/` file. Examples: `q3-pricing-pivot.md` summarizes `raw/discussions/q3-pricing-pivot.md`; `pricing-q3-2026-pdf.md` summarizes `raw/files/5f3c8e-pricing-q3-2026.pdf`.
**Rule of thumb:** if it's about *one specific document*, it's a source-summary. The page body cites that document and pulls 3-7 key claims; the claims also propagate to relevant `concept` / `entity` / `decision` pages.

### `comparison`
**A side-by-side analysis of two or more entities, concepts, or options.** Examples: `stripe-vs-lemonsqueezy.md`, `enterprise-vs-self-serve-pricing.md`, `claude-vs-gpt-for-our-stack.md`.
**Rule of thumb:** if the value is in the *contrast*, not in any single side, it's a comparison.

**Disambiguation cases** (decided in advance to avoid LLM inconsistency):

- "Pricing for Acme Corp" → `entity:acme-corp.md` has a "Pricing" section; the *general* concept lives in `concept:pricing-strategy.md`.
- "Lessons from our Q3 board meeting" → `source-summary` for the discussion + propagation to relevant `concept` / `decision` pages.
- "Should we use Stripe?" → `decision:2026-may-payment-provider.md`; `comparison:stripe-vs-lemonsqueezy.md` is referenced from it.

---

## 10. File-naming rules

Locked per user decision §6.2. Concrete rules:

| Folder | Filename pattern | Example |
|---|---|---|
| `wiki/concepts/` | `<kebab-case-noun-phrase>.md` | `pricing-strategy.md` |
| `wiki/entities/` | `<kebab-case-name>.md` | `tesla.md`, `julian-bent-singh.md` |
| `wiki/decisions/` | `<yyyy>-<qN-or-month>-<kebab-summary>.md` | `2026-q1-focus-enterprise.md`, `2026-may-pause-paid-ads.md` |
| `wiki/sources/` | `<kebab-humanized-title>.md` (footer carries id) | `q3-pricing-pivot.md` (footer: `discussion 7a3f...`) |
| `wiki/comparisons/` | `<a>-vs-<b>.md` | `stripe-vs-lemonsqueezy.md` |
| `raw/files/` | `<hash6>-<original-filename>.<ext>` | `5f3c8e-pricing-q3-2026.pdf` |
| `raw/urls/` | `<hash6>.md` + `<hash6>.meta.json` | `7c3a91.md`, `7c3a91.meta.json` |
| `raw/pasted/` | `<yyyy>-<mm>-<dd>-<hhmm>-<kebab-snippet>.md` | `2026-05-10-1547-quick-thoughts.md` |
| `raw/discussions/` | `<kebab-humanized-question>.md` | `q3-pricing-pivot.md` |
| `raw/summaries/` | `<kebab-humanized-question>.md` (parallel to raw/discussions/) | `q3-pricing-pivot.md` |
| `outputs/` | `lint-<yyyy>-<mm>-<dd>.md`, `query-<yyyy>-<mm>-<dd>-<hhmm>.md` | `lint-2026-05-10.md` |

**`hash6`** = first 6 hex chars of SHA-256 of file bytes (for `raw/files/`) or canonical URL (for `raw/urls/`). Collisions: append `-2`, `-3`, … (lint will flag).

**Humanization** for source pages and discussion raws: take the first non-trivial 6 words of the question, kebab-case them, drop fillers (`the`, `a`, `an`, `is`, `are`, `should`, `we`, `our`). Keep ≤60 chars. If two discussions humanize to the same name, append `-2`.

**Why the footer-id rule matters.** `wiki/sources/q3-pricing-pivot.md` is human-readable. The discussion id appears exactly once in the page footer (`> Source: discussion 7a3f3c12-…`) so it stays traceable but doesn't pollute the filename. The Web UI's "open in CLI" link parses the footer.

---

## 11. Cross-reference / wiki-link syntax

Standard `[[kebab-case-slug]]` everywhere, no exceptions. Resolution rule:

1. `[[foo-bar]]` resolves to whichever of `wiki/{concepts,entities,decisions,sources,comparisons}/foo-bar.md` exists. Slug uniqueness across folders is **enforced by lint**: two pages with the same slug is an error.
2. `[[foo-bar|Display Text]]` is allowed (Obsidian-compatible) — display text in the rendered output, slug for resolution.
3. Never link by path. `[[concepts/foo-bar]]` is wrong. The slug is canonical.

**Why no path-prefixing**: it lets us move pages between folders (e.g., promote a `concept` to a `decision`) without rewriting backlinks. Lint resolves slug → path on every run.

**Backlinks** are computed at lint time and rendered into a "Backlinks" section at the bottom of each page (regenerated, never hand-edited; marked with `<!-- AAB:BACKLINKS -->` sentinel comments so the LLM doesn't overwrite them on regular edits).

---

## 12. The schema file: `wiki/KNOWLEDGE.md`

This is the **rules file**. The ingest, query, and lint agents read this *first* on every call so their behavior is consistent and customizable. Auto-emitted on `aab init` (or `aab knowledge migrate`); the user can edit it, and edits persist.

The emitted skeleton (we can refine later, but this is what version 1 ships):

```markdown
# Knowledge Wiki — Schema and Conventions

This file is the canonical rule set for the wiki at `wiki/`. The advisory-board
members, the orchestrator, and the ingest/query/lint agents all read this file
before they read anything else. Edit it to customize behavior.

## Directory layout

(See PLAN/KNOWLEDGE_WIKI.md §7 for the full layout. Summary:)
- `raw/` — immutable source documents. Never modified.
- `wiki/concepts/`   — ideas, strategies, patterns
- `wiki/entities/`   — companies, products, people, tools
- `wiki/decisions/`  — choices made, with rationale
- `wiki/sources/`    — 1:1 source summaries
- `wiki/comparisons/` — side-by-side analyses
- `wiki/index.md`    — the catalog (entry point for queries)
- `wiki/log.md`      — append-only ingest log
- `outputs/`         — dated lint reports and query archives
- `.manifest.json`   — provenance ledger

## Naming
Kebab-case for all wiki filenames. The slug in frontmatter must match the
filename minus `.md`. Source pages are humanized; the source's id appears in
the page footer, not the filename.

## Cross-references
Use `[[kebab-slug]]` everywhere. `[[slug|Display Text]]` is allowed.
Slugs are unique across the entire wiki — lint enforces this.

## Frontmatter (every page)
```yaml
---
title: …
slug: …                 # must match filename minus .md
type: concept | entity | decision | source-summary | comparison
summary: ≤200 chars one-line synopsis
tags: [free-form]
sources:                # provenance back to raw/
  - raw/…
related:
  - "[[other-slug]]"
confidence: high | medium | low
provenance: extracted | inferred | ambiguous
created: yyyy-mm-dd
updated: yyyy-mm-dd
userEdited: false
---
```

## Ingest procedure (when filing a new source)
1. Hash the source. If hash exists in `.manifest.json`, skip.
2. Read the source.
3. Read `wiki/index.md` to see what already exists.
4. For each key claim in the source, decide:
   - Is there an existing page for this concept/entity/decision? → update it
     (preserve user edits; merge new info; flag contradictions in body with
     `^[ambiguous]`).
   - Is there not? → create one. Pick the right type (§9 of this file).
5. Always also create a `wiki/sources/<humanized>.md` (1:1 condensation of
   this single raw doc).
6. Update `wiki/index.md` with new page entries.
7. Append to `wiki/log.md`: `<iso-timestamp> ingested <raw-path> → produced
   [page1, page2, …]`.
8. Update `.manifest.json`: add `{path, hash, ingestedAt, producedPages}`.

Tools allowed: Read, Grep, Glob, Write, Edit, WebFetch.

## Query procedure (when answering a question)
1. Read `wiki/index.md`.
2. Grep `wiki/` for keywords from the question (titles, summaries, tags).
3. Read 3-10 most relevant pages. Follow `[[wikilinks]]` for connected pages.
4. Synthesize an answer. Cite the wiki pages you used by slug.
5. Mark inferred claims with `^[inferred]`.

Tools allowed: Read, Grep, Glob.  (Read-only.)

## Lint procedure
Scan for:
- **Contradictions**: same claim, different conclusions across pages →
  flag with `^[ambiguous]` in both, list in lint report.
- **Orphan pages**: no incoming links → list in lint report.
- **Missing concepts**: a `[[wikilink]]` whose target page doesn't exist →
  list in lint report (suggest creating).
- **Stale claims**: page's `updated:` is >90 days old AND a newer source
  contradicts it → flag.
- **Slug collisions**: two pages with the same slug → error.
- **Broken sources**: `sources:` references a `raw/` file that no longer
  exists → flag.
- **Missing summaries**: pages without a `summary:` frontmatter field →
  flag (impacts cheap-pass retrieval).
Output: `outputs/lint-<yyyy-mm-dd>.md`.

Tools allowed: Read, Grep, Glob, Write.

## Provenance discipline
- `extracted` claims trace directly to a `sources:` entry — quote or
  paraphrase from a raw doc.
- `inferred` claims are LLM synthesis across multiple sources. Always
  mark with `^[inferred]` in the body so the user can audit.
- `ambiguous` claims have conflicting source evidence. Mark with
  `^[ambiguous]` and explain the disagreement.
- A page's frontmatter `provenance` is the *worst* of any claim in the
  body (extracted < inferred < ambiguous).

## Tiered retrieval (perf)
Cheap pass: agents Grep page titles + summaries + tags. Only open page bodies
when the cheap pass cannot answer. Keep bodies short; keep summaries crisp.
```

The schema file is **never overwritten on subsequent inits** — `aab init` only writes it if absent. `aab knowledge migrate --force-schema` is the only way to overwrite.

---

## 13. The manifest: `.manifest.json`

A single JSON file at the workspace root tracking every ingestion. Format:

```json
{
  "version": 1,
  "createdAt": "2026-05-10T15:47:00.123Z",
  "updatedAt": "2026-05-10T18:22:31.005Z",
  "entries": [
    {
      "id": "ing_01H7ZK…",
      "rawPath": "raw/files/5f3c8e-pricing-q3-2026.pdf",
      "sourceType": "file",
      "originalName": "Pricing Q3 2026.pdf",
      "hash": "5f3c8e…",
      "ingestedAt": "2026-05-10T15:47:00.123Z",
      "ingestModel": "claude-haiku-4-5-20251001",
      "ingestCostUsd": 0.0023,
      "producedPages": [
        "wiki/sources/pricing-q3-2026-pdf.md",
        "wiki/concepts/pricing-strategy.md",
        "wiki/entities/competitor-acme.md"
      ],
      "updatedPages": [
        "wiki/concepts/unit-economics.md"
      ],
      "userEditedPagesSkipped": []
    },
    {
      "id": "ing_01H80…",
      "rawPath": "raw/discussions/q3-pricing-pivot.md",
      "sourceType": "discussion",
      "discussionId": "7a3f3c12-…",
      "hash": "…",
      "ingestedAt": "2026-05-10T18:22:30.555Z",
      "ingestModel": "claude-haiku-4-5-20251001",
      "ingestCostUsd": 0.0041,
      "producedPages": ["wiki/sources/q3-pricing-pivot.md"],
      "updatedPages": [
        "wiki/concepts/pricing-strategy.md",
        "wiki/decisions/2026-may-pause-paid-ads.md"
      ]
    }
  ],
  "userEditedPages": [
    {
      "page": "wiki/entities/company.md",
      "lastEditedAt": "2026-05-09T11:14:02.000Z",
      "editorHint": "manual"
    }
  ]
}
```

**Why a manifest at all**: deduplication (same hash → skip), provenance audit, cost accounting, and to track human-edited pages so the LLM warns before overwriting them. Every ingest call updates the manifest atomically (the existing `writeJsonAtomic` helper at `src/storage/io.ts` handles this).

**`sourceType`** values: `file | url | pasted | discussion | summary | discussion-rerun`.

---

## 14. Tool surface for agents

The tool grants are intentional and minimal. Read carefully — these are the security boundary.

| Agent | Allowed tools | Why |
|---|---|---|
| **Member sub-agent** (during a discussion) | `WebSearch, WebFetch, Read, Grep, Glob` | Already correct (`emit-member-agent.ts:20`). No write access — members **read** the wiki, they don't modify it. Their structured `sources` field cites wiki slugs they used. |
| **Orchestrator** | `Read, Grep, Glob` | **New** — currently `[]` (`orchestrator.ts:51`). Read-only access lets the orchestrator ground "should we conclude / continue / clarify?" decisions in the wiki. |
| **Ingest agent** | `Read, Grep, Glob, Write, Edit, WebFetch` | Needs write access — this is the *only* agent allowed to mutate `wiki/`. WebFetch for URL-source ingestion. |
| **Query agent** (the `aab knowledge query` one-shot) | `Read, Grep, Glob` | Read-only. |
| **Lint agent** | `Read, Grep, Glob, Write` | Write access only to `outputs/lint-<date>.md`. The lint prompt explicitly forbids modifying `wiki/`. |

**System-prompt addendum for member agents** (appended to each `.claude/agents/<slug>.md` body — the existing AAB:GENERATED block per `src/agents/emit-member-agent.ts`):

```markdown
## Knowledge Wiki

Your project has a knowledge wiki at `wiki/` (markdown files with YAML
frontmatter). The schema is in `wiki/KNOWLEDGE.md` — read it first if you
haven't this session.

**To find context for a question:**
1. `Read wiki/index.md` — the catalog.
2. `Grep wiki/` for keywords from the question (target the `summary:` and
   `tags:` frontmatter fields first; they're the cheap pass).
3. `Read` 3-10 of the most relevant pages.
4. Follow `[[wikilinks]]` to connected pages when useful.

**When citing in your response:** put the wiki slugs you actually used into
your `sources` field. E.g., `sources: ["wiki/concepts/pricing-strategy",
"wiki/entities/company"]`. Do not invent slugs you didn't read.

**Never write to `wiki/`.** The ingest agent owns mutation. If you discover
something worth filing, mention it in your `actionableInsights` so the user
can ingest it explicitly.
```

This addendum is appended once at member-emit time. Members read it as part of their system prompt — no extra round-trips.

---

## 15. The three workflows

### 15.1 Ingest

**Triggered by:** `aab knowledge ingest <path|url> [--paste] [--discussion <id>]`, plus the auto-ingest hook (§16).

**Pipeline** (this is the spec — not psuedo-code, this is what to implement):

1. **Resolve the source**.
   - File path → read bytes; compute SHA-256; copy to `raw/files/<hash6>-<sanitized-original-name>.<ext>`.
   - URL → WebFetch (HTML→md); compute SHA-256 of canonical URL; write `raw/urls/<hash6>.md` and `raw/urls/<hash6>.meta.json` (`{url, fetchedAt, title, contentHash}`).
   - `--paste` → read stdin; timestamp filename → `raw/pasted/<yyyy-mm-dd-hhmm>-<kebab-snippet>.md`.
   - `--discussion <id>` → render the discussion via `render-discussion.ts` to `raw/discussions/<humanized>.md`; if a summary exists, also write `raw/summaries/<humanized>.md`. (This is the same path the auto-ingest hook uses.)
2. **Manifest dedup check.** If the hash exists in `.manifest.json` and `--force` was not passed, exit with a friendly "already ingested at <ts>" message.
3. **Run the ingest agent.** One `runClaude` call (`src/llm/claude-code-runner.ts`), no sub-agent persona, with:
   - **Model:** `settings.fastModel` (Haiku) by default. `--model` flag to override.
   - **Tools:** `Read, Grep, Glob, Write, Edit, WebFetch`.
   - **`maxTurns`:** 30 (a single ingest can touch dozens of pages).
   - **System prompt:** the ingest skill prompt (see template below).
   - **User message:** "Ingest the source at `<rawPath>`. Read it; read `wiki/KNOWLEDGE.md`; read `wiki/index.md`; create or update wiki pages following the schema; cite this source in `sources` frontmatter; append to `wiki/log.md`."
4. **Parse the agent's final message.** It must return JSON: `{producedPages: string[], updatedPages: string[], skipped: string[], notes?: string}`. Use `safeParseJSON` (`src/core/parsing/safe-json.ts`) — fall back to a "scan tool calls for write paths" heuristic if JSON fails.
5. **Atomic manifest update.** Append the new entry, bump `updatedAt`, write atomically via `writeJsonAtomic`.
6. **Return** the ingest result (cost, pages produced/updated, notes).

**Ingest skill prompt template** (proposed; lives at `src/core/prompts/skill-ingest.ts`):

```
You are the wiki ingest agent for an AI advisory board CLI tool. Your job is
to read a single new source document and update the user's knowledge wiki
to incorporate its information.

## Source to ingest
{{rawPath}}

## Wiki schema
{{wikiKnowledgeMd}}    ← inlined from wiki/KNOWLEDGE.md

## Wiki index (current state)
{{wikiIndexMd}}        ← inlined from wiki/index.md (truncated if huge)

## Your procedure
1. Read the source.
2. Identify the 3-10 most important claims, entities, concepts, decisions.
3. For each: does a wiki page exist? Decide: create / update / skip.
4. When creating: pick the right type (concept | entity | decision |
   source-summary | comparison). Use `[[wikilinks]]` to connect to existing
   pages liberally. Write proper frontmatter (see schema).
5. ALWAYS create a `wiki/sources/<humanized>.md` for this source — even if
   the rest of the ingest is small. The source page is the audit trail.
6. NEVER overwrite a page where frontmatter `userEdited: true`. Skip and
   list it under `skipped` in your final output.
7. Update `wiki/index.md`: add new pages to the appropriate sections.
8. Append a single line to `wiki/log.md` with the ingest timestamp and the
   list of pages you touched.

## Output
After all writes, return ONLY this JSON object:
{
  "producedPages": ["wiki/concepts/pricing-strategy", …],
  "updatedPages":  ["wiki/entities/company"],
  "skipped":       ["wiki/decisions/2026-q1-…"],
  "notes":         "Optional 1-2 sentence summary of what changed."
}
```

### 15.2 Query

**Triggered by:** member agents during discussions (read-only, system-prompt-driven), the orchestrator, and the user-facing `aab knowledge query "<question>"` command.

**For member agents and orchestrator:** no special command. The system-prompt addendum (§14) tells them the wiki is at `wiki/` and how to use Read/Grep/Glob. They walk it natively.

**For the user-facing query command:** one `runClaude` call:
- **Model:** `settings.primaryModel` (Sonnet) by default — quality matters here.
- **Tools:** `Read, Grep, Glob`.
- **`maxTurns`:** 15.
- **System prompt:** the query skill prompt.
- **User message:** "Question: `{{question}}`. Answer it citing wiki pages. Mark inferred claims with `^[inferred]`."

The user can pipe `--out outputs/query-<ts>.md` to archive the answer; or `--save-as concept|entity|…` to file the answer back into the wiki as a new page (the "knowledge compounds" idea Karpathy emphasizes).

### 15.3 Lint

**Triggered by:** `aab knowledge lint [--write]`. Optionally cron-able by the user (out of scope for v1).

**Pipeline:**
1. Walk `wiki/` (Glob `wiki/**/*.md`). Parse each page's frontmatter.
2. Build the link graph: for each page, parse `[[slugs]]` from body + `related:` field. Compute backlinks.
3. Static checks (no LLM):
   - Slug uniqueness across all folders.
   - Frontmatter completeness (`title, slug, type, summary, sources, created, updated`).
   - Broken `[[wikilinks]]` (target slug not found).
   - Broken `sources:` (referenced `raw/` file missing).
   - Orphan pages (zero incoming links — except `index.md` and `log.md`).
4. LLM checks (one `runClaude` call, model = `fastModel`, tools = `Read, Grep, Glob`):
   - Contradiction scan: any page where two `sources:` say different things on the same claim.
   - Stale-claim scan: pages older than `lintStaleDays` (default 90) where a more recent source contradicts.
   - Missing-concept scan: `[[wikilinks]]` referenced ≥3 times but page doesn't exist.
5. Write `outputs/lint-<yyyy-mm-dd>.md`. Pretty-print. Group by severity (`error | warn | info`).
6. Optional: print a summary to stdout (counts per severity).

---

## 16. Auto-ingest hook (the killer feature)

This is the bit that makes the wiki *grow itself* — and the reason the user said "REALLY pay attention" in the original brief.

**Trigger point:** the existing discussion-conclude path in `src/core/discussion/conversation-flow.ts`. Specifically, in the same place where `autoSummarization` fires (Phase 1 closeout work). Pseudo-flow:

```ts
// in conversation-flow.ts, after orchestrator returns action='conclude':
if (settings.autoSummarization) {
  const summary = await summarizeDiscussion({ discussion, settings, storage });
  discussion.summary = summary;
  await storage.saveDiscussion(discussion);
}
if (settings.knowledgeWiki?.autoIngestDiscussions !== false) {
  // 1. Render the transcript to raw/discussions/<humanized>.md
  // 2. Render the summary to raw/summaries/<humanized>.md (if present)
  // 3. Run the ingest agent on raw/discussions/<humanized>.md
  //    (the agent will also Read raw/summaries/<humanized>.md if present)
  await ingestDiscussion({ discussion, summary, settings, storage });
}
```

**Why this matters:**

1. The user does nothing. Discussions just *become* part of the wiki. No "remember to file your discussion" step.
2. The summary-and-transcript split is intentional. The summary is the LLM's distilled view; the transcript is the raw signal. Auto-ingest reads both — the summary anchors the page-update decisions, the transcript provides the quotable evidence for `sources:`.
3. Cost is bounded. Haiku-priced summarize + Haiku-priced ingest ≈ a few cents per discussion. Toggleable per workspace.

**Failure mode handling:** auto-ingest is wrapped in a try/catch — a failed ingest never blocks discussion completion. The error gets logged to `wiki/log.md` with `[ingest-failed]` prefix; the user can manually re-run with `aab knowledge ingest --discussion <id>` later.

**User HITL responses also get auto-ingested.** Settings `knowledgeWiki.autoIngestUserResponses: true` (default true) — when the user answers an orchestrator clarification (`aab discuss respond`), the response text is treated as a paste-style raw input and ingested. This is how the wiki learns the user's stated preferences and corrections over time.

---

## 17. CLI surface

```
aab knowledge ingest <path-or-url>       Ingest a file, URL, or raw text into the wiki.
                                         Accepts: .md, .txt, .pdf paths; http/https URLs.
  [--paste]                              Read stdin instead of a path.
  [--discussion <id>]                    Re-ingest (or initial ingest if it skipped) a discussion.
  [--type concept|entity|...]            Hint to the agent (rarely needed; agent decides).
  [--model <alias>]                      Override the ingest model (default: fastModel).
  [--force]                              Re-ingest even if hash already in manifest.
  [--json]                               Machine-readable output.

aab knowledge query "<question>"         Ask the wiki a question (read-only, citing pages).
  [--max-pages <n>]                      Cap pages opened (default 10).
  [--out <path>]                         Save the answer to a markdown file.
  [--save-as concept|entity|...]         File the answer back into the wiki as a new page.

aab knowledge lint                       Run health checks on the wiki.
  [--write]                              Write the report to outputs/lint-<date>.md (default true).
  [--max-pages <n>]                      Cap LLM-pass pages (cost control).

aab knowledge list                       List all wiki pages, grouped by type.
  [--type concept|entity|...]            Filter by type.
  [--orphans]                            Only pages with zero incoming links.
  [--user-edited]                        Only pages marked userEdited: true.

aab knowledge show <slug>                Pretty-print one wiki page (frontmatter + body + backlinks).

aab knowledge edit <slug>                Open the page in $EDITOR. Marks userEdited: true on save.

aab knowledge open <slug>                Print absolute filesystem path (handy for piping into editors).

aab knowledge migrate                    One-time: convert existing BusinessContext / BusinessProfile
                                         JSON into wiki pages. Idempotent.
  [--dry-run]                            Show what would be written, don't write.
  [--force-schema]                       Overwrite wiki/KNOWLEDGE.md.

aab knowledge stats                      Page count by type, total raw sources, last ingest, total ingest cost.

aab knowledge graph                      Print the link graph in DOT format (for graphviz / Web UI).
  [--out <path>]                         Write to file.

aab knowledge backfill <discussion-id>   Manually run the auto-ingest hook for one past discussion.
                                         (Useful when the hook was off when it concluded.)
```

All commands respect global flags (`--workspace`, `--json`, `--verbose`).

---

## 18. Web UI surface

(Phase 6.5 follow-on; not part of the initial wiki Phase 1.5 cut.)

New sidebar item: **Knowledge** (icon: book / graph). Replaces the "Business Context" item that the current UI may eventually have.

**Views inside the Knowledge tab:**

1. **Graph view** (default landing). A force-directed graph: nodes are wiki pages (color-coded by type), edges are wiki-links. Hover a node → frontmatter `summary:` in a tooltip. Click a node → opens page detail. Filter by type. Search bar at top.
2. **Page list** (table view). Columns: title, type, summary, tags, updated, confidence. Sortable. Filter chips for type and orphan status.
3. **Page detail**. Rendered markdown body, sidebar showing frontmatter + sources (link to `raw/`) + backlinks list. "Edit" opens an inline markdown editor (saves back via `aab knowledge edit` mechanism).
4. **Raw sources list**. Table of all `raw/` files, showing: filename, source type, ingested at, hash, produced pages (links into the wiki).
5. **Ingest panel**. Drag-drop file zone, URL input, paste textarea. Posting triggers `POST /api/knowledge/ingest`; the ingest result streams back over WS (same pattern as discussions).
6. **Query panel**. Question textarea, "Ask" button. Streams the answer with clickable citations (each citation opens the wiki page detail).
7. **Lint panel**. Run-now button; shows the latest `outputs/lint-*.md` rendered. Severity filter chips.

**API endpoints to add to `src/gui/server.ts`:**

```
GET    /api/knowledge/state              { pageCount, byType, lastIngestAt, totalCostUsd }
GET    /api/knowledge/pages              [{ slug, title, type, summary, tags, updated, … }]
GET    /api/knowledge/pages/:slug        { frontmatter, body, backlinks, rawSources[] }
POST   /api/knowledge/pages/:slug        Save edits (server marks userEdited:true)
POST   /api/knowledge/ingest             multipart upload OR { url } OR { paste }; streams progress over WS
POST   /api/knowledge/ingest/discussion/:id  Auto-ingest hook trigger
POST   /api/knowledge/query              { question } → { answer, citations[], cost }
POST   /api/knowledge/lint               kicks off lint; streams progress; returns lint-<date>.md content
GET    /api/knowledge/graph              { nodes: [{slug,type}], edges: [{from,to}] }
GET    /api/knowledge/raw                List raw sources
GET    /api/knowledge/raw/:hash          Stream raw file content
```

WS event types to add:
- `wiki_ingest_started` `{ rawPath, sourceType }`
- `wiki_ingest_page_written` `{ path, action: 'created'|'updated' }`
- `wiki_ingest_done` `{ producedPages, updatedPages, costUsd }`
- `wiki_query_started` / `wiki_query_done`
- `wiki_lint_done` `{ reportPath, errorCount, warnCount }`

---

## 19. Migration from `BusinessContext`

One-time, idempotent. Implemented as `aab knowledge migrate`.

**What gets converted:**

| Source | Target |
|---|---|
| Each `BusinessContext` item with category `company` | merged into `wiki/entities/company.md` (one section per item) |
| Each `BusinessContext` item with category `industry` / `market` | merged into `wiki/entities/<industry-name>.md` (or `wiki/concepts/market-<slug>.md` if no specific industry name) |
| Each `BusinessContext` item with category `goals` / `challenges` / `strategy` | one `wiki/concepts/<title-slug>.md` per item |
| Each `BusinessContext` item with category `team` | merged into `wiki/entities/team.md` |
| Each `BusinessContext` item with category `product` | one `wiki/entities/<product-slug>.md` |
| Each `BusinessContext` item with category `tools` | merged into `wiki/entities/tools.md` |
| `BusinessProfile` (the wizard blob) | one `wiki/entities/company.md` (overrides any company-category items above) |

For each converted item:
- `confidence` → frontmatter `confidence:` (high if ≥0.8, medium if ≥0.5, else low)
- `extractedFrom` → frontmatter `provenance:` (`extracted` if `extractedFrom` is a known discussion id, else `inferred`) plus a `sources: [discussion:<id>]` placeholder if present
- `relevantKeywords` → frontmatter `tags:`
- `description` → page body
- `createdAt` / `updatedAt` → frontmatter `created` / `updated`
- A migration marker is written in the body footer: `> Migrated from BusinessContext on <ts>.`

**After migration:**
1. `business-context.json` is renamed to `business-context.json.migrated.bak` (kept for rollback).
2. The `paths.businessContext` field is deprecated but the file path remains so any in-flight discussions don't crash.
3. `loadBusinessContextSafe` in `conversation-flow.ts` is updated to *first* try the wiki (if `wiki/` exists, return `[]` so the inline injection block is skipped) and falls back to the old JSON only when the wiki is absent. After the next release, that fallback is deleted entirely.

**Idempotency:** running `migrate` twice is safe — the second run sees the manifest entries from the first run and skips. `--force` re-runs anyway (overwrites pages, except `userEdited: true` ones).

---

## 20. Performance, cost, and model selection

**Default models** (all overridable per call):

| Operation | Default model | Why |
|---|---|---|
| Ingest | `fastModel` (Haiku) | Mostly mechanical: read source, follow schema, write pages. Cheap. |
| Query (`aab knowledge query`) | `primaryModel` (Sonnet) | Quality matters when the user is asking. |
| Member agents reading the wiki | (already-running model) | They're inside an existing member call; no extra cost beyond a few tool-call round trips. |
| Orchestrator reading the wiki | `fastModel` (already, per `orchestrator.ts:49`) | Cheap. |
| Lint static checks | (no LLM) | Pure parse work. |
| Lint LLM checks | `fastModel` (Haiku) | Mostly classification — cheap. |

**Cost ceiling per ingest** (rough): 30 turns × ~5k input tokens × Haiku rate ≈ a few cents. **Per concluded discussion**: summarize + ingest ≈ 5-10¢. Bounded; fine for the always-on default.

**Tiered retrieval** (the obsidian-wiki framework's key insight): keep page bodies short, keep `summary:` frontmatter crisp. Member/orchestrator agents Grep summaries first; only open bodies when the cheap pass can't answer. This is what keeps cost flat as the wiki grows from 50 pages to 500.

**Context-window budgets** (per `src/core/discussion/build-user-message.ts:35-37` patterns): the wiki replaces the 3.5k-char `BusinessContext` injection. Members no longer get a flat blob — they pull what they need. This *frees* roughly 3.5k input tokens per member call, which can be reinvested elsewhere or just saved.

---

## 21. Privacy and security

- **All data on disk.** No external services. The wiki ships with the workspace (matching the rest of the CLI's filesystem-only model).
- **`raw/` is the source of truth.** Wiki pages can be regenerated from `raw/` if anything goes wrong.
- **WebFetch caching.** URLs ingested via `aab knowledge ingest <url>` are snapshotted at fetch time to `raw/urls/<hash>.md`. Re-ingest reads the cache, so the wiki doesn't drift if the URL changes upstream. `--force` re-fetches.
- **No API key leakage.** Nothing in the wiki should ever contain credentials. The ingest skill prompt explicitly forbids writing keys, secrets, or anything that looks like one (regex-checked at write time).
- **Workspace isolation.** Each workspace has its own `raw/`, `wiki/`, `.manifest.json`. Switching workspaces switches knowledge bases. (Matches existing behavior of `BusinessContext` and discussions.)
- **`.gitignore` template.** When `aab init` runs in a `project`-scope workspace, it adds `raw/` to a recommended `.gitignore` (raw sources may include sensitive PDFs); `wiki/` is NOT gitignored — committing the curated knowledge base alongside the project is encouraged.

---

## 22. Edge cases and failure modes

| Case | Handling |
|---|---|
| User ingests the same file twice | Hash dedup in manifest → skip. `--force` to re-run. |
| User edits a wiki page manually, then re-ingests a related source | Page's `userEdited: true` (set by `aab knowledge edit`) → ingest agent skips it; manifest records under `userEditedPagesSkipped`; lint surfaces the skipped page so the user can decide. |
| Two pages end up with the same slug (e.g., user creates `concepts/stripe.md` and `entities/stripe.md`) | Lint flags as error. CLI `aab knowledge migrate --fix-slug-collisions` resolves with `-2` suffix. |
| Wiki page references a `raw/` file that's been deleted | Lint flags as `error`. Suggested fix: re-ingest from a current source, or delete the page. |
| `[[wikilink]]` whose target doesn't exist | Lint flags as `warn`. If referenced ≥3 times, escalates to "missing concept" and suggests creation. |
| Ingest agent times out mid-ingest (partial writes) | Manifest only updates on success. The next ingest sees no manifest entry → re-runs idempotently (the agent reads existing `wiki/` state and merges). |
| URL ingest where the page is JS-rendered (WebFetch returns boilerplate) | Manifest records the empty result; lint flags. User can pre-render and `aab knowledge ingest --paste` instead. |
| User deletes a discussion (`aab discuss delete`) | The discussion's `raw/discussions/*.md` and `raw/summaries/*.md` become orphans. Lint flags. User runs `aab knowledge prune-orphans` (future) to clean up. |
| User changes workspace (`aab workspace switch`) | The wiki is per-workspace; the new workspace has its own (possibly empty) wiki. Member sub-agents read the *current* workspace's wiki. |
| Wiki gets very large (1000+ pages) | Tiered retrieval keeps cost flat. Optional QMD plugin (§26) for sub-second semantic search. |
| Ingest produces a contradiction with an existing claim | Both pages get `provenance: ambiguous`; the body of each gets a `^[ambiguous]` marker explaining the disagreement. Lint promotes to `warn`. |

---

## 23. Settings keys

Add to `AppSettings` (`src/storage/types.ts:300`) under a new `knowledgeWiki` namespace:

```ts
knowledgeWiki: {
  enabled: boolean;                          // default: true
  autoIngestDiscussions: boolean;            // default: true
  autoIngestUserResponses: boolean;          // default: true (aab discuss respond bodies → raw/pasted/)
  ingestModel: ClaudeModelAlias;             // default: 'haiku' (= settings.fastModel)
  queryModel: ClaudeModelAlias;              // default: 'inherit' (= settings.primaryModel)
  lintStaleDays: number;                     // default: 90
  maxAgentPagesPerCall: number;              // default: 10 (caps how many pages a query opens)
  pageBodySoftCap: number;                   // default: 4000 chars; lint warns above
  summarySoftCap: number;                    // default: 200 chars; lint warns above
  exposeToMemberAgents: boolean;             // default: true (the system-prompt addendum)
  exposeToOrchestrator: boolean;             // default: true (opens orchestrator.allowedTools)
}
```

All overridable via `aab settings set knowledgeWiki.<key> <value>` once the existing settings command supports nested paths (small refactor in `src/commands/settings.ts`).

---

## 24. Build phasing — 8 chunks

Each chunk is independently shippable and testable.

| # | Chunk | Deliverables |
|---|---|---|
| 1 | **Wiki skeleton + manifest** | `paths.ts` adds `wiki`, `raw`, `manifest`, `outputs`. `aab init` emits `wiki/KNOWLEDGE.md` + empty `wiki/index.md` + `wiki/log.md`. `.manifest.json` initialized. New `src/core/knowledge/manifest.ts` (load/save/dedup). New `src/core/knowledge/page.ts` (frontmatter parse/serialize, slug helpers). |
| 2 | **File / text / paste ingest** | `src/core/knowledge/ingest.ts`. `src/core/prompts/skill-ingest.ts` (the prompt template). `aab knowledge ingest <path>` and `aab knowledge ingest --paste`. Manifest dedup. Atomic writes. PDF support via Read tool. |
| 3 | **URL ingest** | WebFetch path; `raw/urls/<hash>.md` + `.meta.json`. Re-fetch with `--force`. |
| 4 | **Member + orchestrator integration** | Append the §14 system-prompt addendum to every emitted member agent file (`src/agents/emit-member-agent.ts`). Open `orchestrator.allowedTools = ['Read', 'Grep', 'Glob']`. Settings flag `exposeToMemberAgents`, `exposeToOrchestrator`. |
| 5 | **Auto-ingest hook on discussion conclude** | `conversation-flow.ts` post-conclude: render transcript + summary to `raw/`, run ingest. Wrapped in try/catch; never blocks discussion completion. Settings flag `autoIngestDiscussions`. |
| 6 | **Query + lint commands** | `src/core/knowledge/query.ts`, `src/core/knowledge/lint.ts`. `aab knowledge query`, `aab knowledge lint`. Static + LLM lint passes. `outputs/lint-<date>.md`. |
| 7 | **Migrate + retire BusinessContext** | `aab knowledge migrate`. Update `loadBusinessContextSafe` to no-op when wiki present. Delete inline business-context block from `build-user-message.ts`. Rename `business-context.json` → `business-context.json.migrated.bak`. Drop `BusinessContext` CRUD methods (`fs-storage-service.ts:165-186`). |
| 8 | **Web UI** | Knowledge tab with graph, list, detail, ingest, query, lint panels. WS events. `/api/knowledge/*` endpoints. |

**Order matters**: chunks 1-3 can ship independently of the rest (the wiki exists, you can ingest into it, but agents don't read it yet). Chunk 4 turns it on for discussions. Chunk 5 makes it self-feeding. Chunks 6-7 close the loop. Chunk 8 is UI polish on top.

---

## 25. Testing strategy

(Slot into the existing testing plan in PLAN.md §4.7.)

- **Unit tests** (`src/core/knowledge/__tests__/`):
  - `page.test.ts` — frontmatter round-trip; slug ↔ filename; backlink computation.
  - `manifest.test.ts` — dedup; atomic update; concurrent ingest (proper-lockfile).
  - `slug.test.ts` — humanization rules; collision suffixing.
- **Integration tests** (mocked Claude):
  - `ingest-file.test.ts` — feed a small markdown source through the ingest pipeline; assert wiki pages, manifest, log all updated.
  - `auto-ingest.test.ts` — mock a concluded discussion; assert auto-ingest fires and produces a `wiki/sources/*.md`.
  - `migrate.test.ts` — feed a fixture `business-context.json`, assert the expected wiki page set.
  - `lint.test.ts` — fixture wiki with known issues; assert the lint report flags them all.
- **Golden-file tests** for prompts:
  - `skill-ingest.golden.md` — input source + wiki snapshot → expected page diff. Re-baseline with `AAB_UPDATE_GOLDENS=1`.
  - `skill-query.golden.md` — input question + wiki snapshot → expected answer.
- **Live test** (`AAB_LIVE_TEST=1`): end-to-end ingest of a real PDF + a real URL + a real discussion conclude → assert manifest grows, agent can answer a query that requires wiki context.

---

## 26. Future extensions

Out of scope for v1, but the architecture supports them cleanly:

1. **QMD semantic search** (per the obsidian-wiki framework). Optional plugin: a vector index over `wiki/` page bodies. Falls back to Grep when not configured. Env var: `AAB_KNOWLEDGE_QMD_COLLECTION`.
2. **Cron lint.** OS-level scheduler (cron / Task Scheduler) → `aab knowledge lint`. Output to `outputs/lint-<date>.md`. CLI command `aab knowledge schedule-lint --weekly` to set up.
3. **Multi-workspace knowledge fusion.** `aab knowledge import --from <other-workspace>` to copy wiki pages between workspaces (with collision resolution).
4. **Image ingestion.** PDFs that contain charts/diagrams → extract images to `raw/images/`, embed in wiki pages as markdown image refs.
5. **Conversation continuity.** Future Claude calls receive `wiki/_recent-changes.md` (auto-rendered list of pages modified in the last 7 days) so agents always know "what's new" — useful for the Decision Coach.
6. **Cross-board sharing.** Export selected wiki pages as a portable bundle for sharing between users or boards.
7. **Audit log views.** Web UI panel that renders `wiki/log.md` as a timeline.
8. **Slack / email ingest.** `aab knowledge ingest --from slack-export.zip` to bulk-import past conversations.

---

## 27. Glossary

| Term | Definition |
|---|---|
| **Wiki** | The full markdown corpus at `wiki/`. Mutable, LLM-curated. |
| **Raw** | The immutable source corpus at `raw/`. The verification baseline. |
| **Schema** | The rules file at `wiki/KNOWLEDGE.md`. Tells the LLM how to behave. |
| **Manifest** | The provenance ledger at `.manifest.json`. Tracks every ingest. |
| **Page** | One markdown file in `wiki/`. Has frontmatter + body + (computed) backlinks. |
| **Slug** | The kebab-case identifier for a page; matches the filename minus `.md`. |
| **Wiki-link** | A `[[slug]]` cross-reference. Resolves anywhere in `wiki/` regardless of subfolder. |
| **Page type** | One of `concept`, `entity`, `decision`, `source-summary`, `comparison`. Determines subfolder. |
| **Provenance** | The certainty/origin marker on a claim or page: `extracted`, `inferred`, `ambiguous`. |
| **Ingest** | The workflow of filing a new source into the wiki. |
| **Query** | The workflow of answering a question by walking the wiki. |
| **Lint** | The workflow of scanning for wiki health issues. |
| **Tiered retrieval** | The pattern of Grepping summaries before opening bodies. Performance-critical. |
| **Auto-ingest hook** | The mechanism that fires ingest on every concluded discussion. |
| **Cheap pass** | A search restricted to titles, tags, summaries (frontmatter only). Used before opening page bodies. |

---

*If you are a future coding agent reading this: the locked decisions in §6 are not up for change without a fresh user decision. Everything else is subject to refinement as you build. Read §24 for what to build next; read §15 for the workflow contracts; read the external references in §2 if you've never seen Karpathy's pattern. Welcome aboard.*
