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
 * Returns a `WikiContext` (docs/development/SKILL_CREATOR.md §6.3). Never throws on
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

// ─── Tier 1: KNOWLEDGE — Phase 5.1 (wiki as operating brain) ───────────────

export interface WikiPlaybook {
  slug: string;
  title: string;
  /** FULL body — embedded verbatim into the emitted SKILL.md by skill-creator. */
  body: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface WikiTemplate {
  slug: string;
  title: string;
  /** FULL body — embedded verbatim. */
  body: string;
  /** Literal sample output if surfaceable (≤1500 chars). */
  exampleOutput?: string;
}

export interface WikiDomainKnowledge {
  slug: string;
  title: string;
  summary: string;
  excerpt?: string;
}

export interface WikiPastLesson {
  slug: string;
  summary: string;
  /** The concrete "next time" rule extracted from the post-mortem. */
  actionable: string;
}

export interface WikiContext {
  // Tier 1 — knowledge that must be BAKED INTO the skill
  playbooks: WikiPlaybook[];
  templates: WikiTemplate[];
  domainKnowledge: WikiDomainKnowledge[];
  pastLessons: WikiPastLesson[];

  // Tier 2 — people
  stakeholders: WikiStakeholder[];

  // Tier 3 — rules
  endorsedDirections: WikiEndorsedDirection[];
  vetoes: WikiVeto[];
  pastDecisions: WikiPastDecision[];

