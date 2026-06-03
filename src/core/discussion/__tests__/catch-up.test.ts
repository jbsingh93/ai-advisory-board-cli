import { describe, expect, it } from 'vitest';
import { buildCatchUpContext, renderSummaryText } from '../catch-up.js';
import type { ConversationSummary, Response } from '../../../storage/types.js';

function mkResponse(name: string): Response {
  return {
    memberId: 'm',
    memberName: name,
    content: 'c',
    timestamp: '',
    order: 1,
    roundNumber: 1,
    turnNumber: 1,
    isFollowUp: false,
    referencedMembers: [],
    sentiment: 'constructive',
    topicTags: [],
  };
}

const HISTORY = [mkResponse('A'), mkResponse('B')];

describe('buildCatchUpContext', () => {
  it('returning/founding member always gets full history regardless of mode', () => {
    const ctx = buildCatchUpContext(false, 'fresh', HISTORY, 'summary text');
    expect(ctx.conversationHistory).toBe(HISTORY);
    expect(ctx.joinCatchUpMode).toBeUndefined();
    expect(ctx.priorRoundsSummary).toBeUndefined();
  });

  it('newcomer + full → full history + full framing', () => {
    const ctx = buildCatchUpContext(true, 'full', HISTORY, undefined);
    expect(ctx.conversationHistory).toBe(HISTORY);
    expect(ctx.joinCatchUpMode).toBe('full');
  });

  it('newcomer + fresh → empty history, fresh framing', () => {
    const ctx = buildCatchUpContext(true, 'fresh', HISTORY, 'ignored');
    expect(ctx.conversationHistory).toEqual([]);
    expect(ctx.joinCatchUpMode).toBe('fresh');
    expect(ctx.priorRoundsSummary).toBeUndefined();
  });

  it('newcomer + summary (with text) → empty history + summary block', () => {
    const ctx = buildCatchUpContext(true, 'summary', HISTORY, 'Key points:\n- x');
    expect(ctx.conversationHistory).toEqual([]);
    expect(ctx.joinCatchUpMode).toBe('summary');
    expect(ctx.priorRoundsSummary).toBe('Key points:\n- x');
  });

  it('newcomer + summary but no summary text → degrades to full history + full framing', () => {
    const ctx = buildCatchUpContext(true, 'summary', HISTORY, undefined);
    expect(ctx.conversationHistory).toBe(HISTORY);
    expect(ctx.joinCatchUpMode).toBe('full');
    expect(ctx.priorRoundsSummary).toBeUndefined();
  });
});

describe('renderSummaryText', () => {
  it('renders key points, consensus, disagreements, insights', () => {
    const summary: ConversationSummary = {
      keyPoints: ['kp1'],
      consensus: ['c1'],
      disagreements: ['d1'],
      actionableInsights: ['a1'],
      participationBreakdown: [],
      overallQuality: 80,
      generatedAt: '',
    };
    const text = renderSummaryText(summary);
    expect(text).toContain('Key points:');
    expect(text).toContain('- kp1');
    expect(text).toContain('Consensus:');
    expect(text).toContain('Open disagreements:');
    expect(text).toContain('Actionable insights so far:');
  });

  it('omits empty sections', () => {
    const summary: ConversationSummary = {
      keyPoints: ['only this'],
      consensus: [],
      disagreements: [],
      actionableInsights: [],
      participationBreakdown: [],
      overallQuality: 50,
      generatedAt: '',
    };
    const text = renderSummaryText(summary);
    expect(text).toContain('Key points:');
    expect(text).not.toContain('Consensus:');
  });
});
