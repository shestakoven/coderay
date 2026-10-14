import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { startCore, type Core } from './core';
import { chooseModel, flagOf, hasFlag } from './helpers';

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

  await chooseModel(page, 'opus');
  await page.getByLabel('Effort').selectOption('high');
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.locator('.chat-switcher-button')).toContainText('New chat');
  await expect(page.locator('.model-button')).toHaveText(/Opus 5\.5/);
  await expect(page.getByLabel('Effort')).toHaveValue('high');

  await page.locator('.chat-switcher-button').click();
  const row = page.getByRole('option').filter({ hasText: 'first chat about greetings' });
  await expect(row).toContainText(/Opus[\d. ]* · high/);
  await row.getByRole('button', { name: 'first chat about greetings' }).click();
  await expect(page.locator('.chat-switcher-button')).toContainText('first chat about greetings');
  await expect(page.locator('.msg.user')).toContainText('first chat about greetings');
});

test('a new chat lists its skills before the first message, says it is loading them meanwhile, and says when there are none', async ({ page }) => {
  core = await startCore('multi-turn', { FAKE_CLAUDE_INITIALIZE_MS: '2000' });
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
  await composer.fill('hi');
  await page.keyboard.press('Enter');
  await expect(page.locator('.msg.assistant')).toContainText('OK');
  await composer.fill('/');
  await expect(page.getByTestId('skill-menu-empty')).toHaveText('No skills found.');
  await expect(page.getByTestId('skill-menu-empty')).toHaveAttribute('aria-busy', 'false');
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

test('on a project with no chat yet, the agent starts only after a model is chosen, by keyboard alone, on medium effort', async ({ page }) => {
  core = await startCore('multi-turn', { IDE_DEFAULT_MODEL: '' });
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
  await page.getByPlaceholder('Choose a model to start the agent').fill('hi');
  const send = page.getByRole('button', { name: 'Send' });
  await expect(send).toBeDisabled();
  await expect(send).toHaveAttribute('title', 'Choose a model first');
  await expect(page.getByLabel('Effort')).toHaveCount(0);
  const button = page.locator('.model-button');
  await expect(button).toHaveText(/Select model/);
  await button.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('combobox', { name: 'Search models' })).toBeFocused();
  await page.keyboard.type('son');
  await expect(page.getByRole('option', { selected: true })).toContainText('Sonnet 5.5');
  await page.keyboard.press('Enter');
  await expect(page.getByPlaceholder(/Message the agent/)).toBeFocused();
  await expect(button).toHaveText(/Sonnet 5\.5/);
  await expect(page.getByLabel('Effort')).toHaveValue('medium');
  await page.keyboard.press('Enter');
  await expect(page.locator('.msg.assistant')).toContainText('OK');
  // Every chat agent the core started, oldest first: one, on the model chosen for it.
  const agents = readFileSync(core.record, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    const { argv } = JSON.parse(line) as { argv?: string[] };
    return argv && hasFlag(argv, '--session-id') ? [[flagOf(argv, '--model'), flagOf(argv, '--effort')]] : [];
  });
  expect(agents).toEqual([['sonnet', 'medium']]);
});

test('the model menu filters as you type, moves with the keys, says when nothing matches and gives the focus back, at the narrowest chat panel', async ({ page }) => {
  // The chat panel at its minimum width (LIMITS.right.min, 280 px) in Playwright's default 1280×720 window.
  await page.addInitScript(() => localStorage.setItem('ide.panel-sizes', JSON.stringify({ left: 264, right: 280, bottom: 200 })));
  // A model no list names shows as its id, which may be as long as claude takes.
  const longId = 'claude-opus-5-5-20261013-extended-preview[1m]';
  core = await startCore('multi-turn', { IDE_DEFAULT_MODEL: longId });
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
  const button = page.locator('.model-button');
  await expect(button).toHaveText(longId);
  // The row ends at its right edge, so what does not fit would spill out on the left, where scrollWidth does not see it.
  const spilled = await page.locator('.composer-actions').evaluate((row) => {
    const box = row.getBoundingClientRect();
    return [...row.children].map((child) => child.getBoundingClientRect()).filter((rect) => rect.width > 0 && (rect.left < box.left - 0.5 || rect.right > box.right + 0.5)).length;
  });
  expect(spilled).toBe(0);
  await button.click();
  const menu = page.getByTestId('model-menu');
  const [menuBox, composerBox] = [await menu.boundingBox(), await page.locator('.composer').boundingBox()];
  expect(menuBox!.x >= composerBox!.x && menuBox!.x + menuBox!.width <= composerBox!.x + composerBox!.width).toBe(true);
  await expect(menu.locator('.model-engine')).toHaveText(['Claude']);
  const selected = menu.getByRole('option', { selected: true });
  await expect(selected).toContainText(longId);
  await page.keyboard.press('ArrowDown');
  await expect(selected).toContainText(longId);
  await page.keyboard.press('ArrowUp');
  await expect(selected).toContainText('Haiku 4.5');
  await page.keyboard.press('Home');
  await expect(selected).toContainText('Fable 5.1');
  await page.keyboard.press('End');
  await expect(selected).toContainText(longId);
  await page.keyboard.type('zzz');
  await expect(menu.locator('.model-empty')).toHaveText('No model matches “zzz”');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
});

test('the model menu gives way to another menu, takes a click on a model, and opens on a typed letter', async ({ page }) => {
  core = await startCore('multi-turn');
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
  const button = page.locator('.model-button');
  const menu = page.getByTestId('model-menu');
  await button.click();
  await page.getByRole('button', { name: 'Open project' }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await button.click();
  await menu.getByRole('option', { name: /Opus 5\.5/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(button).toHaveText(/Opus 5\.5/);
  const composer = page.getByPlaceholder(/Message the agent/);
  await expect(composer).toBeFocused();
  // The closed model menu no longer holds back the skill menu.
  await page.keyboard.type('/');
  await expect(page.locator('[data-testid="skill-menu"], [data-testid="skill-menu-empty"]')).toBeVisible();
  await composer.fill('');
  await expect(button).toBeEnabled();
  await button.focus();
  await page.keyboard.press('h');
  await expect(page.getByRole('combobox', { name: 'Search models' })).toHaveValue('h');
  await expect(menu.getByRole('option', { selected: true })).toContainText('Haiku 4.5');
});
