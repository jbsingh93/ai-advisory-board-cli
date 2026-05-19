/**
 * Wiki page primitives — frontmatter parse/serialize, slug helpers,
 * `[[wikilink]]` extraction, and humanization rules.
 *
 * Frontmatter contract: `PLAN/KNOWLEDGE_WIKI.md` §8.
 * Wiki-link syntax: §11.
 * File-naming rules: §10.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, basename, relative, sep } from 'node:path';
import slugify from 'slugify';
import { createHash } from 'node:crypto';

export type PageType = 'concept' | 'entity' | 'decision' | 'source-summary' | 'comparison';
export const PAGE_TYPES: readonly PageType[] = ['concept', 'entity', 'decision', 'source-summary', 'comparison'];

export type PageProvenance = 'extracted' | 'inferred' | 'ambiguous';
export type PageConfidence = 'high' | 'medium' | 'low';

export interface PageFrontmatter {
  title: string;
  slug: string;
  aliases?: string[];
  type: PageType;
  summary?: string;
  tags?: string[];
  sources?: string[];
  related?: string[];
  confidence?: PageConfidence;
  provenance?: PageProvenance;
  created?: string;
  updated?: string;
  userEdited?: boolean;
  [key: string]: unknown;
}

export interface ParsedPage {
  frontmatter: PageFrontmatter;
  body: string;
  raw: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse a markdown file with YAML frontmatter. Returns `null` if the file
 * has no parseable frontmatter (we treat that as a non-page file).
 *
 * Hand-rolled YAML — we deliberately don't pull in a heavyweight parser. We
 * only support the field types in PageFrontmatter:
 *   - `key: scalar`
 *   - `key: [a, b, c]` (inline array of scalars or quoted strings)
 *   - `key:\n  - a\n  - b` (block array)
 */
export function parsePage(raw: string): ParsedPage | null {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return null;
  const yamlBlock = m[1] ?? '';
  const body = raw.slice(m[0].length);
  const fm = parseFrontmatter(yamlBlock);
  if (!fm.slug && !fm.title) return null;
  return { frontmatter: fm as PageFrontmatter, body, raw };
}

export function readPage(path: string): ParsedPage | null {
  if (!existsSync(path)) return null;
  try {
    return parsePage(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Serialize a frontmatter + body back to a markdown file string.
 * Field order is deterministic to keep diffs clean.
 */
export function serializePage(fm: PageFrontmatter, body: string): string {
  const lines: string[] = ['---'];
  const emit = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        return;
      }
      lines.push(`${key}:`);
      for (const v of value) {
        lines.push(`  - ${yamlScalar(v)}`);
      }
      return;
    }
    if (typeof value === 'boolean' || typeof value === 'number') {
      lines.push(`${key}: ${value}`);
      return;
    }
    lines.push(`${key}: ${yamlScalar(String(value))}`);
  };

  const order: Array<keyof PageFrontmatter> = [
    'title',
    'slug',
    'aliases',
    'type',
    'summary',
    'tags',
    'sources',
    'related',
    'confidence',
    'provenance',
    'created',
    'updated',
    'userEdited',
  ];
  for (const k of order) {
    if (fm[k] !== undefined) emit(k as string, fm[k]);
  }
  // Pass-through unknown keys (preserve hand edits)
  for (const k of Object.keys(fm)) {
    if (!order.includes(k as keyof PageFrontmatter)) emit(k, fm[k]);
  }
  lines.push('---');
  lines.push('');
  // Ensure body has a single trailing newline
  const cleanBody = body.replace(/\n+$/, '') + '\n';
  return lines.join('\n') + cleanBody;
}

