/**
 * `tests/fixtures/mock-claude.ts` — type-only export describing the JSON shape
 * the mock `claude` binary returns. The actual stub binary is implemented in
 * plain JS at `tests/fixtures/mock-claude.mjs` so it can be invoked directly
 * by the spawned subprocess without a build step.
 *
 * Authoring guideline: when you want a test to exercise a specific orchestrator
 * decision (e.g. force `request_user_input`), set the environment variable
 * `AAB_MOCK_CLAUDE_PROFILE=<profile>` before launching the UI server. See
 * `tests/fixtures/mock-claude.mjs` for the available profiles.
 */

export type MockProfile =
  | 'happy-path'
  | 'request-user-input'
  | 'conclude-immediately'
  | 'one-member-fails';

export interface MockClaudeEnvelope {
  type: 'result';
  subtype: 'success' | 'error';
  total_cost_usd: number;
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  /** Stringified JSON the engine parses with `safeJSON()`. */
  result: string;
  session_id: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Path to the stub binary directory (prepended to PATH by tests). */
export const MOCK_BIN_DIR_RELATIVE = 'tests/fixtures/bin';
