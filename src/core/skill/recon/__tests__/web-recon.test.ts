import { describe, expect, it } from 'vitest';
import { parseGeneral, parseAppSurface, pickTopAppsForResearch } from '../web-recon.js';
import type { DetectedApp } from '../pc-scan.js';

describe('parseGeneral', () => {
  it('returns null on non-JSON input', () => {
    expect(parseGeneral('not json')).toBeNull();
  });

  it('parses full Pass 1 payload', () => {
    const json = JSON.stringify({
      taskDomain: 'YouTube production',
      bestPracticePatterns: [
        { pattern: 'Use teleprompter', rationale: 'reduces re-takes', sources: [{ title: 't', url: 'https://x' }] },
      ],
      recommendedTools: [
        { name: 'Elgato Prompter', category: 'desktop-app', purpose: 'load script', integrationHint: 'port 9012',
          sources: [{ title: 'docs', url: 'https://x' }] },
      ],
      recentInnovations: [
        { name: 'Claude Chrome', summary: 'GA Dec 2025', sources: [{ title: 'b', url: 'https://y' }] },
      ],
      warningsAndPitfalls: ['port collisions when multiple users'],
    });
    const r = parseGeneral(json)!;
    expect(r.taskDomain).toBe('YouTube production');
    expect(r.bestPracticePatterns).toHaveLength(1);
    expect(r.recommendedTools[0]!.category).toBe('desktop-app');
    expect(r.recentInnovations[0]!.name).toBe('Claude Chrome');
    expect(r.warningsAndPitfalls).toContain('port collisions when multiple users');
  });

  it('drops malformed entries', () => {
    const json = JSON.stringify({
      taskDomain: 'x',
      bestPracticePatterns: [
        { pattern: 'ok', rationale: 'fine', sources: [{ title: 't', url: 'https://x' }] },
        { rationale: 'no pattern field', sources: [] },
      ],
      recommendedTools: [{ category: 'cli', name: 'git' }],
      recentInnovations: [],
      warningsAndPitfalls: [],
    });
    const r = parseGeneral(json)!;
    expect(r.bestPracticePatterns).toHaveLength(1);
    expect(r.recommendedTools).toHaveLength(1);
  });
});

describe('parseAppSurface', () => {
  it('parses a populated per-app payload', () => {
    const json = JSON.stringify({
      appName: 'Elgato Teleprompter',
      integrationKind: 'local-http',
      invocationHint: {
        kind: 'bash-curl',
        tools: ['Bash(curl *)'],
        snippet: 'curl -X POST http://localhost:9012/scripts',
      },
      workflow: ['POST script', 'GET /scripts/<id>'],
      risks: ['port collision'],
      sources: [{ title: 'docs', url: 'https://elgato.com/docs' }],
    });
    const r = parseAppSurface(json, 'Elgato Teleprompter')!;
    expect(r.integrationKind).toBe('local-http');
    expect(r.invocationHint.kind).toBe('bash-curl');
    expect(r.invocationHint.tools).toContain('Bash(curl *)');
    expect(r.workflow).toHaveLength(2);
  });

  it('returns null when invocationHint.kind is invalid', () => {
    const json = JSON.stringify({
      appName: 'x',
      integrationKind: 'cli',
      invocationHint: { kind: 'unknown', tools: [] },
    });
    expect(parseAppSurface(json, 'x')).toBeNull();
  });

  it('falls back appName to the probe label', () => {
    const json = JSON.stringify({
      integrationKind: 'none',
      invocationHint: { kind: 'manual-handoff', tools: [] },
      workflow: [],
      risks: [],
      sources: [],
    });
    const r = parseAppSurface(json, 'Fallback Name')!;
    expect(r.appName).toBe('Fallback Name');
  });
});

describe('pickTopAppsForResearch', () => {
  function app(name: string, category?: DetectedApp['category']): DetectedApp {
    return { name, category: category ?? 'other', source: 'manual' };
  }

  it('ranks apps with title-keyword matches higher', () => {
    const apps: DetectedApp[] = [
      app('Elgato Teleprompter', 'creative'),
      app('Random Notes App', 'productivity'),
      app('Slack', 'comms'),
    ];
    const picks = pickTopAppsForResearch(apps, 'Record YouTube intro for Q3 launch', 'Use Elgato Teleprompter', 2);
    expect(picks[0]!.name).toBe('Elgato Teleprompter');
  });

  it('boosts category matches when keywords align with action verbs', () => {
    const apps: DetectedApp[] = [
      app('Photoshop', 'creative'),
      app('Spotify', 'other'),
    ];
    const picks = pickTopAppsForResearch(apps, 'Design banner for landing page', 'Brand creative banner', 3);
    expect(picks[0]!.name).toBe('Photoshop');
  });

  it('returns empty when no apps match', () => {
    const apps: DetectedApp[] = [app('Spotify', 'other')];
    const picks = pickTopAppsForResearch(apps, 'Refactor auth module', undefined, 5);
    expect(picks).toEqual([]);
  });
});
