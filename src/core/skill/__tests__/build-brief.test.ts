import { describe, expect, it } from 'vitest';
import { buildSkillCreatorBrief, renderUserMessage, DEFAULT_CONSTRAINTS } from '../build-brief.js';
import type { ActionItem } from '../../../storage/types.js';
import type { ResolvedSkillCapabilityProfile } from '../planner-review.js';
import type { SkillDesignProposal } from '../../parsing/llm-response-schemas.js';

function action(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: 'a3f2-1234-5678',
    title: 'Record YouTube intro for Q3 launch',
    description: 'Need a 3-minute intro video',
    priority: 'high',
    status: 'pending',
    createdAt: '2026-05-20T00:00:00Z',
    updatedAt: '2026-05-20T00:00:00Z',
    ...overrides,
  };
}

function proposal(): SkillDesignProposal {
  return {
    skillName: 'record-q3-launch-intro',
    skillSummary: 'End-to-end YouTube intro production',
    triggerLanguage: 'Use when …',
    tiers: {
      minimal: { name: 'minimal' },
      standard: { name: 'standard' },
      maximalist: { name: 'maximalist' },
    },
    recommendedTier: 'maximalist',
    integrations: [
      { id: 'elgato', source: 'pc-app', name: 'Elgato',
        invocationHint: { kind: 'bash-curl', tools: ['Bash(curl *)'], snippet: 'curl ...' } },
    ],
    vetoes: [],
    valueRationale: 'great',
  } as SkillDesignProposal;
}

function profile(): ResolvedSkillCapabilityProfile {
  return {
    generatedAt: '2026-05-20T00:00:00Z',
    proposal: proposal(),
    acceptedTier: 'maximalist',
    acceptedIntegrationIds: ['elgato'],
    rejectedIntegrationIds: [],
    acceptedStakeholderNames: [],
    grantedTools: ['Read', 'Write', 'Bash(curl *)'],
    recon: {
      pc: {
        platform: 'linux',
        scannedAt: '2026-05-20T00:00:00Z',
        apps: [], cliTools: [], mcpServers: [], browserExtensions: [],
        envVars: [], existingSkills: [], playwright: false, chrome: false,
        computerUseAvailable: false, warnings: [],
      },
      wiki: { relevantPages: [], stakeholders: [], endorsedDirections: [], vetoes: [], pastDecisions: [], costUsd: 0 },
      web: { taskDomain: 'x', bestPracticePatterns: [], recommendedTools: [], recentInnovations: [],
             warningsAndPitfalls: [], appIntegrationSurfaces: [], webPassesCompleted: { general: true, perAppCount: 0 }, costUsd: 0 },
      warnings: [], costUsd: 0, durationMs: 100,
    },
  };
}

describe('buildSkillCreatorBrief', () => {
  it('embeds the full Planner proposal verbatim', () => {
    const r = buildSkillCreatorBrief({
      action: action(),
      capabilityProfile: profile(),
      installTarget: { scope: 'project', path: '.claude/skills/record-q3-launch-intro/', skillName: 'record-q3-launch-intro' },
    });
    expect(r.brief.skillPlannerProposal.skillName).toBe('record-q3-launch-intro');
    expect(r.brief.skillPlannerProposal.integrations[0]!.id).toBe('elgato');
    expect(r.brief.capabilityProfile.grantedTools).toContain('Bash(curl *)');
    expect(r.brief.installTarget.skillName).toBe('record-q3-launch-intro');
  });

  it('drops the linkedDiscussion field when discussionId is absent', () => {
    const r = buildSkillCreatorBrief({
      action: action({ discussionId: undefined }),
      capabilityProfile: profile(),
      installTarget: { scope: 'project', path: 'x', skillName: 'x' },
    });
    expect(r.brief.action.linkedDiscussion).toBeUndefined();
  });

  it('stays under the 60KB cap on a typical proposal', () => {
    const r = buildSkillCreatorBrief({
      action: action(),
      capabilityProfile: profile(),
      installTarget: { scope: 'project', path: 'x', skillName: 'x' },
    });
    expect(r.bytes).toBeLessThan(60 * 1024);
    expect(r.truncated).toEqual([]);
  });

  it('default constraints emphasize executable + verbatim snippets', () => {
    expect(DEFAULT_CONSTRAINTS.bodyMustExecute).toContain('execution system prompt');
    expect(DEFAULT_CONSTRAINTS.invocationHintsAreLoadBearing).toContain('MUST NOT paraphrase');
    expect(DEFAULT_CONSTRAINTS.invocationHintsAreLoadBearing).toContain('literal');
  });
});

describe('renderUserMessage', () => {
  it('embeds the brief inside a fenced JSON block with completion sentinel', () => {
    const r = buildSkillCreatorBrief({
      action: action(),
      capabilityProfile: profile(),
      installTarget: { scope: 'project', path: '/x', skillName: 'record-q3' },
    });
    const msg = renderUserMessage(r.brief);
    expect(msg).toContain('SKILL_CREATOR_DONE: record-q3');
    expect(msg).toContain('```json');
    expect(msg).toContain('record-q3');
  });
});
