/**
 * Source-context resolver — snapshots the discussion provenance for an action
 * item at "add to board" time.
 *
 * Single source of truth shared by every entry point that turns a discussion
 * suggestion into an `ActionItem` (GUI `POST /api/actions`, the extract route,
 * and the CLI `aab actions add --discussion`). Keeping the resolution
 * server-side means the rich context (member reasoning, the original question,
 * key points) is captured even when the caller only knows a member id + the
 * step text — the frontend never has to assemble a fragile payload.
 *
 * The whole point: the Skill Planner used to receive only the one-line step
 * title + "Suggested by <name>". Now it gets the member's actual reasoning and
 * the business question that produced it.
 */
import type {
  ActionItemSourceContext,
  AdvisoryBoardMember,
  Discussion,
  Response,
} from '../../storage/types.js';

const MAX_REASONING_CHARS = 1500;
const MAX_KEY_POINTS = 6;

export interface BuildSourceContextOptions {
  /** Preferred member matcher — the id of the member who suggested the step. */
  memberId?: string;
  /** Fallback matcher when no id is known (e.g. parsed from "Suggested by X"). */
  memberName?: string;
  /** The action step / title text — used to pick the exact response among a
   *  member's multiple turns. Optional; without it we fall back to latest. */
  stepText?: string;
}

/**
 * Resolve the source context for an action item from its originating
 * discussion. Returns `undefined` when there's nothing worth storing (no
 * question and no member match) so callers can omit the field entirely.
 */
export function buildSourceContext(
  discussion: Discussion,
  members: AdvisoryBoardMember[],
  opts: BuildSourceContextOptions,
): ActionItemSourceContext | undefined {
  const response = pickResponse(discussion, opts);
  const member = findMember(members, {
    memberId: opts.memberId ?? response?.memberId,
    memberName: opts.memberName ?? response?.memberName,
  });

  const ctx: ActionItemSourceContext = {};

  const question = discussion.question?.trim();
  if (question) ctx.discussionQuestion = question;

  const memberId = response?.memberId ?? member?.id ?? opts.memberId;
  if (memberId) ctx.memberId = memberId;

  const memberName = response?.memberName ?? member?.name ?? opts.memberName;
  if (memberName) ctx.memberName = memberName;

  const memberTitle = buildMemberTitle(member);
  if (memberTitle) ctx.memberTitle = memberTitle;

  if (response) {
    const reasoning = response.content?.trim();
    if (reasoning) {
      ctx.memberReasoning =
        reasoning.length > MAX_REASONING_CHARS
          ? reasoning.slice(0, MAX_REASONING_CHARS).trimEnd() + '…'
          : reasoning;
    }
    const keyPoints = response.structuredData?.keyPoints?.filter((p) => p && p.trim());
    if (keyPoints && keyPoints.length) {
      ctx.relatedKeyPoints = keyPoints.slice(0, MAX_KEY_POINTS);
    }
    if (typeof response.roundNumber === 'number') ctx.roundNumber = response.roundNumber;
  }

  // Nothing useful to store → let the caller omit the field.
  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

/**
 * All member responses in a discussion. Prefers the canonical flat
 * `discussion.responses` list; falls back to flattening rounds for older or
 * partially-persisted discussions.
 */
function allResponses(discussion: Discussion): Response[] {
  if (discussion.responses && discussion.responses.length > 0) return discussion.responses;
  return (discussion.rounds ?? []).flatMap((r) => r.responses ?? []);
}

/**
 * Pick the response that best explains a given step:
 *   1. Among the matched member's responses, the one whose `actionSteps`
 *      contains the step text (tolerant match — titles get sliced to 200).
 *   2. Else the member's latest response (highest round, then turn/order).
 *   3. Else undefined (member never spoke / no match).
 */
function pickResponse(discussion: Discussion, opts: BuildSourceContextOptions): Response | undefined {
  const responses = allResponses(discussion);
  if (responses.length === 0) return undefined;

  const hasMemberMatcher = Boolean(opts.memberId || opts.memberName);
  const byMember = responses.filter((r) => {
    if (opts.memberId && r.memberId === opts.memberId) return true;
    if (opts.memberName && r.memberName === opts.memberName) return true;
    return false;
  });

  // When a member is named, stay within their responses. When none is named
  // (e.g. CLI `aab actions add --discussion`), search ALL responses so we can
  // infer the author from the step text.
  const pool = hasMemberMatcher ? byMember : responses;
  if (pool.length === 0) return undefined;

  const wantStep = normalize(opts.stepText);
  if (wantStep) {
    const exact = pool.find((r) =>
      (r.structuredData?.actionSteps ?? []).some((s) => stepsMatch(normalize(s), wantStep)),
    );
    if (exact) return exact;
  }

  // No step match: a named member falls back to their latest response; an
  // un-named caller gets no response (we don't want to attribute an arbitrary
  // member's reasoning to a manually-typed step).
  return hasMemberMatcher ? [...pool].sort(latestFirst)[0] : undefined;
}

function latestFirst(a: Response, b: Response): number {
  if ((b.roundNumber ?? 0) !== (a.roundNumber ?? 0)) return (b.roundNumber ?? 0) - (a.roundNumber ?? 0);
  if ((b.turnNumber ?? 0) !== (a.turnNumber ?? 0)) return (b.turnNumber ?? 0) - (a.turnNumber ?? 0);
  return (b.order ?? 0) - (a.order ?? 0);
}

function findMember(
  members: AdvisoryBoardMember[],
  by: { memberId?: string; memberName?: string },
): AdvisoryBoardMember | undefined {
  if (by.memberId) {
    const m = members.find((x) => x.id === by.memberId);
    if (m) return m;
  }
  if (by.memberName) return members.find((x) => x.name === by.memberName);
  return undefined;
}

/** "CFA · capital allocation, risk" — title plus a couple of expertise tags. */
function buildMemberTitle(member: AdvisoryBoardMember | undefined): string | undefined {
  if (!member) return undefined;
  const title = member.title?.trim();
  const expertise = (member.expertise ?? []).filter((e) => e && e.trim()).slice(0, 3);
  if (title && expertise.length) return `${title} · ${expertise.join(', ')}`;
  if (title) return title;
  if (expertise.length) return expertise.join(', ');
  return undefined;
}

function normalize(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

/** Tolerant equality — the shorter string is a prefix of the longer (titles
 *  get truncated to 200 chars on the way into the board). */
function stepsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.startsWith(short) && short.length >= 12;
}
