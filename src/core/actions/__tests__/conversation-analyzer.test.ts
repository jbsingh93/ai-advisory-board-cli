import { describe, expect, it, vi } from 'vitest';
import {
  __test,
  extractActionItems,
  extractFromStructuredData,
  toActionItem,
} from '../conversation-analyzer.js';
import type { AppSettings, Discussion, Response } from '../../../storage/types.js';

const { makeTitle, inferPriority, inferCategory, dedupeByTitle, parseAnalysisResult } = __test;

function response(overrides: Partial<Response> = {}): Response {
  return {
    memberId: overrides.memberId ?? 'm-1',
    memberName: overrides.memberName ?? 'Elon Musk',
    content: overrides.content ?? 'a response',
    timestamp: overrides.timestamp ?? '',
    order: overrides.order ?? 1,
    roundNumber: overrides.roundNumber ?? 1,
    turnNumber: overrides.turnNumber ?? 1,
    isFollowUp: false,
    referencedMembers: [],
    sentiment: 'constructive',
    topicTags: [],
    structuredData: overrides.structuredData,
  };
}

function discussion(responses: Response[] = []): Discussion {
  return {
    id: 'd-1',
    question: 'Should we pivot to DK?',
    responses,
    rounds: [],
    orchestratorState: {
      phase: 'concluded',
      reasoning: '',
      consensusLevel: 0,
      topicExploration: 0,
      repetitionDetected: false,
      shouldContinue: false,
      conversationQuality: 'good',
    },
    totalTurns: 0,
    maxTurns: 10,
    userResponses: [],
    createdAt: '',
  };
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    boardTitle: 'Test',
    maxMembersPerDiscussion: 5,
    maxTurnsPerDiscussion: 10,
    orchestratorPromptStyle: 'balanced',
    autoSummarization: true,
    consensusThreshold: 75,
    enableUserInteraction: true,
    userInteractionTimeout: 30,
    clarificationThreshold: 60,
    primaryModel: 'sonnet',
    fastModel: 'haiku',
    researchModel: 'opus',
    perCallBudgetUsd: undefined,
    locale: 'en',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('makeTitle', () => {
  it('returns empty string for blank input', () => {
    expect(makeTitle('   ')).toBe('');
  });

  it('takes the first sentence-ish chunk', () => {
    expect(makeTitle('Ship the pricing test. Then revisit retention.')).toBe('Ship the pricing test');
  });

  it('truncates long titles with an ellipsis', () => {
    const long = 'A'.repeat(150);
    const t = makeTitle(long);
    expect(t.length).toBeLessThanOrEqual(90);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('inferPriority', () => {
  it('flags urgent words as high', () => {
    expect(inferPriority('This is critical — must ship today')).toBe('high');
    expect(inferPriority('Hotfix the leak ASAP')).toBe('high');
  });

  it('flags soft language as low', () => {
    expect(inferPriority('We could explore this eventually')).toBe('low');
    expect(inferPriority('nice to have, optional')).toBe('low');
  });

  it('defaults to medium', () => {
    expect(inferPriority('Document the onboarding flow')).toBe('medium');
  });
});

describe('inferCategory', () => {
  it('classifies research mentions', () => {
    expect(inferCategory('Investigate competitor pricing')).toBe('research');
  });

  it('classifies technical mentions', () => {
    expect(inferCategory('Ship the API integration')).toBe('technical');
  });

  it('classifies financial mentions', () => {
    expect(inferCategory('Cut burn by 15%')).toBe('financial');
  });

  it('classifies strategic mentions', () => {
    expect(inferCategory('Pivot the roadmap toward enterprise')).toBe('strategic');
  });

  it('classifies operational mentions', () => {
    expect(inferCategory('Hire two onboarding specialists')).toBe('operational');
  });

  it('falls through to other', () => {
    expect(inferCategory('Wear a hat tomorrow')).toBe('other');
  });
});

describe('dedupeByTitle', () => {
  it('drops exact-title duplicates and bumps confidence on convergence', () => {
    const items = [
      {
        title: 'Ship pricing test',
        description: 'a',
        priority: 'high' as const,
        category: 'strategic' as const,
        confidence: 70,
        sourceContext: 'x',
      },
      {
        title: 'ship pricing test',
        description: 'b',
        priority: 'medium' as const,
        category: 'strategic' as const,
        confidence: 60,
        sourceContext: 'y',
      },
    ];
    const out = dedupeByTitle(items);
    expect(out.length).toBe(1);
    expect(out[0]!.confidence).toBeGreaterThan(70); // bumped on second occurrence
  });
});

// ---------------------------------------------------------------------------
// Structured-data fast path
// ---------------------------------------------------------------------------

describe('extractFromStructuredData', () => {
  it('returns [] when no responses carry structuredData', () => {
    const d = discussion([response({ content: 'plain text' })]);
    expect(extractFromStructuredData(d)).toEqual([]);
  });

  it('lifts actionSteps into ExtractedActionItem rows', () => {
    const d = discussion([
      response({
        memberId: 'm-1',
        memberName: 'Elon',
        structuredData: {
          actionSteps: ['Ship the pricing test next quarter', 'Investigate retention drivers'],
          confidence: 80,
        },
      }),
    ]);
    const items = extractFromStructuredData(d);
    expect(items.length).toBe(2);
    expect(items[0]!.sourceContext).toContain('actionSteps');
    expect(items[0]!.sourceMemberName).toBe('Elon');
    expect(items[0]!.confidence).toBeGreaterThanOrEqual(50);
  });

  it('maps questionsForOthers to research-category items at lower confidence', () => {
    const d = discussion([
      response({
        structuredData: {
          questionsForOthers: ['What does competitor X charge?'],
          confidence: 80,
        },
      }),
    ]);
    const items = extractFromStructuredData(d);
    expect(items.length).toBe(1);
    expect(items[0]!.category).toBe('research');
    expect(items[0]!.title.startsWith('Investigate: ')).toBe(true);
  });

  it('dedupes when two members converge on the same actionStep', () => {
    const d = discussion([
      response({
        memberId: 'm-1',
        memberName: 'A',
        structuredData: { actionSteps: ['Hire two onboarding specialists'], confidence: 80 },
      }),
      response({
        memberId: 'm-2',
        memberName: 'B',
        structuredData: { actionSteps: ['Hire two onboarding specialists'], confidence: 80 },
      }),
    ]);
    const items = extractFromStructuredData(d);
    expect(items.length).toBe(1);
    expect(items[0]!.confidence).toBeGreaterThan(80);
  });

  it('caps per-response items', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Step ${i} that needs doing`);
    const d = discussion([response({ structuredData: { actionSteps: many, confidence: 70 } })]);
    const items = extractFromStructuredData(d);
    // Cap is 8 (see MAX_STRUCTURED_ITEMS_PER_RESPONSE).
    expect(items.length).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// extractActionItems — top-level orchestration
// ---------------------------------------------------------------------------

describe('extractActionItems', () => {
  it('chooses the structured path and does not call the LLM when structuredData is present', async () => {
    const llmStub = vi.fn();
    const d = discussion([
      response({
        memberId: 'm-1',
        memberName: 'Elon',
        structuredData: {
          actionSteps: ['Ship pricing test', 'Cut burn by 20%'],
          confidence: 80,
        },
      }),
    ]);
    const result = await extractActionItems({
      discussion: d,
      settings: settings(),
      llm: llmStub as unknown as never,
    });
    expect(result.method).toBe('structured');
    expect(result.actionItems.length).toBe(2);
    expect(llmStub).not.toHaveBeenCalled();
    expect(result.analysisConfidence).toBeGreaterThan(0);
  });

  it('falls back to the LLM when no structuredData is available', async () => {
    const fakeJson = JSON.stringify({
      actionItems: [
        {
          title: 'Draft enterprise SLA',
          description: 'Define 14-day onboarding standard',
          priority: 'high',
          category: 'operational',
          confidence: 88,
          sourceContext: 'CFO bullet',
        },
      ],
      keyInsights: ['Execution speed drives retention'],
      recommendedNextSteps: ['Draft SLA + owners'],
      analysisConfidence: 82,
    });
    const llmStub = vi.fn().mockResolvedValue({
      stdout: fakeJson,
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      json: { result: fakeJson },
    });
    const d = discussion([response({ content: 'Plain text response, no structuredData.' })]);
    const result = await extractActionItems({
      discussion: d,
      settings: settings(),
      llm: llmStub as unknown as never,
    });
    expect(result.method).toBe('llm');
    expect(llmStub).toHaveBeenCalledTimes(1);
    expect(result.actionItems.length).toBe(1);
    expect(result.actionItems[0]!.title).toBe('Draft enterprise SLA');
    expect(result.analysisConfidence).toBe(82);
  });

  it('returns a fallback result with confidence 0 when the LLM throws', async () => {
    const llmStub = vi.fn().mockRejectedValue(new Error('claude offline'));
    const d = discussion([response({ content: 'Plain text response.' })]);
    const result = await extractActionItems({
      discussion: d,
      settings: settings(),
      llm: llmStub as unknown as never,
    });
    expect(result.method).toBe('fallback');
    expect(result.analysisConfidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseAnalysisResult — tolerant of malformed JSON
// ---------------------------------------------------------------------------

describe('parseAnalysisResult', () => {
  it('parses a clean payload', () => {
    const text = JSON.stringify({
      actionItems: [
        {
          title: 'Hire CRO',
          description: 'Bring in a sales leader',
          priority: 'high',
          category: 'operational',
          confidence: 90,
          sourceContext: 'cfo line',
        },
      ],
      keyInsights: ['Sales-led growth needs a CRO'],
      recommendedNextSteps: ['Open the search'],
      analysisConfidence: 85,
    });
    const out = parseAnalysisResult(text);
    expect(out.actionItems.length).toBe(1);
    expect(out.keyInsights[0]).toBe('Sales-led growth needs a CRO');
    expect(out.analysisConfidence).toBe(85);
  });

  it('returns an empty result on unparseable text without throwing', () => {
    const out = parseAnalysisResult('not json at all');
    expect(out.actionItems).toEqual([]);
    expect(out.analysisConfidence).toBe(0);
  });

  it('survives a missing actionItems array', () => {
    const out = parseAnalysisResult('{"keyInsights":["just an insight"]}');
    expect(out.actionItems).toEqual([]);
    expect(out.keyInsights).toEqual(['just an insight']);
  });
});

// ---------------------------------------------------------------------------
// toActionItem
// ---------------------------------------------------------------------------

describe('toActionItem', () => {
  it('converts an extracted candidate into a persistable ActionItem', () => {
    const item = toActionItem(
      {
        title: 'Ship pricing test',
        description: 'Run a 30-day test',
        priority: 'high',
        category: 'strategic',
        confidence: 88,
        sourceContext: 'Elon’s actionSteps',
        suggestedAssignee: 'Pricing team',
        suggestedDueDate: '2 weeks',
      },
      'd-42',
    );
    expect(item.discussionId).toBe('d-42');
    expect(item.title).toBe('Ship pricing test');
    expect(item.priority).toBe('high');
    expect(item.status).toBe('pending');
    expect(item.assignedTo).toBe('Pricing team');
    expect(item.dueDate).toBe('2 weeks');
    expect(item.id.length).toBeGreaterThan(0);
  });

  it('trims overlong titles to the title cap', () => {
    const item = toActionItem(
      {
        title: 'X'.repeat(200),
        description: '',
        priority: 'medium',
        category: 'other',
        confidence: 60,
        sourceContext: '',
      },
      'd-1',
    );
    expect(item.title.length).toBeLessThanOrEqual(90);
  });
});
