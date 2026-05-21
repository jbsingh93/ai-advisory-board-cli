#!/usr/bin/env node
/**
 * Mock implementation of the `claude` CLI for hermetic Playwright tests.
 *
 * Supported flags:
 *   --version             → prints `0.0.0-mock` and exits 0.
 *   -p [prompt]           → reads prompt from argv (positional) or stdin.
 *   --output-format json  → emits one JSON envelope to stdout (default).
 *   --output-format stream-json --verbose → emits NDJSON events then a final
 *                           result event, mimicking real stream mode.
 *   --agent <slug>        → recorded but ignored.
 *   --model <id>          → recorded but ignored.
 *
 * Profiles via env `AAB_MOCK_CLAUDE_PROFILE`:
 *   happy-path (default) — every member responds with a canned short bullet
 *                          list, orchestrator returns `continue` for round 1
 *                          and `conclude` for round ≥ 2.
 *   request-user-input   — orchestrator returns `request_user_input` once,
 *                          then `conclude` after the user responds.
 *   conclude-immediately — orchestrator returns `conclude` after round 1.
 *   one-member-fails     — every other member call exits 1 (used by
 *                          `regressions/follow-up-strict-failure`).
 *
 * Counters persist via `AAB_MOCK_CLAUDE_STATE_FILE` (a JSON file written
 * to a temp path by the harness) so the profile can advance across calls.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);

function arg(name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function flag(name) {
  return argv.includes(name);
}

if (flag('--version')) {
  process.stdout.write('0.0.0-mock\n');
  process.exit(0);
}

const profile = process.env.AAB_MOCK_CLAUDE_PROFILE || 'happy-path';
const stateFile = process.env.AAB_MOCK_CLAUDE_STATE_FILE;
const agent = arg('--agent') || '';
const isMember = Boolean(agent);
const wantsStream = arg('--output-format') === 'stream-json';

let state = { callCount: 0, gateConsumed: false };
if (stateFile && existsSync(stateFile)) {
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    /* fresh state */
  }
}
state.callCount = (state.callCount || 0) + 1;

function memberResponseBody(slug) {
  return JSON.stringify({
    response: `Mock response from ${slug || 'member'}. Key consideration: prioritise the smallest reversible step.`,
    structuredData: {
      keyPoints: [
        'Smallest reversible step wins',
        'Optimise for learning, not for being right',
      ],
      questionsForOthers: ['What would make you change your mind?'],
      actionSteps: ['Ship a v0 in one week'],
      confidence: 72,
    },
  });
}

function orchestratorBody() {
  const action =
    profile === 'request-user-input' && !state.gateConsumed
      ? 'request_user_input'
      : profile === 'conclude-immediately' || state.callCount > 8
        ? 'conclude'
        : 'continue';

  if (action === 'request_user_input') {
    state.gateConsumed = true;
    return JSON.stringify({
      action,
      reasoning: 'Need user input to disambiguate scope.',
      consensusReached: false,
      confidence: 60,
      userInputRequest: {
        id: 'mock-req-1',
        type: 'clarification',
        question: 'Should we prioritise revenue or learning in the next sprint?',
        context: 'The members disagree on the primary metric.',
        requestingMembers: [],
        urgency: 'medium',
        createdAt: new Date().toISOString(),
        options: ['Revenue', 'Learning', 'Both'],
      },
    });
  }

  return JSON.stringify({
    action,
    reasoning:
      action === 'conclude'
        ? 'Members converged on the smallest reversible step.'
        : 'Worth one more round to pressure-test assumptions.',
    consensusReached: action === 'conclude',
    confidence: action === 'conclude' ? 85 : 65,
  });
}

if (stateFile) {
  try {
    writeFileSync(stateFile, JSON.stringify(state));
  } catch {
    /* harness handles failure */
  }
}

if (profile === 'one-member-fails' && isMember && state.callCount % 2 === 0) {
  process.stderr.write('mock-claude: synthetic member failure\n');
  process.exit(1);
}

const resultBody = isMember ? memberResponseBody(agent) : orchestratorBody();

const envelope = {
  type: 'result',
  subtype: 'success',
  total_cost_usd: 0.0008,
  is_error: false,
  duration_ms: 50,
  duration_api_ms: 25,
  num_turns: 1,
  result: resultBody,
  session_id: `mock-session-${state.callCount}`,
  usage: {
    input_tokens: 120,
    output_tokens: 60,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 80,
  },
};

if (wantsStream) {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', content: resultBody }) + '\n');
  process.stdout.write(JSON.stringify(envelope) + '\n');
} else {
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

process.exit(0);
