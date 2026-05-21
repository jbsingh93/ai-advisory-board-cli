/**
 * Install — Phase 5 Chunk 4. Per PLAN/SKILL_CREATOR.md §10.
 *
 *   cp -r workspace/ → .claude/skills/<name>/    (project scope, default)
 *   cp -r workspace/ → ~/.claude/skills/<name>/  (--scope user)
 *
 * Conflict handling: overwrite (archives existing to .snapshots/skills/<name>-<ts>/),
 * rename (<name>-2, <name>-3, ...), abort. Sidecar `installed-at.json`
 * lives in the workspace (per T3.9 — NOT inside the installed skill dir to
 * avoid Claude Code loading it as a support file).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { UserError } from '../errors.js';
import { askConfirm, askSelect } from '../../ui/prompts.js';
import type { EmittedFile } from './invoke-skill-creator.js';

export type ConflictMode = 'overwrite' | 'rename' | 'abort';

export interface InstallOptions {
  files: EmittedFile[];
  /** Final skill name (kebab-case) — used for both dir name and frontmatter validation. */
  skillName: string;
  /** Default 'project'. */
  scope?: 'project' | 'user';
  /** Project root (for project-scope installs). Defaults to process.cwd(). */
  projectRoot?: string;
  /** Auto-resolve conflicts (--yes mode). */
  yes?: boolean;
  /** Workspace root containing skill-runs/<runId>/installed-at.json sidecar. */
  workspaceRoot?: string;
  /** Run id (used in sidecar). */
  runId?: string;
  /** Action item id (used in sidecar). */
  actionItemId?: string;
  /** Cap on `.snapshots/skills/<name>-*` entries. */
  snapshotRetention?: number;
}

export interface InstallResult {
  installPath: string;
  conflictAction?: ConflictMode;
  archivedTo?: string;
  filesWritten: number;
}

export async function installSkillPackage(opts: InstallOptions): Promise<InstallResult> {
  const scope = opts.scope ?? 'project';
  const projectRoot = opts.projectRoot ?? process.cwd();
  let installPath = scope === 'user'
    ? join(homedir(), '.claude', 'skills', opts.skillName)
    : join(projectRoot, '.claude', 'skills', opts.skillName);

  let conflictAction: ConflictMode | undefined;
  let archivedTo: string | undefined;

  if (existsSync(installPath)) {
    conflictAction = opts.yes ? 'overwrite' : await askConflictMode(installPath);
    if (conflictAction === 'abort') {
      throw new UserError(`Install aborted — ${installPath} already exists.`);
    }
    if (conflictAction === 'rename') {
      installPath = uniqueRename(installPath);
    } else {
      // overwrite — archive first
      archivedTo = archiveExisting(installPath, opts.snapshotRetention ?? 5);
      rmSync(installPath, { recursive: true, force: true });
    }
  }

  // Write each file.
  mkdirSync(installPath, { recursive: true });
  let filesWritten = 0;
  for (const f of opts.files) {
    const target = join(installPath, ...f.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content, 'utf8');
    filesWritten++;
  }

  // Sidecar — lives in the workspace, not in the installed skill dir.
  if (opts.workspaceRoot && opts.runId) {
    const sidecarDir = join(opts.workspaceRoot, 'skill-runs', opts.runId);
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(
      join(sidecarDir, 'installed-at.json'),
      JSON.stringify(
        {
          runId: opts.runId,
          actionItemId: opts.actionItemId,
          skillName: opts.skillName,
          installPath,
          installedAt: new Date().toISOString(),
          generatedBy: 'aab actions solve',
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  return { installPath, conflictAction, archivedTo, filesWritten };
}

async function askConflictMode(path: string): Promise<ConflictMode> {
  const proceed = await askConfirm(`${path} already exists. Overwrite (archives existing)?`, false);
  if (proceed) return 'overwrite';
  const next = await askSelect<ConflictMode>(
    'Choose alternative',
    [
      { name: 'rename', message: 'Install under a renamed slug (<name>-2)' },
      { name: 'abort', message: 'Abort the install' },
    ],
    { initial: 'rename' },
  );
  return next;
}

function uniqueRename(installPath: string): string {
  let n = 2;
  let candidate = `${installPath}-${n}`;
  while (existsSync(candidate)) {
    n++;
    candidate = `${installPath}-${n}`;
  }
  return candidate;
}

function archiveExisting(installPath: string, retention: number): string {
  const parentDir = dirname(installPath);
  const skillsDirName = installPath.split(/[\\/]/).pop()!;
  const snapshotsDir = join(parentDir, '.snapshots', 'skills');
  mkdirSync(snapshotsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(snapshotsDir, `${skillsDirName}-${ts}`);
  // Use rename if same volume; cp + rm as fallback.
  try {
    renameSync(installPath, target);
  } catch {
    cpSync(installPath, target, { recursive: true });
    rmSync(installPath, { recursive: true, force: true });
  }
  // Retention rotation — keep newest N.
  pruneSnapshots(snapshotsDir, skillsDirName, retention);
  return target;
}

function pruneSnapshots(snapshotsDir: string, namePrefix: string, retention: number): void {
  if (!existsSync(snapshotsDir)) return;
  try {
    const all = readdirSync(snapshotsDir).filter((n) => n.startsWith(namePrefix + '-')).sort();
    while (all.length > retention) {
      const oldest = all.shift()!;
      try {
        rmSync(join(snapshotsDir, oldest), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}
