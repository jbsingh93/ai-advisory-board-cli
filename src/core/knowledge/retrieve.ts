/**
 * Deterministic, LLM-free wiki retrieval.
 *
 * The architecture (per the user's review): the AAB CLI finds the relevant wiki
 * context and the board member *advises on it* — the member is not a wiki search
 * engine. Before `runMember` spawns a Claude sub-agent we score the wiki pages
 * by keyword overlap (slug / title / tags / summary) against the question, read
 * the top few, and inject short excerpts into the member message. The agent
 * keeps Read/Grep/Glob as a fallback for anything we missed.
 *
 * This reads the compact catalog (`wiki/.aab/catalog.json`) when present — a
 * tiny structured index — and falls back to walking the wiki directory. It
 * never reads `index.md` (which can blow past 256 KB on a populated wiki).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPage, walkWikiPages } from './page.js';
import { BACKLINKS_OPEN, BACKLINKS_CLOSE, type Catalog, type CatalogEntry } from './slug-map.js';

export interface RetrievedWikiPage {
  slug: string;
  title?: string;
  type: string;
  /** Forward-slash path relative to `wiki/`. */
  path: string;
  /** Trimmed, frontmatter-stripped excerpt of the page body. */
  excerpt: string;
}

export interface RetrieveOptions {
  /** Absolute path to the `wiki/` directory. */
  wikiRoot: string;
  /** Absolute path to the compact catalog. Defaults to `<wikiRoot>/.aab/catalog.json`. */
  catalogPath?: string;
  /** Workspace root (passed to walkWikiPages for relPath resolution). */
  workspaceRoot?: string;
  /** The primary question to retrieve for. */
  query: string;
  /** Optional secondary query text (e.g. a follow-up question) — also scored. */
  extraQuery?: string;
  /** How many pages to return. Default 8. */
  maxPages?: number;
  /** Per-page excerpt cap (chars). Default 2000. */
  excerptChars?: number;
}

// Short, high-frequency words that carry little retrieval signal.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'nor', 'so', 'yet', 'of', 'to',
  'in', 'on', 'at', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'we', 'our', 'us', 'you', 'your', 'i', 'it', 'its',
  'this', 'that', 'these', 'those', 'with', 'from', 'as', 'how', 'what', 'why',
  'when', 'where', 'who', 'which', 'should', 'would', 'could', 'can', 'will',
  'about', 'into', 'over', 'than', 'then', 'them', 'they', 'their', 'have',
  'has', 'had', 'not', 'all', 'any', 'more', 'most', 'some', 'such', 'if',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

interface Candidate {
  slug: string;
  type: string;
  title?: string;
  summary?: string;
  tags?: string[];
  path: string;
}

function loadCandidates(opts: RetrieveOptions): Candidate[] {
  const catalogPath = opts.catalogPath ?? join(opts.wikiRoot, '.aab', 'catalog.json');
  if (existsSync(catalogPath)) {
    try {
      const parsed = JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog;
      if (Array.isArray(parsed?.pages) && parsed.pages.length > 0) {
        return parsed.pages.map((e: CatalogEntry) => ({
          slug: e.slug,
          type: e.type,
          title: e.title,
          summary: e.summary,
          tags: e.tags,
          path: e.path,
        }));
      }
    } catch {
      // Stale/corrupt catalog — fall through to walking the wiki.
    }
  }
  // Fallback: walk the wiki directory directly.
  return walkWikiPages(opts.wikiRoot, opts.workspaceRoot).map((p) => ({
    slug: String(p.frontmatter.slug ?? '').toLowerCase(),
    type: String(p.frontmatter.type ?? 'concept'),
    title: typeof p.frontmatter.title === 'string' ? p.frontmatter.title : undefined,
    summary: typeof p.frontmatter.summary === 'string' ? p.frontmatter.summary : undefined,
    tags: Array.isArray(p.frontmatter.tags)
      ? p.frontmatter.tags.filter((t): t is string => typeof t === 'string')
      : undefined,
    path: p.wikiRelPath,
  })).filter((c) => c.slug);
}

/** Score a candidate against the query terms. Weights favour slug/title/tags. */
function scoreCandidate(c: Candidate, terms: string[]): number {
  if (terms.length === 0) return 0;
  const slugTokens = new Set(tokenize(c.slug.replace(/-/g, ' ')));
  const titleTokens = new Set(tokenize(c.title ?? ''));
  const tagTokens = new Set((c.tags ?? []).flatMap((t) => tokenize(t)));
  const summaryTokens = new Set(tokenize(c.summary ?? ''));
  let score = 0;
  for (const term of terms) {
    if (slugTokens.has(term)) score += 3;
    if (titleTokens.has(term)) score += 3;
    if (tagTokens.has(term)) score += 2;
    if (summaryTokens.has(term)) score += 1;
  }
  return score;
}

/** Read a page body, strip frontmatter + backlinks section, truncate. */
function pageExcerpt(absPath: string, cap: number): string {
  const parsed = readPage(absPath);
  if (!parsed) return '';
  let body = parsed.body;
  // Drop the auto-maintained backlinks block — it's noise for an advisor.
  const open = body.indexOf(BACKLINKS_OPEN);
  if (open >= 0) {
    const close = body.indexOf(BACKLINKS_CLOSE);
    body = close > open ? body.slice(0, open) + body.slice(close + BACKLINKS_CLOSE.length) : body.slice(0, open);
  }
  body = body.replace(/\n{3,}/g, '\n\n').trim();
  if (body.length <= cap) return body;
  return body.slice(0, cap).replace(/\s+\S*$/, '') + '\n…[excerpt truncated — Read the page for the rest]';
}

/**
 * Retrieve the most relevant wiki pages for a question, as injectable excerpts.
 * Returns `[]` when there's no wiki, no keyword match, or retrieval is otherwise
 * empty — callers should treat that as "let the agent search on its own".
 */
export function retrieveWikiContext(opts: RetrieveOptions): RetrievedWikiPage[] {
  if (!existsSync(opts.wikiRoot)) return [];
  const maxPages = opts.maxPages ?? 8;
  const cap = opts.excerptChars ?? 2000;
  const terms = [...new Set([...tokenize(opts.query), ...tokenize(opts.extraQuery ?? '')])];
  if (terms.length === 0) return [];

  const candidates = loadCandidates(opts);
  const scored = candidates
    .map((c) => ({ c, score: scoreCandidate(c, terms) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPages);

  const out: RetrievedWikiPage[] = [];
  for (const { c } of scored) {
    const excerpt = pageExcerpt(join(opts.wikiRoot, c.path), cap);
    if (!excerpt) continue;
    out.push({ slug: c.slug, title: c.title, type: c.type, path: c.path, excerpt });
  }
  return out;
}
