import { describe, expect, it } from 'vitest';
import { parseWikiContext } from '../wiki-recon.js';

describe('parseWikiContext — Planner contract', () => {
  it('returns empty arrays for non-JSON input', () => {
    const c = parseWikiContext('this is just prose, not JSON');
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
});
