import type { ClientMessage, ImageFailure, ImageMediaType, ImageRef, SessionServerMessage } from '@ide/protocol';
import { pickEvictions } from './image-cache';
import { base64ToBytes, MAX_REQUEST_KEY, requestKeyOf, type ImageSource } from './image-source';

export type ImageView =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string; image: ImageRef }
  | { status: 'failed'; reason: ImageFailure };

export type ImageAnswer = Extract<SessionServerMessage, { type: 'image.data' | 'image.failed' }>;

export interface ObjectUrls {
  create(bytes: Uint8Array<ArrayBuffer>, mediaType: ImageMediaType): string;
  revoke(url: string): void;
}

const BLOB_URLS: ObjectUrls = {
  create: (bytes, mediaType) => URL.createObjectURL(new Blob([bytes], { type: mediaType })),
  revoke: (url) => URL.revokeObjectURL(url),
};

export const IDLE: ImageView = { status: 'idle' };
const LOADING: ImageView = { status: 'loading' };
// The core reads at most 8 images at a time for a socket; the rest wait here, where the order can still change.
const MAX_IN_FLIGHT = 6;
const QUEUED = '';

interface Entry {
  source: ImageSource;
  view: ImageView;
  listeners: Set<() => void>;
  scopes: Set<string>;
  retried: boolean;
  // The request key in flight, QUEUED while it waits its turn, null when nothing is asked.
  pending: string | null;
  // A file shown already is read again for a newer message; until the answer comes the old image stays.
  background: boolean;
}

interface Cached {
  url: string;
  image: ImageRef;
  usedAt: number;
}

// The images of one project's chat: fetched over its socket on demand, each blob kept once by its id.
export class ImageStore {
  private readonly entries = new Map<string, Entry>();
  private readonly cache = new Map<string, Cached>();
  private readonly inFlight = new Map<string, string>();
  private queue: string[] = [];
  private online = false;
  private serial = 0;
  private clock = 0;

  constructor(
    private readonly send: (message: ClientMessage) => boolean,
    private readonly urls: ObjectUrls = BLOB_URLS,
  ) {}

  view(key: string): ImageView {
    return this.entries.get(key)?.view ?? IDLE;
  }

  subscribe(key: string, source: ImageSource, listener: () => void): () => void {
    let entry = this.entries.get(key);
    if (!entry) this.entries.set(key, (entry = { source, view: IDLE, listeners: new Set(), scopes: new Set(), retried: false, pending: null, background: false }));
    entry.listeners.add(listener);
    const held = entry;
    return () => {
      held.listeners.delete(listener);
      if (held.listeners.size === 0) this.evict();
    };
  }

  // Asks for an image once it is about to be seen; a scope not seen before reads a shown file again.
  want(key: string, scope?: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (scope !== undefined && scope !== '' && 'path' in entry.source && !entry.scopes.has(scope)) {
      const known = entry.scopes.size > 0;
      entry.scopes.add(scope);
      if (known && entry.pending === null && (entry.view.status === 'ready' || entry.view.status === 'failed')) {
        entry.background = true;
        this.enqueue(key, entry);
        return;
      }
    }
    if (entry.view.status !== 'idle') return;
    if ('id' in entry.source) {
      const cached = this.cache.get(entry.source.id);
      if (cached) {
        cached.usedAt = ++this.clock;
        this.show(entry, { status: 'ready', url: cached.url, image: cached.image });
        return;
      }
    }
    this.show(entry, LOADING);
    this.enqueue(key, entry);
  }

