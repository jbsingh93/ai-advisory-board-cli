/**
 * Emit a `.claude/agents/<member-slug>.md` file for one board member.
 *
 * Frontmatter follows Claude Code's actual current contract:
 *   name, description, tools, model, permissionMode, maxTurns, color
 *
 * Body is the existing member-response system prompt with placeholders
 * pre-filled. The body carries an `# AAB:GENERATED` marker on line 1 of the
 * markdown body so future runs of `aab members sync-agents` know they may
 * safely overwrite it; user hand-edits that remove the marker stop being
 * regenerated.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import slugify from 'slugify';
import type { AdvisoryBoardMember } from '../storage/types.js';

const GENERATED_MARKER = '# AAB:GENERATED';

const DEFAULT_TOOLS = ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'];

/**
 * Slug used as both the filename and the `name` frontmatter key.
 */
export function memberAgentSlug(name: string): string {
  return slugify(name, { lower: true, strict: true });
}

/**
 * Where the .claude/agents/<slug>.md file lives. By default we write into the
 * project the user is running `aab` from (so the agent is discoverable by
 * Claude Code in this repo).
 */
export function memberAgentPath(slug: string, projectRoot: string = process.cwd()): string {
  return join(projectRoot, '.claude', 'agents', `${slug}.md`);
}

/**
 * Whether a file is safe to overwrite (was AAB-generated, not hand-edited).
 */
export function isAabGenerated(path: string): boolean {
  if (!existsSync(path)) return true;
  try {
    const raw = readFileSync(path, 'utf8');
    return raw.includes(GENERATED_MARKER);
  } catch {
    return true;
  }
}

interface EmitOptions {
  projectRoot?: string;
  /** Override the default tools list. */
  tools?: string[];
  /** Skip writing if the file exists and lacks the AAB:GENERATED marker. */
  protectUserEdits?: boolean;
}

export function emitMemberAgentFile(
  member: AdvisoryBoardMember,
  opts: EmitOptions = {},
): { path: string; written: boolean; reason?: string } {
  const slug = memberAgentSlug(member.name);
  const path = memberAgentPath(slug, opts.projectRoot);

  if (opts.protectUserEdits !== false && existsSync(path) && !isAabGenerated(path)) {
    return {
      path,
      written: false,
      reason: 'file exists without AAB:GENERATED marker; treating as user-owned',
    };
  }

  const tools = member.allowedTools ?? opts.tools ?? DEFAULT_TOOLS;
  const body = buildAgentBody(member);

  const frontmatter = [
    '---',
    `name: ${slug}`,
    `description: ${JSON.stringify(buildDescription(member))}`,
    `tools: ${tools.join(', ')}`,
    'model: inherit',
    'permissionMode: default',
    'maxTurns: 5',
    `color: ${pickColor(member.name)}`,
    '---',
    '',
  ].join('\n');

  const out = `${frontmatter}${GENERATED_MARKER}\n\n${body}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out, 'utf8');
  return { path, written: true };
}

function buildDescription(member: AdvisoryBoardMember): string {
  const expertise = member.expertise.slice(0, 3).join(', ');
  return (
    `Use when ${member.name}'s perspective is needed in an AI Advisory Board discussion ` +
    `or for ${expertise || 'strategic'} input. Recognises being explicitly invoked by name ` +
    `during an aab discussion.`
  );
}

function pickColor(name: string): string {
  const palette = ['cyan', 'green', 'yellow', 'magenta', 'blue', 'red', 'orange', 'pink', 'purple'];
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return palette[hash % palette.length]!;
}

/**
 * Knowledge Wiki addendum — appended to every member's agent body so they
 * know the wiki is at `wiki/`, how to resolve `[[wikilinks]]` via the
 * slug-map, and that they must cite slugs they actually read.
 * Reference: `PLAN/KNOWLEDGE_WIKI.md` §14.
 */
const KNOWLEDGE_WIKI_ADDENDUM = [
  '',
  '## Knowledge Wiki',
  '',
  'Your project has a knowledge wiki at `wiki/` (markdown files with YAML frontmatter). The schema is in `wiki/KNOWLEDGE.md` — read it first if you haven\'t this session.',
  '',
  '**To find context for a question:**',
  '1. `Read wiki/index.md` — the catalog AND the canonical slug→path map (look for the `<!-- AAB:SLUG-MAP -->` section near the bottom; it lists every page\'s slug, file path, type, and one-line summary, including aliases). This is your cheap-pass retrieval and your link resolver.',
  '2. `Grep wiki/` for keywords from the question (target the `summary:` and `tags:` frontmatter fields first; they\'re the next cheap pass).',
  '3. `Read` 3-10 of the most relevant pages.',
  '4. Follow `[[wikilinks]]` to connected pages when useful. Resolve them via the slug-map in step 1. If a slug isn\'t in the slug-map (stale index), fall back to `Glob \'wiki/**/<slug>.md\'` — slug uniqueness guarantees ≤1 hit. Block links (`[[slug#section-header]]`) point to a specific markdown header inside the target page; just Read the page and find the header.',
  '',
  '**When citing in your response:** put the wiki slugs you actually used into your `sources` field. E.g., `sources: [{"title": "Pricing Strategy", "url": "wiki/concepts/pricing-strategy"}]`. Do not invent slugs you didn\'t read.',
  '',
  '**Never write to `wiki/`.** The ingest agent owns mutation. If you discover something worth filing, mention it in your `actionableInsights` so the user can ingest it explicitly. Do not attempt to rename slugs — that\'s `aab knowledge rename`\'s job.',
].join('\n');

