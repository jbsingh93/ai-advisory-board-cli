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
      wiki: {
        playbooks: [], templates: [], domainKnowledge: [], pastLessons: [],
        relevantPages: [], stakeholders: [], endorsedDirections: [], vetoes: [], pastDecisions: [],
        costUsd: 0,
      },
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

  // ─── Phase 5.1 — wiki knowledge bundle ──────────────────────────────────

  it('wikiKnowledgeIsBakeIn constraint emphasizes verbatim + cite-by-slug', () => {
    expect(DEFAULT_CONSTRAINTS.wikiKnowledgeIsBakeIn).toContain('VERBATIM');
    expect(DEFAULT_CONSTRAINTS.wikiKnowledgeIsBakeIn).toContain('Cite every wiki entry by slug');
    expect(DEFAULT_CONSTRAINTS.wikiKnowledgeIsBakeIn).toContain('OPERATING BRAIN');
  });

  it('propagates wiki Tier 1 knowledge from recon into the brief with FULL bodies', () => {
    const profileWithWiki = profile();
    const fullPlaybookBody = '## Step 1\nDo the thing.\n\n## Step 2\nVerify the thing.\n\n## Step 3\nSend the receipt.';
    const fullTemplateBody = 'Subject: Standard subject line\n\nBody:\nGreeting block\nMiddle block\nCTA block';
    profileWithWiki.recon.wiki = {
      playbooks: [
        { slug: 'our-launch-playbook', title: 'Our launch playbook', body: fullPlaybookBody, confidence: 'high' },
      ],
      templates: [
        { slug: 'cta-template', title: 'Our CTA template', body: fullTemplateBody,
          exampleOutput: 'Sign up — no credit card required.' },
      ],
      domainKnowledge: [
        { slug: 'tone-guide', title: 'Brand voice', summary: 'casual-direct, no superlatives',
          excerpt: 'We always speak in plain Danish business voice...' },
      ],
      pastLessons: [
        { slug: 'publishat-bug', summary: 'YouTube publishAt drift bit us in March',
          actionable: 'Always GET status after PATCH to verify publishAt' },
      ],
      relevantPages: [], stakeholders: [], endorsedDirections: [], vetoes: [], pastDecisions: [],
      costUsd: 0,
    };
    const r = buildSkillCreatorBrief({
      action: action(),
      capabilityProfile: profileWithWiki,
      installTarget: { scope: 'project', path: 'x', skillName: 'x' },
    });
    expect(r.brief.wikiKnowledge.playbooks).toHaveLength(1);
    expect(r.brief.wikiKnowledge.playbooks[0]!.body).toBe(fullPlaybookBody);
    expect(r.brief.wikiKnowledge.templates[0]!.body).toBe(fullTemplateBody);
    expect(r.brief.wikiKnowledge.domainKnowledge[0]!.excerpt).toContain('plain Danish');
    expect(r.brief.wikiKnowledge.pastLessons[0]!.actionable).toContain('GET status');
    expect(r.truncated).toEqual([]); // no truncation for normal bundle
  });

  it('truncation order preserves playbook bodies last (most load-bearing)', () => {
    const profileBig = profile();
    const giantBody = 'x'.repeat(40 * 1024); // 40KB — pushes brief over the 60KB cap
    profileBig.recon.wiki = {
      playbooks: [
        { slug: 'big-playbook', title: 'Big', body: giantBody, confidence: 'high' },
      ],
      templates: [
        { slug: 'big-template', title: 'Big T', body: giantBody },
      ],
      domainKnowledge: [
        { slug: 'big-dk', title: 'DK', summary: 's', excerpt: giantBody },
      ],
      pastLessons: [],
      relevantPages: [], stakeholders: [], endorsedDirections: [], vetoes: [], pastDecisions: [],
      costUsd: 0,
    };
    const r = buildSkillCreatorBrief({
      action: action(),
      capabilityProfile: profileBig,
      installTarget: { scope: 'project', path: 'x', skillName: 'x' },
    });
    // The truncated[] log should list domainKnowledge.excerpt and template
    // bodies BEFORE playbook bodies — playbook is the last-touched tier.
    const truncated = r.truncated.join(' | ');
    expect(truncated).toMatch(/domainKnowledge\.excerpt/);
    // Whatever survives, the playbook bundle still exists (truncated, not dropped).
    expect(r.brief.wikiKnowledge.playbooks).toHaveLength(1);
    expect(r.brief.wikiKnowledge.playbooks[0]!.slug).toBe('big-playbook');
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
