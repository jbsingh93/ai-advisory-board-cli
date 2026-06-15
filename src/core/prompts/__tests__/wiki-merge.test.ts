import { describe, it, expect } from 'vitest';
import { buildUserFactMergePrompt, type UserInputKind } from '../wiki-merge.js';

function build(kind: UserInputKind, text = 'Acme sells to SMB retailers.') {
  return buildUserFactMergePrompt({
    text,
    kind,
    rawRelPath: 'raw/user-inputs/2026-06-15-follow_up-acme.md',
    wikiKnowledgeMd: '# Schema\n(schema body)',
    wikiIndexMd: '# Index\n<!-- AAB:SLUG-MAP -->\n(map)',
  });
}

describe('buildUserFactMergePrompt', () => {
  it('frames the input as pure first-person user voice', () => {
    const p = build('initial_question');
    expect(p).toContain('user speaking in their own first-person words');
    expect(p).toContain('NOT an advisor');
  });

  it('includes the user text and the raw citation path', () => {
    const p = build('follow_up', 'We just pivoted to APAC enterprise.');
    expect(p).toContain('We just pivoted to APAC enterprise.');
    expect(p).toContain('raw/user-inputs/2026-06-15-follow_up-acme.md');
  });

  it('mandates reading the page before writing (no blind writes)', () => {
    const p = build('hitl_response');
    expect(p).toContain('Read');
    expect(p).toContain('Never write blind.');
  });

  it('explicitly allows an empty result (no mandatory source page)', () => {
    const p = build('sparring_message');
    expect(p).toContain('NO source page requirement');
    expect(p).toContain('Empty arrays are valid');
  });

  it('encodes the per-fact create/update/skip + conflict contract', () => {
    const p = build('initial_question');
    expect(p).toContain('Already fully captured');
    expect(p).toContain('update');
    expect(p).toContain('^[ambiguous]');
    expect(p).toContain('userEdited: true');
  });

  it('varies the framing line per kind', () => {
    expect(build('initial_question')).toContain('opened an advisory-board discussion');
    expect(build('hitl_response')).toContain('clarifying question');
    expect(build('sparring_message')).toContain('1:1 deep-dive');
  });

  it('forbids path-prefixed wikilinks and secrets', () => {
    const p = build('follow_up');
    expect(p).toContain('NOT ALLOWED: `[[concepts/foo]]`');
    expect(p).toContain('NEVER write secrets');
  });
});
