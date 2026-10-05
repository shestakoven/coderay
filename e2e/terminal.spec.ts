import { expect, test, type Page } from '@playwright/test';
import { startCore, type Core } from './core';

let core: Core | undefined;

test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

test('the terminal runs commands in the project, survives a reload and closes', async ({ page }) => {
  core = await startCore('gate-big-plan');
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();

  await page.keyboard.press('Control+`');
  const screen = page.locator('.terminal-host:visible .xterm-rows');
  await expect(screen).toContainText(/\S/, { timeout: 15000 });
  await page.locator('.terminal-host:visible .xterm').click();
  await page.keyboard.type('echo hi-$((1+2)) && pwd');
  await page.keyboard.press('Enter');
  await expect(screen).toContainText('hi-3');

  await page.reload();
  await expect(page.getByText('core connected')).toBeVisible();
  await page.keyboard.press('Control+`');
  await expect(page.locator('.terminal-host:visible .xterm-rows')).toContainText('hi-3', { timeout: 15000 });
  await expect(page.getByRole('button', { name: /^Terminal · / })).toContainText('1');

  await page.getByRole('button', { name: /^Close / }).click();
  await expect(page.locator('.terminal-host:visible .xterm-rows')).not.toContainText('hi-3', { timeout: 15000 });
  await expect(page.locator('.terminal-tab')).toHaveCount(1);
});

const OPEN = 1;
interface BrowserSocket { readyState: number; close(): void }
interface TrackedPage {
  __sockets: BrowserSocket[];
  WebSocket: new (url: string | URL, protocols?: string | string[]) => BrowserSocket;
}

// Keeps every WebSocket the page opens, so that a test can cut the connection to the core and see the page reconnect.
async function trackSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const browser = globalThis as unknown as TrackedPage;
    const Native = browser.WebSocket;
    const sockets: BrowserSocket[] = [];
    browser.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
    browser.__sockets = sockets;
  });
}

async function reconnect(page: Page): Promise<void> {
  const before = await page.evaluate(() => (globalThis as unknown as TrackedPage).__sockets.length);
  await page.evaluate(() => (globalThis as unknown as TrackedPage).__sockets.at(-1)?.close());
  await page.waitForFunction(([count, open]) => {
    const sockets = (globalThis as unknown as TrackedPage).__sockets;
    return sockets.length > (count as number) && sockets.at(-1)?.readyState === open;
  }, [before, OPEN]);
  await expect(page.getByText('core connected')).toBeVisible();
}

test('after a reconnect a shell terminal shows what it held and takes input', async ({ page }) => {
  await trackSockets(page);
  core = await startCore('gate-big-plan');
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();

  await page.keyboard.press('Control+`');
  const screen = page.locator('.terminal-host:visible .xterm-rows');
  await expect(screen).toContainText(/\S/, { timeout: 15000 });
  await page.locator('.terminal-host:visible .xterm').click();
  await page.keyboard.type('echo hi-$((1+2))');
  await page.keyboard.press('Enter');
  await expect(screen).toContainText('hi-3');

  await reconnect(page);
  await expect(page.locator('.terminal-host:visible .xterm-rows')).toContainText('hi-3');
  await page.locator('.terminal-host:visible .xterm').click();
  await page.keyboard.type('echo again-$((2+3))');
  await page.keyboard.press('Enter');
  await expect(page.locator('.terminal-host:visible .xterm-rows')).toContainText('again-5');
  await expect(page.locator('.terminal-host .xterm')).toHaveCount(1);
});

test('after a reconnect the terminal view of the agent shows what it held and takes input', async ({ page }) => {
  await trackSockets(page);
  core = await startCore('text-then-wait');
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();

  await page.getByRole('radio', { name: 'Terminal' }).click();
  const host = page.locator('[data-testid="agent-terminal"] .agent-terminal-host');
  await expect(host.locator('.xterm')).toBeVisible({ timeout: 30000 });
  await host.locator('.xterm').click();
  await page.keyboard.type('before');
  await expect(host.locator('.xterm-rows')).toContainText('before');

  await reconnect(page);
  await expect(host.locator('.xterm-rows')).toContainText('before');
  await page.keyboard.type('after');
  await expect(host.locator('.xterm-rows')).toContainText('beforeafter');
  await expect(host.locator('.xterm')).toHaveCount(1);
});

test('Ctrl+` toggles the bottom panel and the Terminal tab reflects it', async ({ page }) => {
  core = await startCore('gate-big-plan');
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
  const button = page.getByRole('button', { name: /^Terminal/ });
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Control+`');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+`');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
});
