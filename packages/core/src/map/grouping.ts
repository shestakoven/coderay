import type { FileEdge, GroupingPayload } from '@ide/protocol';
import { isRecord } from '../json';
import type { JsonSchema, StructuredModel } from '../models/types';
import { averageLinkageGroups } from './cluster';
import { compare, folderComponents } from './folder-components';
import type { AiComponent } from './map-file';
import { importTargets, isTestPath, testSubject } from './test-files';
import { centroid, dot } from './vectors';

export const MAX_AI_FILES = 10_000;
export const MAX_GROUPS = 500;
export const NAME_MAX = 40;
export const SUMMARY_MAX = 120;
export const DESCRIPTION_MAX = 600;
const PATH_MAX = 300;
const NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9 &/+.()'-]*$";
const MAX_CLUSTER_FILES = 1200;
const EDGE_BONUS = 0.1;
const PROMPT_FILE_LINES = 1500;
const PROMPT_LINK_LINES = 400;
const SYMBOLS_PER_FILE = 6;
const SAME_COMPONENT = 0.5;

export interface GroupingFile {
  path: string;
  symbols: string[];
}

export interface GroupingInput {
  projectName: string;
  files: GroupingFile[];
  vectors: ReadonlyMap<string, Float32Array>;
  edges: FileEdge[];
  previous: AiComponent[];
  reservedIds: string[];
}

export interface GroupingOptions {
  signal?: AbortSignal;
  onSend?: (payload: GroupingPayload) => void;
}

export class GroupingError extends Error {}

interface CandidateGroup {
  id: string;
  paths: string[];
}

interface Draft {
  name: string;
  summary: string;
  description: string;
  keyFiles: string[];
  files: string[];
}

export async function groupFiles(input: GroupingInput, model: StructuredModel, options: GroupingOptions = {}): Promise<AiComponent[]> {
  if (input.files.length === 0) return [];
  if (input.files.length > MAX_AI_FILES) {
    throw new GroupingError(`AI grouping is limited to ${MAX_AI_FILES} files; this project has ${input.files.length}`);
  }
  const groups = candidateGroups(input).map((paths, index) => ({ id: `g${index + 1}`, paths }));
  const { prompt, payload } = groupingPrompt(input, groups);
  const schema = groupingSchema(groups);
  options.onSend?.(payload);
  const signal = options.signal;
  let drafts = parseGrouping(await model.generate({ prompt, schema }, { signal }), groups, true);
  if (typeof drafts === 'string') {
    const retry = `${prompt}\n\nYour previous answer was rejected: ${drafts}. Answer again and follow every rule.`;
    drafts = parseGrouping(await model.generate({ prompt: retry, schema }, { signal }), groups, false);
  }
  if (typeof drafts === 'string') throw new GroupingError(`the model returned an invalid grouping: ${drafts}`);
  return withStableIds(attachTests(drafts, input.edges), input.previous, input.reservedIds);
}

function candidateGroups({ files, vectors, edges }: GroupingInput): string[][] {
  const folders = folderComponents(files.map((file) => file.path)).map((component) => component.files);
  const groupSize = Math.min(25, Math.max(4, Math.round(files.length / 30)));
  const groups = folders.flatMap((paths) => {
    if (paths.length <= groupSize) return [paths];
    const embedded = paths.filter((path) => vectors.has(path));
    const rest = paths.filter((path) => !vectors.has(path));
    const clustered = chunks(embedded, MAX_CLUSTER_FILES).flatMap((chunk) => clusterChunk(chunk, vectors, edges, groupSize));
    return rest.length > 0 ? [...clustered, rest] : clustered;
  });
  return capGroupCount(groups, groupSize);
}

function clusterChunk(paths: string[], vectors: ReadonlyMap<string, Float32Array>, edges: FileEdge[], groupSize: number): string[][] {
  const index = new Map(paths.map((path, i) => [path, i]));
  const links = edges.flatMap((edge): [number, number][] => {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    return from === undefined || to === undefined ? [] : [[from, to]];
  });
  const members = averageLinkageGroups(
    paths.map((path) => vectors.get(path)!),
    links,
    { targetGroups: Math.ceil(paths.length / groupSize), edgeBonus: EDGE_BONUS },
  );
  return members.map((group) => group.map((i) => paths[i]!));
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}

