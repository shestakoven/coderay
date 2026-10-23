import { expect, test, type Page } from '@playwright/test';
import { startCore, type Core } from './core';
import { openPlanTab, sendMessage } from './helpers';

let core: Core | undefined;

test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

async function openWaitingPlan(page: Page, scenario = 'gate-flow-plan'): Promise<void> {
  core = await startCore(scenario);
  await page.goto(core.url);
  await sendMessage(page, 'fix them');
  await expect(page.getByTestId('steer-bar')).toBeVisible();
  await expect(page.getByTestId('plan-flow')).toBeVisible();
}

// A click on the selected part clears the selection, so click only a part that is not selected yet.
async function select(page: Page, id: string): Promise<void> {
  const card = page.getByTestId(`flow-node-${id}`);
  if (!(await card.evaluate((el) => el.classList.contains('selected')))) await card.click();
  await expect(card).toHaveClass(/selected/);
}

// Selects a part, then drafts a change with the keys: the key opens the editor, Enter saves.
async function draft(page: Page, id: string, key: 'c' | 'a', text: string): Promise<void> {
  await select(page, id);
  await page.keyboard.press(key);
  await page.getByTestId('steer-pop').locator('textarea').fill(text);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('steer-pop')).toBeHidden();
}

// A key the map ignores leaves nothing to wait for: two frames let the render a wrong reaction would cause happen first.
const settle = (page: Page) => page.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');

const expectChanges = (page: Page, count: number) =>
  expect(page.getByTestId('steer-changes')).toHaveText(new RegExp(`^${count}\\s*changes?$`));

async function openList(page: Page): Promise<void> {
  if (await page.getByTestId('steer-draft').count() === 0) await page.getByTestId('steer-changes').click();
  await expect(page.getByTestId('steer-draft')).toBeVisible();
}

const draftItems = async (page: Page): Promise<string[]> => {
  await openList(page);
  return page.getByTestId('steer-item').allInnerTexts();
};

test('steer a waiting plan: comment on a part, add a part, read the message, send, and the map waits read-only', async ({ page }) => {
  await openWaitingPlan(page);
  const step = page.getByTestId('flow-step-1');
  await expect(step).toContainText('Fix the greetings');
  await expect(step).toContainText('They have typos');
  await expect(step).toContainText('2 files');

  const app = page.getByTestId('flow-node-app');
  await app.hover();
  await app.getByRole('button', { name: 'Comment' }).click();
  await page.getByTestId('steer-pop').locator('textarea').fill('use the shared formatter');
  await page.keyboard.press('Enter');
  await expect(app).toContainText('use the shared formatter');

  const greeter = page.getByTestId('flow-node-greeter');
  await greeter.hover();
  await greeter.getByRole('button', { name: 'Add a part after this' }).click();
  await page.getByTestId('steer-pop').locator('textarea').fill('log every greeting');
  await page.keyboard.press('Enter');
  const ghost = page.getByTestId('flow-node-~ask-1');
  await expect(ghost).toBeVisible();
  await expect(ghost).toContainText('ASK');
  await expectChanges(page, 2);

  const items = await draftItems(page);
  expect(items).toHaveLength(2);
  expect(items[0]).toContain('greeting (app)');
  expect(items[0]).toContain('use the shared formatter');
  expect(items[1]).toContain('after Greeter (greeter)');
  expect(items[1]).toContain('log every greeting');

  await page.getByRole('button', { name: 'Message' }).click();
  const message = [
    'Please revise the plan.',
    '',
    'Notes',
    '- greeting (app): use the shared formatter',
    '',
    'Add',
    '- after Greeter (greeter): log every greeting',
  ].join('\n');
  expect(await page.getByTestId('steer-message').textContent()).toBe(message);

  await page.getByTestId('steer-send').click();
  await openPlanTab(page);
  const panel = page.getByTestId('plan-panel');
  await expect(panel).toContainText('Plan v1 · changes requested');
  expect(await panel.locator('.plan-note', { hasText: 'Please revise the plan.' }).textContent()).toBe(message);

  const bar = page.getByTestId('steer-bar');
  await expect(bar).toHaveAttribute('data-phase', 'sending');
  await expect(bar).toContainText('Sent to the agent');
  await expect(ghost).toHaveCount(0);
  await expect(page.getByTestId('flow-node-app')).not.toContainText('use the shared formatter');
  await expect(page.getByTestId('steer-approve')).toHaveCount(0);
  await expect(page.getByTestId('steer-changes')).toHaveCount(0);
  await select(page, 'app');
  await page.keyboard.press('c');
  await expect(page.getByTestId('steer-pop')).toHaveCount(0);
  await page.getByTestId('flow-node-app').hover();
  await expect(page.getByRole('button', { name: 'Comment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a part after this' })).toHaveCount(0);
});

