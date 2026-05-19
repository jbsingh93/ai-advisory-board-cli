/**
 * `aab knowledge` — wiki management.
 *
 * Phase 1.5 surface (per `PLAN/KNOWLEDGE_WIKI.md` §17):
 *   - Chunk 1 (this file as of initial drop): rename, show, list, open, edit,
 *     stats, related, unresolved
 *   - Chunk 2/3: ingest <path|url> [--paste] [--force]
 *   - Chunk 5: backfill <discussion-id>
 *   - Chunk 6: query, lint, graph
 *   - Chunk 7: migrate
 */
import { Command } from 'commander';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, basename } from 'node:path';
import { closeContext, openContext } from './_context.js';
import { c, brand } from '../ui/colors.js';
import { UserError } from '../core/errors.js';
import { paths, ensureWikiDirs } from '../storage/paths.js';
import {
  walkWikiPages,
  parsePage,
  serializePage,
  extractWikiLinks,
  toPosix,
  type PageType,
  PAGE_TYPES,
  pathForPage,
  folderForType,
  type WikiPageEntry,
} from '../core/knowledge/page.js';
import {
  buildSlugMap,
  resolveSlug,
  parseSlugMap,
  writeSlugMapToIndex,
  extractBacklinksSection,
} from '../core/knowledge/slug-map.js';
import {
  renameSlug,
  reconcileManifest,
  suggestSlug,
} from '../core/knowledge/rename.js';
import { loadManifest, markUserEdited } from '../core/knowledge/manifest.js';
import { ingestFile, ingestPaste, ingestUrl, ingestDiscussionRaw } from '../core/knowledge/ingest.js';
import { queryWiki } from '../core/knowledge/query.js';
import { lintWiki } from '../core/knowledge/lint.js';
import { migrateBusinessContext } from '../core/knowledge/migrate.js';
import { nowIso } from '../core/utils.js';

export function registerKnowledgeCommand(program: Command): void {
  const k = program.command('knowledge').description('manage the Knowledge Wiki (Phase 1.5)');

  registerShow(k);
  registerList(k);
  registerOpen(k);
  registerEdit(k);
  registerStats(k);
  registerRename(k);
  registerRelated(k);
  registerUnresolved(k);
  registerIngest(k);
  registerQuery(k);
  registerLint(k);
  registerBackfill(k);
  registerMigrate(k);
  registerGraph(k);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function registerList(parent: Command): void {
  parent
    .command('list')
    .description('list all wiki pages, grouped by type')
    .option('--type <type>', `filter by type (${PAGE_TYPES.join('|')})`)
    .option('--orphans', 'only pages with zero incoming links')
    .option('--user-edited', 'only pages marked userEdited: true')
    .action(async (opts: { type?: string; orphans?: boolean; userEdited?: boolean }) => {
      const ctx = await openContext(parent, { lock: false });
      try {
        const p = paths(ctx.workspace.root);
        const pages = walkWikiPages(p.wiki, ctx.workspace.root);

        // Compute incoming-link graph if needed for --orphans.
        let inDegree: Map<string, number> | undefined;
        if (opts.orphans) {
          inDegree = new Map();
          for (const page of pages) {
            for (const link of extractWikiLinks(page.body)) {
              inDegree.set(link.slug, (inDegree.get(link.slug) ?? 0) + 1);
            }
          }
        }

        const filtered = pages.filter((page) => {
          if (opts.type && page.frontmatter.type !== opts.type) return false;
          if (opts.userEdited && page.frontmatter.userEdited !== true) return false;
          if (opts.orphans) {
            const slug = (page.frontmatter.slug ?? '').toLowerCase();
            if ((inDegree?.get(slug) ?? 0) > 0) return false;
          }
          return true;
        });

        if (ctx.json) {
          process.stdout.write(
            JSON.stringify(
              {
                pages: filtered.map((p) => ({
                  slug: p.frontmatter.slug,
                  title: p.frontmatter.title,
                  type: p.frontmatter.type,
                  summary: p.frontmatter.summary,
                  tags: p.frontmatter.tags ?? [],
                  path: p.wikiRelPath,
                  userEdited: p.frontmatter.userEdited ?? false,
                  updated: p.frontmatter.updated,
                })),
              },
              null,
              2,
            ) + '\n',
          );
          return;
        }

        process.stdout.write(`\n${brand()}  ${c.hint('· wiki pages')}\n\n`);
        if (filtered.length === 0) {
          process.stdout.write(c.hint('  (no pages matched — try `aab knowledge ingest <path>`)\n'));
          return;
        }
        const grouped = new Map<string, WikiPageEntry[]>();
        for (const page of filtered) {
          const type = String(page.frontmatter.type ?? 'unknown');
          if (!grouped.has(type)) grouped.set(type, []);
          grouped.get(type)!.push(page);
        }
        for (const [type, list] of Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b))) {
          process.stdout.write(`${c.bold(type)} ${c.hint(`(${list.length})`)}\n`);
          for (const p of list.sort((a, b) => (a.frontmatter.slug ?? '').localeCompare(b.frontmatter.slug ?? ''))) {
            const tag = p.frontmatter.userEdited ? c.warn(' [user-edited]') : '';
            const summary = p.frontmatter.summary ? c.hint(` — ${truncate(String(p.frontmatter.summary), 80)}`) : '';
            process.stdout.write(`  ${c.cyan(String(p.frontmatter.slug ?? '?'))}${tag}${summary}\n`);
          }
          process.stdout.write('\n');
        }
      } finally {
        await closeContext(ctx);
      }
    });
}

