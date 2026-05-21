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
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
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
  /**
   * Path to a SKILL.md / system-prompt file to APPEND to the default Claude
   * Code system prompt. Used by the Phase 5 skill-creator orchestrator:
   * `--append-system-prompt-file <path>` makes Claude load the file's
   * contents on top of its default behavior, so we can drive any installed
   * skill headlessly. Note: this is distinct from `--system-prompt` (which
   * REPLACES the default).
   */
  appendSystemPromptFile?: string;
  /**
   * Force a specific output format. Defaults to `json` (or `stream-json`
   * when an `onEvent` callback is provided). Callers can pass
   * `'stream-json'` explicitly to capture tool-use events for any kind of
   * call, not just member responses.
   */
  outputFormat?: 'json' | 'stream-json';
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
  const wantStreamFormat = opts.outputFormat === 'stream-json' || (opts.streaming !== false && !!opts.onEvent);
  const streaming = wantStreamFormat;

  // sub-agent or fresh session
  if (opts.agent) args.push('--agent', opts.agent);

  // append a system prompt file (used by skill-creator orchestrator)
  if (opts.appendSystemPromptFile) {
    args.push('--append-system-prompt-file', opts.appendSystemPromptFile);
  }

  // prompt mode
  // Windows argv has a ~32k-char hard limit (ENAMETOOLONG). For long prompts
  // (Planner prompt is ~24k+, skill-creator briefs can hit 60k) we pipe the
  // prompt via stdin instead. `claude -p` with no positional value reads
  // the prompt from stdin — verified pattern from Anthropic Claude Code docs.
  const promptViaStdin = opts.prompt.length > 8000;
  if (promptViaStdin) {
    args.push('-p');
  } else {
    args.push('-p', opts.prompt);
  }

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
    stdinData: promptViaStdin ? opts.prompt : undefined,
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

  logger.debug('[claude] result', {
    stdoutLen: result.stdout.length,
    stdoutHead: result.stdout.slice(0, 200),
    stdoutTail: result.stdout.length > 400 ? result.stdout.slice(-200) : undefined,
    envelopeParsed: !!json,
    envelopeType: json?.type,
    resultLen: typeof json?.result === 'string' ? json.result.length : undefined,
    resultHead: typeof json?.result === 'string' ? json.result.slice(0, 200) : undefined,
    resultTail:
      typeof json?.result === 'string' && json.result.length > 400 ? json.result.slice(-200) : undefined,
  });

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

/**
 * Peek inside an npm-style `.cmd` shim and extract the underlying executable
 * path so we can spawn it directly (avoiding cmd.exe, which truncates
 * multi-line argv).
 *
 * The npm shim format is essentially:
 *   "%dp0%\node_modules\<pkg>\bin\<name>.exe"   %*
 * Some variants use `%~dp0\..\<pkg>\bin\<name>`. We match the last quoted
 * path on a non-comment line, substitute `%dp0%` / `%~dp0` with the shim
 * directory, and verify the file exists.
 *
 * Returns `undefined` if the shim doesn't match a recognised pattern — the
 * caller falls back to the cmd.exe wrapper.
 */
function resolveCmdShimToExe(cmdPath: string): string | undefined {
  let body: string;
  try {
    body = readFileSync(cmdPath, 'utf8');
  } catch {
    return undefined;
  }
  const dp0 = dirname(cmdPath);
  const lines = body.split(/\r?\n/);
  // Walk bottom-up — the actual call is near the end of npm shims.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || line.startsWith(':') || line.startsWith('REM ') || line.startsWith('@')) continue;
    const m = line.match(/"([^"]+\.(?:exe|cmd|bat))"/i);
    if (!m) continue;
    let candidate = m[1]!;
    // Substitute the common npm-shim variables.
    candidate = candidate
      .replace(/%~dp0/gi, dp0 + '\\')
      .replace(/%dp0%/gi, dp0 + '\\');
    // Collapse `\\` and resolve `..` segments.
    const abs = isAbsolute(candidate) ? resolvePath(candidate) : resolvePath(dp0, candidate);
    if (existsSync(abs) && /\.exe$/i.test(abs)) return abs;
  }
  return undefined;
}

