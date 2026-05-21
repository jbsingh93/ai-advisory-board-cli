import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMemberAgentColor } from '../emit-member-agent.js';

describe('readMemberAgentColor', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'aab-color-'));
    mkdirSync(join(workDir, '.claude', 'agents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function writeAgent(slug: string, body: string): void {
    writeFileSync(join(workDir, '.claude', 'agents', `${slug}.md`), body, 'utf8');
  }

  it('returns undefined when the agent file does not exist', () => {
    expect(readMemberAgentColor('Nobody', workDir)).toBeUndefined();
  });

  it('parses a known color from frontmatter', () => {
    writeAgent(
      'alexandra-chen',
      [
        '---',
        'name: alexandra-chen',
        'description: "Use when needed"',
        'tools: WebSearch',
        'color: orange',
        '---',
        '# AAB:GENERATED',
        '',
        'Body here',
      ].join('\n'),
    );
    expect(readMemberAgentColor('Alexandra Chen', workDir)).toBe('orange');
  });

  it('accepts a quoted color value', () => {
    writeAgent('elon-musk', '---\nname: elon-musk\ncolor: "magenta"\n---\nbody');
    expect(readMemberAgentColor('Elon Musk', workDir)).toBe('magenta');
  });

  it('lowercases the value before matching', () => {
    writeAgent('julian', '---\nname: julian\ncolor: GREEN\n---\nbody');
    expect(readMemberAgentColor('Julian', workDir)).toBe('green');
  });

  it('returns undefined when color is not one of the recognised palette names', () => {
    writeAgent('xy', '---\nname: xy\ncolor: chartreuse\n---\nbody');
    expect(readMemberAgentColor('XY', workDir)).toBeUndefined();
  });

  it('ignores a color: line that appears inside the body, not the frontmatter', () => {
    writeAgent(
      'no-frontmatter-color',
      ['---', 'name: x', 'description: ok', '---', '', 'color: red — discussed in chat'].join('\n'),
    );
    expect(readMemberAgentColor('No Frontmatter Color', workDir)).toBeUndefined();
  });

  it('returns undefined when the file has no frontmatter at all', () => {
    writeAgent('plain', 'just markdown with no fences\ncolor: yellow\n');
    expect(readMemberAgentColor('Plain', workDir)).toBeUndefined();
  });

  it('stops scanning at the closing --- and does not pick up body-level color: lines', () => {
    writeAgent(
      'jane',
      ['---', 'name: jane', 'description: ok', '---', 'color: red', ''].join('\n'),
    );
    expect(readMemberAgentColor('Jane', workDir)).toBeUndefined();
  });
});
