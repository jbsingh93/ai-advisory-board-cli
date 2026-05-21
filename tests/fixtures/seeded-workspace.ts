/**
 * `tests/fixtures/seeded-workspace.ts` — boots a tempdir workspace pre-seeded
 * with starter members + principles, then returns the directory + a Node
 * `env` object that points the `aab` runtime at it.
 *
 * Used by `start-ui-server.mjs` (the Playwright `webServer.command`) and by
 * any spec that needs a fresh workspace.
 *
 * The fixture relies on the `aab init` CLI to do the actual seeding — calling
 * the binary keeps us honest about what shipped behavior produces, instead of
 * hand-rolling the JSON. We invoke `dist/bin/aab.js` directly (assumes
 * `npm run build` was run; `playwright.config.ts` documents this dependency).
 */

import { mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const AAB_BIN = join(REPO_ROOT, 'dist', 'bin', 'aab.js');
const MOCK_BIN_DIR = join(HERE, 'bin');

export interface SeededWorkspace {
  /** Filesystem path to the workspace (e.g. `/tmp/aab-e2e-xyz/workspace`). */
  workspacePath: string;
  /** Slug we passed to `aab init`. */
  workspaceSlug: string;
  /** Project root we ran `aab init` from (also where `.claude/agents/` lands). */
  projectRoot: string;
  /** Env vars to spread into a `spawn()` for `node dist/bin/aab.js ui`. */
  env: NodeJS.ProcessEnv;
  /** Path to the persistent mock-claude state file (per workspace). */
  mockStateFile: string;
}

/**
 * Bootstraps a brand-new workspace under `os.tmpdir()`. Idempotent if the
 * caller hands back the same `slug` — the workspace dir is recreated and
 * `aab init --non-interactive` is re-run.
 */
export function seedWorkspace(opts: { slug?: string; profile?: string } = {}): SeededWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'aab-e2e-'));
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });

  const workspaceSlug = opts.slug ?? `e2e-${Date.now().toString(36)}`;
  const homeDir = join(root, 'home');
  mkdirSync(homeDir, { recursive: true });
  const workspacePath = join(homeDir, '.aabcli', workspaceSlug);

  const mockStateFile = join(root, 'mock-claude-state.json');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Park the user-home pointer under root so the test never touches the
    // real ~/.aabcli/ directory.
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: homeDir,
    AAB_WORKSPACE: workspaceSlug,
    AAB_MOCK_CLAUDE_PROFILE: opts.profile ?? 'happy-path',
    AAB_MOCK_CLAUDE_STATE_FILE: mockStateFile,
    // Prepend the mock-claude bin dir so `spawn('claude', …)` resolves to our stub.
    PATH: `${MOCK_BIN_DIR}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
  };

  if (!existsSync(AAB_BIN)) {
    throw new Error(
      `Seeded workspace fixture requires dist/bin/aab.js. Run \`npm run build\` first.\n` +
        `Looked for: ${AAB_BIN}`,
    );
  }

  const init = spawnSync(
    process.execPath,
    [AAB_BIN, 'init', '--non-interactive', '--home', '--name', workspaceSlug],
    {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
    },
  );
  if (init.status !== 0) {
    throw new Error(
      `aab init failed (exit ${init.status}):\n${init.stdout}\n${init.stderr}`,
    );
  }

  return { workspacePath, workspaceSlug, projectRoot, env, mockStateFile };
}
