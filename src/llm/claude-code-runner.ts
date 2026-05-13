/**
 * Claude Code runner.
 *
 * Instead of calling the Anthropic API directly, the CLI shells out to the
 * `claude` binary. This means the user's existing Claude Max/Pro subscription
 * is the LLM — no API key, no extra cost.
 *
 * Pattern (borrowed from aiagentorg's heartbeat.sh):
 *   claude --agent <slug> -p "<prompt>" --output-format json \
 *          --model sonnet --allowedTools "Read,WebSearch,..."
 *
 * For one-shot calls without a sub-agent (e.g., orchestrator decisions or
 * business-context extraction) we omit `--agent`, which gives a fresh Claude
 * Code session with just the prompt + allowed tools.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { ModelError, NetworkError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import type { ClaudeModel } from '../storage/types.js';

export type ClaudeAlias = 'opus' | 'sonnet' | 'haiku' | 'inherit';

export interface RunOptions {
  /** The prompt to send. Required. */
  prompt: string;
  /** Sub-agent slug (matches a `.claude/agents/<slug>.md` filename). */
  agent?: string;
  /** Model alias or full id (passed through to `claude --model`). */
  model?: ClaudeAlias | ClaudeModel | string;
  /** Tool allowlist passed via --allowedTools (comma-separated). */
  allowedTools?: string[];
  /** Max conversation turns inside the spawned session. */
  maxTurns?: number;
  /** Per-call dollar budget passed via --max-budget-usd. */
  maxBudgetUsd?: number;
  /** Working directory for the spawn (defaults to cwd). */
  cwd?: string;
  /** External AbortSignal — kills the spawned process when triggered. */
  signal?: AbortSignal;
  /** Wall-clock timeout in ms (default 5 min). */
  timeoutMs?: number;
  /** Extra environment variables to set on the child process. */
  env?: Record<string, string>;
  /**
   * Pass `--dangerously-skip-permissions` to bypass Claude Code's trust /
   * permission prompts. Safe in our case because each sub-agent's
   * `.claude/agents/<slug>.md` already restricts `tools:` to a read/web
   * allowlist — even with permissions skipped, the agent cannot execute
   * write/edit/bash. Default: true (we always run non-interactively).
   */
  dangerouslySkipPermissions?: boolean;
  /**
   * Stream incremental events from the `claude` CLI (uses
   * `--output-format stream-json --verbose` under the hood) and invoke
   * `onEvent` once per line. Each event is the parsed JSON object the CLI
   * printed. The final `result` event has the same shape as the
   * non-streaming JSON envelope, so callers can keep using `result.json`.
   *
   * When `onEvent` is provided we automatically use streaming mode; pass
   * `streaming: false` to opt out even if a callback is supplied.
   */
  onEvent?: (event: ClaudeStreamEvent) => void;
  streaming?: boolean;
}

/**
 * One event from `claude --output-format stream-json`. The CLI emits one
 * JSON object per line. We model the bits we care about; everything else is
 * preserved on the index signature for telemetry.
 */
export interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    id?: string;
    model?: string;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
    }>;
  };
  result?: string;
  cost_usd?: number;
  usage?: ClaudeJsonEnvelope['usage'];
  num_turns?: number;
  is_error?: boolean;
  [key: string]: unknown;
}

