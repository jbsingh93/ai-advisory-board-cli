/**
 * Query skill prompt. Reference: `docs/development/KNOWLEDGE_WIKI.md` §15.2.
 *
 * Read-only — agent uses Read, Grep, Glob. It MUST cite wiki slugs it
 * actually used and mark inferred claims with `^[inferred]`.
 */

export interface QueryPromptInput {
  question: string;
  wikiKnowledgeMd: string;
  /** Capped slice of `wiki/index.md` — only used when no compact catalog exists. */
  wikiIndexMd: string;
  /** Compact catalog JSON (`wiki/.aab/catalog.json`) — preferred over the index. */
  wikiCatalogJson?: string;
  maxPages: number;
}

export function buildQueryPrompt(input: QueryPromptInput): string {
  const lines: string[] = [];
  lines.push('You are the wiki query agent for an AI advisory-board CLI.');
  lines.push('Your job: answer ONE question using the user\'s knowledge wiki, citing the pages you used.');
  lines.push('');
  lines.push('## Question');
  lines.push(input.question);
  lines.push('');
  lines.push('## Wiki schema (`wiki/KNOWLEDGE.md`)');
  lines.push(input.wikiKnowledgeMd);
  lines.push('');
  if (input.wikiCatalogJson) {
    lines.push('## Wiki catalog (`wiki/.aab/catalog.json`)');
    lines.push('');
    lines.push('This compact catalog lists pages (slug, type, title, summary, tags, path). Use it to pick pages and resolve slugs — do NOT `Read wiki/index.md` in full (it can exceed 256 KB). On a large wiki this catalog is **relevance-filtered** to the pages most related to the question (see any `_note`/`_omitted` fields); if what you need is not listed, `Grep`/`Glob` `wiki/` for it rather than assuming it does not exist.');
    lines.push('');
    lines.push('```json');
    lines.push(input.wikiCatalogJson.trim());
    lines.push('```');
  } else {
    lines.push('## Wiki index (`wiki/index.md`, possibly truncated)');
    lines.push('');
    lines.push('The `<!-- AAB:SLUG-MAP -->` section is your `[[wikilink]]` resolver. Do NOT re-`Read` the full index.md (it can exceed 256 KB) — `Grep` it or `Read` with `limit: 150` if you need more.');
    lines.push('');
    lines.push(input.wikiIndexMd);
  }
  lines.push('');
  lines.push('## Your procedure');
  lines.push(`1. From the catalog/index above, identify the most relevant ≤${input.maxPages} pages — do NOT read the full index.md.`);
  lines.push('2. `Grep wiki/` for keywords from the question (target `summary:` and `tags:` first).');
  lines.push('3. `Read` only the relevant pages. Follow `[[wikilinks]]` only when useful.');
  lines.push('4. Synthesize a focused answer.');
  lines.push('5. Mark any claims you inferred (rather than read directly from a page) with `^[inferred]`.');
  lines.push('6. NEVER fabricate page slugs in citations — only cite slugs you actually opened.');
  lines.push('');
  lines.push('## Output (return ONLY this raw JSON object — no fences, no commentary)');
  lines.push('');
  lines.push('{');
  lines.push('  "answer": "<markdown — the answer to the user\'s question, terse and grounded in the wiki>",');
  lines.push('  "citations": ["slug-a", "slug-b", ...],   // wiki slugs you actually used');
  lines.push('  "notes": "Optional 1-line caveat (e.g., \\"wiki contained no info on X\\")."');
  lines.push('}');
  return lines.join('\n');
}
