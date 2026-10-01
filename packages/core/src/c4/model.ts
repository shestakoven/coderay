import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type {
  C4Container,
  C4Evidence,
  C4External,
  C4Link,
  C4Model,
  ContainerRole,
  ExternalKind,
  FileEdge,
  MapComponent,
} from '@ide/protocol';
import type { IndexedFile } from '../model';
import { identifierKey, type Classification, type Classify, type Identifier } from './classify';
import { readDeploy, type ServiceDef } from './deploy';

// Literal URL hosts are names like package names; file contents never leave this process.
const URL_LITERAL = /['"`]https?:\/\/(?:[^\s'"`@/]*@)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi;
// A URL on a line that reaches for the network is a call; one named like a link for a person (docs, homepage,
// href) is a reference. Anything else stays a call: a bare API_BASE constant is how most clients are configured.
const NETWORK_CONTEXT = new RegExp(
  [
    String.raw`\b(?:fetch|axios|requests?|httpx|aiohttp|urllib3?|urlopen|got|ky|superagent|XMLHttpRequest|WebSocket|EventSource|sendBeacon|curl|wget)\b`,
    String.raw`\bnew\s+URL\b`,
    String.raw`\.(?:get|post|put|patch|delete|head|options|request|stream|connect|dial)\s*\(\s*$`,
    String.raw`\b(?:base_?url|api_?(?:url|base|host|endpoint)|endpoint|dsn|server_?url|webhook_?url)\b`,
  ].join('|'),
  'i',
);
const REFERENCE_WORDS = ['link', 'href', 'docs', 'doc', 'documentation', 'homepage', 'website', 'help', 'terms', 'privacy', 'license', 'readme', 'logo', 'icon', 'avatar'];
const REFERENCE_CONTEXT = new RegExp(
  REFERENCE_WORDS.flatMap((w) => {
    const cap = w[0]!.toUpperCase() + w.slice(1);
    return [`(?<![A-Za-z])${w}(?![a-z])`, `${cap}(?![a-z])`, `(?<![A-Z])${w.toUpperCase()}(?![A-Z])`];
  }).join('|'),
);

export function isNetworkCall(text: string, index: number): boolean {
  const line = text.slice(text.lastIndexOf('\n', index - 1) + 1, index);
  if (NETWORK_CONTEXT.test(line)) return true;
  return !REFERENCE_CONTEXT.test(line);
}

const literalHosts = new Map<string, { hash: string; hosts: string[] }>();

function hostsIn(root: string, file: IndexedFile): string[] {
  const cached = literalHosts.get(file.path);
  if (cached?.hash === file.contentHash) return cached.hosts;
  let hosts: string[] = [];
  try {
    const text = readFileSync(join(root, file.path), 'utf8');
    hosts = [...new Set([...text.matchAll(URL_LITERAL)].filter((m) => isNetworkCall(text, m.index)).map((m) => m[1]!.toLowerCase()))];
  } catch {
    hosts = [];
  }
  literalHosts.set(file.path, { hash: file.contentHash, hosts });
  return hosts;
}

const SCHEME_PROTOCOL: Record<string, string> = {
  http: 'HTTP',
  https: 'HTTPS',
  ws: 'WebSocket',
  wss: 'WebSocket',
  postgres: 'SQL',
  postgresql: 'SQL',
  nats: 'NATS',
  redis: 'Redis',
  amqp: 'AMQP',
  s3: 'S3',
};

const KIND_PROTOCOL: Record<ExternalKind, string> = {
  database: 'SQL',
  broker: 'messages',
  storage: 'S3',
  ai: 'LLM API',
  search: 'HTTP',
  documents: 'HTTP',
  email: 'SMTP',
  cache: 'Redis',
  ml: 'HTTP',
  source: 'API',
  other: 'uses',
};

const NEAR_DEPTH = 2;
const TOOLING_NAME = /(^|[-_])(test|tests|e2e|lint|migrate|migrations?)([-_]|$)/;
const RUNNERS = new Set(['uvicorn', 'gunicorn', 'hypercorn', 'celery', 'pytest', 'alembic', 'pip']);

interface Entry {
  role: ContainerRole;
  tech: string;
  modules: string[];
  paths: string[];
  devServer: boolean;
}

export interface C4Build {
  model: C4Model;
  pending: Identifier[];
}

export function buildC4(
  root: string,
  files: IndexedFile[],
  edges: FileEdge[],
  components: MapComponent[],
  unresolved: ReadonlyMap<string, string[]>,
  classify: Classify,
): C4Build {
  const deploy = readDeploy(root);
  const warnings = [...deploy.warnings];
  const paths = files.map((f) => f.path);
  const owner = new Map(components.flatMap((c) => c.files.map((path) => [path, c.id] as const)));
  const out = new Map<string, string[]>();
  for (const edge of edges) out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
  const hasSources = (dir: string) => paths.some((p) => dir === '' || p.startsWith(`${dir}/`));

  const containers: C4Container[] = [];
  const closures = new Map<string, Set<string>>();
  const depths = new Map<string, Map<string, number>>();
  const serviceImage = new Map<string, Identifier>();
  const tooling: string[] = [];
  const externals = new Map<string, C4External>();
  const generic = new Set<string>();
  const serviceBacked = new Set<string>();
  const protocols = new Map<string, string>();
  const pending = new Map<string, Identifier>();
  const lookup = (id: Identifier): Classification | null => {
    const found = classify(id);
    if (found === undefined) pending.set(identifierKey(id), id);
    return found ?? null;
  };
  const addExternal = (found: Classification, identifier: string): string => {
    const id = `ext:${slug(found.system)}`;
    const existing = externals.get(id) ?? { id, name: found.system, kind: found.kind, identifiers: [] };
    if (!existing.identifiers.includes(identifier)) existing.identifiers.push(identifier);
    externals.set(id, existing);
    if (found.generic) generic.add(id);
    if (found.protocol && !protocols.has(id)) protocols.set(id, found.protocol);
    return id;
  };

  for (const [name, defs] of deploy.services) {
    const repoCode = defs.some((d) => d.build !== null) || defs.some((d) => d.mounts.some((m) => hasSources(m) && d.commands.length > 0));
    const commands = defs.flatMap((d) => d.commands);
    if (repoCode && (TOOLING_NAME.test(name) || commands.some((c) => /\b(pytest|vitest|jest)\b/.test(c)))) {
      tooling.push(name);
      continue;
    }
    if (!repoCode) {
      const image = (defs.find((d) => d.image)?.image ?? name).split('@')[0]!.replace(/:[\w.-]+$/, '');
      serviceImage.set(name, { type: 'image', ecosystem: 'docker', name: image, hint: `compose service "${name}"` });
      continue;
    }
    const entry = detectEntry(commands);
    const entryFiles = new Set<string>();
    const entryMissing: string[] = [];
    const scope = defs.flatMap((d) => [d.build?.context ?? '', ...d.mounts]).filter((dir) => dir !== '');
    for (const module of entry.modules) {
      const hit = resolveModule(module, paths, scope);
      if (hit) entryFiles.add(hit);
      else entryMissing.push(module);
    }
    for (const path of entry.paths) {
      const hit = paths.find((p) => p === path || p.endsWith(`/${path.replace(/^\.\//, '')}`));
      if (hit) entryFiles.add(hit);
      else entryMissing.push(path);
    }
    const closure = new Set<string>();
    if (entry.devServer) {
      for (const dir of defs.flatMap((d) => d.mounts).filter((m) => m !== '' && hasSources(m))) {
        for (const p of paths) if (p.startsWith(`${dir}/`)) closure.add(p);
      }
    }
    const depth = new Map<string, number>([...entryFiles].map((p) => [p, 0]));
    const queue = [...entryFiles];
    for (let i = 0; i < queue.length; i += 1) {
      const path = queue[i]!;
      closure.add(path);
      for (const next of out.get(path) ?? []) {
        if (depth.has(next)) continue;
        depth.set(next, depth.get(path)! + 1);
        queue.push(next);
      }
    }
    depths.set(name, depth);
    if (entry.devServer) for (const path of closure) if (!depth.has(path)) depth.set(path, 0);
    if (entryMissing.length > 0) warnings.push(`${name}: entry not found: ${entryMissing.join(', ')}`);
    closures.set(name, closure);
    const def = defs[0]!;
    containers.push({
      id: `container:${name}`,
      name,
      role: entry.role,
      tech: entry.tech,
      launch: [...new Set(commands.flatMap(launchLines))],
      entryFiles: [...entryFiles],
      entryMissing,
      files: closure.size,
      components: [],
      componentLinks: [],
      group: null,
      evidence: [
        ...[...new Set(defs.map((d) => d.file))].map((file) => ({ path: file, note: `service ${name}` })),
        ...(def.build ? [{ path: posix.join(def.build.context, def.build.dockerfile), note: `build${def.build.target ? ` target ${def.build.target}` : ''}` }] : []),
      ],
    });
  }

  const reach = new Map<string, number>();
  for (const container of containers) {
    const counts = new Map<string, number>();
    const near = new Map<string, number>();
    const depth = depths.get(container.name);
    for (const path of closures.get(container.name) ?? []) {
      const id = owner.get(path) ?? 'unassigned';
      counts.set(id, (counts.get(id) ?? 0) + 1);
      if ((depth?.get(path) ?? 99) <= NEAR_DEPTH) near.set(id, (near.get(id) ?? 0) + 1);
    }
    container.components = [...counts].map(([id, count]) => ({ id, files: count, near: near.get(id) ?? 0, containers: 0 }));
    const closure = closures.get(container.name) ?? new Set<string>();
    const between = new Map<string, number>();
    for (const from of closure) {
      for (const to of out.get(from) ?? []) {
        const a = owner.get(from) ?? 'unassigned';
        const b = owner.get(to) ?? 'unassigned';
        if (a === b || !closure.has(to)) continue;
        between.set(`${a}\0${b}`, (between.get(`${a}\0${b}`) ?? 0) + 1);
      }
    }
    container.componentLinks = [...between].map(([key, count]) => {
      const [from, to] = key.split('\0') as [string, string];
      return { from, to, count };
    });
    for (const id of counts.keys()) reach.set(id, (reach.get(id) ?? 0) + 1);
  }
  for (const container of containers) {
    for (const component of container.components) component.containers = reach.get(component.id) ?? 0;
    container.components.sort((a, b) => b.near - a.near || a.containers - b.containers || b.files - a.files);
  }

  const links = new Map<string, C4Link>();
  const link = (from: string, to: string, protocol: string, evidence: C4Evidence): void => {
    if (from === to) return;
    const id = `${from}->${to}`;
    const existing = links.get(id) ?? { id, from, to, protocol, strength: 0, evidence: [] };
    if (existing.evidence.some((e) => e.path === evidence.path && e.note === evidence.note)) return;
    existing.strength += 1;
    if (existing.evidence.length < 500) existing.evidence.push(evidence);
    if (existing.protocol === 'uses' || existing.protocol === 'messages') existing.protocol = protocol;
    links.set(id, existing);
  };

  const byFile = new Map(files.map((f) => [f.path, f]));
  const codeContainers = containers.filter((c) => c.files > 0).length;
  const fileReach = new Map<string, number>();
  for (const closure of closures.values()) for (const path of closure) fileReach.set(path, (fileReach.get(path) ?? 0) + 1);
  const containerNames = new Set(containers.map((c) => c.name));
  for (const container of containers) {
    for (const path of closures.get(container.name) ?? []) {
      const ecosystem = byFile.get(path)?.lang === 'python' ? 'python' : 'npm';
      for (const specifier of unresolved.get(path) ?? []) {
        const name = packageOf(specifier);
        if (!name) continue;
        const found = lookup({ type: 'package', ecosystem, name });
        if (!found) continue;
        const to = addExternal(found, name);
        link(container.id, to, protocolOf(to, externals, protocols), { path, note: `imports ${name}` });
      }
      const file = byFile.get(path);
      // A URL in a module every container loads (settings) is configuration, not a call.
      const everywhere = codeContainers > 2 && (fileReach.get(path) ?? 0) >= codeContainers;
      const test = /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]*\.py$|\.(test|spec)\.[jt]sx?$/.test(path);
      for (const host of file && !everywhere && !test ? hostsIn(root, file).filter(isPublicHost) : []) {
        const found = lookup({ type: 'host', ecosystem: 'url', name: host });
        if (!found) continue;
        const to = addExternal(found, host);
        link(container.id, to, protocolOf(to, externals, protocols), { path, note: `calls ${host}` });
      }
    }
    for (const def of deploy.services.get(container.name) ?? []) {
      for (const [key, value] of def.env) {
        const target = hostOf(key, value, deploy.services);
        if (!target) continue;
        const note = `${key} in ${def.file}`;
        if (containerNames.has(target.host)) {
          link(container.id, `container:${target.host}`, SCHEME_PROTOCOL[target.scheme] ?? 'HTTP', { path: def.file, note });
        } else if (serviceImage.has(target.host)) {
          const image = serviceImage.get(target.host)!;
          const found = lookup(image) ?? { system: image.name.split('/').at(-1)!, kind: 'other' as const, generic: false, protocol: '' };
          const to = addExternal(found, `service ${target.host}`);
          addExternal(found, `image ${image.name}`);
          serviceBacked.add(to);
          link(container.id, to, SCHEME_PROTOCOL[target.scheme] ?? protocolOf(to, externals, protocols), { path: def.file, note });
        }
      }
    }
  }
  const behindUi = new Set(
    [...links.values()].filter((l) => containers.some((c) => c.id === l.from && c.role === 'ui')).map((l) => l.to),
  );
  const entrances = containers.filter(
    (c) => c.role === 'ui' && !behindUi.has(c.id) && deploy.services.get(c.name)?.some((d) => d.ports),
  );
  const fromUsers = entrances.length > 0 ? entrances : containers.filter((c) => c.role === 'ui');
  for (const container of fromUsers) {
    link('users', container.id, 'HTTPS', { path: container.evidence[0]?.path ?? '', note: 'published port' });
  }

  const byBuild = new Map<string, C4Container[]>();
  for (const container of containers.filter((c) => c.role === 'worker')) {
    const def = deploy.services.get(container.name)?.find((d) => d.build);
    const key = def?.build ? `${def.build.context}|${def.build.dockerfile}` : container.name;
    byBuild.set(key, [...(byBuild.get(key) ?? []), container]);
  }
  for (const [key, members] of byBuild) {
    if (members.length < 3) continue;
    for (const member of members) member.group = `group:${key}`;
  }

  const merged = mergeGeneric(externals, generic, serviceBacked, [...links.values()]);
  return {
    model: { containers, externals: merged.externals, links: merged.links, tooling, warnings },
    pending: [...pending.values()],
  };
}

