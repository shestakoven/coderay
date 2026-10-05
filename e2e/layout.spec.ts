import { expect, test } from '@playwright/test';
import { startCore, type Core } from './core';

let core: Core | undefined;

test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

const width = async (page: import('@playwright/test').Page, selector: string): Promise<number> =>
  Math.round((await page.locator(selector).boundingBox())!.width);

test('panels resize by dragging and by keyboard, keep their size after a reload and reset on double-click', async ({ page }) => {
  core = await startCore('gate-big-plan');
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();

  const left = page.getByRole('separator', { name: 'Resize project panel' });
  expect(await width(page, '.left-panel')).toBe(264);
  const box = (await left.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 101, box.y + 200, { steps: 5 });
  await page.mouse.up();
  expect(await width(page, '.left-panel')).toBe(364);

  const right = page.getByRole('separator', { name: 'Resize agent panel' });
  const rbox = (await right.boundingBox())!;
  await page.mouse.move(rbox.x + 1, rbox.y + 200);
  await page.mouse.down();
  await page.mouse.move(rbox.x - 59, rbox.y + 200, { steps: 5 });
  await page.mouse.up();
  expect(await width(page, '.right-panel')).toBe(400);

  await left.focus();
  await page.keyboard.press('ArrowLeft');
  expect(await width(page, '.left-panel')).toBe(348);
  await page.keyboard.press('Shift+ArrowLeft');
  expect(await width(page, '.left-panel')).toBe(284);

  await page.reload();
  await expect(page.getByText('core connected')).toBeVisible();
  expect(await width(page, '.left-panel')).toBe(284);
  expect(await width(page, '.right-panel')).toBe(400);

  // The handle is a zero-width strip with a wider hit area, so it is reached by position.
  const handle = (await page.getByRole('separator', { name: 'Resize project panel' }).boundingBox())!;
  await page.mouse.dblclick(handle.x, handle.y + 200);
  expect(await width(page, '.left-panel')).toBe(264);
});

test('a panel cannot be dragged below its minimum or past the room the map needs', async ({ page }) => {
  core = await startCore('gate-big-plan');
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
  const left = page.getByRole('separator', { name: 'Resize project panel' });
  let box = (await left.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x - 400, box.y + 200, { steps: 4 });
  await page.mouse.up();
  expect(await width(page, '.left-panel')).toBe(200);
  box = (await left.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 900, box.y + 200, { steps: 4 });
  await page.mouse.up();
  const map = await width(page, '.map-area');
  expect(map).toBeGreaterThanOrEqual(320);
});

test('the timeline height can be resized when it is open', async ({ page }) => {
  core = await startCore('gate-big-plan');
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
  await page.getByRole('button', { name: /^Timeline/ }).click();
  const handle = page.getByRole('separator', { name: 'Resize timeline' });
  await expect(handle).toBeAttached();
  await handle.focus();
  await page.keyboard.press('ArrowUp');
  await expect(handle).toHaveAttribute('aria-valuenow', '216');
  await page.keyboard.press('End');
  await expect(handle).toHaveAttribute('aria-valuenow', '480');
});