// Packs neighbouring small groups from the deepest shared directory up; as a last resort merges neighbours of any size.
function capGroupCount(groups: string[][], groupSize: number): string[][] {
  const dirsOf = (group: string[]) => group[0]!.split('/').slice(0, -1);
  let result = groups;
  for (let depth = Math.max(0, ...groups.map((group) => dirsOf(group).length)); result.length > MAX_GROUPS && depth >= 0; depth -= 1) {
    const packed: string[][] = [];
    let open: { key: string; files: string[] } | undefined;
    for (const group of [...result].sort((a, b) => compare(a[0]!, b[0]!))) {
      const key = group.length < groupSize ? dirsOf(group).slice(0, depth).join('/') : undefined;
      if (key !== undefined && open?.key === key && open.files.length + group.length <= groupSize) {
        open.files.push(...group);
        continue;
      }
      if (open) packed.push(open.files);
      open = key === undefined ? undefined : { key, files: [...group] };
      if (key === undefined) packed.push(group);
    }
    if (open) packed.push(open.files);
    result = packed;
  }
  if (result.length <= MAX_GROUPS) return result;
  const sorted = [...result].sort((a, b) => compare(a[0]!, b[0]!));
  const per = Math.ceil(sorted.length / MAX_GROUPS);
  return chunks(sorted, per).map((neighbours) => neighbours.flat());
}

function groupingPrompt(input: GroupingInput, groups: CandidateGroup[]): { prompt: string; payload: GroupingPayload } {
  const target = Math.min(20, Math.max(3, Math.round(Math.sqrt(input.files.length) * 1.2)));
  const symbols = new Map(input.files.map((file) => [file.path, file.symbols]));
  const previousOf = new Map(input.previous.flatMap((component) => component.files.map((path) => [path, component.name] as const)));
  const shown = Math.max(1, Math.floor(PROMPT_FILE_LINES / groups.length));
  const payload: GroupingPayload = { paths: 0, symbols: 0, links: 0 };
  const lines = [
    `You are organizing the source files of the project "${input.projectName}" into components for an architecture map. A developer reads the map to understand what each part of the code is responsible for.`,
    '',
    'The files were pre-clustered into candidate groups by folder, content similarity and imports. Compose components from these groups: every group belongs to exactly one component, and a component may take several groups.',
    '',
    'Answer with:',
    '- components: every component once, with its name, summary, description and keyFiles.',
    '- groups: for every group id listed below, the name of the component it belongs to.',
    '- moves: single files that clearly belong to another component than the rest of their group, as { file, component }. Usually empty.',
    '',
    'Rules:',
    `- Aim for ${Math.max(2, target - 3)} to ${target + 3} components.`,
    '- name: 1 to 3 words in Title Case, for example "Indexer" or "Map UI". Names must be unique.',
    '- summary: one line under 90 characters that says what the component is responsible for.',
    '- description: 2 to 4 sentences on its responsibilities, its main collaborators and its entry points.',
    '- keyFiles: 1 to 3 of its files that a reader should open first.',
    '- Put tests and test helpers in the component of the code they test; never create a separate component for tests.',
    '- Every name used in groups and moves must be a component in your components list, with its summary and description.',
    '- Write every name, summary and description in English.',
  ];
  if (input.previous.length > 0) {
    lines.push('', 'Previous components (keep a name when the component still fits):');
    lines.push(...input.previous.map((component) => `- ${component.name}: ${component.summary}`));
  }
  lines.push('', 'Candidate groups (exported symbols in brackets):');
  for (const group of groups) {
    const listed = representatives(group.paths, input.vectors, shown);
    const before = majority(group.paths.map((path) => previousOf.get(path)));
    const hint = before ? `, previously: ${before}` : '';
    lines.push(`${group.id} (${group.paths.length} ${group.paths.length === 1 ? 'file' : 'files'}${hint}):`);
    for (const path of listed) {
      const names = (symbols.get(path) ?? []).slice(0, SYMBOLS_PER_FILE);
      lines.push(`  ${path}${names.length > 0 ? ` [${names.join(', ')}]` : ''}`);
      payload.paths += 1;
      payload.symbols += names.length;
    }
    if (listed.length < group.paths.length) lines.push(`  … ${group.paths.length - listed.length} more`);
  }
  const links = groupLinks(groups, input.edges);
  payload.links = links.length;
  if (links.length > 0) lines.push('', 'Imports between groups (from -> to: count):', ...links);
  return { prompt: lines.join('\n'), payload };
}

