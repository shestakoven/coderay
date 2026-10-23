import { expect, test } from '@playwright/test';
import { startCore, type Core } from './core';
import { chatAgents, chooseModel, openPlanTab, sendMessage } from './helpers';

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
  await openPlanTab(page);
  const panel = page.getByTestId('plan-panel');
  await expect(panel).toContainText('waiting for you');
  await panel.getByRole('button', { name: 'Approve' }).click();
  await expect(panel).toContainText('done');
  await page.getByRole('tab', { name: 'Agent' }).click();

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
  await openPlanTab(page);
  await page.getByTestId('plan-panel').getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('tab', { name: 'Agent' }).click();
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
  expect(chatAgents(core.record)).toEqual([['sonnet', 'medium']]);
});

test('the model menu filters as you type, moves with the keys, says when nothing matches, stays open through an Escape that ends a composition and gives the focus back, at the narrowest chat panel', async ({ page }) => {
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
    return [...row.querySelectorAll('*')].map((inner) => inner.getBoundingClientRect()).filter((rect) => rect.width > 0 && (rect.left < box.left - 0.5 || rect.right > box.right + 0.5)).length;
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
  await page.getByRole('combobox', { name: 'Search models' }).dispatchEvent('keydown', { key: 'Escape', isComposing: true });
  await expect(menu).toBeVisible();
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

test("the model menu keeps its highlighted model as claude's list arrives, scrolls with the keys but not under the mouse, and keeps its search box through a press on its frame", async ({ page }) => {
  // The core's answer is held back, and the test hands the page claude's list while the menu is open.
  const arrive: ((models: object[]) => void)[] = [];
  await page.routeWebSocket(/\/ws\?/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if ((JSON.parse(String(message)) as { type: string }).type !== 'models.snapshot') ws.send(message);
    });
    arrive.push((models) => ws.send(JSON.stringify({ type: 'models.snapshot', models })));
  });
  core = await startCore('multi-turn');
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
  const menu = page.getByTestId('model-menu');
  const selected = menu.getByRole('option', { selected: true });
  await page.locator('.model-button').click();
  await page.keyboard.press('ArrowDown');
  await expect(selected).toContainText('Haiku 4.5');
  // Haiku moves from the fourth row of the built-in list to the first.
  const names = ['Haiku 4.5', 'Sonnet 5.5', ...Array.from({ length: 18 }, (_, at) => `Model ${at + 1}`)];
  arrive.at(-1)?.(names.map((name, at) => ({ value: ['haiku', 'sonnet'][at] ?? `model-${at - 1}`, name, engine: 'claude', efforts: ['medium'] })));
  await expect(menu.getByRole('option')).toHaveCount(names.length);
  await expect(selected).toContainText('Haiku 4.5');

  const list = menu.locator('.model-list');
  // The fourth row half hidden above the list's top edge, where the pointer lands on it.
  const scrolled = await list.evaluate((element) => {
    const row = element.querySelectorAll('.model-row')[3]!;
    element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top + 16;
    return element.scrollTop;
  });
  const box = (await list.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await expect(selected).toContainText('Model 2');
  expect(await list.evaluate((element) => element.scrollTop)).toBe(scrolled);
  await page.keyboard.press('End');
  await expect(selected).toContainText('Model 18');
  await expect(selected).toBeInViewport();

  await menu.locator('.model-foot').click();
  await page.keyboard.type('model 1');
  await expect(page.getByRole('combobox', { name: 'Search models' })).toHaveValue('model 1');
});

test('a Codex chat: choosing GPT-6-Luna makes it a Codex chat that answers, its header names Codex and how it guards writes, and its row in the chat list names Codex', async ({ page }) => {
  core = await startCore('multi-turn', {}, 'tiny', 'multi-turn');
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
  await page.locator('.model-button').click();
  await expect(page.getByTestId('model-menu').locator('.model-engine')).toHaveText(['Claude', 'Codex']);
  await page.keyboard.press('Escape');
  await chooseModel(page, 'luna');
  await sendMessage(page, 'hi');
  await expect(page.locator('.msg.assistant').last()).toHaveText('OK');
  await expect(page.locator('.engine-chip')).toHaveCount(0);
  await expect(page.locator('.agent-view')).toHaveCount(0);
  await page.locator('.chat-switcher-button').click();
  await expect(page.getByRole('option').filter({ hasText: 'hi' }).locator('.chat-list-meta')).toContainText('Codex · GPT-6-Luna · ');
});

test('an opencode chat: choosing Nemotron makes it an opencode chat that answers, offers no effort, its header says opencode guards writes by rules only, and its row names opencode and the model', async ({ page }) => {
  core = await startCore('multi-turn', {}, 'tiny', null, 'reply');
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
  await page.locator('.model-button').click();
  await expect(page.getByTestId('model-menu').locator('.model-engine')).toHaveText(['Claude', 'opencode']);
  await page.keyboard.press('Escape');
  await chooseModel(page, 'nemotron');
  await sendMessage(page, 'hi');
  await expect(page.locator('.msg.assistant').last()).toHaveText('OK');
  await expect(page.locator('.engine-chip')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Effort' })).toHaveCount(0);
  await page.locator('.chat-switcher-button').click();
  await expect(page.getByRole('option').filter({ hasText: 'hi' }).locator('.chat-list-meta')).toContainText('opencode · OpenCode Zen · Nemotron 3.5 Lightning (free) · —');
});