// A generic client ("SQL database" from sqlalchemy) belongs to the one specific system of its kind: the one the
// project runs as a compose service if there is exactly one, else the only one there is.
function mergeGeneric(
  externals: Map<string, C4External>,
  generic: Set<string>,
  serviceBacked: Set<string>,
  links: C4Link[],
): { externals: C4External[]; links: C4Link[] } {
  const into = new Map<string, string>();
  for (const id of generic) {
    const kind = externals.get(id)!.kind;
    const specific = [...externals.values()].filter((e) => e.kind === kind && !generic.has(e.id));
    const backed = specific.filter((e) => serviceBacked.has(e.id));
    const target = backed.length === 1 ? backed[0] : specific.length === 1 ? specific[0] : undefined;
    if (!target) continue;
    into.set(id, target.id);
    target.identifiers.push(...externals.get(id)!.identifiers.filter((i) => !target.identifiers.includes(i)));
  }
  const byId = new Map<string, C4Link>();
  for (const l of links) {
    const to = into.get(l.to) ?? l.to;
    const id = `${l.from}->${to}`;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { ...l, id, to, evidence: [...l.evidence] });
      continue;
    }
    for (const e of l.evidence) {
      if (existing.evidence.some((x) => x.path === e.path && x.note === e.note)) continue;
      existing.strength += 1;
      existing.evidence.push(e);
    }
  }
  return { externals: [...externals.values()].filter((e) => !into.has(e.id)), links: [...byId.values()] };
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'system';
}