function majority(names: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const name of names) if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  const [top] = [...counts].sort((a, b) => b[1] - a[1]);
  return top && top[1] > names.length / 2 ? top[0] : undefined;
}

function representatives(paths: string[], vectors: ReadonlyMap<string, Float32Array>, limit: number): string[] {
  if (paths.length <= limit) return paths;
  const scored = paths.map((path) => ({ path, vector: vectors.get(path) }));
  const center = scored.every((entry) => entry.vector) ? centroid(scored.map((entry) => entry.vector!)) : null;
  const ranked = center ? [...scored].sort((a, b) => dot(b.vector!, center) - dot(a.vector!, center)) : scored;
  return ranked
    .slice(0, limit)
    .map((entry) => entry.path)
    .sort();
}

function groupLinks(groups: CandidateGroup[], edges: FileEdge[]): string[] {
  const groupOf = new Map(groups.flatMap((group) => group.paths.map((path) => [path, group.id] as const)));
  const counts = new Map<string, number>();
  for (const edge of edges) {
    const from = groupOf.get(edge.from);
    const to = groupOf.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from} -> ${to}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, PROMPT_LINK_LINES)
    .map(([key, count]) => `${key}: ${count}`);
}

function groupingSchema(groups: CandidateGroup[]): JsonSchema {
  const name = { type: 'string', maxLength: NAME_MAX, pattern: NAME_PATTERN };
  const path = { type: 'string', maxLength: PATH_MAX };
  const ids = groups.map((group) => group.id);
  return {
    type: 'object',
    properties: {
      components: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name,
            summary: { type: 'string', maxLength: SUMMARY_MAX },
            description: { type: 'string', maxLength: DESCRIPTION_MAX },
            keyFiles: { type: 'array', maxItems: 3, items: path },
          },
          required: ['name', 'summary', 'description', 'keyFiles'],
          additionalProperties: false,
        },
      },
      groups: {
        type: 'object',
        properties: Object.fromEntries(ids.map((id) => [id, name])),
        required: ids,
        additionalProperties: false,
      },
      moves: {
        type: 'array',
        items: {
          type: 'object',
          properties: { file: path, component: name },
          required: ['file', 'component'],
          additionalProperties: false,
        },
      },
    },
    required: ['components', 'groups', 'moves'],
    additionalProperties: false,
  };
}

