import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import type { Lang } from '@ide/protocol';
import type { IndexedFile } from '../src/model';

export const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

export function indexed(path: string, lang: Lang, imports: string[], overrides: Partial<IndexedFile> = {}): IndexedFile {
  return { path, lang, contentHash: path, imports, symbols: [], parseError: false, ...overrides };
}

export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, relPath)), { recursive: true });
    await writeFile(join(root, relPath), content);
  }
}

export async function waitFor<T>(
  probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  label: string,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor: ${label} not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function unit(...values: number[]): Float32Array {
  const norm = Math.hypot(...values);
  return Float32Array.from(values, (value) => value / norm);
}
