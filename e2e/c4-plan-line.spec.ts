import { expect, test } from '@playwright/test';
import { startCore, type Core } from './core';
import { sendMessage } from './helpers';

let core: Core | undefined;

test.use({ viewport: { width: 1600, height: 1000 } });

test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

test('c4: in an open container the cards keep their plan line inside the border and open their details', async ({ page }) => {
  core = await startCore('gate-big-plan', {}, 'c4-web');
  await page.goto(core.url);
  await sendMessage(page, 'fix them');
  const panel = page.getByTestId('plan-panel');
  await expect(panel).toContainText('Plan v1 · waiting for you');
  await panel.getByRole('button', { name: 'Approve' }).click();
  await expect(panel).toContainText('Plan v1 · done');
  await page.locator('[data-id="container:web"]').dblclick();

  const both = page.locator('.c4-card.component.in-plan', { has: page.locator('.change-line') });
  await expect(both.locator('.c4-plan-line')).toBeVisible();
  const overflow = () =>
    page.locator('.c4-card.in-plan').evaluateAll((cards) =>
      cards.flatMap((card) => {
        const line = card.querySelector('.c4-plan-line');
        return line ? [line.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom] : [];
      }),
    );
  await expect.poll(async () => Math.max(...(await overflow())), { message: 'plan line bottom minus card bottom, px' }).toBeLessThanOrEqual(0);
  // Shell (change line and plan line), Views, State and the Libraries card (plan line).
  expect(await overflow()).toHaveLength(4);
  await page.screenshot({ path: '/private/tmp/claude-501/-Users-evgeny-code-pet-IDE/d541650e-5e4e-4fb3-aad5-46a3af18a744/scratchpad/c4-planline.png' });

  const details = page.locator('.details-slot');
  await page.locator('[data-id="container:web/views"]').click();
  await expect(details.getByRole('heading', { name: 'Views' })).toBeVisible();
  await expect(details.getByText('Select a component or file')).toBeHidden();
  await page.locator('[data-id="container:web/shared"]').click();
  await expect(details.getByRole('heading', { name: /^Libraries ·/ })).toBeVisible();
});
