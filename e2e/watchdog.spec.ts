import { expect, test } from '@playwright/test';
import { readRecords } from '../packages/core/test/fake-claude/fake';
import { startCore, type Core } from './core';
import { sendMessage } from './helpers';

let core: Core | undefined;

test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

async function openWatchdog(page: import('@playwright/test').Page) {
  core = await startCore('exec-mcp-write-out-of-plan');
  await page.goto(core.url);
  await sendMessage(page, 'Fix the greeting');
  await expect(page.locator('.plan-chip')).toHaveClass(/approved/);
  const dialog = page.getByTestId('watchdog-dialog');
  await expect(dialog).toContainText('src/other.ts');
  return dialog;
}

test('a watchdog dialog with revert', async ({ page }) => {
  const dialog = await openWatchdog(page);
  expect(core!.file('src/other.ts')).toContain('changed');
  await expect(page.locator('.node.out-of-plan')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Revert all' }).click();
  await expect.poll(() => core!.file('src/other.ts')).not.toContain('changed');
  await page.getByTestId('timeline').getByRole('button').first().click();
  await expect(page.getByTestId('timeline')).toContainText('reverted');
  await expect(dialog).toHaveCount(0);
});

test('keep tells the agent what was kept', async ({ page }) => {
  const dialog = await openWatchdog(page);
  await dialog.getByRole('button', { name: 'Keep all' }).click();
  await expect(dialog).toHaveCount(0);
  expect(core!.file('src/other.ts')).toContain('changed');
  await expect
    .poll(() =>
      readRecords(core!.record)
        .flatMap((r) => (r.stdin?.type === 'user' ? [String((r.stdin.message as { content: unknown }).content)] : []))
        .find((t) => t.includes('[IDE]') && t.includes('src/other.ts')),
    )
    .toBeTruthy();
});
