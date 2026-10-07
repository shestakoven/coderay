import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { startCore, type Core } from './core';
import { chatConversation, flagOf, hookChecks, isAlive, sendMessage, terminalLaunches } from './helpers';

let core: Core | undefined;

test.afterEach(async () => {
  const launched = core ? terminalLaunches(core.record) : [];
  await core?.stop();
  core = undefined;
  for (const { pid } of launched) expect(isAlive(pid), `the agent terminal ${pid} outlived the core`).toBe(false);
});

const READ_TOOL = JSON.stringify({ name: 'Read', input: { file_path: 'README.md' } });
const SLOW_TURN = { FAKE_CLAUDE_TUI_SLOW_MS: '120000' };

const agentView = (page: Page, view: 'Chat' | 'Terminal'): Locator => page.getByRole('radiogroup', { name: 'Agent view' }).getByRole('radio', { name: view });
const agentScreen = (page: Page): Locator => page.locator('.agent-terminal .xterm-rows');
const composer = (page: Page): Locator => page.getByPlaceholder(/Message the agent/);

async function open(page: Page, scenario = 'multi-turn', env: Record<string, string> = {}): Promise<Core> {
  const started = await startCore(scenario, env);
  core = started;
  await page.goto(started.url);
  await expect(page.getByText('core connected')).toBeVisible();
  return started;
}

async function openTerminal(page: Page): Promise<void> {
  await agentView(page, 'Terminal').click();
  await expect(agentScreen(page)).toContainText('FAKE CLAUDE INTERACTIVE', { timeout: 30_000 });
}

