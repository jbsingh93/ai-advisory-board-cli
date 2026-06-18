import { describe, expect, it } from 'vitest';
import { buildCatalogDigest } from '../query.js';

function makeCatalog(n: number, extra: Record<string, unknown>[] = []): string {
  const pages = [];
  for (let i = 0; i < n; i++) {
    pages.push({
      slug: `filler-page-${i}`,
      type: 'entity',
      title: `Filler Page ${i}`,
      summary: 'A filler page with a reasonably long summary so the catalog grows large enough to exceed the digest budget for the test.',
      tags: ['filler', 'noise', `t${i % 7}`],
      path: `entities/filler-page-${i}.md`,
    });
  }
  pages.push(...extra);
  return JSON.stringify({ version: 1, count: pages.length, pages });
}

describe('buildCatalogDigest', () => {
  it('returns the catalog unchanged when it is already under budget', () => {
    const json = makeCatalog(2);
    expect(buildCatalogDigest(json, 'anything', 100_000)).toBe(json);
  });

  it('bounds an oversized catalog to roughly the budget', () => {
    const json = makeCatalog(2000);
    expect(json.length).toBeGreaterThan(48_000);
    const out = buildCatalogDigest(json, 'robin sand', 48_000);
    // Allow a little overhead for the _note/_omitted wrapper + one last entry.
    expect(out.length).toBeLessThan(48_000 + 2_000);
    const parsed = JSON.parse(out);
    expect(parsed._omitted).toBeGreaterThan(0);
    expect(parsed.pages.length).toBeLessThan(2000);
  });

  it('keeps the most relevant page even when it would otherwise be buried', () => {
    const target = {
      slug: 'robin-sand',
      type: 'entity',
      title: 'Robin Sand',
      summary: 'CEO and Sales Lead at Vallora.',
      tags: ['person', 'sales'],
      path: 'entities/robin-sand.md',
    };
    // Bury the target at the END so only relevance ranking surfaces it.
    const json = makeCatalog(2000, [target]);
    const out = buildCatalogDigest(json, 'hvem er robin sand?', 48_000);
    const parsed = JSON.parse(out);
    const slugs = parsed.pages.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain('robin-sand');
  });

  it('hard-caps unparseable catalog JSON instead of inlining it whole', () => {
    const garbage = 'x'.repeat(80_000);
    const out = buildCatalogDigest(garbage, 'q', 48_000);
    expect(out.length).toBeLessThan(48_500);
    expect(out).toContain('truncated');
  });
});