function yamlScalar(value: unknown): string {
  const s = String(value);
  // Quote if it contains characters that complicate parsing
  if (s === '' || /^[\[\]{}|>!&*%@`,#?:\-\s]/.test(s) || /:\s|\s$|\s$/.test(s) || s.includes('"')) {
    return JSON.stringify(s);
  }
  return s;
}

function parseFrontmatter(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const mFlow = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!mFlow) {
      i++;
      continue;
    }
    const key = mFlow[1]!;
    const rest = (mFlow[2] ?? '').trim();
    if (rest === '') {
      // Block array follows
      const arr: string[] = [];
      i++;
      while (i < lines.length) {
        const nx = lines[i] ?? '';
        const item = nx.match(/^\s+-\s*(.+)$/);
        if (!item) break;
        arr.push(stripScalar(item[1]!));
        i++;
      }
      out[key] = arr;
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      // Inline array
      const inner = rest.slice(1, -1).trim();
      if (!inner) out[key] = [];
      else {
        const items = splitInlineArray(inner).map(stripScalar);
        out[key] = items;
      }
    } else if (rest === 'true' || rest === 'false') {
      out[key] = rest === 'true';
    } else if (/^-?\d+(\.\d+)?$/.test(rest)) {
      out[key] = Number(rest);
    } else {
      out[key] = stripScalar(rest);
    }
    i++;
  }
  return out;
}

function splitInlineArray(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuote: '"' | "'" | null = null;
  let acc = '';
  for (const ch of s) {
    if (inQuote) {
      acc += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      acc += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      if (acc.trim()) out.push(acc.trim());
      acc = '';
      continue;
    }
    acc += ch;
  }
  if (acc.trim()) out.push(acc.trim());
  return out;
}

function stripScalar(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    try {
      return v.startsWith('"') ? (JSON.parse(v) as string) : v.slice(1, -1);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

// ----------------------------------------------------------------------------
// Slug helpers
// ----------------------------------------------------------------------------

export function toSlug(input: string): string {
  const s = slugify(input, { lower: true, strict: true, trim: true });
  return s || 'untitled';
}

const HUMANIZE_FILLER = new Set([
  'the', 'a', 'an', 'is', 'are', 'should', 'we', 'our', 'us', 'do', 'does',
  'to', 'of', 'in', 'on', 'for', 'and', 'or', 'but', 'be', 'this', 'that',
  'how', 'what', 'why', 'when', 'where', 'who',
]);

/**
 * Humanize an arbitrary string (question text, document title) into a
 * filename-safe kebab slug capped at ~60 chars.
 */
export function humanizeSlug(input: string, maxChars = 60): string {
  const words = input
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !HUMANIZE_FILLER.has(w));
  const candidate = words.slice(0, 8).join('-').replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!candidate) return 'untitled';
  return candidate.slice(0, maxChars).replace(/-$/, '');
}

/** SHA-256 of bytes, first 6 hex chars. */
export function hash6(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 6);
}

/** Full SHA-256 hex digest. */
export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ----------------------------------------------------------------------------
// Wiki-link extraction
// ----------------------------------------------------------------------------

export interface WikiLinkRef {
  slug: string;
  /** Optional `#section-header` portion (without the `#`). */
  anchor?: string;
  /** Optional `|Display Text` portion. */
  display?: string;
  /** True for `![[slug]]` transclusion (not supported in v1). */
  transclusion?: boolean;
  /** True for `[[slug#^block-id]]` block IDs (not supported in v1). */
  blockId?: boolean;
  /** True if a path-prefixed form was used (forbidden — `[[concepts/foo]]`). */
  pathPrefixed?: boolean;
  /** Source text exactly as it appeared. */
  raw: string;
}

const WIKILINK_RE = /(!?)\[\[([^\]\n]+)\]\]/g;

/**
 * Extract every `[[wikilink]]` in a body string. Returns refs in source order.
 * Recognises display overrides `[[slug|Display]]`, header anchors `[[slug#sec]]`,
 * block IDs `[[slug#^id]]` (flagged as blockId), transclusion `![[slug]]`
 * (flagged), and path-prefixed forms (flagged as pathPrefixed).
 */
export function extractWikiLinks(body: string): WikiLinkRef[] {
  const out: WikiLinkRef[] = [];
  let m: RegExpExecArray | null;
  // Reset regex state across calls.
  const re = new RegExp(WIKILINK_RE.source, 'g');
  while ((m = re.exec(body)) !== null) {
    const transclusion = m[1] === '!';
    const inner = (m[2] ?? '').trim();
    if (!inner) continue;
    let display: string | undefined;
    let target = inner;
    const pipeIdx = inner.indexOf('|');
    if (pipeIdx >= 0) {
      target = inner.slice(0, pipeIdx).trim();
      display = inner.slice(pipeIdx + 1).trim();
    }
    let anchor: string | undefined;
    let blockId = false;
    const hashIdx = target.indexOf('#');
    if (hashIdx >= 0) {
      anchor = target.slice(hashIdx + 1).trim();
      target = target.slice(0, hashIdx).trim();
      if (anchor.startsWith('^')) blockId = true;
    }
    const pathPrefixed = target.includes('/') || target.includes('\\');
    const slug = pathPrefixed
      ? target.split(/[/\\]/).pop()!.toLowerCase()
      : target.toLowerCase();
    out.push({
      slug,
      anchor,
      display,
      transclusion: transclusion || undefined,
      blockId: blockId || undefined,
      pathPrefixed: pathPrefixed || undefined,
      raw: m[0]!,
    });
  }
  return out;
}

/** Kebab-case a header text the same way GitHub Flavored Markdown does. */
export function kebabHeader(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

/** Extract all `## ...` and `### ...` headers' kebab-anchors from a body. */
export function extractHeaderAnchors(body: string): string[] {
  const anchors: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^(#{2,6})\s+(.+?)\s*$/);
    if (m) anchors.push(kebabHeader(m[2]!));
  }
  return anchors;
}

// ----------------------------------------------------------------------------
// Page discovery
// ----------------------------------------------------------------------------

export interface WikiPageEntry {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the workspace root (forward slashes). */
  relPath: string;
  /** Path relative to `wiki/` (e.g., `concepts/foo.md`). */
  wikiRelPath: string;
  frontmatter: PageFrontmatter;
  body: string;
}

/**
 * Walk a `wiki/` directory and return every parseable page (skips files with
 * no frontmatter). KNOWLEDGE.md, index.md, and log.md are excluded — they
 * are wiki *infrastructure*, not content pages.
 */
export function walkWikiPages(wikiRoot: string, workspaceRoot?: string): WikiPageEntry[] {
  const out: WikiPageEntry[] = [];
  if (!existsSync(wikiRoot)) return out;
  const wsRoot = workspaceRoot ?? dirname(wikiRoot);
  const infraNames = new Set(['KNOWLEDGE.md', 'index.md', 'log.md']);

  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      // Skip wiki infrastructure files at the top level of wiki/.
      if (dirname(full) === wikiRoot && infraNames.has(e.name)) continue;
      const parsed = readPage(full);
      if (!parsed) continue;
      out.push({
        path: full,
        relPath: toPosix(relative(wsRoot, full)),
        wikiRelPath: toPosix(relative(wikiRoot, full)),
        frontmatter: parsed.frontmatter,
        body: parsed.body,
      });
    }
  };
  walk(wikiRoot);
  return out;
}

export function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Write a page atomically (mkdir parent + write). */
export function writePageAtomic(path: string, fm: PageFrontmatter, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializePage(fm, body), 'utf8');
}

/** Decide the subfolder for a page based on its type. */
export function folderForType(type: PageType): string {
  switch (type) {
    case 'concept':
      return 'concepts';
    case 'entity':
      return 'entities';
    case 'decision':
      return 'decisions';
    case 'source-summary':
      return 'sources';
    case 'comparison':
      return 'comparisons';
  }
}

/** Build an absolute file path from a type + slug + wiki root. */
export function pathForPage(wikiRoot: string, type: PageType, slug: string): string {
  return join(wikiRoot, folderForType(type), `${slug}.md`);
}

/** True if any file ancestor of `path` contains a `.git` directory. */
export function isAncestor(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith('..') && !rel.startsWith(sep + '..');
}

/** File metadata used by lint to flag stale claims. */
export function fileMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
