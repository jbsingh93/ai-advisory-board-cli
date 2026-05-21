/**
 * Adapter pass — Phase 5 Chunk 4. Per docs/development/SKILL_CREATOR.md §9.
 *
 * Normalizes skill-creator's emitted SKILL.md frontmatter against the
 * current Claude Code spec. Defense-in-depth: skill-creator usually emits
 * good frontmatter, but bugs happen and the spec evolves. Steps:
 *
 *   1. Parse frontmatter (hand-rolled, matching `src/core/knowledge/page.ts`).
 *   2. Ensure required fields exist (name, description with "Use when …").
 *   3. Cap combined description + when_to_use ≤ 1,536 chars.
 *   4. Reconcile allowed-tools against the user-accepted grantedTools —
 *      add any granted-but-omitted body-referenced tool, remove any
 *      not-granted skill-creator-leaked tool.
 *   5. Fold sage-council-style invented keys into body sections.
 *   6. Default model: inherit when skill-creator didn't pick one.
 *   7. Reserved-name refusal.
 *   8. Produce a diff (skill-creator emit vs adapter result) for the dry-run preview.
 */
import { RESERVED_SKILL_NAMES } from '../parsing/llm-response-schemas.js';
import { UserError } from '../errors.js';
import type { EmittedFile } from './invoke-skill-creator.js';

export interface AdapterOptions {
  files: EmittedFile[];
  /** The deterministic `grantedTools` projection from §6.7. */
  grantedTools: string[];
  /** Required: the user-confirmed skill name. */
  skillName: string;
  /** Optional descriptive context for trigger fallback. */
  actionTitle?: string;
  actionDescription?: string;
}

export interface AdapterResult {
  /** Mutated files array — caller writes these back to the workspace. */
  files: EmittedFile[];
  /** Human-readable diff lines (skill-creator emit → adapter result). */
  diff: string[];
  /** True if the adapter had to inject the missing SKILL.md scaffold. */
  scaffoldedSkillMd: boolean;
  warnings: string[];
}

const SKILL_MD_FILENAMES = new Set(['SKILL.md', 'skill.md']);

const SAGE_INVENTED_KEYS = ['trigger_queries', 'dependencies', 'file_types', 'safety_mode', 'estimated_tokens', 'estimated_time_minutes', 'examples', 'notes'];

export function adaptSkillPackage(opts: AdapterOptions): AdapterResult {
  if (RESERVED_SKILL_NAMES.has(opts.skillName)) {
    throw new UserError(
      `Skill name "${opts.skillName}" is reserved by Anthropic`,
      'Pass --skill-name <other-name> to override the auto-derived slug.',
    );
  }

  const diff: string[] = [];
  const warnings: string[] = [];

  // Locate (or scaffold) SKILL.md.
  let skillMdIdx = opts.files.findIndex((f) => SKILL_MD_FILENAMES.has(f.path));
  let scaffolded = false;
  if (skillMdIdx === -1) {
    scaffolded = true;
    const scaffold = scaffoldSkillMd(opts.skillName, opts.grantedTools, opts.actionTitle, opts.actionDescription);
    opts.files.push({ path: 'SKILL.md', content: scaffold, sizeBytes: scaffold.length });
    skillMdIdx = opts.files.length - 1;
    diff.push('+ SKILL.md (scaffolded by adapter — skill-creator did not emit one)');
  }

  const skillMd = opts.files[skillMdIdx]!;
  const parsed = parseFrontmatter(skillMd.content);
  if (!parsed) {
    // No frontmatter at all — wrap the existing body.
    const wrapped = scaffoldSkillMd(opts.skillName, opts.grantedTools, opts.actionTitle, opts.actionDescription) +
      '\n\n' + skillMd.content;
    skillMd.content = wrapped;
    skillMd.sizeBytes = wrapped.length;
    diff.push('+ Frontmatter scaffold (body had none)');
    return { files: opts.files, diff, scaffoldedSkillMd: scaffolded || true, warnings };
  }

  const before = JSON.stringify(parsed.frontmatter);

  // (1) name
  if (!parsed.frontmatter.name) {
    parsed.frontmatter.name = opts.skillName;
    diff.push(`+ frontmatter name: ${opts.skillName}`);
  } else if (parsed.frontmatter.name !== opts.skillName) {
    diff.push(`~ frontmatter name: ${parsed.frontmatter.name} → ${opts.skillName}`);
    parsed.frontmatter.name = opts.skillName;
  }

  // (2) description — must include "Use when …" trigger language
  const description = String(parsed.frontmatter.description ?? '');
  if (!description.trim()) {
    parsed.frontmatter.description = `Use when ${opts.actionTitle ?? opts.skillName}. ${opts.actionDescription ?? ''}`.trim();
    diff.push('+ frontmatter description (was missing)');
  } else if (!/^use when /i.test(description) && !/use when/i.test(description.slice(0, 80))) {
    parsed.frontmatter.description = `Use when ${opts.actionTitle ?? opts.skillName}. ${description}`;
    diff.push('~ frontmatter description: prepended "Use when …"');
  }

  // (3) cap description + when_to_use ≤ 1,536 chars combined
  const combinedLen = String(parsed.frontmatter.description ?? '').length + String(parsed.frontmatter.when_to_use ?? '').length;
  if (combinedLen > 1536) {
    const wtu = String(parsed.frontmatter.when_to_use ?? '');
    const trimmed = wtu.slice(0, Math.max(0, 1536 - String(parsed.frontmatter.description ?? '').length - 24)) + ' [trimmed]';
    parsed.frontmatter.when_to_use = trimmed;
    diff.push(`~ frontmatter when_to_use: trimmed to fit 1536-char combined cap`);
  }

  // (4) allowed-tools reconciliation
  const existingTools = coerceTools(parsed.frontmatter['allowed-tools']);
  const granted = new Set(opts.grantedTools);
  const reconciled = Array.from(granted).sort();
  const removed = existingTools.filter((t) => !granted.has(t));
  const added = reconciled.filter((t) => !existingTools.includes(t));
  if (removed.length > 0) diff.push(`- allowed-tools: ${removed.join(', ')}`);
  if (added.length > 0) diff.push(`+ allowed-tools: ${added.join(', ')}`);
  parsed.frontmatter['allowed-tools'] = reconciled;

  // (5) fold sage-council-style invented keys into the body
  const invented: Record<string, unknown> = {};
  for (const key of SAGE_INVENTED_KEYS) {
    if (key in parsed.frontmatter) {
      invented[key] = parsed.frontmatter[key];
      delete parsed.frontmatter[key];
      diff.push(`- frontmatter ${key} (folded into body)`);
    }
  }

  // (6) default model
  if (!parsed.frontmatter.model) {
    parsed.frontmatter.model = 'inherit';
    diff.push('+ frontmatter model: inherit');
  }

  // Re-emit the file.
  let newBody = parsed.body;
  if (Object.keys(invented).length > 0) {
    const inventedSection = [
      '',
      '<!-- folded by aab actions solve adapter — these keys are not in the current Claude Code spec -->',
      ...Object.entries(invented).map(([k, v]) => `- **${k}:** ${JSON.stringify(v)}`),
      '',
    ].join('\n');
    newBody = inventedSection + newBody;
  }

  skillMd.content = serializeWithFrontmatter(parsed.frontmatter, newBody);
  skillMd.sizeBytes = skillMd.content.length;

  // (7) body-size warning
  const lineCount = newBody.split(/\r?\n/).length;
  if (lineCount > 500) {
    warnings.push(`SKILL.md body is ${lineCount} lines (> 500 target — consider moving content to references/).`);
  }

  // Diff completeness — no-op if frontmatter unchanged
  if (JSON.stringify(parsed.frontmatter) === before && diff.length === 0) {
    diff.push('(no changes)');
  }

  return { files: opts.files, diff, scaffoldedSkillMd: scaffolded, warnings };
}

