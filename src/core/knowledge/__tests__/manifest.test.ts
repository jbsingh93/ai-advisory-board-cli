import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyManifest,
  loadManifest,
  saveManifest,
  initManifestIfAbsent,
  appendEntry,
  appendRename,
  findEntryByHash,
  newEntry,
  rewriteManifestPaths,
  markUserEdited,
  MANIFEST_VERSION,
} from '../manifest.js';

let dir: string;
let p: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aab-mf-'));
  p = join(dir, '.manifest.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('manifest lifecycle', () => {
  it('starts empty with the correct shape', () => {
    const m = emptyManifest();
    expect(m.version).toBe(MANIFEST_VERSION);
    expect(m.entries).toEqual([]);
    expect(m.userEditedPages).toEqual([]);
    expect(m.renames).toEqual([]);
  });

  it('initManifestIfAbsent creates a file once', () => {
    expect(existsSync(p)).toBe(false);
    initManifestIfAbsent(p);
    expect(existsSync(p)).toBe(true);
    const before = readFileSync(p, 'utf8');
    initManifestIfAbsent(p);
    expect(readFileSync(p, 'utf8')).toBe(before);
  });

  it('appendEntry persists atomically', () => {
    const entry = newEntry({
      rawPath: 'raw/files/foo.md',
      sourceType: 'file',
      hash: 'abc123',
      producedPages: ['wiki/concepts/foo.md'],
      updatedPages: [],
    });
    const m1 = appendEntry(p, entry);
    expect(m1.entries.length).toBe(1);
    const m2 = loadManifest(p);
    expect(m2.entries[0]!.hash).toBe('abc123');
  });

  it('findEntryByHash returns the most recent match', () => {
    const e1 = newEntry({ rawPath: 'raw/files/a.md', sourceType: 'file', hash: 'x', producedPages: [], updatedPages: [] });
    const e2 = newEntry({ rawPath: 'raw/files/b.md', sourceType: 'file', hash: 'y', producedPages: [], updatedPages: [] });
    appendEntry(p, e1);
    appendEntry(p, e2);
    const m = loadManifest(p);
    expect(findEntryByHash(m, 'x')!.rawPath).toBe('raw/files/a.md');
    expect(findEntryByHash(m, 'unknown')).toBeUndefined();
  });

  it('rewriteManifestPaths rewrites producedPages, updatedPages, userEdited', () => {
    const e1 = newEntry({
      rawPath: 'raw/files/a.md',
      sourceType: 'file',
      hash: 'h1',
      producedPages: ['wiki/concepts/old.md', 'wiki/entities/other.md'],
      updatedPages: ['wiki/concepts/old.md'],
      userEditedPagesSkipped: ['wiki/concepts/old.md'],
    });
    appendEntry(p, e1);
    markUserEdited(p, 'wiki/concepts/old.md');
    const m = loadManifest(p);
    const res = rewriteManifestPaths(m, 'wiki/concepts/old.md', 'wiki/concepts/new.md');
    expect(res.rewroteManifestEntries).toBeGreaterThanOrEqual(3);
    expect(m.entries[0]!.producedPages).toContain('wiki/concepts/new.md');
    expect(m.entries[0]!.updatedPages).toContain('wiki/concepts/new.md');
    expect(m.userEditedPages[0]!.page).toBe('wiki/concepts/new.md');
  });

  it('appendRename logs the rename event', () => {
    appendRename(p, {
      from: 'wiki/concepts/old.md',
      to: 'wiki/concepts/new.md',
      fromSlug: 'old',
      toSlug: 'new',
      trigger: 'manual',
      rewroteRefs: 5,
    });
    const m = loadManifest(p);
    expect(m.renames.length).toBe(1);
    expect(m.renames[0]!.trigger).toBe('manual');
    expect(m.renames[0]!.rewroteRefs).toBe(5);
    expect(m.renames[0]!.id.startsWith('ren_')).toBe(true);
  });
});

void saveManifest;
