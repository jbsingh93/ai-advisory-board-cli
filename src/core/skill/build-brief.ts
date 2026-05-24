/**
 * Brief assembly — Phase 5 Chunk 4. Per docs/development/SKILL_CREATOR.md §7.
 *
 * The brief is the JSON payload we send as the user message to a headless
 * skill-creator invocation. It's mostly the Planner's accepted proposal
 * verbatim — skill-creator's job is to author the SKILL.md package
 * matching the brief, not to re-reason about the user's environment.
 *
 * Cap: ≤60 KB total. Truncation priority:
 *   1. webResearch.recentInnovations
 *   2. integration citations
 *   3. webResearch.bestPracticePatterns sources
 *   4. userNarrativeEdits (last — user authorship is precious)
 */
import type { ActionItem, ActionItemSourceContext, ConversationSummary } from '../../storage/types.js';
import type { ResolvedSkillCapabilityProfile } from './planner-review.js';
import type { WikiPlaybook, WikiTemplate, WikiDomainKnowledge, WikiPastLesson } from './recon/wiki-recon.js';

const MAX_BRIEF_BYTES = 60 * 1024;

export interface InstallTarget {
  scope: 'project' | 'user';
  path: string;
  skillName: string;
}

/**
 * Wiki knowledge bundle that travels in the brief with FULL bodies for
 * playbooks + templates so skill-creator can embed them verbatim into the
 * emitted SKILL.md. Phase 5.1 addition — without this skill-creator has
 * no way to bake the user's operating procedures into the skill.
 */
export interface WikiKnowledgeBundle {
  playbooks: WikiPlaybook[];        // FULL body each
  templates: WikiTemplate[];        // FULL body each
  domainKnowledge: WikiDomainKnowledge[];  // summary + excerpt only
  pastLessons: WikiPastLesson[];
}

export interface SkillCreatorBrief {
  action: {
    id: string;
    title: string;
    description: string;
    priority: string;
    /** Provenance snapshot — suggesting member's reasoning + original question. */
    sourceContext?: ActionItemSourceContext;
    linkedDiscussion?: { id: string; summary: ConversationSummary };
  };
  skillPlannerProposal: ResolvedSkillCapabilityProfile['proposal'];
  /**
   * The user's operating knowledge from the wiki — playbooks + templates with
   * FULL bodies, domain knowledge as summaries, past lessons as actionable
   * rules. Skill-creator must embed playbook + template bodies verbatim;
   * see `constraints.wikiKnowledgeIsBakeIn`.
   */
  wikiKnowledge: WikiKnowledgeBundle;
  capabilityProfile: {
    grantedTools: string[];
    acceptedTier: ResolvedSkillCapabilityProfile['acceptedTier'];
    acceptedIntegrationIds: string[];
    acceptedStakeholderNames: string[];
    userNarrativeEdits?: string;
    detectedEnvironment: {
      platform: string;
      mcpServers: string[];
      cliTools: string[];
      envVars: string[];
      chrome: boolean;
      computerUseAvailable: boolean;
    };
  };
  installTarget: InstallTarget;
  constraints: typeof DEFAULT_CONSTRAINTS;
}

