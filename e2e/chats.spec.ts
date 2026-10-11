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
  await expect(row).toContainText(/Opus[\d. ]* · high/);
  await row.getByRole('button', { name: 'first chat about greetings' }).click();
  await expect(page.locator('.chat-switcher-button')).toContainText('first chat about greetings');
  await expect(page.locator('.msg.user')).toContainText('first chat about greetings');
});

test('a new chat lists its skills before the first message, and says it is loading them meanwhile', async ({ page }) => {
  core = await startCore('skills-init', { FAKE_CLAUDE_INITIALIZE_MS: '2000' });
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
  const composer = page.getByPlaceholder(/Message the agent/);
  await composer.fill('/');
  await expect(page.getByTestId('skill-menu-empty')).toHaveText('Skills appear once the agent has started.');
  await page.locator('.chat-new').click();
  await composer.fill('/');
  await expect(page.getByTestId('skill-menu-empty')).toHaveText('Loading skills…');
  await expect(page.getByTestId('skill-menu-empty')).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('skill-menu').getByRole('option')).toHaveText(['/repo-probe', '/omc-plan', /^\/brainstorming\s*superpowers$/]);
});

test('the chat shows the agent at work until the turn ends', async ({ page }) => {
  core = await startCore('gate-big-plan');
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
  await expect(page.locator('.working')).toHaveCount(0);
  await page.getByPlaceholder(/Message the agent/).fill('fix them');
  await page.keyboard.press('Enter');
  const working = page.locator('.working');
  await expect(working).toContainText('approve the plan');
  await expect(page.locator('.chat-header')).toHaveClass(/working-on/);
  await page.getByTestId('plan-panel').getByRole('button', { name: 'Approve' }).click();
  await expect(working).toHaveCount(0);
  await expect(page.locator('.chat-header')).not.toHaveClass(/working-on/);
});
