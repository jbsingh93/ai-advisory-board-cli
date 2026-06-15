/**
 * Emit a `.claude/agents/<member-slug>.md` file for one board member.
 *
 * Frontmatter follows Claude Code's actual current contract:
 *   name, description, tools, model, permissionMode, color
 *
 * We deliberately do NOT emit `maxTurns` — a low tool-turn cap only produced
 * spurious `max_turns` failures on members doing Read/Grep/Glob wiki retrieval.
 * The Claude Code harness, the per-call budget, and the wall-clock timeout are
 * the real guardrails.
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
    // The file exists but can't be read (permissions, transient FS error) —
    // we can't prove it's ours, so protect it like a hand-edited file.
    return false;
  }
}

const KNOWN_COLORS = new Set([
  'cyan', 'green', 'yellow', 'magenta', 'blue', 'red', 'orange', 'pink', 'purple',
]);

/**
 * Parse the `color:` field out of the agent file's YAML frontmatter.
 * Returns undefined if the file is missing, frontmatter is absent, or the
 * value isn't one of the recognised palette names. Whitespace-tolerant and
 * accepts optional surrounding quotes.
 */
export function readMemberAgentColor(name: string, projectRoot?: string): string | undefined {
  const slug = memberAgentSlug(name);
  const path = memberAgentPath(slug, projectRoot);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, 'utf8');
    // Frontmatter is the first --- … --- block. Use line-by-line so we only
    // match top-level keys, never something nested in the body.
    const lines = raw.split(/\r?\n/);
    if (lines[0]?.trim() !== '---') return undefined;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.trim() === '---') break;
      const m = /^color\s*:\s*(.+?)\s*$/.exec(line);
      if (m) {
        const v = m[1]!.replace(/^["']|["']$/g, '').toLowerCase();
        return KNOWN_COLORS.has(v) ? v : undefined;
      }
    }
  } catch {
    // unreadable or transient FS error — treat as no color
  }
  return undefined;
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
 * Reference: `docs/development/KNOWLEDGE_WIKI.md` §14.
 */
const KNOWLEDGE_WIKI_ADDENDUM = [
  '',
  '## Knowledge Wiki — your primary source of truth about the user',
  '',
  'The user has a knowledge wiki: markdown files with YAML frontmatter holding what we know about them, their business, goals, prior decisions, and context. The CLI usually **pre-fetches the most relevant pages for you** and injects them into your task message under a `## Retrieved knowledge` heading — when present, that is your primary context and you normally do NOT need to open the wiki yourself.',
  '',
  '**If you do need to retrieve from the wiki, your task message gives its absolute directory path** (the wiki lives outside your working directory, so relative paths like `wiki/` will NOT resolve). Follow these rules — they keep you within your finite tool-turn budget:',
  '1. **Never `Read <wikiDir>/index.md` in full** — on a populated wiki it can exceed 256 KB and will exhaust your tool budget. If you must inspect it, `Read` it with `limit: 150`, or `Grep` it for keywords.',
  '2. `Grep <wikiDir>` for the question\'s key terms first (target `summary:` and `tags:` frontmatter). For `[[wikilink]]` / slug→path resolution, prefer the compact catalog at `<wikiDir>/.aab/catalog.json` (small JSON: slug, type, title, summary, tags, path) over the full index.',
  '3. `Read` only the 1-3 most relevant pages, then answer. You have a finite tool-turn budget — do targeted retrieval, don\'t browse.',
  '4. Follow `[[wikilinks]]` only when genuinely useful. Resolve via the catalog; if a slug is missing (stale catalog), `Glob \'**/<slug>.md\'` under the wiki dir — slug uniqueness guarantees ≤1 hit. Block links (`[[slug#section-header]]`) point to a markdown header inside the target page.',
  '',
  '**Web search is the fallback, not the default.** The wiki is what makes your advice specific to THIS user. Only reach for WebSearch/WebFetch to fill gaps the wiki genuinely does not cover (fresh market data, current events). Never give generic advice when the wiki has relevant context.',
  '',
  '**When citing in your response:** put the wiki slugs you actually used into your `sources` field. E.g., `sources: [{"title": "Pricing Strategy", "url": "wiki/concepts/pricing-strategy"}]`. Do not invent slugs you didn\'t read.',
  '',
  '**Never write to the wiki.** The ingest agent owns mutation. If you discover something worth filing, mention it in your `actionSteps` so the user can ingest it. Do not rename slugs — that\'s `aab knowledge rename`\'s job.',
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
    `- **Ground every recommendation in the user's specific situation** — pull from the Knowledge Wiki and business context before answering. Reference what you actually know about them; never give generic advice that ignores their context.`,
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
