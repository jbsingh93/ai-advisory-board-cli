/**
 * Ingest skill prompt. Reference: `PLAN/KNOWLEDGE_WIKI.md` §15.1.
 *
 * The agent reads `wiki/KNOWLEDGE.md`, then `wiki/index.md` (slug-map), then
 * the source at `rawPath`. It creates/updates wiki pages with proper
 * frontmatter and `[[wikilinks]]`, then emits a JSON summary to stdout.
 */

export interface IngestPromptInput {
  rawPath: string;
  /** Forward-slash workspace-relative path of the raw source (for citations). */
  rawRelPath: string;
  wikiKnowledgeMd: string;
  wikiIndexMd: string;
  hintType?: string;
  sourceType: string;
  /** Optional pre-extracted text for sources we know we can give to the model
   *  cheaply (paste, summary). When provided, the agent uses this instead of
   *  re-reading the file. */
  inlineBody?: string;
}

export function buildIngestPrompt(input: IngestPromptInput): string {
  const lines: string[] = [];
  lines.push('You are the wiki ingest agent for an AI advisory-board CLI.');
  lines.push('Your job: read ONE new source and update the user\'s knowledge wiki.');
  lines.push('');
  lines.push('## Source to ingest');
  lines.push(`- Path: \`${input.rawPath}\``);
  lines.push(`- Workspace-relative: \`${input.rawRelPath}\``);
  lines.push(`- Source type: ${input.sourceType}`);
  if (input.hintType) lines.push(`- Suggested page type: ${input.hintType}`);
  lines.push('');
  if (input.inlineBody) {
    lines.push('## Source content (inlined for you)');
    lines.push('');
    lines.push('```');
    lines.push(truncateForPrompt(input.inlineBody, 8000));
    lines.push('```');
    lines.push('');
  }
  lines.push('## Wiki schema (`wiki/KNOWLEDGE.md`)');
  lines.push('');
  lines.push(input.wikiKnowledgeMd);
  lines.push('');
  lines.push('## Current wiki index (`wiki/index.md`)');
  lines.push('');
  lines.push('READ THIS FIRST — the `<!-- AAB:SLUG-MAP -->` section is your `[[wikilink]]` resolver and your cheap-pass page catalog.');
  lines.push('');
  lines.push(input.wikiIndexMd);
  lines.push('');
  lines.push('## Your procedure (follow exactly)');
  lines.push('1. Read the source at the path above (use the `Read` tool, or use the inlined content above if present).');
  lines.push('2. Read the wiki schema above and the wiki index above (the slug-map section is your resolver).');
  lines.push('3. Identify the 3-10 most important claims, entities, concepts, decisions.');
  lines.push('4. For each:');
  lines.push('   - Does a wiki page already exist for it? (Check the slug-map first; fall back to `Glob \'wiki/**/<slug>.md\'`.)');
  lines.push('   - If yes AND its frontmatter does NOT have `userEdited: true`: update the page (merge new info; preserve `[[wikilinks]]`; flag contradictions in body with `^[ambiguous]`).');
  lines.push('   - If yes AND `userEdited: true`: skip — record in the `skipped` field of your output.');
  lines.push('   - If no: create a new page. Pick the right type (concept | entity | decision | source-summary | comparison) and the right folder (`wiki/concepts/`, `wiki/entities/`, `wiki/decisions/`, `wiki/sources/`, `wiki/comparisons/`).');
  lines.push('5. ALWAYS create exactly one `wiki/sources/<humanized-slug>.md` for this source — even if the rest is small. This is the audit trail.');
  lines.push('6. Use `[[wikilinks]]` LIBERALLY in page bodies to connect to existing pages. Every connection compounds value.');
  lines.push('   - Allowed: `[[slug]]`, `[[slug|Display]]`, `[[slug#section-header]]`.');
  lines.push('   - NOT ALLOWED: `[[concepts/foo]]` (path-prefixed), `![[slug]]` (transclusion), `[[slug#^id]]` (block IDs).');
  lines.push('7. Frontmatter contract — every page MUST have:');
  lines.push('   ```yaml');
  lines.push('   ---');
  lines.push('   title: …');
  lines.push('   slug: <matches-filename-minus-md>');
  lines.push('   type: concept|entity|decision|source-summary|comparison');
  lines.push('   summary: ≤200-char one-line synopsis');
  lines.push('   tags: [free-form]');
  lines.push('   sources:');
  lines.push(`     - ${input.rawRelPath}`);
  lines.push('   related:');
  lines.push('     - "[[other-slug]]"');
  lines.push('   confidence: high|medium|low');
  lines.push('   provenance: extracted|inferred|ambiguous');
  lines.push('   created: <yyyy-mm-dd>');
  lines.push('   updated: <yyyy-mm-dd>');
  lines.push('   userEdited: false');
  lines.push('   ---');
  lines.push('   ```');
  lines.push('8. DO NOT touch the `<!-- AAB:SLUG-MAP -->` section in `wiki/index.md` — the orchestrator regenerates it after your run.');
  lines.push('9. DO NOT touch any `<!-- AAB:BACKLINKS -->` section — lint owns those.');
  lines.push('10. Append ONE line to `wiki/log.md` summarising what you wrote: `<iso-timestamp> ingested <rawRelPath> → produced [...]; updated [...]`.');
  lines.push('11. NEVER write secrets, API keys, credentials, or anything that looks like one into a wiki page.');
  lines.push('');
  lines.push('## Output (return ONLY this raw JSON object — no fences, no commentary)');
  lines.push('');
  lines.push('Start with `{`, end with `}`:');
  lines.push('');
  lines.push('{');
  lines.push('  "producedPages": ["wiki/concepts/foo.md", ...],   // newly created pages, workspace-relative paths');
  lines.push('  "updatedPages":  ["wiki/entities/company.md", ...], // existing pages you modified');
  lines.push('  "skipped":       ["wiki/decisions/bar.md", ...],   // userEdited pages you skipped');
  lines.push('  "notes":         "Optional 1-2 sentence summary."');
  lines.push('}');
  return lines.join('\n');
}

function truncateForPrompt(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n\n[…truncated for prompt — read the full file via Read if needed…]';
}
