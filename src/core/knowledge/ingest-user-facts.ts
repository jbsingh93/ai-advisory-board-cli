/**
 * User-fact merge ingest (Phase 8). Reference:
 * `docs/development/USER_INPUT_INGEST.md`, `PLAN.md` Part 11.
 *
 * Ingests ONE piece of the user's own input (initial question, follow-up,
 * HITL response, or 1:1 sparring message) into the Knowledge Wiki via the
 * user-fact **merge** agent (`buildUserFactMergePrompt`).
 *
 * Differences from `runIngestCore` (the document pipeline in `ingest.ts`):
 *   - NO mandatory `wiki/sources/*.md` page — an empty result is valid and
 *     expected when the utterance adds nothing new. This is what keeps the
 *     wiki from bloating when the user re-mentions known facts.
 *   - Update-biased, cheaper budget (maxTurns 8, haiku), no WebFetch.
 *   - There is NO content-hash skip: every utterance always reaches the agent
 *     (a re-mention can carry new nuance — only the agent, reading the wiki,
 *     can tell). The agent decides per-fact what is new. Idempotency against
 *     double-fired *events* is the queue's job, not this function's.
 *
 * Still mirrors the rest of `runIngestCore`'s plumbing: write a raw capture
 * for provenance/citation, run the agent, parse its JSON, rebuild the
 * slug-map, append a manifest entry, and log to `wiki/log.md`.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { paths, ensureWikiDirs, type ResolvedWorkspace } from '../../storage/paths.js';
import { runClaude, extractText } from '../../llm/claude-code-runner.js';
import { safeParseJSON } from '../parsing/safe-json.js';
import { logger } from '../logger.js';
import { nowIso } from '../utils.js';
import { ModelError } from '../errors.js';
import { humanizeSlug, sha256Hex, toPosix } from './page.js';
import { newEntry, appendEntry, type ManifestEntry } from './manifest.js';
import { buildSlugMap, writeSlugMapToIndex } from './slug-map.js';
import { emitWikiSkeleton } from './schema-emitter.js';
import { buildUserFactMergePrompt, type UserInputKind } from '../prompts/wiki-merge.js';
import type { IngestResult } from './ingest.js';
import type { AppSettings } from '../../storage/types.js';

export interface IngestUserFactsOptions {
  /** The user's own words (one utterance, or a coalesced burst). */
  text: string;
  /** Which surface the utterance came from. */
  kind: UserInputKind;
  workspace: ResolvedWorkspace;
  settings: AppSettings;
  /** Discussion this input belongs to (for manifest provenance). */
  discussionId?: string;
  /** Sparring session id, when kind === 'sparring_message'. */
  sparringSessionId?: string;
  /** Decision-coach session id, when kind === 'coach_message'. */
  coachSessionId?: string;
  /** Override the ingest model (default: knowledgeWiki.ingestModel ?? fastModel ?? haiku). */
  modelOverride?: string;
  signal?: AbortSignal;
}

const MERGE_MAX_TURNS = 8;
const MERGE_TIMEOUT_MS = 3 * 60_000;
const MERGE_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit'];

/**
 * Ingest one user utterance as net-new user facts. Never throws on a "nothing
 * new" outcome — that returns empty page arrays. Throws ModelError only when
 * the underlying `claude` call fails.
 */
