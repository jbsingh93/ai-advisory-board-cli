/**
 * Per-workspace file lock using proper-lockfile. Held for the duration of
 * a CLI command that mutates state, so two `aab` invocations on the same
 * workspace never corrupt JSON files.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';

export interface LockHandle {
  release: () => Promise<void>;
}

export async function acquireLock(lockPath: string, opts: { stale?: number; retries?: number } = {}): Promise<LockHandle> {
  const dir = dirname(lockPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(lockPath)) writeFileSync(lockPath, '', 'utf8');

  const release = await lockfile.lock(lockPath, {
    stale: opts.stale ?? 30_000, // forcibly break locks older than 30s
    retries: opts.retries ?? { retries: 3, factor: 2, minTimeout: 100, maxTimeout: 1_000 },
    realpath: false,
  });
  return { release: async () => release() };
}
