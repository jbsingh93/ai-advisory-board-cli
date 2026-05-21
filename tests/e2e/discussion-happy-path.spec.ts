/**
 * Deterministic CI spec for the discussion happy path.
 *
 * Source-of-truth markdown: `docs/specs/discussion-happy-path.md`. Generated via
 * `docs/development/PLAYWRIGHT_MCP.md` §7 Pattern C, then reviewed by hand.
 *
 * Hermeticity: `playwright.config.ts` boots a fresh tempdir workspace and
 * prepends `tests/fixtures/bin` (containing the mock `claude` shim) to PATH,
 * so no real Claude tokens are consumed.
 */
import { test, expect } from '@playwright/test';

test.describe('Dashboard scaffolding', () => {
  test('the sidebar exposes every tab with stable testids', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/AI Advisory Board/);

    for (const route of [
      'discussions',
      'actions',
      'members',
      'principles',
      'coach',
      'knowledge',
      'skills',
      'usage',
      'settings',
    ]) {
      await expect(page.getByTestId(`tab-${route}`)).toBeVisible();
    }
  });

  test('the Discussions tab is the default selection', async ({ page }) => {
    await page.goto('/');
    const tab = page.getByTestId('tab-discussions');
    await expect(tab).toHaveClass(/active/);
  });

  test('clicking + New discussion opens the modal with question + Start controls', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('new-discussion').click();

    const modal = page.getByTestId('new-discussion-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute('aria-modal', 'true');
    await expect(modal).toHaveAttribute('role', 'dialog');

    await expect(page.getByTestId('new-discussion-question')).toBeVisible();
    await expect(page.getByTestId('new-discussion-start')).toBeVisible();
  });
});

test.describe('Members tab', () => {
  test('seeded workspace shows the starter members', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-members').click();

    // `aab init --non-interactive` seeds at least Elon, Julian, and Alexandra.
    // We assert the Sync / Add CTAs are present rather than depending on the
    // exact member names, which could change. The view-title is a styled <div>
    // not a heading, so we anchor on the testids instead.
    await expect(page.getByTestId('members-sync-btn')).toBeVisible();
    await expect(page.getByTestId('members-add-btn')).toBeVisible();
    await expect(page.getByText('Board members', { exact: true }).first()).toBeVisible();
  });
});

test.describe('Theme + sidebar a11y', () => {
  test('theme toggle persists across reload', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByTestId('theme-toggle');
    await toggle.click();

    const html = page.locator('html');
    const theme = await html.getAttribute('data-theme');
    expect(['light', 'dark']).toContain(theme);

    await page.reload();
    await expect(html).toHaveAttribute('data-theme', theme!);
  });

  test('main landmark is labelled', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('main')).toHaveAttribute('role', 'main');
    await expect(page.getByTestId('sidebar')).toHaveAttribute('aria-label', 'Navigation sidebar');
  });
});
