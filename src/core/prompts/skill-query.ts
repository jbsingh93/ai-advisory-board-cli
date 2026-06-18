/**
 * Query skill prompt. Reference: `docs/development/KNOWLEDGE_WIKI.md` §15.2.
 *
 * Read-only — agent uses Read, Grep, Glob. It MUST cite wiki slugs it
 * actually used and mark inferred claims with `^[inferred]`.
 *
 * Per §15.2 the agent **walks the wiki natively** with its tools. We do NOT
 * inline the catalog or the index — those grow to hundreds of KB on a populated
 * wiki and overflow the model context window ("Prompt is too long"). The prompt
 * stays a fixed small size regardless of wiki size; retrieval is via the tools.
 */

export interface QueryPromptInput {
  question: string;
  wikiKnowledgeMd: string;
  /**
   * Wiki directory the agent should walk (relative to its cwd, which is the
   * workspace root) — e.g. `wiki`. Retrieval is native via Read/Grep/Glob;
   * nothing from the wiki body/catalog is inlined into this prompt.
   */
  wikiDir: string;
  maxPages: number;
}

export function buildQueryPrompt(input: QueryPromptInput): string {
  const dir = input.wikiDir.replace(/\\/g, '/').replace(/\/+$/, '') || 'wiki';
  const lines: string[] = [];
  lines.push('You are the wiki query agent for an AI advisory-board CLI.');
  lines.push("Your job: answer ONE question using the user's knowledge wiki, citing the pages you used.");
  lines.push('');
  lines.push('## Question');
  lines.push(input.question);
  lines.push('');
  lines.push('## Wiki schema (`wiki/KNOWLEDGE.md`)');
  lines.push(input.wikiKnowledgeMd);
  lines.push('');
  lines.push('## How to retrieve - the wiki lives at `' + dir + '/`; walk it with your tools');
  lines.push(
    'The wiki can hold hundreds of pages - do NOT try to read it all, and do NOT expect it inlined here. Retrieve on-demand, within your tool budget:',
  );
  lines.push('1. **`Grep ' + dir + '/` for the key terms in the question first** (entity names, topics). Target `summary:` and `tags:` frontmatter. Try both English and the user\'s own language (e.g. Danish) where relevant.');
  lines.push('2. To resolve a slug to a file path, the compact catalog is at `' + dir + '/.aab/catalog.json` - but it can be large, so `Grep` it for the term rather than `Read`-ing it whole. **Never `Read ' + dir + '/index.md` in full** (it can exceed 256 KB) - `Grep` it or `Read` with `limit: 150`.');
  lines.push('3. `Read` only the ' + input.maxPages + ' or fewer most relevant pages (usually 1-3). Follow `[[wikilinks]]` only when they help answer the question.');
  lines.push('4. Synthesize a focused answer grounded in what you actually read. If the wiki has nothing on the topic, say so plainly in `notes`.');
  lines.push('5. Mark any claims you inferred (rather than read directly from a page) with `^[inferred]`.');
  lines.push('6. NEVER fabricate page slugs in citations - only cite slugs you actually opened.');
  lines.push('');
  lines.push('## Output (return ONLY this raw JSON object - no fences, no commentary)');
  lines.push('');
  lines.push('{');
  lines.push('  "answer": "<markdown - the answer to the user\'s question, terse and grounded in the wiki>",');
  lines.push('  "citations": ["slug-a", "slug-b", ...],   // wiki slugs you actually used');
  lines.push('  "notes": "Optional 1-line caveat (e.g., \\"wiki contained no info on X\\")."');
  lines.push('}');
  return lines.join('\n');
}
