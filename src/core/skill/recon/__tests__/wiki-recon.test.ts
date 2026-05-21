import { describe, expect, it } from 'vitest';
import { parseWikiContext } from '../wiki-recon.js';

describe('parseWikiContext — Planner contract', () => {
  it('returns empty arrays (all 9 tiers) for non-JSON input', () => {
    const c = parseWikiContext('this is just prose, not JSON');
    expect(c.playbooks).toEqual([]);
    expect(c.templates).toEqual([]);
    expect(c.domainKnowledge).toEqual([]);
    expect(c.pastLessons).toEqual([]);
    expect(c.relevantPages).toEqual([]);
    expect(c.stakeholders).toEqual([]);
    expect(c.endorsedDirections).toEqual([]);
    expect(c.vetoes).toEqual([]);
    expect(c.pastDecisions).toEqual([]);
  });

  it('parses a fully-populated proposal', () => {
    const json = JSON.stringify({
      relevantPages: [
        { slug: 'q3-launch', type: 'concept', title: 'Q3 launch', summary: 'Danish SMBs, 3-week runway' },
        { slug: 'mads-larsen', type: 'entity', title: 'Mads Larsen', summary: 'Video editor' },
      ],
      stakeholders: [
        { slug: 'mads-larsen', name: 'Mads Larsen', role: 'video editor', contactHints: 'mads@example.dk' },
      ],
      endorsedDirections: [
        { slug: 'q3-launch', statement: 'Launch videos must hit Danish SMB tone' },
      ],
      vetoes: [
        { slug: 'do-not-contact', statement: 'Never contact Acme Corp' },
      ],
      pastDecisions: [
        { slug: '2026-may-oauth', title: 'OAuth2 PKCE', outcome: 'Adopt PKCE for enterprise tier' },
      ],
    });
    const c = parseWikiContext(json);
    expect(c.relevantPages).toHaveLength(2);
    expect(c.relevantPages[0]).toMatchObject({ slug: 'q3-launch', type: 'concept' });
    expect(c.stakeholders[0]).toMatchObject({ name: 'Mads Larsen', role: 'video editor' });
    expect(c.endorsedDirections[0]!.slug).toBe('q3-launch');
    expect(c.vetoes[0]!.slug).toBe('do-not-contact');
    expect(c.pastDecisions[0]!.outcome).toContain('PKCE');
  });

  it('drops malformed entries instead of throwing', () => {
    const json = JSON.stringify({
      relevantPages: [
        { slug: 'q3-launch', type: 'concept', title: 'Q3 launch', summary: 'ok' },
        { type: 'concept' }, // missing slug + title
        { slug: 'no-type', title: 'oops' }, // missing type
        { slug: 'bad-type', type: 'invalid', title: 'Q3' }, // unknown type
      ],
      stakeholders: [
        { slug: 'ok', name: 'Ok', role: 'something' },
        { slug: 'missing-name', role: 'x' },
        { slug: 'missing-role', name: 'X' },
      ],
    });
    const c = parseWikiContext(json);
    expect(c.relevantPages).toHaveLength(1);
    expect(c.stakeholders).toHaveLength(1);
  });

  it('handles fenced JSON output (markdown fence stripping)', () => {
    const text = '```json\n{ "relevantPages": [{ "slug": "x", "type": "concept", "title": "X", "summary": "y" }] }\n```';
    const c = parseWikiContext(text);
    expect(c.relevantPages).toHaveLength(1);
  });

  // ─── Phase 5.1: Tier 1 KNOWLEDGE slot tests ──────────────────────────

  it('parses playbooks with confidence + FULL body preserved verbatim', () => {
    const fullBody = '## Step 1\nDraft script.\n\n## Step 2\nLoad into Elgato.\n\n## Step 3\nBook practice slot.';
    const json = JSON.stringify({
      playbooks: [
        { slug: 'our-launch-playbook', title: 'Our launch playbook', body: fullBody, confidence: 'high' },
        { slug: 'mid', title: 'Mid', body: 'principles only', confidence: 'medium' },
      ],
    });
    const c = parseWikiContext(json);
    expect(c.playbooks).toHaveLength(2);
    expect(c.playbooks[0]!.body).toBe(fullBody); // FULL body, not truncated
    expect(c.playbooks[0]!.confidence).toBe('high');
    expect(c.playbooks[1]!.confidence).toBe('medium');
  });

  it('parses templates with optional exampleOutput', () => {
    const json = JSON.stringify({
      templates: [
        { slug: 'cta-template', title: 'Our CTA template', body: '...full body...',
          exampleOutput: 'CTA: Start your 7-day trial — no credit card.' },
        { slug: 'no-example', title: 'No example template', body: 'shape only' },
      ],
    });
    const c = parseWikiContext(json);
    expect(c.templates).toHaveLength(2);
    expect(c.templates[0]!.exampleOutput).toContain('7-day trial');
    expect(c.templates[1]!.exampleOutput).toBeUndefined();
  });

  it('parses domainKnowledge + pastLessons', () => {
    const json = JSON.stringify({
      domainKnowledge: [
        { slug: 'tone-guide', title: 'Brand voice', summary: 'casual-direct, no superlatives' },
      ],
      pastLessons: [
        { slug: 'publishat-bug', summary: 'YouTube publishAt drift bug bit us in March',
          actionable: 'Always GET status after PATCH to verify' },
      ],
    });
    const c = parseWikiContext(json);
    expect(c.domainKnowledge).toHaveLength(1);
    expect(c.pastLessons[0]!.actionable).toContain('GET status');
  });

  it('accepts model synonyms (procedures → playbooks, formats → templates, etc.)', () => {
    const json = JSON.stringify({
      procedures: [{ slug: 'p1', title: 'P', body: 'body', confidence: 'high' }],
      formats: [{ slug: 't1', title: 'T', body: 'shape' }],
      knowledge: [{ slug: 'k1', title: 'K', summary: 's' }],
      lessons: [{ slug: 'l1', summary: 's', rule: 'do X next time' }],
    });
    const c = parseWikiContext(json);
    expect(c.playbooks).toHaveLength(1);
    expect(c.templates).toHaveLength(1);
    expect(c.domainKnowledge).toHaveLength(1);
    expect(c.pastLessons[0]!.actionable).toBe('do X next time');
  });

  it('drops Tier 1 entries missing the body (body is load-bearing)', () => {
    const json = JSON.stringify({
      playbooks: [
        { slug: 'no-body', title: 'No body', confidence: 'high' },
        { slug: 'ok', title: 'Ok', body: 'has body', confidence: 'high' },
      ],
      templates: [
        { slug: 'no-body-t', title: 'No body T' },
        { slug: 'ok-t', title: 'Ok T', body: 'shape' },
      ],
    });
    const c = parseWikiContext(json);
    expect(c.playbooks).toHaveLength(1);
    expect(c.playbooks[0]!.slug).toBe('ok');
    expect(c.templates).toHaveLength(1);
    expect(c.templates[0]!.slug).toBe('ok-t');
  });

  it('dedupes by slug across both canonical and synonym fields', () => {
    const json = JSON.stringify({
      playbooks: [{ slug: 'dup', title: 'A', body: 'b', confidence: 'high' }],
      procedures: [{ slug: 'dup', title: 'B-different-title', body: 'b2', confidence: 'low' }],
    });
    const c = parseWikiContext(json);
    expect(c.playbooks).toHaveLength(1);
    expect(c.playbooks[0]!.title).toBe('A'); // first wins
  });

  it('defaults playbook confidence to "medium" when missing or invalid', () => {
    const json = JSON.stringify({
      playbooks: [
        { slug: 'missing', title: 'M', body: 'b' },
        { slug: 'bad', title: 'B', body: 'b', confidence: 'super-high' },
      ],
    });
    const c = parseWikiContext(json);
    expect(c.playbooks[0]!.confidence).toBe('medium');
    expect(c.playbooks[1]!.confidence).toBe('medium');
  });
});
