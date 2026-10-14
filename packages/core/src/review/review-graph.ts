import { posix } from 'node:path';
import type {
  FileEdge, ReviewEvidence, ReviewGraph, ReviewGraphFile, ReviewLink, ReviewLinkState, ReviewPart, ReviewPartFile, ReviewPartStatus,
} from '@ide/protocol';
import { computeFileEdges } from '../graph/edges';
import type { LanguageAdapter } from '../lang/types';
import type { IndexedFile } from '../model';

export const MAX_PARTS = 40;
export const UNASSIGNED = 'unassigned';
const MAX_EVIDENCE = 3;
const EVIDENCE_TEXT = 160;
const STATUS_ORDER: Record<ReviewPartStatus, number> = { created: 0, modified: 1, deleted: 2, missing: 3, untouched: 4 };
const FLAGGED = new Set<ReviewLinkState>(['unplanned', 'missing', 'broken', 'removed']);
const UNREAD_SOURCE = /\.(go|rs|java|kt|kts|rb|php|scala|lua|dart|ex|exs)$/i;

export interface PlanRef {
  targets: { step: string; componentId?: string; path?: string }[];
  flow: { nodes: { id: string; files: string[] }[]; edges: { from: string; to: string; state: string }[] } | null;
}

export interface ReviewGraphInput {
  changed: ReviewGraphFile[];
  current: IndexedFile[];
  components: { id: string; name: string; files: string[] }[];
  adapters: LanguageAdapter[];
  plan: PlanRef | null;
  readBefore: (path: string) => Promise<string | null>;
  readNow: (path: string) => Promise<string | null>;
}

const opOf = (file: ReviewGraphFile): '+' | '~' | '-' => (file.before === null ? '+' : file.after === null ? '-' : '~');

function statusOf(files: ReviewPartFile[]): ReviewPartStatus {
  if (files.every((file) => file.op === '+')) return 'created';
  if (files.every((file) => file.op === '-')) return 'deleted';
  return 'modified';
}

// A deleted file is no longer in the map: it goes to the part that alone holds files of the deepest directory it shares.
function nearest(path: string, owner: ReadonlyMap<string, string>): string {
  const dir = posix.dirname(path);
  const segments = dir === '.' ? [] : dir.split('/');
  for (let depth = segments.length; depth > 0; depth -= 1) {
    const prefix = `${segments.slice(0, depth).join('/')}/`;
    const owners = new Set<string>();
    for (const [file, id] of owner) if (file.startsWith(prefix)) owners.add(id);
    if (owners.size > 0) return owners.size === 1 ? [...owners][0]! : UNASSIGNED;
  }
  return UNASSIGNED;
}

// `from pkg import module` never spells the specifier `pkg.module`: fall back to the parent and the last name as a word.
function lineOf(lines: string[], specifier: string): number {
  const direct = lines.findIndex((line) => line.includes(specifier));
  if (direct >= 0) return direct;
  const dots = specifier.length - specifier.replace(/^\.+/, '').length;
  const rest = specifier.slice(dots);
  const cut = rest.lastIndexOf('.');
  const parent = cut < 0 ? specifier.slice(0, dots) : specifier.slice(0, dots + cut);
  const name = cut < 0 ? rest : rest.slice(cut + 1);
  if (parent === '' || name === '') return -1;
  const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return lines.findIndex((line) => line.includes(parent) && word.test(line));
}

const under = (file: string, target: string): boolean => file === target || file.startsWith(target.endsWith('/') ? target : `${target}/`);

function lift(edges: FileEdge[], partOf: (path: string) => string): Map<string, FileEdge[]> {
  const links = new Map<string, FileEdge[]>();
  for (const edge of edges) {
    const from = partOf(edge.from);
    const to = partOf(edge.to);
    if (from === to) continue;
    const key = `${from}\0${to}`;
    links.set(key, [...(links.get(key) ?? []), edge]);
  }
  return links;
}

