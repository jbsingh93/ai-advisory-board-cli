/**
 * Render a `Discussion` to a self-contained markdown file.
 *
 * Used by `aab discuss export <id> --md`. Also the source of truth for the
 * `raw/discussions/<short>.md` files that Phase 1.5's auto-ingest hook will
 * write into the wiki workspace — keep this renderer deterministic so the
 * file hashes stay stable across runs (no timestamps in the body, only in
 * the frontmatter).
 */
import slugify from 'slugify';
import type { ConversationSummary, Discussion, Response } from '../storage/types.js';

export function renderDiscussionMarkdown(d: Discussion): string {
  const lines: string[] = [];

  // ---------- Frontmatter ----------
  lines.push('---');
  lines.push(`id: ${d.id}`);
  lines.push(`question: ${yamlString(d.question)}`);
  lines.push(`createdAt: ${d.createdAt}`);
  if (d.completedAt) lines.push(`completedAt: ${d.completedAt}`);
  if (d.archivedAt) lines.push(`archivedAt: ${d.archivedAt}`);
  lines.push(`rounds: ${d.rounds.length}`);
  lines.push(`totalTurns: ${d.totalTurns}`);
  lines.push(`maxTurns: ${d.maxTurns}`);
  if (d.boardName) lines.push(`board: ${yamlString(d.boardName)}`);
  if (d.summary) lines.push(`summaryQuality: ${d.summary.overallQuality}`);
  lines.push('---');
  lines.push('');

  // ---------- Title ----------
  lines.push(`# ${d.question.replace(/\n+/g, ' ')}`);
  lines.push('');

  // ---------- Metadata line ----------
  const status = d.completedAt
    ? 'concluded'
    : d.pendingUserRequest
      ? 'awaiting input'
      : 'open';
  const memberCount = new Set(d.responses.map((r) => r.memberId)).size;
  lines.push(
    `*${d.rounds.length} round${d.rounds.length === 1 ? '' : 's'} · ${d.totalTurns} turn${
      d.totalTurns === 1 ? '' : 's'
    } · ${memberCount} member${memberCount === 1 ? '' : 's'} · ${status}*`,
  );
  lines.push('');

  // ---------- The user's own input ----------
  // Collected up front and clearly labelled so the ingest agent can mine the
  // user's words (their framing, follow-ups, and HITL answers) for durable
  // facts about them and their business — distinct from advisor opinion.
  lines.push(...renderUserInputSection(d));

  // ---------- Summary (if present) ----------
  if (d.summary) {
    lines.push(...renderSummarySection(d.summary));
  }

  // ---------- Rounds ----------
  for (const round of d.rounds) {
    lines.push(`## Round ${round.roundNumber}`);
    if (round.followUpQuestion) {
      lines.push('');
      lines.push(`> **Follow-up:** ${round.followUpQuestion}`);
    }
    if (round.addedMemberIds && round.addedMemberIds.length > 0) {
      const names = round.addedMemberIds.map((id) => {
        const p = d.participants?.find((x) => x.memberId === id);
        const mode = p?.catchUpMode ? ` (caught up via ${p.catchUpMode})` : '';
        return `${p?.name ?? id}${mode}`;
      });
      lines.push('');
      lines.push(`> **+ Joined this round:** ${names.join(', ')}`);
    }
    lines.push('');

    for (const r of round.responses) {
      lines.push(...renderResponseBlock(r));
      lines.push('');
    }

    if (round.orchestratorDecision) {
      const od = round.orchestratorDecision;
      lines.push(`*Orchestrator → \`${od.action}\` (confidence ${od.confidence}%)*`);
      if (od.reasoning) lines.push(`> ${od.reasoning}`);
      if (od.suggestedDirection) lines.push(`> Suggested direction: ${od.suggestedDirection}`);
      lines.push('');
    }

    if (round.userInteractionRequest && round.userResponse) {
      lines.push('### Human-in-the-loop');
      lines.push('');
      lines.push(`> **The board asked:** ${round.userInteractionRequest.question}`);
      if (round.userInteractionRequest.context) {
        lines.push(`> ${round.userInteractionRequest.context}`);
      }
      lines.push('');
      lines.push(`> **You replied:** ${round.userResponse.content}`);
      if (round.userResponse.selectedOption) {
        lines.push(`> (chose option: ${round.userResponse.selectedOption})`);
      }
      lines.push('');
    }
  }

  // ---------- Pending user request (if still open) ----------
  if (d.pendingUserRequest) {
    lines.push('## Awaiting your input');
    lines.push('');
    lines.push(`> ${d.pendingUserRequest.question}`);
    if (d.pendingUserRequest.context) lines.push(`> ${d.pendingUserRequest.context}`);
    if (d.pendingUserRequest.options && d.pendingUserRequest.options.length > 0) {
      lines.push('');
      lines.push('Options:');
      d.pendingUserRequest.options.forEach((opt, i) => {
        lines.push(`${i + 1}. ${opt}`);
      });
    }
    lines.push('');
  }

  // ---------- Footer ----------
  lines.push('---');
  lines.push('');
  lines.push(`*Exported from aab discussion \`${d.id}\`.*`);
  lines.push('');

  return lines.join('\n');
}

