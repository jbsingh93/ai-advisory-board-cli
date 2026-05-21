/**
 * Aggregates token-usage JSONL logs (`<workspace>/token-usage/YYYY-MM-DD.jsonl`)
 * into the summary shape the Usage dashboard view consumes.
 *
 * Pure function — no I/O. The caller passes in the records loaded via
 * `storage.loadTokenUsageLogs(...)`.
 */
import type { TokenUsageLog } from '../../storage/types.js';

export interface UsageBucket {
  /** Key for the bucket: the date (YYYY-MM-DD), feature, or model name. */
  key: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageSummary {
  totals: Omit<UsageBucket, 'key'>;
  byDay: UsageBucket[];
  byFeature: UsageBucket[];
  byModel: UsageBucket[];
  /** Earliest createdAt in the logs (ISO). undefined when logs is empty. */
  windowStart?: string;
  /** Latest createdAt in the logs (ISO). undefined when logs is empty. */
  windowEnd?: string;
}

function emptyBucket(key: string): UsageBucket {
  return {
    key,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

function addInto(bucket: UsageBucket, log: TokenUsageLog): void {
  bucket.calls += 1;
  bucket.promptTokens += log.tokens.promptTokenCount || 0;
  bucket.completionTokens += log.tokens.candidatesTokenCount || 0;
  bucket.cacheReadTokens += log.tokens.cacheReadTokens || 0;
  bucket.cacheCreationTokens += log.tokens.cacheCreationTokens || 0;
  bucket.totalTokens += log.tokens.totalTokenCount || 0;
  bucket.costUsd += log.costUsd || 0;
}

/**
 * Build the dashboard summary from a flat list of token-usage logs.
 *
 * Day buckets are sorted by date ascending so a sparkline can render
 * left-to-right. Feature and model buckets are sorted by cost descending
 * (most expensive first) — the dashboard surfaces "where is the money going".
 */
export function summariseUsage(logs: TokenUsageLog[]): UsageSummary {
  const totals = emptyBucket('totals');
  const byDay = new Map<string, UsageBucket>();
  const byFeature = new Map<string, UsageBucket>();
  const byModel = new Map<string, UsageBucket>();

  let windowStart: string | undefined;
  let windowEnd: string | undefined;

  for (const log of logs) {
    addInto(totals, log);

    const date = (log.createdAt || '').slice(0, 10) || 'unknown';
    if (!byDay.has(date)) byDay.set(date, emptyBucket(date));
    addInto(byDay.get(date)!, log);

    const feature = log.feature || 'unknown';
    if (!byFeature.has(feature)) byFeature.set(feature, emptyBucket(feature));
    addInto(byFeature.get(feature)!, log);

    const model = log.model || 'unknown';
    if (!byModel.has(model)) byModel.set(model, emptyBucket(model));
    addInto(byModel.get(model)!, log);

    if (log.createdAt) {
      if (!windowStart || log.createdAt < windowStart) windowStart = log.createdAt;
      if (!windowEnd || log.createdAt > windowEnd) windowEnd = log.createdAt;
    }
  }

  // Strip the "totals" key field — the consumer just wants the numbers.
  const { key: _k, ...totalsNoKey } = totals;

  return {
    totals: totalsNoKey,
    byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byFeature: [...byFeature.values()].sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens),
    byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens),
    ...(windowStart ? { windowStart } : {}),
    ...(windowEnd ? { windowEnd } : {}),
  };
}