export async function buildReviewGraph(input: ReviewGraphInput): Promise<ReviewGraph> {
  const { changed, current, components, adapters, plan } = input;
  const byPath = new Map(changed.map((file) => [file.path, file]));
  const gone = changed.filter((file) => file.after === null).map((file) => file.path);
  const goneSet = new Set(gone);
  const adapterOf = (path: string): LanguageAdapter | undefined => adapters.find((adapter) => adapter.handles(path));
  const unparsed = new Set<string>();
  let unread = 0;

  async function asItWas(path: string, base: IndexedFile | null): Promise<IndexedFile | null> {
    const adapter = adapterOf(path);
    if (adapter === undefined) return base;
    const source = await input.readBefore(path);
    if (source === null) {
      unread += 1;
      return base;
    }
    const parsed = adapter.parse(path, source);
    if (parsed.parseError) unparsed.add(path);
    return { path, lang: adapter.lang, contentHash: base?.contentHash ?? path, imports: parsed.imports, symbols: parsed.symbols, parseError: parsed.parseError, provides: parsed.provides };
  }

  const before: IndexedFile[] = [];
  for (const file of current) {
    const touched = byPath.get(file.path);
    if (touched === undefined) before.push(file);
    else if (touched.before !== null) {
      const restored = await asItWas(file.path, file);
      if (restored !== null) before.push(restored);
    }
  }
  for (const path of gone) {
    const restored = await asItWas(path, null);
    if (restored !== null) before.push(restored);
  }

  for (const file of current) if (byPath.has(file.path) && file.parseError) unparsed.add(file.path);
  const drawn = (edge: FileEdge): boolean => !unparsed.has(edge.from);
  const nowEdges = computeFileEdges(current, adapters, gone).filter(drawn);
  const beforeEdges = computeFileEdges(before, adapters).filter(drawn);
  const owner = new Map(components.flatMap((component) => component.files.map((path) => [path, component.id] as const)));
  const placed = new Map<string, string>();
  const partOf = (path: string): string => {
    let id = placed.get(path);
    if (id === undefined) {
      id = owner.get(path) ?? (goneSet.has(path) ? nearest(path, owner) : UNASSIGNED);
      placed.set(path, id);
    }
    return id;
  };
  const nowLinks = lift(nowEdges, partOf);
  const beforeLinks = lift(beforeEdges, partOf);
  const titleOf = (id: string): string => components.find((component) => component.id === id)?.name ?? (id === UNASSIGNED ? 'Unassigned files' : id);

  const grouped = new Map<string, ReviewPartFile[]>();
  for (const file of changed) {
    const id = partOf(file.path);
    const entry: ReviewPartFile = { path: file.path, op: opOf(file), added: file.added, removed: file.removed, step: file.step, external: file.external };
    grouped.set(id, [...(grouped.get(id) ?? []), entry]);
  }

  const stepsOf = (id: string, files: ReviewPartFile[]): string[] => {
    if (plan === null) return [];
    const own = [...(components.find((component) => component.id === id)?.files ?? []), ...files.map((file) => file.path)];
    return [...new Set(plan.targets
      .filter((target) => target.componentId === id || (target.path !== undefined && own.some((path) => under(path, target.path!))))
      .map((target) => target.step))];
  };

  const parts = new Map<string, ReviewPart>();
  for (const [id, files] of grouped) {
    parts.set(id, {
      id, title: titleOf(id), status: statusOf(files), steps: stepsOf(id, files),
      outside: plan !== null && files.every((file) => file.step === null && !file.external), files, broken: [],
    });
  }
  const addContext = (id: string): void => {
    if (!parts.has(id)) parts.set(id, { id, title: titleOf(id), status: 'untouched', steps: stepsOf(id, []), outside: false, files: [], broken: [] });
  };
  if (plan !== null) {
    for (const target of plan.targets) {
      const ids = target.componentId !== undefined
        ? components.filter((component) => component.id === target.componentId).map((component) => component.id)
        : components.filter((component) => component.files.some((path) => under(path, target.path ?? ''))).map((component) => component.id);
      for (const id of ids) {
        if (parts.has(id)) continue;
        parts.set(id, { id, title: titleOf(id), status: 'missing', steps: stepsOf(id, []), outside: false, files: [], broken: [] });
      }
    }
  }

  // Links are kept when one end changed or is missing; the context parts added below must not let two unchanged parts in.
  const core = new Set(parts.keys());
  const nowByPath = new Map(current.map((file) => [file.path, file]));
  const beforeByPath = new Map(before.map((file) => [file.path, file]));
  const nowPaths = new Set([...nowByPath.keys(), ...gone]);
  const beforePaths = new Set(beforeByPath.keys());

  async function evidenceOf(edge: FileEdge, side: 'now' | 'before'): Promise<ReviewEvidence | null> {
    const importer = (side === 'now' ? nowByPath : beforeByPath).get(edge.from);
    const adapter = importer === undefined ? undefined : adapterOf(importer.path);
    if (importer === undefined || adapter === undefined || adapter.resolveAll !== undefined) return null;
    const live = side === 'now' ? nowByPath : beforeByPath;
    const known = side === 'now' ? nowPaths : beforePaths;
    const resolves = (candidate: string): string | null =>
      adapter.resolve(importer.path, candidate, (path) => live.has(path)) ?? adapter.resolve(importer.path, candidate, (path) => known.has(path));
    const specifier = importer.imports.find((candidate) => resolves(candidate) === edge.to);
    if (specifier === undefined) return null;
    const source = side === 'before' && byPath.has(edge.from) ? await input.readBefore(edge.from) : await input.readNow(edge.from);
    if (source === null) return null;
    const lines = source.split('\n');
    const at = lineOf(lines, specifier);
    return at < 0 ? null : { path: edge.from, line: at + 1, text: lines[at]!.trim().slice(0, EVIDENCE_TEXT) };
  }
  const evidenceFor = async (edges: FileEdge[], side: 'now' | 'before'): Promise<ReviewEvidence[]> =>
    (await Promise.all(edges.slice(0, MAX_EVIDENCE).map((edge) => evidenceOf(edge, side)))).filter((item): item is ReviewEvidence => item !== null);

  const links: ReviewLink[] = [];
  for (const key of new Set([...beforeLinks.keys(), ...nowLinks.keys()])) {
    const [from, to] = key.split('\0') as [string, string];
    if (!core.has(from) && !core.has(to)) continue;
    const now = nowLinks.get(key);
    const was = beforeLinks.get(key);
    let state: ReviewLinkState;
    if (now?.some((edge) => goneSet.has(edge.to))) state = 'broken';
    else if (now !== undefined && was !== undefined) state = 'existing';
    else if (now !== undefined) state = plan !== null && (parts.get(from)?.outside === true || parts.get(to)?.outside === true) ? 'unplanned' : 'new';
    else state = 'removed';
    const edges = (state === 'removed' ? was : now)!;
    const evidence = state === 'existing' ? [] : await evidenceFor(state === 'broken' ? edges.filter((edge) => goneSet.has(edge.to)) : edges, state === 'removed' ? 'before' : 'now');
    links.push({ from, to, state, count: edges.length, evidence });
    addContext(from);
    addContext(to);
  }

  for (const edge of nowEdges.filter((candidate) => goneSet.has(candidate.to) && partOf(candidate.from) === partOf(candidate.to))) {
    const part = parts.get(partOf(edge.from));
    const evidence = await evidenceOf(edge, 'now');
    if (part !== undefined && evidence !== null) part.broken.push(evidence);
  }

  if (plan?.flow) {
    const partOfNode = (node: { files: string[] }): string | undefined => {
      for (const path of node.files) {
        const id = owner.get(path) ?? (byPath.has(path) ? partOf(path) : undefined);
        if (id !== undefined) return id;
      }
      return undefined;
    };
    const ends = new Map(plan.flow.nodes.map((node) => [node.id, partOfNode(node)]));
    for (const edge of plan.flow.edges) {
      if (edge.state !== 'new') continue;
      const from = ends.get(edge.from);
      const to = ends.get(edge.to);
      if (from === undefined || to === undefined || from === to) continue;
      if (nowLinks.has(`${from}\0${to}`) || links.some((link) => link.from === from && link.to === to)) continue;
      if (!core.has(from) && !core.has(to)) continue;
      links.push({ from, to, state: 'missing', count: 0, evidence: [] });
      addContext(from);
      addContext(to);
    }
  }

  const notes: string[] = [];
  if (components.length === 0) notes.push('The project map has no components yet, so every change is one part.');
  if (unread > 0) notes.push(`${unread} ${unread === 1 ? 'file' : 'files'} could not be read as ${unread === 1 ? 'it' : 'they'} were before the change, so links through ${unread === 1 ? 'it' : 'them'} may be missing.`);
  if (unparsed.size > 0) {
    notes.push(`${unparsed.size} changed ${unparsed.size === 1 ? 'file' : 'files'} could not be parsed, so no links are drawn from ${unparsed.size === 1 ? 'it' : 'them'}.`);
  }
  if (changed.some((file) => adapterOf(file.path)?.resolveAll !== undefined)) {
    notes.push('Links through C# and Swift namespace imports point at every file that declares the namespace and carry no line.');
  }
  const unsupported = changed.filter((file) => UNREAD_SOURCE.test(file.path) && adapterOf(file.path) === undefined).length;
  if (unsupported > 0) {
    notes.push(`${unsupported} changed ${unsupported === 1 ? 'file is' : 'files are'} in a language the map does not read, so ${unsupported === 1 ? 'its' : 'their'} links are not drawn.`);
  }

  let kept = [...parts.values()];
  if (kept.length > MAX_PARTS) {
    const flagged = new Set(links.filter((link) => FLAGGED.has(link.state)).flatMap((link) => [link.from, link.to]));
    const degree = (id: string): number => links.filter((link) => link.from === id || link.to === id).length;
    const rank = (part: ReviewPart): number => (part.status !== 'untouched' ? 0 : flagged.has(part.id) ? 1 : 2);
    kept.sort((a, b) => rank(a) - rank(b) || degree(b.id) - degree(a.id) || a.id.localeCompare(b.id));
    const left = kept.length - MAX_PARTS;
    kept = kept.slice(0, MAX_PARTS);
    notes.push(`${left} ${left === 1 ? 'part' : 'parts'} left out; the review touches more than ${MAX_PARTS}.`);
  }
  const ids = new Set(kept.map((part) => part.id));
  kept.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.title.localeCompare(b.title));
  return { parts: kept, links: links.filter((link) => ids.has(link.from) && ids.has(link.to)), partial: notes.length > 0 ? notes.join(' ') : null };
}