/**
 * Wrap a `.cmd` / `.bat` invocation so it can be spawned safely on modern
 * Node (20.12+, 21.7+, 22+) where direct spawn of those files throws EINVAL.
 *
 * Strategy: invoke `cmd.exe /d /s /c "<path> <args...>"` with
 * `windowsVerbatimArguments: true` and quote each argument manually.
 *
 * /d   skip AutoRun commands
 * /s   strip outer quotes from the rest of the command line so we control quoting
 * /c   run and exit
 */
function wrapForCmd(
  resolved: string,
  args: string[],
): { command: string; args: string[]; windowsVerbatimArguments: true } {
  const commandLine = [resolved, ...args].map(quoteForCmd).join(' ');
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine],
    windowsVerbatimArguments: true,
  };
}

/**
 * Quote an argument for cmd.exe. Wraps in double quotes when necessary and
 * escapes embedded `"`, `\`, and `%` per the cmd.exe + CommandLineToArgvW
 * conventions. Used together with `windowsVerbatimArguments: true` so Node
 * doesn't re-quote on top.
 */
function quoteForCmd(s: string): string {
  if (s === '') return '""';
  // No special chars → return as-is.
  if (!/[\s"&|<>^()%!`]/.test(s)) return s;
  // Escape backslashes that precede a quote (Windows argv rule).
  let escaped = s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  // Escape `%` so cmd.exe doesn't try to expand it as a variable.
  escaped = escaped.replace(/%/g, '"^%"');
  // Caret-escape cmd metacharacters that survive double-quotes in some edge cases.
  escaped = escaped.replace(/([&|<>^!])/g, '^$1');
  return `"${escaped}"`;
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
  /**
   * If provided, the spawn opens stdin and writes this string before closing.
   * Used to bypass the Windows argv 32k-char limit when passing long prompts
   * to `claude -p` (no positional value → reads prompt from stdin).
   */
  stdinData?: string;
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
    // On Windows, npm installs `claude` as a `.cmd` shim under %APPDATA%\npm\.
    // Two problems with that:
    //   1. Since Node 20.12 / 21.7 / 22 (CVE-2024-27980), spawning `.cmd`
    //      directly without `shell: true` throws EINVAL.
    //   2. Routing through `cmd.exe /c` works for short args but **truncates
    //      multi-line arguments at the first newline** — cmd.exe treats `\n`
    //      as a command separator even inside quoted strings. Our prompts
    //      are multi-line.
    // Fix: peek inside the `.cmd` shim, extract the underlying `.exe` path it
    // calls, and spawn that directly via argv (binary-safe). Only fall back
    // to the cmd.exe wrapper if shim parsing fails — and in that case
    // multi-line prompts will still be broken, so we log a warning.
    let resolvedRaw = process.platform === 'win32' ? resolveWinCommand(command) : command;
    if (process.platform === 'win32' && /\.cmd$/i.test(resolvedRaw)) {
      const realExe = resolveCmdShimToExe(resolvedRaw);
      if (realExe) resolvedRaw = realExe;
    }
    const launch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedRaw)
      ? wrapForCmd(resolvedRaw, args)
      : { command: resolvedRaw, args, windowsVerbatimArguments: false };
    const child = spawn(launch.command, launch.args, {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      // Pipe stdin when long-prompt mode is requested (caller bypassing the
      // Windows 32k argv limit). Otherwise close stdin — without this, claude
      // waits 3s for stdin then prints a warning to stderr.
      stdio: [opts.stdinData !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    // Long-prompt path — write the prompt body to stdin and close it. Any
    // EPIPE here is non-fatal (caller will see the model's response or a
    // descriptive error from exit-code handling).
    if (opts.stdinData !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* swallow EPIPE / write-after-end */ });
      child.stdin.write(opts.stdinData);
      child.stdin.end();
    }

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