// ---------------------------------------------------------------------------
// show <slug>
// ---------------------------------------------------------------------------

function registerShow(parent: Command): void {
  parent
    .command('show <slug>')
    .description('pretty-print one wiki page (frontmatter + body + backlinks)')
    .action(async (slug: string) => {
      const ctx = await openContext(parent, { lock: false });
      try {
        const p = paths(ctx.workspace.root);
        const map = buildSlugMap(p.wiki, ctx.workspace.root);
        const entry = resolveSlug(map, slug);
        if (!entry) {
          throw new UserError(
            `No wiki page found for slug "${slug}".`,
            'Use `aab knowledge list` to see existing slugs.',
          );
        }
        const fullPath = join(p.wiki, entry.path);
        const raw = readFileSync(fullPath, 'utf8');
        const parsed = parsePage(raw);
        if (!parsed) {
          throw new UserError(`Page ${entry.path} has no parseable frontmatter.`);
        }

        if (ctx.json) {
          process.stdout.write(JSON.stringify({ ...parsed, slugMap: serializeMap(map), path: fullPath }, null, 2) + '\n');
          return;
        }

        // Header
        const title = String(parsed.frontmatter.title ?? entry.slug);
        process.stdout.write(`\n${c.bold(title)} ${c.hint(`(${entry.type})`)}\n`);
        process.stdout.write(c.hint(`  ${toPosix(relative(ctx.workspace.root, fullPath))}\n\n`));

        // Frontmatter summary
        const fm = parsed.frontmatter;
        if (fm.summary) process.stdout.write(`${c.bold('Summary:')} ${fm.summary}\n`);
        if (Array.isArray(fm.tags) && fm.tags.length > 0) {
          process.stdout.write(`${c.bold('Tags:')} ${fm.tags.join(', ')}\n`);
        }
        if (Array.isArray(fm.aliases) && fm.aliases.length > 0) {
          process.stdout.write(`${c.bold('Aliases:')} ${fm.aliases.join(', ')}\n`);
        }
        if (fm.confidence) process.stdout.write(`${c.bold('Confidence:')} ${fm.confidence}\n`);
        if (fm.provenance) process.stdout.write(`${c.bold('Provenance:')} ${fm.provenance}\n`);
        if (fm.updated) process.stdout.write(`${c.bold('Updated:')} ${fm.updated}\n`);
        if (Array.isArray(fm.sources) && fm.sources.length > 0) {
          process.stdout.write(`${c.bold('Sources:')}\n`);
          for (const s of fm.sources) process.stdout.write(`  - ${s}\n`);
        }
        process.stdout.write('\n');

        // Body with `[[slug]]` resolution pretty-print
        const pretty = parsed.body.replace(/(!?)\[\[([^\]\n]+)\]\]/g, (whole, bang: string, inner: string) => {
          if (bang === '!') return c.warn(`[[!${inner}]]`); // transclusion — unsupported
          const pipe = inner.indexOf('|');
          const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
          const display = pipe >= 0 ? inner.slice(pipe + 1).trim() : '';
          const hash = target.indexOf('#');
          const slugPart = (hash >= 0 ? target.slice(0, hash) : target).toLowerCase();
          const anchor = hash >= 0 ? target.slice(hash) : '';
          const resolved = resolveSlug(map, slugPart);
          if (!resolved) return c.err(`[[${inner}]] ⚠ unresolved`);
          const label = display || resolved.title || resolved.slug;
          return c.cyan(`${resolved.slug}${anchor}`) + c.hint(` ("${label}")`);
        });
        process.stdout.write(pretty);
        process.stdout.write('\n');
      } finally {
        await closeContext(ctx);
      }
    });
}

// ---------------------------------------------------------------------------
// open <slug>
// ---------------------------------------------------------------------------

function registerOpen(parent: Command): void {
  parent
    .command('open <slug>')
    .description('print absolute filesystem path of a wiki page (handy for piping into editors)')
    .action(async (slug: string) => {
      const ctx = await openContext(parent, { lock: false });
      try {
        const p = paths(ctx.workspace.root);
        const map = buildSlugMap(p.wiki, ctx.workspace.root);
        const entry = resolveSlug(map, slug);
        if (!entry) {
          throw new UserError(`No wiki page found for slug "${slug}".`);
        }
        process.stdout.write(join(p.wiki, entry.path) + '\n');
      } finally {
        await closeContext(ctx);
      }
    });
}

