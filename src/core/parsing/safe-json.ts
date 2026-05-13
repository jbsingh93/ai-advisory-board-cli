/**
 * Tolerant JSON parser. Ported from sage-council/src/lib/parsing/safe-json.ts.
 *
 * Strategy ordering (first success wins):
 *   1. Raw input (already JSON).
 *   2. Strip ```json / ``` fences.
 *   3. Balanced-brace extraction (handles leading/trailing chatter).
 *   4. Regex object match.
 *   5. Regex array match.
 *
 * Then optionally validate against a zod schema; the caller can branch on
 * `parseResult.success` and (when false) read `parseResult.error` to surface
 * a path-joined message.
 */
import type { ZodSchema } from 'zod';

export type ParseSource = 'raw' | 'fence_stripped' | 'balanced' | 'regex_object' | 'regex_array';

export interface SafeParseSuccess<T> {
  success: true;
  data: T;
  source: ParseSource;
}

export interface SafeParseFailure {
  success: false;
  error: string;
}

export type SafeParseResult<T> = SafeParseSuccess<T> | SafeParseFailure;

const FENCE_RE = /^\s*```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```\s*$/i;

function stripFences(text: string): string | null {
  const m = text.match(FENCE_RE);
  return m && typeof m[1] === 'string' ? m[1].trim() : null;
}

/**
 * Find a balanced {...} or [...] block ignoring chars inside string literals.
 */
function balancedExtract(text: string, opener: '{' | '['): string | null {
  const closer = opener === '{' ? '}' : ']';
  const start = text.indexOf(opener);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function regexFirstMatch(text: string, opener: '{' | '['): string | null {
  // Greedy enough to grab a likely object/array; falls back to balancedExtract
  // on the matched chunk so we don't return mismatched braces.
  const re = opener === '{' ? /\{[\s\S]*\}/ : /\[[\s\S]*\]/;
  const m = text.match(re);
  if (!m) return null;
  return balancedExtract(m[0], opener);
}

function tryParse<T>(text: string, source: ParseSource): SafeParseSuccess<T> | null {
  try {
    const data = JSON.parse(text) as T;
    return { success: true, data, source };
  } catch {
    return null;
  }
}

/**
 * Parse a raw text blob as JSON, trying multiple extraction strategies.
 */
export function safeParseJSON<T = unknown>(text: string): SafeParseResult<T> {
  if (typeof text !== 'string' || !text.trim()) {
    return { success: false, error: 'empty input' };
  }

  // 1. raw
  const raw = tryParse<T>(text, 'raw');
  if (raw) return raw;

  // 2. fenced
  const fenced = stripFences(text);
  if (fenced) {
    const r = tryParse<T>(fenced, 'fence_stripped');
    if (r) return r;
  }

  // 3. balanced object
  const balObj = balancedExtract(text, '{');
  if (balObj) {
    const r = tryParse<T>(balObj, 'balanced');
    if (r) return r;
  }

  // 4. regex object
  const reObj = regexFirstMatch(text, '{');
  if (reObj) {
    const r = tryParse<T>(reObj, 'regex_object');
    if (r) return r;
  }

  // 5. balanced array
  const balArr = balancedExtract(text, '[');
  if (balArr) {
    const r = tryParse<T>(balArr, 'balanced');
    if (r) return r;
  }

  const reArr = regexFirstMatch(text, '[');
  if (reArr) {
    const r = tryParse<T>(reArr, 'regex_array');
    if (r) return r;
  }

  return { success: false, error: 'no JSON candidate parsed' };
}

/**
 * Parse + validate against a zod schema. Returns the parsed data on success
 * with the source, or a path-joined error on failure.
 */
export function safeParseJSONWithSchema<T>(text: string, schema: ZodSchema<T>): SafeParseResult<T> {
  const parsed = safeParseJSON<unknown>(text);
  if (!parsed.success) return parsed;

  const validated = schema.safeParse(parsed.data);
  if (!validated.success) {
    const error = validated.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { success: false, error };
  }
  return { success: true, data: validated.data, source: parsed.source };
}
