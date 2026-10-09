import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { ImageRef } from '@ide/protocol';
import { imageInfo } from './image-info';

// Larger bytes are not kept; the chat shows images up to MAX_IMAGE_BYTES and answers 'too-large' above it.
export const MAX_STORED_IMAGE_BYTES = 25 * 1024 * 1024;
export const BLOB_ID = /^[0-9a-f]{64}$/;

const STRAY = /\.tmp$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function imageRef(bytes: Uint8Array): ImageRef | null {
  const info = imageInfo(bytes);
  if (!info) return null;
  const { mediaType, width, height } = info;
  return { id: createHash('sha256').update(bytes).digest('hex'), mediaType, bytes: bytes.length, ...(width === undefined ? {} : { width, height }) };
}

// Images of the project's chats, each in a file named by the sha256 of its bytes, so the same image is kept once.
export class BlobStore {
  private readonly dir: string;

  constructor(projectDataDir: string) {
    this.dir = join(projectDataDir, 'blobs');
  }

  // Null when the bytes are not a png, jpeg, gif or webp, or are larger than MAX_STORED_IMAGE_BYTES.
  put(bytes: Uint8Array): ImageRef | null {
    if (bytes.length > MAX_STORED_IMAGE_BYTES) return null;
    const ref = imageRef(bytes);
    if (!ref) return null;
    const file = this.path(ref.id);
    if (existsSync(file)) return ref;
    mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
    const temp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, bytes, { mode: FILE_MODE });
      renameSync(temp, file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    return ref;
  }

  // Removes the blobs no chat refers to and what interrupted writes left; asks for the references only when there are files.
  sweep(referenced: () => Set<string>): number {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    const files = entries.filter((entry) => entry.isFile() && (BLOB_ID.test(entry.name) || STRAY.test(entry.name)));
    if (files.length === 0) return 0;
    const keep = referenced();
    const unused = files.filter((file) => !keep.has(file.name));
    for (const file of unused) rmSync(join(this.dir, file.name), { force: true });
    return unused.length;
  }

  path(id: string): string {
    if (!BLOB_ID.test(id)) throw new Error(`not a blob id: ${JSON.stringify(id)}`);
    return join(this.dir, id);
  }
}
