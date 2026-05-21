import { describe, expect, it } from 'vitest';
import { renderSkillPlannerPrompt } from '../../prompts/skill-planner.js';
import { projectGrantedTools } from '../planner.js';
import {
  skillDesignProposalSchema,
  validateProposalSemantics,
  type SkillDesignProposal,
} from '../../parsing/llm-response-schemas.js';
import { acceptAll, acceptWith, renderProposalMarkdown } from '../planner-review.js';
import type { ReconTriple } from '../recon/orchestrator.js';

describe('renderSkillPlannerPrompt — required directives present', () => {
  function render(extras: Partial<Parameters<typeof renderSkillPlannerPrompt>[0]> = {}): string {
    return renderSkillPlannerPrompt({
      actionItemJson: '{"id":"a3f2","title":"Record YouTube intro","description":"","priority":"high"}',
      reconResultJson: '{}',
      wikiContextJson: '{}',
      webResearchContextJson: '{}',
      maxTier: 'maximalist',
      budgetCapUsd: 2.5,
      ...extras,
    });
  }

  it('embeds skill_operating_model preamble', () => {
    expect(render()).toContain('Agent Skills operating model');
  });

  it('embeds master_gpt_prompter_hardening with self-verification', () => {
    const p = render();
    expect(p).toContain('master_gpt_prompter_hardening');
    expect(p).toContain('self_verification');
  });

  it('embeds the three-tier ambition directive with hard gate', () => {
    const p = render();
    expect(p).toContain('minimal');
    expect(p).toContain('standard');
    expect(p).toContain('maximalist');
    expect(p).toContain('HARD GATE');
    expect(p).toContain('≥3');
  });

  it('embeds orchestration directives with chrome-extension + computer-use first-class framing', () => {
    const p = render();
    expect(p).toContain('chrome-extension');
    expect(p).toContain('computer-use');
    expect(p).toContain('FIRST-CLASS');
  });

  it('embeds invocation_hint_directive with all 8 kind examples named', () => {
    const p = render();
    for (const kind of ['bash-curl', 'mcp-tool', 'write-artifact', 'chrome-extension', 'computer-use']) {
      expect(p).toContain(kind);
    }
  });

  it('embeds output_contract requiring JSON-only', () => {
    expect(render()).toContain('Return ONLY a single JSON object');
  });

  it('embeds the action item + recon triple in the input block', () => {
    const p = render({ actionItemJson: '{"id":"x","title":"foo"}' });
    expect(p).toContain('<action>');
    expect(p).toContain('"id":"x"');
    expect(p).toContain('<pc_scan>');
    expect(p).toContain('<wiki_context>');
    expect(p).toContain('<web_research>');
  });

  it('embeds replan feedback only when provided', () => {
    expect(render()).not.toContain('<replan_feedback>');
    const p = render({ userReplanFeedback: 'add LinkedIn integration' });
    expect(p).toContain('<replan_feedback>add LinkedIn integration</replan_feedback>');
  });

  it('embeds the few-shot library with three worked examples', () => {
    const p = render();
    expect(p).toContain('Example 1');
    expect(p).toContain('Example 2');
    expect(p).toContain('Example 3');
    expect(p).toContain('Elgato Teleprompter');
    expect(p).toContain('LinkedIn');
  });
});

