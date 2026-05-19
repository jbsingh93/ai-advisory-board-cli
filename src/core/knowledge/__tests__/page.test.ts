import { describe, it, expect } from 'vitest';
import {
  parsePage,
  serializePage,
  toSlug,
  humanizeSlug,
  extractWikiLinks,
  kebabHeader,
  extractHeaderAnchors,
  hash6,
  sha256Hex,
  type PageFrontmatter,
} from '../page.js';

describe('toSlug', () => {
  it('produces kebab-case', () => {
    expect(toSlug('Hello World')).toBe('hello-world');
    expect(toSlug('Q3 2026 Pricing!')).toBe('q3-2026-pricing');
  });
  it('falls back to "untitled" for empty input', () => {
    expect(toSlug('')).toBe('untitled');
    expect(toSlug('   ')).toBe('untitled');
  });
});

describe('humanizeSlug', () => {
  it('drops filler words', () => {
    // "should we focus on enterprise this quarter" → "focus enterprise quarter"
    const slug = humanizeSlug('Should we focus on enterprise this quarter?');
    expect(slug).toContain('focus');
    expect(slug).toContain('enterprise');
    expect(slug).not.toContain('should');
    expect(slug).not.toContain('we');
    expect(slug).not.toContain('on');
  });
  it('caps length', () => {
    const long = humanizeSlug('a '.repeat(100) + 'word', 20);
    expect(long.length).toBeLessThanOrEqual(20);
  });
});

describe('parsePage + serializePage', () => {
  it('round-trips frontmatter + body', () => {
    const fm: PageFrontmatter = {
      title: 'Pricing Strategy',
      slug: 'pricing-strategy',
      aliases: ['pricing', 'monetization'],
      type: 'concept',
      summary: 'How we price.',
      tags: ['pricing', 'b2b'],
      sources: ['raw/files/foo.md'],
      related: ['[[unit-economics]]'],
      confidence: 'high',
      provenance: 'extracted',
      created: '2026-05-19',
      updated: '2026-05-19',
      userEdited: false,
    };
    const body = '# Pricing\n\nWe price by [[unit-economics]].\n';
    const out = serializePage(fm, body);
    expect(out).toContain('slug: pricing-strategy');
    expect(out).toContain('aliases:');
    expect(out).toContain('  - pricing');
    expect(out).toContain('  - monetization');
    const parsed = parsePage(out);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.slug).toBe('pricing-strategy');
    expect(parsed!.frontmatter.aliases).toEqual(['pricing', 'monetization']);
    expect(parsed!.frontmatter.type).toBe('concept');
    expect(parsed!.body.trim()).toBe('# Pricing\n\nWe price by [[unit-economics]].'.trim());
  });
  it('returns null on missing frontmatter', () => {
    expect(parsePage('# Just a heading\n\nNo frontmatter.')).toBeNull();
  });
});

describe('extractWikiLinks', () => {
  it('catches basic, display, anchor, transclusion, path-prefixed, and block-id forms', () => {
    const body = `
      A regular [[foo-bar]] link.
      A display [[foo-bar|Friendly Name]] override.
      An anchor [[foo-bar#section-one]] link.
      A block id [[foo-bar#^abc]] (deprecated).
      A transclusion ![[foo-bar]] (deprecated).
      A path-prefixed [[concepts/foo-bar]] (forbidden).
    `;
    const links = extractWikiLinks(body);
    expect(links.length).toBe(6);
    expect(links[0]!.slug).toBe('foo-bar');
    expect(links[1]!.display).toBe('Friendly Name');
    expect(links[2]!.anchor).toBe('section-one');
    expect(links[3]!.blockId).toBe(true);
    expect(links[4]!.transclusion).toBe(true);
    expect(links[5]!.pathPrefixed).toBe(true);
  });
});

describe('kebabHeader + extractHeaderAnchors', () => {
  it('kebab-cases header text', () => {
    expect(kebabHeader('Pricing Strategy')).toBe('pricing-strategy');
    expect(kebabHeader('## Edge Cases (1)')).toBe('-edge-cases-1');
  });
  it('extracts all H2+ anchors', () => {
    const body = '# H1\n\n## Section One\n\n### Sub\n\n#### Deeper\n';
    const anchors = extractHeaderAnchors(body);
    expect(anchors).toContain('section-one');
    expect(anchors).toContain('sub');
    expect(anchors).toContain('deeper');
  });
});

describe('hashes', () => {
  it('hash6 returns 6 hex chars', () => {
    const h = hash6('hello');
    expect(h.length).toBe(6);
    expect(/^[0-9a-f]{6}$/.test(h)).toBe(true);
  });
  it('sha256Hex is deterministic', () => {
    const a = sha256Hex('hello');
    const b = sha256Hex('hello');
    expect(a).toBe(b);
    expect(a.length).toBe(64);
  });
});
