import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSlugMap, writeSlugMapToIndex, buildCatalog, type Catalog } from '../slug-map.js';
import { retrieveWikiContext } from '../retrieve.js';

let root: string;
let wiki: string;

function writePage(folder: string, slug: string, fm: Record<string, unknown>, body: string): void {
  const dir = join(wiki, folder);
  mkdirSync(dir, { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`);
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push('---', '', body, '');
  writeFileSync(join(dir, `${slug}.md`), lines.join('\n'), 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aab-retrieve-'));
  wiki = join(root, 'wiki');
  mkdirSync(wiki, { recursive: true });
  writePage('concepts', 'pricing-strategy', { slug: 'pricing-strategy', title: 'Pricing Strategy', type: 'concept', summary: 'How we price the SaaS product', tags: ['pricing', 'revenue'] }, 'We use value-based pricing tiers. Enterprise is custom.');
  writePage('entities', 'stripe', { slug: 'stripe', title: 'Stripe', type: 'entity', summary: 'Payment processor we use', tags: ['payments', 'billing'] }, 'Stripe handles all card billing and invoicing.');
  writePage('decisions', 'hire-cfo', { slug: 'hire-cfo', title: 'Hire a CFO', type: 'decision', summary: 'Decision to hire a fractional CFO', tags: ['hiring', 'finance'] }, 'We decided to bring on a fractional CFO in Q3.');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('catalog generation', () => {
  it('buildCatalog projects canonical pages with the compact field set', () => {
    const map = buildSlugMap(wiki, root);
    const catalog = buildCatalog(map);
    expect(catalog.version).toBe(1);
    expect(catalog.count).toBe(3);
    const pricing = catalog.pages.find((p) => p.slug === 'pricing-strategy')!;
    expect(pricing).toMatchObject({
      slug: 'pricing-strategy',
      type: 'concept',
      title: 'Pricing Strategy',
      summary: 'How we price the SaaS product',
      tags: ['pricing', 'revenue'],
      path: 'concepts/pricing-strategy.md',
    });
  });

  it('writeSlugMapToIndex also writes the compact catalog at .aab/catalog.json', () => {
    const map = buildSlugMap(wiki, root);
    writeSlugMapToIndex(join(wiki, 'index.md'), map);
    const catalogPath = join(wiki, '.aab', 'catalog.json');
    expect(existsSync(catalogPath)).toBe(true);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog;
    expect(catalog.count).toBe(3);
    expect(catalog.pages.map((p) => p.slug).sort()).toEqual(['hire-cfo', 'pricing-strategy', 'stripe']);
  });
});

describe('retrieveWikiContext', () => {
  it('ranks pages by keyword overlap and returns excerpts', () => {
    const pages = retrieveWikiContext({ wikiRoot: wiki, workspaceRoot: root, query: 'How should we change our pricing tiers?' });
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0]!.slug).toBe('pricing-strategy');
    expect(pages[0]!.excerpt).toContain('value-based pricing');
    // Frontmatter must be stripped from the excerpt.
    expect(pages[0]!.excerpt).not.toContain('slug:');
  });

  it('matches on tags and title, not just slug', () => {
    const pages = retrieveWikiContext({ wikiRoot: wiki, workspaceRoot: root, query: 'questions about billing and payments' });
    expect(pages.some((p) => p.slug === 'stripe')).toBe(true);
  });

  it('returns [] when no keyword matches (agent falls back to its own search)', () => {
    const pages = retrieveWikiContext({ wikiRoot: wiki, workspaceRoot: root, query: 'astrophysics nebula telescope' });
    expect(pages).toEqual([]);
  });

  it('honours maxPages', () => {
    const pages = retrieveWikiContext({ wikiRoot: wiki, workspaceRoot: root, query: 'pricing payments finance hiring revenue billing', maxPages: 2 });
    expect(pages.length).toBeLessThanOrEqual(2);
  });

  it('prefers the catalog when present and still resolves excerpts', () => {
    const map = buildSlugMap(wiki, root);
    writeSlugMapToIndex(join(wiki, 'index.md'), map);
    const pages = retrieveWikiContext({ wikiRoot: wiki, workspaceRoot: root, query: 'fractional CFO finance hire' });
    expect(pages[0]!.slug).toBe('hire-cfo');
    expect(pages[0]!.excerpt).toContain('fractional CFO');
  });

  it('truncates excerpts to the cap', () => {
    writePage('concepts', 'long-page', { slug: 'long-page', title: 'Long Page', type: 'concept', summary: 'big', tags: ['pricing'] }, 'pricing '.repeat(500));
    const pages = retrieveWikiContext({ wikiRoot: wiki, workspaceRoot: root, query: 'pricing', excerptChars: 200 });
    const long = pages.find((p) => p.slug === 'long-page')!;
    expect(long.excerpt.length).toBeLessThan(400);
    expect(long.excerpt).toContain('truncated');
  });
});