// ---------------------------------------------------------------------------
// edit <slug>
// ---------------------------------------------------------------------------

function registerEdit(parent: Command): void {
  parent
    .command('edit <slug>')
    .description('open a wiki page in $EDITOR and mark userEdited: true on save')
    .action(async (slug: string) => {
      const ctx = await openContext(parent);
      try {
        const p = paths(ctx.workspace.root);
        const map = buildSlugMap(p.wiki, ctx.workspace.root);
        const entry = resolveSlug(map, slug);
        if (!entry) throw new UserError(`No wiki page found for slug "${slug}".`);
        const fullPath = join(p.wiki, entry.path);

        const editor = process.env.EDITOR || process.env.VISUAL || (process.platform === 'win32' ? 'notepad' : 'vi');
        const before = readFileSync(fullPath, 'utf8');
        const result = spawnSync(editor, [fullPath], { stdio: 'inherit' });
        if (result.status !== 0) {
          throw new UserError(`Editor exited with code ${result.status}.`);
        }
        const after = readFileSync(fullPath, 'utf8');
        if (before === after) {
          process.stdout.write(c.hint('  (no changes)\n'));
          return;
        }
        // Re-parse and stamp userEdited + updated date.
        const parsed = parsePage(after);
        if (!parsed) throw new UserError('After edit, page has no parseable frontmatter — restore and try again.');
        const next = { ...parsed.frontmatter, userEdited: true, updated: nowIso().slice(0, 10) };
        writeFileSync(fullPath, serializePage(next, parsed.body), 'utf8');
        markUserEdited(p.manifest, toPosix(`wiki/${entry.path}`), 'aab knowledge edit');
        process.stdout.write(`${c.ok('✓')} marked ${c.bold(entry.slug)} as user-edited.\n`);
      } finally {
        await closeContext(ctx);
      }
    });
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

function registerStats(parent: Command): void {
  parent
    .command('stats')
    .description('show wiki size, page counts by type, ingest history')
    .action(async () => {
      const ctx = await openContext(parent, { lock: false });
      try {
        const p = paths(ctx.workspace.root);
        const pages = walkWikiPages(p.wiki, ctx.workspace.root);
        const manifest = loadManifest(p.manifest);
        const byType: Record<string, number> = {};
        let aliasCount = 0;
        for (const page of pages) {
          const type = String(page.frontmatter.type ?? 'unknown');
          byType[type] = (byType[type] ?? 0) + 1;
          if (Array.isArray(page.frontmatter.aliases)) aliasCount += page.frontmatter.aliases.length;
        }
        const totalCost = manifest.entries.reduce((sum, e) => sum + (e.ingestCostUsd ?? 0), 0);
        const lastIngest = manifest.entries[manifest.entries.length - 1]?.ingestedAt;

        if (ctx.json) {
          process.stdout.write(
            JSON.stringify(
              {
                pageCount: pages.length,
                byType,
                aliasCount,
                ingestCount: manifest.entries.length,
                renameCount: manifest.renames.length,
                userEditedCount: manifest.userEditedPages.length,
                totalIngestCostUsd: totalCost,
                lastIngestAt: lastIngest,
              },
              null,
              2,
            ) + '\n',
          );
          return;
        }
        process.stdout.write(`\n${brand()}  ${c.hint('· wiki stats')}\n\n`);
        process.stdout.write(`  ${c.bold('Pages:')}        ${pages.length}\n`);
        for (const [type, count] of Object.entries(byType).sort(([a], [b]) => a.localeCompare(b))) {
          process.stdout.write(`    ${type.padEnd(16)} ${count}\n`);
        }
        process.stdout.write(`  ${c.bold('Aliases:')}      ${aliasCount}\n`);
        process.stdout.write(`  ${c.bold('Ingests:')}      ${manifest.entries.length}\n`);
        process.stdout.write(`  ${c.bold('Renames:')}      ${manifest.renames.length}\n`);
        process.stdout.write(`  ${c.bold('User-edited:')}  ${manifest.userEditedPages.length}\n`);
        process.stdout.write(`  ${c.bold('Cost (USD):')}   ${totalCost.toFixed(4)}\n`);
        if (lastIngest) process.stdout.write(`  ${c.bold('Last ingest:')} ${lastIngest}\n`);
        process.stdout.write('\n');
      } finally {
        await closeContext(ctx);
      }
    });
}

// ---------------------------------------------------------------------------
// rename <old> <new>
// ---------------------------------------------------------------------------

function registerRename(parent: Command): void {
  parent
    .command('rename <oldSlug> [newSlug]')
    .description('atomically rename a slug across the wiki (file + body + related + aliases + manifest)')
    .option('--dry-run', 'print the diff without writing')
    .option('--auto-fix', 'fuzzy-match a broken slug to its likely new location and prompt')
    .option('--reconcile', 'align the manifest with the current filesystem (after Foam-driven moves)')
    .action(
      async (
        oldSlug: string,
        newSlug: string | undefined,
        opts: { dryRun?: boolean; autoFix?: boolean; reconcile?: boolean },
      ) => {
        const ctx = await openContext(parent);
        try {
          const p = paths(ctx.workspace.root);
          ensureWikiDirs(ctx.workspace.root);

          if (opts.reconcile) {
            const result = reconcileManifest({
              wikiRoot: p.wiki,
              workspaceRoot: ctx.workspace.root,
              manifestPath: p.manifest,
              dryRun: opts.dryRun,
            });
            if (ctx.json) {
              process.stdout.write(JSON.stringify(result, null, 2) + '\n');
              return;
            }
            if (result.rewrites.length === 0) {
              process.stdout.write(`${c.hint('—')} manifest is already aligned with the filesystem.\n`);
            } else {
              process.stdout.write(`${opts.dryRun ? c.warn('(dry-run) ') : c.ok('✓ ')}reconciled ${result.rewrites.length} manifest entr${result.rewrites.length === 1 ? 'y' : 'ies'}:\n`);
              for (const r of result.rewrites) {
                process.stdout.write(`  ${r.kind}: ${c.hint(r.from)} → ${c.bold(r.to)}\n`);
              }
            }
            return;
          }

          let resolvedTo = newSlug;
          if (opts.autoFix) {
            const map = buildSlugMap(p.wiki, ctx.workspace.root);
            const all = Array.from(map.canonical.keys());
            const suggestion = suggestSlug(oldSlug, all);
            if (!suggestion) {
              throw new UserError(
                `auto-fix: no plausible match for "${oldSlug}".`,
                'Pass the target slug explicitly: `aab knowledge rename <old> <new>`.',
              );
            }
            resolvedTo = suggestion;
            process.stdout.write(`${c.warn('auto-fix:')} matched ${c.bold(oldSlug)} → ${c.bold(resolvedTo)}\n`);
          }
          if (!resolvedTo) {
            throw new UserError('rename: <newSlug> is required (or pass --auto-fix or --reconcile).');
          }

          const result = await renameSlug({
            wikiRoot: p.wiki,
            manifestPath: p.manifest,
            indexPath: p.wikiIndex,
            workspaceRoot: ctx.workspace.root,
            fromSlug: oldSlug,
            toSlug: resolvedTo,
            dryRun: opts.dryRun,
            trigger: opts.autoFix ? 'lint-recommended' : 'manual',
          });

          if (ctx.json) {
            process.stdout.write(JSON.stringify(result, null, 2) + '\n');
            return;
          }

          const tag = result.dryRun ? c.warn('(dry-run) ') : c.ok('✓ ');
          process.stdout.write(
            `${tag}rename ${c.bold(result.fromSlug)} → ${c.bold(result.toSlug)}\n` +
              `  ${c.hint('file:')}     ${result.fromPath} → ${result.toPath}\n` +
              `  ${c.hint('refs:')}     ${result.rewroteRefs} body link${result.rewroteRefs === 1 ? '' : 's'} rewritten\n` +
              `  ${c.hint('related:')}  ${result.rewroteRelated} frontmatter entr${result.rewroteRelated === 1 ? 'y' : 'ies'}\n` +
              `  ${c.hint('aliases:')}  ${result.rewroteAliases}\n` +
              `  ${c.hint('manifest:')} ${result.rewroteManifestEntries} path${result.rewroteManifestEntries === 1 ? '' : 's'}\n`,
          );
          if (result.changedFiles.length > 0) {
            process.stdout.write(`  ${c.hint('files:')}\n`);
            for (const f of result.changedFiles) {
              process.stdout.write(`    ${c.cyan(f.path)} ${c.hint(`(refs:${f.refs} related:${f.related} aliases:${f.aliases})`)}\n`);
            }
          }
        } finally {
          await closeContext(ctx);
        }
      },
    );
}

// ---------------------------------------------------------------------------
// related <slug>
// ---------------------------------------------------------------------------

function registerRelated(parent: Command): void {
  parent
    .command('related <slug>')
    .description('walk the link neighborhood of a slug (outgoing + incoming)')
    .option('--depth <n>', 'how many hops to walk (1-5)', (v) => Number(v), 1)
    .option('--out <path>', 'save as a markdown report')
    .action(async (slug: string, opts: { depth: number; out?: string }) => {
      const ctx = await openContext(parent, { lock: false });
      try {
        const p = paths(ctx.workspace.root);
        const pages = walkWikiPages(p.wiki, ctx.workspace.root);
        const map = buildSlugMap(p.wiki, ctx.workspace.root);
        const startEntry = resolveSlug(map, slug);
        if (!startEntry) {
          throw new UserError(`No wiki page found for slug "${slug}".`);
        }
        const startSlug = startEntry.slug;
        const depth = Math.min(5, Math.max(1, Number.isFinite(opts.depth) ? opts.depth : 1));

        // Build graph
        const outgoing = new Map<string, Set<string>>();
        const incoming = new Map<string, Set<string>>();
        for (const page of pages) {
          const fromSlug = (page.frontmatter.slug ?? '').toLowerCase();
          if (!fromSlug) continue;
          for (const link of extractWikiLinks(page.body)) {
            const target = map.aliasToCanonical.get(link.slug);
            if (!target) continue;
            if (!outgoing.has(fromSlug)) outgoing.set(fromSlug, new Set());
            outgoing.get(fromSlug)!.add(target);
            if (!incoming.has(target)) incoming.set(target, new Set());
            incoming.get(target)!.add(fromSlug);
          }
        }

        // BFS to depth
        const visited = new Map<string, number>([[startSlug, 0]]);
        const queue: string[] = [startSlug];
        while (queue.length > 0) {
          const node = queue.shift()!;
          const d = visited.get(node)!;
          if (d >= depth) continue;
          const neighbors = new Set([...(outgoing.get(node) ?? []), ...(incoming.get(node) ?? [])]);
          for (const n of neighbors) {
            if (!visited.has(n)) {
              visited.set(n, d + 1);
              queue.push(n);
            }
          }
        }

        const report: string[] = [];
        report.push(`# Related: ${startSlug}`);
        report.push('');
        report.push(`_Depth ${depth} · ${visited.size - 1} neighbor${visited.size === 2 ? '' : 's'}_`);
        report.push('');
        const grouped = new Map<number, string[]>();
        for (const [s, d] of visited.entries()) {
          if (d === 0) continue;
          if (!grouped.has(d)) grouped.set(d, []);
          grouped.get(d)!.push(s);
        }
        for (const [d, list] of Array.from(grouped.entries()).sort(([a], [b]) => a - b)) {
          report.push(`## Hop ${d}`);
          for (const s of list.sort()) {
            const e = map.canonical.get(s);
            report.push(`- \`[[${s}]]\`${e?.title ? ` — ${e.title}` : ''}${e?.summary ? ` — ${truncate(e.summary, 80)}` : ''}`);
          }
          report.push('');
        }

        const rendered = report.join('\n');
        if (opts.out) {
          mkdirSync(dirname(resolve(opts.out)), { recursive: true });
          writeFileSync(resolve(opts.out), rendered, 'utf8');
          process.stdout.write(`${c.ok('✓')} wrote ${c.bold(resolve(opts.out))}\n`);
        } else if (ctx.json) {
          const neighbors = Array.from(visited.entries())
            .filter(([s]) => s !== startSlug)
            .map(([s, d]) => ({ slug: s, hop: d }));
          process.stdout.write(JSON.stringify({ start: startSlug, depth, neighbors }, null, 2) + '\n');
        } else {
          process.stdout.write(rendered + '\n');
        }
      } finally {
        await closeContext(ctx);
      }
    });
}

// ---------------------------------------------------------------------------
// unresolved
// ---------------------------------------------------------------------------

function registerUnresolved(parent: Command): void {
  parent
    .command('unresolved')
    .description('list every [[wikilink]] whose target slug does not exist')
    .option('--suggest-fixes', 'fuzzy-match each unresolved slug against existing slugs')
    .action(async (opts: { suggestFixes?: boolean }) => {
      const ctx = await openContext(parent, { lock: false });
      try {
        const p = paths(ctx.workspace.root);
        const pages = walkWikiPages(p.wiki, ctx.workspace.root);
        const map = buildSlugMap(p.wiki, ctx.workspace.root);
        const knownSlugs = Array.from(new Set([
          ...Array.from(map.canonical.keys()),
          ...Array.from(map.aliasToCanonical.keys()),
        ]));

        interface UnresolvedRef {
          slug: string;
          refs: Array<{ file: string; line: number }>;
          suggestion?: string;
        }
        const unresolvedBySlug = new Map<string, UnresolvedRef>();

        for (const page of pages) {
          const lines = page.body.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? '';
            const re = /(!?)\[\[([^\]\n]+)\]\]/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(line)) !== null) {
              if (m[1] === '!') continue; // transclusion — separate lint warning
              const inner = (m[2] ?? '').trim();
              const pipe = inner.indexOf('|');
              const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
              const hash = target.indexOf('#');
              const slugOnly = (hash >= 0 ? target.slice(0, hash) : target).trim().toLowerCase();
              if (!slugOnly) continue;
              if (map.aliasToCanonical.has(slugOnly)) continue;
              const existing = unresolvedBySlug.get(slugOnly) ?? { slug: slugOnly, refs: [] };
              existing.refs.push({ file: page.wikiRelPath, line: i + 1 });
              unresolvedBySlug.set(slugOnly, existing);
            }
          }
        }

        if (opts.suggestFixes) {
          for (const u of unresolvedBySlug.values()) {
            u.suggestion = suggestSlug(u.slug, knownSlugs);
          }
        }

        const list = Array.from(unresolvedBySlug.values()).sort((a, b) => a.slug.localeCompare(b.slug));
        if (ctx.json) {
          process.stdout.write(JSON.stringify({ unresolved: list }, null, 2) + '\n');
          return;
        }
        if (list.length === 0) {
          process.stdout.write(`${c.ok('✓')} no unresolved [[wikilinks]].\n`);
          return;
        }
        process.stdout.write(`\n${brand()}  ${c.hint('· unresolved wiki-links')}\n\n`);
        for (const u of list) {
          process.stdout.write(`${c.err('[[')}${c.bold(u.slug)}${c.err(']]')}\n`);
          for (const r of u.refs) {
            process.stdout.write(`  ${c.hint(`${r.file}:${r.line}`)}\n`);
          }
          if (u.suggestion) {
            process.stdout.write(`  ${c.warn('→ suggestion:')} ${c.cyan(u.suggestion)}\n`);
          }
        }
        process.stdout.write('\n');
      } finally {
        await closeContext(ctx);
      }
    });
}

