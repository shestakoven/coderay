import { expect, test } from '@playwright/test';
import { startCore, type Core } from './core';
import { openPlanTab, sendMessage } from './helpers';

let core: Core | undefined;

test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

test('approve a plan: it waits on the map, and its write happens after Approve', async ({ page }) => {
  core = await startCore('gate-big-plan');
  await page.goto(core.url);
  await sendMessage(page, 'fix them');
  await openPlanTab(page);
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

test('plan flow: the view opens for a waiting plan, Now hides the new parts, approval turns the parts green', async ({ page }) => {
  core = await startCore('gate-flow-plan');
  await page.goto(core.url);
  await sendMessage(page, 'fix them');
  await expect(page.getByTestId('steer-bar')).toBeVisible();
  await expect(page.getByTestId('plan-flow')).toBeVisible();

  const greeter = page.getByTestId('flow-node-greeter');
  const app = page.getByTestId('flow-node-app');
  await expect(greeter).toHaveAttribute('data-state', 'create');
  await expect(greeter).toHaveAttribute('data-phase', 'proposed');
  await expect(greeter).toHaveAttribute('data-hidden', 'false');

  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await expect(greeter).toHaveAttribute('data-hidden', 'true');
  await expect(app).toHaveAttribute('data-hidden', 'false');
  await app.hover();
  await expect(greeter).toHaveCSS('opacity', '0');
  const caller = page.getByTestId('flow-node-caller');
  let lastBox = '';
  await expect.poll(async () => {
    const box = JSON.stringify(await caller.boundingBox());
    const still = box === lastBox;
    lastBox = box;
    return still;
  }, { intervals: [150] }).toBe(true);
  await caller.hover();
  await expect(greeter).toHaveClass(/dim/);
  await expect(greeter).toHaveAttribute('data-hidden', 'true');
  await greeter.evaluate((el) => Promise.all(el.getAnimations().map((animation: { finished: Promise<unknown> }) => animation.finished.catch(() => undefined))));
  await expect(greeter).toHaveCSS('opacity', '0');
  await page.getByRole('button', { name: 'After the plan' }).click();
  await expect(greeter).toHaveAttribute('data-hidden', 'false');

  await app.click();
  await expect(page.getByTestId('flow-details')).toContainText('src/app.ts');
  await expect(page.getByTestId('flow-details')).toContainText('format(name)');

  await page.getByTestId('steer-approve').click();
  await openPlanTab(page);
  await expect(page.getByTestId('plan-panel')).toContainText('Plan v1 · done');
  await expect(app).toHaveAttribute('data-phase', 'done');
  await expect(greeter).toHaveAttribute('data-phase', 'done');
});

test('plan flow: a plan without a flow has no Plan flow button and no view switch', async ({ page }) => {
  core = await startCore('gate-big-plan');
  await page.goto(core.url);
  await sendMessage(page, 'fix them');
  await openPlanTab(page);
  await expect(page.getByTestId('plan-panel')).toContainText('Plan v1 · waiting for you');
  await expect(page.getByRole('button', { name: 'Plan flow' })).toHaveCount(0);
  await expect(page.getByTestId('plan-flow')).toHaveCount(0);
  await expect(page.locator('.view-switch')).toHaveCount(0);
});

test('request changes: Enter on blank text keeps the box open, Shift+Enter adds a line, Enter sends it', async ({ page }) => {
  core = await startCore('gate-big-plan');
  await page.goto(core.url);
  await sendMessage(page, 'fix them');
  await openPlanTab(page);
  const panel = page.getByTestId('plan-panel');
  await expect(panel).toContainText('Plan v1 · waiting for you');
  await panel.getByRole('button', { name: 'Request changes' }).click();
  const feedback = panel.locator('.plan-feedback');
  await expect(feedback).toBeFocused();

  await page.keyboard.press('Enter');
  await feedback.fill('   ');
  await page.keyboard.press('Enter');
  await expect(feedback).toBeVisible();
  await expect(panel).toContainText('Plan v1 · waiting for you');

  await feedback.fill('first line');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second line');
  await expect(feedback).toHaveValue('first line\nsecond line');
  await expect(panel).toContainText('Plan v1 · waiting for you');

  await page.keyboard.press('Enter');
  await expect(feedback).toHaveCount(0);
  await expect(panel).toContainText('Plan v1 · changes requested');
  await expect(panel).toContainText('first line second line');
});
