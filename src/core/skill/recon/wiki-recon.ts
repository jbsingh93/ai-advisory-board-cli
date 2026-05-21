/**
 * Wiki recon — Phase 5 Skill Planner recon phase 2.
 *
 * Walks the Knowledge Wiki (Phase 1.5) looking for the people, decisions,
 * concepts, vetoes, and past decisions that matter for one action item.
 * One Sonnet call with Read/Grep/Glob + maxTurns: 8 — reuses the same
 * Claude-Code-CLI primitives `aab knowledge query` does, but with a
 * recon-specific prompt that's tuned for stakeholder + decision + veto
 * extraction.
 *
 * Returns a `WikiContext` (PLAN/SKILL_CREATOR.md §6.3). Never throws on
 * an empty/missing wiki — degraded output with a warning is the contract.
 */
import { existsSync, readFileSync } from 'node:fs';
import { paths, type ResolvedWorkspace } from '../../../storage/paths.js';
import { runClaude, extractText } from '../../../llm/claude-code-runner.js';
import { safeParseJSON } from '../../parsing/safe-json.js';
import { logger } from '../../logger.js';
import type { AppSettings } from '../../../storage/types.js';

export interface WikiStakeholder {
  slug: string;
  name: string;
  role: string;
  contactHints?: string;
}

export interface WikiRelevantPage {
  slug: string;
  type: 'concept' | 'entity' | 'decision' | 'source-summary' | 'comparison';
  title: string;
  summary: string;
  excerpt?: string;
}

export interface WikiEndorsedDirection {
  slug: string;
  statement: string;
}

export interface WikiVeto {
  slug: string;
  statement: string;
}

export interface WikiPastDecision {
  slug: string;
  title: string;
  outcome: string;
}

export interface WikiContext {
  relevantPages: WikiRelevantPage[];
  stakeholders: WikiStakeholder[];
  endorsedDirections: WikiEndorsedDirection[];
  vetoes: WikiVeto[];
  pastDecisions: WikiPastDecision[];
  costUsd: number;
  warning?: string;
}

export interface WikiReconOptions {
  workspace: ResolvedWorkspace;
  settings: AppSettings;
  /** Action item title + description (the "what we're planning for"). */
  actionTitle: string;
  actionDescription?: string;
  discussionSummary?: string;
  maxTurns?: number;
  /** Bypass — return empty context with a note. */
  skip?: boolean;
}

const PROMPT_TEMPLATE = `<role>
You are the Wiki Recon agent. Your job: walk the Knowledge Wiki at wiki/ and find
every page that's relevant to one specific action item. Surface stakeholders,
endorsed directions, vetoes, and past decisions the Skill Planner can use to
design a maximalist skill.
</role>

<instructions>
You have Read + Grep + Glob — no write tools. Walk the wiki tiered:
1. Start with wiki/index.md (the slug map) and wiki/KNOWLEDGE.md (the curated
   index) to identify candidate pages.
2. Open the bodies of the most relevant 5-15 pages.
3. For each \`type: entity\` page that looks human (kebab-cased multi-word slug,
   body mentions relationship-to-user like "my video editor", "our advisor"),
   extract them as a stakeholder. Honor frontmatter \`role:\` if present;
   otherwise extract role + contact hints from the body's first paragraph.
4. For each \`type: decision\` page relevant to the action's domain, extract
   the outcome.
5. For each \`type: concept\` page that contains endorsed directions ("we
   standardize on…", "always do X") or vetoes ("never do X", "do not use Y"),
   capture them verbatim.
</instructions>

<action>
title: {{ACTION_TITLE}}
description: {{ACTION_DESCRIPTION}}
linkedDiscussionSummary: {{DISCUSSION_SUMMARY}}
</action>

<output_contract>
Return ONLY a single JSON object. Start with \`{\`, end with \`}\`. No fences,
no prose. Schema:

{
  "relevantPages": [{ "slug": "...", "type": "concept|entity|decision|source-summary|comparison",
                      "title": "...", "summary": "≤200 chars", "excerpt"?: "≤500 chars when highly relevant" }],
  "stakeholders":  [{ "slug": "...", "name": "...", "role": "...", "contactHints"?: "..." }],
  "endorsedDirections": [{ "slug": "...", "statement": "..." }],
  "vetoes":        [{ "slug": "...", "statement": "..." }],
  "pastDecisions": [{ "slug": "...", "title": "...", "outcome": "..." }]
}

If wiki has no relevant content, return all-empty arrays. Do not invent.
</output_contract>`;