test('steer a link: Esc, Remove, undo and Reset keep the draft right, and Cmd+Enter on an empty draft does not approve', async ({ page }) => {
  await openWaitingPlan(page);

  const link = page.getByTestId('flow-edge-1');
  await link.hover();
  await link.getByRole('button', { name: 'Comment' }).click();
  await page.getByTestId('steer-pop').locator('textarea').fill('rename the method');
  await page.keyboard.press('Enter');
  await expectChanges(page, 1);
  expect((await draftItems(page))[0]).toContain('greeting (app) → Greeter (greeter)');

  await select(page, 'greeter');
  await page.keyboard.press('c');
  await page.getByTestId('steer-pop').locator('textarea').fill('never saved');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('steer-pop')).toHaveCount(0);
  await expectChanges(page, 1);

  await draft(page, 'app', 'a', 'cache greetings');
  await expectChanges(page, 2);
  const ghost = page.getByTestId('flow-node-~ask-1');
  await expect(ghost).toBeVisible();

  await openList(page);
  await page.getByTestId('steer-item').filter({ hasText: 'cache greetings' }).getByRole('button', { name: 'Remove this change' }).click();
  await expectChanges(page, 1);
  await expect(ghost).toHaveCount(0);
  expect(await draftItems(page)).toEqual([expect.stringContaining('rename the method')]);

  await page.keyboard.press('ControlOrMeta+z');
  await expectChanges(page, 2);
  await expect(ghost).toBeVisible();

  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(ghost).toHaveCount(0);
  await expect(page.getByTestId('steer-changes')).toHaveCount(0);
  await expect(page.getByTestId('steer-approve')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+Enter');
  await draft(page, 'app', 'c', 'check the casing');
  await page.keyboard.press('ControlOrMeta+Enter');
  await openPlanTab(page);
  const panel = page.getByTestId('plan-panel');
  await expect(panel).toContainText('Plan v1 · changes requested');
  expect(await panel.locator('.plan-note', { hasText: 'Please revise the plan.' }).textContent())
    .toBe('Please revise the plan.\n\nNotes\n- greeting (app): check the casing');
});

test('Approve as is with a pending draft approves the plan and sends nothing as changes', async ({ page }) => {
  await openWaitingPlan(page);
  await draft(page, 'app', 'c', 'use the shared formatter');
  await draft(page, 'greeter', 'a', 'log every greeting');
  await draft(page, '~ask-1', 'c', 'which logger?');
  await expectChanges(page, 3);
  await page.keyboard.press('Backspace');
  await expect(page.getByTestId('flow-node-~ask-1')).toHaveCount(0);
  await expectChanges(page, 1);

  await page.getByRole('button', { name: 'Approve as is' }).click();
  await openPlanTab(page);
  const panel = page.getByTestId('plan-panel');
  await expect(panel).toContainText('Plan v1 · done');
  await expect(panel).not.toContainText('changes requested');
  await expect(panel).not.toContainText('use the shared formatter');
  await expect(page.getByTestId('flow-node-app')).not.toContainText('use the shared formatter');
  await expect.poll(() => core?.file('src/app.ts')).toBe("export const greeting = 'hello';\n");
  await expect(page.getByTestId('steer-changes')).toHaveCount(0);
});

test('removing a requested part from the list takes the comment written on it along', async ({ page }) => {
  await openWaitingPlan(page);
  await draft(page, 'greeter', 'a', 'log every greeting');
  await draft(page, '~ask-1', 'c', 'which logger?');
  await expectChanges(page, 2);
  await openList(page);
  await page.getByTestId('steer-item').filter({ hasText: 'after Greeter (greeter)' }).getByRole('button', { name: 'Remove this change' }).click();
  await expect(page.getByTestId('flow-node-~ask-1')).toHaveCount(0);
  await expect(page.getByTestId('steer-changes')).toHaveCount(0);
});

