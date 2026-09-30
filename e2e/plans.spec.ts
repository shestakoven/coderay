import { expect, test } from '@playwright/test';
import { startCore, type Core } from './core';

let core: Core | undefined;

test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

async function sendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  await expect(page.getByText('live ●')).toBeVisible();
  // A prompt raised before the first map snapshot has no node to open at.
  await expect(page.getByText('1 components')).toBeVisible();
  await page.getByPlaceholder(/Message the agent/).fill(text);
  await page.keyboard.press('Enter');
}

test('approve a plan: it waits on the map, and its write happens after Approve', async ({ page }) => {
  core = await startCore('gate-big-plan');
  await page.goto(core.url);
  await sendMessage(page, 'fix them');
  const panel = page.getByTestId('plan-panel');
  await expect(panel).toContainText('Plan v1 · waiting for you');
  expect(core.file('src/app.ts')).toBe("export const greeting = 'helo';\n");
  await panel.getByRole('button', { name: 'Approve' }).click();
  await expect(panel).toContainText('Plan v1 · done');
  await expect.poll(() => core?.file('src/app.ts')).toBe("export const greeting = 'hello';\n");
});

test('a pre-execution prompt: an out-of-plan write waits at its node until Allow once', async ({ page }) => {
  core = await startCore('gate-out-of-plan');
  await page.goto(core.url);
  await sendMessage(page, 'fix it');
  const popover = page.getByTestId('gate-popover');
  await expect(popover).toContainText('Out of plan');
  await expect(popover).toContainText('src/other.ts has the same typo.');
  expect(core.file('src/other.ts')).toBe("export const other = 'helo';\n");
  await popover.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByText('allowed by you')).toBeVisible();
  await expect.poll(() => core?.file('src/other.ts')).toBe("export const other = 'hello';\n");
});
