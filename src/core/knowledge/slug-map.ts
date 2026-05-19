/**
 * Slug-map — the canonical `[[wikilink]]` resolver.
 *
 * Lives between `<!-- AAB:SLUG-MAP -->` and `<!-- /AAB:SLUG-MAP -->` sentinels
 * in `wiki/index.md`. Ingest re-renders it after every run; lint regenerates
 * it from scratch (idempotent). Agents read it as the cheap-pass map; if a
 * slug is missing they Glob `wiki/**\/<slug>.md`. See `PLAN/KNOWLEDGE_WIKI.md`
 * §11.3 and §11.5.
 *
 * Aliases share the global namespace with canonical slugs. The slug-map
 * renders an alias as its own row, annotated `(alias: <alias>)`, so a single
 * lookup table covers both forms.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { walkWikiPages, type WikiPageEntry, type PageType } from './page.js';

export const SLUG_MAP_OPEN = '<!-- AAB:SLUG-MAP -->';
export const SLUG_MAP_CLOSE = '<!-- /AAB:SLUG-MAP -->';
export const BACKLINKS_OPEN = '<!-- AAB:BACKLINKS -->';
export const BACKLINKS_CLOSE = '<!-- /AAB:BACKLINKS -->';

export interface SlugMapEntry {
  slug: string;
  /** Forward-slash path relative to `wiki/`. */
  path: string;
  type: PageType | string;
  title?: string;
  summary?: string;
  /** When this row represents an alias, the canonical slug. */
  canonical?: string;
}

export interface SlugMap {
  /** Canonical slug → entry. */
  canonical: Map<string, SlugMapEntry>;
  /** Alias → canonical slug. Includes self-mapping for canonicals. */
  aliasToCanonical: Map<string, string>;
}

/**
 * Build a slug-map by walking the wiki directory.
 */
export function buildSlugMap(wikiRoot: string, workspaceRoot?: string): SlugMap {
  const pages = walkWikiPages(wikiRoot, workspaceRoot);
  return buildSlugMapFromPages(pages);
}

export function buildSlugMapFromPages(pages: WikiPageEntry[]): SlugMap {
  const canonical = new Map<string, SlugMapEntry>();
  const aliasToCanonical = new Map<string, string>();
  for (const p of pages) {
    const slug = (p.frontmatter.slug ?? '').trim().toLowerCase();
    if (!slug) continue;
    const entry: SlugMapEntry = {
      slug,
      path: p.wikiRelPath,
      type: (p.frontmatter.type as PageType) ?? 'concept',
      title: typeof p.frontmatter.title === 'string' ? p.frontmatter.title : undefined,
      summary: typeof p.frontmatter.summary === 'string' ? p.frontmatter.summary : undefined,
    };
    canonical.set(slug, entry);
    aliasToCanonical.set(slug, slug);
    const aliases = Array.isArray(p.frontmatter.aliases) ? p.frontmatter.aliases : [];
    for (const a of aliases) {
      if (typeof a !== 'string') continue;
      const alias = a.trim().toLowerCase();
      if (!alias || alias === slug) continue;
      aliasToCanonical.set(alias, slug);
    }
  }
  return { canonical, aliasToCanonical };
}

/** Resolve a `[[slug]]` (possibly an alias) to its entry, or `undefined`. */
export function resolveSlug(map: SlugMap, slug: string): SlugMapEntry | undefined {
  const canonical = map.aliasToCanonical.get(slug.trim().toLowerCase());
  if (!canonical) return undefined;
  return map.canonical.get(canonical);
}

/**
 * Render the slug-map table block (between the sentinels). Stable order:
 *   - canonical slugs alphabetically by slug
 *   - aliases interleaved right after their canonical row
 */
export function renderSlugMap(map: SlugMap): string {
  const slugs = Array.from(map.canonical.keys()).sort();
  const aliasesBySlug = new Map<string, string[]>();
  for (const [alias, canonical] of map.aliasToCanonical.entries()) {
    if (alias === canonical) continue;
    if (!aliasesBySlug.has(canonical)) aliasesBySlug.set(canonical, []);
    aliasesBySlug.get(canonical)!.push(alias);
  }

  const lines: string[] = [];
  lines.push(SLUG_MAP_OPEN);
  if (slugs.length === 0) {
    lines.push('');
    lines.push('_No wiki pages yet. Run `aab knowledge ingest <path-or-url>` to seed._');
    lines.push('');
  } else {
    lines.push('');
    lines.push('| Slug | Path | Type | Summary |');
    lines.push('|------|------|------|---------|');
    for (const slug of slugs) {
      const e = map.canonical.get(slug)!;
      lines.push(`| ${escapeCell(e.slug)} | ${escapeCell(e.path)} | ${escapeCell(e.type)} | ${escapeCell(e.summary ?? '')} |`);
      const aliases = aliasesBySlug.get(slug);
      if (aliases) {
        for (const a of aliases.sort()) {
          lines.push(`| ${escapeCell(a)} _(alias)_ | ${escapeCell(e.path)} | ${escapeCell(e.type)} | ${escapeCell(e.summary ?? '')} |`);
        }
      }
    }
    lines.push('');
  }
  lines.push(SLUG_MAP_CLOSE);
  return lines.join('\n');
}

