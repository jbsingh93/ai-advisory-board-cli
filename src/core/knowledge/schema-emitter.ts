/**
 * Emit the wiki schema (`wiki/KNOWLEDGE.md`) plus the bootstrap skeleton
 * (`wiki/index.md` with empty `<!-- AAB:SLUG-MAP -->` sentinels and
 * `wiki/log.md`).
 *
 * Reference: `docs/development/KNOWLEDGE_WIKI.md` §12. Idempotent — `aab init` calls
 * `emitWikiSkeleton({ force: false })` so existing files are never
 * overwritten. `aab knowledge migrate --force-schema` is the only path that
 * re-writes `KNOWLEDGE.md`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths, ensureWikiDirs } from '../../storage/paths.js';
import {
  SLUG_MAP_OPEN,
  SLUG_MAP_CLOSE,
  defaultIndexHeader,
} from './slug-map.js';
import { initManifestIfAbsent } from './manifest.js';
import { nowIso } from '../utils.js';

export interface EmitWikiSkeletonOptions {
  workspaceRoot: string;
  /** When true, overwrite KNOWLEDGE.md even if it already exists. */
  forceSchema?: boolean;
}

export interface EmitWikiSkeletonResult {
  wrote: string[];
  skipped: string[];
}

export function emitWikiSkeleton(opts: EmitWikiSkeletonOptions): EmitWikiSkeletonResult {
  const p = paths(opts.workspaceRoot);
  ensureWikiDirs(opts.workspaceRoot);

  const wrote: string[] = [];
  const skipped: string[] = [];

  const writeIfAbsent = (path: string, body: string, force = false) => {
    if (existsSync(path) && !force) {
      skipped.push(path);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, 'utf8');
    wrote.push(path);
  };

  writeIfAbsent(p.wikiKnowledge, KNOWLEDGE_MD_TEMPLATE, !!opts.forceSchema);
  writeIfAbsent(p.wikiIndex, indexMdTemplate());
  writeIfAbsent(p.wikiLog, logMdTemplate());
  initManifestIfAbsent(p.manifest);
  return { wrote, skipped };
}

function indexMdTemplate(): string {
  return [
    defaultIndexHeader(),
    '',
    '## Slug map (auto-maintained — do not hand-edit)',
    '',
    SLUG_MAP_OPEN,
    '',
    '_No wiki pages yet. Run `aab knowledge ingest <path-or-url>` to seed._',
    '',
    SLUG_MAP_CLOSE,
    '',
  ].join('\n');
}

function logMdTemplate(): string {
  return [
    '# Wiki ingest log',
    '',
    `_Initialised ${nowIso()}._`,
    '',
    '> One line per ingest. Failed ingests are prefixed `[ingest-failed]`. Hand edits are okay but will not affect auto-ingest behaviour.',
    '',
  ].join('\n');
}

