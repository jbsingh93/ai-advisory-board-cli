/**
 * Migrate `BusinessContext` + `BusinessProfile` JSON into wiki pages.
 * Reference: `PLAN/KNOWLEDGE_WIKI.md` §19. Idempotent. Backs up the old
 * JSON to `business-context.json.migrated.bak` after success.
 */
import { existsSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths, type ResolvedWorkspace } from '../../storage/paths.js';
import { toSlug, pathForPage, type PageType, type PageFrontmatter, writePageAtomic, toPosix } from './page.js';
import { emitWikiSkeleton } from './schema-emitter.js';
import { buildSlugMap, writeSlugMapToIndex } from './slug-map.js';
import { nowIso } from '../utils.js';
import { relative } from 'node:path';
import type {
  BusinessContext,
  BusinessProfile,
  StorageService,
} from '../../storage/types.js';

export interface MigrateOptions {
  workspace: ResolvedWorkspace;
  storage: StorageService;
  dryRun?: boolean;
  forceSchema?: boolean;
}

export interface MigrateResult {
  producedPages: string[];
  skipped: string[];
  backupPath?: string;
  dryRun: boolean;
}

export async function migrateBusinessContext(opts: MigrateOptions): Promise<MigrateResult> {
  const p = paths(opts.workspace.root);

  // Ensure wiki skeleton exists before we write pages.
  if (!opts.dryRun) {
    emitWikiSkeleton({ workspaceRoot: opts.workspace.root, forceSchema: opts.forceSchema });
  }

  const items = await safeLoad(opts.storage.loadBusinessContext.bind(opts.storage));
  const profile = await safeLoadOne(opts.storage.loadBusinessProfile.bind(opts.storage));

  const produced: string[] = [];
  const skipped: string[] = [];

  // ---- Company profile → wiki/entities/company.md ----
  if (profile) {
    const path = pathForPage(p.wiki, 'entity', 'company');
    if (!opts.dryRun) {
      writePageAtomic(path, profileFrontmatter(profile), profileBody(profile));
    }
    produced.push(toPosix(`wiki/entities/company.md`));
  }

  // ---- BusinessContext items ----
  for (const item of items ?? []) {
    const target = mapItem(item);
    if (!target) {
      skipped.push(`${item.category}/${item.title}`);
      continue;
    }
    const path = pathForPage(p.wiki, target.type, target.slug);
    if (!opts.dryRun) writePageAtomic(path, target.frontmatter, target.body);
    produced.push(toPosix(`wiki/${typeFolder(target.type)}/${target.slug}.md`));
  }

  // Slug-map refresh
  if (!opts.dryRun) {
    const map = buildSlugMap(p.wiki, opts.workspace.root);
    writeSlugMapToIndex(p.wikiIndex, map);
  }

  // Back up the old JSON.
  let backupPath: string | undefined;
  if (!opts.dryRun && existsSync(p.businessContext)) {
    const backup = `${p.businessContext}.migrated.bak`;
    if (!existsSync(backup)) renameSync(p.businessContext, backup);
    backupPath = toPosix(relative(opts.workspace.root, backup));
  }
  // Also back up profile JSON if present.
  if (!opts.dryRun && existsSync(p.businessProfile)) {
    const backup = `${p.businessProfile}.migrated.bak`;
    if (!existsSync(backup)) renameSync(p.businessProfile, backup);
  }

  return { producedPages: produced, skipped, backupPath, dryRun: !!opts.dryRun };
}

async function safeLoad<T>(fn: () => Promise<T[]>): Promise<T[] | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
async function safeLoadOne<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function typeFolder(t: PageType): string {
  return ({ concept: 'concepts', entity: 'entities', decision: 'decisions', 'source-summary': 'sources', comparison: 'comparisons' } as const)[t];
}

function profileFrontmatter(p: BusinessProfile): PageFrontmatter {
  const today = nowIso().slice(0, 10);
  return {
    title: p.companyName || 'Company',
    slug: 'company',
    type: 'entity',
    summary: [p.companyName, p.industry, p.stage].filter(Boolean).join(' · ').slice(0, 200),
    tags: ['company', 'profile', p.industry, p.stage, p.companySize].filter((t): t is string => !!t),
    sources: ['business-profile.json (migrated)'],
    confidence: 'high',
    provenance: 'extracted',
    created: today,
    updated: today,
    userEdited: false,
  };
}

function profileBody(p: BusinessProfile): string {
  const lines: string[] = [];
  lines.push(`# ${p.companyName || 'Company'}`);
  lines.push('');
  if (p.industry) lines.push(`- **Industry:** ${p.industry}`);
  if (p.companySize) lines.push(`- **Size:** ${p.companySize}`);
  if (p.stage) lines.push(`- **Stage:** ${p.stage}`);
  if (p.targetMarket) lines.push(`- **Target market:** ${p.targetMarket}`);
  lines.push('');
  if (p.products && p.products.length > 0) {
    lines.push('## Products');
    for (const x of p.products) lines.push(`- ${x}`);
    lines.push('');
  }
  if (p.topGoals && p.topGoals.length > 0) {
    lines.push('## Top goals');
    for (const x of p.topGoals) lines.push(`- ${x}`);
    lines.push('');
  }
  if (p.blockers && p.blockers.length > 0) {
    lines.push('## Blockers');
    for (const x of p.blockers) lines.push(`- ${x}`);
    lines.push('');
  }
  if (p.tools && p.tools.length > 0) {
    lines.push('## Tools');
    for (const x of p.tools) lines.push(`- ${x}`);
    lines.push('');
  }
  if (p.customTools) {
    lines.push('## Custom tools');
    lines.push(p.customTools);
    lines.push('');
  }
  lines.push('> Migrated from `business-profile.json` on ' + nowIso() + '.');
  return lines.join('\n');
}

function mapItem(item: BusinessContext): { type: PageType; slug: string; frontmatter: PageFrontmatter; body: string } | null {
  const today = nowIso().slice(0, 10);
  const slug = toSlug(item.title);
  if (!slug) return null;
  let type: PageType = 'concept';
  switch (item.category) {
    case 'company':
    case 'team':
    case 'product':
    case 'tools':
    case 'industry':
    case 'market':
      type = 'entity';
      break;
    case 'goals':
    case 'challenges':
    case 'strategy':
      type = 'concept';
      break;
  }
  const confidence: 'high' | 'medium' | 'low' = item.confidence >= 0.8 ? 'high' : item.confidence >= 0.5 ? 'medium' : 'low';
  const provenance: 'extracted' | 'inferred' = item.extractedFrom && item.extractedFrom !== 'manual' ? 'extracted' : 'inferred';
  const fm: PageFrontmatter = {
    title: item.title,
    slug,
    type,
    summary: item.description.slice(0, 200),
    tags: [item.category, ...(item.relevantKeywords ?? [])].filter(Boolean) as string[],
    sources: item.extractedFrom ? [`discussion:${item.extractedFrom}`] : [],
    confidence,
    provenance,
    created: (item.createdAt ?? today).slice(0, 10),
    updated: (item.updatedAt ?? today).slice(0, 10),
    userEdited: false,
  };
  const body = [
    `# ${item.title}`,
    '',
    item.description,
    '',
    '> Migrated from `business-context.json` on ' + nowIso() + '.',
  ].join('\n');
  return { type, slug, frontmatter: fm, body };
}

// Silence unused
void writeFileSync;
void mkdirSync;
void dirname;