test('keys belong to the map: not with focus elsewhere, in any layout, and not on the link of a request', async ({ page }) => {
  await openWaitingPlan(page);
  const pop = page.getByTestId('steer-pop');
  await select(page, 'app');

  await page.getByRole('tab').filter({ hasText: /^Plan$/ }).focus();
  await page.keyboard.press('c');
  await settle(page);
  await expect(pop).toHaveCount(0);
  await page.locator(':focus').evaluate((el) => el.blur());

  await page.locator('body').dispatchEvent('keydown', { code: 'KeyC', key: 'с' });
  await expect(pop).toBeVisible();
  await pop.locator('textarea').fill('use the shared formatter');
  await page.keyboard.press('Enter');
  await expectChanges(page, 1);

  await page.locator('body').dispatchEvent('keydown', { code: 'KeyZ', key: 'Z', ctrlKey: true, shiftKey: true });
  await settle(page);
  await expectChanges(page, 1);
  await page.locator('body').dispatchEvent('keydown', { code: 'KeyZ', key: 'я', ctrlKey: true });
  await expect(page.getByTestId('steer-changes')).toHaveCount(0);

  await draft(page, 'greeter', 'a', 'log every greeting');
  await page.getByTestId('flow-edge-1').click();
  await page.keyboard.press('c');
  await expect(pop).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('flow-details')).toHaveCount(0);

  // The pill of a request's link is not interactive: the mouse lands on the line under it, which is how a user reaches the link.
  const requested = page.getByTestId('flow-edge-2');
  await requested.hover({ force: true });
  await expect(requested).toContainText('requested');
  await expect(requested.getByRole('button', { name: 'Comment' })).toHaveCount(0);
  await requested.click({ force: true });
  await expect(page.getByTestId('flow-details')).toBeVisible();
  await expect(page.getByTestId('flow-details').getByRole('button', { name: 'Comment' })).toHaveCount(0);
  await page.keyboard.press('c');
  await settle(page);
  await expect(pop).toHaveCount(0);
});

test('a draft is not drawn once the plan is approved with Approve plan', async ({ page }) => {
  await openWaitingPlan(page);
  await draft(page, 'app', 'c', 'use the shared formatter');
  await draft(page, 'greeter', 'a', 'log every greeting');
  const ghost = page.getByTestId('flow-node-~ask-1');
  await expect(ghost).toBeVisible();

  await page.getByRole('button', { name: 'Approve as is' }).click();
  await openPlanTab(page);
  await expect(page.getByTestId('plan-panel')).toContainText('Plan v1 · done');
  await expect(ghost).toHaveCount(0);
  await expect(page.getByTestId('flow-node-app')).not.toContainText('use the shared formatter');
  await expect(page.getByTestId('steer-bar')).toHaveCount(0);
});

test('leaving the editor with text keeps it, and Esc throws it away', async ({ page }) => {
  await openWaitingPlan(page);
  const pop = page.getByTestId('steer-pop');
  const app = page.getByTestId('flow-node-app');

  await select(page, 'app');
  await page.keyboard.press('c');
  await pop.locator('textarea').fill('use the shared formatter');
  await page.locator('.react-flow__pane').click({ position: { x: 40, y: 420 } });
  await expect(pop).toHaveCount(0);
  await expect(app).toContainText('use the shared formatter');
  await expectChanges(page, 1);

  await select(page, 'greeter');
  await page.keyboard.press('c');
  await pop.locator('textarea').fill('thrown away');
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expect(page.getByTestId('flow-node-greeter')).not.toContainText('thrown away');
  await expectChanges(page, 1);
});

test('the map shows today without what does not exist yet, and the sent bar spins only while the agent works', async ({ page }) => {
  await openWaitingPlan(page, 'gate-flow-plan-hold');
  const details = page.getByTestId('flow-details');
  await select(page, 'greeter');
  await expect(details).toBeVisible();
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await expect(details).toHaveCount(0);
  await page.getByRole('button', { name: 'After the plan', exact: true }).click();
  await expect(details).toBeVisible();

  await draft(page, 'app', 'c', 'use the shared formatter');
  await page.getByTestId('steer-send').click();
  const bar = page.getByTestId('steer-bar');
  await expect(bar).toHaveAttribute('data-phase', 'sending');
  await expect(bar).toContainText('it is revising the plan');
  await expect(bar.locator('.pf-spin')).toBeVisible();

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(bar).toContainText('it is not working on the plan now');
  await expect(bar.locator('.pf-spin')).toHaveCount(0);
});

test('clicking Approve plan while a comment is typed keeps the comment and does not approve', async ({ page }) => {
  await openWaitingPlan(page);
  await select(page, 'app');
  await page.keyboard.press('c');
  await page.getByTestId('steer-pop').locator('textarea').fill('typed, then approve clicked');
  await page.getByTestId('steer-approve').click();
  // The click first keeps the typed text as a comment, and the bar turns into its "changes" form: a plan with a remark is never approved by one click.
  await expect(page.getByTestId('steer-changes')).toContainText(/1\s*change/);
  await expect(page.getByTestId('steer-bar')).toBeVisible();
  await expect(page.getByTestId('flow-node-app')).toContainText('typed, then approve clicked');
});
