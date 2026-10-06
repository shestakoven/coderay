import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, posix } from 'node:path';
import { parse } from 'yaml';
import { createIgnoreMatcher } from '../indexer/ignore';
import { isRecord } from '../json';

export interface XcodeApp {
  name: string;
  platform: string | null;
  file: string;
  dirs: string[];
}

export interface Xcode {
  apps: XcodeApp[];
  files: string[];
  warnings: string[];
}

const MAX_DEPTH = 3;

// XcodeGen specs only: a plain .xcodeproj keeps its targets in project.pbxproj, which this does not read.
export function readXcode(root: string): Xcode {
  const { specs, bundles } = findProjects(root);
  const apps: XcodeApp[] = [];
  const warnings: string[] = [];
  for (const file of specs) {
    let doc: unknown;
    try {
      doc = parse(readFileSync(join(root, file), 'utf8'));
    } catch (error) {
      warnings.push(`${file}: ${(error as Error).message.split('\n')[0]}`);
      continue;
    }
    apps.push(...appsIn(file, doc));
  }
  for (const bundle of bundles) {
    if (!specs.includes(posix.join(posix.dirname(bundle), 'project.yml'))) warnings.push(`${bundle}: Xcode project without project.yml is not shown`);
  }
  return { apps, files: specs, warnings };
}

function appsIn(file: string, doc: unknown): XcodeApp[] {
  const targets = isRecord(doc) && isRecord(doc.targets) ? Object.entries(doc.targets).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])) : [];
  const typeOf = (target: Record<string, unknown>) => (typeof target.type === 'string' ? target.type : '');
  const apps = targets.filter(([, target]) => typeOf(target).startsWith('application'));
  const extensions = new Map(targets.filter(([, target]) => typeOf(target).startsWith('app-extension')));
  const claimed = new Set(apps.flatMap(([, target]) => dependencyTargets(target)));
  return apps.map(([name, target]) => {
    const embedded = [...extensions].filter(([extension]) => dependencyTargets(target).includes(extension) || (apps.length === 1 && !claimed.has(extension)));
    return {
      name,
      platform: typeof target.platform === 'string' ? target.platform : null,
      file,
      dirs: [...new Set([target, ...embedded.map(([, extension]) => extension)].flatMap((t) => sourceDirs(posix.dirname(file), t)))],
    };
  });
}

function dependencyTargets(target: Record<string, unknown>): string[] {
  const dependencies = Array.isArray(target.dependencies) ? target.dependencies : [];
  return dependencies.flatMap((dependency) => (isRecord(dependency) && typeof dependency.target === 'string' ? [dependency.target] : []));
}

function sourceDirs(base: string, target: Record<string, unknown>): string[] {
  const sources = Array.isArray(target.sources) ? target.sources : typeof target.sources === 'string' ? [target.sources] : [];
  return sources.flatMap((source) => {
    const path = typeof source === 'string' ? source : isRecord(source) && typeof source.path === 'string' ? source.path : null;
    return path === null ? [] : [posix.join(base, path)];
  });
}

function findProjects(root: string): { specs: string[]; bundles: string[] } {
  const isIgnored = createIgnoreMatcher(root);
  const specs: string[] = [];
  const bundles: string[] = [];
  const walk = (relDir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isFile() && entry.name === 'project.yml') specs.push(relPath);
      else if (entry.isDirectory() && !isIgnored(relPath, true)) {
        if (entry.name.endsWith('.xcodeproj')) bundles.push(relPath);
        else if (depth < MAX_DEPTH) walk(relPath, depth + 1);
      }
    }
  };
  walk('', 0);
  return { specs: specs.sort(), bundles: bundles.sort() };
}