function parseGrouping(answer: unknown, groups: CandidateGroup[], strict: boolean): Draft[] | string {
  if (!isRecord(answer) || !Array.isArray(answer.components) || !isRecord(answer.groups)) {
    return 'the answer needs a "components" list and a "groups" object';
  }
  const assignment = answer.groups;
  const unassigned = groups.filter((group) => cleanName(assignment[group.id]) === '').map((group) => group.id);
  if (unassigned.length > 0) return `groups ${unassigned.join(', ')} have no component`;

  const drafts = new Map<string, Draft>();
  const described = new Set<string>();
  const draftFor = (name: string): Draft => {
    const key = name.toLowerCase();
    const existing = drafts.get(key);
    if (existing) return existing;
    const draft: Draft = { name, summary: '', description: '', keyFiles: [], files: [] };
    drafts.set(key, draft);
    return draft;
  };
  for (const raw of answer.components as unknown[]) {
    const name = isRecord(raw) ? cleanName(raw.name) : '';
    if (!isRecord(raw) || name === '') continue;
    const draft = draftFor(name);
    described.add(name.toLowerCase());
    draft.summary ||= clean(raw.summary, SUMMARY_MAX);
    draft.description ||= clean(raw.description, DESCRIPTION_MAX);
    draft.keyFiles.push(...stringList(raw.keyFiles));
  }
  const ownerOf = new Map<string, Draft>();
  for (const group of groups) {
    const draft = draftFor(cleanName(assignment[group.id]));
    for (const path of group.paths) ownerOf.set(path, draft);
  }
  for (const move of Array.isArray(answer.moves) ? (answer.moves as unknown[]) : []) {
    const file = isRecord(move) && typeof move.file === 'string' ? move.file : '';
    const target = isRecord(move) ? cleanName(move.component) : '';
    if (ownerOf.has(file) && target !== '') ownerOf.set(file, draftFor(target));
  }
  for (const [path, draft] of ownerOf) draft.files.push(path);
  const undescribed = [...drafts].filter(([key, draft]) => !described.has(key) && draft.files.length > 0);
  if (strict && undescribed.length > 0) {
    const names = undescribed.map(([, draft]) => `"${draft.name}"`).join(', ');
    return `these names are used in "groups" or "moves" but not described in "components": ${names}`;
  }
  return [...drafts.values()].filter((draft) => draft.files.length > 0);
}

function attachTests(drafts: Draft[], edges: FileEdge[]): Draft[] {
  const owner = new Map(drafts.flatMap((draft, index) => draft.files.map((path) => [path, String(index)] as const)));
  const targets = importTargets(edges);
  const moves = [...owner].flatMap(([path, index]) => {
    const subject = isTestPath(path) ? testSubject(path, targets.get(path) ?? [], owner) : null;
    return subject !== null && subject !== index ? [[path, Number(subject)] as const] : [];
  });
  const moved = new Set(moves.map(([path]) => path));
  const result = drafts.map((draft) => ({ ...draft, files: draft.files.filter((path) => !moved.has(path)) }));
  for (const [path, index] of moves) result[index]!.files.push(path);
  return result.filter((draft) => draft.files.length > 0);
}

function withStableIds(drafts: Draft[], previous: AiComponent[], reservedIds: string[]): AiComponent[] {
  const pairs = drafts.flatMap((draft, index) =>
    previous.flatMap((old) => {
      const before = new Set(old.files);
      const shared = draft.files.filter((path) => before.has(path)).length;
      const jaccard = shared / (draft.files.length + old.files.length - shared);
      return shared > 0 && jaccard >= SAME_COMPONENT ? [{ index, id: old.id, jaccard, shared }] : [];
    }),
  );
  pairs.sort((a, b) => b.jaccard - a.jaccard || b.shared - a.shared || a.index - b.index || compare(a.id, b.id));
  const kept = new Map<number, string>();
  const used = new Set<string>();
  for (const pair of pairs) {
    if (kept.has(pair.index) || used.has(pair.id)) continue;
    kept.set(pair.index, pair.id);
    used.add(pair.id);
  }
  for (const id of [...new Set(reservedIds)].sort()) {
    const old = previous.find((component) => component.id === id);
    if (!old || used.has(id)) continue;
    const before = new Set(old.files);
    const overlaps = drafts.map((draft, index) => (kept.has(index) ? 0 : draft.files.filter((path) => before.has(path)).length));
    const index = overlaps.indexOf(Math.max(...overlaps));
    if ((overlaps[index] ?? 0) === 0) continue;
    kept.set(index, id);
    used.add(id);
  }
  const taken = new Set([...previous.map((old) => old.id), ...reservedIds, ...used]);
  return drafts.map((draft, index) => {
    const files = [...draft.files].sort();
    return {
      id: kept.get(index) ?? uniqueId(`ai:${slug(draft.name)}`, taken),
      name: draft.name,
      summary: draft.summary,
      description: draft.description,
      keyFiles: [...new Set(draft.keyFiles)].filter((path) => files.includes(path)).slice(0, 3),
      files,
      globs: [],
    };
  });
}

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

const cleanName = (value: unknown): string =>
  clean(value, NAME_MAX)
    .replace(/[^A-Za-z0-9 &/+.()'-]/g, '')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'component';

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}