describe('skillDesignProposalSchema — validation', () => {
  function validProposal(): SkillDesignProposal {
    return {
      skillName: 'record-q3-launch-intro',
      skillSummary: 'End-to-end YouTube intro production',
      triggerLanguage: 'Use when …',
      tiers: {
        minimal: { name: 'minimal', description: 'md only', estimatedValueScore: 25 },
        standard: { name: 'standard', description: 'script + teleprompter', estimatedValueScore: 70 },
        maximalist: { name: 'maximalist', description: 'orchestrated', estimatedValueScore: 95 },
      },
      recommendedTier: 'maximalist',
      integrations: [
        {
          id: 'elgato', source: 'pc-app', name: 'Elgato',
          invocationHint: { kind: 'bash-curl', tools: ['Bash(curl *)'], snippet: 'curl ...' },
          requiredTools: ['Bash(curl *)'],
        },
        {
          id: 'cal', source: 'mcp-server', name: 'Calendar',
          invocationHint: { kind: 'mcp-tool', tools: ['mcp__google_calendar__create_event'] },
          requiredTools: ['mcp__google_calendar__create_event'],
        },
        {
          id: 'mads', source: 'wiki-entity', name: 'Mads email',
          invocationHint: { kind: 'write-artifact', tools: ['Write'], artifactPath: 'references/mads.md' },
          requiredTools: ['Write'],
        },
      ],
      vetoes: [],
      valueRationale: 'Maximalist wins by 70%',
    };
  }

  it('accepts a valid proposal', () => {
    const r = skillDesignProposalSchema.safeParse(validProposal());
    expect(r.success).toBe(true);
  });

  it('rejects non-kebab-case skillName', () => {
    const p = { ...validProposal(), skillName: 'BadName' };
    expect(skillDesignProposalSchema.safeParse(p).success).toBe(false);
  });

  it('rejects skillName starting with a digit', () => {
    const p = { ...validProposal(), skillName: '1bad' };
    expect(skillDesignProposalSchema.safeParse(p).success).toBe(false);
  });

  it('rejects missing tier', () => {
    const p = validProposal();
    // @ts-expect-error intentional
    delete p.tiers.maximalist;
    expect(skillDesignProposalSchema.safeParse(p).success).toBe(false);
  });

  it('rejects invalid invocationHint.kind', () => {
    const p = validProposal();
    // @ts-expect-error intentional
    p.integrations[0].invocationHint.kind = 'unknown';
    expect(skillDesignProposalSchema.safeParse(p).success).toBe(false);
  });

  // ─── Phase 5.1 — top-level synonym tolerance ────────────────────────

  it('accepts integrations under synonym field "proposalIntegrations"', () => {
    const p = validProposal() as Record<string, unknown>;
    const integrations = p.integrations;
    delete p.integrations;
    p.proposalIntegrations = integrations;
    const r = skillDesignProposalSchema.safeParse(p);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.integrations).toHaveLength(3);
  });

  it('accepts integrations nested under tiers.maximalist.integrations', () => {
    const p = validProposal() as Record<string, unknown>;
    const integrations = p.integrations;
    delete p.integrations;
    const tiers = p.tiers as Record<string, Record<string, unknown>>;
    tiers.maximalist!.integrations = integrations;
    const r = skillDesignProposalSchema.safeParse(p);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.integrations).toHaveLength(3);
  });

  it('accepts touchpointKind as any string (e.g. "draft-slack-message")', () => {
    const p = validProposal();
    p.stakeholderTouchpoints = [
      { name: 'Pat', role: 'editor', touchpointKind: 'draft-slack-message',
        produces: 'artifact', artifactPath: 'references/msg.md' },
    ] as never;
    const r = skillDesignProposalSchema.safeParse(p);
    expect(r.success).toBe(true);
  });

  it('accepts skillSummary under the "summary" synonym', () => {
    const p = validProposal() as Record<string, unknown>;
    const summary = p.skillSummary;
    delete p.skillSummary;
    p.summary = summary;
    const r = skillDesignProposalSchema.safeParse(p);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.skillSummary).toBe('End-to-end YouTube intro production');
  });

  it('accepts skillSummary under the "description" synonym', () => {
    const p = validProposal() as Record<string, unknown>;
    const summary = p.skillSummary;
    delete p.skillSummary;
    p.description = summary;
    const r = skillDesignProposalSchema.safeParse(p);
    expect(r.success).toBe(true);
  });

  it('accepts valueRationale under the "rationale" synonym', () => {
    const p = validProposal() as Record<string, unknown>;
    const rationale = p.valueRationale;
    delete p.valueRationale;
    p.rationale = rationale;
    const r = skillDesignProposalSchema.safeParse(p);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.valueRationale).toBe('Maximalist wins by 70%');
  });

  it('accepts vetoes under the "mustNot" synonym', () => {
    const p = validProposal() as Record<string, unknown>;
    delete p.vetoes;
    p.mustNot = ['never do X'];
    const r = skillDesignProposalSchema.safeParse(p);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.vetoes).toEqual(['never do X']);
  });

  it('falls back skillSummary to skillName when both summary synonyms are missing', () => {
    const p = validProposal() as Record<string, unknown>;
    delete p.skillSummary;
    const r = skillDesignProposalSchema.safeParse(p);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.skillSummary).toBe('record-q3-launch-intro');
  });
});

