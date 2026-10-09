import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MAX_IMAGE_BYTES, type ServerMessage } from '@ide/protocol';
import { BlobStore } from '../../src/images/blob-store';
import { ImageRequests } from '../../src/images/image-requests';
import type { Reply } from '../../src/server/server';
import { tempDir } from '../helpers';
import { png } from './bytes';

function socket(room: (bytes: number) => Promise<boolean> = async () => true) {
  const sent: ServerMessage[] = [];
  const reply: Reply = Object.assign((message: ServerMessage) => void sent.push(message), { room });
  return { reply, sent };
}

function project() {
  const root = tempDir('ide-images-root-');
  const blobs = new BlobStore(tempDir('ide-images-data-'));
  const requests = new ImageRequests({ root, blobs });
  // A size tells which file was served.
  const answer = async (path: string): Promise<string> => {
    const { reply, sent } = socket();
    await requests.handle({ type: 'image.get', key: 'k', path }, reply);
    const message = sent[0];
    if (message?.type === 'image.data') return `${message.image.width}x${message.image.height}`;
    return message?.type === 'image.failed' ? message.reason : 'no answer';
  };
  return { root, blobs, requests, answer };
}

describe('ImageRequests paths', () => {
  it('finds a file in every form an agent writes its path, trimming prose only when the path as written names nothing', async () => {
    const { root, answer } = project();
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/shot.png'), png(64, 40));
    writeFileSync(join(root, 'my shot.png'), png(11, 11));
    writeFileSync(join(root, '(paren).png'), png(7, 7));
    writeFileSync(join(root, 'edge.png'), Buffer.concat([png(3, 3), Buffer.alloc(MAX_IMAGE_BYTES - png(3, 3).length)]));
    symlinkSync(join(root, 'docs/shot.png'), join(root, 'link.png'));
    const outside = tempDir('ide-images-outside-');
    writeFileSync(join(outside, 'far.png'), png(9, 9));
    const home = tempDir('ide-images-home-');
    writeFileSync(join(home, 'pic.png'), png(5, 5));
    const saved = process.env.HOME;
    process.env.HOME = home;
    onTestFinished(() => {
      process.env.HOME = saved;
    });

    const written = [
      'docs/shot.png', join(root, 'docs/shot.png'), pathToFileURL(join(root, 'docs/shot.png')).href, 'my%20shot.png', '~/pic.png', join(outside, 'far.png'),
      '"docs/shot.png"', '`docs/shot.png`', '<docs/shot.png>', '(docs/shot.png),', 'docs/shot.png.', 'docs/shot.png:', '(paren).png', 'link.png', 'edge.png',
    ];
    const answers = await Promise.all(written.map(answer));
    expect(Object.fromEntries(written.map((path, index) => [path, answers[index]]))).toEqual({
      'docs/shot.png': '64x40',
      [join(root, 'docs/shot.png')]: '64x40',
      [pathToFileURL(join(root, 'docs/shot.png')).href]: '64x40',
      'my%20shot.png': '11x11',
      '~/pic.png': '5x5',
      [join(outside, 'far.png')]: '9x9',
      '"docs/shot.png"': '64x40',
      '`docs/shot.png`': '64x40',
      '<docs/shot.png>': '64x40',
      '(docs/shot.png),': '64x40',
      'docs/shot.png.': '64x40',
      'docs/shot.png:': '64x40',
      '(paren).png': '7x7',
      'link.png': '64x40',
      'edge.png': '3x3',
    });
  });

  it('answers with the reason instead of bytes for anything that is not a regular image file within the size limit', async () => {
    const { root, answer } = project();
    writeFileSync(join(root, 'notes.png'), 'just text with a png name');
    writeFileSync(join(root, 'shot.txt'), png(4, 4));
    mkdirSync(join(root, 'dir.png'));
    execFileSync('mkfifo', [join(root, 'pipe.png')]);
    writeFileSync(join(root, 'big.png'), Buffer.concat([png(3, 3), Buffer.alloc(MAX_IMAGE_BYTES + 1 - png(3, 3).length)]));

    const written = ['docs/none.png', 'notes.png', 'shot.txt', 'dir.png', 'pipe.png', 'big.png', 'file://elsewhere/x.png'];
    const answers = await Promise.all(written.map(answer));
    expect(Object.fromEntries(written.map((path, index) => [path, answers[index]]))).toEqual({
      'docs/none.png': 'missing',
      'notes.png': 'not-image',
      'shot.txt': 'not-image',
      'dir.png': 'not-image',
      'pipe.png': 'not-image',
      'big.png': 'too-large',
      'file://elsewhere/x.png': 'missing',
    });
  });
});

describe('ImageRequests ids and the socket', () => {
  it('sends a stored image by its id as base64 of its bytes, and an unknown id as missing', async () => {
    const { blobs, requests } = project();
    const bytes = png(12, 34);
    const image = blobs.put(bytes)!;
    const { reply, sent } = socket();
    await requests.handle({ type: 'image.get', key: 'a', id: image.id }, reply);
    await requests.handle({ type: 'image.get', key: 'b', id: 'f'.repeat(64) }, reply);
    await requests.handle({ type: 'image.get', key: 'c', id: '../../etc/passwd' }, reply);
    expect(sent).toEqual([
      { type: 'image.data', key: 'a', image, data: bytes.toString('base64') },
      { type: 'image.failed', key: 'b', reason: 'missing' },
      { type: 'image.failed', key: 'c', reason: 'missing' },
    ]);
  });

  it('waits for backlog room for one frame at a time', async () => {
    const { blobs, requests } = project();
    const ids = [blobs.put(png(1, 1))!.id, blobs.put(png(2, 2))!.id, blobs.put(png(3, 3))!.id];
    let waiting = 0;
    let most = 0;
    const { reply, sent } = socket(async () => {
      most = Math.max(most, ++waiting);
      await new Promise((resolve) => setTimeout(resolve, 20));
      waiting -= 1;
      return true;
    });
    await Promise.all(ids.map((id, index) => requests.handle({ type: 'image.get', key: String(index), id }, reply)));
    expect([most, sent.map((message) => message.type).sort()]).toEqual([1, ['image.data', 'image.data', 'image.data']]);
  });

  it('fails an image whose frame never finds room in the backlog', async () => {
    const { blobs, requests } = project();
    const image = blobs.put(png(1, 1))!;
    const { reply, sent } = socket(async () => false);
    await requests.handle({ type: 'image.get', key: 'k', id: image.id }, reply);
    expect(sent).toEqual([{ type: 'image.failed', key: 'k', reason: 'unreadable' }]);
  });
});