// ---------------------------------------------------------------------------
// ingest <path-or-url>
// ---------------------------------------------------------------------------

function registerIngest(parent: Command): void {
  parent
    .command('ingest [pathOrUrl]')
    .description('ingest a file, URL, or raw text into the wiki')
    .option('--paste', 'read raw markdown from stdin')
    .option('--discussion <id>', 're-ingest (or initial ingest if it skipped) a discussion')
    .option('--type <type>', `hint to the agent (${PAGE_TYPES.join('|')})`)
    .option('--model <alias>', 'override the ingest model (default: fastModel)')
    .option('--force', 're-ingest even if hash already in manifest')
    .action(
      async (
        pathOrUrl: string | undefined,
        opts: { paste?: boolean; discussion?: string; type?: string; model?: string; force?: boolean },
      ) => {
        const ctx = await openContext(parent);
        try {
          const settings = await ctx.storage.loadSettings();
          if (opts.paste) {
            const stdin = await readStdin();
            if (!stdin.trim()) throw new UserError('ingest --paste: stdin is empty.');
            const result = await ingestPaste({
              text: stdin,
              workspace: ctx.workspace,
              settings,
              force: opts.force,
              hintType: opts.type as PageType | undefined,
              modelOverride: opts.model,
            });
            renderIngestResult(ctx.json, result);
            return;
          }
          if (opts.discussion) {
            const disc = await ctx.storage.loadDiscussionById(opts.discussion);
            if (!disc) throw new UserError(`No discussion found with id "${opts.discussion}".`);
            const result = await ingestDiscussionRaw({
              discussion: disc,
              workspace: ctx.workspace,
              settings,
              force: opts.force,
              storage: ctx.storage,
              modelOverride: opts.model,
            });
            renderIngestResult(ctx.json, result);
            return;
          }
          if (!pathOrUrl) {
            throw new UserError('ingest: provide a path, URL, --paste, or --discussion <id>.');
          }
          if (/^https?:\/\//i.test(pathOrUrl)) {
            const result = await ingestUrl({
              url: pathOrUrl,
              workspace: ctx.workspace,
              settings,
              force: opts.force,
              hintType: opts.type as PageType | undefined,
              modelOverride: opts.model,
            });
            renderIngestResult(ctx.json, result);
            return;
          }
          const result = await ingestFile({
            path: resolve(pathOrUrl),
            workspace: ctx.workspace,
            settings,
            force: opts.force,
            hintType: opts.type as PageType | undefined,
            modelOverride: opts.model,
          });
          renderIngestResult(ctx.json, result);
        } finally {
          await closeContext(ctx);
        }
      },
    );
}

