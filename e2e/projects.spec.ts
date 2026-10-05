import { expect, test, type Page } from '@playwright/test';
import { startHub, type Hub } from './core';

let hub: Hub | undefined;

test.afterEach(async () => {
  try {
    await hub?.stop();
  } finally {
    hub = undefined;
  }
});

const tab = (page: Page, name: string) => page.getByRole('tablist', { name: 'Open projects' }).getByRole('tab', { name });
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Open projects' }).getByRole('tab');

async function expectShown(page: Page, name: string): Promise<void> {
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveTitle(`${name} · AI Control IDE`);
}

test('shows a tab per project of the hub and switches by click and by keyboard', async ({ page }) => {
  hub = await startHub(['alpha', 'beta']);
  await page.goto(hub.url);
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).nth(0)).toContainText('alpha');
  await expect(tabs(page).nth(1)).toContainText('beta');

  await tab(page, 'alpha').click();
  await expectShown(page, 'alpha');
  await expect(tab(page, 'beta')).toHaveAttribute('aria-selected', 'false');
  await tab(page, 'beta').click();
  await expectShown(page, 'beta');
  await expect(tab(page, 'alpha')).toHaveAttribute('aria-selected', 'false');

  await page.keyboard.press('ControlOrMeta+1');
  await expectShown(page, 'alpha');
  await page.keyboard.press('ControlOrMeta+2');
  await expectShown(page, 'beta');
});

test('opens a third project from the plus menu and shows it', async ({ page }) => {
  hub = await startHub(['alpha', 'beta']);
  const gamma = hub.addProject('gamma');
  await page.goto(hub.url);
  await expect(tabs(page)).toHaveCount(2);

  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await page.getByRole('menu', { name: 'Open project' }).getByRole('menuitem', { name: /Open folder/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Open project' });
  const input = dialog.getByLabel('Folder path');
  // The first listing fills the field when it arrives and would overwrite what is typed before that.
  await expect(input).not.toHaveValue('');
  await input.fill(gamma);
  await input.press('Enter');
  await dialog.getByRole('button', { name: 'Open this folder' }).click();

  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect(tabs(page)).toHaveCount(3);
  await expect(tabs(page).nth(2)).toContainText('gamma');
  await expectShown(page, 'gamma');
  await expect.poll(() => hub?.coresOf(gamma).length, { timeout: 30_000 }).toBeGreaterThan(0);
});

test('closes an idle project with its tab button and ends its core', async ({ page }) => {
  hub = await startHub(['alpha', 'beta']);
  const beta = hub.root('beta');
  await page.goto(hub.url);
  await expect(tabs(page)).toHaveCount(2);
  await expect.poll(() => hub?.coresOf(beta).length, { timeout: 60_000 }).toBeGreaterThan(0);
  // A starting core counts as working, and closing a working project asks first.
  await expect(tab(page, 'beta')).toHaveClass(/\bs-idle\b/, { timeout: 60_000 });

  await tab(page, 'beta').getByRole('button', { name: 'Close beta' }).click();

  await expect(page.getByRole('dialog', { name: 'Close beta' })).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(1);
  await expect(tab(page, 'beta')).toHaveCount(0);
  await expectShown(page, 'alpha');
  await expect.poll(() => hub?.coresOf(beta).length, { timeout: 30_000 }).toBe(0);
  await expect(tab(page, 'beta')).toHaveCount(0);
});

test('lists the open projects in the palette and switches to the chosen one with Enter', async ({ page }) => {
  hub = await startHub(['alpha', 'beta']);
  await page.goto(hub.url);
  await expect(tabs(page)).toHaveCount(2);
  await tab(page, 'beta').click();
  await expectShown(page, 'beta');

  await page.keyboard.press('ControlOrMeta+P');
  const palette = page.getByRole('dialog', { name: 'Switch project' });
  await expect(palette.getByRole('option', { name: /alpha/ })).toBeVisible();
  await expect(palette.getByRole('option', { name: /beta/ })).toBeVisible();

  await palette.getByLabel('Project').fill('alpha');
  await expect(palette.getByRole('option', { name: /alpha/ })).toHaveAttribute('aria-selected', 'true');
  await palette.getByLabel('Project').press('Enter');

  await expect(palette).toBeHidden();
  await expectShown(page, 'alpha');
});
