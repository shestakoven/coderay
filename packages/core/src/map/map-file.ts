import { createHash, randomUUID } from 'node:crypto';
import { statSync, type Stats } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord, parseJson } from '../json';

export const MAP_FILE = '.ide/map.json';
const RESERVED_ID_PREFIXES = ['ai:', 'folder:'];

export interface AiComponent {
  id: string;
  name: string;
  summary: string;
  description: string;
  keyFiles: string[];
  files: string[];
  globs: string[];
}

export interface ManualComponent {
  id: string;
  name: string;
  summary: string;
  description: string;
  files: string[];
  globs: string[];
}

export interface MapFileData {
  ai: AiComponent[] | null;
  groupedAt: string | null;
  manual: ManualComponent[];
  assignments: ReadonlyMap<string, string>;
  raw: Record<string, unknown>;
  warnings: string[];
  writable: boolean;
  hash: string | null;
}

export interface MapFileWrite {
  ai: AiComponent[];
  groupedAt: string;
  raw: Record<string, unknown>;
}

export interface MapFileWatch {
  stop(): void;
  check(): Promise<void>;
}

export const emptyMapFile = (): MapFileData => ({
  ai: null,
  groupedAt: null,
  manual: [],
  assignments: new Map(),
  raw: {},
  warnings: [],
  writable: true,
  hash: null,
});

export async function readMapFile(root: string): Promise<MapFileData> {
  let text: string;
  try {
    text = await readFile(join(root, MAP_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyMapFile();
    return unreadable(`${MAP_FILE} cannot be read (${(error as Error).message})`, null);
  }
  return parseMapFile(text);
}

export function parseMapFile(text: string): MapFileData {
  const hash = hashOf(text);
  const json = parseJson(text);
  if (json === undefined) return unreadable(`${MAP_FILE} is not valid JSON`, hash);
  if (!isRecord(json) || json.version !== 1) return unreadable(`${MAP_FILE} is not a version 1 map`, hash);

  const warnings: string[] = [];
  const manual: ManualComponent[] = [];
  (Array.isArray(json.manual) ? json.manual : []).forEach((entry: unknown, index: number) => {
    const component = toManual(entry);
    if (!component) {
      warnings.push(
        `${MAP_FILE}: manual[${index}] needs an "id" not starting with "ai:" or "folder:", a "name", and string lists for "files" and "globs"; it was ignored`,
      );
    } else if (manual.some((existing) => existing.id === component.id)) {
      warnings.push(`${MAP_FILE}: manual[${index}] repeats the id "${component.id}"; it was ignored`);
    } else {
      manual.push(component);
    }
  });
  const assignments = new Map<string, string>();
  for (const [path, id] of Object.entries(isRecord(json.assignments) ? json.assignments : {})) {
    if (typeof id === 'string' && id !== '') assignments.set(path, id);
    else warnings.push(`${MAP_FILE}: assignments["${path}"] must be a component id; it was ignored`);
  }
  const ai = (Array.isArray(json.components) ? json.components : []).flatMap((entry: unknown, index: number) => {
    const component = toAi(entry);
    if (!component) warnings.push(`${MAP_FILE}: components[${index}] is invalid; it was ignored`);
    return component ? [component] : [];
  });
  return {
    ai: ai.length > 0 ? ai : null,
    groupedAt: typeof json.groupedAt === 'string' ? json.groupedAt : null,
    manual,
    assignments,
    raw: json,
    warnings,
    writable: true,
    hash,
  };
}

export async function writeMapFile(root: string, data: MapFileWrite, expectedHash: string | null): Promise<MapFileData | 'conflict'> {
  const path = join(root, MAP_FILE);
  const json: Record<string, unknown> = { version: 1, groupedAt: null, components: [], manual: [], assignments: {}, ...data.raw };
  json.version = 1;
  json.groupedAt = data.groupedAt;
  json.components = data.ai.map(({ id, name, summary, description, keyFiles, files, globs }) => ({
    id,
    name,
    summary,
    description,
    keyFiles,
    files,
    globs,
  }));
  const text = `${JSON.stringify(json, null, 2)}\n`;
  await mkdir(join(root, '.ide'), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(temp, text);
    if ((await currentHash(path)) !== expectedHash) return 'conflict';
    await rename(temp, path);
    return parseMapFile(text);
  } finally {
    await rm(temp, { force: true });
  }
}

export function watchMapFile(root: string, onChange: () => void, intervalMs = 2000): MapFileWatch {
  const path = join(root, MAP_FILE);
  let last = signatureOf(statSync(path, { throwIfNoEntry: false }));
  let checking: Promise<void> | undefined;
  const check = (): Promise<void> => {
    checking ??= (async () => {
      const signature = signatureOf(await stat(path).catch(() => undefined));
      if (signature !== last) {
        last = signature;
        onChange();
      }
    })().finally(() => {
      checking = undefined;
    });
    return checking;
  };
  const timer = setInterval(() => void check(), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), check };
}

const signatureOf = (info: Stats | undefined): string =>
  info ? `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` : 'missing';

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

async function currentHash(path: string): Promise<string | null> {
  const text = await readFile(path, 'utf8').catch(() => null);
  return text === null ? null : hashOf(text);
}

function unreadable(problem: string, hash: string | null): MapFileData {
  return { ...emptyMapFile(), warnings: [`${problem}; the file is left untouched`], writable: false, hash };
}

function toManual(value: unknown): ManualComponent | null {
  if (!isRecord(value)) return null;
  const { id, name } = value;
  const files = optionalStrings(value.files);
  const globs = optionalStrings(value.globs);
  if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name === '' || !files || !globs) return null;
  if (RESERVED_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) return null;
  return { id, name, summary: text(value.summary), description: text(value.description), files, globs };
}

function toAi(value: unknown): AiComponent | null {
  if (!isRecord(value)) return null;
  const { id, name } = value;
  const files = optionalStrings(value.files);
  const keyFiles = optionalStrings(value.keyFiles);
  const globs = optionalStrings(value.globs);
  if (typeof id !== 'string' || !id.startsWith('ai:') || typeof name !== 'string' || name === '' || !files || !keyFiles || !globs) {
    return null;
  }
  return { id, name, summary: text(value.summary), description: text(value.description), keyFiles, files, globs };
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function optionalStrings(value: unknown): string[] | null {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}