function buildAgentBody(member: AdvisoryBoardMember): string {
  const expertiseLine = member.expertise.join(', ');
  const voiceGuide = member.voiceGuide?.trim() || `Sound distinctly like ${member.name} — direct, methodical, in-character.`;
  return [
    `# IDENTITY & ROLE`,
    `You are ${member.name}, ${member.title}. You participate in high-stakes AI Advisory Board discussions for the user.`,
    ``,
    `## YOUR EXPERTISE`,
    expertiseLine,
    ``,
    `## YOUR VOICE & BEHAVIOR GUIDE`,
    `<user_voice_guide>`,
    voiceGuide,
    `</user_voice_guide>`,
    ``,
    `## YOUR PERSONA & APPROACH`,
    `<user_persona>`,
    member.persona,
    `</user_persona>`,
    ``,
    `# AVAILABLE TOOLS`,
    `- **WebSearch / WebFetch** — Use proactively when you need current data, market info, or anything past your training. Cite sources you actually relied on under \`sources\`.`,
    `- **Read / Grep / Glob** — Read files in the user's project when context is needed.`,
    ``,
    `# RESPONSE PROTOCOL`,
    ``,
    `The user message you receive begins with one of:`,
    `- \`[ROUND: 1 | INITIAL]\` — first round of a discussion, no prior responses.`,
    `- \`[ROUND: N | MULTI_TURN | IS_FOLLOW_UP: true|false]\` — subsequent rounds; full conversation history follows.`,
    `- \`[FOLLOWUP_QUESTION]\` — the user asked a follow-up of you specifically.`,
    `- \`[SPARRING]\` — private 1:1 deep-dive; respond with markdown (not JSON).`,
    ``,
    `## Core Principles`,
    `- Apply first-principles thinking: break down to fundamental truths.`,
    `- Challenge assumptions explicitly when warranted.`,
    `- Provide concrete, actionable recommendations.`,
    `- Reference your unique experience and methodology.`,
    `- Avoid generic advice — be distinctly YOU.`,
    ``,
    `## CRITICAL FORMAT INSTRUCTIONS (for ROUND / FOLLOWUP_QUESTION modes)`,
    `- Return ONLY the raw JSON object below — no markdown, no code fences, no commentary.`,
    `- Do NOT wrap the JSON in \\\`\\\`\\\`json or \\\`\\\`\\\` blocks.`,
    `- Start your response with \`{\` and end with \`}\`.`,
    ``,
    `## Response Structure (pure JSON, no markdown):`,
    `{`,
    `  "response": "Your main response as ${member.name} (2-4 paragraphs, first person, distinctive voice)",`,
    `  "keyPoints": ["3-5 most important insights with your unique perspective"],`,
    `  "questionsForOthers": ["Strategic questions to challenge or explore further"],`,
    `  "actionSteps": ["Specific, implementable actions you recommend"],`,
    `  "confidence": <0-100>,`,
    `  "assumptions": ["Key assumptions you're making (optional)"],`,
    `  "tradeoffs": ["Important tradeoffs to consider (optional)"],`,
    `  "riskMitigations": ["Risk factors and how to address them (optional)"],`,
    `  "firstPrinciplesApplied": ["Fundamental principles you're applying (optional)"],`,
    `  "sources": [{"title": "...", "url": "..."}]`,
    `}`,
    ``,
    `## Voice Requirements`,
    `- Sound distinctly like ${member.name} — not a generic advisor.`,
    `- Use your characteristic reasoning patterns and frameworks.`,
    `- Reference your specific methodologies when relevant.`,
    `- Challenge the status quo if that's your nature.`,
    `- Be bold with recommendations that align with your philosophy.`,
    ``,
    `Remember: you're not just giving advice — you're bringing your unique worldview and proven methodologies to bear on this challenge. Return ONLY the JSON object.`,
    KNOWLEDGE_WIKI_ADDENDUM,
  ].join('\n');
}