export const DEFAULT_CONSTRAINTS = {
  frontmatter: 'Claude Code spec; see when_to_use, allowed-tools, model, etc.',
  bodyMustExecute:
    'Encode the proposed workflow as ordered, executable steps using ONLY the tools in allowed-tools. ' +
    'Do not produce a how-to guide — produce an execution system prompt.',
  invocationHintsAreLoadBearing:
    'For EACH integration in skillPlannerProposal.integrations[], the emitted SKILL.md body MUST include the literal ' +
    'invocationHint.snippet inside a code block. You MAY surround the snippet with context, validation logic, and ' +
    'follow-up steps — but you MUST NOT paraphrase, abbreviate, or rewrite the snippet. The snippet is the contract.',
  wikiKnowledgeIsBakeIn:
    'The wikiKnowledge field carries the USER\'S OPERATING BRAIN — playbooks they have run multiple times, ' +
    'templates they have already proven, domain knowledge only they have, and past lessons they have paid for. ' +
    'These are NOT background hints. Specifically: (1) For each entry in wikiKnowledge.playbooks[], the SKILL.md ' +
    'body must EXECUTE the playbook step-for-step — quote the playbook\'s numbered steps VERBATIM into the body. ' +
    'Do not paraphrase, do not invent alternative workflows, do not soft-reference. The user knows how they want ' +
    'this done. (2) For each entry in wikiKnowledge.templates[], any output-producing step must use the template ' +
    'body VERBATIM as the output shape (substitute placeholders for runtime values only). (3) For each entry in ' +
    'wikiKnowledge.domainKnowledge[], weave the relevant fact into the body where it informs a decision — inline ' +
    'the content, do not just link the page. (4) For each entry in wikiKnowledge.pastLessons[], the lesson\'s ' +
    '`actionable` field must appear in the body as either a MUST NOT line or a preflight check. Cite every wiki ' +
    'entry by slug in the SKILL.md\'s preamble or provenance section so the reader can trace back.',
  fallbacks: 'For each integration with fallbackIfMissing set, emit explicit fallback behavior in the body.',
  stakeholderHandoffs:
    'For each stakeholderTouchpoint where produces=artifact, write the artifact to artifactPath using ' +
    'artifactTemplate verbatim (leave bracketed placeholders unresolved if unknowable at build time). ' +
    'For produces=send, use sendVia exactly as the mcp tool entry.',
  bodySize: '≤500 lines for SKILL.md; everything else in references/ or scripts/.',
  vetoesAreMandatory:
    'For each entry in skillPlannerProposal.vetoes[], emit a MUST NOT line in the SKILL.md body matching the veto exactly.',
  provenanceFooter:
    'Append: > Generated by aab actions solve from action <short-id>; planner tier <tier>; <N> integrations.',
};

export interface BuildBriefOptions {
  action: ActionItem;
  capabilityProfile: ResolvedSkillCapabilityProfile;
  installTarget: InstallTarget;
  discussionSummary?: ConversationSummary;
}

