/**
 * User-fact merge prompt (Phase 8). Reference:
 * `docs/development/USER_INPUT_INGEST.md` §5.2, `PLAN.md` Part 11.
 *
 * Distinct from `skill-ingest.ts` (document ingest) in three deliberate ways:
 *   1. NO mandatory `wiki/sources/*.md` page — an empty result is valid and
 *      expected when the utterance adds nothing new (that is the whole point:
 *      re-mentions of known facts must not bloat the wiki).
 *   2. Update-biased — prefer extending an existing entity/concept page over
 *      creating a near-duplicate.
 *   3. Framed as PURE first-person user voice (no advisor opinions mixed in),
 *      so extracted facts are high-signal ground truth about the user.
 *
 * Dedup is semantic and per-FACT: the agent reads the current wiki, then for
 * each fact decides create / update (+merge, bump `updated:`) / skip. There is
 * deliberately NO deterministic slug/hash gate — a re-mention of the company
 * name can carry brand-new nuance, and a lexical gate would throw that away.
 *
 * Frontmatter / `[[wikilink]]` / secrets contracts are kept identical to
 * `skill-ingest.ts` so pages stay schema-consistent regardless of which path
 * produced them.
 */

export type UserInputKind =
  | 'initial_question'
  | 'follow_up'
  | 'hitl_response'
  | 'sparring_message'
  | 'coach_message';

export interface UserFactMergePromptInput {
  /** The user's own words (one utterance, or a coalesced burst of them). */
  text: string;
  /** Which surface the utterance came from. Shapes the framing line only. */
  kind: UserInputKind;
  /** Forward-slash workspace-relative path of the raw capture (for citations). */
  rawRelPath: string;
  /** Wiki schema file contents (`wiki/KNOWLEDGE.md`). */
  wikiKnowledgeMd: string;
  /** Wiki index file contents (`wiki/index.md`) — the slug-map / resolver. */
  wikiIndexMd: string;
}

const KIND_FRAMING: Record<UserInputKind, string> = {
  initial_question:
    'This is the question the user opened an advisory-board discussion with. The way they frame it reveals their goals, assumptions, and situation.',
  follow_up:
    'This is a follow-up the user put to their advisory board mid-discussion. It often adds new constraints, facts, or refinements to their situation.',
  hitl_response:
    'This is the user answering a clarifying question the board asked them. It is direct, high-signal ground truth — their stated facts, preferences, and decisions.',
  sparring_message:
    'This is the user talking to one advisor in a private 1:1 deep-dive. It tends to be candid and detailed about their real situation.',
  coach_message:
    "This is the user thinking through a hard decision with their principles-based decision coach. It is candid, reflective, and high-signal about their real situation, values, and what they're weighing.",
};

