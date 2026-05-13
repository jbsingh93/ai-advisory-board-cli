/**
 * Logger.
 *
 * Levels: silent < error < warn < info < debug < trace.
 * stdout is reserved for user-facing command output and --json payloads.
 * Logs always go to stderr so `aab ... | jq` is safe.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

let currentLevel: LogLevel = (process.env.AAB_LOG_LEVEL as LogLevel) || 'warn';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel];
}

function emit(level: Exclude<LogLevel, 'silent'>, args: unknown[]): void {
  if (!enabled(level)) return;
  const prefix = `[aabcli ${level}]`;
  // eslint-disable-next-line no-console
  console.error(prefix, ...args);
}

export const logger = {
  error: (...args: unknown[]) => emit('error', args),
  warn: (...args: unknown[]) => emit('warn', args),
  info: (...args: unknown[]) => emit('info', args),
  debug: (...args: unknown[]) => emit('debug', args),
  trace: (...args: unknown[]) => emit('trace', args),
};

/**
 * Redact a sensitive value (API keys, full model responses) for log output.
 * Shows the first `prefixChars` characters then `***`.
 */
export function redact(value: string | undefined | null, prefixChars = 4): string {
  if (!value) return '';
  if (value.length <= prefixChars) return '***';
  return `${value.slice(0, prefixChars)}***`;
}
