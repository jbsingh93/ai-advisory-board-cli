import { describe, expect, it } from 'vitest';
import { buildQueryPrompt } from '../../prompts/skill-query.js';

describe('buildQueryPrompt', () => {
  const base = { question: 'hvem er robin sand?', wikiKnowledgeMd: '# schema', wikiDir: 'wiki', maxPages: 10 };

  it('stays a small fixed size regardless of wiki size (nothing from the wiki is inlined)', () => {
    const prompt = buildQueryPrompt(base);
    // The prompt must not depend on catalog/index content — it should be well
    // under a few KB no matter how large the wiki is.
    expect(prompt.length).toBeLessThan(4_000);
  });

  it('instructs native on-demand retrieval (Grep first, do not read the index whole)', () => {
    const prompt = buildQueryPrompt(base);
    expect(prompt).toContain('Grep wiki/');
    expect(prompt).toContain('.aab/catalog.json');
    expect(prompt).toContain('Never `Read wiki/index.md` in full');
    expect(prompt).toMatch(/most relevant pages/);
  });

  it('embeds the question and the schema', () => {
    const prompt = buildQueryPrompt(base);
    expect(prompt).toContain('hvem er robin sand?');
    expect(prompt).toContain('# schema');
  });

  it('asks for the strict JSON answer/citations contract', () => {
    const prompt = buildQueryPrompt(base);
    expect(prompt).toContain('"answer"');
    expect(prompt).toContain('"citations"');
    expect(prompt).toContain('^[inferred]');
  });
});
