import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

const read = (file: string) => readFileSync(join(DESKTOP, file), 'utf8');

function localModulesLoadedBy(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(join(DESKTOP, file))) continue;
    for (const [, specifier] of read(file).matchAll(LOCAL_IMPORT)) {
      queue.push(relative(DESKTOP, join(DESKTOP, dirname(file), specifier)));
    }
  }
  return [...seen];
}

function packagedFiles(): string[] {
  const list = /\bfiles\s*:\s*\[([^\]]*)\]/.exec(read('build-app.mjs'))?.[1] ?? '';
  return [...list.matchAll(/['"]([^'"]+)['"]/g)].map(([, name]) => normalize(name));
}

describe('packaged desktop app', () => {
  it('lists in electron-builder files every local module that main.mjs loads, directly or through another module', () => {
    const loaded = localModulesLoadedBy('main.mjs');
    const packaged = packagedFiles();

    expect(packaged.length).toBeGreaterThan(0);
    expect(loaded).toContain('main.mjs');
    expect(loaded.length).toBeGreaterThan(1);
    expect(loaded.filter((file) => !packaged.includes(file))).toEqual([]);
  });
});