export interface RunResult {
  /** Raw concatenated stdout. */
  stdout: string;
  /** Concatenated stderr (typically empty on success). */
  stderr: string;
  /** Exit code from the `claude` process. */
  exitCode: number;
  /** When --output-format json, the parsed JSON envelope. */
  json?: ClaudeJsonEnvelope;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

/**
 * Shape of `claude --output-format json` output (the bits we use).
 */
export interface ClaudeJsonEnvelope {
  type?: string;
  subtype?: string;
  /** Final assistant message text (this is what we want for member responses). */
  result?: string;
  /** Per-call cost in USD. */
  cost_usd?: number;
  /** Token usage breakdown. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** Number of turns the agent took. */
  num_turns?: number;
  /** Anything else the CLI emits — preserved for telemetry. */
  [key: string]: unknown;
}

/**
 * Detection result for the `claude` CLI.
 */
export interface ClaudeCliInfo {
  installed: boolean;
  path?: string;
  version?: string;
  error?: string;
}

/**
 * Detect the local `claude` CLI by running `claude --version`. Doesn't throw.
 */
export async function detectClaudeCli(): Promise<ClaudeCliInfo> {
  try {
    const { stdout, exitCode } = await spawnRaw('claude', ['--version'], {
      timeoutMs: 5_000,
    });
    if (exitCode !== 0) {
      return { installed: false, error: `claude --version exited ${exitCode}` };
    }
    const version = parseVersion(stdout);
    return { installed: true, version };
  } catch (error) {
    return { installed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseVersion(text: string): string | undefined {
  const m = text.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
  return m?.[1];
}

/**
 * Run one `claude` invocation. Throws ModelError / NetworkError on failure.
 */
export async function runClaude(opts: RunOptions): Promise<RunResult> {
  const args: string[] = [];
  const streaming = opts.streaming !== false && !!opts.onEvent;

  // sub-agent or fresh session
  if (opts.agent) args.push('--agent', opts.agent);

  // prompt mode
  args.push('-p', opts.prompt);

  // structured output: stream-json (line-delimited events) when we want to
  // surface tool-use events live; plain json otherwise.
  if (streaming) {
    args.push('--output-format', 'stream-json', '--verbose');
  } else {
    args.push('--output-format', 'json');
  }

  // model
  if (opts.model) args.push('--model', opts.model);

  // tools allowlist
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push('--allowedTools', opts.allowedTools.join(','));
  }

  // max turns
  if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns));

  // budget cap
  if (opts.maxBudgetUsd) args.push('--max-budget-usd', String(opts.maxBudgetUsd));

  // bypass trust + permission prompts (default true; the agent file's
  // tools allowlist already prevents the sub-agent from writing/editing/etc.)
  if (opts.dangerouslySkipPermissions !== false) {
    args.push('--dangerously-skip-permissions');
  }

  logger.debug('[claude]', 'spawn', { args: args.slice(0, 4), agent: opts.agent, model: opts.model });

  const result = await spawnRaw('claude', args, {
    cwd: opts.cwd,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
    env: opts.env,
    onLine: streaming && opts.onEvent
      ? (line) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) return;
          try {
            const evt = JSON.parse(trimmed) as ClaudeStreamEvent;
            opts.onEvent!(evt);
          } catch {
            // Ignore malformed lines — we only consume well-formed JSON.
          }
        }
      : undefined,
  });

  if (result.exitCode !== 0) {
    const stderrTrim = result.stderr.trim();
    const stdoutTrim = result.stdout.trim();
    if (/timeout|aborted|EAGAIN|ETIMEDOUT/i.test(stderrTrim)) {
      throw new NetworkError(`claude CLI timed out: ${stderrTrim}`);
    }
    if (/dangerously|permission|trust|approve/i.test(stderrTrim)) {
      throw new ModelError(
        `claude CLI permission error: ${stderrTrim}`,
        "The CLI runs claude with --dangerously-skip-permissions by default. If your Claude Code install is rejecting it, run `claude` once interactively in this directory to set up trust.",
      );
    }
    throw new ModelError(
      `claude CLI exited ${result.exitCode}: ${stderrTrim || stdoutTrim || 'no output'}`,
      'Run `aab doctor` to verify claude is installed and working. Re-run with `aab --debug discuss start ...` to see the spawn args.',
    );
  }

  // Surface non-fatal stderr at debug level (claude prints various warnings here)
  if (result.stderr.trim()) {
    logger.debug('[claude] stderr:', result.stderr.trim().slice(0, 500));
  }

  // Parse final result envelope.
  //   - Non-streaming mode: stdout is one JSON object.
  //   - Streaming mode: stdout is line-delimited; the last `{type:"result"...}`
  //     line carries the same shape we want.
  let json: ClaudeJsonEnvelope | undefined;
  const trimmed = result.stdout.trim();
  if (streaming) {
    json = parseLastResultLine(trimmed);
  } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      json = JSON.parse(trimmed) as ClaudeJsonEnvelope;
    } catch {
      // Some claude versions stream NDJSON even with --output-format=json.
      json = parseLastJsonObject(trimmed);
    }
  }

  return { ...result, json };
}

