/**
 * Render a Discussion to the terminal.
 */
import type { Discussion, Response } from '../storage/types.js';
import { c, memberColor } from './colors.js';

const HR = c.dim('─'.repeat(72));

export function renderDiscussion(d: Discussion, opts: { round?: number } = {}): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(c.brand('AI Advisory Board') + c.hint(`  · discussion ${shortId(d.id)}`));
  lines.push(HR);
  lines.push(c.bold('Question:'));
  lines.push(`  ${d.question}`);
  lines.push('');

  // Metadata
  const memberCount = new Set(d.responses.map((r) => r.memberId)).size;
  const meta = [
    `${d.rounds.length} round${d.rounds.length === 1 ? '' : 's'}`,
    `${d.totalTurns} turn${d.totalTurns === 1 ? '' : 's'}`,
    `${memberCount} member${memberCount === 1 ? '' : 's'}`,
    d.completedAt ? c.ok('concluded') : d.pendingUserRequest ? c.warn('awaiting input') : c.cyan('open'),
  ];
  lines.push(c.hint(meta.join(' · ')));
  lines.push('');

  const roundsToShow = opts.round
    ? d.rounds.filter((r) => r.roundNumber === opts.round)
    : d.rounds;

  for (const round of roundsToShow) {
    lines.push(c.bold(`▸ Round ${round.roundNumber}`));
    if (round.followUpQuestion) {
      lines.push(c.hint(`  follow-up: ${round.followUpQuestion}`));
    }
    if (round.addedMemberIds && round.addedMemberIds.length > 0) {
      const names = round.addedMemberIds.map((id) => {
        const p = d.participants?.find((x) => x.memberId === id);
        const mode = p?.catchUpMode ? ` via ${p.catchUpMode}` : '';
        return `${p?.name ?? id.slice(0, 8)}${mode}`;
      });
      lines.push(c.green(`  + joined this round: ${names.join(', ')}`));
    }
    lines.push('');

    for (const r of round.responses) {
      lines.push(renderResponse(r));
      lines.push('');
    }

    if (round.orchestratorDecision) {
      const od = round.orchestratorDecision;
      const action =
        od.action === 'conclude'
          ? c.ok(od.action)
          : od.action === 'request_user_input'
            ? c.warn(od.action)
            : od.action === 'redirect'
              ? c.magenta(od.action)
              : c.cyan(od.action);
      lines.push(c.hint(`  orchestrator → ${action}  (confidence ${od.confidence}%)`));
      if (od.reasoning) lines.push(c.hint(`  reason: ${truncate(od.reasoning, 200)}`));
      lines.push('');
    }
  }

  if (d.pendingUserRequest) {
    const r = d.pendingUserRequest;
    lines.push(HR);
    lines.push(c.warn('● The board is asking you a question:'));
    lines.push(`  ${c.bold(r.question)}`);
    if (r.context) lines.push(c.hint(`  ${r.context}`));
    if (r.options && r.options.length > 0) {
      lines.push(c.hint('  options:'));
      r.options.forEach((opt, i) => {
        lines.push(`    ${i + 1}) ${opt}`);
      });
    }
    lines.push(c.hint(`  Reply with: aab discuss respond ${shortId(d.id)} "<your answer>"`));
  }

  return lines.join('\n');
}

function renderResponse(r: Response): string {
  const colour = memberColor(r.memberName);
  const header = `  ${colour('●')} ${c.bold(colour(r.memberName))} ${c.hint('· turn ' + r.turnNumber)}`;
  const body = indent(r.content.trim(), '    ');
  const lines = [header, body];

  const sd = r.structuredData;
  if (sd) {
    if (sd.keyPoints && sd.keyPoints.length > 0) {
      lines.push('');
      lines.push(c.hint('    key points:'));
      for (const p of sd.keyPoints) lines.push(`      • ${p}`);
    }
    if (sd.questionsForOthers && sd.questionsForOthers.length > 0) {
      lines.push('');
      lines.push(c.hint('    questions for others:'));
      for (const q of sd.questionsForOthers) lines.push(`      ? ${q}`);
    }
    if (sd.actionSteps && sd.actionSteps.length > 0) {
      lines.push('');
      lines.push(c.hint('    action steps:'));
      for (const a of sd.actionSteps) lines.push(`      → ${a}`);
    }
    if (typeof sd.confidence === 'number') {
      lines.push('');
      lines.push(c.hint(`    confidence: ${sd.confidence}%`));
    }
  }

  return lines.join('\n');
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
