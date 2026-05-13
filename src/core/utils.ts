import { randomUUID, randomBytes } from 'node:crypto';

/**
 * Generate a v4 UUID. Uses node:crypto.randomUUID when available; otherwise
 * falls back to manual v4 generation from random bytes.
 */
export function generateUUID(): string {
  if (typeof randomUUID === 'function') {
    return randomUUID();
  }
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Normalize a confidence value 0-100; preserve 0; fall back when null/undefined/NaN.
 */
export function normalizeConfidence(value: unknown, fallback = 70): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Sleep for `ms` milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clamp an integer to [min, max].
 */
export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const v = Math.round(value);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/**
 * ISO-8601 timestamp string for storage. Always UTC.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Format a duration in milliseconds as a short human string ("4m 12s", "850ms").
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remainder}s`;
}

/**
 * Format USD with 4 fractional digits (small per-call costs need precision).
 */
export function formatUsd(amount: number): string {
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
