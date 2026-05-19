/**
 * Sparring-injection: write a sparring deep-dive insight back into the main
 * discussion timeline as a UserResponse with `type: 'sparring_injection'`.
 *
 * Ported from sage-council/src/lib/conversation-flow.ts:injectSparringInsight.
 *
 * Semantics: the injected response is attached to the round the user was
 * looking at when they triggered the deep-dive (typically the anchor round).
 * If no round exists yet, we throw. If the target round already has a linked
 * userResponse (e.g. an HITL reply), we preserve it and only set ours when
 * the round has no userResponse yet — matching the source.
 */
import { generateUUID, nowIso } from '../utils.js';
import type {
  Discussion,
  SparringInjectionContext,
  SparringSession,
  StorageService,
  UserResponse,
} from '../../storage/types.js';

export interface InjectSparringInsightOptions {
  discussion: Discussion;
  session: SparringSession;
  insight: string;
  storage: StorageService;
  /** Optional override for the round the injected insight targets.
   *  Defaults to the session's anchor round. */
  sourceRoundNumber?: number;
  /** Optional override for the turn within that round (informational only). */
  sourceTurnNumber?: number;
  /** The user's original sparring trigger input (informational only). */
  sparringTriggerInput?: string;
}

export interface InjectSparringInsightResult {
  discussion: Discussion;
  injectedUserResponse: UserResponse;
}

export async function injectSparringInsight(
  opts: InjectSparringInsightOptions,
): Promise<InjectSparringInsightResult> {
  const trimmedInsight = opts.insight.trim();
  if (!trimmedInsight) {
    throw new Error('Sparring insight cannot be empty');
  }
  if (opts.discussion.rounds.length === 0) {
    throw new Error('No discussion round available to attach injected insight');
  }

  const currentRound = opts.discussion.rounds[opts.discussion.rounds.length - 1]!;
  const targetRoundNumber = opts.sourceRoundNumber ?? opts.session.anchorRoundNumber;
  const sourceRound =
    opts.discussion.rounds.find((round) => round.roundNumber === targetRoundNumber) ?? currentRound;
  const sourceRoundNumber = sourceRound.roundNumber;
  const sourceTurnNumber = opts.sourceTurnNumber ?? opts.session.anchorTurnNumber;

  const injectionContext: SparringInjectionContext = {
    sourceRoundNumber,
    sourceTurnNumber,
    sparringTriggerInput: opts.sparringTriggerInput,
  };

  const injectedUserResponse: UserResponse = {
    id: generateUUID(),
    requestId: `sparring-injection-${opts.discussion.id}-${Date.now()}`,
    content: trimmedInsight,
    timestamp: nowIso(),
    roundNumber: sourceRoundNumber,
    type: 'sparring_injection',
    prompt: `Injected from 1:1 Deep Dive with ${opts.session.memberName}`,
    selectedMemberId: opts.session.memberId,
    sourceRoundNumber: injectionContext.sourceRoundNumber,
    sourceTurnNumber: injectionContext.sourceTurnNumber,
    sparringTriggerInput: injectionContext.sparringTriggerInput,
    sparringSessionId: opts.session.id,
  };

  opts.discussion.userResponses.push(injectedUserResponse);

  if (!sourceRound.userResponse) {
    sourceRound.userResponse = injectedUserResponse;
  }

  await opts.storage.updateDiscussion(opts.discussion);

  return { discussion: opts.discussion, injectedUserResponse };
}
