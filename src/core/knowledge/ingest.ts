/**
 * Wiki ingest pipeline.
 *
 * Phases (per `docs/development/KNOWLEDGE_WIKI.md` §15.1):
 *  1. Resolve the source → write to `raw/<bucket>/`.
 *  2. Manifest dedup check (skip if hash exists, unless `force`).
 *  3. Run the ingest agent (one `runClaude` call with `Read,Grep,Glob,Write,Edit`).
 *  4. Parse the agent's JSON output.
 *  5. Rebuild slug-map in `wiki/index.md`.
 *  6. Append manifest entry atomically.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { paths, ensureWikiDirs, type ResolvedWorkspace } from '../../storage/paths.js';
import { runClaude, extractText } from '../../llm/claude-code-runner.js';
import { safeParseJSON } from '../parsing/safe-json.js';
import { logger } from '../logger.js';
import { nowIso } from '../utils.js';
import { ModelError, UserError } from '../errors.js';
import {
  hash6,
  sha256Hex,
  humanizeSlug,
  walkWikiPages,
  toPosix,
  type PageType,
} from './page.js';
import {
  emptyManifest,
  loadManifest,
  saveManifest,
  appendEntry,
  newEntry,
  findEntryByHash,
  type ManifestEntry,
  type ManifestSourceType,
} from './manifest.js';
import { buildSlugMap, writeSlugMapToIndex } from './slug-map.js';
import { emitWikiSkeleton } from './schema-emitter.js';
import { buildIngestPrompt } from '../prompts/skill-ingest.js';
import type { AppSettings, Discussion, StorageService, ClaudeModel, ClaudeModelAlias } from '../../storage/types.js';
import { renderDiscussionMarkdown } from '../../ui/render-discussion-markdown.js';

export interface IngestResult {
  rawPath: string;
  rawRelPath: string;
  producedPages: string[];
  updatedPages: string[];
  skipped: string[];
  notes?: string;
  costUsd: number;
  alreadyIngested?: boolean;
  warning?: string;
  entryId?: string;
}

interface IngestCore {
  workspace: ResolvedWorkspace;
  settings: AppSettings;
  rawPath: string;
  rawRelPath: string;
  sourceType: ManifestSourceType;
  hash: string;
  originalName?: string;
  url?: string;
  discussionId?: string;
  hintType?: PageType;
  inlineBody?: string;
  force?: boolean;
  modelOverride?: string;
}

async function runIngestCore(core: IngestCore): Promise<IngestResult> {
  const p = paths(core.workspace.root);
  ensureWikiDirs(core.workspace.root);
  // Make sure the schema + index exist before the agent reads them.
  emitWikiSkeleton({ workspaceRoot: core.workspace.root });

  // Dedup check
  const manifest = loadManifest(p.manifest);
  if (!core.force) {
    const existing = findEntryByHash(manifest, core.hash);
    if (existing) {
      return {
        rawPath: core.rawPath,
        rawRelPath: core.rawRelPath,
        producedPages: existing.producedPages,
        updatedPages: existing.updatedPages,
        skipped: existing.userEditedPagesSkipped ?? [],
        notes: existing.notes,
        costUsd: 0,
        alreadyIngested: true,
        entryId: existing.id,
      };
    }
  }

  const wikiKnowledgeMd = existsSync(p.wikiKnowledge) ? readFileSync(p.wikiKnowledge, 'utf8') : '';
  const wikiIndexMd = existsSync(p.wikiIndex) ? readFileSync(p.wikiIndex, 'utf8') : '';
  const prompt = buildIngestPrompt({
    rawPath: core.rawPath,
    rawRelPath: core.rawRelPath,
    sourceType: core.sourceType,
    hintType: core.hintType,
    wikiKnowledgeMd,
    wikiIndexMd,
    inlineBody: core.inlineBody,
  });

  const model = pickModel(core.settings, core.modelOverride);
  logger.debug('[ingest] starting', { rawPath: core.rawPath, hash: core.hash, model });

  let text: string;
  let costUsd = 0;
  try {
    const result = await runClaude({
      prompt,
      model,
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebFetch'],
      maxTurns: 30,
      cwd: core.workspace.root,
      maxBudgetUsd: core.settings.perCallBudgetUsd,
      timeoutMs: 5 * 60_000,
    });
    text = extractText(result);
    costUsd = result.json?.cost_usd ?? 0;
  } catch (error) {
    throw new ModelError(
      `Ingest LLM call failed: ${error instanceof Error ? error.message : String(error)}`,
      'Check `aab doctor` and retry. If the source is private, try `aab knowledge ingest --paste` after copy-pasting the content.',
    );
  }

  const parsed = safeParseJSON<Record<string, unknown>>(text);
  let producedPages: string[] = [];
  let updatedPages: string[] = [];
  let skipped: string[] = [];
  let notes: string | undefined;
  let warning: string | undefined;
  if (parsed.success && parsed.data && typeof parsed.data === 'object') {
    const d = parsed.data;
    producedPages = asStringArray(d.producedPages).map((s) => toWikiPath(s, core.workspace.root)).filter(isContentPage);
    updatedPages = asStringArray(d.updatedPages).map((s) => toWikiPath(s, core.workspace.root)).filter(isContentPage);
    skipped = asStringArray(d.skipped).map((s) => toWikiPath(s, core.workspace.root)).filter(isContentPage);
    notes = typeof d.notes === 'string' ? d.notes : undefined;
  } else {
    // Heuristic fallback: scan for `wiki/...md` strings in the agent text.
    const re = /wiki\/[a-z0-9-]+\/[a-z0-9-]+\.md/g;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) seen.add(m[0]!);
    producedPages = Array.from(seen);
    warning = 'Agent output did not contain a parseable JSON envelope; pages list is heuristic.';
    logger.warn('[ingest] non-JSON output, using fallback path scrape; raw:', text.slice(0, 400));
  }

  // Rebuild slug-map regardless of JSON outcome (defensive: ensures the
  // next ingest's cheap-pass works even if this one was partial).
  const map = buildSlugMap(p.wiki, core.workspace.root);
  writeSlugMapToIndex(p.wikiIndex, map);

  // Manifest entry
  const entry: ManifestEntry = newEntry({
    rawPath: core.rawRelPath,
    sourceType: core.sourceType,
    originalName: core.originalName,
    url: core.url,
    discussionId: core.discussionId,
    hash: core.hash,
    ingestModel: model,
    ingestCostUsd: costUsd,
    producedPages,
    updatedPages,
    userEditedPagesSkipped: skipped,
    notes,
  });
  appendEntry(p.manifest, entry);

  // Append to wiki/log.md (the agent may have done this; fallback for parse failures).
  try {
    if (warning) {
      appendFileSync(
        p.wikiLog,
        `${nowIso()} ingest ${core.rawRelPath} → (fallback) produced=[${producedPages.join(', ')}]\n`,
        'utf8',
      );
    }
  } catch {
    // best-effort
  }

  return {
    rawPath: core.rawPath,
    rawRelPath: core.rawRelPath,
    producedPages,
    updatedPages,
    skipped,
    notes,
    costUsd,
    warning,
    entryId: entry.id,
  };
}

function pickModel(settings: AppSettings, override?: string): string {
  if (override) return override;
  const v = settings.knowledgeWiki?.ingestModel ?? settings.fastModel;
  return typeof v === 'string' ? v : 'haiku';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
}

function toWikiPath(input: string, workspaceRoot: string): string {
  let s = input.trim().replace(/\\/g, '/');
  // Strip any absolute prefix
  if (s.startsWith(workspaceRoot.replace(/\\/g, '/') + '/')) {
    s = s.slice(workspaceRoot.length + 1).replace(/\\/g, '/');
  }
  if (!s.endsWith('.md')) s += '.md';
  if (!s.startsWith('wiki/')) s = `wiki/${s}`;
  return s;
}

/** Filter wiki infrastructure files out of the manifest's producedPages list. */
function isContentPage(wikiPath: string): boolean {
  const tail = wikiPath.replace(/^wiki\//, '');
  return tail !== 'index.md' && tail !== 'log.md' && tail !== 'KNOWLEDGE.md';
}

// ---------------------------------------------------------------------------
// File ingest
// ---------------------------------------------------------------------------

export interface IngestFileOptions {
  path: string;
  workspace: ResolvedWorkspace;
  settings: AppSettings;
  force?: boolean;
  hintType?: PageType;
  modelOverride?: string;
}

export async function ingestFile(opts: IngestFileOptions): Promise<IngestResult> {
  if (!existsSync(opts.path)) {
    throw new UserError(`ingest: file not found: ${opts.path}`);
  }
  const stats = statSync(opts.path);
  if (!stats.isFile()) {
    throw new UserError(`ingest: not a file: ${opts.path}`);
  }
  const buf = readFileSync(opts.path);
  return ingestFileBuffer({
    buffer: buf,
    originalName: basename(opts.path),
    workspace: opts.workspace,
    settings: opts.settings,
    force: opts.force,
    hintType: opts.hintType,
    modelOverride: opts.modelOverride,
  });
}

// ---------------------------------------------------------------------------
// Buffer ingest (uploaded file content — e.g. from the web UI file picker,
// where the browser hands us bytes + a name but never an absolute path)
// ---------------------------------------------------------------------------

export interface IngestBufferOptions {
  /** File contents. */
  buffer: Buffer;
  /** Display name including extension (may be a `folder/sub/file.md` rel path). */
  originalName: string;
  workspace: ResolvedWorkspace;
  settings: AppSettings;
  force?: boolean;
  hintType?: PageType;
  modelOverride?: string;
}

/**
 * Ingest from an in-memory buffer rather than a filesystem path. Shared by
 * `ingestFile` (reads a path → buffer) and the web UI upload route. The only
 * difference from `ingestFile` is the source of the bytes; everything
 * downstream (hash, raw-file copy, inline-body optimisation, manifest) is
 * identical, so the `sourceType` stays `'file'`.
 */
export async function ingestFileBuffer(opts: IngestBufferOptions): Promise<IngestResult> {
  const buf = opts.buffer;
  if (!buf || buf.length === 0) {
    throw new UserError('ingest: file is empty.');
  }
  // `originalName` may carry a relative path (folder upload) — keep only the
  // leaf for slug/extension purposes, but preserve the full name in the manifest.
  const leaf = basename(opts.originalName.replace(/\\/g, '/')) || 'upload';
  const hash = sha256Hex(buf);
  const h6 = hash.slice(0, 6);
  const ext = extname(leaf).toLowerCase() || '.md';
  const sanitizedName = sanitizeFilename(basename(leaf, extname(leaf)));
  const rawFilename = `${h6}-${sanitizedName}${ext}`;
  const p = paths(opts.workspace.root);
  ensureWikiDirs(opts.workspace.root);
  const rawPath = join(p.rawFiles, rawFilename);
  if (!existsSync(rawPath) || opts.force) {
    mkdirSync(dirname(rawPath), { recursive: true });
    writeFileSync(rawPath, buf);
  }
  const rawRelPath = toPosix(relative(opts.workspace.root, rawPath));
  // For text-based files, inline the body so the agent doesn't need to spend
  // a tool-call round-trip reading it.
  let inlineBody: string | undefined;
  if (['.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.yaml', '.yml'].includes(ext)) {
    try {
      inlineBody = buf.toString('utf8');
    } catch {
      inlineBody = undefined;
    }
  }
  return runIngestCore({
    workspace: opts.workspace,
    settings: opts.settings,
    rawPath,
    rawRelPath,
    sourceType: 'file',
    hash,
    originalName: opts.originalName,
    hintType: opts.hintType,
    inlineBody,
    force: opts.force,
    modelOverride: opts.modelOverride,
  });
}

// ---------------------------------------------------------------------------
// Paste ingest
// ---------------------------------------------------------------------------

export interface IngestPasteOptions {
  text: string;
  workspace: ResolvedWorkspace;
  settings: AppSettings;
  force?: boolean;
  hintType?: PageType;
  modelOverride?: string;
}

export async function ingestPaste(opts: IngestPasteOptions): Promise<IngestResult> {
  const trimmed = opts.text.trim();
  if (!trimmed) throw new UserError('ingest: paste text is empty.');
  const hash = sha256Hex(trimmed);
  const p = paths(opts.workspace.root);
  ensureWikiDirs(opts.workspace.root);
  const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'); // yyyy-mm-dd-hhmm
  const snippet = humanizeSlug(trimmed.split(/\s+/).slice(0, 6).join(' '), 40);
  const rawPath = join(p.rawPasted, `${ts}-${snippet}.md`);
  mkdirSync(dirname(rawPath), { recursive: true });
  writeFileSync(rawPath, trimmed + '\n', 'utf8');
  const rawRelPath = toPosix(relative(opts.workspace.root, rawPath));
  return runIngestCore({
    workspace: opts.workspace,
    settings: opts.settings,
    rawPath,
    rawRelPath,
    sourceType: 'pasted',
    hash,
    hintType: opts.hintType,
    inlineBody: trimmed,
    force: opts.force,
    modelOverride: opts.modelOverride,
  });
}

// ---------------------------------------------------------------------------
// URL ingest (Chunk 3)
// ---------------------------------------------------------------------------

export interface IngestUrlOptions {
  url: string;
  workspace: ResolvedWorkspace;
  settings: AppSettings;
  force?: boolean;
  hintType?: PageType;
  modelOverride?: string;
}

/**
 * URL ingest: snapshot the URL via WebFetch (executed by the ingest agent),
 * write `raw/urls/<hash6>.md` + `<hash6>.meta.json`, then run the standard
 * ingest pipeline on the snapshot. The snapshot step itself is currently
 * skeleton: we record the URL and meta, and the agent fetches the body via
 * its WebFetch tool. Reference: `docs/development/KNOWLEDGE_WIKI.md` §15.1 step 1.
 */
export async function ingestUrl(opts: IngestUrlOptions): Promise<IngestResult> {
  const url = opts.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new UserError(`ingest: not a valid http(s) URL: ${url}`);
  }
  const p = paths(opts.workspace.root);
  ensureWikiDirs(opts.workspace.root);
  const canonical = canonicaliseUrl(url);
  const hash = sha256Hex(canonical);
  const h6 = hash.slice(0, 6);
  const rawPath = join(p.rawUrls, `${h6}.md`);
  const metaPath = join(p.rawUrls, `${h6}.meta.json`);
  if (!existsSync(rawPath) || opts.force) {
    // Stub body — the agent will WebFetch and rewrite this on its first turn.
    mkdirSync(dirname(rawPath), { recursive: true });
    writeFileSync(
      rawPath,
      [
        `# ${url}`,
        '',
        `> Snapshot pending — the ingest agent will fetch this URL via WebFetch on its first turn.`,
        `> URL: ${url}`,
        `> Fetched-at: ${nowIso()}`,
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      metaPath,
      JSON.stringify({ url, canonical, hash, fetchedAt: nowIso(), title: undefined }, null, 2) + '\n',
      'utf8',
    );
  }
  const rawRelPath = toPosix(relative(opts.workspace.root, rawPath));
  return runIngestCore({
    workspace: opts.workspace,
    settings: opts.settings,
    rawPath,
    rawRelPath,
    sourceType: 'url',
    hash,
    originalName: url,
    url,
    hintType: opts.hintType,
    force: opts.force,
    modelOverride: opts.modelOverride,
  });
}

function canonicaliseUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Discussion ingest (auto + backfill)
// ---------------------------------------------------------------------------

export interface IngestDiscussionOptions {
  discussion: Discussion;
  workspace: ResolvedWorkspace;
  settings: AppSettings;
  storage: StorageService;
  force?: boolean;
  modelOverride?: string;
}

export async function ingestDiscussionRaw(
  opts: IngestDiscussionOptions,
): Promise<IngestResult> {
  const p = paths(opts.workspace.root);
  ensureWikiDirs(opts.workspace.root);

  // Render transcript markdown using the same renderer the export command uses.
  const transcriptMd = renderDiscussionMarkdown(opts.discussion);
  const summary = opts.discussion.summary;
  const humanized = humanizeSlug(opts.discussion.question) || `discussion-${opts.discussion.id.slice(0, 8)}`;
  const discPath = join(p.rawDiscussions, `${humanized}.md`);
  if (!existsSync(discPath) || opts.force) {
    mkdirSync(dirname(discPath), { recursive: true });
    writeFileSync(discPath, transcriptMd, 'utf8');
  }
  if (summary) {
    const sumPath = join(p.rawSummaries, `${humanized}.md`);
    if (!existsSync(sumPath) || opts.force) {
      mkdirSync(dirname(sumPath), { recursive: true });
      writeFileSync(sumPath, renderSummaryMarkdown(opts.discussion, summary), 'utf8');
    }
  }
  const rawRelPath = toPosix(relative(opts.workspace.root, discPath));
  const hash = sha256Hex(transcriptMd);
  return runIngestCore({
    workspace: opts.workspace,
    settings: opts.settings,
    rawPath: discPath,
    rawRelPath,
    sourceType: 'discussion',
    hash,
    originalName: opts.discussion.question,
    discussionId: opts.discussion.id,
    hintType: 'source-summary',
    inlineBody: transcriptMd,
    force: opts.force,
    modelOverride: opts.modelOverride,
  });
}

function renderSummaryMarkdown(
  d: Discussion,
  s: NonNullable<Discussion['summary']>,
): string {
  const lines: string[] = [];
  lines.push(`# Summary — ${d.question}`);
  lines.push('');
  lines.push(`> Discussion \`${d.id}\` · ${d.rounds.length} round${d.rounds.length === 1 ? '' : 's'} · ${d.totalTurns} turn${d.totalTurns === 1 ? '' : 's'} · quality ${s.overallQuality}/100`);
  lines.push('');
  if (s.keyPoints.length > 0) {
    lines.push('## Key points');
    for (const p of s.keyPoints) lines.push(`- ${p}`);
    lines.push('');
  }
  if (s.consensus.length > 0) {
    lines.push('## Consensus');
    for (const p of s.consensus) lines.push(`- ${p}`);
    lines.push('');
  }
  if (s.disagreements.length > 0) {
    lines.push('## Disagreements');
    for (const p of s.disagreements) lines.push(`- ${p}`);
    lines.push('');
  }
  if (s.actionableInsights.length > 0) {
    lines.push('## Actionable insights');
    for (const p of s.actionableInsights) lines.push(`- ${p}`);
    lines.push('');
  }
  if (s.participationBreakdown.length > 0) {
    lines.push('## Participation');
    for (const r of s.participationBreakdown) {
      lines.push(`- **${r.memberName}** — ${r.totalResponses} response${r.totalResponses === 1 ? '' : 's'}, avg ${r.averageLength} chars, influence ${r.influence}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function sanitizeFilename(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'source';
}

// Silence unused-import linter on `copyFileSync` (kept for future binary file copy)
void copyFileSync;
void emptyManifest;
void saveManifest;
void walkWikiPages;
void hash6;
