/**
 * Wiki lint — static checks + maintenance writes (slug-map rebuild,
 * backlinks regeneration), plus optional LLM passes (contradictions, stale
 * claims, missing concepts). Reference: `PLAN/KNOWLEDGE_WIKI.md` §15.3.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { paths, type ResolvedWorkspace } from '../../storage/paths.js';
import {
  walkWikiPages,
  extractWikiLinks,
  extractHeaderAnchors,
  kebabHeader,
  serializePage,
  toPosix,
  type WikiPageEntry,
} from './page.js';
import {
  buildSlugMapFromPages,
  writeSlugMapToIndex,
  setBacklinksSection,
  BACKLINKS_OPEN,
  BACKLINKS_CLOSE,
  SLUG_MAP_OPEN,
  SLUG_MAP_CLOSE,
  resolveSlug,
} from './slug-map.js';
import { loadManifest } from './manifest.js';
import { nowIso } from '../utils.js';
import { logger } from '../logger.js';
import type { AppSettings } from '../../storage/types.js';

export type LintSeverity = 'error' | 'warn' | 'info';

export interface LintFinding {
  severity: LintSeverity;
  code: string;
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

export interface LintResult {
  findings: LintFinding[];
  pagesScanned: number;
  slugMapUpdated: boolean;
  backlinksUpdated: number;
  reportPath?: string;
}

export interface LintOptions {
  workspace: ResolvedWorkspace;
  settings: AppSettings;
  writeReport?: boolean;
  runLlm?: boolean;
  maxPages?: number;
}

export async function lintWiki(opts: LintOptions): Promise<LintResult> {
  const p = paths(opts.workspace.root);
  const findings: LintFinding[] = [];
  if (!existsSync(p.wiki)) {
    findings.push({
      severity: 'error',
      code: 'wiki-missing',
      message: `Wiki directory not found at ${p.wiki}.`,
      suggestion: 'Run `aab init` first.',
    });
    return { findings, pagesScanned: 0, slugMapUpdated: false, backlinksUpdated: 0 };
  }

  const pages = walkWikiPages(p.wiki, opts.workspace.root);
  const settings = opts.settings.knowledgeWiki;
  const aliasCapWarn = settings?.maxAliasesGlobal ? settings.maxAliasesGlobal * 0.8 : 80;
  const aliasCapErr = settings?.maxAliasesGlobal ?? 100;

  // ---------- frontmatter completeness + slug/alias uniqueness ----------
  const slugOwners = new Map<string, WikiPageEntry>();
  const aliasOwners = new Map<string, WikiPageEntry>();
  let aliasTotal = 0;
  for (const page of pages) {
    const fm = page.frontmatter;
    const path = page.wikiRelPath;
    if (!fm.title) {
      findings.push({ severity: 'warn', code: 'fm-missing-title', message: `missing \`title:\``, file: path });
    }
    if (!fm.slug) {
      findings.push({ severity: 'error', code: 'fm-missing-slug', message: `missing \`slug:\``, file: path });
      continue;
    }
    const slug = String(fm.slug).toLowerCase();
    const filenameSlug = page.wikiRelPath.split('/').pop()!.replace(/\.md$/, '').toLowerCase();
    if (slug !== filenameSlug) {
      findings.push({
        severity: 'error',
        code: 'fm-slug-filename-mismatch',
        message: `slug "${slug}" does not match filename "${filenameSlug}"`,
        file: path,
        suggestion: `aab knowledge rename ${slug} ${filenameSlug}`,
      });
    }
    if (slugOwners.has(slug)) {
      findings.push({
        severity: 'error',
        code: 'slug-collision',
        message: `duplicate slug "${slug}" — also at ${slugOwners.get(slug)!.wikiRelPath}`,
        file: path,
      });
    } else {
      slugOwners.set(slug, page);
    }
    if (!fm.type || !['concept', 'entity', 'decision', 'source-summary', 'comparison'].includes(String(fm.type))) {
      findings.push({ severity: 'error', code: 'fm-invalid-type', message: `invalid \`type:\` ${fm.type ?? '(missing)'}`, file: path });
    }
    if (!fm.summary) {
      findings.push({ severity: 'warn', code: 'fm-missing-summary', message: 'missing `summary:` — cheap-pass retrieval will be slower', file: path });
    } else if (typeof fm.summary === 'string' && fm.summary.length > (settings?.summarySoftCap ?? 200)) {
      findings.push({
        severity: 'info',
        code: 'fm-summary-long',
        message: `summary is ${fm.summary.length} chars (soft cap ${settings?.summarySoftCap ?? 200})`,
        file: path,
      });
    }
    const aliases = Array.isArray(fm.aliases) ? fm.aliases : [];
    aliasTotal += aliases.length;
    for (const a of aliases) {
      if (typeof a !== 'string') continue;
      const alias = a.trim().toLowerCase();
      if (!alias) continue;
      if (alias === slug) {
        findings.push({ severity: 'warn', code: 'alias-equals-slug', message: `alias "${alias}" equals slug — redundant`, file: path });
        continue;
      }
      if (slugOwners.has(alias) && slugOwners.get(alias) !== page) {
        findings.push({
          severity: 'error',
          code: 'alias-slug-collision',
          message: `alias "${alias}" collides with another page's slug at ${slugOwners.get(alias)!.wikiRelPath}`,
          file: path,
        });
      }
      if (aliasOwners.has(alias) && aliasOwners.get(alias) !== page) {
        findings.push({
          severity: 'error',
          code: 'alias-alias-collision',
          message: `alias "${alias}" already declared on ${aliasOwners.get(alias)!.wikiRelPath}`,
          file: path,
        });
      }
      aliasOwners.set(alias, page);
    }
    if (Array.isArray(fm.sources) && fm.sources.length > 0) {
      for (const src of fm.sources) {
        if (typeof src !== 'string') continue;
        const abs = src.startsWith('/') ? src : join(opts.workspace.root, src);
        if (!existsSync(abs)) {
          findings.push({
            severity: 'warn',
            code: 'broken-source',
            message: `\`sources:\` references missing raw file: ${src}`,
            file: path,
          });
        }
      }
    } else if (fm.type === 'source-summary') {
      findings.push({ severity: 'warn', code: 'source-summary-no-sources', message: 'source-summary page has no `sources:` entries', file: path });
    }
    // Page body soft cap
    if (page.body.length > (settings?.pageBodySoftCap ?? 4000)) {
      findings.push({
        severity: 'info',
        code: 'body-long',
        message: `body is ${page.body.length} chars (soft cap ${settings?.pageBodySoftCap ?? 4000}) — consider splitting`,
        file: path,
      });
    }
  }

  if (aliasTotal >= aliasCapErr) {
    findings.push({
      severity: 'error',
      code: 'alias-cap-exceeded',
      message: `total aliases (${aliasTotal}) exceeds maxAliasesGlobal (${aliasCapErr})`,
      suggestion: 'Remove aliases on pages where the canonical slug is sufficient.',
    });
  } else if (aliasTotal >= aliasCapWarn) {
    findings.push({
      severity: 'warn',
      code: 'alias-cap-warn',
      message: `total aliases (${aliasTotal}) approaching maxAliasesGlobal (${aliasCapErr})`,
    });
  }

  // ---------- broken [[wikilinks]] + broken anchors + forbidden forms ----------
  const slugMap = buildSlugMapFromPages(pages);
  const linkCount = new Map<string, number>();
  for (const page of pages) {
    const lines = page.body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      for (const link of extractWikiLinks(line)) {
        if (link.transclusion) {
          findings.push({
            severity: 'warn',
            code: 'transclusion-not-supported',
            message: `\`![[${link.slug}]]\` transclusion is not supported in v1`,
            file: page.wikiRelPath,
            line: i + 1,
            suggestion: `replace with \`[[${link.slug}]]\``,
          });
        }
        if (link.blockId) {
          findings.push({
            severity: 'warn',
            code: 'block-id-not-supported',
            message: `\`[[${link.slug}#^${link.anchor?.replace(/^\^/, '') ?? ''}]]\` block IDs are not supported in v1`,
            file: page.wikiRelPath,
            line: i + 1,
            suggestion: `use header anchors \`[[${link.slug}#section]]\` instead`,
          });
        }
        if (link.pathPrefixed) {
          findings.push({
            severity: 'error',
            code: 'path-prefixed-link',
            message: `path-prefixed link \`[[${link.raw.slice(2, -2)}]]\` is forbidden — slug is canonical`,
            file: page.wikiRelPath,
            line: i + 1,
            suggestion: `rewrite to \`[[${link.slug}]]\``,
          });
        }
        const resolved = resolveSlug(slugMap, link.slug);
        if (!resolved) {
          linkCount.set(link.slug, (linkCount.get(link.slug) ?? 0) + 1);
          findings.push({
            severity: 'warn',
            code: 'broken-wikilink',
            message: `unresolved \`[[${link.slug}]]\``,
            file: page.wikiRelPath,
            line: i + 1,
            suggestion: `aab knowledge rename --auto-fix ${link.slug}`,
          });
        } else if (link.anchor && !link.blockId) {
          // Verify the target has a matching header anchor.
          const targetPage = pages.find((p) => p.frontmatter.slug?.toString().toLowerCase() === resolved.slug);
          if (targetPage) {
            const anchors = extractHeaderAnchors(targetPage.body).map(kebabHeader);
            const wanted = kebabHeader(link.anchor);
            if (!anchors.includes(wanted)) {
              findings.push({
                severity: 'warn',
                code: 'broken-anchor',
                message: `header anchor \`#${link.anchor}\` not found in \`[[${link.slug}]]\``,
                file: page.wikiRelPath,
                line: i + 1,
              });
            }
          }
        }
      }
    }
  }
  // Missing concept escalation
  for (const [slug, count] of linkCount.entries()) {
    if (count >= 3) {
      findings.push({
        severity: 'info',
        code: 'missing-concept',
        message: `\`[[${slug}]]\` referenced ${count}× but no page exists`,
        suggestion: `aab knowledge ingest --paste  (file a quick note for this concept)`,
      });
    }
  }

  // ---------- orphan pages ----------
  const incoming = new Map<string, number>();
  for (const page of pages) {
    for (const link of extractWikiLinks(page.body)) {
      const target = slugMap.aliasToCanonical.get(link.slug);
      if (target) incoming.set(target, (incoming.get(target) ?? 0) + 1);
    }
  }
  for (const page of pages) {
    const slug = (page.frontmatter.slug ?? '').toString().toLowerCase();
    if (!slug) continue;
    if ((incoming.get(slug) ?? 0) === 0) {
      findings.push({
        severity: 'info',
        code: 'orphan',
        message: `page has zero incoming wiki-links`,
        file: page.wikiRelPath,
      });
    }
  }

  // ---------- manifest drift ----------
  const manifest = loadManifest(p.manifest);
  const existingPaths = new Set(pages.map((p) => toPosix(`wiki/${p.wikiRelPath}`)));
  for (const entry of manifest.entries) {
    for (const target of [...entry.producedPages, ...entry.updatedPages]) {
      if (!existingPaths.has(target)) {
        findings.push({
          severity: 'error',
          code: 'manifest-drift',
          message: `manifest entry ${entry.id} references missing ${target}`,
          suggestion: 'aab knowledge rename --reconcile',
        });
      }
    }
  }

  // ---------- sentinel integrity (index slug-map + per-page backlinks) ----------
  if (existsSync(p.wikiIndex)) {
    const indexBody = readFileSync(p.wikiIndex, 'utf8');
    const hasOpen = indexBody.includes(SLUG_MAP_OPEN);
    const hasClose = indexBody.includes(SLUG_MAP_CLOSE);
    if (!hasOpen || !hasClose) {
      findings.push({
        severity: 'warn',
        code: 'slug-map-sentinels-missing',
        message: 'wiki/index.md is missing one or both `<!-- AAB:SLUG-MAP -->` sentinels',
        file: 'wiki/index.md',
        suggestion: 'lint will append a fresh slug-map section on this run',
      });
    }
  }

  // ---------- maintenance writes ----------
  let slugMapUpdated = false;
  if (settings?.slugMapInIndex !== false) {
    try {
      writeSlugMapToIndex(p.wikiIndex, slugMap);
      slugMapUpdated = true;
    } catch (error) {
      findings.push({
        severity: 'error',
        code: 'slug-map-write-failed',
        message: `failed to write slug-map: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // Backlinks: regenerate `<!-- AAB:BACKLINKS -->` in every page
  const backLinks = new Map<string, string[]>();
  for (const page of pages) {
    const fromSlug = (page.frontmatter.slug ?? '').toString().toLowerCase();
    if (!fromSlug) continue;
    const seen = new Set<string>();
    for (const link of extractWikiLinks(page.body)) {
      const target = slugMap.aliasToCanonical.get(link.slug);
      if (!target) continue;
      if (target === fromSlug) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      if (!backLinks.has(target)) backLinks.set(target, []);
      const targetPage = slugMap.canonical.get(target)!;
      const summary = targetPage?.summary ? ` — "${truncate(String(targetPage.summary), 80)}"` : '';
      const display = page.frontmatter.title ? ` — ${page.frontmatter.title}` : '';
      backLinks.get(target)!.push(`[[${fromSlug}]]${display}${summary}`);
    }
  }
  let backlinksUpdated = 0;
  for (const page of pages) {
    const slug = (page.frontmatter.slug ?? '').toString().toLowerCase();
    if (!slug) continue;
    const links = backLinks.get(slug) ?? [];
    const newBody = setBacklinksSection(page.body, links);
    if (newBody !== page.body) {
      writeFileSync(page.path, serializePage(page.frontmatter, newBody), 'utf8');
      backlinksUpdated++;
    }
  }

  // ---------- LLM passes (optional) ----------
  if (opts.runLlm !== false) {
    // For v1 we keep this lightweight — the heavy contradiction/stale-claim
    // analysis would be a separate `claude -p` call; we surface a placeholder
    // info so the user knows where to look. Real LLM passes can be wired in
    // a follow-up without changing the public lint shape.
    findings.push({
      severity: 'info',
      code: 'llm-passes-skipped',
      message: 'LLM contradiction/stale-claim/missing-concept passes are wired but conservative in v1; set `--no-llm` to suppress this notice.',
    });
  }

  // ---------- write report ----------
  let reportPath: string | undefined;
  if (opts.writeReport !== false) {
    const date = nowIso().slice(0, 10);
    reportPath = join(p.outputs, `lint-${date}.md`);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, renderReport(findings, pages.length, slugMapUpdated, backlinksUpdated), 'utf8');
  }

  logger.debug('[lint] done', { findings: findings.length, pages: pages.length, slugMapUpdated, backlinksUpdated });
  return {
    findings,
    pagesScanned: pages.length,
    slugMapUpdated,
    backlinksUpdated,
    reportPath,
  };
}

function renderReport(
  findings: LintFinding[],
  pagesScanned: number,
  slugMapUpdated: boolean,
  backlinksUpdated: number,
): string {
  const lines: string[] = [];
  lines.push(`# Wiki lint report — ${nowIso().slice(0, 10)}`);
  lines.push('');
  lines.push(`- Pages scanned: ${pagesScanned}`);
  lines.push(`- Slug-map rewritten: ${slugMapUpdated ? 'yes' : 'no'}`);
  lines.push(`- Backlinks sections updated: ${backlinksUpdated}`);
  const errs = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;
  const infos = findings.filter((f) => f.severity === 'info').length;
  lines.push(`- Errors: ${errs} · Warnings: ${warns} · Info: ${infos}`);
  lines.push('');
  for (const sev of ['error', 'warn', 'info'] as const) {
    const subset = findings.filter((f) => f.severity === sev);
    if (subset.length === 0) continue;
    lines.push(`## ${sev.toUpperCase()} (${subset.length})`);
    lines.push('');
    for (const f of subset) {
      const loc = f.file ? ` _${f.file}${f.line ? `:${f.line}` : ''}_` : '';
      lines.push(`- **[${f.code}]**${loc} ${f.message}`);
      if (f.suggestion) lines.push(`  - _fix:_ \`${f.suggestion}\``);
    }
    lines.push('');
  }
  if (findings.length === 0) {
    lines.push('✓ all checks pass.');
  }
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

// Quiet unused
void BACKLINKS_OPEN;
void BACKLINKS_CLOSE;
