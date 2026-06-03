/**
 * Discussion participant snapshot (Phase 7, spec §2.4).
 *
 * `Discussion.participants` is an append-only roster snapshot capturing each
 * member's name/slug/title at join time, so a transcript renders correctly even
 * after the underlying member is renamed or deleted. Legacy discussions predate
 * the field; `ensureParticipants` synthesises it lazily (non-destructive — the
 * synthesised form persists on the discussion's next save).
 */
import { memberAgentSlug } from '../../agents/emit-member-agent.js';
import type { AdvisoryBoardMember, Discussion, DiscussionParticipant } from '../../storage/types.js';

/**
 * Build a participant snapshot for a legacy discussion from `selectedMemberIds`
 * (preferred) or the distinct members seen in `responses`. Resolves
 * name/slug/title from the live members where possible, falling back to the
 * response snapshot for members that no longer exist. All founders get
 * `joinedAtRound: 1`.
 */
export function synthesizeParticipants(
  discussion: Discussion,
  members: AdvisoryBoardMember[],
): DiscussionParticipant[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  // Snapshot of name seen per memberId in the transcript (for deleted members).
  const seenName = new Map<string, string>();
  for (const r of discussion.responses) {
    if (!seenName.has(r.memberId)) seenName.set(r.memberId, r.memberName);
  }

  const ids =
    discussion.selectedMemberIds && discussion.selectedMemberIds.length > 0
      ? discussion.selectedMemberIds
      : [...new Set(discussion.responses.map((r) => r.memberId))];

  const out: DiscussionParticipant[] = [];
  for (const id of ids) {
    const live = byId.get(id);
    const name = live?.name ?? seenName.get(id) ?? 'Unknown member';
    out.push({
      memberId: id,
      name,
      slug: memberAgentSlug(name),
      title: live?.title ?? '',
      joinedAtRound: 1,
    });
  }
  return out;
}

/**
 * Return the discussion's participant snapshot, synthesising + back-filling it
 * in place when absent. Mutates `discussion.participants` so the synthesised
 * form is persisted on the next `saveDiscussion`.
 */
export function ensureParticipants(
  discussion: Discussion,
  members: AdvisoryBoardMember[],
): DiscussionParticipant[] {
  if (discussion.participants && discussion.participants.length > 0) {
    return discussion.participants;
  }
  const synthesized = synthesizeParticipants(discussion, members);
  discussion.participants = synthesized;
  return synthesized;
}

/** Look up a participant snapshot by member id (for render layers). */
export function participantById(
  discussion: Discussion,
  memberId: string,
): DiscussionParticipant | undefined {
  return discussion.participants?.find((p) => p.memberId === memberId);
}
