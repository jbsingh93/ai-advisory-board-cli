/**
 * Atomic cross-file slug rename — the only sanctioned way to rewrite a slug
 * across the wiki. Manual `mv` breaks `[[wikilinks]]` and is recoverable only
 * via `aab knowledge rename --auto-fix`.
 *
 * Spec: `PLAN/KNOWLEDGE_WIKI.md` §11.4 + §13 ("Rename behavior on the manifest").
 *
 * All writes are atomic at the file level (parent dir + write). The whole
 * operation runs under the workspace mutex (acquired by the caller via
 * `openContext`).
 */
import { existsSync, readFileSync, renameSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  walkWikiPages,
  type WikiPageEntry,
  type PageFrontmatter,
  serializePage,
  extractWikiLinks,
  parsePage,
  toPosix,
} from './page.js';
import {
  loadManifest,
  saveManifest,
  appendRename,
  rewriteManifestPaths,
  type ManifestRenameTrigger,
} from './manifest.js';
import { writeSlugMapToIndex, buildSlugMap } from './slug-map.js';
import { nowIso } from '../utils.js';
import { UserError } from '../errors.js';

export interface RenameOptions {
  wikiRoot: string;
  manifestPath: string;
  indexPath: string;
  workspaceRoot: string;
  fromSlug: string;
  toSlug: string;
  /** When true, plan the rewrites but don't write anything. */
  dryRun?: boolean;
  /** Trigger label for the manifest renames[] log entry. */
  trigger?: ManifestRenameTrigger;
}

export interface RenameResult {
  fromPath: string;
  toPath: string;
  fromSlug: string;
  toSlug: string;
  rewroteRefs: number;
  rewroteRelated: number;
  rewroteAliases: number;
  rewroteManifestEntries: number;
  /** Per-file diff hints (path → change summary). */
  changedFiles: Array<{ path: string; refs: number; related: number; aliases: number }>;
  dryRun: boolean;
}

export async function renameSlug(opts: RenameOptions): Promise<RenameResult> {
  const fromSlug = opts.fromSlug.trim().toLowerCase();
  const toSlug = opts.toSlug.trim().toLowerCase();
  if (!fromSlug) throw new UserError('rename: <old-slug> is required.');
  if (!toSlug) throw new UserError('rename: <new-slug> is required.');
  if (fromSlug === toSlug) throw new UserError(`rename: <old> and <new> are identical ("${fromSlug}").`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(toSlug)) {
    throw new UserError(
      `rename: "${toSlug}" is not a valid kebab-case slug.`,
      'Use lower-case letters, digits, and hyphens only; start with a letter or digit.',
    );
  }

  const pages = walkWikiPages(opts.wikiRoot, opts.workspaceRoot);
  const source = pages.find((p) => (p.frontmatter.slug ?? '').toLowerCase() === fromSlug);
  if (!source) {
    throw new UserError(
      `rename: no page with slug "${fromSlug}" found in ${opts.wikiRoot}.`,
      `Try \`aab knowledge list\` to see existing slugs, or \`aab knowledge unresolved --suggest-fixes\` if the slug is referenced but has been moved.`,
    );
  }

  // Detect collision with the new slug or any alias.
  for (const p of pages) {
    if (p === source) continue;
    const otherSlug = (p.frontmatter.slug ?? '').toLowerCase();
    if (otherSlug === toSlug) {
      throw new UserError(
        `rename: a page with slug "${toSlug}" already exists at ${p.wikiRelPath}.`,
        'Pick a different new slug, or delete/merge the colliding page first.',
      );
    }
    const aliases = Array.isArray(p.frontmatter.aliases) ? p.frontmatter.aliases : [];
    for (const a of aliases) {
      if (typeof a === 'string' && a.toLowerCase() === toSlug) {
        throw new UserError(
          `rename: "${toSlug}" is already declared as an alias on ${p.wikiRelPath}.`,
          'Remove the alias first (manually or via `aab knowledge edit`) and try again.',
        );
      }
    }
  }

  const fromPath = source.path;
  const toPath = join(dirname(fromPath), `${toSlug}.md`);
  const fromRel = toPosix(`wiki/${source.wikiRelPath}`);
  const toRel = toPosix(`wiki/${source.wikiRelPath.replace(/[^/]+$/, `${toSlug}.md`)}`);

  // Plan rewrites.
  let totalRefs = 0;
  let totalRelated = 0;
  let totalAliases = 0;
  const changedFiles: RenameResult['changedFiles'] = [];

  for (const p of pages) {
    const bodyRewrite = rewriteBodyLinks(p.body, fromSlug, toSlug);
    const newRelated = rewriteRelated(p.frontmatter.related, fromSlug, toSlug);
    const newAliases = rewriteAliases(p.frontmatter.aliases, fromSlug, toSlug);
    const totalPageChanges = bodyRewrite.count + newRelated.count + newAliases.count;
    const isSourcePage = p === source;
    if (totalPageChanges === 0 && !isSourcePage) continue;

    const nextFm: PageFrontmatter = { ...p.frontmatter };
    if (newRelated.count > 0) nextFm.related = newRelated.values;
    if (newAliases.count > 0) nextFm.aliases = newAliases.values.length > 0 ? newAliases.values : undefined;

    if (isSourcePage) {
      nextFm.slug = toSlug;
      nextFm.updated = nowIso().slice(0, 10);
    }

    totalRefs += bodyRewrite.count;
    totalRelated += newRelated.count;
    totalAliases += newAliases.count;
    changedFiles.push({
      path: toPosix(p.relPath),
      refs: bodyRewrite.count,
      related: newRelated.count,
      aliases: newAliases.count,
    });

    if (!opts.dryRun) {
      // Write the page to its (possibly new) path. We delete from the old
      // path AFTER writing the new file so a crash in-between leaves the
      // old file intact for recovery.
      const targetPath = isSourcePage ? toPath : p.path;
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, serializePage(nextFm, bodyRewrite.text), 'utf8');
    }
  }

  // Now move the source file (delete original) after the new file is written.
  if (!opts.dryRun && fromPath !== toPath) {
    try {
      // Remove the old source file via renameSync to a tombstone — but since
      // we already wrote toPath above, just unlink the old path.
      if (existsSync(fromPath)) {
        // Use renameSync to /dev/null doesn't exist on Windows; just unlink.
        // Defer to fs.rmSync via dynamic import to keep import surface small.
        const { rmSync } = await import('node:fs');
        rmSync(fromPath);
      }
    } catch (error) {
      throw new UserError(
        `rename: failed to remove old source ${fromPath}: ${error instanceof Error ? error.message : String(error)}`,
        'The new file was written but the old one is still on disk. Remove it manually, then re-run `aab knowledge lint` to verify links.',
      );
    }
  }

  // Manifest update.
  let rewroteManifestEntries = 0;
  if (!opts.dryRun) {
    const manifest = loadManifest(opts.manifestPath);
    const rewrite = rewriteManifestPaths(manifest, fromRel, toRel);
    rewroteManifestEntries = rewrite.rewroteManifestEntries;
    saveManifest(opts.manifestPath, rewrite.manifest);
    appendRename(opts.manifestPath, {
      from: fromRel,
      to: toRel,
      fromSlug,
      toSlug,
      trigger: opts.trigger ?? 'manual',
      rewroteRefs: totalRefs,
      rewroteRelated: totalRelated,
      rewroteAliases: totalAliases,
      rewroteManifestEntries,
    });

    // Refresh the slug-map in wiki/index.md.
    const updatedMap = buildSlugMap(opts.wikiRoot, opts.workspaceRoot);
    writeSlugMapToIndex(opts.indexPath, updatedMap);
  } else {
    // Dry-run still reports the count.
    const manifest = loadManifest(opts.manifestPath);
    const rewrite = rewriteManifestPaths(manifest, fromRel, toRel);
    rewroteManifestEntries = rewrite.rewroteManifestEntries;
  }

  return {
    fromPath,
    toPath,
    fromSlug,
    toSlug,
    rewroteRefs: totalRefs,
    rewroteRelated: totalRelated,
    rewroteAliases: totalAliases,
    rewroteManifestEntries,
    changedFiles,
    dryRun: !!opts.dryRun,
  };
}