export function buildUserFactMergePrompt(input: UserFactMergePromptInput): string {
  const lines: string[] = [];
  lines.push('You are the user-fact merge agent for an AI advisory-board CLI.');
  lines.push(
    "Your job: read ONE piece of the user's own input and reconcile it against the user's knowledge wiki — recording ONLY what is genuinely new or changed.",
  );
  lines.push('');

  lines.push('## What you are reading (PURE user voice)');
  lines.push(
    'The text below is the **user speaking in their own first-person words** about themselves and their business — NOT an advisor\'s opinion. Treat it as ground truth about the user.',
  );
  lines.push(KIND_FRAMING[input.kind]);
  lines.push('');
  lines.push('## The user said');
  lines.push('');
  lines.push('```');
  lines.push(truncateForPrompt(input.text, 8000));
  lines.push('```');
  lines.push(`Raw capture (use this exact path in \`sources:\`): \`${input.rawRelPath}\``);
  lines.push('');

  lines.push('## Wiki schema (`wiki/KNOWLEDGE.md`)');
  lines.push('');
  lines.push(input.wikiKnowledgeMd);
  lines.push('');
  lines.push('## Current wiki index (`wiki/index.md`)');
  lines.push('');
  lines.push(
    'READ THIS FIRST — the `<!-- AAB:SLUG-MAP -->` section is your `[[wikilink]]` resolver and your catalog of every existing page.',
  );
  lines.push('');
  lines.push(input.wikiIndexMd);
  lines.push('');

  lines.push('## The core rule: capture NEW knowledge, never duplicate');
  lines.push(
    'The wiki already holds much of what we know about the user. Your value is reconciliation: notice what is genuinely **new or changed** in the text above and fold ONLY that in. The user will mention the same entities (their company, market, customers) over and over — that is expected and is NOT a reason to write anything. Write only when a fact is new, more specific, or updated.',
  );
  lines.push('');
  lines.push('**There is NO source page requirement.** If the text adds nothing the wiki does not already record, write NOTHING and return empty arrays. That is a correct, common outcome — do not invent a page just to have produced something.');
  lines.push('');

  lines.push('## Your procedure (follow exactly)');
  lines.push('1. Read the wiki schema and the index/slug-map above (your resolver + catalog).');
  lines.push('2. Extract the discrete **facts about the user** in the text — who they are, their business/role, products, market, customers, stage, scale, goals, problems, constraints, resources, timelines, ideas, plans, preferences, and decisions made or being weighed.');
  lines.push('3. For EACH fact, before writing anything, find the page it belongs to:');
  lines.push("   - Check the slug-map first; fall back to `Grep` the wiki for the entity/topic, then `Glob 'wiki/**/<slug>.md'`.");
  lines.push('   - **Then `Read` that page** so you can see its current contents before you decide. Never write blind.');
  lines.push('4. Decide per fact:');
  lines.push('   - **Already fully captured** → do nothing (skip the fact silently; it does not go in any output array).');
  lines.push('   - **New fact, page exists** (and page is NOT `userEdited: true`) → **update**: merge the new nuance into the right section of the existing page body (do NOT append a redundant paragraph restating what is already there). Bump `updated:` to today. Add it to `updatedPages`.');
  lines.push('   - **New fact, no page exists** → **create** a new page of the right `type` in the right folder. Add it to `producedPages`. Prefer adding a fact to an existing entity page over creating a brand-new near-duplicate page.');
  lines.push('   - **Conflicts with what the page says** (the user is correcting/updating prior info) → prefer the NEWER user statement: update the value, bump `updated:`, set `provenance: ambiguous`, and mark the superseded claim inline with `^[ambiguous]` so the contradiction is traceable. Never silently delete the old value without a trace. (Distinguish a *correction* — replace — from an *accumulation* like "another competitor is X" — add to the list.)');
  lines.push('   - **Page exists but is `userEdited: true`** → do NOT touch it; record its path in `skipped`.');
  lines.push('5. Pick the right page `type` (concept | entity | decision | source-summary | comparison) and folder (`wiki/concepts/`, `wiki/entities/`, `wiki/decisions/`, `wiki/sources/`, `wiki/comparisons/`). User facts are usually `entity` (the user, their company, key people/products) and `concept`/`decision` (goals, strategies, choices).');
  lines.push('6. Use `[[wikilinks]]` LIBERALLY in page bodies to connect to existing pages. Every connection compounds value.');
  lines.push('   - Allowed: `[[slug]]`, `[[slug|Display]]`, `[[slug#section-header]]`.');
  lines.push('   - NOT ALLOWED: `[[concepts/foo]]` (path-prefixed), `![[slug]]` (transclusion), `[[slug#^id]]` (block IDs).');
  lines.push('7. Frontmatter contract — every page you create or update MUST have:');
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
  lines.push('   When updating an existing page, PRESERVE its `created:`, its existing `[[wikilinks]]`, and any other `sources:` already listed — append the new raw path to `sources:` rather than replacing it.');
  lines.push('8. DO NOT touch the `<!-- AAB:SLUG-MAP -->` section in `wiki/index.md` — the orchestrator regenerates it after your run.');
  lines.push('9. DO NOT touch any `<!-- AAB:BACKLINKS -->` section — lint owns those.');
  lines.push('10. NEVER write secrets, API keys, credentials, passwords, or anything that looks like one into a wiki page.');
  lines.push('');

  lines.push('## Output (return ONLY this raw JSON object — no fences, no commentary)');
  lines.push('');
  lines.push('Start with `{`, end with `}`. Empty arrays are valid and expected when nothing is new:');
  lines.push('');
  lines.push('{');
  lines.push('  "producedPages": ["wiki/entities/foo.md", ...],   // pages you newly created (workspace-relative)');
  lines.push('  "updatedPages":  ["wiki/entities/company.md", ...], // existing pages you merged new facts into');
  lines.push('  "skipped":       ["wiki/decisions/bar.md", ...],   // userEdited pages you left untouched');
  lines.push('  "notes":         "Optional 1-2 sentence summary, or what you judged already-known."');
  lines.push('}');
  return lines.join('\n');
}

function truncateForPrompt(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n\n[…truncated for prompt…]';
}
