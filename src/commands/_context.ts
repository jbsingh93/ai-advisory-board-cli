/**
 * Helpers shared by command implementations: resolve workspace, build
 * StorageService, manage the per-workspace lock.
 */
import { Command } from 'commander';
import { AabError } from '../core/errors.js';
import { acquireLock, type LockHandle } from '../storage/locks.js';
import { paths, resolveWorkspace, type ResolvedWorkspace } from '../storage/paths.js';
import { FsStorageService } from '../storage/fs-storage-service.js';

export interface CommandContext {
  workspace: ResolvedWorkspace;
  storage: FsStorageService;
  lock: LockHandle;
  json: boolean;
}

interface OpenOptions {
  /** When false, skip acquiring the workspace lock (for read-only commands). */
  lock?: boolean;
}

/**
 * Resolve workspace + storage from a command's parsed options.
 */
export async function openContext(cmd: Command, opts: OpenOptions = {}): Promise<CommandContext> {
  const root = cmd.optsWithGlobals<{ workspace?: string; json?: boolean }>();
  const workspace = resolveWorkspace({ override: root.workspace });
  const storage = new FsStorageService(workspace);
  const lock = opts.lock === false
    ? { release: async () => undefined }
    : await acquireLock(paths(workspace.root).lockFile).catch((error: unknown) => {
        throw new AabError(
          `Could not acquire workspace lock: ${error instanceof Error ? error.message : String(error)}`,
          5,
          'Another `aab` invocation may be running. Wait for it to finish or remove the stale .lock file.',
        );
      });
  return { workspace, storage, lock, json: !!root.json };
}

export async function closeContext(ctx: CommandContext): Promise<void> {
  await ctx.lock.release();
}
