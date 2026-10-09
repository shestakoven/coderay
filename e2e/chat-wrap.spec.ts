import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { startCore, type Core } from './core';
import { sendMessage } from './helpers';

const UNBREAKABLE =
  "['Sources/Ask/AskModel.swift','Array(turns.suffix(Self.historyLimit))','Array(turns.prefix(Self.historyLimit))'),('Models/ReminderModels.swift','intent = (try? c.decode(Intent.self, forKey: .intent)) ?? .chat')";

let core: Core | undefined;
let scratch: string | undefined;

test.afterEach(async () => {
  await core?.stop();
  core = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

test('a long unbreakable string in a notice or an agent question wraps instead of scrolling the chat sideways', async ({ page }) => {
  scratch = mkdtempSync(join(tmpdir(), 'chat-wrap-'));
  const scenario = join(scratch, 'ask-long.jsonl');
  const original = readFileSync(resolve(import.meta.dirname, '../packages/core/test/fixtures/stream/ask-user-question.jsonl'), 'utf8');
  writeFileSync(scenario, original.replaceAll('"Red"', JSON.stringify(UNBREAKABLE)).replaceAll('Which color?', UNBREAKABLE));
  core = await startCore('ask-user-question', { FAKE_CLAUDE_SCENARIO: scenario });
  await page.goto(core.url);
  await sendMessage(page, 'ask me');
  await expect(page.locator('.chat-log .prompt .option', { hasText: 'Array(turns.suffix' })).toBeVisible();

  // No notice with free text can be raised from the outside, so the CSS is exercised on a node of the same shape.
  await page.evaluate((text) => {
    const notice = document.createElement('div');
    notice.className = 'notice';
    notice.textContent = text;
    document.querySelector('.chat-log')!.append(notice);
  }, UNBREAKABLE);

  // scrollWidth counts clipped overflow too, so this fails on a missing wrap even with overflow-x: hidden on the log.
  const excess = await page.locator('.chat-log').evaluate((log) => log.scrollWidth - log.clientWidth);
  expect(excess).toBeLessThanOrEqual(0);
});
