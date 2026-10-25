import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startCore, type Core } from './core';

let core: Core | undefined;

test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

test('the first project shows the engines found, keeps the focus inside, fits a narrow window, and Continue without AI turns the AI off for good', async ({ page }) => {
  core = await startCore('text-then-wait', {}, 'tiny', null, null, { onboarded: false });
  const stored = (): unknown => JSON.parse(readFileSync(join(core!.home, 'background-ai.json'), 'utf8'));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(core.url);
  const dialog = page.getByRole('dialog', { name: 'Background AI' });
  await expect(dialog.getByRole('listitem').filter({ hasText: 'Claude Code' })).toContainText('Ready');
  await expect(dialog.getByRole('button', { name: "Use what's found" })).toBeFocused();

  const buttons = dialog.getByRole('button');
  const focusInside = (): Promise<boolean> => dialog.evaluate((node) => node.contains(node.ownerDocument.activeElement));
  for (let press = 0; press < 6; press += 1) {
    await page.keyboard.press('Tab');
    expect(await focusInside()).toBe(true);
  }
  await buttons.first().focus();
  await page.keyboard.press('Shift+Tab');
  await expect(buttons.last()).toBeFocused();
  // The project behind is inert: from the top bar, Tab goes into the screen.
  await page.getByRole('button', { name: /^Settings/ }).focus();
  await page.keyboard.press('Tab');
  expect(await focusInside()).toBe(true);

  await page.setViewportSize({ width: 400, height: 800 });
  expect(await page.locator('html').evaluate((root) => root.scrollWidth <= root.clientWidth)).toBe(true);
  for (const button of await buttons.all()) await expect(button).toBeInViewport();

  await page.setViewportSize({ width: 1280, height: 800 });
  await dialog.getByRole('button', { name: 'Continue without AI' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.chip', { hasText: /^AI off$/ })).toBeVisible();
  await expect.poll(stored).toEqual({ choice: { mode: 'off' }, onboarded: true });

  // Settings can bring the screen back in the same window; Esc skips it and keeps the AI off.
  await page.keyboard.press('Control+,');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Background AI', exact: true }).click();
  await settings.getByRole('button', { name: 'Show the first-run screen again' }).click();
  await expect(settings).toBeHidden();
  await expect(dialog).toContainText('Skip keeps the background AI off.');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect.poll(stored).toEqual({ choice: { mode: 'off' }, onboarded: true });

  await page.reload();
  await expect(page.locator('.chip', { hasText: /^AI off$/ })).toBeVisible();
  await expect(dialog).toBeHidden();
});
