import { describe, expect, it } from 'vitest';
import { adaptSkillPackage, parseFrontmatter } from '../adapter.js';
import type { EmittedFile } from '../invoke-skill-creator.js';

function skillMd(body: string): EmittedFile {
  return { path: 'SKILL.md', content: body, sizeBytes: body.length };
}

describe('parseFrontmatter', () => {
  it('parses inline arrays', () => {
    const r = parseFrontmatter('---\nname: foo\nallowed-tools: [Write, Bash]\n---\nbody');
    expect(r!.frontmatter.name).toBe('foo');
    expect(r!.frontmatter['allowed-tools']).toEqual(['Write', 'Bash']);
  });

  it('parses block arrays', () => {
    const r = parseFrontmatter('---\nname: foo\nallowed-tools:\n  - Write\n  - Bash\n---\nbody');
    expect(r!.frontmatter['allowed-tools']).toEqual(['Write', 'Bash']);
  });

  it('returns null on missing frontmatter', () => {
    expect(parseFrontmatter('no frontmatter')).toBeNull();
  });
});

describe('adaptSkillPackage', () => {
  it('reconciles allowed-tools against grantedTools (removes extras, adds missing)', () => {
    const original = '---\nname: x\ndescription: Use when ...\nallowed-tools: [Write, Bash, ExtraTool]\n---\nbody';
    const r = adaptSkillPackage({
      files: [skillMd(original)],
      grantedTools: ['Read', 'Write', 'Bash(curl *)'],
      skillName: 'x',
    });
    const final = r.files.find((f) => f.path === 'SKILL.md')!;
    expect(final.content).toContain('- Read');
    expect(final.content).toContain('- Write');
    expect(final.content).toContain('- Bash(curl *)');
    expect(final.content).not.toContain('- ExtraTool');
    expect(r.diff.some((d) => d.includes('ExtraTool'))).toBe(true);
  });

  it('refuses reserved skill names', () => {
    expect(() =>
      adaptSkillPackage({
        files: [skillMd('---\nname: skill-creator\n---\nbody')],
        grantedTools: [],
        skillName: 'skill-creator',
      }),
    ).toThrow(/reserved/i);
  });

  it('prepends "Use when ..." when missing', () => {
    const original = '---\nname: x\ndescription: just describes the skill\nallowed-tools: []\n---\nbody';
    const r = adaptSkillPackage({
      files: [skillMd(original)],
      grantedTools: ['Read'],
      skillName: 'x',
      actionTitle: 'record YouTube intro',
    });
    expect(r.files.find((f) => f.path === 'SKILL.md')!.content).toContain('Use when');
  });

  it('folds sage-council invented keys into the body', () => {
    const original = [
      '---',
      'name: x',
      'description: Use when ...',
      'allowed-tools: []',
      'trigger_queries:',
      '  - foo',
      '  - bar',
      'safety_mode: strict',
      '---',
      'main body',
    ].join('\n');
    const r = adaptSkillPackage({
      files: [skillMd(original)],
      grantedTools: ['Read'],
      skillName: 'x',
    });
    const final = r.files.find((f) => f.path === 'SKILL.md')!.content;
    expect(final).not.toMatch(/^trigger_queries:/m);
    expect(final).toContain('folded by aab actions solve adapter');
    expect(final).toContain('trigger_queries');
  });

  it('scaffolds SKILL.md when skill-creator emitted no SKILL.md', () => {
    const r = adaptSkillPackage({
      files: [{ path: 'references/notes.md', content: 'hello', sizeBytes: 5 }],
      grantedTools: ['Read', 'Write'],
      skillName: 'fallback',
    });
    expect(r.scaffoldedSkillMd).toBe(true);
    const sm = r.files.find((f) => f.path === 'SKILL.md');
    expect(sm).toBeDefined();
    expect(sm!.content).toContain('name: fallback');
    expect(sm!.content).toContain('Use when');
  });

  it('defaults model: inherit when missing', () => {
    const original = '---\nname: x\ndescription: Use when x\nallowed-tools: []\n---\nbody';
    const r = adaptSkillPackage({
      files: [skillMd(original)],
      grantedTools: [],
      skillName: 'x',
    });
    expect(r.files.find((f) => f.path === 'SKILL.md')!.content).toContain('model: inherit');
  });
});
