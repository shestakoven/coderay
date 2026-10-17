import { expect, test, type Locator, type Page } from '@playwright/test';
import { startCore, type Core } from './core';

let core: Core | undefined;

test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

async function openApp(page: Page, width = 1400): Promise<void> {
  core = await startCore('text-then-wait');
  await page.setViewportSize({ width, height: 900 });
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
}

const settingsDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Settings' });

async function openSettings(page: Page): Promise<Locator> {
  await page.keyboard.press('Control+,');
  const dialog = settingsDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

async function showCategory(dialog: Locator, name: string): Promise<void> {
  await dialog.getByRole('tab', { name, exact: true }).click();
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText(name);
}

const setting = (dialog: Locator, title: string): Locator => dialog.getByRole('region', { name: title, exact: true });
const modeSetting = (dialog: Locator): Locator => setting(dialog, 'When the agent writes outside the plan');
const mode = (dialog: Locator, name: string): Locator =>
  dialog.getByRole('radiogroup', { name: 'When the agent writes outside the plan' }).getByRole('radio', { name: new RegExp(`^${name}\\b`) });
const scope = (dialog: Locator, name: string): Locator =>
  dialog.getByRole('radiogroup', { name: 'Where these settings apply' }).getByRole('radio', { name, exact: true });
const saveBar = (page: Page): Locator => page.getByRole('region', { name: 'Unsaved changes' });
const toast = (page: Page, text: string): Locator => page.getByRole('status').filter({ hasText: text });
const chips = (list: Locator): Locator => list.getByRole('button', { name: /^Remove / });

async function saveWithButton(page: Page): Promise<void> {
  await saveBar(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(toast(page, 'Settings saved')).toBeVisible();
  await expect(saveBar(page)).toBeHidden();
}

const field = (form: Locator, label: string): Locator => form.getByRole('textbox', { name: new RegExp(`^${label}`) });
const fieldError = (form: Locator, label: string): Locator =>
  form.locator('label').filter({ has: form.page().getByRole('textbox', { name: new RegExp(`^${label}`) }) }).getByRole('alert');

async function paste(input: Locator, text: string): Promise<void> {
  await input.evaluate((element, pasted) => {
    const view = element.ownerDocument.defaultView!;
    const data = new view.DataTransfer();
    data.setData('text/plain', pasted);
    element.dispatchEvent(new view.ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

async function addPattern(list: Locator, pattern: string): Promise<void> {
  await list.getByRole('textbox', { name: 'Add a pattern' }).fill(pattern);
  await list.getByRole('textbox', { name: 'Add a pattern' }).press('Enter');
}

const htmlAttribute = (page: Page, name: string): Promise<string | null> => page.locator('html').getAttribute(name);
const fontScale = (page: Page): Promise<number> =>
  page.locator('html').evaluate((html) => Number.parseFloat(html.style.getPropertyValue('--fs-scale') || '1'));

test('opens from the gear and from the shortcut, and closes by Escape, the close button and the backdrop', async ({ page }) => {
  await openApp(page);
  const dialog = settingsDialog(page);
  const gear = page.getByRole('button', { name: 'Settings (⌘,)' });

  await gear.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Agent control');
  await expect(dialog.getByRole('tab', { name: 'Agent control' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(gear).toBeFocused();

  await page.getByPlaceholder(/Message the agent/).click();
  await page.keyboard.type('half a thought');
  await page.keyboard.press('Control+,');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await expect(dialog).toBeHidden();

  await page.keyboard.press('Control+,');
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  await page.mouse.click(Math.max(2, box.x / 2), Math.max(2, box.y / 2));
  await expect(dialog).toBeHidden();
});

test('the category rail follows the arrow keys and the last category survives reopening and a reload', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  const tabs = dialog.getByRole('tablist').getByRole('tab');
  await expect(tabs).toHaveText([/Agent control/, /MCP servers/, /Paths/, /Accounts/, /Appearance/]);

  await dialog.getByRole('tab', { name: 'Agent control' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('tab', { name: 'MCP servers' })).toBeFocused();
  await expect(dialog.getByRole('tab', { name: 'MCP servers' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('MCP servers');
  await page.keyboard.press('End');
  await expect(dialog.getByRole('tab', { name: 'Appearance' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Appearance');
  await page.keyboard.press('ArrowUp');
  await expect(dialog.getByRole('tab', { name: 'Accounts' })).toBeFocused();
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Accounts');
  await page.keyboard.press('Home');
  await expect(dialog.getByRole('tab', { name: 'Agent control' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('tab', { name: 'Accounts' })).toHaveAttribute('aria-selected', 'false');

  await showCategory(dialog, 'Paths');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await openSettings(page);
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Paths');

  await page.reload();
  await expect(page.getByText('core connected')).toBeVisible();
  await openSettings(page);
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Paths');
  await expect(dialog.getByRole('tab', { name: 'Paths' })).toHaveAttribute('aria-selected', 'true');
});

test('search finds settings across categories, counts them per category and clears before closing', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  const search = dialog.getByRole('textbox', { name: 'Search settings' });

  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await page.keyboard.type('gitignore');
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Search');
  await expect(dialog.getByText('2 settings match “gitignore”.')).toBeVisible();
  await expect(setting(dialog, 'Guarded paths')).toBeVisible();
  await expect(setting(dialog, 'Harness paths')).toBeVisible();
  await expect(setting(dialog, 'Allowed outside the project')).toHaveCount(0);
  await expect(modeSetting(dialog)).toHaveCount(0);
  await expect(dialog.getByRole('tab', { name: 'Paths' })).toContainText('2');
  await expect(dialog.getByRole('tab', { name: 'Paths' })).not.toHaveClass(/\bdim\b/);
  for (const name of ['Agent control', 'MCP servers', 'Accounts', 'Appearance']) await expect(dialog.getByRole('tab', { name })).toHaveClass(/\bdim\b/);

  await search.fill('mode');
  await expect(dialog.getByText('1 setting matches “mode”.')).toBeVisible();
  await expect(modeSetting(dialog)).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Agent control' })).not.toHaveClass(/\bdim\b/);
  await expect(dialog.getByRole('tab', { name: 'Paths' })).toHaveClass(/\bdim\b/);

  await search.fill('zebra');
  await expect(dialog.getByText('Nothing matches “zebra”')).toBeVisible();
  await dialog.getByRole('button', { name: 'clear the search' }).click();
  await expect(search).toHaveValue('');
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Agent control');

  await search.fill('gitignore');
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Agent control');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('Escape on the search clear button only clears the query, and the next Escape closes', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  const search = dialog.getByRole('textbox', { name: 'Search settings' });
  await search.fill('gitignore');
  await dialog.getByRole('button', { name: 'Clear search' }).focus();
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Agent control');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('Escape on "clear the search" in the no-match state only clears the query, and the next Escape closes', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  const search = dialog.getByRole('textbox', { name: 'Search settings' });
  await search.fill('zebra');
  await dialog.getByRole('button', { name: 'clear the search' }).focus();
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(dialog.getByText('Nothing matches “zebra”')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('a control mode edit is listed, saved, read back after a reload and can be reset to inherited', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  await expect(scope(dialog, 'This project')).toHaveAttribute('aria-checked', 'true');
  await expect(mode(dialog, 'Ask me')).toHaveAttribute('aria-checked', 'true');
  await expect(modeSetting(dialog).getByText('Inherited from all projects')).toBeVisible();
  await expect(saveBar(page)).toBeHidden();

  await mode(dialog, 'Block').click();
  await expect(mode(dialog, 'Block')).toHaveAttribute('aria-checked', 'true');
  await expect(mode(dialog, 'Ask me')).toHaveAttribute('aria-checked', 'false');
  await expect(modeSetting(dialog).getByText('Set for this project')).toBeVisible();
  await expect(modeSetting(dialog).getByRole('button', { name: 'Reset to inherited' })).toBeVisible();
  const count = saveBar(page).getByRole('button', { name: /unsaved change/ });
  await expect(count).toHaveText(/\b1 unsaved change\b(?!s)/);
  await count.click();
  await expect(saveBar(page).getByRole('listitem')).toHaveCount(1);
  await expect(saveBar(page).getByRole('listitem')).toContainText(/This project\s*Control mode: Block\b/);

  await saveWithButton(page);
  await expect(toast(page, 'Settings saved')).toBeHidden({ timeout: 15_000 });

  await page.reload();
  await expect(page.getByText('core connected')).toBeVisible();
  await openSettings(page);
  await expect(mode(dialog, 'Block')).toHaveAttribute('aria-checked', 'true');
  await expect(modeSetting(dialog).getByText('Set for this project')).toBeVisible();

  await mode(dialog, 'Allow and flag').click();
  await saveBar(page).getByRole('button', { name: /unsaved change/ }).click();
  await expect(saveBar(page).getByText('Control mode: Block → Allow and flag')).toBeVisible();
  await modeSetting(dialog).getByRole('button', { name: 'Reset to inherited' }).click();
  await expect(mode(dialog, 'Ask me')).toHaveAttribute('aria-checked', 'true');
  await expect(modeSetting(dialog).getByText('Inherited from all projects')).toBeVisible();
  await expect(modeSetting(dialog).getByRole('button', { name: 'Reset to inherited' })).toHaveCount(0);
  await expect(saveBar(page).getByRole('listitem')).toContainText(/Control mode: follows all projects/);
  await saveWithButton(page);

  await page.reload();
  await expect(page.getByText('core connected')).toBeVisible();
  await openSettings(page);
  await expect(mode(dialog, 'Ask me')).toHaveAttribute('aria-checked', 'true');
  await expect(modeSetting(dialog).getByText('Inherited from all projects')).toBeVisible();
});

test('the mode cards work from the keyboard and Ctrl+S saves the choice', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  await mode(dialog, 'Ask me').focus();
  await page.keyboard.press('ArrowRight');
  await expect(mode(dialog, 'Allow and flag')).toHaveAttribute('aria-checked', 'true');
  await expect(mode(dialog, 'Allow and flag')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(mode(dialog, 'Block')).toHaveAttribute('aria-checked', 'true');
  await expect(saveBar(page).getByRole('button', { name: /unsaved change/ })).toHaveText(/\b1 unsaved change\b(?!s)/);

  await page.keyboard.press('Control+s');
  await expect(toast(page, 'Settings saved')).toBeVisible();
  await expect(saveBar(page)).toBeHidden();
  await page.reload();
  await expect(page.getByText('core connected')).toBeVisible();
  await openSettings(page);
  await expect(mode(dialog, 'Block')).toHaveAttribute('aria-checked', 'true');
});

test('the all-projects scope points at a project override, Show returns to it, and project settings inherit the rest', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  await mode(dialog, 'Allow and flag').click();
  await saveWithButton(page);

  await scope(dialog, 'All projects').click();
  await expect(scope(dialog, 'All projects')).toHaveAttribute('aria-checked', 'true');
  await expect(modeSetting(dialog).getByText('This project uses its own value')).toBeVisible();
  await expect(mode(dialog, 'Ask me')).toHaveAttribute('aria-checked', 'true');
  const autoApprove = setting(dialog, 'Approve small plans automatically');
  await expect(autoApprove.getByText('Applies to every project')).toBeVisible();

  await autoApprove.getByRole('button', { name: 'More files' }).click();
  await autoApprove.getByRole('button', { name: 'More files' }).click();
  await expect(autoApprove.getByRole('textbox', { name: 'Number of files' })).toHaveValue('5');
  await saveWithButton(page);

  await page.reload();
  await expect(page.getByText('core connected')).toBeVisible();
  await openSettings(page);
  await expect(scope(dialog, 'All projects')).toHaveAttribute('aria-checked', 'true');
  await expect(setting(dialog, 'Approve small plans automatically').getByRole('textbox', { name: 'Number of files' })).toHaveValue('5');

  await modeSetting(dialog).getByRole('button', { name: 'Show' }).click();
  await expect(scope(dialog, 'This project')).toHaveAttribute('aria-checked', 'true');
  await expect(mode(dialog, 'Allow and flag')).toHaveAttribute('aria-checked', 'true');
  await expect(modeSetting(dialog).getByText('Set for this project')).toBeVisible();
  const inherited = setting(dialog, 'Approve small plans automatically');
  await expect(inherited.getByRole('textbox', { name: 'Number of files' })).toHaveValue('5');
  await expect(inherited.getByText('Inherited from all projects')).toBeVisible();
});

test('Discard restores the saved values and hides the bar', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  const autoApprove = setting(dialog, 'Approve small plans automatically');
  await mode(dialog, 'Block').click();
  await autoApprove.getByRole('button', { name: 'More files' }).click();
  await expect(saveBar(page).getByRole('button', { name: /unsaved change/ })).toHaveText(/\b2 unsaved changes\b/);

  await saveBar(page).getByRole('button', { name: 'Discard' }).click();
  await expect(saveBar(page)).toBeHidden();
  await expect(mode(dialog, 'Ask me')).toHaveAttribute('aria-checked', 'true');
  await expect(autoApprove.getByRole('textbox', { name: 'Number of files' })).toHaveValue('3');
  await expect(modeSetting(dialog).getByText('Inherited from all projects')).toBeVisible();
  await expect(autoApprove.getByText('Inherited from all projects')).toBeVisible();
});

test('closing with unsaved changes asks first, keeps editing on request and discards when confirmed', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  await mode(dialog, 'Block').click();
  const confirm = saveBar(page).getByText('Close and lose this change?');
  const keepEditing = saveBar(page).getByRole('button', { name: 'Keep editing' });

  await page.keyboard.press('Escape');
  await expect(confirm).toBeVisible();
  await expect(dialog).toBeVisible();
  await keepEditing.click();
  await expect(confirm).toBeHidden();
  await expect(mode(dialog, 'Block')).toHaveAttribute('aria-checked', 'true');
  await expect(saveBar(page).getByRole('button', { name: 'Save changes' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await expect(confirm).toBeVisible();
  await keepEditing.click();
  const box = (await dialog.boundingBox())!;
  await page.mouse.click(Math.max(2, box.x / 2), Math.max(2, box.y / 2));
  await expect(confirm).toBeVisible();
  await expect(dialog).toBeVisible();

  await saveBar(page).getByRole('button', { name: 'Discard and close' }).click();
  await expect(dialog).toBeHidden();
  await openSettings(page);
  await expect(mode(dialog, 'Ask me')).toHaveAttribute('aria-checked', 'true');
  await expect(saveBar(page)).toBeHidden();
});

test('the auto-approve switch and stepper keep the number of files in range', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  const autoApprove = setting(dialog, 'Approve small plans automatically');
  const toggle = autoApprove.getByRole('switch', { name: 'Approve small plans automatically' });
  const files = autoApprove.getByRole('textbox', { name: 'Number of files' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(files).toHaveValue('3');

  await autoApprove.getByRole('button', { name: 'More files' }).click();
  await expect(files).toHaveValue('4');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(saveBar(page).getByRole('button', { name: /unsaved change/ })).toHaveText(/\b1 unsaved change\b(?!s)/);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(files).toHaveValue('4');
  await autoApprove.getByRole('button', { name: 'Fewer files' }).click();
  await expect(files).toHaveValue('3');
  await expect(autoApprove.getByText('Set for this project')).toBeVisible();

  for (const bad of ['51', '-1', '2.5', 'many']) {
    await files.fill(bad);
    await expect(autoApprove.getByRole('alert')).toHaveText('Use a whole number from 0 to 50.');
  }
  await files.fill('50');
  await expect(autoApprove.getByRole('alert')).toHaveCount(0);
  await expect(saveBar(page).getByRole('button', { name: /unsaved change/ })).toHaveText(/\b1 unsaved change\b(?!s)/);
  await saveWithButton(page);
  await page.reload();
  await expect(page.getByText('core connected')).toBeVisible();
  await openSettings(page);
  await expect(setting(dialog, 'Approve small plans automatically').getByRole('textbox', { name: 'Number of files' })).toHaveValue('50');

  await setting(dialog, 'Approve small plans automatically').getByRole('switch', { name: 'Approve small plans automatically' }).click();
  await saveWithButton(page);
  await page.reload();
  await expect(page.getByText('core connected')).toBeVisible();
  await openSettings(page);
  await expect(setting(dialog, 'Approve small plans automatically').getByRole('switch', { name: 'Approve small plans automatically' })).toHaveAttribute('aria-checked', 'false');
});

test('guarded paths accept valid patterns, refuse invalid and duplicate ones, and edit or remove chips', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  await showCategory(dialog, 'Paths');
  const guarded = setting(dialog, 'Guarded paths');
  await expect(guarded.getByRole('button', { name: 'Remove .env*' })).toBeVisible();
  const defaults = await chips(guarded).count();
  for (const pattern of ['.env*', '.git/hooks/', '.claude/']) await expect(guarded.getByRole('button', { name: `Remove ${pattern}` })).toBeVisible();
  await expect(setting(dialog, 'Harness paths').getByRole('button', { name: 'Remove .omc/' })).toBeVisible();
  await expect(guarded.getByText('Inherited from all projects')).toBeVisible();

  await guarded.getByText('.env*', { exact: true }).click();
  await expect(guarded.getByRole('textbox', { name: 'Edit .env*' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(guarded.getByRole('textbox', { name: 'Edit .env*' })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(saveBar(page)).toBeHidden();

  for (const bad of ['#secrets', './secrets', '~/secrets', 'a/../b', 'a/***', 'file[ab']) {
    await addPattern(guarded, bad);
    await expect(guarded.getByRole('alert')).toBeVisible();
    await expect(chips(guarded)).toHaveCount(defaults);
  }
  await addPattern(guarded, '.env*');
  await expect(guarded.getByRole('alert')).toHaveText('This pattern is already in the list.');
  await expect(chips(guarded)).toHaveCount(defaults);
  await expect(saveBar(page)).toBeHidden();
  await expect(guarded.getByText('Inherited from all projects')).toBeVisible();

  // Typed key by key: "/" inside a field must stay a character, not jump to the search box.
  await guarded.getByRole('textbox', { name: 'Add a pattern' }).fill('');
  await guarded.getByRole('textbox', { name: 'Add a pattern' }).pressSequentially('secrets/');
  await expect(guarded.getByRole('textbox', { name: 'Add a pattern' })).toHaveValue('secrets/');
  await guarded.getByRole('textbox', { name: 'Add a pattern' }).press('Enter');
  await expect(guarded.getByRole('alert')).toHaveCount(0);
  await expect(guarded.getByRole('button', { name: 'Remove secrets/' })).toBeVisible();
  await expect(guarded.getByRole('textbox', { name: 'Add a pattern' })).toHaveValue('');
  await expect(guarded.getByText('Set for this project')).toBeVisible();
  await expect(saveBar(page)).toBeVisible();

  await guarded.getByRole('button', { name: 'Remove .git/hooks/' }).click();
  await expect(guarded.getByRole('button', { name: 'Remove .git/hooks/' })).toHaveCount(0);

  await guarded.getByText('secrets/', { exact: true }).click();
  const editor = guarded.getByRole('textbox', { name: 'Edit secrets/' });
  await expect(editor).toBeFocused();
  await editor.fill('vault/');
  await editor.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(saveBar(page).getByRole('button', { name: 'Save changes' })).toBeVisible();
  await expect(guarded.getByRole('button', { name: 'Remove secrets/' })).toBeVisible();
  await expect(guarded.getByRole('button', { name: 'Remove vault/' })).toHaveCount(0);

  await guarded.getByText('secrets/', { exact: true }).click();
  await guarded.getByRole('textbox', { name: 'Edit secrets/' }).fill('vault/');
  await guarded.getByRole('textbox', { name: 'Edit secrets/' }).press('Enter');
  await expect(guarded.getByRole('button', { name: 'Remove vault/' })).toBeVisible();
  await expect(guarded.getByRole('button', { name: 'Remove secrets/' })).toHaveCount(0);

  await saveWithButton(page);
  await page.reload();
  await expect(page.getByText('core connected')).toBeVisible();
  const reopened = await openSettings(page);
  const saved = setting(reopened, 'Guarded paths');
  await expect(chips(saved)).toHaveCount(defaults);
  for (const pattern of ['.env*', '.claude/', 'vault/']) await expect(saved.getByRole('button', { name: `Remove ${pattern}` })).toBeVisible();
  await expect(saved.getByText('Set for this project')).toBeVisible();

  await saved.getByRole('button', { name: 'Remove vault/' }).click();
  await saveBar(page).getByRole('button', { name: /unsaved change/ }).click();
  await expect(saveBar(page).getByRole('listitem')).toHaveText([/Guarded paths: − vault\//]);
});

test('a pasted list adds every valid line around an invalid one and keeps the first invalid line in the input', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  await showCategory(dialog, 'Paths');
  const guarded = setting(dialog, 'Guarded paths');
  await expect(guarded.getByRole('button', { name: 'Remove .env*' })).toBeVisible();
  const defaults = await chips(guarded).count();
  const input = guarded.getByRole('textbox', { name: 'Add a pattern' });

  await paste(input, 'secrets/\n#notes\nvault/');
  await expect(guarded.getByRole('button', { name: 'Remove secrets/' })).toBeVisible();
  await expect(guarded.getByRole('button', { name: 'Remove vault/' })).toBeVisible();
  await expect(chips(guarded)).toHaveCount(defaults + 2);
  await expect(guarded.getByRole('alert')).toHaveCount(1);
  await expect(input).toHaveValue('#notes');
  await expect(guarded.getByRole('button', { name: /^Remove #/ })).toHaveCount(0);
  const count = saveBar(page).getByRole('button', { name: /unsaved change/ });
  await expect(count).toHaveText(/\b1 unsaved change\b(?!s)/);
  await count.click();
  await expect(saveBar(page).getByRole('listitem')).toHaveCount(1);
  await expect(saveBar(page).getByRole('listitem')).toContainText(/Guarded paths: \+ secrets\/, \+ vault\//);
});

test('a pasted line that duplicates a chip is refused while the other lines are added', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  await showCategory(dialog, 'Paths');
  const guarded = setting(dialog, 'Guarded paths');
  await expect(guarded.getByRole('button', { name: 'Remove .env*' })).toBeVisible();
  const defaults = await chips(guarded).count();
  const input = guarded.getByRole('textbox', { name: 'Add a pattern' });

  await paste(input, '.env*\nlogs/');
  await expect(guarded.getByRole('button', { name: 'Remove logs/' })).toBeVisible();
  await expect(guarded.getByRole('button', { name: 'Remove .env*' })).toHaveCount(1);
  await expect(chips(guarded)).toHaveCount(defaults + 1);
  await expect(guarded.getByRole('alert')).toHaveText('This pattern is already in the list.');
  await expect(input).toHaveValue('.env*');
  await expect(saveBar(page).getByRole('button', { name: /unsaved change/ })).toHaveText(/\b1 unsaved change\b(?!s)/);
});

test('a pasted list adds each valid line, and outside paths must be absolute or under the home folder', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  await showCategory(dialog, 'Paths');
  const harness = setting(dialog, 'Harness paths');
  await expect(harness.getByRole('button', { name: 'Remove .omc/' })).toBeVisible();
  const defaults = await chips(harness).count();
  await paste(harness.getByRole('textbox', { name: 'Add a pattern' }), 'build/cache/\n.cursor/\n');
  await expect(harness.getByRole('button', { name: 'Remove build/cache/' })).toBeVisible();
  await expect(harness.getByRole('button', { name: 'Remove .cursor/' })).toBeVisible();
  await expect(chips(harness)).toHaveCount(defaults + 2);
  await paste(harness.getByRole('textbox', { name: 'Add a pattern' }), 'logs/\n#comment');
  await expect(harness.getByRole('button', { name: 'Remove logs/' })).toBeVisible();
  await expect(harness.getByRole('alert')).toBeVisible();
  await expect(harness.getByRole('button', { name: /^Remove #/ })).toHaveCount(0);
  await expect(chips(harness)).toHaveCount(defaults + 3);

  const outside = setting(dialog, 'Allowed outside the project');
  await expect(outside.getByRole('button', { name: 'Remove ~/.claude/plans/' })).toBeVisible();
  const outsideDefaults = await chips(outside).count();
  for (const bad of ['relative/path', '/', '~/']) {
    await addPattern(outside, bad);
    await expect(outside.getByRole('alert')).toBeVisible();
    await expect(chips(outside)).toHaveCount(outsideDefaults);
  }
  await expect(outside.getByText('Inherited from all projects')).toBeVisible();
  await addPattern(outside, '/opt/shared/');
  await expect(outside.getByRole('button', { name: 'Remove /opt/shared/' })).toBeVisible();
  await outside.getByRole('textbox', { name: 'Add a pattern' }).fill('~/notes/');
  await outside.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(outside.getByRole('button', { name: 'Remove ~/notes/' })).toBeVisible();
  await expect(outside.getByText('Set for this project')).toBeVisible();
  await expect(saveBar(page).getByRole('button', { name: /unsaved change/ })).toHaveText(/\b2 unsaved changes\b/);
});

test('an MCP server is validated, added, shown with masked secrets, edited in place and removed after confirming', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  await showCategory(dialog, 'MCP servers');
  const project = dialog.getByRole('region', { name: 'This project servers' });
  await project.getByRole('button', { name: 'Add server' }).click();
  const form = project.locator('form');
  const name = field(form, 'Name');

  await form.getByRole('button', { name: 'Add server' }).click();
  await expect(fieldError(form, 'Name')).toHaveText('Give the server a name.');
  await expect(fieldError(form, 'Command')).toHaveText('Enter the command that starts the server.');
  for (const refused of ['ide', 'idecore', 'docs server!', 'docs.search']) {
    await name.fill(refused);
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(fieldError(form, 'Name')).toBeVisible();
    await expect(fieldError(form, 'Name')).not.toHaveText('Give the server a name.');
  }

  await name.fill('docs-search');
  await expect(name).toHaveAttribute('aria-invalid', 'false');
  await field(form, 'Command').fill('node');
  await field(form, 'Arguments').fill('server.js\n--verbose');
  await field(form, 'Environment').fill('API_TOKEN=abc123secret\nMODE=fast');
  await field(form, 'Timeout').fill('30000');
  await expect(form.getByRole('alert')).toHaveCount(0);
  await form.getByRole('button', { name: 'Add server' }).click();

  await expect(toast(page, 'Server added')).toBeVisible();
  await expect(form).toHaveCount(0);
  await expect(dialog.getByText('Changes apply when the session restarts', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Restart session' })).toBeVisible();
  const row = project.getByRole('listitem').filter({ hasText: 'docs-search' });
  const toggle = row.getByRole('button', { name: /docs-search/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toContainText('node');
  await expect(toggle).toContainText('Ready');
  await expect(row.getByText('abc123secret')).toHaveCount(0);
  await expect(dialog.getByText('Not approved on this machine')).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(row.getByText('server.js', { exact: true })).toBeVisible();
  await expect(row.getByText('--verbose', { exact: true })).toBeVisible();
  await expect(row.getByText('fast', { exact: true })).toBeVisible();
  await expect(row.getByText('30000 ms')).toBeVisible();
  await expect(row.getByText('In this session')).toBeVisible();
  await expect(row.getByText('••••••••')).toHaveCount(1);
  await expect(row.getByText('abc123secret')).toHaveCount(0);
  await row.getByRole('button', { name: 'Show value' }).click();
  await expect(row.getByText('abc123secret')).toBeVisible();
  await row.getByRole('button', { name: 'Hide value' }).click();
  await expect(row.getByText('abc123secret')).toHaveCount(0);
  await expect(row.getByText('••••••••')).toHaveCount(1);

  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(field(form, 'Name')).toHaveValue('docs-search');
  await expect(field(form, 'Command')).toHaveValue('node');
  await field(form, 'Command').press('Escape');
  await expect(form).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(row.getByRole('button', { name: /docs-search/ })).toContainText('node');

  await row.getByRole('button', { name: 'Edit' }).click();
  await field(form, 'Command').fill('deno');
  await form.getByRole('button', { name: 'Save server' }).click();
  await expect(form).toHaveCount(0);
  await expect(row.getByRole('button', { name: /docs-search/ })).toContainText('deno');

  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Remove?' })).toBeVisible();
  await expect(project.getByRole('listitem').filter({ hasText: 'docs-search' })).toHaveCount(1);
  await row.getByRole('button', { name: 'Remove?' }).click();
  await expect(toast(page, 'docs-search removed')).toBeVisible();
  await expect(project.getByRole('listitem').filter({ hasText: 'docs-search' })).toHaveCount(0);
});

test('an http MCP server needs an http URL, masks secret headers and can be saved for all projects', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  await showCategory(dialog, 'MCP servers');
  const project = dialog.getByRole('region', { name: 'This project servers' });
  const everywhere = dialog.getByRole('region', { name: 'All projects servers' });
  await project.getByRole('button', { name: 'Add server' }).click();
  const form = dialog.locator('form');
  await field(form, 'Name').fill('remote-docs');
  await form.getByRole('radio', { name: 'URL (http)' }).click();
  await form.getByRole('radiogroup', { name: 'Where to save the server' }).getByRole('radio', { name: 'All projects' }).click();
  await expect(everywhere.locator('form')).toHaveCount(1);
  await expect(field(form, 'Command')).toHaveCount(0);

  for (const refused of ['ftp://example.com/mcp', 'example.com/mcp']) {
    await field(form, 'URL').fill(refused);
    await field(form, 'URL').blur();
    await expect(fieldError(form, 'URL')).toBeVisible();
  }
  await field(form, 'URL').fill('https://example.com/mcp');
  await expect(fieldError(form, 'URL')).toHaveCount(0);
  await field(form, 'Headers').fill('Authorization: Bearer topsecret\nX-Team: core');
  await form.getByRole('button', { name: 'Add server' }).click();

  await expect(toast(page, 'Server added')).toBeVisible();
  const row = everywhere.getByRole('listitem').filter({ hasText: 'remote-docs' });
  await expect(row.getByRole('button', { name: /remote-docs/ })).toContainText('https://example.com/mcp');
  await expect(project.getByRole('listitem').filter({ hasText: 'remote-docs' })).toHaveCount(0);
  await row.getByRole('button', { name: /remote-docs/ }).click();
  await expect(row.getByText('core', { exact: true })).toBeVisible();
  await expect(row.getByText('Bearer topsecret')).toHaveCount(0);
  await row.getByRole('button', { name: 'Show value' }).click();
  await expect(row.getByText('Bearer topsecret')).toBeVisible();
});

test('appearance changes apply to the whole app at once and are restored after a reload', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.tree-row').first()).toBeVisible();
  await expect(page.locator('.react-flow__background')).toBeVisible();
  expect(await htmlAttribute(page, 'data-density')).toBe('comfortable');
  expect(await htmlAttribute(page, 'data-motion')).toBe('full');
  expect(await htmlAttribute(page, 'data-canvas-dots')).toBe('on');
  expect(await fontScale(page)).toBe(1);
  await expect(page.locator('.tree-row').first()).toHaveCSS('min-height', '24px');

  const dialog = await openSettings(page);
  await showCategory(dialog, 'Appearance');
  await setting(dialog, 'Density').getByRole('radio', { name: 'Compact' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await expect(page.locator('.tree-row').first()).toHaveCSS('min-height', '21px');
  await setting(dialog, 'Text size').getByRole('radio', { name: 'Large', exact: true }).click();
  await expect.poll(() => fontScale(page)).toBeCloseTo(14 / 13, 4);
  await setting(dialog, 'Reduce motion').getByRole('switch', { name: 'Reduce motion' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await setting(dialog, 'Dots on the map').getByRole('switch', { name: 'Dots on the map' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-canvas-dots', 'off');
  await expect(page.locator('.react-flow__background')).toBeHidden();
  await expect(saveBar(page)).toBeHidden();

  const stored = await page.locator('html').evaluate((html) => JSON.parse(html.ownerDocument.defaultView!.localStorage.getItem('ide.appearance') ?? 'null'));
  expect(stored).toEqual({ density: 'compact', fontSize: 14, reducedMotion: true, canvasDots: false });

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await expect(page.locator('html')).toHaveAttribute('data-canvas-dots', 'off');
  expect(await fontScale(page)).toBeCloseTo(14 / 13, 4);
  await expect(page.getByText('core connected')).toBeVisible();
  await expect(page.locator('.tree-row').first()).toHaveCSS('min-height', '21px');
  await expect(page.locator('.react-flow__background')).toBeHidden();

  const reopened = await openSettings(page);
  await expect(setting(reopened, 'Density').getByRole('radio', { name: 'Compact' })).toHaveAttribute('aria-checked', 'true');
  await setting(reopened, 'Density').getByRole('radio', { name: 'Comfortable' }).click();
  await setting(reopened, 'Text size').getByRole('radio', { name: 'Default' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
  await expect(page.locator('.tree-row').first()).toHaveCSS('min-height', '24px');
  await expect.poll(() => fontScale(page)).toBe(1);
});

test('a narrow window shows the rail as icons and puts the search under the title', async ({ page }) => {
  await openApp(page, 1400);
  let dialog = await openSettings(page);
  const title = dialog.getByRole('heading', { level: 2 });
  const search = dialog.getByRole('textbox', { name: 'Search settings' });
  await expect(dialog.getByRole('tab', { name: 'Paths' }).getByText('Paths')).toBeVisible();
  expect((await search.boundingBox())!.y).toBeLessThan((await title.boundingBox())!.y + (await title.boundingBox())!.height);
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 820, height: 900 });
  dialog = await openSettings(page);
  const paths = dialog.getByRole('tab', { name: 'Paths' });
  await expect(paths).toBeVisible();
  await expect(paths.getByText('Paths')).toBeHidden();
  const narrowTitle = (await title.boundingBox())!;
  expect((await search.boundingBox())!.y).toBeGreaterThanOrEqual(narrowTitle.y + narrowTitle.height);
  await paths.click();
  await expect(title).toHaveText('Paths');
});

test('the accounts page shows the system account as the active one', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  await showCategory(dialog, 'Accounts');
  const accounts = setting(dialog, 'Claude accounts');
  const choices = accounts.getByRole('radiogroup', { name: 'Claude account' });
  await expect(choices.getByRole('radio')).toHaveCount(1);
  await expect(choices.getByRole('radio', { name: 'System' })).toBeChecked();
  await expect(choices.getByText('active', { exact: true })).toBeVisible();
  await expect(accounts.getByRole('button', { name: /Add account/ })).toBeVisible();
});

const IDLE_LOGIN = { state: 'idle', engine: null, method: null, url: null, userCode: null, error: null };

interface AccountRequest { type: string; requestId: string; engine?: string; method?: string; apiKey?: string }

// The page talks to a stand-in for the core's accounts of Claude and Codex: each request is answered the way the core answers it, state first.
async function standInAccounts(page: Page, lists: { claude: object[]; codex: object[] }): Promise<{ login: (state: object) => void; sent: Omit<AccountRequest, 'requestId'>[] }> {
  let login: object = IDLE_LOGIN;
  const sent: Omit<AccountRequest, 'requestId'>[] = [];
  let push = (): void => undefined;
  await page.routeWebSocket(/\/ws\?/, (ws) => {
    const server = ws.connectToServer();
    let settings: object = {};
    push = () => {
      const engines = [{ engine: 'claude', accounts: lists.claude, activeId: null }, { engine: 'codex', accounts: lists.codex, activeId: null }];
      ws.send(JSON.stringify({ type: 'settings.snapshot', settings: { ...settings, accounts: { engines, login } } }));
    };
    server.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { type: string; settings: object };
      if (message.type !== 'settings.snapshot') return ws.send(raw);
      settings = message.settings;
      push();
    });
    ws.onMessage((raw) => {
      const { requestId, ...message } = JSON.parse(String(raw)) as AccountRequest;
      if (!message.type.startsWith('account.')) return server.send(raw);
      sent.push(message);
      if (message.type === 'account.login.start') login = { ...IDLE_LOGIN, state: 'waiting', engine: message.engine, method: message.method };
      if (message.type === 'account.login.code') login = { ...IDLE_LOGIN, state: 'checking', engine: 'claude', method: 'browser' };
      if (message.type === 'account.login.cancel') login = IDLE_LOGIN;
      if (message.type === 'account.remove') lists.claude = [];
      push();
      ws.send(JSON.stringify({ type: 'settings.result', requestId, error: null }));
    });
  });
  return {
    login: (state) => {
      login = state;
      push();
    },
    sent,
  };
}

test("a Claude sign-in keeps the keyboard's focus on its current step and gives it back where it began, shows its code field again empty, keeps the code out of the page's markup, and search finds a Claude account", async ({ page }) => {
  const stand = await standInAccounts(page, { claude: [{ id: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff', email: 'a@example.com', createdAt: 1 }], codex: [] });
  await openApp(page);
  const dialog = await openSettings(page);
  await showCategory(dialog, 'Accounts');
  const accounts = setting(dialog, 'Claude accounts');
  const chatGpt = setting(dialog, 'Codex accounts').getByRole('button', { name: 'Sign in with ChatGPT' });
  const submit = accounts.getByRole('button', { name: 'Submit' });
  const waiting = { ...IDLE_LOGIN, state: 'waiting', engine: 'claude', method: 'browser', url: 'https://claude.com/oauth?state=s' };
  const failed = { ...IDLE_LOGIN, state: 'error', engine: 'claude', method: 'browser', error: 'The sign-in timed out after 10 minutes.' };
  const step = async (state: object, focused: Locator): Promise<void> => {
    stand.login(state);
    await expect(focused).toBeFocused();
  };

  await accounts.getByRole('button', { name: 'Add account' }).focus();
  await page.keyboard.press('Enter');
  await expect(accounts.getByRole('textbox', { name: 'Sign-in code' })).toBeFocused();
  await expect(chatGpt).toBeDisabled();
  await expect(setting(dialog, 'Codex accounts').getByText('Finish or cancel the Claude sign-in first.')).toBeVisible();
  await step(waiting, accounts.getByRole('button', { name: 'Open sign-in page' }));
  await page.keyboard.press('Tab');
  await page.keyboard.type('CODE-SECRET-7');
  // A controlled input would copy what is typed into the DOM's value attribute.
  expect((await dialog.evaluate((element) => element.outerHTML)).includes('CODE-SECRET-7')).toBe(false);
  await expect(submit).toBeEnabled();
  await step(failed, accounts.getByRole('button', { name: 'Retry' }));
  await expect(chatGpt).toBeEnabled();
  await page.keyboard.press('Enter');
  await step(waiting, accounts.getByRole('button', { name: 'Open sign-in page' }));
  await expect(submit).toBeDisabled();
  await page.keyboard.press('Tab');
  await page.keyboard.type('CODE-SECRET-8');
  await page.keyboard.press('Enter');
  await expect(accounts.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(accounts.getByRole('button', { name: 'Cancel' })).toHaveAccessibleDescription('Checking account…');
  await step(failed, accounts.getByRole('button', { name: 'Retry' }));
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(accounts.getByRole('button', { name: 'Add account' })).toBeFocused();

  const search = dialog.getByRole('textbox', { name: 'Search settings' });
  await search.fill('a@example.com');
  await expect(accounts).toBeVisible();
  await expect(setting(dialog, 'Codex accounts')).toHaveCount(0);
  await search.fill('');
  await accounts.getByRole('button', { name: 'Remove' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(accounts.getByRole('radio', { name: 'System' })).toBeFocused();
  expect(stand.sent.map(({ type, engine, method }) => [type, engine, method])).toEqual([
    ['account.login.start', 'claude', 'browser'], ['account.login.start', 'claude', 'browser'], ['account.login.code', undefined, undefined],
    ['account.login.cancel', undefined, undefined], ['account.remove', 'claude', undefined],
  ]);
});

test('Escape while a Claude sign-in checks its code cancels only the sign-in, and the next Escape closes Settings', async ({ page }) => {
  const stand = await standInAccounts(page, { claude: [], codex: [] });
  await openApp(page);
  const dialog = await openSettings(page);
  await showCategory(dialog, 'Accounts');
  const accounts = setting(dialog, 'Claude accounts');
  const add = accounts.getByRole('button', { name: 'Add account' });

  await add.focus();
  await page.keyboard.press('Enter');
  stand.login({ ...IDLE_LOGIN, state: 'waiting', engine: 'claude', method: 'browser', url: 'https://claude.com/oauth?state=s' });
  await expect(accounts.getByRole('button', { name: 'Open sign-in page' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.type('CODE-SECRET-9');
  await page.keyboard.press('Enter');
  await expect(accounts.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();
  await expect(dialog).toBeVisible();
  expect(stand.sent).toEqual([{ type: 'account.login.start', engine: 'claude', method: 'browser' }, { type: 'account.login.code', code: 'CODE-SECRET-9' }, { type: 'account.login.cancel' }]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test("a Codex sign-in keeps the keyboard's focus on its current step, Escape cancels only the device-code sign-in, sends a key once with its engine and way, shows the key form again empty, Escape closes only that form, and search finds a Codex account", async ({ page }) => {
  const stand = await standInAccounts(page, { claude: [], codex: [{ id: '3c1e8f5a-7d2b-4c6e-9a1f-2b3c4d5e6f70', email: 'work@example.com', plan: 'Plus', createdAt: 3 }] });
  await openApp(page);
  const dialog = await openSettings(page);
  await showCategory(dialog, 'Accounts');
  const codex = setting(dialog, 'Codex accounts');
  const device = codex.getByRole('button', { name: 'Use a device code' });
  const useKey = codex.getByRole('button', { name: 'Use an API key' });
  const addKey = codex.getByRole('button', { name: 'Add key' });
  const cancel = codex.getByRole('button', { name: 'Cancel' });
  const keyField = codex.getByLabel(/^Paste an OpenAI API key/);
  const notAKey = codex.getByText(/^That is not an API key/);
  const step = async (state: object, focused: Locator): Promise<void> => {
    stand.login(state);
    await expect(focused).toBeFocused();
  };

  await device.focus();
  await page.keyboard.press('Enter');
  await expect(cancel).toBeFocused();
  await step({ ...IDLE_LOGIN, state: 'waiting', engine: 'codex', method: 'device-code', url: 'https://auth.example.test/codex/device', userCode: 'ABCD-1234' }, codex.getByRole('button', { name: 'Open the device page' }));
  await page.keyboard.press('Escape');
  await expect(device).toBeFocused();
  await expect(dialog).toBeVisible();

  await useKey.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('sk-proj-SECRET42');
  expect([await keyField.getAttribute('value'), (await dialog.evaluate((element) => element.outerHTML)).includes('SECRET42')]).toEqual([null, false]);
  await expect(addKey).toBeEnabled();
  await step({ ...IDLE_LOGIN, state: 'waiting', engine: 'claude', method: 'browser' }, keyField);
  await expect(addKey).toBeDisabled();
  await expect(codex.getByText('Finish or cancel the Claude sign-in first.')).toBeVisible();
  await step(IDLE_LOGIN, keyField);
  await page.keyboard.type(' x');
  await expect(notAKey).toBeVisible();
  await expect(addKey).toBeDisabled();
  await step({ ...IDLE_LOGIN, state: 'waiting', engine: 'codex', method: 'browser' }, cancel);
  await step(IDLE_LOGIN, keyField);
  await expect(keyField).toHaveValue('');
  await expect(keyField).not.toHaveAttribute('aria-invalid', 'true');
  await expect(notAKey).toHaveCount(0);
  await page.keyboard.type('sk-proj-SECRET42');
  await page.keyboard.press('Enter');
  await step({ ...IDLE_LOGIN, state: 'error', engine: 'codex', method: 'api-key', error: 'OpenAI rejected the key.' }, codex.getByRole('button', { name: 'Retry' }));
  await page.keyboard.press('Enter');
  await expect(keyField).toBeFocused();
  await expect(keyField).toHaveValue('');
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(useKey).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(useKey).toBeFocused();
  expect(stand.sent).toEqual([
    { type: 'account.login.start', engine: 'codex', method: 'device-code' }, { type: 'account.login.cancel' },
    { type: 'account.login.start', engine: 'codex', method: 'api-key', apiKey: 'sk-proj-SECRET42' }, { type: 'account.login.cancel' },
  ]);

  await dialog.getByRole('textbox', { name: 'Search settings' }).fill('work@');
  await expect(codex).toBeVisible();
  await expect(setting(dialog, 'Claude accounts')).toHaveCount(0);
});

test('the scope choice is remembered after a reload', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  await scope(dialog, 'All projects').click();
  await expect(modeSetting(dialog).getByText('Applies to every project')).toBeVisible();
  await page.reload();
  await expect(page.getByText('core connected')).toBeVisible();
  await openSettings(page);
  await expect(scope(dialog, 'All projects')).toHaveAttribute('aria-checked', 'true');
  await expect(modeSetting(dialog).getByText('Applies to every project')).toBeVisible();
});
