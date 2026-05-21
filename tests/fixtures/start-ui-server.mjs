/**
 * Entry point used by `playwright.config.ts`'s `webServer.command`.
 *
 * Seeds a tempdir workspace by shelling out to `aab init`, prepends the
 * mock-claude bin shim to PATH, then spawns `aab ui` against the seeded
 * workspace. Pipes child stdio through so Playwright captures startup logs.
 *
 * Requires `npm run build` to have been run (dist/bin/aab.js must exist).
 * Mirrors `tests/fixtures/seeded-workspace.ts` — keep them in sync.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const AAB_BIN = join(REPO_ROOT, 'dist', 'bin', 'aab.js');
const MOCK_BIN_DIR = join(HERE, 'bin');

if (!existsSync(AAB_BIN)) {
  console.error(`✗ ${AAB_BIN} not found. Run \`npm run build\` first.`);
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), 'aab-e2e-'));
const projectRoot = join(root, 'project');
mkdirSync(projectRoot, { recursive: true });
const workspaceSlug = `e2e-${Date.now().toString(36)}`;
const homeDir = join(root, 'home');
mkdirSync(homeDir, { recursive: true });
const mockStateFile = join(root, 'mock-claude-state.json');

const env = {
  ...process.env,
  HOME: homeDir,
  USERPROFILE: homeDir,
  APPDATA: homeDir,
  AAB_WORKSPACE: workspaceSlug,
  AAB_MOCK_CLAUDE_PROFILE: process.env.AAB_MOCK_CLAUDE_PROFILE ?? 'happy-path',
  AAB_MOCK_CLAUDE_STATE_FILE: mockStateFile,
  // Prepend the mock-claude shim dir so `spawn('claude', …)` hits the stub.
  PATH: `${MOCK_BIN_DIR}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
};

const init = spawnSync(
  process.execPath,
  [AAB_BIN, 'init', '--non-interactive', '--home', '--name', workspaceSlug],
  { cwd: projectRoot, env, encoding: 'utf8' },
);
if (init.status !== 0) {
  console.error('✗ aab init failed:', init.stdout, init.stderr);
  process.exit(1);
}
console.log(`✓ Seeded workspace at ${join(homeDir, '.aabcli', workspaceSlug)}`);

const ui = spawn(process.execPath, [AAB_BIN, 'ui', '--port', '3737'], {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
});

ui.on('exit', (code) => {
  console.error(`aab ui exited with ${code}`);
  process.exit(code ?? 1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    ui.kill(sig);
  });
}
