import { describe, expect, it } from 'vitest';
import { buildSparringUserMessage } from '../build-sparring-prompt.js';
import type {
  AdvisoryBoardMember,
  Discussion,
  SparringMessage,
} from '../../../storage/types.js';

function member(overrides: Partial<AdvisoryBoardMember> = {}): AdvisoryBoardMember {
  return {
    id: overrides.id ?? 'm-1',
    name: overrides.name ?? 'Elon Musk',
    title: overrides.title ?? 'CEO of SpaceX & Tesla',
    expertise: overrides.expertise ?? ['first-principles thinking', 'manufacturing'],
    persona: overrides.persona ?? 'I think from first principles…',
    voiceGuide: overrides.voiceGuide,
    isActive: overrides.isActive ?? true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function discussion(overrides: Partial<Discussion> = {}): Discussion {
  return {
    id: overrides.id ?? 'd-1',
    question: overrides.question ?? 'Should we ship the $50k pivot?',
    responses: overrides.responses ?? [],
    rounds: overrides.rounds ?? [],
    orchestratorState: overrides.orchestratorState ?? {
      phase: 'continuation',
      reasoning: '',
      consensusLevel: 0,
      topicExploration: 0,
      repetitionDetected: false,
      shouldContinue: true,
      conversationQuality: 'good',
    },
    totalTurns: overrides.totalTurns ?? 0,
    maxTurns: overrides.maxTurns ?? 10,
    userResponses: overrides.userResponses ?? [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function message(role: 'user' | 'assistant', content: string): SparringMessage {
  return {
    id: 'msg-' + content.slice(0, 8),
    sessionId: 's-1',
    role,
    content,
    sources: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('buildSparringUserMessage', () => {
  it('includes member identity headers (name, title, expertise, persona)', () => {
    const out = buildSparringUserMessage({
      member: member(),
      discussion: discussion(),
      anchorResponse: 'Original board answer here.',
      history: [],
    });
    expect(out).toContain('Elon Musk');
    expect(out).toContain('CEO of SpaceX & Tesla');
    expect(out).toContain('first-principles thinking, manufacturing');
    expect(out).toContain('I think from first principles');
  });

  it('omits the voice-guide section header when no voiceGuide is set', () => {
    const out = buildSparringUserMessage({
      member: member({ voiceGuide: undefined }),
      discussion: discussion(),
      anchorResponse: 'Anchor.',
      history: [],
    });
    expect(out).not.toContain('## YOUR VOICE GUIDE');
  });

  it('includes the voice-guide section when set', () => {
    const out = buildSparringUserMessage({
      member: member({ voiceGuide: 'Speak in short clipped sentences.' }),
      discussion: discussion(),
      anchorResponse: 'Anchor.',
      history: [],
    });
    expect(out).toContain('## YOUR VOICE GUIDE');
    expect(out).toContain('Speak in short clipped sentences.');
  });

  it('quotes the original discussion question verbatim', () => {
    const out = buildSparringUserMessage({
      member: member(),
      discussion: discussion({ question: 'Where do we go from here?' }),
      anchorResponse: 'Anchor.',
      history: [],
    });
    expect(out).toContain('"Where do we go from here?"');
  });

  it('renders the anchor under "YOUR ORIGINAL BOARD RESPONSE (ANCHOR)"', () => {
    const out = buildSparringUserMessage({
      member: member(),
      discussion: discussion(),
      anchorResponse: 'My original take was X because Y.',
      history: [],
    });
    expect(out).toContain('## YOUR ORIGINAL BOARD RESPONSE (ANCHOR)');
    expect(out).toContain('My original take was X because Y.');
  });

  it('shows the "no prior board responses" line when the discussion has no rounds', () => {
    const out = buildSparringUserMessage({
      member: member(),
      discussion: discussion(),
      anchorResponse: 'Anchor.',
      history: [],
    });
    expect(out).toContain('No prior board responses yet.');
  });

  it('renders rounds with member name + turn number', () => {
    const out = buildSparringUserMessage({
      member: member(),
      discussion: discussion({
        rounds: [
          {
            roundNumber: 1,
            responses: [
              {
                memberId: 'm-1',
                memberName: 'Elon Musk',
                content: 'Pivot now or run out of cash.',
                timestamp: '',
                order: 1,
                roundNumber: 1,
                turnNumber: 1,
                isFollowUp: false,
                referencedMembers: [],
                sentiment: 'constructive',
                topicTags: [],
              },
              {
                memberId: 'm-2',
                memberName: 'Alexandra Chen',
                content: 'Show me the unit economics first.',
                timestamp: '',
                order: 2,
                roundNumber: 1,
                turnNumber: 2,
                isFollowUp: false,
                referencedMembers: [],
                sentiment: 'constructive',
                topicTags: [],
              },
            ],
            orchestratorDecision: {
              action: 'continue',
              reasoning: 'r',
              consensusReached: false,
              confidence: 80,
            },
            startedAt: '',
          },
        ],
      }),
      anchorResponse: 'Anchor.',
      history: [],
    });
    expect(out).toContain('Round 1');
    expect(out).toContain('Elon Musk | Turn 1');
    expect(out).toContain('Alexandra Chen | Turn 2');
    expect(out).toContain('Pivot now or run out of cash.');
  });

  it('renders the sparring history with role prefixes', () => {
    const out = buildSparringUserMessage({
      member: member({ name: 'Julian Bent Singh' }),
      discussion: discussion(),
      anchorResponse: 'Anchor.',
      history: [
        message('user', 'Push back: why now?'),
        message('assistant', 'Because the bridge funding window closes in 14 days.'),
      ],
    });
    expect(out).toContain('User: Push back: why now?');
    expect(out).toContain('Julian Bent Singh: Because the bridge funding window closes in 14 days.');
  });

  it('appends pendingUserMessage to the history as a User turn', () => {
    const out = buildSparringUserMessage({
      member: member(),
      discussion: discussion(),
      anchorResponse: 'Anchor.',
      history: [message('user', 'Earlier'), message('assistant', 'Reply')],
      pendingUserMessage: 'New sharp follow-up',
    });
    expect(out).toContain('User: New sharp follow-up');
    // Order matters — pending must come after history
    expect(out.indexOf('User: New sharp follow-up')).toBeGreaterThan(out.indexOf('User: Earlier'));
  });

  it('truncates a giant discussion context with a marker', () => {
    const giantResponses = Array.from({ length: 200 }, (_, i) => ({
      memberId: 'm-1',
      memberName: 'M',
      content: 'A'.repeat(200) + ` (response ${i})`,
      timestamp: '',
      order: i + 1,
      roundNumber: 1,
      turnNumber: i + 1,
      isFollowUp: false,
      referencedMembers: [],
      sentiment: 'constructive' as const,
      topicTags: [],
    }));
    const out = buildSparringUserMessage({
      member: member(),
      discussion: discussion({
        rounds: [
          {
            roundNumber: 1,
            responses: giantResponses,
            orchestratorDecision: { action: 'continue', reasoning: '', consensusReached: false, confidence: 0 },
            startedAt: '',
          },
        ],
      }),
      anchorResponse: 'Anchor.',
      history: [],
    });
    expect(out).toContain('Discussion context truncated to fit context window');
  });

  it('truncates anchor responses longer than MAX_ANCHOR_RESPONSE_CHARS', () => {
    const giantAnchor = 'X'.repeat(20_000);
    const out = buildSparringUserMessage({
      member: member(),
      discussion: discussion(),
      anchorResponse: giantAnchor,
      history: [],
    });
    expect(out).toContain('Anchor response truncated to fit context window');
  });

  it('emits formatting requirements + the no-JSON wrap directive', () => {
    const out = buildSparringUserMessage({
      member: member(),
      discussion: discussion(),
      anchorResponse: 'A',
      history: [],
    });
    expect(out).toContain('## FORMATTING REQUIREMENTS');
    expect(out).toContain('Use ## and ### headers');
    expect(out).toContain('Use bullet points');
    expect(out).toContain('do NOT wrap your response in JSON');
  });
});
