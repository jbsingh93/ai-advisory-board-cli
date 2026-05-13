/**
 * Atomic JSON read / write with optional snapshotting.
 *
 * Writes go to a `.tmp` sibling and rename over the destination, so a partial
 * write can never corrupt the live file. On overwrite, the previous version
 * is copied to the .snapshots/ directory (caller chooses).
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { FsError } from '../core/errors.js';

const SNAPSHOT_LIMIT_PER_ENTITY = 20;

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new FsError(
      `Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'The file may be corrupted. Restore from a snapshot under .snapshots/ or delete it to reseed.',
    );
  }
}

export function writeJsonAtomic(path: string, value: unknown, opts: { snapshotDir?: string } = {}): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (opts.snapshotDir && existsSync(path)) {
    snapshot(path, opts.snapshotDir);
  }

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, path);
}

function snapshot(path: string, snapshotDir: string): void {
  if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(snapshotDir, `${basename(path)}.${ts}.bak`);
  try {
    copyFileSync(path, dest);
    pruneSnapshots(snapshotDir, basename(path));
  } catch {
    // snapshot is best-effort; never block the actual write
  }
}

function pruneSnapshots(snapshotDir: string, entityName: string): void {
  if (!existsSync(snapshotDir)) return;
  const entries = readdirSync(snapshotDir)
    .filter((f) => f.startsWith(`${entityName}.`))
    .map((f) => ({
      name: f,
      mtime: statSync(join(snapshotDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of entries.slice(SNAPSHOT_LIMIT_PER_ENTITY)) {
    try {
      unlinkSync(join(snapshotDir, stale.name));
    } catch {
      // ignore
    }
  }
}

export function appendJsonl(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

export function readJsonlAll<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return [];
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}