// ---------------------------------------------------------------------------
// query "<question>"
// ---------------------------------------------------------------------------

function registerQuery(parent: Command): void {
  parent
    .command('query <question>')
    .description('ask the wiki a question (read-only, citing pages)')
    .option('--max-pages <n>', 'cap pages opened (default 10)', (v) => Number(v))
    .option('--model <alias>', 'override the query model (default: queryModel)')
    .option('--out <path>', 'save the answer to a markdown file')
    .option('--save-as <type>', 'file the answer back into the wiki as a new page')
    .action(
      async (
        question: string,
        opts: { maxPages?: number; model?: string; out?: string; saveAs?: string },
      ) => {
        const ctx = await openContext(parent);
        try {
          const settings = await ctx.storage.loadSettings();
          const result = await queryWiki({
            question,
            workspace: ctx.workspace,
            settings,
            maxPages: opts.maxPages,
            modelOverride: opts.model,
            saveAs: opts.saveAs as PageType | undefined,
          });
          if (opts.out) {
            mkdirSync(dirname(resolve(opts.out)), { recursive: true });
            writeFileSync(resolve(opts.out), result.answer, 'utf8');
            process.stdout.write(`${c.ok('✓')} wrote ${c.bold(resolve(opts.out))}\n`);
          }
          if (ctx.json) {
            process.stdout.write(JSON.stringify(result, null, 2) + '\n');
            return;
          }
          process.stdout.write(`\n${c.bold('Answer:')}\n\n${result.answer}\n\n`);
          if (result.citations.length > 0) {
            process.stdout.write(c.bold('Citations:\n'));
            for (const slug of result.citations) {
              process.stdout.write(`  - [[${slug}]]\n`);
            }
            process.stdout.write('\n');
          }
          process.stdout.write(c.hint(`  cost: ${result.costUsd.toFixed(4)} USD\n`));
        } finally {
          await closeContext(ctx);
        }
      },
    );
}

