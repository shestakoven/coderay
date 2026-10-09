import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { startCore, type Core } from './core';
import { sendMessage } from './helpers';

const SHOT = resolve(import.meta.dirname, 'fixtures/tiny/docs/shot.png');
const READ_IMAGE = resolve(import.meta.dirname, '../packages/core/test/fixtures/stream/read-image.jsonl');

let core: Core | undefined;
let scratch: string | undefined;

test.afterEach(async () => {
  await core?.stop();
  core = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

// A grey png the browser can decode, of any size.
function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(width * 3 + 1, 0x80);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// The read-image scenario with its closing message replaced.
function closingWith(text: string): string {
  scratch = mkdtempSync(join(tmpdir(), 'chat-images-'));
  const file = join(scratch, 'read-image.jsonl');
  const lines = readFileSync(READ_IMAGE, 'utf8').split('\n').map((line) => {
    if (!line.includes('![Settings screenshot]')) return line;
    const event = JSON.parse(line);
    event.message.content[0].text = text;
    return JSON.stringify(event);
  });
  writeFileSync(file, lines.join('\n'));
  return file;
}

test('a tool image opens in the viewer, which walks every chat image with the arrow keys, zooms with Z and gives focus back on Esc', async ({ page }) => {
  core = await startCore('read-image');
  await page.goto(core.url);
  await sendMessage(page, 'compare the screenshots');
  const thumbs = page.locator('.chat-log [data-chat-image]');
  await expect(thumbs).toHaveCount(3);
  await expect(page.locator('.chat-log .ci-thumb.loaded')).toHaveCount(3);

  await thumbs.first().click();
  const viewer = page.getByRole('dialog', { name: /Image viewer/ });
  const count = viewer.locator('.iv-count');
  await expect(count).toHaveText('1 / 3');
  for (const [key, shown] of [['ArrowRight', '2 / 3'], ['ArrowRight', '3 / 3'], ['ArrowRight', '3 / 3'], ['ArrowLeft', '2 / 3']]) {
    await page.keyboard.press(key!);
    await expect(count).toHaveText(shown!);
  }

  await expect(viewer.locator('.iv-img.loaded')).toBeVisible();
  const zoom = viewer.locator('.iv-zoom');
  await expect(zoom).toHaveText('100%');
  await page.keyboard.press('z');
  await expect(zoom).toHaveText('200%');
  await page.keyboard.press('Z');
  await expect(zoom).toHaveText('100%');

  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(thumbs.nth(1)).toBeFocused();
});

test('an attached image shows as a thumbnail on the user message instead of the attachment count line', async ({ page }) => {
  core = await startCore('read-image');
  await page.goto(core.url);
  await expect(page.getByText('core connected')).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(SHOT);
  await expect(page.locator('.attachment')).toHaveCount(1);
  await sendMessage(page, 'what is on this');

  const message = page.locator('.msg.user');
  await expect(message.locator('.ci-thumb.loaded')).toHaveCount(1);
  await expect(message).toContainText('what is on this');
  await expect(message).not.toContainText('attached');
});

test('a reply shows its local images and the image files it names, never a missing one or a remote image, without scrolling sideways', async ({ page }) => {
  const scenario = closingWith('The page is in docs/shot.png and `docs/gone.png`.\n\n![Wide banner](docs/wide.png)\n\n![Remote chart](https://remote.invalid/chart.png)');
  core = await startCore('read-image', { FAKE_CLAUDE_SCENARIO: scenario });
  writeFileSync(join(core.root, 'docs/wide.png'), solidPng(4000, 24));
  const requested: string[] = [];
  const frames: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  page.on('websocket', (socket) => socket.on('framesent', (frame) => frames.push(String(frame.payload))));
  await page.goto(core.url);
  await sendMessage(page, 'show me');

  const reply = page.locator('.msg.assistant', { hasText: 'The page is in' });
  await expect(reply.locator('.md-previews .ci-thumb.loaded')).toHaveCount(1);
  await expect(reply.getByRole('button', { name: 'Open image Wide banner' })).toHaveClass(/loaded/);
  await expect(reply.locator('a.md-image-link[href="https://remote.invalid/chart.png"]')).toBeVisible();
  await expect(reply.locator('.ci-failed, .ci-pending')).toHaveCount(0);

  const asked = frames.filter((frame) => frame.includes('"image.get"'));
  expect(asked.some((frame) => frame.includes('docs/gone.png'))).toBe(true);
  expect(asked.filter((frame) => frame.includes('remote.invalid'))).toEqual([]);
  expect(requested.filter((url) => url.includes('remote.invalid'))).toEqual([]);
  const excess = await page.locator('.chat-log').evaluate((log) => log.scrollWidth - log.clientWidth);
  expect(excess).toBeLessThanOrEqual(0);
});
