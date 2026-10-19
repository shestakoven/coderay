import { constants } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_IMAGE_BYTES, type ClientMessage, type ImageFailure, type ImageRef } from '@ide/protocol';
import type { Reply } from '../server/server';
import { BLOB_ID, imageRef, type BlobStore } from './blob-store';

type ImageGet = Extract<ClientMessage, { type: 'image.get' }>;
type Read = { image: ImageRef; bytes: Buffer } | { reason: ImageFailure };

interface Client {
  reads: number;
  waiting: (() => void)[];
  sending: Promise<void>;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_READS = 8;
const MAX_WAITING = 256;
// Base64 is ASCII and the key escapes to at most six bytes a character, so a frame's JSON stays under this.
const frameBytes = (key: string, data: string): number => data.length + key.length * 6 + 512;

// Answers `image.get` on the socket that asked: an image of the chat by its id, or a file the agent named by its path.
export class ImageRequests {
  private readonly root: string;
  private readonly blobs: BlobStore;
  private readonly clients = new WeakMap<Reply, Client>();

  constructor(options: { root: string; blobs: BlobStore }) {
    this.root = options.root;
    this.blobs = options.blobs;
  }

  async handle(message: ImageGet, reply: Reply): Promise<void> {
    let client = this.clients.get(reply);
    if (!client) this.clients.set(reply, (client = { reads: 0, waiting: [], sending: Promise.resolve() }));
    if (!(await acquire(client))) {
      reply({ type: 'image.failed', key: message.key, reason: 'unreadable' });
      return;
    }
    try {
      const read = await this.read(message);
      // One image frame at a time per socket, each only once the socket's backlog has room for it.
      const sent = client.sending.then(async () => {
        if ('reason' in read) return reply({ type: 'image.failed', key: message.key, reason: read.reason });
        const data = read.bytes.toString('base64');
        if (!(await reply.room(frameBytes(message.key, data)))) return reply({ type: 'image.failed', key: message.key, reason: 'unreadable' });
        reply({ type: 'image.data', key: message.key, image: read.image, data });
      });
      client.sending = sent.catch(() => undefined);
      await sent;
    } finally {
      release(client);
    }
  }

  private async read(message: ImageGet): Promise<Read> {
    try {
      if (message.id !== undefined) return BLOB_ID.test(message.id) ? await readImage(this.blobs.path(message.id)) : { reason: 'missing' };
      return await this.readPath(message.path ?? '');
    } catch (error) {
      console.error('images: could not read an image', error);
      return { reason: 'unreadable' };
    }
  }

  // Agents write paths inside prose: quotes, brackets or punctuation around one are dropped only when the path as written names nothing.
  private async readPath(written: string): Promise<Read> {
    const asWritten = this.locate(written);
    const trimmed = trimProse(written);
    const path = trimmed === written || (asWritten !== null && (await exists(asWritten))) ? asWritten : this.locate(trimmed);
    if (path === null) return { reason: 'missing' };
    if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return { reason: 'not-image' };
    return readImage(path);
  }

  private locate(written: string): string | null {
    let path: string;
    if (/^file:/i.test(written)) {
      try {
        path = fileURLToPath(written);
      } catch {
        return null;
      }
    } else {
      path = decodePercent(written);
      if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
    }
    return resolve(this.root, path);
  }
}

async function acquire(client: Client): Promise<boolean> {
  if (client.reads < MAX_READS) {
    client.reads += 1;
    return true;
  }
  if (client.waiting.length >= MAX_WAITING) return false;
  // The slot is handed over by release, never freed in between.
  await new Promise<void>((resolveTurn) => client.waiting.push(resolveTurn));
  return true;
}

function release(client: Client): void {
  const next = client.waiting.shift();
  if (next) next();
  else client.reads -= 1;
}

async function readImage(path: string): Promise<Read> {
  let handle: FileHandle;
  try {
    // A fifo would hold the open until some writer came.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return { reason: isMissing(error) ? 'missing' : 'unreadable' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { reason: 'not-image' };
    if (info.size > MAX_IMAGE_BYTES) return { reason: 'too-large' };
    const buffer = Buffer.alloc(info.size);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const bytes = buffer.subarray(0, filled);
    const image = imageRef(bytes);
    return image ? { image, bytes } : { reason: 'not-image' };
  } catch {
    return { reason: 'unreadable' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return !isMissing(error);
  }
}

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const decodePercent = (path: string): string => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

const trimProse = (path: string): string => path.trim().replace(/^["'`<(]+/, '').replace(/["'`>).,;:!?]+$/, '');
