import { describe, it, expect } from 'vitest';
import {
  buildSlugMapFromPages,
  renderSlugMap,
  parseSlugMap,
  resolveSlug,
  setBacklinksSection,
  extractBacklinksSection,
  SLUG_MAP_OPEN,
  SLUG_MAP_CLOSE,
  BACKLINKS_OPEN,
  BACKLINKS_CLOSE,
} from '../slug-map.js';
import type { WikiPageEntry } from '../page.js';

function page(slug: string, type: string, opts: { aliases?: string[]; title?: string; summary?: string } = {}): WikiPageEntry {
  const folder = ({ concept: 'concepts', entity: 'entities', decision: 'decisions', 'source-summary': 'sources', comparison: 'comparisons' } as Record<string, string>)[type] ?? 'concepts';
  return {
    path: `/ws/wiki/${folder}/${slug}.md`,
    relPath: `wiki/${folder}/${slug}.md`,
    wikiRelPath: `${folder}/${slug}.md`,
    frontmatter: {
      slug,
      title: opts.title ?? slug,
      type: type as any,
      summary: opts.summary,
      aliases: opts.aliases,
    } as any,
    body: '',
  };
}

describe('buildSlugMapFromPages', () => {
  it('indexes slugs and aliases into one namespace', () => {
    const pages = [
      page('unit-economics', 'concept'),
      page('stripe', 'entity', { aliases: ['stripe-inc'] }),
    ];
    const map = buildSlugMapFromPages(pages);
    expect(map.canonical.size).toBe(2);
    expect(map.aliasToCanonical.get('stripe-inc')).toBe('stripe');
    expect(map.aliasToCanonical.get('unit-economics')).toBe('unit-economics');
  });
});

describe('renderSlugMap + parseSlugMap round-trip', () => {
  it('produces a table that parses back to the same canonical/alias structure', () => {
    const pages = [
      page('a-concept', 'concept', { summary: 'first' }),
      page('an-entity', 'entity', { aliases: ['the-entity'], summary: 'second' }),
    ];
    const map = buildSlugMapFromPages(pages);
    const rendered = renderSlugMap(map);
    expect(rendered.startsWith(SLUG_MAP_OPEN)).toBe(true);
    expect(rendered.trimEnd().endsWith(SLUG_MAP_CLOSE)).toBe(true);

    const wrapped = `# Test\n\n${rendered}\n`;
    const parsed = parseSlugMap(wrapped);
    expect(parsed.canonical.has('a-concept')).toBe(true);
    expect(parsed.canonical.has('an-entity')).toBe(true);
    expect(parsed.aliasToCanonical.get('the-entity')).toBe('an-entity');
  });

  it('resolves an alias to its canonical entry', () => {
    const pages = [page('stripe', 'entity', { aliases: ['stripe-inc'] })];
    const map = buildSlugMapFromPages(pages);
    const e = resolveSlug(map, 'stripe-inc');
    expect(e).toBeDefined();
    expect(e!.slug).toBe('stripe');
  });

  it('returns undefined for unknown slugs', () => {
    const map = buildSlugMapFromPages([]);
    expect(resolveSlug(map, 'nope')).toBeUndefined();
  });
});

describe('renderSlugMap is idempotent', () => {
  it('render → parse → render produces structurally identical content', () => {
    const pages = [
      page('foo', 'concept'),
      page('bar', 'entity', { aliases: ['baz'] }),
    ];
    const map1 = buildSlugMapFromPages(pages);
    const rendered1 = renderSlugMap(map1);
    const parsed = parseSlugMap(`x\n${rendered1}\n`);
    const rendered2 = renderSlugMap(parsed);
    expect(rendered1).toBe(rendered2);
  });
});

describe('backlinks section', () => {
  it('appends a backlinks block when none exists', () => {
    const body = '# Body\n\nText.\n';
    const next = setBacklinksSection(body, ['[[other]]']);
    expect(next).toContain(BACKLINKS_OPEN);
    expect(next).toContain(BACKLINKS_CLOSE);
    expect(next).toContain('[[other]]');
  });
  it('replaces an existing backlinks block', () => {
    const body = '# Body\n\nText.\n\n' + BACKLINKS_OPEN + '\n\n## Backlinks\n\n- [[old]]\n\n' + BACKLINKS_CLOSE + '\n';
    const next = setBacklinksSection(body, ['[[new]]']);
    expect(next).toContain('[[new]]');
    expect(next).not.toContain('[[old]]');
  });
  it('extracts the existing block', () => {
    const body = '# Body\n\n' + BACKLINKS_OPEN + '\ninside\n' + BACKLINKS_CLOSE + '\n';
    expect(extractBacklinksSection(body)?.includes('inside')).toBe(true);
    expect(extractBacklinksSection('no markers here')).toBeNull();
  });
});
