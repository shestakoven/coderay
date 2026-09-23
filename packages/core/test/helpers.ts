import { fileURLToPath } from 'node:url';
import type { Lang } from '@ide/protocol';
import type { IndexedFile } from '../src/model';

export const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

export function indexed(path: string, lang: Lang, imports: string[], overrides: Partial<IndexedFile> = {}): IndexedFile {
  return { path, lang, contentHash: path, imports, symbols: [], parseError: false, ...overrides };
}
