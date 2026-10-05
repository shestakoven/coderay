import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { isRecord, parseJson } from '../json';

export interface OpenProjects {
  roots: string[];
  activeRoot: string | null;
}

const PRIVATE_FILE_MODE = 0o600;

export const openProjectsFile = (home: string): string => join(home, 'open-projects.json');

export function parseOpenProjects(text: string): OpenProjects {
  const value = parseJson(text);
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.roots)) return { roots: [], activeRoot: null };
  const roots = [...new Set(value.roots.filter((root): root is string => typeof root === 'string' && isAbsolute(root)))];
  const activeRoot = typeof value.activeRoot === 'string' && roots.includes(value.activeRoot) ? value.activeRoot : null;
  return { roots, activeRoot };
}

export function serializeOpenProjects({ roots, activeRoot }: OpenProjects): string {
  return `${JSON.stringify({ version: 1, roots, activeRoot }, null, 2)}\n`;
}

export function readOpenProjects(home: string): OpenProjects {
  try {
    return parseOpenProjects(readFileSync(openProjectsFile(home), 'utf8'));
  } catch {
    return { roots: [], activeRoot: null };
  }
}

export function writeOpenProjects(home: string, text: string): void {
  const file = openProjectsFile(home);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: PRIVATE_FILE_MODE });
  renameSync(temp, file);
}