// Hosts that name a machine on a private network or a placeholder never leave this process.
function isPublicHost(host: string): boolean {
  if (/^\d+(\.\d+){3}$/.test(host) || !host.includes('.')) return false;
  return !/(^|\.)(localhost|local|internal|lan|svc|cluster\.local|example|test|invalid)$|(^|\.)example\.(com|org|net)$/.test(host);
}

function launchLines(command: string): string[] {
  const lines = command.split('\n').map((l) => l.trim()).filter(Boolean);
  const useful = lines.length === 1 ? lines : lines.filter((l) => /\b(uvicorn|gunicorn|python3?|node|celery|npm|pnpm|nginx|alembic|exec)\b/.test(l));
  return useful.map((l) => l.slice(0, 160));
}

function detectEntry(commands: string[]): Entry {
  const text = commands.join('\n').replace(/\b(poetry|uv|pipenv|pdm|hatch)\s+run\s+/g, '');
  const modules: string[] = [];
  const paths: string[] = [];
  let role: ContainerRole = 'service';
  let tech = 'Process';
  let devServer = false;
  for (const m of text.matchAll(/\b(?:uvicorn|gunicorn|hypercorn|granian)\b[^\n;&|]*?\s([A-Za-z_][\w.]*):[A-Za-z_]\w*/g)) {
    modules.push(m[1]!);
    role = 'api';
    tech = 'Python · uvicorn';
  }
  for (const m of text.matchAll(/\bcelery\b[^\n;&|]*?-A\s+([\w.]+)/g)) {
    modules.push(m[1]!);
    if (role === 'service') role = 'worker';
    tech = 'Python · Celery';
  }
  for (const m of text.matchAll(/\bpython3?(?:\.\d+)?\s+-m\s+([\w.]+)/g)) {
    if (RUNNERS.has(m[1]!)) continue;
    modules.push(m[1]!);
    if (role === 'service') role = 'worker';
    if (tech === 'Process') tech = 'Python';
  }
  for (const m of text.matchAll(/\bpython3?(?:\.\d+)?\s+([\w./-]+\.py)\b/g)) {
    paths.push(m[1]!);
    if (role === 'service') role = 'worker';
    if (tech === 'Process') tech = 'Python';
  }
  for (const m of text.matchAll(/\bnode\s+([\w./-]+\.[cm]?js)\b/g)) {
    paths.push(m[1]!);
    tech = 'Node';
  }
  if (/\b(npm|pnpm|yarn)\s+(run\s+)?(dev|start|preview)\b|\bvite\b/.test(text)) {
    role = 'ui';
    tech = 'Vite dev server';
    devServer = true;
  }
  if (/\bnginx\b/.test(text) && role === 'service') {
    role = 'ui';
    tech = 'nginx';
  }
  return { role, tech, modules: [...new Set(modules)], paths: [...new Set(paths)], devServer };
}

