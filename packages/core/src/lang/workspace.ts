import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, posix } from 'node:path';
import { createIgnoreMatcher } from '../indexer/ignore';
import { isRecord } from '../json';

export interface WorkspacePackage {
  name: string;
  dir: string;
  exports: unknown;
  main?: string;
  module?: string;
}

const MAX_DEPTH = 8;
const BUILD_DIRS = new Set(['dist', 'lib', 'build', 'out']);
const FLAVOR_DIRS = new Set(['esm', 'cjs', 'es', 'mjs', 'types']);
const DECLARATION = /\.d\.[cm]?ts$/;
const CONDITION_ORDER = ['types', 'import', 'module', 'default', 'require', 'node'];

export function findWorkspacePackages(root: string): WorkspacePackage[] {
  const isIgnored = createIgnoreMatcher(root);
  const packages: WorkspacePackage[] = [];
  const walk = (relDir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isFile() && entry.name === 'package.json') {
        const found = readPackage(join(root, relPath), relDir);
        if (found) packages.push(found);
      } else if (entry.isDirectory() && depth < MAX_DEPTH && !isIgnored(relPath, true)) {
        walk(relPath, depth + 1);
      }
    }
  };
  walk('', 0);
  return packages;
}

export function workspaceImportBases(specifier: string, packages: WorkspacePackage[]): string[] {
  const owner = packages
    .filter((candidate) => specifier === candidate.name || specifier.startsWith(`${candidate.name}/`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!owner) return [];
  const subpath = specifier === owner.name ? '.' : `./${specifier.slice(owner.name.length + 1)}`;
  const targets =
    owner.exports !== undefined && owner.exports !== null
      ? exportTargets(owner.exports, subpath)
      : subpath === '.'
        ? [owner.module, owner.main, 'src/index', 'index'].filter((target): target is string => target !== undefined)
        : [subpath, `src/${subpath.slice(2)}`];
  return targets.flatMap((target) => sourceBases(owner.dir, target));
}

function readPackage(path: string, dir: string): WorkspacePackage | null {
  try {
    const json: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(json) || typeof json.name !== 'string' || json.name === '') return null;
    return {
      name: json.name,
      dir,
      exports: json.exports,
      main: typeof json.main === 'string' ? json.main : undefined,
      module: typeof json.module === 'string' ? json.module : undefined,
    };
  } catch {
    return null;
  }
}

// Follows Node's PACKAGE_EXPORTS_RESOLVE: an exact key wins, then the pattern with the longest prefix; null excludes.
function exportTargets(exports: unknown, subpath: string): string[] {
  if (!isRecord(exports) || !Object.keys(exports).some((key) => key.startsWith('.'))) {
    return subpath === '.' ? conditionTargets(exports) : [];
  }
  if (Object.hasOwn(exports, subpath) && !subpath.includes('*')) return conditionTargets(exports[subpath]);
  const patterns = Object.keys(exports)
    .filter((key) => key.split('*').length === 2)
    .sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length);
  for (const key of patterns) {
    const star = key.indexOf('*');
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || subpath === prefix) continue;
    if (suffix !== '' && (!subpath.endsWith(suffix) || subpath.length < key.length)) continue;
    const match = subpath.slice(prefix.length, subpath.length - suffix.length);
    return conditionTargets(exports[key]).map((target) => target.replaceAll('*', match));
  }
  return [];
}

function conditionTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(conditionTargets);
  if (!isRecord(value)) return [];
  const rank = (condition: string) => {
    const index = CONDITION_ORDER.indexOf(condition);
    return index === -1 ? CONDITION_ORDER.length : index;
  };
  return Object.keys(value)
    .sort((a, b) => rank(a) - rank(b))
    .flatMap((condition) => conditionTargets(value[condition]));
}

function sourceBases(dir: string, target: string): string[] {
  const rel = posix.normalize(target.replace(DECLARATION, ''));
  const [first, second, ...rest] = rel.split('/');
  const bases = [posix.join(dir, rel)];
  if (first && BUILD_DIRS.has(first) && second) {
    bases.push(posix.join(dir, 'src', second, ...rest));
    if (FLAVOR_DIRS.has(second) && rest.length > 0) bases.push(posix.join(dir, 'src', ...rest));
  }
  return bases;
}