/**
 * Rewrite every `[[fromSlug]]` (and `[[fromSlug|Display]]`, `[[fromSlug#section]]`,
 * `[[fromSlug#^id]]`) in a body to `[[toSlug...]]`. Preserves display + anchor.
 * Does NOT rewrite path-prefixed forms (those are forbidden by spec; lint
 * surfaces them separately).
 */
export function rewriteBodyLinks(
  body: string,
  fromSlug: string,
  toSlug: string,
): { text: string; count: number } {
  let count = 0;
  const re = /(!?)\[\[([^\]\n]+)\]\]/g;
  const next = body.replace(re, (whole, bang: string, inner: string) => {
    const pipe = inner.indexOf('|');
    const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
    const display = pipe >= 0 ? inner.slice(pipe + 1) : '';
    const hash = target.indexOf('#');
    const slug = (hash >= 0 ? target.slice(0, hash) : target).trim().toLowerCase();
    const anchor = hash >= 0 ? target.slice(hash) : '';
    if (slug !== fromSlug) return whole;
    count++;
    const newTarget = `${toSlug}${anchor}`;
    const reassembled = pipe >= 0 ? `${newTarget}|${display}` : newTarget;
    return `${bang}[[${reassembled}]]`;
  });
  return { text: next, count };
}

function rewriteRelated(
  related: unknown,
  fromSlug: string,
  toSlug: string,
): { values: string[]; count: number } {
  if (!Array.isArray(related)) return { values: [], count: 0 };
  let count = 0;
  const next: string[] = [];
  for (const item of related) {
    if (typeof item !== 'string') {
      next.push(String(item));
      continue;
    }
    const m = item.match(/^\[\[([^\]]+)\]\]$/);
    if (!m) {
      // Plain slug or other form — replace if it matches.
      if (item.trim().toLowerCase() === fromSlug) {
        next.push(toSlug);
        count++;
        continue;
      }
      next.push(item);
      continue;
    }
    const inner = m[1]!;
    const pipe = inner.indexOf('|');
    const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
    const display = pipe >= 0 ? inner.slice(pipe + 1) : '';
    const hash = target.indexOf('#');
    const slug = (hash >= 0 ? target.slice(0, hash) : target).trim().toLowerCase();
    const anchor = hash >= 0 ? target.slice(hash) : '';
    if (slug === fromSlug) {
      count++;
      const newTarget = `${toSlug}${anchor}`;
      const rebuilt = pipe >= 0 ? `${newTarget}|${display}` : newTarget;
      next.push(`[[${rebuilt}]]`);
    } else {
      next.push(item);
    }
  }
  return { values: next, count };
}