const KNOWLEDGE_MD_TEMPLATE = `# Knowledge Wiki — Schema and Conventions

This file is the canonical rule set for the wiki at \`wiki/\`. The advisory-board
members, the orchestrator, and the ingest/query/lint agents all read this file
before they read anything else. Edit it to customize behavior — the tool will
not overwrite it on subsequent inits.

## Directory layout

- \`raw/\` — immutable source documents. Never modified.
- \`wiki/concepts/\`   — ideas, strategies, patterns
- \`wiki/entities/\`   — companies, products, people, tools
- \`wiki/decisions/\`  — choices made, with rationale
- \`wiki/sources/\`    — 1:1 source summaries
- \`wiki/comparisons/\` — side-by-side analyses
- \`wiki/index.md\`    — the catalog (entry point for queries) AND the canonical
  slug→path map between \`<!-- AAB:SLUG-MAP -->\` sentinels
- \`wiki/log.md\`      — append-only ingest log
- \`outputs/\`         — dated lint reports and query archives
- \`.manifest.json\`   — provenance ledger

## Naming

Kebab-case for all wiki filenames. The slug in frontmatter must match the
filename minus \`.md\`. Source pages are humanized; the source's id appears in
the page footer, not the filename.

## Cross-references

Use \`[[kebab-slug]]\` everywhere. \`[[slug|Display Text]]\` is allowed.
Block links \`[[slug#section-header]]\` point to a markdown header inside the
target. Transclusion \`![[slug]]\` and block-id refs \`[[slug#^id]]\` are NOT
supported in v1. Path-prefixed links \`[[concepts/foo]]\` are NOT allowed.
Slugs (plus any aliases) are globally unique — lint enforces this.

**Resolving a \`[[wikilink]]\` without Obsidian:** the slug→path map lives in
\`wiki/index.md\` between the \`<!-- AAB:SLUG-MAP -->\` sentinels and is
maintained by ingest and lint. Read it first. If a slug is missing from the
map (stale index), \`Glob 'wiki/**/<slug>.md'\` returns the file (uniqueness
guarantees ≤1 hit). Manual file moves are unsupported — use
\`aab knowledge rename\`.

## Frontmatter (every page)

\`\`\`yaml
---
title: …
slug: …                 # must match filename minus .md
aliases: []             # optional alternate slugs; share global namespace
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
\`\`\`

## Page types

- **concept** — an idea, strategy, pattern, or framework. Not tied to a
  specific entity. E.g., \`pricing-strategy\`, \`unit-economics\`.
- **entity** — a specific noun: company, product, person, tool, market. E.g.,
  \`stripe\`, \`tesla\`, \`julian-bent-singh\`. Each board member gets one.
- **decision** — a choice the user (or board) made, with rationale. Always
  carries a date in the title and stable id in the footer. E.g.,
  \`2026-q1-focus-enterprise\`.
- **source-summary** — a 1:1 condensation of a single raw input. One per
  \`raw/\` file. Cites the document; pulls 3-7 key claims.
- **comparison** — side-by-side analysis of two or more entities/concepts.

## Ingest procedure (when filing a new source)

1. Hash the source. If hash exists in \`.manifest.json\`, skip.
2. Read the source.
3. **Read \`wiki/index.md\` — including the \`<!-- AAB:SLUG-MAP -->\` section.**
   This is your resolver: every existing page's slug, file path, type, and
   one-line summary lives here (aliases too). Use it to decide whether a
   page already exists and to emit accurate \`[[wikilinks]]\`.
4. Identify 3-10 most important claims, entities, concepts, decisions.
5. For each: decide create / update / skip. Pick the right type. Use
   \`[[wikilinks]]\` liberally — every connection compounds value. Use
   \`aliases:\` SPARINGLY (only for real ambiguity).
6. Block links \`[[slug#section-header]]\` are allowed for pointing at a
   specific markdown header. Block IDs \`[[slug#^id]]\` and transclusion
   \`![[slug]]\` are NOT supported — do not emit them.
7. Path-prefixed links \`[[concepts/foo]]\` are NOT allowed. Slug is
   canonical. Folder location is incidental.
8. ALWAYS create a \`wiki/sources/<humanized>.md\` for this source.
9. NEVER overwrite a page where frontmatter \`userEdited: true\`.
10. Update \`wiki/index.md\`: add new pages to the catalog. **DO NOT touch
    the \`<!-- AAB:SLUG-MAP -->\` section** — the orchestrator regenerates
    that section after your run.
11. **DO NOT touch any \`<!-- AAB:BACKLINKS -->\` section** in any page —
    lint owns those.
12. Append a single line to \`wiki/log.md\` with the timestamp and the list
    of pages you touched.

Tools allowed: Read, Grep, Glob, Write, Edit, WebFetch.

## Query procedure (when answering a question)

1. Read \`wiki/index.md\` (including the slug-map).
2. Grep \`wiki/\` for keywords from the question (target \`summary:\` and
   \`tags:\` first).
3. Read 3-10 most relevant pages. Follow \`[[wikilinks]]\` via the slug-map.
4. Synthesize an answer. Cite the wiki slugs you actually used.
5. Mark inferred claims with \`^[inferred]\`.

Tools allowed: Read, Grep, Glob.

## Lint procedure

Static checks (no LLM):
- Slug + alias uniqueness (global namespace)
- Frontmatter completeness
- Broken \`[[wikilinks]]\` + broken \`[[slug#header]]\` anchors
- Forbidden link forms: path-prefixed, transclusion, block IDs
- Broken \`sources:\` references
- Orphan pages
- Manifest drift (entries point to deleted files)
- Alias cap (warn at 80, error past 100)
- Sentinel integrity

LLM checks (\`fastModel\`):
- Contradictions
- Stale claims (page >90 days, newer source contradicts)
- Missing concepts (referenced ≥3× but no page)

Maintenance writes (no LLM):
- Rebuild slug-map in \`wiki/index.md\`
- Regenerate per-page \`<!-- AAB:BACKLINKS -->\` sections

Output: \`outputs/lint-<yyyy-mm-dd>.md\`. Tools: Read, Grep, Glob, Write.

## Provenance discipline

- \`extracted\` claims trace directly to a \`sources:\` entry.
- \`inferred\` claims are LLM synthesis across multiple sources. Mark with
  \`^[inferred]\` in the body.
- \`ambiguous\` claims have conflicting source evidence. Mark with
  \`^[ambiguous]\` and explain.
- A page's frontmatter \`provenance\` is the worst of any claim in its
  body (extracted < inferred < ambiguous).

## Tiered retrieval (perf)

Cheap pass: Grep page titles + summaries + tags. Open page bodies only when
the cheap pass cannot answer. Keep bodies short; keep summaries crisp
(≤200 chars).
`;
