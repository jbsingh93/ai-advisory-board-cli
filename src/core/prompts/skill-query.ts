/**
 * Query skill prompt. Reference: `docs/development/KNOWLEDGE_WIKI.md` §15.2.
 *
 * Read-only — agent uses Read, Grep, Glob. It MUST cite wiki slugs it
 * actually used and mark inferred claims with `^[inferred]`.
 */

export interface QueryPromptInput {
  question: string;
  wikiKnowledgeMd: string;
  wikiIndexMd: string;
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
  lines.push('## Wiki index (`wiki/index.md`)');
  lines.push('');
  lines.push('READ THIS FIRST — the `<!-- AAB:SLUG-MAP -->` section is your `[[wikilink]]` resolver.');
  lines.push('');
  lines.push(input.wikiIndexMd);
  lines.push('');
  lines.push('## Your procedure');
  lines.push(`1. Read the slug-map in the wiki index. Identify the most relevant ≤${input.maxPages} pages.`);
  lines.push('2. `Grep wiki/` for keywords from the question (target `summary:` and `tags:` first).');
  lines.push('3. `Read` the relevant pages. Follow `[[wikilinks]]` only when useful.');
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