// ---------------------------------------------------------------------------
// lint [--write]
// ---------------------------------------------------------------------------

function registerLint(parent: Command): void {
  parent
    .command('lint')
    .description('run health checks on the wiki; rebuild slug-map + per-page backlinks')
    .option('--no-write', 'skip writing outputs/lint-<date>.md')
    .option('--no-llm', 'skip the LLM passes (contradiction / stale / missing concept)')
    .option('--max-pages <n>', 'cap LLM-pass pages (cost control)', (v) => Number(v))
    .action(async (opts: { write?: boolean; llm?: boolean; maxPages?: number }) => {
      const ctx = await openContext(parent);
      try {
        const settings = await ctx.storage.loadSettings();
        const result = await lintWiki({
          workspace: ctx.workspace,
          settings,
          writeReport: opts.write !== false,
          runLlm: opts.llm !== false,
          maxPages: opts.maxPages,
        });
        if (ctx.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
        const errs = result.findings.filter((f) => f.severity === 'error').length;
        const warns = result.findings.filter((f) => f.severity === 'warn').length;
        const infos = result.findings.filter((f) => f.severity === 'info').length;
        process.stdout.write(`\n${brand()}  ${c.hint('· lint')}\n\n`);
        process.stdout.write(`  ${c.err('errors:')}  ${errs}\n`);
        process.stdout.write(`  ${c.warn('warns:')}   ${warns}\n`);
        process.stdout.write(`  ${c.hint('infos:')}   ${infos}\n`);
        if (result.reportPath) {
          process.stdout.write(`\n  report: ${c.bold(result.reportPath)}\n`);
        }
        if (errs > 0) process.exitCode = 1;
      } finally {
        await closeContext(ctx);
      }
    });
}

// ---------------------------------------------------------------------------
// backfill <discussion-id>
// ---------------------------------------------------------------------------

function registerBackfill(parent: Command): void {
  parent
    .command('backfill <discussionId>')
    .description('manually run the auto-ingest hook for one past discussion')
    .option('--force', 're-ingest even if hash already in manifest')
    .option('--model <alias>', 'override the ingest model')
    .action(async (discussionId: string, opts: { force?: boolean; model?: string }) => {
      const ctx = await openContext(parent);
      try {
        const settings = await ctx.storage.loadSettings();
        const disc = await ctx.storage.loadDiscussionById(discussionId);
        if (!disc) {
          // Try short prefix
          const all = await ctx.storage.loadDiscussions();
          const matches = all.filter((d) => d.id.startsWith(discussionId));
          if (matches.length === 0) throw new UserError(`No discussion found with id starting "${discussionId}".`);
          if (matches.length > 1) throw new UserError(`Multiple discussions match "${discussionId}". Use a longer prefix.`);
          const result = await ingestDiscussionRaw({
            discussion: matches[0]!,
            workspace: ctx.workspace,
            settings,
            force: opts.force,
            storage: ctx.storage,
            modelOverride: opts.model,
          });
          renderIngestResult(ctx.json, result);
          return;
        }
        const result = await ingestDiscussionRaw({
          discussion: disc,
          workspace: ctx.workspace,
          settings,
          force: opts.force,
          storage: ctx.storage,
          modelOverride: opts.model,
        });
        renderIngestResult(ctx.json, result);
      } finally {
        await closeContext(ctx);
      }
    });
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

function registerMigrate(parent: Command): void {
  parent
    .command('migrate')
    .description('convert BusinessContext / BusinessProfile JSON into wiki pages')
    .option('--dry-run', 'show what would be written, do not write')
    .option('--force-schema', 'overwrite wiki/KNOWLEDGE.md')
    .action(async (opts: { dryRun?: boolean; forceSchema?: boolean }) => {
      const ctx = await openContext(parent);
      try {
        const result = await migrateBusinessContext({
          workspace: ctx.workspace,
          storage: ctx.storage,
          dryRun: !!opts.dryRun,
          forceSchema: !!opts.forceSchema,
        });
        if (ctx.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
        const tag = result.dryRun ? c.warn('(dry-run) ') : c.ok('✓ ');
        process.stdout.write(`${tag}migrate complete: ${result.producedPages.length} produced, ${result.skipped.length} skipped\n`);
        for (const p of result.producedPages) process.stdout.write(`  + ${c.cyan(p)}\n`);
        for (const s of result.skipped) process.stdout.write(`  ${c.hint('—')} ${s}\n`);
        if (result.backupPath) process.stdout.write(`  ${c.hint('backup:')} ${result.backupPath}\n`);
      } finally {
        await closeContext(ctx);
      }
    });
}

// ---------------------------------------------------------------------------
// graph
// ---------------------------------------------------------------------------

function registerGraph(parent: Command): void {
  parent
    .command('graph')
    .description('print the wiki link graph in DOT format')
    .option('--out <path>', 'save to file')
    .action(async (opts: { out?: string }) => {
      const ctx = await openContext(parent, { lock: false });
      try {
        const p = paths(ctx.workspace.root);
        const pages = walkWikiPages(p.wiki, ctx.workspace.root);
        const map = buildSlugMap(p.wiki, ctx.workspace.root);
        const lines: string[] = ['digraph wiki {', '  rankdir=LR;', '  node [shape=box, style=rounded];'];
        for (const page of pages) {
          const slug = (page.frontmatter.slug ?? '').toLowerCase();
          if (!slug) continue;
          const type = String(page.frontmatter.type ?? '');
          lines.push(`  "${slug}" [label="${slug}\\n(${type})"];`);
          for (const link of extractWikiLinks(page.body)) {
            const target = map.aliasToCanonical.get(link.slug);
            if (target && target !== slug) {
              lines.push(`  "${slug}" -> "${target}";`);
            }
          }
        }
        lines.push('}');
        const dot = lines.join('\n') + '\n';
        if (opts.out) {
          mkdirSync(dirname(resolve(opts.out)), { recursive: true });
          writeFileSync(resolve(opts.out), dot, 'utf8');
          process.stdout.write(`${c.ok('✓')} wrote ${c.bold(resolve(opts.out))}\n`);
        } else if (ctx.json) {
          const nodes = pages.map((p) => ({
            slug: p.frontmatter.slug,
            type: p.frontmatter.type,
            title: p.frontmatter.title,
          }));
          const edges: Array<{ from: string; to: string }> = [];
          for (const page of pages) {
            const fromSlug = (page.frontmatter.slug ?? '').toLowerCase();
            for (const link of extractWikiLinks(page.body)) {
              const target = map.aliasToCanonical.get(link.slug);
              if (target && target !== fromSlug) edges.push({ from: fromSlug, to: target });
            }
          }
          process.stdout.write(JSON.stringify({ nodes, edges }, null, 2) + '\n');
        } else {
          process.stdout.write(dot);
        }
      } finally {
        await closeContext(ctx);
      }
    });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function serializeMap(map: ReturnType<typeof buildSlugMap>) {
  return {
    canonical: Object.fromEntries(map.canonical),
    aliasToCanonical: Object.fromEntries(map.aliasToCanonical),
  };
}

interface IngestRenderShape {
  producedPages: string[];
  updatedPages: string[];
  skipped: string[];
  rawPath?: string;
  costUsd?: number;
  notes?: string;
  alreadyIngested?: boolean;
  warning?: string;
}

function renderIngestResult(json: boolean, result: IngestRenderShape) {
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (result.alreadyIngested) {
    process.stdout.write(`${c.hint('—')} already ingested (hash hit in manifest). Re-run with --force.\n`);
    if (result.rawPath) process.stdout.write(c.hint(`  source: ${result.rawPath}\n`));
    return;
  }
  process.stdout.write(`${c.ok('✓')} ingest complete\n`);
  if (result.rawPath) process.stdout.write(c.hint(`  source: ${result.rawPath}\n`));
  for (const p of result.producedPages) process.stdout.write(`  ${c.ok('+')} ${c.cyan(p)} ${c.hint('(created)')}\n`);
  for (const p of result.updatedPages) process.stdout.write(`  ${c.warn('~')} ${c.cyan(p)} ${c.hint('(updated)')}\n`);
  for (const p of result.skipped) process.stdout.write(`  ${c.hint('—')} ${p} ${c.hint('(skipped — userEdited)')}\n`);
  if (result.notes) process.stdout.write(c.hint(`  notes: ${result.notes}\n`));
  if (result.costUsd != null) process.stdout.write(c.hint(`  cost:  ${result.costUsd.toFixed(4)} USD\n`));
  if (result.warning) process.stdout.write(`${c.warn('!')} ${result.warning}\n`);
}

function readStdin(): Promise<string> {
  return new Promise((resolveFn, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => resolveFn(data));
    process.stdin.on('error', reject);
  });
}

// Reference unused imports to keep TS happy until later chunks land.
void basename;
void extractBacklinksSection;
void parseSlugMap;
void writeSlugMapToIndex;
void folderForType;
void pathForPage;