  // Catch-all (anything that didn't fit a tier above)
  relevantPages: WikiRelevantPage[];

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
  /** Cancellation — kills the in-flight `claude` child when aborted. */
  signal?: AbortSignal;
}

const PROMPT_TEMPLATE = `<role>
You are the Wiki Recon agent. The wiki at wiki/ is the user's OPERATING BRAIN —
the playbooks they've refined, the templates they've already proven, the
domain knowledge only they have, the post-mortems documenting what bit them
last time. Your job: find that knowledge and route it into structured slots
the Skill Planner uses to design a skill that does work THE USER'S WAY, not
in a generic-best-practice way.

This is NOT a stakeholder address book. Do NOT over-weight people extraction.
Most pages in a healthy wiki are about procedures, templates, and concepts —
not about humans.
</role>

<instructions>
You have Read + Grep + Glob — no write tools. Three-pass walk:

PASS 1 — Tier classification.
Walk wiki/index.md (slug map) and wiki/KNOWLEDGE.md (curated index). For each
candidate page, classify by TIER. A single page can land in multiple tiers
(e.g., a playbook page that also contains a literal template).

Tier 1 — KNOWLEDGE (bake into the emitted skill):
  - playbook: \`type: concept\` page documenting "how we X" — procedural, uses
    first-person plural ("we", "our"), contains numbered/ordered steps, title
    matches patterns like "Our X playbook", "How we Y", "X runbook", "Our
    process for Z".
    Examples by domain (action-agnostic): "Our YouTube launch playbook" /
    "How we land OAuth changes" / "Our pricing-decision framework" / "Our
    SDR hiring loop" / "Our monthly investor-update process" / "How we run
    competitive teardowns" / "Our DPA review checklist".
  - template: \`type: concept\` page documenting an OUTPUT SHAPE — title
    contains "template/format/style/structure/shape/example", body contains
    a literal output sample.
    Examples: "Our Danish SMB tone guide" / "Our PR description template" /
    "Our decision-memo template" / "Our SDR JD template" / "Our investor
    email template" / "Our slack incident-update format".
  - domainKnowledge: \`type: concept\` page that is DESCRIPTIVE (not
    procedural) — defines what something IS or means in the user's context.
    Or \`type: source-summary\` that captures distilled learnings.
    Examples: "Our brand voice principles" / "Our session-cookie threat
    model" / "TAM/SAM/SOM for DK" / "Our compensation philosophy" / "Our
    gross-margin definition" / "Our GDPR posture".
  - pastLessons: post-mortems / retros / "what bit us last time" pages.
    Title contains "lesson/post-mortem/retro/incident". Body uses past-tense
    narrative + "next time we will…" / "we should always…" patterns.

Tier 2 — PEOPLE:
  - stakeholder: \`type: entity\` page about a human (kebab-cased multi-word
    slug not matching a company/product/tool name), body mentions
    relationship-to-user ("my X", "our X", "X for the user"). Extract role
    from frontmatter \`role:\` if present; otherwise from body's first
    paragraph. Capture email/Slack/phone as contactHints.

Tier 3 — RULES:
  - endorsedDirection: \`type: concept\` page or section stating "we
    standardize on Y" / "we always X" / "we prefer Z".
  - veto: same shape but "never X" / "do not use Y" / "avoid Z".
  - pastDecision: \`type: decision\` page relevant to the action — extract
    the outcome.

PASS 2 — Open Tier 1 bodies in FULL.
For every playbook, template, and high-confidence domainKnowledge page,
Read the entire body and include it in the output JSON. Do NOT summarize.
The Planner + skill-creator need the literal text to embed verbatim into the
emitted skill.

PASS 3 — Extract Tier 2-3 by summary (bodies only when highly relevant).

Confidence scoring on playbooks:
- "high"   = title is "Our X playbook"/"How we Y" + body has ≥3 numbered
             first-person-plural steps naming the user's tools/people.
- "medium" = title fits but body is principles-only without concrete steps.
- "low"    = page describes X without prescribing process → surface as
             domainKnowledge instead of playbook.

If a page seems to belong in BOTH playbook AND domainKnowledge, prefer
playbook (procedural signal is more load-bearing for the skill). If a page
seems to be both template AND domainKnowledge, surface in BOTH (cheap; both
slots accept the same body).

Anti-bias check: if you find yourself wanting to put more than 3 pages in
stakeholders[] and fewer than 3 in playbooks+templates+domainKnowledge,
re-examine — you're under-counting knowledge.
</instructions>

<action>
title: {{ACTION_TITLE}}
description: {{ACTION_DESCRIPTION}}
linkedDiscussionSummary: {{DISCUSSION_SUMMARY}}
</action>

<output_contract>
Return ONLY a single JSON object. Start with \`{\`, end with \`}\`. No fences,
no prose. Schema (every array is required even when empty):

{
  "playbooks":     [{ "slug": "...", "title": "...", "body": "<FULL body verbatim>",
                       "confidence": "high|medium|low" }],
  "templates":     [{ "slug": "...", "title": "...", "body": "<FULL body verbatim>",
                       "exampleOutput"?: "≤1500 chars literal sample if surfaceable" }],
  "domainKnowledge": [{ "slug": "...", "title": "...", "summary": "≤200 chars",
                        "excerpt"?: "≤1000 chars when highly relevant" }],
  "pastLessons":   [{ "slug": "...", "summary": "≤200 chars",
                       "actionable": "the concrete 'next time' rule, ≤200 chars" }],
  "stakeholders":  [{ "slug": "...", "name": "...", "role": "...", "contactHints"?: "..." }],
  "endorsedDirections": [{ "slug": "...", "statement": "..." }],
  "vetoes":        [{ "slug": "...", "statement": "..." }],
  "pastDecisions": [{ "slug": "...", "title": "...", "outcome": "..." }],
  "relevantPages": [{ "slug": "...", "type": "concept|entity|decision|source-summary|comparison",
                       "title": "...", "summary": "≤200 chars", "excerpt"?: "≤500 chars" }]
}

If wiki has no relevant content for the action, return all-empty arrays.
Do NOT invent. Do NOT pad to look productive.
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
  // Bumped from 8 → 12 (Phase 5.1): the recon agent now opens FULL bodies
  // of playbooks + templates, not just summaries.
  const maxTurns = opts.maxTurns ?? 12;

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
      strictMcpConfig: true,
      signal: opts.signal,
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
  const empty = {
    playbooks: [], templates: [], domainKnowledge: [], pastLessons: [],
    stakeholders: [], endorsedDirections: [], vetoes: [], pastDecisions: [],
    relevantPages: [],
  };
  const parsed = safeParseJSON<Record<string, unknown>>(text);
  if (!parsed.success || !parsed.data || typeof parsed.data !== 'object') {
    return empty;
  }
  const d = parsed.data;
  // Tolerate model synonyms — different runs sometimes pick adjacent words
  // for the slot names (procedure/process for playbook, format/example for
  // template, knowledge/facts for domainKnowledge, lessons/learnings for
  // pastLessons). Coerce them all into the canonical fields before parsing.
  const playbookSrc = coerceArray(d.playbooks).concat(coerceArray(d.procedures)).concat(coerceArray(d.processes));
  const templateSrc = coerceArray(d.templates).concat(coerceArray(d.formats)).concat(coerceArray(d.examples));
  const dkSrc = coerceArray(d.domainKnowledge).concat(coerceArray(d.knowledge)).concat(coerceArray(d.facts));
  const lessonSrc = coerceArray(d.pastLessons).concat(coerceArray(d.lessons)).concat(coerceArray(d.learnings));
  return {
    playbooks: dedupeBySlug(playbookSrc.map(coercePlaybook).filter(nonNull)),
    templates: dedupeBySlug(templateSrc.map(coerceTemplate).filter(nonNull)),
    domainKnowledge: dedupeBySlug(dkSrc.map(coerceDomainKnowledge).filter(nonNull)),
    pastLessons: dedupeBySlug(lessonSrc.map(coercePastLesson).filter(nonNull)),
    stakeholders: coerceArray(d.stakeholders).map(coerceStakeholder).filter(nonNull),
    endorsedDirections: coerceArray(d.endorsedDirections).map(coerceEndorsedDirection).filter(nonNull),
    vetoes: coerceArray(d.vetoes).map(coerceVeto).filter(nonNull),
    pastDecisions: coerceArray(d.pastDecisions).map(coercePastDecision).filter(nonNull),
    relevantPages: coerceArray(d.relevantPages).map(coerceRelevantPage).filter(nonNull),
  };
}

function emptyContext(warning: string): WikiContext {
  return {
    playbooks: [], templates: [], domainKnowledge: [], pastLessons: [],
    stakeholders: [], endorsedDirections: [], vetoes: [], pastDecisions: [],
    relevantPages: [],
    costUsd: 0,
    warning,
  };
}

function dedupeBySlug<T extends { slug: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.slug)) continue;
    seen.add(item.slug);
    out.push(item);
  }
  return out;
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

function coercePlaybook(raw: unknown): WikiPlaybook | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const slug = asString(r.slug);
  const title = asString(r.title);
  const body = asString(r.body) ?? asString(r.content);
  if (!slug || !title || !body) return null;
  const conf = asString(r.confidence)?.toLowerCase();
  const confidence: WikiPlaybook['confidence'] =
    conf === 'high' || conf === 'medium' || conf === 'low' ? conf : 'medium';
  return { slug, title, body, confidence };
}

function coerceTemplate(raw: unknown): WikiTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const slug = asString(r.slug);
  const title = asString(r.title);
  const body = asString(r.body) ?? asString(r.content);
  if (!slug || !title || !body) return null;
  return { slug, title, body, exampleOutput: asString(r.exampleOutput) ?? asString(r.example) };
}

function coerceDomainKnowledge(raw: unknown): WikiDomainKnowledge | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const slug = asString(r.slug);
  const title = asString(r.title);
  const summary = asString(r.summary);
  if (!slug || !title || !summary) return null;
  return { slug, title, summary, excerpt: asString(r.excerpt) };
}

function coercePastLesson(raw: unknown): WikiPastLesson | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const slug = asString(r.slug);
  const summary = asString(r.summary);
  const actionable = asString(r.actionable) ?? asString(r.rule) ?? asString(r.nextTime);
  if (!slug || !summary || !actionable) return null;
  return { slug, summary, actionable };
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
