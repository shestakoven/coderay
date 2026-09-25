import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createPathsMatcher, getTsconfig, parseTsconfig, type PathsMatcher, type TsConfigResult } from 'get-tsconfig';

export function createTsconfigPaths(root: string): (fromPath: string) => PathsMatcher[] {
  const found = new Map<string, unknown>();
  const parsed = new Map<string, string>();
  const warned = new Set<string>();
  const warn = (error: unknown): void => {
    const message = `typescript: ignoring tsconfig paths: ${(error as Error).message}`;
    if (warned.has(message)) return;
    warned.add(message);
    console.warn(message);
  };

  const readReference = (from: TsConfigResult, referencePath: string): TsConfigResult[] => {
    const target = resolve(dirname(from.path), referencePath);
    const path = isDirectory(target) ? join(target, 'tsconfig.json') : target;
    if (!inside(root, path)) return [];
    try {
      return [{ path, config: parseTsconfig(path, parsed) }];
    } catch (error) {
      warn(error);
      return [];
    }
  };

  const matchersFor = (dir: string): PathsMatcher[] => {
    let nearest: TsConfigResult | null;
    try {
      nearest = getTsconfig(dir, 'tsconfig.json', found);
    } catch (error) {
      warn(error);
      return [];
    }
    if (!nearest || !inside(root, nearest.path)) return [];
    const own = nearest;
    const configs = [own, ...(own.config.references ?? []).flatMap((reference) => readReference(own, reference.path))];
    return configs.flatMap((config) => {
      try {
        return createPathsMatcher(config) ?? [];
      } catch (error) {
        warn(error);
        return [];
      }
    });
  };

  const byDir = new Map<string, PathsMatcher[]>([[root, matchersFor(root)]]);
  return (fromPath) => {
    const dir = dirname(join(root, fromPath));
    let matchers = byDir.get(dir);
    if (!matchers) {
      matchers = matchersFor(dir);
      byDir.set(dir, matchers);
    }
    return matchers;
  };
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