async function typeInTerminal(page: Page, text: string): Promise<void> {
  await page.locator('.agent-terminal .xterm').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('Terminal runs claude in the agent panel in place of the composer, and Chat closes it', async ({ page }) => {
  const c = await open(page);
  await expect(agentView(page, 'Chat')).toBeChecked();
  await expect(composer(page)).toBeVisible();

  await openTerminal(page);
  await expect(agentView(page, 'Terminal')).toBeChecked();
  await expect(composer(page)).toHaveCount(0);

  await agentView(page, 'Chat').click();
  await expect(agentView(page, 'Chat')).toBeChecked();
  await expect(composer(page)).toBeVisible();
  await expect(page.locator('.agent-terminal')).toHaveCount(0);
  const [launched] = terminalLaunches(c.record);
  await expect.poll(() => isAlive(launched!.pid), { message: 'claude of the closed terminal still runs' }).toBe(false);
});

test('the Terminal button of the bottom panel counts shell terminals, not the agent terminal', async ({ page }) => {
  await open(page);
  await openTerminal(page);
  await expect(page.getByRole('button', { name: /^Terminal · / })).toHaveCount(0);

  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Terminal · 1', exact: true })).toBeVisible();
  await expect(page.locator('.terminal-host:visible .xterm-rows')).toContainText(/\S/, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Terminal · 1', exact: true })).toBeVisible();
  await expect(agentScreen(page)).toContainText('FAKE CLAUDE INTERACTIVE');
});

test('a prompt typed in the terminal shows in the chat with its tool and answer, and the turn is closed', async ({ page }) => {
  await open(page, 'multi-turn', { FAKE_CLAUDE_TUI_TOOL: READ_TOOL });
  await openTerminal(page);
  await typeInTerminal(page, 'hello from the terminal');
  await expect(agentScreen(page)).toContainText('fake answer to: hello from the terminal');
  // The turn must close while claude still runs: leaving the terminal ends an open turn too.
  await expect(page.locator('.chat-header')).not.toHaveClass(/working-on/);

  await agentView(page, 'Chat').click();
  await expect(page.locator('.msg.user')).toHaveText('hello from the terminal');
  await expect(page.locator('.msg.assistant')).toHaveText('fake answer to: hello from the terminal');
  const tool = page.locator('.tool.ok');
  await expect(tool).toHaveCount(1);
  await expect(tool.locator('.tool-status')).toHaveText('✓');
  await expect(tool).toContainText('Read');
  await expect(tool).toContainText('README.md');
  await expect(page.locator('.working')).toHaveCount(0);
  await expect(page.locator('.chat-header')).not.toHaveClass(/working-on/);
  await expect(page.locator('.turn-end')).toHaveCount(0);
});

test('a second prompt in the terminal opens a second turn', async ({ page }) => {
  await open(page);
  await openTerminal(page);
  await typeInTerminal(page, 'first question');
  await expect(agentScreen(page)).toContainText('fake answer to: first question');
  await expect(page.locator('.chat-header')).not.toHaveClass(/working-on/);
  await typeInTerminal(page, 'second question');
  await expect(agentScreen(page)).toContainText('fake answer to: second question');
  await expect(page.locator('.chat-header')).not.toHaveClass(/working-on/);

  await agentView(page, 'Chat').click();
  await expect(page.locator('.msg.user')).toHaveText(['first question', 'second question']);
  await expect(page.locator('.msg.assistant')).toHaveText(['fake answer to: first question', 'fake answer to: second question']);
  await expect(page.locator('.working')).toHaveCount(0);
  await expect(page.locator('.turn-end')).toHaveCount(0);
});

test('Esc during a slow turn shows the turn as stopped in the chat', async ({ page }) => {
  await open(page, 'multi-turn', SLOW_TURN);
  await openTerminal(page);
  await typeInTerminal(page, 'a slow question');
  await expect(agentScreen(page)).toContainText('thinking slowly');
  await expect(page.locator('.chat-header')).toHaveClass(/working-on/);
  await page.keyboard.press('Escape');
  await expect(agentScreen(page)).toContainText('Interrupted');
  await expect(page.locator('.chat-header')).not.toHaveClass(/working-on/);

  await agentView(page, 'Chat').click();
  await expect(page.locator('.msg.user')).toHaveText('a slow question');
  await expect(page.locator('.turn-end')).toHaveText('stopped');
  await expect(page.locator('.msg.assistant')).toHaveCount(0);
  await expect(page.locator('.working')).toHaveCount(0);
});

test('without CodeRay\'s hook the terminal does not open, and every new attempt checks again', async ({ page }) => {
  const c = await open(page, 'multi-turn', { FAKE_CLAUDE_HOOKS: 'off' });
  const notices = page.getByText(/hook did not start, so the agent was not started/);

  await agentView(page, 'Terminal').click();
  await expect(page.getByText('Starting claude')).toBeVisible();
  await expect(notices).toHaveCount(1, { timeout: 45_000 });
  await expect(agentView(page, 'Chat')).toBeChecked();
  await expect(composer(page)).toBeVisible();
  await expect(page.getByText('hook off')).toBeVisible();
  await expect(page.getByText('Starting claude')).toHaveCount(0);
  await expect(page.locator('.agent-terminal')).toHaveCount(0);
  await expect(page.locator('.chat-error')).toHaveCount(0);
  expect(hookChecks(c.record)).toBe(1);

  await agentView(page, 'Terminal').click();
  await expect(page.getByText('Starting claude')).toBeVisible();
  await expect(notices).toHaveCount(2, { timeout: 45_000 });
  await expect(agentView(page, 'Chat')).toBeChecked();
  await expect(page.getByText('Starting claude')).toHaveCount(0);
  await expect(page.locator('.agent-terminal')).toHaveCount(0);
  await expect(page.locator('.chat-error')).toHaveCount(0);
  expect(hookChecks(c.record)).toBe(2);
  expect(terminalLaunches(c.record)).toHaveLength(0);
});

test('when claude exits the panel offers Back to chat and Restart', async ({ page }) => {
  await open(page);
  await openTerminal(page);
  await typeInTerminal(page, '/exit');
  await expect(page.getByText('claude exited')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restart' })).toBeVisible();

  await page.getByRole('button', { name: 'Back to chat' }).click();
  await expect(agentView(page, 'Chat')).toBeChecked();
  await expect(composer(page)).toBeVisible();
  await expect(page.getByText('claude exited')).toHaveCount(0);
});

test('Restart opens a new terminal that resumes the conversation and is tracked too', async ({ page }) => {
  const c = await open(page);
  await openTerminal(page);
  await typeInTerminal(page, 'before the exit');
  await expect(agentScreen(page)).toContainText('fake answer to: before the exit');
  await typeInTerminal(page, '/exit');
  await expect(page.getByText('claude exited')).toBeVisible();

  await page.getByRole('button', { name: 'Restart' }).click();
  await expect(page.getByText('claude exited')).toHaveCount(0);
  await expect(agentScreen(page)).toContainText('resumed the conversation', { timeout: 30_000 });
  await expect.poll(() => terminalLaunches(c.record).length).toBe(2);
  const [first, second] = terminalLaunches(c.record);
  expect(flagOf(first!.argv, '--resume')).toBeUndefined();
  const conversation = flagOf(first!.argv, '--session-id');
  expect(conversation).toBeTruthy();
  expect(flagOf(second!.argv, '--resume')).toBe(conversation);
  expect(second!.argv).not.toContain('--session-id');

  await typeInTerminal(page, 'after the restart');
  await expect(agentScreen(page)).toContainText('fake answer to: after the restart');
  await agentView(page, 'Chat').click();
  await expect(page.locator('.msg.user')).toHaveText(['before the exit', 'after the restart']);
  await expect(page.locator('.msg.assistant')).toHaveText(['fake answer to: before the exit', 'fake answer to: after the restart']);
  await expect(page.locator('.turn-end')).toHaveCount(0);
});

test('reloading the page keeps the Terminal view, its scrollback and the running claude', async ({ page }) => {
  const c = await open(page);
  await openTerminal(page);
  await typeInTerminal(page, 'remember this');
  await expect(agentScreen(page)).toContainText('fake answer to: remember this');
  const [launched] = terminalLaunches(c.record);

  await page.reload();
  await expect(page.getByText('core connected')).toBeVisible();
  await expect(agentView(page, 'Terminal')).toBeChecked();
  await expect(agentScreen(page)).toContainText('fake answer to: remember this', { timeout: 30_000 });
  await expect(agentScreen(page)).toContainText('FAKE CLAUDE INTERACTIVE');
  await expect(composer(page)).toHaveCount(0);
  expect(isAlive(launched!.pid)).toBe(true);
  expect(terminalLaunches(c.record)).toHaveLength(1);

  await typeInTerminal(page, 'still alive');
  await expect(agentScreen(page)).toContainText('fake answer to: still alive');
});

test('Terminal resumes the conversation the chat has started', async ({ page }) => {
  const c = await open(page);
  await sendMessage(page, 'start in the chat');
  await expect(page.locator('.msg.assistant')).toHaveText('OK');
  await expect(page.locator('.working')).toHaveCount(0);
  const conversation = chatConversation(c.record);
  expect(conversation).toBeTruthy();
  // The real claude persists the chat's conversation; the fake does not, and the core resumes what has a transcript.
  mkdirSync(c.transcripts, { recursive: true });
  writeFileSync(join(c.transcripts, `${conversation}.jsonl`), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'start in the chat' } })}\n`);

  await openTerminal(page);
  const [launched] = terminalLaunches(c.record);
  expect(flagOf(launched!.argv, '--resume')).toBe(conversation);
  expect(launched!.argv).not.toContain('--session-id');
  await expect(agentScreen(page)).toContainText('resumed the conversation');
  await typeInTerminal(page, 'continue in the terminal');
  await expect(agentScreen(page)).toContainText('fake answer to: continue in the terminal');
  await agentView(page, 'Chat').click();
  await expect(page.locator('.msg.user')).toHaveText(['start in the chat', 'continue in the terminal']);
});

test('hook events of another conversation are not the chat\'s', async ({ page }) => {
  await open(page, 'multi-turn', { FAKE_CLAUDE_TUI_HOOK_SESSION: 'another-conversation' });
  await openTerminal(page);
  await typeInTerminal(page, 'not for the chat');
  await expect(agentScreen(page)).toContainText('fake answer to: not for the chat');

  await agentView(page, 'Chat').click();
  await expect(composer(page)).toBeVisible();
  await expect(page.locator('.msg')).toHaveCount(0);
  await expect(page.locator('.turn-end')).toHaveCount(0);
  await expect(page.locator('.working')).toHaveCount(0);
});

test('CodeRay gate guards the agent terminal: a write without an approved plan is blocked', async ({ page }) => {
  await open(page, 'multi-turn', { FAKE_CLAUDE_TUI_TOOL: JSON.stringify({ name: 'Write', input: { file_path: 'out.txt', content: 'x' } }) });
  await openTerminal(page);
  await typeInTerminal(page, 'write the file');
  await expect(agentScreen(page)).toContainText('fake answer to: write the file');
  await expect(agentScreen(page)).toContainText('Write denied');
  await expect(agentScreen(page)).not.toContainText('Write done');

  await agentView(page, 'Chat').click();
  const tool = page.locator('.tool');
  await expect(tool).toHaveCount(1);
  await expect(tool).toHaveClass(/rejected/);
  await expect(tool).toContainText('blocked');
  await expect(tool).toContainText('out.txt');
  await expect(page.locator('.tool.ok')).toHaveCount(0);
});