function resolveModule(module: string, paths: string[], scope: string[]): string | null {
  const base = module.replace(/\./g, '/');
  const suffixes = [`${base}.py`, `${base}/__main__.py`, `${base}/__init__.py`];
  const hits = paths.filter((p) => suffixes.some((s) => p === s || p.endsWith(`/${s}`)));
  const inScope = hits.filter((p) => scope.length === 0 || scope.some((dir) => p.startsWith(`${dir}/`)));
  return [...(inScope.length > 0 ? inScope : hits)].sort((a, b) => a.length - b.length)[0] ?? null;
}

function packageOf(specifier: string): string {
  if (/^[./#~]|^@\//.test(specifier)) return '';
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split(/[./]/)[0]!;
}

function protocolOf(id: string, externals: Map<string, C4External>, protocols: Map<string, string>): string {
  const external = externals.get(id)!;
  return protocols.get(id) ?? (external.kind === 'broker' ? external.name : KIND_PROTOCOL[external.kind]);
}

function hostOf(key: string, value: string, services: Map<string, ServiceDef[]>): { host: string; scheme: string } | null {
  const url = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/\s]*@)?([^:/?#\s]+)/i.exec(value);
  if (url) return services.has(url[2]!) ? { host: url[2]!, scheme: url[1]!.toLowerCase() } : null;
  const hostPort = /^([a-z0-9][a-z0-9_.-]*):\d+$/i.exec(value);
  if (hostPort) return services.has(hostPort[1]!) ? { host: hostPort[1]!, scheme: '' } : null;
  if (/(HOST|ENDPOINT|SERVER|ADDR)$/.test(key) && services.has(value)) return { host: value, scheme: '' };
  return null;
}
