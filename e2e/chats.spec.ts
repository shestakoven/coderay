import { expect, test } from '@playwright/test';
import { startCore, type Core } from './core';

let core: Core | undefined;

test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

test('chats keep their own model and effort, and switching restores the first chat', async ({ page }) => {
  core = await startCore('gate-big-plan');
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
  await page.getByPlaceholder(/Message the agent/).fill('first chat about greetings');
  await page.keyboard.press('Enter');
  const panel = page.getByTestId('plan-panel');
  await expect(panel).toContainText('waiting for you');
  await panel.getByRole('button', { name: 'Approve' }).click();
  await expect(panel).toContainText('done');

  await page.getByLabel('Model').selectOption('opus');
  await page.getByLabel('Effort').selectOption('high');
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.locator('.chat-switcher-button')).toContainText('New chat');
  await expect(page.getByLabel('Model')).toHaveValue('opus');
  await expect(page.getByLabel('Effort')).toHaveValue('high');

  await page.locator('.chat-switcher-button').click();
  const row = page.getByRole('option').filter({ hasText: 'first chat about greetings' });
  await expect(row).toContainText('Opus · high');
  await row.getByRole('button').click();
  await expect(page.locator('.chat-switcher-button')).toContainText('first chat about greetings');
  await expect(page.locator('.msg.user')).toContainText('first chat about greetings');
});
