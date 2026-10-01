import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addAttachments, imageFiles, MAX_IMAGE_BYTES, type Attachment } from '../src/chat/attachments';

class FakeFileReader {
  result: string | null = null;
  error: Error | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      this.result = `data:${blob.type};base64,${btoa(new Uint8Array(buffer).reduce((text, byte) => text + String.fromCharCode(byte), ''))}`;
      this.onload?.();
    });
  }
}

beforeEach(() => {
  vi.stubGlobal('FileReader', FakeFileReader);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const file = (name: string, type: string, bytes: Uint8Array<ArrayBuffer> | number = new Uint8Array([102, 111, 111])) =>
  new File([typeof bytes === 'number' ? new Uint8Array(bytes) : bytes], name, { type });
const existing = (id: string): Attachment => ({ id, name: `${id}.png`, mediaType: 'image/png', data: 'AAEC' });

describe('addAttachments', () => {
  it('adds an image with its name, media type and base64 data', async () => {
    const result = await addAttachments([], [file('a.png', 'image/png')]);
    expect(result.problem).toBeNull();
    expect(result.attachments).toMatchObject([{ name: 'a.png', mediaType: 'image/png', data: 'Zm9v' }]);
    expect(result.attachments[0]?.id).toEqual(expect.any(String));
  });

  it('keeps the existing attachments before the new ones', async () => {
    const result = await addAttachments([existing('one')], [file('two.webp', 'image/webp')]);
    expect(result.attachments.map((item) => item.name)).toEqual(['one.png', 'two.webp']);
  });

  it('does not change the list it was given', async () => {
    const current = [existing('one')];
    await addAttachments(current, [file('a.png', 'image/png')]);
    expect(current).toHaveLength(1);
  });

  it('gives different attachments different ids', async () => {
    const result = await addAttachments([], [file('a.png', 'image/png'), file('a.png', 'image/png')]);
    expect(new Set(result.attachments.map((item) => item.id)).size).toBe(2);
  });

  it('accepts exactly four images', async () => {
    const files = [1, 2, 3, 4].map((n) => file(`${n}.png`, 'image/png'));
    const result = await addAttachments([], files);
    expect([result.attachments.length, result.problem]).toEqual([4, null]);
  });

  it('rejects the fifth image with a limit message and keeps the first four', async () => {
    const files = [1, 2, 3, 4, 5].map((n) => file(`${n}.png`, 'image/png'));
    const result = await addAttachments([], files);
    expect(result.attachments.map((item) => item.name)).toEqual(['1.png', '2.png', '3.png', '4.png']);
    expect(result.problem).toBe('At most 4 images per message.');
  });

  it('counts the existing attachments toward the limit', async () => {
    const result = await addAttachments([existing('a'), existing('b'), existing('c')], [file('x.png', 'image/png'), file('y.png', 'image/png')]);
    expect(result.attachments.map((item) => item.name)).toEqual(['a.png', 'b.png', 'c.png', 'x.png']);
    expect(result.problem).toBe('At most 4 images per message.');
  });

  it.each(['image/svg+xml', 'image/bmp', 'application/pdf', ''])('rejects the type "%s" and names the file', async (type) => {
    const result = await addAttachments([], [file('doc.bin', type)]);
    expect(result.attachments).toEqual([]);
    expect(result.problem).toBe('doc.bin: only PNG, JPEG, GIF and WebP are supported.');
  });

  it('rejects a file over 1 MiB and accepts one of exactly 1 MiB', async () => {
    const big = await addAttachments([], [file('big.png', 'image/png', 1024 * 1024 + 1)]);
    const edge = await addAttachments([], [file('edge.png', 'image/png', 1024 * 1024)]);
    expect([big.attachments.length, big.problem, edge.attachments.length, edge.problem]).toEqual([0, 'big.png is larger than 1 MB.', 1, null]);
    expect(MAX_IMAGE_BYTES).toBe(1048576);
  });

  it('keeps the good files when another file in the batch is rejected', async () => {
    const result = await addAttachments([], [file('ok.png', 'image/png'), file('bad.svg', 'image/svg+xml'), file('ok2.jpg', 'image/jpeg')]);
    expect(result.attachments.map((item) => item.name)).toEqual(['ok.png', 'ok2.jpg']);
    expect(result.problem).toBe('bad.svg: only PNG, JPEG, GIF and WebP are supported.');
  });

  it('names an unnamed image "image"', async () => {
    const result = await addAttachments([], [file('', 'image/png')]);
    expect(result.attachments[0]?.name).toBe('image');
  });
});

describe('imageFiles', () => {
  it('keeps only files whose type starts with image/', () => {
    const files = [file('a.png', 'image/png'), file('b.txt', 'text/plain'), file('c.svg', 'image/svg+xml'), file('d', '')];
    expect(imageFiles(files).map((item) => item.name)).toEqual(['a.png', 'c.svg']);
  });
});