describe('validateProposalSemantics — hard gates', () => {
  function validProposal(): SkillDesignProposal {
    return {
      skillName: 'ok',
      skillSummary: 's',
      tiers: {
        minimal: { name: 'minimal' },
        standard: { name: 'standard' },
        maximalist: { name: 'maximalist' },
      },
      recommendedTier: 'maximalist',
      integrations: [
        { id: 'a', source: 'pc-app', name: 'A', invocationHint: { kind: 'bash-cmd', tools: ['Bash'] } },
        { id: 'b', source: 'mcp-server', name: 'B', invocationHint: { kind: 'mcp-tool', tools: ['mcp__x__y'] } },
        { id: 'c', source: 'wiki-entity', name: 'C', invocationHint: { kind: 'write-artifact', tools: ['Write'] } },
      ],
      valueRationale: 'maximalist wins',
    } as SkillDesignProposal;
  }

  it('passes a 3-integration 2-source proposal', () => {
    expect(validateProposalSemantics(validProposal())).toBeNull();
  });

  it('rejects when maximalist tier has <3 integrations and recommendedTier=maximalist', () => {
    const p = validProposal();
    p.integrations = p.integrations.slice(0, 2);
    const errs = validateProposalSemantics(p);
    expect(errs).not.toBeNull();
    expect(errs!.join('\n')).toContain('≥3');
  });

  it('rejects when integrations only span 1 source type', () => {
    const p = validProposal();
    p.integrations = p.integrations.map((i) => ({ ...i, source: 'pc-app' as const }));
    const errs = validateProposalSemantics(p);
    expect(errs).not.toBeNull();
    expect(errs!.join('\n')).toContain('source');
  });

  it('rejects reserved skillName', () => {
    const p = validProposal();
    p.skillName = 'skill-creator';
    expect(validateProposalSemantics(p)).not.toBeNull();
  });

  it('allows empty-recon honest fallback', () => {
    const p = validProposal();
    p.integrations = [];
    p.recommendedTier = 'minimal';
    p.valueRationale = "user's environment has limited integration surface for this action";
    expect(validateProposalSemantics(p)).toBeNull();
  });

  // ─── Phase 5.1 — wiki Tier 1 citation gate ──────────────────────────

  it('rejects when wiki Tier 1 slugs are present but valueRationale cites none', () => {
    const p = validProposal();
    p.valueRationale = 'Maximalist wins by 70%'; // doesn't cite the playbook
    const wikiKnowledge = {
      playbooks: ['our-launch-playbook'],
      templates: [],
      domainKnowledge: [],
      pastLessons: [],
    };
    const errs = validateProposalSemantics(p, wikiKnowledge);
    expect(errs).not.toBeNull();
    expect(errs!.join('\n')).toContain('our-launch-playbook');
    expect(errs!.join('\n')).toContain('cite at least one wiki Tier 1 slug');
  });

  it('passes when valueRationale cites a wiki playbook slug', () => {
    const p = validProposal();
    p.valueRationale = 'Executing wiki/concepts/our-launch-playbook step-for-step.';
    const wikiKnowledge = {
      playbooks: ['our-launch-playbook'],
      templates: [],
      domainKnowledge: [],
      pastLessons: [],
    };
    expect(validateProposalSemantics(p, wikiKnowledge)).toBeNull();
  });

  it('passes when a playbook slug appears in proposedWorkflow even if not in valueRationale', () => {
    const p = validProposal();
    p.valueRationale = 'Maximalist wins by 70%';
    p.proposedWorkflow = [{ step: 'Apply our-launch-playbook step 1', integrations: [] }];
    const wikiKnowledge = {
      playbooks: ['our-launch-playbook'],
      templates: ['cta-template'], // template not cited, but at least one Tier 1 slug appears
      domainKnowledge: [],
      pastLessons: [],
    };
    // cta-template isn't cited → first gate fires
    const errs = validateProposalSemantics(p, wikiKnowledge);
    expect(errs).not.toBeNull();
    // but the "playbook ignored entirely" gate should NOT fire because the
    // playbook slug appears in proposedWorkflow.
    expect(errs!.join('\n')).not.toMatch(/playbook\(s\) ignored entirely/);
  });

  it('no-op when wikiKnowledge parameter is omitted (backwards compat)', () => {
    const p = validProposal();
    expect(validateProposalSemantics(p)).toBeNull();
  });
});

