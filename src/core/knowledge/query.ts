/**
 * Wiki query — one-shot Claude call with Read/Grep/Glob, no writes.
 * Reference: `docs/development/KNOWLEDGE_WIKI.md` §15.2.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths, type ResolvedWorkspace } from '../../storage/paths.js';
import { runClaude, extractText } from '../../llm/claude-code-runner.js';
import { safeParseJSON } from '../parsing/safe-json.js';
import { logger } from '../logger.js';
import { ModelError, UserError } from '../errors.js';
import { buildQueryPrompt } from '../prompts/skill-query.js';
import { humanizeSlug, pathForPage, type PageType } from './page.js';
import { writePageAtomic } from './page.js';
import { buildSlugMap, writeSlugMapToIndex } from './slug-map.js';
import { nowIso } from '../utils.js';
import type { AppSettings } from '../../storage/types.js';

export interface WikiQueryOptions {
  question: string;
  workspace: ResolvedWorkspace;
  settings: AppSettings;
  maxPages?: number;
  modelOverride?: string;
  saveAs?: PageType;
}

export interface WikiQueryResult {
  question: string;
  answer: string;
  citations: string[];
  notes?: string;
  costUsd: number;
  savedAs?: string;
}

export async function queryWiki(opts: WikiQueryOptions): Promise<WikiQueryResult> {
  const p = paths(opts.workspace.root);
  if (!existsSync(p.wiki)) {
    throw new UserError('Wiki not initialised. Run `aab init` (or `aab knowledge migrate`) first.');
  }
  const maxPages = opts.maxPages ?? opts.settings.knowledgeWiki?.maxAgentPagesPerCall ?? 10;
  const model = pickQueryModel(opts.settings, opts.modelOverride);
  const wikiKnowledgeMd = existsSync(p.wikiKnowledge) ? readFileSync(p.wikiKnowledge, 'utf8') : '';
  // Prefer the compact catalog (small, structured) over the full index.md, which
  // can blow past 256 KB on a populated wiki and bloat the prompt. Fall back to a
  // capped slice of index.md only when no catalog exists yet.
  const wikiCatalogJson = existsSync(p.wikiCatalog) ? readFileSync(p.wikiCatalog, 'utf8') : '';
  const wikiIndexMd = wikiCatalogJson
    ? ''
    : existsSync(p.wikiIndex)
      ? capText(readFileSync(p.wikiIndex, 'utf8'), 12_000)
      : '';
  const prompt = buildQueryPrompt({
    question: opts.question,
    wikiKnowledgeMd,
    wikiIndexMd,
    wikiCatalogJson,
    maxPages,
  });

  logger.debug('[query] starting', { question: opts.question.slice(0, 80), model, maxPages });
  let text: string;
  let costUsd = 0;
  try {
    // No `--max-turns`: the harness terminates the agent when it has its answer;
    // budget + timeout are the real guardrails. A low turn cap only caused
    // spurious `max_turns` failures on big-wiki retrieval.
    const result = await runClaude({
      prompt,
      model,
      allowedTools: ['Read', 'Grep', 'Glob'],
      cwd: opts.workspace.root,
      maxBudgetUsd: opts.settings.perCallBudgetUsd,
      timeoutMs: 3 * 60_000,
    });
    text = extractText(result);
    costUsd = result.json?.cost_usd ?? 0;
  } catch (error) {
    throw new ModelError(
      `Query LLM call failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let answer = text.trim();
  let citations: string[] = [];
  let notes: string | undefined;
  const parsed = safeParseJSON<Record<string, unknown>>(text);
  if (parsed.success && parsed.data && typeof parsed.data === 'object') {
    const d = parsed.data;
    if (typeof d.answer === 'string') answer = d.answer.trim();
    if (Array.isArray(d.citations)) {
      citations = d.citations.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')).filter(Boolean);
    }
    if (typeof d.notes === 'string') notes = d.notes;
  }

  let savedAs: string | undefined;
  if (opts.saveAs) {
    const slug = humanizeSlug(opts.question) || `query-${Date.now()}`;
    const targetPath = pathForPage(p.wiki, opts.saveAs, slug);
    const today = nowIso().slice(0, 10);
    writePageAtomic(
      targetPath,
      {
        title: opts.question,
        slug,
        type: opts.saveAs,
        summary: opts.question,
        tags: [],
        sources: citations.map((s) => `wiki/${s}`),
        related: citations.map((s) => `[[${s}]]`),
        confidence: 'medium',
        provenance: 'inferred',
        created: today,
        updated: today,
        userEdited: false,
      },
      answer + (citations.length > 0 ? `\n\n## Citations\n\n${citations.map((c) => `- [[${c}]]`).join('\n')}\n` : '\n'),
    );
    savedAs = `wiki/${humanizeSlug(opts.saveAs)}/${slug}.md`;
    // Refresh slug-map.
    const map = buildSlugMap(p.wiki, opts.workspace.root);
    writeSlugMapToIndex(p.wikiIndex, map);
  }

  return { question: opts.question, answer, citations, notes, costUsd, savedAs };
}

function pickQueryModel(settings: AppSettings, override?: string): string {
  if (override) return override;
  const v = settings.knowledgeWiki?.queryModel ?? settings.primaryModel;
  return typeof v === 'string' ? v : 'sonnet';
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n…[truncated — use the compact catalog / Grep instead of reading this in full]';
}

// Silence unused
void mkdirSync;
void writeFileSync;
void dirname;
void join;
