/**
 * Wiki query — one-shot Claude call with Read/Grep/Glob, no writes.
 * Reference: `docs/development/KNOWLEDGE_WIKI.md` §15.2.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths, type ResolvedWorkspace } from '../../storage/paths.js';
import { runClaude, extractText } from '../../llm/claude-code-runner.js';
import { safeParseJSON } from '../parsing/safe-json.js';
import { logger } from '../logger.js';
import { ModelError, UserError } from '../errors.js';
import { buildQueryPrompt } from '../prompts/skill-query.js';
import { humanizeSlug, pathForPage, type PageType } from './page.js';
import { writePageAtomic } from './page.js';
import { buildSlugMap, writeSlugMapToIndex, type Catalog, type CatalogEntry } from './slug-map.js';
import { nowIso } from '../utils.js';
import type { AppSettings } from '../../storage/types.js';

export interface WikiQueryOptions {
  question: string;
  workspace: ResolvedWorkspace;
  settings: AppSettings;
  maxPages?: number;
  modelOverride?: string;
  saveAs?: PageType;
}

export interface WikiQueryResult {
  question: string;
  answer: string;
  citations: string[];
  notes?: string;
  costUsd: number;
  savedAs?: string;
}

export async function queryWiki(opts: WikiQueryOptions): Promise<WikiQueryResult> {
  const p = paths(opts.workspace.root);
  if (!existsSync(p.wiki)) {
    throw new UserError('Wiki not initialised. Run `aab init` (or `aab knowledge migrate`) first.');
  }
  const maxPages = opts.maxPages ?? opts.settings.knowledgeWiki?.maxAgentPagesPerCall ?? 10;
  const model = pickQueryModel(opts.settings, opts.modelOverride);
  const wikiKnowledgeMd = capText(
    existsSync(p.wikiKnowledge) ? readFileSync(p.wikiKnowledge, 'utf8') : '',
    KNOWLEDGE_CHAR_BUDGET,
  );
  // Prefer the compact catalog (small, structured) over the full index.md, which
  // can blow past 256 KB on a populated wiki and bloat the prompt. The catalog
  // ITSELF can also grow huge (hundreds of pages from email/Slack ingestion →
  // 170k+ tokens → "Prompt is too long"), so we never inline it whole: we build
  // a relevance-ranked, size-bounded digest of the most relevant pages and let
  // the agent Grep/Glob the wiki for anything not listed. Fall back to a capped
  // slice of index.md only when no catalog exists yet.
  const rawCatalogJson = existsSync(p.wikiCatalog) ? readFileSync(p.wikiCatalog, 'utf8') : '';
  const wikiCatalogJson = rawCatalogJson
    ? buildCatalogDigest(rawCatalogJson, opts.question, CATALOG_CHAR_BUDGET)
    : '';
  const wikiIndexMd = wikiCatalogJson
    ? ''
    : existsSync(p.wikiIndex)
      ? capText(readFileSync(p.wikiIndex, 'utf8'), 12_000)
      : '';
  const prompt = buildQueryPrompt({
    question: opts.question,
    wikiKnowledgeMd,
    wikiIndexMd,
    wikiCatalogJson,
    maxPages,
  });

  logger.debug('[query] starting', { question: opts.question.slice(0, 80), model, maxPages });
  let text: string;
  let costUsd = 0;
  try {
    // No `--max-turns`: the harness terminates the agent when it has its answer;
    // budget + timeout are the real guardrails. A low turn cap only caused
    // spurious `max_turns` failures on big-wiki retrieval.
    const result = await runClaude({
      prompt,
      model,
      allowedTools: ['Read', 'Grep', 'Glob'],
      cwd: opts.workspace.root,
      maxBudgetUsd: opts.settings.perCallBudgetUsd,
      timeoutMs: 3 * 60_000,
    });
    text = extractText(result);
    costUsd = result.json?.cost_usd ?? 0;
  } catch (error) {
    throw new ModelError(
      `Query LLM call failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let answer = text.trim();
  let citations: string[] = [];
  let notes: string | undefined;
  const parsed = safeParseJSON<Record<string, unknown>>(text);
  if (parsed.success && parsed.data && typeof parsed.data === 'object') {
    const d = parsed.data;
    if (typeof d.answer === 'string') answer = d.answer.trim();
    if (Array.isArray(d.citations)) {
      citations = d.citations.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')).filter(Boolean);
    }
    if (typeof d.notes === 'string') notes = d.notes;
  }

  let savedAs: string | undefined;
  if (opts.saveAs) {
    const slug = humanizeSlug(opts.question) || `query-${Date.now()}`;
    const targetPath = pathForPage(p.wiki, opts.saveAs, slug);
    const today = nowIso().slice(0, 10);
    writePageAtomic(
      targetPath,
      {
        title: opts.question,
        slug,
        type: opts.saveAs,
        summary: opts.question,
        tags: [],
        sources: citations.map((s) => `wiki/${s}`),
        related: citations.map((s) => `[[${s}]]`),
        confidence: 'medium',
        provenance: 'inferred',
        created: today,
        updated: today,
        userEdited: false,
      },
      answer + (citations.length > 0 ? `\n\n## Citations\n\n${citations.map((c) => `- [[${c}]]`).join('\n')}\n` : '\n'),
    );
    savedAs = `wiki/${humanizeSlug(opts.saveAs)}/${slug}.md`;
    // Refresh slug-map.
    const map = buildSlugMap(p.wiki, opts.workspace.root);
    writeSlugMapToIndex(p.wikiIndex, map);
  }

  return { question: opts.question, answer, citations, notes, costUsd, savedAs };
}

function pickQueryModel(settings: AppSettings, override?: string): string {
  if (override) return override;
  const v = settings.knowledgeWiki?.queryModel ?? settings.primaryModel;
  return typeof v === 'string' ? v : 'sonnet';
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n…[truncated — use the compact catalog / Grep instead of reading this in full]';
}

// Char budgets for the parts of the query prompt we inline. Kept well under the
// model's context window so a large wiki can never produce "Prompt is too long".
// ~48k chars of catalog ≈ ~12-15k tokens; the question + schema + template add a
// few thousand more. The agent's Read/Grep/Glob cover anything not inlined.
const CATALOG_CHAR_BUDGET = 48_000;
const KNOWLEDGE_CHAR_BUDGET = 16_000;

const QUERY_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'of', 'to', 'in', 'on', 'at',
  'is', 'are', 'was', 'were', 'be', 'who', 'what', 'why', 'how', 'when', 'where',
  'which', 'with', 'from', 'as', 'this', 'that', 'these', 'those', 'do', 'does',
  'did', 'we', 'our', 'you', 'your', 'i', 'it', 'its', 'er', 'hvem', 'hvad',
  'hvor', 'hvordan', 'hvorfor', 'og', 'eller', 'en', 'et', 'den', 'det', 'som',
]);

function tokenizeQuery(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9æøå\s-]/gi, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length >= 2 && !QUERY_STOPWORDS.has(t));
}

function scoreCatalogEntry(e: CatalogEntry, terms: string[]): number {
  if (terms.length === 0) return 0;
  const slug = new Set(tokenizeQuery(String(e.slug ?? '').replace(/-/g, ' ')));
  const title = new Set(tokenizeQuery(String(e.title ?? '')));
  const tags = new Set((e.tags ?? []).flatMap((t) => tokenizeQuery(String(t))));
  const summary = new Set(tokenizeQuery(String(e.summary ?? '')));
  let score = 0;
  for (const term of terms) {
    if (slug.has(term)) score += 4;
    if (title.has(term)) score += 3;
    if (tags.has(term)) score += 2;
    if (summary.has(term)) score += 1;
  }
  return score;
}

/**
 * Build a relevance-ranked, size-bounded catalog digest for the query prompt.
 * Never inlines the whole catalog — that's what blew the context window on big
 * wikis. Returns a JSON object `{ pages, _note, _omitted }` where `pages` is the
 * most relevant entries that fit `budget`. The agent Grep/Glob's for the rest.
 *
 * Exported for unit testing.
 */