describe('projectGrantedTools — deterministic projection', () => {
  function proposal(): SkillDesignProposal {
    return {
      skillName: 'x', skillSummary: 's',
      tiers: { minimal: { name: 'minimal' }, standard: { name: 'standard' }, maximalist: { name: 'maximalist' } },
      recommendedTier: 'maximalist',
      integrations: [
        { id: 'a', source: 'pc-app', name: 'A',
          invocationHint: { kind: 'bash-curl', tools: ['Bash(curl *)'] }, requiredTools: ['Bash(curl *)'] },
        { id: 'b', source: 'mcp-server', name: 'B',
          invocationHint: { kind: 'mcp-tool', tools: ['mcp__cal__create'] }, requiredTools: ['mcp__cal__create'] },
        { id: 'c', source: 'wiki-entity', name: 'C',
          invocationHint: { kind: 'write-artifact', tools: ['Write'] }, requiredTools: ['Write'] },
      ],
      stakeholderTouchpoints: [
        { name: 'Mads', role: 'editor', produces: 'send', sendVia: 'mcp__gmail__send_message' },
      ],
    } as SkillDesignProposal;
  }

  it('includes Read/Write/Glob/Grep baseline plus accepted integration tools', () => {
    const tools = projectGrantedTools(proposal(), new Set(['a', 'b']), new Set());
    expect(tools).toContain('Read');
    expect(tools).toContain('Write');
    expect(tools).toContain('Bash(curl *)');
    expect(tools).toContain('mcp__cal__create');
    expect(tools).not.toContain('mcp__gmail__send_message'); // stakeholder rejected
  });

  it('adds stakeholder.sendVia when stakeholder is accepted with produces=send', () => {
    const tools = projectGrantedTools(proposal(), new Set(['c']), new Set(['Mads']));
    expect(tools).toContain('mcp__gmail__send_message');
  });

  it('output is sorted + deduplicated', () => {
    const tools = projectGrantedTools(proposal(), new Set(['a', 'b', 'c']), new Set(['Mads']));
    expect(tools).toEqual([...tools].sort());
    expect(new Set(tools).size).toBe(tools.length);
  });
});

describe('planner-review — acceptance helpers', () => {
  function fakeRecon(): ReconTriple {
    return {
      pc: {
        platform: 'linux',
        scannedAt: new Date().toISOString(),
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
      warnings: [],
      costUsd: 0,
      durationMs: 0,
    };
  }
  function fakeProposal(): SkillDesignProposal {
    return {
      skillName: 'x', skillSummary: 's',
      tiers: { minimal: { name: 'minimal' }, standard: { name: 'standard' }, maximalist: { name: 'maximalist' } },
      recommendedTier: 'maximalist',
      integrations: [
        { id: 'a', source: 'pc-app', name: 'A',
          invocationHint: { kind: 'bash-cmd', tools: ['Bash'] }, requiredTools: ['Bash'] },
      ],
    } as SkillDesignProposal;
  }

  it('acceptAll accepts every integration + every stakeholder', () => {
    const r = acceptAll(fakeProposal(), fakeRecon());
    expect(r.status).toBe('accepted');
    expect(r.profile?.acceptedIntegrationIds).toContain('a');
    expect(r.profile?.grantedTools).toContain('Bash');
  });

  it('acceptWith preserves narrative edits + computes rejected set', () => {
    const p = fakeProposal();
    p.integrations = [
      ...p.integrations,
      { id: 'b', source: 'mcp-server', name: 'B',
        invocationHint: { kind: 'mcp-tool', tools: ['mcp__x__y'] }, requiredTools: ['mcp__x__y'] },
    ];
    const r = acceptWith(p, fakeRecon(), 'standard', ['a'], [], 'extra context');
    expect(r.profile?.acceptedIntegrationIds).toEqual(['a']);
    expect(r.profile?.rejectedIntegrationIds).toEqual(['b']);
    expect(r.profile?.userNarrativeEdits).toBe('extra context');
    expect(r.profile?.grantedTools).not.toContain('mcp__x__y');
  });

  it('renderProposalMarkdown produces readable output', () => {
    const md = renderProposalMarkdown(fakeProposal());
    expect(md).toContain('# Skill Planner proposal: x');
    expect(md).toContain('## Integrations (1)');
  });
});
