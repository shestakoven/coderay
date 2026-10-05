import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startCore, startLauncher, type Core, type Launcher } from './core';

let launcher: Launcher | undefined;
let core: Core | undefined;

const folders: string[] = [];

// The folders go after the cores: a core can still be writing into its project until it exits.
test.afterEach(async () => {
  try {
    await launcher?.stop();
    await core?.stop();
  } finally {
    launcher = undefined;
    core = undefined;
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  }
});

function tempFolder(): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ide-start-')));
  folders.push(folder);
  return folder;
}

const action = (page: Page, title: string) => page.locator('.start-action').filter({ hasText: title });

async function browseTo(page: Page, folder: string): Promise<void> {
  const input = page.getByLabel('Folder path');
  // The first listing fills the field when it arrives and would overwrite what is typed before that.
  await expect(input).not.toHaveValue('');
  await input.fill(folder);
  await input.press('Enter');
}

function sourceRepo(): string {
  const path = join(tempFolder(), 'origin');
  mkdirSync(path);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: path, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(path, 'hello.txt'), 'hi');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return path;
}

test('shows the start screen when the core has no project', async ({ page }) => {
  launcher = await startLauncher();
  await page.goto(launcher.url);
  await expect(page.getByRole('heading', { name: 'AI Control IDE' })).toBeVisible();
  await expect(page.getByText('No recent projects yet.')).toBeVisible();
  for (const title of ['Create', 'Open', 'Clone']) await expect(action(page, title)).toBeVisible();
});

test('creates a project and opens it', async ({ page }) => {
  launcher = await startLauncher();
  const parent = tempFolder();
  await page.goto(launcher.url);
  await action(page, 'Create').click();
  await page.getByLabel('Project name').fill('fresh');
  await browseTo(page, parent);
  await expect(page.getByText(`Creates ${join(parent, 'fresh')}`)).toBeVisible();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.project')).toHaveText('fresh', { timeout: 60_000 });
  expect(existsSync(join(parent, 'fresh', '.git'))).toBe(true);
});

test('keeps the form and shows the reason when the name is taken', async ({ page }) => {
  launcher = await startLauncher();
  const parent = tempFolder();
  mkdirSync(join(parent, 'taken'));
  writeFileSync(join(parent, 'taken', 'keep.txt'), 'mine');
  await page.goto(launcher.url);
  await action(page, 'Create').click();
  await page.getByLabel('Project name').fill('taken');
  await browseTo(page, parent);
  await expect(page.getByText(`Creates ${join(parent, 'taken')}`)).toBeVisible();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('already exists');
  await expect(page.getByLabel('Project name')).toHaveValue('taken');
});

test('clones a repository and opens it', async ({ page }) => {
  launcher = await startLauncher();
  const origin = sourceRepo();
  const parent = tempFolder();
  await page.goto(launcher.url);
  await action(page, 'Clone').click();
  await page.getByLabel('Repository URL').fill(origin);
  await browseTo(page, parent);
  await expect(page.getByText(`Clones into ${join(parent, 'origin')}`)).toBeVisible();
  await page.getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(page.locator('.project')).toHaveText('origin', { timeout: 60_000 });
  expect(existsSync(join(parent, 'origin', 'hello.txt'))).toBe(true);
});

test('shows the error git prints for a repository that does not exist', async ({ page }) => {
  launcher = await startLauncher();
  const parent = tempFolder();
  await page.goto(launcher.url);
  await action(page, 'Clone').click();
  await page.getByLabel('Repository URL').fill(join(tempFolder(), 'no-such-repo'));
  await page.getByLabel('Folder name').fill('copy');
  await browseTo(page, parent);
  await expect(page.getByText(`Clones into ${join(parent, 'copy')}`)).toBeVisible();
  await page.getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(existsSync(join(parent, 'copy'))).toBe(false);
});

test('opens a recent project', async ({ page }) => {
  launcher = await startLauncher();
  const project = tempFolder();
  writeFileSync(join(project, 'a.txt'), 'x');
  writeFileSync(join(launcher.home, 'recent-projects.json'), JSON.stringify({ version: 1, projects: [{ path: project, name: 'recent-one', openedAt: Date.now() - 3_600_000 }] }));
  await page.goto(launcher.url);
  await expect(page.getByText('1 h ago')).toBeVisible();
  await page.getByRole('button', { name: /recent-one/ }).click();
  await expect(page.locator('.project')).toHaveText(/./, { timeout: 60_000 });
  await expect(page.getByText('core connected')).toBeVisible();
});

test('an error from a recent project shows beside the list and collapses the open form', async ({ page }) => {
  launcher = await startLauncher();
  const project = tempFolder();
  writeFileSync(join(launcher.home, 'recent-projects.json'), JSON.stringify({ version: 1, projects: [{ path: project, name: 'recent-gone', openedAt: Date.now() }] }));
  await page.goto(launcher.url);
  await action(page, 'Create').click();
  await expect(page.getByLabel('Project name')).toBeVisible();
  rmSync(project, { recursive: true });
  await page.getByRole('button', { name: /recent-gone/ }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Project name')).toHaveCount(0);
  await expect(page.locator('.start-recent').getByRole('alert')).toBeVisible();
});

test('the folder list and the Create button work again after the Open dialog was cancelled', async ({ page }) => {
  launcher = await startLauncher();
  await page.goto(launcher.url);
  await action(page, 'Create').click();
  await expect(page.getByLabel('Folder path')).not.toHaveValue('');
  await action(page, 'Open').click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await action(page, 'Create').click();
  await expect(page.getByLabel('Folder path')).not.toHaveValue('');
  await expect(page.locator('.dirs')).toBeVisible();
  await page.getByLabel('Project name').fill('again');
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
});

test('closing the project returns to the start screen', async ({ page }) => {
  core = await startCore('text-then-wait');
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+KeyP');
  await page.getByRole('option', { name: /Close this project/ }).click();
  await expect(page.getByRole('heading', { name: 'AI Control IDE' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.start-recent-row')).toHaveCount(1);
});