function renderUserInputSection(d: Discussion): string[] {
  const out: string[] = [];
  out.push("## The user's input & context");
  out.push('');
  out.push('*The user\'s own words — mine these for durable facts about the user and their business.*');
  out.push('');
  out.push(`- **Question asked:** ${d.question.replace(/\n+/g, ' ').trim()}`);

  // Follow-up questions the user posed in later rounds.
  for (const round of d.rounds) {
    if (round.followUpQuestion && round.followUpQuestion.trim()) {
      out.push(`- **Follow-up (round ${round.roundNumber}):** ${round.followUpQuestion.replace(/\n+/g, ' ').trim()}`);
    }
  }

  // The user's direct replies (initial framing + HITL answers). `userResponses`
  // includes the initial question echo; skip that exact dup, keep the rest.
  const replies = (d.userResponses ?? [])
    .map((r) => (r.content ?? '').trim())
    .filter((c) => c.length > 0 && c !== d.question.trim());
  for (const reply of replies) {
    out.push(`- **User said:** ${reply.replace(/\n+/g, ' ')}`);
  }

  out.push('');
  return out;
}

function renderSummarySection(s: ConversationSummary): string[] {
  const out: string[] = [];
  out.push('## Summary');
  out.push('');
  out.push(`*Generated ${s.generatedAt} · overall quality ${s.overallQuality}/100*`);
  out.push('');

  if (s.keyPoints.length > 0) {
    out.push('### Key points');
    for (const p of s.keyPoints) out.push(`- ${p}`);
    out.push('');
  }
  if (s.consensus.length > 0) {
    out.push('### Consensus');
    for (const p of s.consensus) out.push(`- ${p}`);
    out.push('');
  }
  if (s.disagreements.length > 0) {
    out.push('### Disagreements');
    for (const p of s.disagreements) out.push(`- ${p}`);
    out.push('');
  }
  if (s.actionableInsights.length > 0) {
    out.push('### Actionable insights');
    for (const p of s.actionableInsights) out.push(`- ${p}`);
    out.push('');
  }
  if (s.participationBreakdown.length > 0) {
    out.push('### Participation');
    out.push('');
    out.push('| Member | Responses | Avg length | Influence | Topics |');
    out.push('|---|---:|---:|---:|---|');
    for (const p of s.participationBreakdown) {
      const topics = p.topicsCovered.length > 0 ? p.topicsCovered.join(', ') : '—';
      out.push(
        `| ${escapeTableCell(p.memberName)} | ${p.totalResponses} | ${p.averageLength} | ${p.influence} | ${escapeTableCell(topics)} |`,
      );
    }
    out.push('');
  }

  return out;
}

function renderResponseBlock(r: Response): string[] {
  const lines: string[] = [];
  lines.push(`### ${r.memberName} *(turn ${r.turnNumber})*`);
  lines.push('');
  lines.push(r.content.trim());

  const sd = r.structuredData;
  if (sd) {
    if (sd.keyPoints && sd.keyPoints.length > 0) {
      lines.push('');
      lines.push('**Key points**');
      for (const p of sd.keyPoints) lines.push(`- ${p}`);
    }
    if (sd.questionsForOthers && sd.questionsForOthers.length > 0) {
      lines.push('');
      lines.push('**Questions for others**');
      for (const q of sd.questionsForOthers) lines.push(`- ${q}`);
    }
    if (sd.actionSteps && sd.actionSteps.length > 0) {
      lines.push('');
      lines.push('**Action steps**');
      for (const a of sd.actionSteps) lines.push(`- ${a}`);
    }
    if (typeof sd.confidence === 'number') {
      lines.push('');
      lines.push(`*Confidence: ${sd.confidence}%*`);
    }
  }

  return lines;
}

export function defaultExportFilename(d: Discussion): string {
  const short = d.id.slice(0, 8);
  const slug = slugify(d.question.slice(0, 80), { lower: true, strict: true }) || 'discussion';
  return `${short}-${slug}.md`;
}

function yamlString(value: string): string {
  // Quote and escape — YAML 1.2 double-quoted scalar.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}
