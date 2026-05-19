import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renameSlug, rewriteBodyLinks, suggestSlug } from '../rename.js';
import { writePageAtomic } from '../page.js';
import { initManifestIfAbsent, loadManifest, appendEntry, newEntry } from '../manifest.js';

let dir: string;
let wiki: string;
let manifestPath: string;
let indexPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aab-rn-'));
  wiki = join(dir, 'wiki');
  manifestPath = join(dir, '.manifest.json');
  indexPath = join(wiki, 'index.md');
  mkdirSync(wiki, { recursive: true });
  mkdirSync(join(wiki, 'concepts'), { recursive: true });
  mkdirSync(join(wiki, 'entities'), { recursive: true });
  initManifestIfAbsent(manifestPath);
  writeFileSync(indexPath, '# Wiki index\n\n<!-- AAB:SLUG-MAP -->\n<!-- /AAB:SLUG-MAP -->\n', 'utf8');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('rewriteBodyLinks', () => {
  it('rewrites plain, display, anchor variants but not unrelated slugs', () => {
    const body = `
      See [[foo-bar]] and [[foo-bar|Display]] and [[foo-bar#section]] and [[other]].
    `;
    const r = rewriteBodyLinks(body, 'foo-bar', 'baz-qux');
    expect(r.count).toBe(3);
    expect(r.text).toContain('[[baz-qux]]');
    expect(r.text).toContain('[[baz-qux|Display]]');
    expect(r.text).toContain('[[baz-qux#section]]');
    expect(r.text).toContain('[[other]]');
  });
});

describe('suggestSlug', () => {
  it('returns the closest match within edit-distance threshold', () => {
    const candidates = ['pricing-strategy', 'unit-economics', 'foo'];
    expect(suggestSlug('priceing-strategy', candidates)).toBe('pricing-strategy');
    expect(suggestSlug('totally-different-xyz', candidates)).toBeUndefined();
  });
});

describe('renameSlug', () => {
  it('rewrites the source file, body refs across pages, related, aliases, and manifest', async () => {
    // Page A — the target of the rename.
    writePageAtomic(
      join(wiki, 'concepts', 'old-thing.md'),
      {
        title: 'Old Thing',
        slug: 'old-thing',
        type: 'concept',
        summary: 'tbd',
        aliases: ['oldie'],
      },
      '# Old Thing\n\nSelf-reference [[old-thing]] and other [[neighbor]].\n',
    );
    // Page B — links into A from its body and `related:`.
    writePageAtomic(
      join(wiki, 'entities', 'neighbor.md'),
      {
        title: 'Neighbor',
        slug: 'neighbor',
        type: 'entity',
        summary: 'nbhd',
        related: ['[[old-thing]]', '[[other-thing]]'],
      },
      '# Neighbor\n\nMentions [[old-thing]] and [[old-thing|the old one]].\n',
    );
    // Page C — has `old-thing` as an alias under a different canonical (would
    // be a collision — but here we use a different alias to keep it valid).
    writePageAtomic(
      join(wiki, 'concepts', 'other-thing.md'),
      {
        title: 'Other Thing',
        slug: 'other-thing',
        type: 'concept',
        summary: 'misc',
      },
      '# Other Thing\n',
    );

    // Manifest entry that mentions the old path.
    appendEntry(
      manifestPath,
      newEntry({
        rawPath: 'raw/files/whatever.md',
        sourceType: 'file',
        hash: 'h1',
        producedPages: ['wiki/concepts/old-thing.md'],
        updatedPages: ['wiki/entities/neighbor.md'],
      }),
    );

    const result = await renameSlug({
      wikiRoot: wiki,
      manifestPath,
      indexPath,
      workspaceRoot: dir,
      fromSlug: 'old-thing',
      toSlug: 'new-thing',
    });
    expect(result.fromSlug).toBe('old-thing');
    expect(result.toSlug).toBe('new-thing');
    expect(result.rewroteRefs).toBeGreaterThan(0);
    expect(result.rewroteRelated).toBeGreaterThan(0);
    expect(result.rewroteManifestEntries).toBeGreaterThan(0);

    // Old file gone, new file present.
    expect(existsSync(join(wiki, 'concepts', 'old-thing.md'))).toBe(false);
    expect(existsSync(join(wiki, 'concepts', 'new-thing.md'))).toBe(true);

    // Source page now has slug: new-thing.
    const newA = readFileSync(join(wiki, 'concepts', 'new-thing.md'), 'utf8');
    expect(newA).toMatch(/slug:\s*new-thing/);
    expect(newA).toContain('[[new-thing]]');

    // Neighbor page rewritten.
    const newB = readFileSync(join(wiki, 'entities', 'neighbor.md'), 'utf8');
    expect(newB).toContain('[[new-thing]]');
    expect(newB).toContain('[[new-thing|the old one]]');
    expect(newB).toContain('[[new-thing]]'); // in related
    expect(newB).not.toMatch(/\[\[old-thing/);

    // Manifest rewritten + rename event appended.
    const manifest = loadManifest(manifestPath);
    expect(manifest.entries[0]!.producedPages).toContain('wiki/concepts/new-thing.md');
    expect(manifest.renames.length).toBe(1);
    expect(manifest.renames[0]!.fromSlug).toBe('old-thing');
    expect(manifest.renames[0]!.toSlug).toBe('new-thing');

    // Slug-map in index.md regenerated.
    const idx = readFileSync(indexPath, 'utf8');
    expect(idx).toContain('new-thing');
    expect(idx).not.toContain('| old-thing |');
  });

  it('refuses to rename to a slug that already exists', async () => {
    writePageAtomic(join(wiki, 'concepts', 'foo.md'), { title: 'Foo', slug: 'foo', type: 'concept' }, '# Foo\n');
    writePageAtomic(join(wiki, 'concepts', 'bar.md'), { title: 'Bar', slug: 'bar', type: 'concept' }, '# Bar\n');
    await expect(
      renameSlug({
        wikiRoot: wiki,
        manifestPath,
        indexPath,
        workspaceRoot: dir,
        fromSlug: 'foo',
        toSlug: 'bar',
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('refuses to rename to an existing alias on another page', async () => {
    writePageAtomic(
      join(wiki, 'concepts', 'foo.md'),
      { title: 'Foo', slug: 'foo', type: 'concept' },
      '# Foo\n',
    );
    writePageAtomic(
      join(wiki, 'concepts', 'baz.md'),
      { title: 'Baz', slug: 'baz', type: 'concept', aliases: ['shared'] },
      '# Baz\n',
    );
    await expect(
      renameSlug({
        wikiRoot: wiki,
        manifestPath,
        indexPath,
        workspaceRoot: dir,
        fromSlug: 'foo',
        toSlug: 'shared',
      }),
    ).rejects.toThrow(/already declared as an alias/);
  });

  it('--dry-run does not modify any files', async () => {
    writePageAtomic(
      join(wiki, 'concepts', 'foo.md'),
      { title: 'Foo', slug: 'foo', type: 'concept' },
      '# Foo\n',
    );
    const result = await renameSlug({
      wikiRoot: wiki,
      manifestPath,
      indexPath,
      workspaceRoot: dir,
      fromSlug: 'foo',
      toSlug: 'bar',
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(existsSync(join(wiki, 'concepts', 'foo.md'))).toBe(true);
    expect(existsSync(join(wiki, 'concepts', 'bar.md'))).toBe(false);
  });
});
