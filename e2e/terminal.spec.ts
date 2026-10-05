import { expect, test } from '@playwright/test';
import { startCore, type Core } from './core';

let core: Core | undefined;

test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

test('the terminal runs commands in the project, survives a reload and closes', async ({ page }) => {
  core = await startCore('gate-big-plan');
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();

  await page.keyboard.press('Control+`');
  const screen = page.locator('.terminal-host:visible .xterm-rows');
  await expect(screen).toContainText(/\S/, { timeout: 15000 });
  await page.locator('.terminal-host:visible .xterm').click();
  await page.keyboard.type('echo hi-$((1+2)) && pwd');
  await page.keyboard.press('Enter');
  await expect(screen).toContainText('hi-3');

  await page.reload();
  await expect(page.getByText('core connected')).toBeVisible();
  await page.keyboard.press('Control+`');
  await expect(page.locator('.terminal-host:visible .xterm-rows')).toContainText('hi-3', { timeout: 15000 });
  await expect(page.getByRole('button', { name: /^Terminal · / })).toContainText('1');

  await page.getByRole('button', { name: /^Close / }).click();
  await expect(page.locator('.terminal-host:visible .xterm-rows')).not.toContainText('hi-3', { timeout: 15000 });
  await expect(page.locator('.terminal-tab')).toHaveCount(1);
});

test('Ctrl+` toggles the bottom panel and the Terminal tab reflects it', async ({ page }) => {
  core = await startCore('gate-big-plan');
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
  const button = page.getByRole('button', { name: /^Terminal/ });
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Control+`');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+`');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
});
