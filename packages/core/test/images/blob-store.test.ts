import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlobStore } from '../../src/images/blob-store';
import { tempDir } from '../helpers';
import { gif, png } from './bytes';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function store() {
  const dir = tempDir('ide-blobs-');
  return { blobs: new BlobStore(dir), dir: join(dir, 'blobs'), files: () => readdirSync(join(dir, 'blobs')).sort() };
}

describe('BlobStore', () => {
  it('keeps the same image once, under the sha256 of its bytes, with no temporary file left', () => {
    const { blobs, dir, files } = store();
    const image = png(64, 40);
    const first = blobs.put(image);
    const second = blobs.put(Buffer.from(image));
    expect([first, second]).toEqual([
      { id: sha(image), mediaType: 'image/png', bytes: image.length, width: 64, height: 40 },
      { id: sha(image), mediaType: 'image/png', bytes: image.length, width: 64, height: 40 },
    ]);
    expect(files()).toEqual([sha(image)]);
    expect(readFileSync(join(dir, sha(image)))).toEqual(image);
  });

  it('sweeps unreferenced blobs and interrupted writes, keeping referenced blobs and files it does not own', () => {
    const { blobs, dir, files } = store();
    const kept = blobs.put(png(1, 1))!.id;
    blobs.put(gif(1, 1));
    writeFileSync(join(dir, `${kept}.4242.tmp`), 'half');
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    expect(blobs.sweep(() => new Set([kept]))).toBe(2);
    expect(files()).toEqual([kept, 'notes.txt'].sort());
  });

  it('deletes nothing when the references cannot be read, and does not ask for them when there is nothing to sweep', () => {
    const empty = store();
    let asked = false;
    expect(empty.blobs.sweep(() => {
      asked = true;
      return new Set();
    })).toBe(0);
    expect(asked).toBe(false);

    const { blobs, files } = store();
    const id = blobs.put(png(2, 2))!.id;
    expect(() => blobs.sweep(() => {
      throw new Error('database is locked');
    })).toThrow('database is locked');
    expect(files()).toEqual([id]);
  });
});
