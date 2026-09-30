import { createHash } from 'node:crypto';

export type ExpectWrite = (rel: string, hash: string) => void;

export const blobHash = (text: string): string =>
  createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');

export class IdeWrites {
  private readonly pending = new Map<string, { hash: string | null; until: number }[]>();

  constructor(private readonly now: () => number = Date.now) {}

  expect(rel: string, hash: string | null, ttlMs = 10_000): void {
    const list = this.pending.get(rel) ?? [];
    list.push({ hash, until: this.now() + ttlMs });
    this.pending.set(rel, list);
  }

  claim(rel: string, hash: string | null): boolean {
    const list = (this.pending.get(rel) ?? []).filter((e) => e.until > this.now());
    const i = list.findIndex((e) => e.hash === hash);
    if (i >= 0) list.splice(i, 1);
    if (list.length) this.pending.set(rel, list);
    else this.pending.delete(rel);
    return i >= 0;
  }
}
