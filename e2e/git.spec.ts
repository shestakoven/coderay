import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startCore, type Core } from './core';

let core: Core | undefined;

test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

test('stage, commit, diff and branch from the Git tab', async ({ page }) => {
  core = await startCore('gate-big-plan');
  git(core.root, 'config', 'user.name', 'E2E');
  git(core.root, 'config', 'user.email', 'e2e@example.com');
  git(core.root, 'config', 'commit.gpgsign', 'false');
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
  await page.keyboard.press('Control+Shift+G');
  const panel = page.getByTestId('git-panel');
  await expect(panel).toBeVisible();

  await panel.getByRole('button', { name: 'Stage all untracked' }).click();
  await panel.getByTestId('git-commit-message').fill('first commit');
  await panel.getByTestId('git-commit').click();
  await expect(panel.getByText('No changes')).toBeVisible();
  expect(git(core.root, 'log', '-1', '--format=%s').trim()).toBe('first commit');

  writeFileSync(join(core.root, 'notes.md'), 'hello\nworld\n');
  const row = panel.getByRole('option', { name: /notes\.md/ });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId('git-diff')).toContainText('world');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('git-diff')).toHaveCount(0);

  await panel.getByRole('button', { name: 'Stage notes.md' }).click();
  await expect(panel.getByRole('button', { name: 'Unstage notes.md' })).toBeVisible();
  await panel.getByTestId('git-commit-message').fill('add notes');
  await panel.getByTestId('git-commit-message').press('Control+Enter');
  await expect(panel.getByText('No changes')).toBeVisible();

  await page.getByTestId('branch-chip').click();
  await page.getByTestId('branch-search').fill('feature/e2e');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('branch-chip')).toContainText('feature/e2e');
  expect(git(core.root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/e2e');
});