export function buildCatalogDigest(catalogJson: string, question: string, budget = CATALOG_CHAR_BUDGET): string {
  if (catalogJson.length <= budget) return catalogJson;
  let pages: CatalogEntry[];
  try {
    const parsed = JSON.parse(catalogJson) as Catalog;
    pages = Array.isArray(parsed?.pages) ? parsed.pages : [];
  } catch {
    // Unparseable JSON — hard-cap so we never blow the context window. Mid-JSON
    // truncation isn't valid JSON, but it's still a usable hint and the agent
    // falls back to Grep/Glob anyway.
    return catalogJson.slice(0, budget) + '\n…[catalog truncated — Grep/Glob the wiki for anything not listed]';
  }
  if (pages.length === 0) return catalogJson.slice(0, budget);

  const terms = tokenizeQuery(question);
  const ranked = pages
    .map((e, i) => ({ e, i, score: scoreCatalogEntry(e, terms) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);

  const kept: CatalogEntry[] = [];
  let size = 0;
  for (const { e } of ranked) {
    const entryLen = JSON.stringify(e).length + 1;
    if (size + entryLen > budget && kept.length > 0) break;
    kept.push(e);
    size += entryLen;
  }
  return JSON.stringify({
    pages: kept,
    _note: `relevance-filtered: showing ${kept.length} of ${pages.length} pages most relevant to the question — Grep/Glob \`wiki/\` for anything not listed here`,
    _omitted: pages.length - kept.length,
  });
}

// Silence unused
void mkdirSync;
void writeFileSync;
void dirname;
void join;