export async function ingestUserFacts(opts: IngestUserFactsOptions): Promise<IngestResult> {
  const root = opts.workspace.root;
  const p = paths(root);
  ensureWikiDirs(root);
  emitWikiSkeleton({ workspaceRoot: root });

  const text = opts.text.trim();
  // 1. Write a raw capture for provenance + citation. One file per utterance —
  //    raw/ is the immutable audit trail; the redundancy guard is about wiki
  //    CONTENT pages, not raw captures.
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'); // yyyy-mm-dd-hh-mm-ss
  const snippet = humanizeSlug(text.split(/\s+/).slice(0, 6).join(' '), 40) || 'user-input';
  const rawPath = join(p.rawUserInputs, `${ts}-${opts.kind}-${snippet}.md`);
  mkdirSync(dirname(rawPath), { recursive: true });
  writeFileSync(
    rawPath,
    renderRawCapture(opts.kind, text, opts.discussionId, opts.sparringSessionId, opts.coachSessionId),
    'utf8',
  );
  const rawRelPath = toPosix(relative(root, rawPath));
  const hash = sha256Hex(text);

  // 2. Build the merge prompt with the current wiki state inlined.
  const wikiKnowledgeMd = existsSync(p.wikiKnowledge) ? readFileSync(p.wikiKnowledge, 'utf8') : '';
  const wikiIndexMd = existsSync(p.wikiIndex) ? readFileSync(p.wikiIndex, 'utf8') : '';
  const prompt = buildUserFactMergePrompt({
    text,
    kind: opts.kind,
    rawRelPath,
    wikiKnowledgeMd,
    wikiIndexMd,
  });

  const model = pickModel(opts.settings, opts.modelOverride);
  logger.debug('[ingest-user-facts] starting', { kind: opts.kind, hash, model, rawRelPath });

  // 3. Run the merge agent.
  let agentText: string;
  let costUsd = 0;
  try {
    const result = await runClaude({
      prompt,
      model,
      allowedTools: MERGE_TOOLS,
      maxTurns: MERGE_MAX_TURNS,
      cwd: root,
      maxBudgetUsd: opts.settings.perCallBudgetUsd,
      timeoutMs: MERGE_TIMEOUT_MS,
      signal: opts.signal,
    });
    agentText = extractText(result);
    costUsd = result.json?.cost_usd ?? 0;
  } catch (error) {
    throw new ModelError(
      `User-fact merge LLM call failed: ${error instanceof Error ? error.message : String(error)}`,
      'Check `aab doctor` and retry. This is non-blocking for discussions — the input was still recorded.',
    );
  }

  // 4. Parse the agent's JSON envelope (heuristic path-scrape fallback).
  const parsed = safeParseJSON<Record<string, unknown>>(agentText);
  let producedPages: string[] = [];
  let updatedPages: string[] = [];
  let skipped: string[] = [];
  let notes: string | undefined;
  let warning: string | undefined;
  if (parsed.success && parsed.data && typeof parsed.data === 'object') {
    const d = parsed.data;
    producedPages = asStringArray(d.producedPages).map((s) => toWikiPath(s, root)).filter(isContentPage);
    updatedPages = asStringArray(d.updatedPages).map((s) => toWikiPath(s, root)).filter(isContentPage);
    skipped = asStringArray(d.skipped).map((s) => toWikiPath(s, root)).filter(isContentPage);
    notes = typeof d.notes === 'string' ? d.notes : undefined;
  } else {
    const re = /wiki\/[a-z0-9-]+\/[a-z0-9-]+\.md/g;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(agentText)) !== null) seen.add(m[0]!);
    producedPages = Array.from(seen);
    warning = 'Agent output did not contain a parseable JSON envelope; pages list is heuristic.';
    logger.warn('[ingest-user-facts] non-JSON output, using fallback path scrape; raw:', agentText.slice(0, 400));
  }

  // 5. Rebuild slug-map regardless of outcome (defensive — keeps the next
  //    ingest's resolver correct even if this run was partial).
  const map = buildSlugMap(p.wiki, root);
  writeSlugMapToIndex(p.wikiIndex, map);

  // 6. Append a manifest entry (provenance ledger). Always recorded, even when
  //    no pages changed — that's how we audit that the utterance was processed.
  const entry: ManifestEntry = newEntry({
    rawPath: rawRelPath,
    sourceType: 'user-input',
    originalName: opts.kind,
    discussionId: opts.discussionId,
    hash,
    ingestModel: model,
    ingestCostUsd: costUsd,
    producedPages,
    updatedPages,
    userEditedPagesSkipped: skipped,
    notes,
  });
  appendEntry(p.manifest, entry);

  // 7. Log one line so the raw stream is auditable even when nothing changed.
  try {
    const summary =
      producedPages.length + updatedPages.length === 0
        ? '(nothing new)'
        : `produced=[${producedPages.join(', ')}] updated=[${updatedPages.join(', ')}]`;
    appendFileSync(
      p.wikiLog,
      `${nowIso()} user-input(${opts.kind}) ${rawRelPath} → ${summary}${warning ? ' [fallback]' : ''}\n`,
      'utf8',
    );
  } catch {
    // best-effort
  }

  return {
    rawPath,
    rawRelPath,
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

function renderRawCapture(
  kind: UserInputKind,
  text: string,
  discussionId?: string,
  sparringSessionId?: string,
  coachSessionId?: string,
): string {
  const meta: string[] = [`<!-- kind: ${kind} -->`];
  if (discussionId) meta.push(`<!-- discussion: ${discussionId} -->`);
  if (sparringSessionId) meta.push(`<!-- sparring: ${sparringSessionId} -->`);
  if (coachSessionId) meta.push(`<!-- coach: ${coachSessionId} -->`);
  meta.push(`<!-- captured: ${nowIso()} -->`);
  return `${meta.join('\n')}\n\n${text}\n`;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
}

function toWikiPath(input: string, workspaceRoot: string): string {
  let s = input.trim().replace(/\\/g, '/');
  const rootPosix = workspaceRoot.replace(/\\/g, '/') + '/';
  if (s.startsWith(rootPosix)) s = s.slice(rootPosix.length);
  if (!s.endsWith('.md')) s += '.md';
  if (!s.startsWith('wiki/')) s = `wiki/${s}`;
  return s;
}

/** Filter wiki infrastructure files out of the manifest's page lists. */
function isContentPage(wikiPath: string): boolean {
  const tail = wikiPath.replace(/^wiki\//, '');
  return tail !== 'index.md' && tail !== 'log.md' && tail !== 'KNOWLEDGE.md';
}