// ---------- frontmatter parser (hand-rolled — minimal YAML) ----------

interface ParsedSkillMd {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(raw: string): ParsedSkillMd | null {
  const m = raw.match(FM_RE);
  if (!m) return null;
  const block = m[1] ?? '';
  const body = raw.slice(m[0].length);
  const fm: Record<string, unknown> = {};
  let i = 0;
  const lines = block.split(/\r?\n/);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1]!;
    const rest = (kv[2] ?? '').trim();
    if (rest === '') {
      // block array or block scalar
      const block: string[] = [];
      i++;
      while (i < lines.length && /^\s+-\s/.test(lines[i] ?? '')) {
        block.push((lines[i] ?? '').replace(/^\s+-\s/, '').trim());
        i++;
      }
      if (block.length > 0) fm[key] = block;
      else {
        // multi-line scalar (block style with `|`)
        // Not commonly used here; leave as empty.
        fm[key] = '';
      }
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      // inline array
      fm[key] = rest.slice(1, -1).split(',').map((s) => stripQuotes(s.trim())).filter(Boolean);
    } else {
      fm[key] = stripQuotes(rest);
    }
    i++;
  }
  return { frontmatter: fm, body };
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function serializeWithFrontmatter(fm: Record<string, unknown>, body: string): string {
  const lines: string[] = ['---'];
  const FIELD_ORDER = ['name', 'description', 'when_to_use', 'allowed-tools', 'paths', 'model', 'disable-model-invocation', 'version'];
  const seen = new Set<string>();
  for (const key of FIELD_ORDER) {
    if (!(key in fm)) continue;
    emit(key, fm[key], lines);
    seen.add(key);
  }
  for (const [key, value] of Object.entries(fm)) {
    if (seen.has(key)) continue;
    emit(key, value, lines);
  }
  lines.push('---');
  return lines.join('\n') + '\n' + body;
}

function emit(key: string, value: unknown, out: string[]): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    out.push(`${key}:`);
    for (const v of value) out.push(`  - ${String(v)}`);
    return;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    out.push(`${key}: ${value}`);
    return;
  }
  const s = String(value);
  if (s.includes('\n')) {
    out.push(`${key}: |`);
    for (const line of s.split('\n')) out.push(`  ${line}`);
    return;
  }
  out.push(`${key}: ${s}`);
}

function coerceTools(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function scaffoldSkillMd(name: string, tools: string[], actionTitle?: string, actionDescription?: string): string {
  const lines = [
    '---',
    `name: ${name}`,
    `description: Use when ${actionTitle ?? name}. ${actionDescription ?? ''}`.trim(),
    'allowed-tools:',
    ...tools.map((t) => `  - ${t}`),
    'model: inherit',
    '---',
    '',
    `# ${name}`,
    '',
    'Workflow:',
    '',
    '<!-- Adapter scaffold — skill-creator did not produce SKILL.md. Add body manually. -->',
    '',
  ];
  return lines.join('\n');
}
