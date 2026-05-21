import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the `aab` web dashboard E2E suite.
 *
 * - Tests live under `tests/e2e/` and use the `data-testid` locator policy
 *   from `docs/development/PLAYWRIGHT_MCP.md` §6.
 * - The dev server is started by a global fixture (`tests/fixtures/seeded-workspace.ts`)
 *   that points `aab ui` at a tempdir workspace seeded by `aab init` and a
 *   stubbed `claude` binary (`tests/fixtures/mock-claude.ts`).
 * - We run chromium by default for the dev loop; CI fans out to firefox + webkit
 *   too via the matrix in `.github/workflows/ui-e2e.yml`.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false, // single shared workspace per project
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { outputFolder: 'test-artifacts/playwright-test/html' }]] : 'list',
  outputDir: 'test-artifacts/playwright-test',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.AAB_UI_BASE_URL ?? 'http://127.0.0.1:3737',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    testIdAttribute: 'data-testid',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    // Cross-browser projects are CI-only by default. Uncomment locally to run them.
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 } },
      testIgnore: process.env.CI ? undefined : /.*/,
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 } },
      testIgnore: process.env.CI ? undefined : /.*/,
    },
  ],
  webServer: process.env.AAB_UI_SKIP_SERVER
    ? undefined
    : {
        command: 'node tests/fixtures/start-ui-server.mjs',
        url: process.env.AAB_UI_BASE_URL ?? 'http://127.0.0.1:3737',
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
