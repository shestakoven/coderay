import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startLauncher, type Launcher } from './core';

let launcher: Launcher | undefined;
let work: string | undefined;

test.afterEach(async () => {
  await launcher?.stop();
  launcher = undefined;
  if (work) rmSync(work, { recursive: true, force: true });
  work = undefined;
  // A form that lost its folder choice creates in the home folder; these pid-suffixed names exist only for this run.
  for (const name of ['taken', 'alpha', 'beta']) rmSync(join(homedir(), unique(name)), { recursive: true, force: true });
});

const MARKER = 'contract-marker';
const unique = (name: string): string => `${name}-${process.pid}`;

function workDir(): string {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'ide-e2e-start-contract-')));
  mkdirSync(join(work, MARKER));
  return work;
}

const startScreen = (page: Page) => page.getByRole('heading', { name: 'CodeRay' });
const recent = (page: Page) => page.getByRole('complementary', { name: 'Recent projects' });

const folders = (page: Page) => page.getByRole('list', { name: 'Folders' });

// The form first lists the home folder; typing before that listing lands loses the typed path (see the test below).
async function chooseFolder(page: Page, path: string): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Folder path' });
  await expect(field).toHaveValue(launcher!.userHome);
  await field.fill(path);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(folders(page).getByRole('button', { name: MARKER, exact: true })).toBeVisible();
  await expect(field).toHaveValue(path);
}

async function create(page: Page, parent: string, name: string): Promise<void> {
  await page.getByRole('button', { name: /^Create A new folder/ }).click();
  await chooseFolder(page, parent);
  await page.getByRole('textbox', { name: 'Project name' }).fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
}

async function closeProject(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+KeyP');
  await page.getByRole('option', { name: /Close this project/ }).click();
  await expect(startScreen(page)).toBeVisible({ timeout: 60_000 });
}

test('a folder path typed right after opening the Create form is not replaced by the home listing', async ({ page }) => {
  const dir = workDir();
  launcher = await startLauncher();
  await page.goto(launcher.url);
  await page.getByRole('button', { name: /^Create A new folder/ }).click();
  const field = page.getByRole('textbox', { name: 'Folder path' });
  await field.fill(dir);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(folders(page).getByRole('button', { name: MARKER, exact: true })).toBeVisible();
  await expect(field).toHaveValue(dir);
});

test('a failed clone shows git\'s own error text and keeps the form', async ({ page }) => {
  const dir = workDir();
  launcher = await startLauncher();
  await page.goto(launcher.url);
  await page.getByRole('button', { name: /^Clone A git repository/ }).click();
  await page.getByRole('textbox', { name: 'Repository URL' }).fill(join(dir, 'nope.git'));
  await page.getByRole('textbox', { name: 'Folder name' }).fill('target');
  await chooseFolder(page, dir);
  await page.getByRole('button', { name: 'Clone', exact: true }).click();

  await expect(page.getByText(/nope\.git' does not exist/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('textbox', { name: 'Repository URL' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clone', exact: true })).toBeEnabled();
  expect(existsSync(join(dir, 'target'))).toBe(false);
});

test('creating into a taken folder name shows the error and leaves the user\'s file intact', async ({ page }) => {
  const dir = workDir();
  const taken = unique('taken');
  mkdirSync(join(dir, taken));
  writeFileSync(join(dir, taken, 'notes.txt'), 'keep me');
  launcher = await startLauncher();
  await page.goto(launcher.url);
  await create(page, dir, taken);

  await expect(page.getByText(/already exists/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible();
  expect(readdirSync(join(dir, taken))).toEqual(['notes.txt']);
  expect(readFileSync(join(dir, taken, 'notes.txt'), 'utf8')).toBe('keep me');
});

test('a closed project is listed in Recent, and Recent opens the row that was clicked', async ({ page }) => {
  const dir = workDir();
  const alpha = unique('alpha');
  const beta = unique('beta');
  launcher = await startLauncher();
  await page.goto(launcher.url);

  await create(page, dir, alpha);
  await expect(page.getByRole('tab', { name: alpha, exact: true })).toBeVisible({ timeout: 60_000 });
  await closeProject(page, alpha);
  await expect(recent(page).getByRole('button', { name: new RegExp(alpha) })).toBeVisible();

  await create(page, dir, beta);
  await expect(page.getByRole('tab', { name: beta, exact: true })).toBeVisible({ timeout: 60_000 });
  await closeProject(page, beta);
  await expect(recent(page).getByRole('button', { name: new RegExp(beta) })).toBeVisible();
  await expect(recent(page).getByRole('button', { name: new RegExp(alpha) })).toBeVisible();

  await recent(page).getByRole('button', { name: new RegExp(alpha) }).click();
  await expect(page.getByRole('tab', { name: alpha, exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('tab', { name: beta, exact: true })).toHaveCount(0);
});