export async function runWikiRecon(opts: WikiReconOptions): Promise<WikiContext> {
  if (opts.skip) {
    return emptyContext('skipped via --planner-no-wiki');
  }
  const p = paths(opts.workspace.root);
  if (!existsSync(p.wiki) || !existsSync(p.wikiIndex)) {
    return emptyContext('wiki not bootstrapped — run `aab init` (or `aab knowledge migrate`) to enable wiki recon');
  }

  const model = pickReconModel(opts.settings);
  const maxTurns = opts.maxTurns ?? 8;

  const prompt = PROMPT_TEMPLATE
    .replace('{{ACTION_TITLE}}', escapeForPrompt(opts.actionTitle))
    .replace('{{ACTION_DESCRIPTION}}', escapeForPrompt(opts.actionDescription ?? ''))
    .replace('{{DISCUSSION_SUMMARY}}', escapeForPrompt(opts.discussionSummary ?? ''));

  logger.debug('[wiki-recon] starting', { title: opts.actionTitle.slice(0, 60), model, maxTurns });
  try {
    const result = await runClaude({
      prompt,
      model,
      allowedTools: ['Read', 'Grep', 'Glob'],
      maxTurns,
      cwd: opts.workspace.root,
      maxBudgetUsd: opts.settings.perCallBudgetUsd,
      timeoutMs: 3 * 60_000,
    });
    const costUsd = result.json?.cost_usd ?? 0;
    const text = extractText(result);
    const parsed = parseWikiContext(text);
    return { ...parsed, costUsd };
  } catch (err) {
    logger.debug('[wiki-recon] failed', { error: err instanceof Error ? err.message : String(err) });
    return emptyContext(
      `wiki recon LLM call failed: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`,
    );
  }
}

export function parseWikiContext(text: string): Omit<WikiContext, 'costUsd' | 'warning'> {
  const parsed = safeParseJSON<Record<string, unknown>>(text);
  if (!parsed.success || !parsed.data || typeof parsed.data !== 'object') {
    return { relevantPages: [], stakeholders: [], endorsedDirections: [], vetoes: [], pastDecisions: [] };
  }
  const d = parsed.data;
  return {
    relevantPages: coerceArray(d.relevantPages).map(coerceRelevantPage).filter(nonNull),
    stakeholders: coerceArray(d.stakeholders).map(coerceStakeholder).filter(nonNull),
    endorsedDirections: coerceArray(d.endorsedDirections).map(coerceEndorsedDirection).filter(nonNull),
    vetoes: coerceArray(d.vetoes).map(coerceVeto).filter(nonNull),
    pastDecisions: coerceArray(d.pastDecisions).map(coercePastDecision).filter(nonNull),
  };
}

function emptyContext(warning: string): WikiContext {
  return {
    relevantPages: [],
    stakeholders: [],
    endorsedDirections: [],
    vetoes: [],
    pastDecisions: [],
    costUsd: 0,
    warning,
  };
}

function pickReconModel(settings: AppSettings): string {
  const v = settings.knowledgeWiki?.queryModel ?? settings.primaryModel;
  return typeof v === 'string' ? v : 'sonnet';
}

function escapeForPrompt(text: string): string {
  // Block injections that close our XML-style sections.
  return text.replace(/<\/?action>/gi, '').replace(/<\/?instructions>/gi, '').slice(0, 4000);
}

function coerceArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function coerceRelevantPage(raw: unknown): WikiRelevantPage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const slug = asString(r.slug);
  const title = asString(r.title);
  if (!slug || !title) return null;
  const type = asPageType(r.type);
  if (!type) return null;
  return {
    slug,
    type,
    title,
    summary: asString(r.summary) ?? '',
    excerpt: asString(r.excerpt),
  };
}

function coerceStakeholder(raw: unknown): WikiStakeholder | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const slug = asString(r.slug);
  const name = asString(r.name);
  const role = asString(r.role);
  if (!slug || !name || !role) return null;
  return { slug, name, role, contactHints: asString(r.contactHints) };
}

function coerceEndorsedDirection(raw: unknown): WikiEndorsedDirection | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const slug = asString(r.slug);
  const statement = asString(r.statement);
  if (!slug || !statement) return null;
  return { slug, statement };
}

function coerceVeto(raw: unknown): WikiVeto | null {
  return coerceEndorsedDirection(raw); // same shape
}

function coercePastDecision(raw: unknown): WikiPastDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const slug = asString(r.slug);
  const title = asString(r.title);
  const outcome = asString(r.outcome);
  if (!slug || !title || !outcome) return null;
  return { slug, title, outcome };
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function asPageType(value: unknown): WikiRelevantPage['type'] | null {
  if (typeof value !== 'string') return null;
  const v = value.toLowerCase();
  if (v === 'concept' || v === 'entity' || v === 'decision' || v === 'source-summary' || v === 'comparison') return v;
  return null;
}

function nonNull<T>(v: T | null): v is T {
  return v !== null;
}

// Suppress unused import (readFileSync may be needed when we later add
// frontmatter pre-scanning prior to the LLM call to seed candidate slugs).
void readFileSync;