export function buildSkillCreatorBrief(opts: BuildBriefOptions): {
  brief: SkillCreatorBrief;
  bytes: number;
  truncated: string[];
} {
  const cp = opts.capabilityProfile;
  const truncated: string[] = [];

  const brief: SkillCreatorBrief = {
    action: {
      id: opts.action.id,
      title: opts.action.title,
      description: opts.action.description,
      priority: opts.action.priority,
      ...(opts.action.sourceContext ? { sourceContext: opts.action.sourceContext } : {}),
      ...(opts.action.discussionId && opts.discussionSummary
        ? { linkedDiscussion: { id: opts.action.discussionId, summary: opts.discussionSummary } }
        : {}),
    },
    skillPlannerProposal: cp.proposal,
    wikiKnowledge: {
      // FULL bodies — these are the load-bearing entries skill-creator must
      // embed verbatim into the SKILL.md body. Truncation order below
      // preserves these last, after dropping web innovations, citations,
      // relevantPages excerpts, and pastDecisions outcomes.
      playbooks: cp.recon.wiki.playbooks,
      templates: cp.recon.wiki.templates,
      domainKnowledge: cp.recon.wiki.domainKnowledge,
      pastLessons: cp.recon.wiki.pastLessons,
    },
    capabilityProfile: {
      grantedTools: cp.grantedTools,
      acceptedTier: cp.acceptedTier,
      acceptedIntegrationIds: cp.acceptedIntegrationIds,
      acceptedStakeholderNames: cp.acceptedStakeholderNames,
      userNarrativeEdits: cp.userNarrativeEdits,
      detectedEnvironment: {
        platform: cp.recon.pc.platform,
        mcpServers: cp.recon.pc.mcpServers.map((m) => m.name),
        cliTools: cp.recon.pc.cliTools.map((t) => t.name),
        envVars: cp.recon.pc.envVars,
        chrome: cp.recon.pc.chrome,
        computerUseAvailable: cp.recon.pc.computerUseAvailable,
      },
    },
    installTarget: opts.installTarget,
    constraints: DEFAULT_CONSTRAINTS,
  };

  let bytes = Buffer.byteLength(JSON.stringify(brief), 'utf8');
  // Truncation priority order — drop things in order of least load-bearing
  // first. Phase 5.1: wikiKnowledge.playbooks + templates are preserved to
  // the very end because they're THE most load-bearing content (the user's
  // operating brain). Order: web innovations → integration citations →
  // best-practice sources → web app surfaces details → narrative edits →
  // domainKnowledge excerpts → past lessons → templates → playbooks.
  if (bytes > MAX_BRIEF_BYTES) {
    (brief as unknown as { skillPlannerProposal: { recentInnovations?: unknown[] } }).skillPlannerProposal.recentInnovations = [];
    bytes = Buffer.byteLength(JSON.stringify(brief), 'utf8');
    truncated.push('webResearch.recentInnovations');
  }
  if (bytes > MAX_BRIEF_BYTES) {
    for (const i of brief.skillPlannerProposal.integrations) {
      (i as unknown as { citations?: unknown[] }).citations = [];
    }
    bytes = Buffer.byteLength(JSON.stringify(brief), 'utf8');
    truncated.push('integration.citations');
  }
  if (bytes > MAX_BRIEF_BYTES && brief.capabilityProfile.userNarrativeEdits) {
    brief.capabilityProfile.userNarrativeEdits = brief.capabilityProfile.userNarrativeEdits.slice(0, 800) + '…';
    bytes = Buffer.byteLength(JSON.stringify(brief), 'utf8');
    truncated.push('userNarrativeEdits (truncated to first 800 chars)');
  }
  if (bytes > MAX_BRIEF_BYTES) {
    // drop the domainKnowledge excerpts (keep summaries)
    brief.wikiKnowledge.domainKnowledge = brief.wikiKnowledge.domainKnowledge.map((d) => ({
      slug: d.slug, title: d.title, summary: d.summary,
    }));
    bytes = Buffer.byteLength(JSON.stringify(brief), 'utf8');
    truncated.push('wikiKnowledge.domainKnowledge.excerpt');
  }
  if (bytes > MAX_BRIEF_BYTES) {
    // truncate template bodies to first 1500 chars (preserve playbooks fully)
    brief.wikiKnowledge.templates = brief.wikiKnowledge.templates.map((t) => ({
      ...t, body: t.body.length > 1500 ? t.body.slice(0, 1500) + '…' : t.body,
    }));
    bytes = Buffer.byteLength(JSON.stringify(brief), 'utf8');
    truncated.push('wikiKnowledge.templates.body (truncated to 1500 chars each)');
  }
  if (bytes > MAX_BRIEF_BYTES) {
    // last resort — truncate playbook bodies. The user will see this in the
    // truncated[] return value so they know which playbook got cut.
    brief.wikiKnowledge.playbooks = brief.wikiKnowledge.playbooks.map((p) => ({
      ...p, body: p.body.length > 3000 ? p.body.slice(0, 3000) + '… [body truncated by brief assembler]' : p.body,
    }));
    bytes = Buffer.byteLength(JSON.stringify(brief), 'utf8');
    truncated.push('wikiKnowledge.playbooks.body (truncated to 3000 chars each)');
  }
  return { brief, bytes, truncated };
}

/**
 * Render the brief into the wire-shape user message that goes to the
 * `claude -p` call (skill-creator system prompt is added via
 * --append-system-prompt-file). Includes the "print SKILL_CREATOR_DONE
 * when finished" sentinel so we can robustly detect completion in
 * `--output-format stream-json` output.
 */
export function renderUserMessage(brief: SkillCreatorBrief): string {
  return [
    'Author a Claude Code skill matching this brief. Write all files into the current working directory.',
    '',
    'Required output: an installable skill package with SKILL.md at the root + any supporting files',
    `under references/ or scripts/. The skill name MUST be "${brief.installTarget.skillName}".`,
    '',
    'When done, print a single line on its own: SKILL_CREATOR_DONE: ' + brief.installTarget.skillName,
    '',
    'Brief:',
    '```json',
    JSON.stringify(brief, null, 2),
    '```',
  ].join('\n');
}