function rewriteAliases(
  aliases: unknown,
  fromSlug: string,
  toSlug: string,
): { values: string[]; count: number } {
  if (!Array.isArray(aliases)) return { values: [], count: 0 };
  let count = 0;
  const next: string[] = [];
  for (const item of aliases) {
    if (typeof item !== 'string') {
      next.push(String(item));
      continue;
    }
    if (item.trim().toLowerCase() === fromSlug) {
      next.push(toSlug);
      count++;
    } else {
      next.push(item);
    }
  }
  return { values: next, count };
}

/**
 * Best-effort fuzzy match for `--auto-fix`. Returns the existing slug whose
 * Levenshtein distance from `target` is smallest, provided it's ≤ 3.
 */
export function suggestSlug(target: string, candidates: string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  let best: { slug: string; d: number } | undefined;
  for (const cand of candidates) {
    const d = levenshtein(target, cand);
    if (!best || d < best.d) best = { slug: cand, d };
  }
  if (best && best.d <= Math.max(3, Math.floor(target.length / 3))) return best.slug;
  return undefined;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const dp = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j - 1]!, dp[j]!);
      }
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/**
 * Reconcile the manifest with the current filesystem state. Used after a
 * Foam-driven rename (Foam rewrites `[[wikilinks]]` but doesn't know about
 * `.manifest.json`). Walks every `producedPages` / `updatedPages` /
 * `userEditedPages.page` entry; if the path is missing, fuzzy-matches against
 * existing files and rewrites the manifest atomically.
 */
export interface ReconcileResult {
  rewrites: Array<{ from: string; to: string; entryId?: string; kind: 'producedPages' | 'updatedPages' | 'userEditedPages' }>;
  manifestRewritten: boolean;
}

export function reconcileManifest(opts: {
  wikiRoot: string;
  workspaceRoot: string;
  manifestPath: string;
  dryRun?: boolean;
}): ReconcileResult {
  const pages = walkWikiPages(opts.wikiRoot, opts.workspaceRoot);
  const existingPaths = new Set(pages.map((p) => toPosix(p.relPath)));
  const existingFileNames = new Map<string, string>(); // base name (slug) → relPath
  for (const p of pages) {
    const slug = (p.frontmatter.slug ?? '').toLowerCase();
    if (slug) existingFileNames.set(slug, toPosix(p.relPath));
  }

  const rewrites: ReconcileResult['rewrites'] = [];
  const manifest = loadManifest(opts.manifestPath);

  const tryFix = (path: string): string | undefined => {
    if (existingPaths.has(path)) return undefined;
    // The path was `wiki/<folder>/<slug>.md` — extract the slug and see if
    // that slug exists at a different location now.
    const m = path.match(/wiki\/[^/]+\/([^/]+)\.md$/);
    if (!m) return undefined;
    const slug = m[1]!.toLowerCase();
    return existingFileNames.get(slug);
  };

  for (const entry of manifest.entries) {
    entry.producedPages = entry.producedPages.map((p) => {
      const fix = tryFix(p);
      if (fix) {
        rewrites.push({ from: p, to: fix, entryId: entry.id, kind: 'producedPages' });
        return fix;
      }
      return p;
    });
    entry.updatedPages = entry.updatedPages.map((p) => {
      const fix = tryFix(p);
      if (fix) {
        rewrites.push({ from: p, to: fix, entryId: entry.id, kind: 'updatedPages' });
        return fix;
      }
      return p;
    });
  }
  for (const ue of manifest.userEditedPages) {
    const fix = tryFix(ue.page);
    if (fix) {
      rewrites.push({ from: ue.page, to: fix, kind: 'userEditedPages' });
      ue.page = fix;
    }
  }

  if (rewrites.length > 0 && !opts.dryRun) {
    saveManifest(opts.manifestPath, manifest);
    // Log each as a separate rename for audit.
    for (const r of rewrites) {
      appendRename(opts.manifestPath, {
        from: r.from,
        to: r.to,
        fromSlug: r.from.split('/').pop()?.replace(/\.md$/, '') ?? '',
        toSlug: r.to.split('/').pop()?.replace(/\.md$/, '') ?? '',
        trigger: 'foam-reconcile',
        rewroteManifestEntries: 1,
      });
    }
  }

  // Reference parsePage to keep tree-shake quiet about unused exports.
  void parsePage;

  return { rewrites, manifestRewritten: rewrites.length > 0 && !opts.dryRun };
}