/**
 * Walk lines from the bottom up looking for the `result` event emitted by
 * `claude --output-format stream-json`. That event has the same shape as the
 * non-streaming JSON envelope we already understand.
 */
function parseLastResultLine(text: string): ClaudeJsonEnvelope | undefined {
  const lines = text.split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const obj = JSON.parse(t) as ClaudeJsonEnvelope;
      if (obj.type === 'result') return obj;
    } catch {
      // keep scanning
    }
  }
  // Fallback: any parseable JSON line.
  return parseLastJsonObject(text);
}

/**
 * On Windows, npm-installed CLI tools land as `.cmd` / `.ps1` shims in PATH.
 * `child_process.spawn` won't pick those up unless we either set `shell: true`
 * (which triggers DEP0190 with args) or pass the explicit shim path. This
 * helper does the lookup once.
 */
function resolveWinCommand(command: string): string {
  // Already absolute or has an extension — trust it.
  if (/\\|\//.test(command) || /\.[a-z0-9]+$/i.test(command)) return command;
  const PATH = process.env.PATH ?? process.env.Path ?? '';
  const PATHEXT = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.PS1').split(';').filter(Boolean);
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue;
    for (const ext of PATHEXT) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command; // fall through; spawn will report ENOENT cleanly
}

function parseLastJsonObject(text: string): ClaudeJsonEnvelope | undefined {
  const lines = text.split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      return JSON.parse(t) as ClaudeJsonEnvelope;
    } catch {
      // keep scanning
    }
  }
  return undefined;
}

/**
 * Pull the final assistant text out of a JSON envelope, falling back to
 * stdout when the shape is unfamiliar.
 */
export function extractText(result: RunResult): string {
  if (result.json?.result && typeof result.json.result === 'string') {
    return result.json.result;
  }
  return result.stdout.trim();
}

interface SpawnRawOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Invoked once per line of stdout (for stream-json parsing). */
  onLine?: (line: string) => void;
}

interface SpawnRawResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Thin wrapper around child_process.spawn that captures stdout/stderr,
 * applies a timeout, and forwards an AbortSignal.
 */
function spawnRaw(command: string, args: string[], opts: SpawnRawOptions = {}): Promise<SpawnRawResult> {
  return new Promise<SpawnRawResult>((resolve, reject) => {
    const start = Date.now();
    // On Windows, .cmd / .ps1 shims (which `claude` typically is when installed
    // via npm) require shell:false + the .cmd extension OR shell:true. Using
    // the explicit .cmd extension when it resolves keeps args properly escaped
    // and avoids the DEP0190 deprecation warning from shell:true + args.
    const resolved = process.platform === 'win32' ? resolveWinCommand(command) : command;
    const child = spawn(resolved, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
      // Close stdin: the prompt is passed via -p, no piping. Without this,
      // `claude` waits 3s for stdin then prints a warning to stderr.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    let timed = false;
    let aborted = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timed = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;

    if (opts.signal) {
      if (opts.signal.aborted) {
        aborted = true;
        child.kill('SIGKILL');
      } else {
        opts.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            child.kill('SIGKILL');
          },
          { once: true },
        );
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (opts.onLine) {
        lineBuf += text;
        let nl = lineBuf.indexOf('\n');
        while (nl >= 0) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          if (line.length > 0) opts.onLine(line);
          nl = lineBuf.indexOf('\n');
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (opts.onLine && lineBuf.length > 0) {
        opts.onLine(lineBuf);
        lineBuf = '';
      }
      if (timed) {
        resolve({ stdout, stderr: stderr || 'timeout', exitCode: 124, durationMs: Date.now() - start });
      } else if (aborted) {
        resolve({ stdout, stderr: stderr || 'aborted', exitCode: 137, durationMs: Date.now() - start });
      } else {
        resolve({ stdout, stderr, exitCode: code ?? 0, durationMs: Date.now() - start });
      }
    });
  });
}
