import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { RecentProject } from '@ide/protocol';
import { isRecord, parseJson } from '../json';

const MAX_RECENT = 12;
const PRIVATE_FILE_MODE = 0o600;

export class RecentProjects {
  private readonly file: string;

  constructor(ideHome: string) {
    this.file = join(ideHome, 'recent-projects.json');
  }

  list(): RecentProject[] {
    return this.read().filter((item) => isDirectory(item.path));
  }

  add(path: string): void {
    const rest = this.read().filter((item) => item.path !== path);
    this.write([{ path, name: basename(path), openedAt: Date.now() }, ...rest].slice(0, MAX_RECENT));
  }

  private read(): RecentProject[] {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const value = parseJson(text);
    if (!isRecord(value) || !Array.isArray(value.projects)) return [];
    const items: RecentProject[] = [];
    for (const item of value.projects) {
      if (isRecord(item) && typeof item.path === 'string' && typeof item.name === 'string' && typeof item.openedAt === 'number') {
        items.push({ path: item.path, name: item.name, openedAt: item.openedAt });
      }
    }
    return items.sort((a, b) => b.openedAt - a.openedAt);
  }

  private write(projects: RecentProject[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, projects }), { mode: PRIVATE_FILE_MODE });
    renameSync(temp, this.file);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