  retry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.view.status !== 'failed') return;
    entry.retried = false;
    entry.background = false;
    this.show(entry, LOADING);
    this.enqueue(key, entry);
  }

  handle(message: ImageAnswer): void {
    const key = this.inFlight.get(message.key);
    if (key === undefined) return;
    this.inFlight.delete(message.key);
    const entry = this.entries.get(key);
    if (entry?.pending === message.key) this.settle(key, entry, message);
    this.pump();
  }

  setOnline(online: boolean): void {
    this.online = online;
    if (!online) {
      // The answers died with the socket: ask again, first, once it is back.
      const lost = [...this.inFlight.values()];
      this.inFlight.clear();
      for (const key of lost) {
        const entry = this.entries.get(key);
        if (entry) entry.pending = QUEUED;
      }
      this.queue = [...lost.filter((key) => this.entries.has(key)), ...this.queue];
    }
    this.pump();
  }

  dispose(): void {
    for (const cached of this.cache.values()) this.urls.revoke(cached.url);
    this.cache.clear();
    this.inFlight.clear();
    this.queue = [];
    for (const entry of this.entries.values()) {
      entry.pending = null;
      entry.background = false;
      if (entry.view.status !== 'idle') this.show(entry, IDLE);
    }
  }

  private settle(key: string, entry: Entry, message: ImageAnswer): void {
    entry.pending = null;
    const background = entry.background;
    entry.background = false;
    if (message.type === 'image.failed') {
      if (message.reason === 'unreadable' && !entry.retried) {
        entry.retried = true;
        entry.background = background;
        this.enqueue(key, entry);
        return;
      }
      if (background && message.reason === 'unreadable') return;
      this.show(entry, { status: 'failed', reason: message.reason });
      return;
    }
    entry.retried = false;
    let cached = this.cache.get(message.image.id);
    if (!cached) {
      cached = { url: this.urls.create(base64ToBytes(message.data), message.image.mediaType), image: message.image, usedAt: 0 };
      this.cache.set(message.image.id, cached);
    }
    cached.usedAt = ++this.clock;
    const current = entry.view;
    if (current.status !== 'ready' || current.url !== cached.url) this.show(entry, { status: 'ready', url: cached.url, image: cached.image });
    this.evict();
  }

  private enqueue(key: string, entry: Entry): void {
    entry.pending = QUEUED;
    this.queue.push(key);
    this.pump();
  }

  private pump(): void {
    while (this.online && this.inFlight.size < MAX_IN_FLIGHT && this.queue.length > 0) {
      const key = this.queue.shift()!;
      const entry = this.entries.get(key);
      if (!entry || entry.pending !== QUEUED) continue;
      const requestKey = requestKeyOf(key, ++this.serial);
      if (requestKey.length > MAX_REQUEST_KEY) {
        entry.pending = null;
        this.show(entry, { status: 'failed', reason: 'missing' });
        continue;
      }
      const sent = this.send('id' in entry.source
        ? { type: 'image.get', key: requestKey, id: entry.source.id }
        : { type: 'image.get', key: requestKey, path: entry.source.path });
      if (!sent) {
        this.queue.unshift(key);
        return;
      }
      entry.pending = requestKey;
      this.inFlight.set(requestKey, key);
    }
  }

  private show(entry: Entry, view: ImageView): void {
    entry.view = view;
    for (const listener of [...entry.listeners]) listener();
  }

  private evict(): void {
    const users = new Map<string, number>();
    for (const entry of this.entries.values()) {
      if (entry.view.status === 'ready' && entry.listeners.size > 0) users.set(entry.view.image.id, (users.get(entry.view.image.id) ?? 0) + 1);
    }
    const evicted = pickEvictions([...this.cache].map(([id, cached]) => ({ id, bytes: cached.image.bytes, users: users.get(id) ?? 0, usedAt: cached.usedAt })));
    if (evicted.length === 0) return;
    const gone = new Set(evicted);
    for (const id of evicted) {
      this.urls.revoke(this.cache.get(id)!.url);
      this.cache.delete(id);
    }
    for (const entry of this.entries.values()) {
      if (entry.view.status === 'ready' && gone.has(entry.view.image.id)) this.show(entry, IDLE);
    }
  }
}