/**
 * Parse the slug-map back out of a rendered block. Used by query/lint as a
 * fast-path before walking the wiki. Returns an empty SlugMap if the
 * sentinels are missing or the table is empty.
 */
export function parseSlugMap(indexBody: string): SlugMap {
  const openIdx = indexBody.indexOf(SLUG_MAP_OPEN);
  const closeIdx = indexBody.indexOf(SLUG_MAP_CLOSE);
  const map: SlugMap = { canonical: new Map(), aliasToCanonical: new Map() };
  if (openIdx < 0 || closeIdx < 0 || closeIdx <= openIdx) return map;
  const block = indexBody.slice(openIdx + SLUG_MAP_OPEN.length, closeIdx);
  const rows = block.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith('|') && !s.startsWith('|--') && !/^\|\s*Slug\s*\|/i.test(s));
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
    if (cells.length < 3) continue;
    const slugCell = cells[0]!;
    const path = cells[1]!;
    const type = cells[2]!;
    const summary = cells[3] ?? '';
    const aliasMatch = slugCell.match(/^(\S+)\s+_\(alias\)_$/);
    if (aliasMatch) {
      const alias = aliasMatch[1]!.toLowerCase();
      // Find canonical by path
      let canonical: string | undefined;
      for (const [cSlug, cEntry] of map.canonical.entries()) {
        if (cEntry.path === path) {
          canonical = cSlug;
          break;
        }
      }
      if (canonical) map.aliasToCanonical.set(alias, canonical);
    } else {
      const slug = slugCell.toLowerCase();
      map.canonical.set(slug, { slug, path, type, summary });
      map.aliasToCanonical.set(slug, slug);
    }
  }
  return map;
}

/**
 * Rewrite the slug-map section of `wiki/index.md`. Preserves the prose
 * outside the sentinels verbatim. If the sentinels are missing, appends a
 * fresh slug-map section to the end of the file.
 */
export function writeSlugMapToIndex(indexPath: string, map: SlugMap, header?: string): void {
  mkdirSync(dirname(indexPath), { recursive: true });
  const existing = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
  const block = renderSlugMap(map);
  const openIdx = existing.indexOf(SLUG_MAP_OPEN);
  const closeIdx = existing.indexOf(SLUG_MAP_CLOSE);
  let next: string;
  if (openIdx >= 0 && closeIdx > openIdx) {
    next = existing.slice(0, openIdx) + block + existing.slice(closeIdx + SLUG_MAP_CLOSE.length);
  } else if (existing) {
    next = existing.replace(/\n+$/, '') + '\n\n## Slug map (auto-maintained — do not hand-edit)\n\n' + block + '\n';
  } else {
    next = (header ?? defaultIndexHeader()) + '\n\n## Slug map (auto-maintained — do not hand-edit)\n\n' + block + '\n';
  }
  writeFileSync(indexPath, next, 'utf8');
}

export function defaultIndexHeader(): string {
  return [
    '# Wiki index',
    '',
    'Browse the wiki by type:',
    '',
    '- [Concepts](concepts/)',
    '- [Entities](entities/)',
    '- [Decisions](decisions/)',
    '- [Sources](sources/)',
    '- [Comparisons](comparisons/)',
    '',
    'See `KNOWLEDGE.md` for the schema and conventions.',
  ].join('\n');
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200);
}

// ----------------------------------------------------------------------------
// Backlinks (`<!-- AAB:BACKLINKS -->` section per page)
// ----------------------------------------------------------------------------

/** Replace the backlinks section in a page body, or append one if missing. */
export function setBacklinksSection(body: string, backlinks: string[]): string {
  const block: string[] = [];
  block.push(BACKLINKS_OPEN);
  if (backlinks.length === 0) {
    block.push('');
    block.push('_(no incoming links yet)_');
    block.push('');
  } else {
    block.push('');
    block.push('## Backlinks');
    block.push('');
    for (const b of backlinks) block.push(`- ${b}`);
    block.push('');
  }
  block.push(BACKLINKS_CLOSE);
  const text = block.join('\n');
  const openIdx = body.indexOf(BACKLINKS_OPEN);
  const closeIdx = body.indexOf(BACKLINKS_CLOSE);
  if (openIdx >= 0 && closeIdx > openIdx) {
    return body.slice(0, openIdx) + text + body.slice(closeIdx + BACKLINKS_CLOSE.length);
  }
  return body.replace(/\n+$/, '') + '\n\n' + text + '\n';
}

/** Extract the existing backlinks block (everything between the sentinels). */
export function extractBacklinksSection(body: string): string | null {
  const openIdx = body.indexOf(BACKLINKS_OPEN);
  const closeIdx = body.indexOf(BACKLINKS_CLOSE);
  if (openIdx < 0 || closeIdx < 0 || closeIdx <= openIdx) return null;
  return body.slice(openIdx + BACKLINKS_OPEN.length, closeIdx);
}
