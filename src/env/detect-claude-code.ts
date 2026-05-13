/**
 * Heuristics for detecting whether the CLI is running inside Claude Code.
 *
 * The Claude Code harness sets a handful of environment variables prefixed
 * with CLAUDE_CODE_* / CLAUDECODE_* / CLAUDE_*; the exact set varies by
 * version. We treat ANY of these as evidence and fall back to "no".
 */
export interface ClaudeCodeEnv {
  detected: boolean;
  version?: string;
  hints: string[];
}

const HINT_VARS = [
  'CLAUDE_CODE',
  'CLAUDE_CODE_VERSION',
  'CLAUDECODE',
  'CLAUDECODE_VERSION',
  'CLAUDE_AGENT_SDK',
  'CLAUDE_PROJECT_DIR',
];

export function detectClaudeCode(env: NodeJS.ProcessEnv = process.env): ClaudeCodeEnv {
  const hints: string[] = [];
  let version: string | undefined;
  for (const v of HINT_VARS) {
    if (env[v]) {
      hints.push(v);
      if (/VERSION$/.test(v) && !version) version = env[v];
    }
  }
  return { detected: hints.length > 0, version, hints };
}
