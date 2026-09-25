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
import { readDeploy, type ServiceDef } from './deploy';

// POC stand-in for the Haiku classification of identifiers (spec §5.2): names only, no values.
const SYSTEMS: Record<string, { name: string; kind: ExternalKind; protocol?: string }> = {
  postgresql: { name: 'PostgreSQL', kind: 'database' },
  nats: { name: 'NATS', kind: 'broker' },
  minio: { name: 'MinIO', kind: 'storage' },
  onlyoffice: { name: 'OnlyOffice', kind: 'documents' },
  gotenberg: { name: 'Gotenberg', kind: 'documents' },
  email: { name: 'Mail (SMTP)', kind: 'email' },
  searxng: { name: 'SearXNG', kind: 'search' },
  firecrawl: { name: 'Firecrawl', kind: 'search' },
  redis: { name: 'Redis', kind: 'cache' },
  rabbitmq: { name: 'RabbitMQ', kind: 'broker' },
  mlflow: { name: 'MLflow', kind: 'ml' },
  llm: { name: 'LLM providers', kind: 'ai' },
  microsoft365: { name: 'Microsoft 365', kind: 'source' },
  google: { name: 'Google Workspace', kind: 'source' },
  atlassian: { name: 'Atlassian', kind: 'source' },
  asana: { name: 'Asana', kind: 'source' },
  box: { name: 'Box', kind: 'source' },
  clickup: { name: 'ClickUp', kind: 'source' },
  discord: { name: 'Discord', kind: 'source' },
  docusign: { name: 'DocuSign', kind: 'source' },
  fireflies: { name: 'Fireflies', kind: 'source' },
  gitbook: { name: 'GitBook', kind: 'source' },
  monday: { name: 'monday.com', kind: 'source' },
  notion: { name: 'Notion', kind: 'source' },
  servicenow: { name: 'ServiceNow', kind: 'source' },
  webex: { name: 'Webex', kind: 'source' },
  zoom: { name: 'Zoom', kind: 'source' },
  slack: { name: 'Slack', kind: 'source' },
  s3: { name: 'Amazon S3', kind: 'source', protocol: 'S3' },
  smb: { name: 'SMB file shares', kind: 'source', protocol: 'SMB' },
  sftp: { name: 'SFTP servers', kind: 'source', protocol: 'SFTP' },
  ldap: { name: 'Active Directory', kind: 'source', protocol: 'LDAP' },
};

const HOST_RULES: [RegExp, string][] = [
  [/(^|\.)(graph\.microsoft\.com|login\.microsoftonline\.com|sharepoint\.com)$/, 'microsoft365'],
  [/(^|\.)googleapis\.com$/, 'google'],
  [/(^|\.)atlassian\.com$/, 'atlassian'],
  [/(^|\.)asana\.com$/, 'asana'],
  [/(^|\.)box\.com$/, 'box'],
  [/(^|\.)clickup\.com$/, 'clickup'],
  [/(^|\.)discord\.com$/, 'discord'],
  [/(^|\.)docusign\.(net|com)$/, 'docusign'],
  [/(^|\.)fireflies\.ai$/, 'fireflies'],
  [/(^|\.)gitbook\.com$/, 'gitbook'],
  [/(^|\.)monday\.com$/, 'monday'],
  [/(^|\.)notion\.com$/, 'notion'],
  [/(^|\.)service-now\.com$/, 'servicenow'],
  [/(^|\.)webexapis\.com$/, 'webex'],
  [/(^|\.)zoom\.us$/, 'zoom'],
  [/(^|\.)firecrawl\.dev$/, 'firecrawl'],
];

// Literal URL hosts are names like package names; file contents never leave this process.
const URL_LITERAL = /['"`]https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi;
const literalHosts = new Map<string, { hash: string; hosts: string[] }>();

function hostsIn(root: string, file: IndexedFile): string[] {
  const cached = literalHosts.get(file.path);
  if (cached?.hash === file.contentHash) return cached.hosts;
  let hosts: string[] = [];
  try {
    hosts = [...new Set([...readFileSync(join(root, file.path), 'utf8').matchAll(URL_LITERAL)].map((m) => m[1]!.toLowerCase()))];
  } catch {
    hosts = [];
  }
  literalHosts.set(file.path, { hash: file.contentHash, hosts });
  return hosts;
}

const IMAGE_RULES: [RegExp, string][] = [
  [/postgres|vchord|pgvector|timescale|postgis/, 'postgresql'],
  [/(^|\/)nats\b/, 'nats'],
  [/minio/, 'minio'],
  [/onlyoffice|documentserver/, 'onlyoffice'],
  [/gotenberg/, 'gotenberg'],
  [/mailpit|mailhog|maildev/, 'email'],
  [/searxng/, 'searxng'],
  [/firecrawl/, 'firecrawl'],
  [/redis|valkey/, 'redis'],
  [/rabbitmq/, 'rabbitmq'],
  [/mlflow/, 'mlflow'],
];

const PACKAGE_RULES: Record<string, string> = {
  sqlalchemy: 'postgresql',
  asyncpg: 'postgresql',
  psycopg: 'postgresql',
  psycopg2: 'postgresql',
  pgvector: 'postgresql',
  nats: 'nats',
  minio: 'minio',
  boto3: 's3',
  aioboto3: 's3',
  botocore: 's3',
  msal: 'microsoft365',
  googleapiclient: 'google',
  google: 'google',
  slack_sdk: 'slack',
  smbprotocol: 'smb',
  smbclient: 'smb',
  paramiko: 'sftp',
  ldap3: 'ldap',
  litellm: 'llm',
  openai: 'llm',
  anthropic: 'llm',
  mistralai: 'llm',
  firecrawl: 'firecrawl',
  redis: 'redis',
  mlflow: 'mlflow',
  aiosmtplib: 'email',
  smtplib: 'email',
  '@onlyoffice/document-editor-react': 'onlyoffice',
};

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

export function buildC4(root: string, files: IndexedFile[], edges: FileEdge[], components: MapComponent[]): C4Model {
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
  const serviceSystem = new Map<string, string>();
  const tooling: string[] = [];
  const externals = new Map<string, C4External>();
  const addExternal = (systemId: string, identifier: string): string => {
    const id = `ext:${systemId}`;
    const known = SYSTEMS[systemId] ?? { name: systemId, kind: 'other' as const };
    const existing = externals.get(id) ?? { id, name: known.name, kind: known.kind, identifiers: [] };
    if (!existing.identifiers.includes(identifier)) existing.identifiers.push(identifier);
    externals.set(id, existing);
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
      const image = defs.find((d) => d.image)?.image ?? name;
      const system = IMAGE_RULES.find(([pattern]) => pattern.test(image))?.[1] ?? image.split(/[:@]/)[0]!.split('/').at(-1)!;
      serviceSystem.set(name, system);
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
  const linkedServices = new Set<string>();
  const codeContainers = containers.filter((c) => c.files > 0).length;
  const fileReach = new Map<string, number>();
  for (const closure of closures.values()) for (const path of closure) fileReach.set(path, (fileReach.get(path) ?? 0) + 1);
  const containerNames = new Set(containers.map((c) => c.name));
  for (const container of containers) {
    for (const path of closures.get(container.name) ?? []) {
      for (const specifier of byFile.get(path)?.imports ?? []) {
        const system = PACKAGE_RULES[packageOf(specifier)];
        if (!system) continue;
        const to = addExternal(system, packageOf(specifier));
        link(container.id, to, protocolFor(externals.get(to)!), { path, note: `imports ${packageOf(specifier)}` });
      }
      const file = byFile.get(path);
      // A URL in a module every container loads (settings) is configuration, not a call.
      const everywhere = codeContainers > 2 && (fileReach.get(path) ?? 0) >= codeContainers;
      const test = /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]*\.py$|\.(test|spec)\.[jt]sx?$/.test(path);
      for (const host of file && !everywhere && !test ? hostsIn(root, file) : []) {
        const system = HOST_RULES.find(([pattern]) => pattern.test(host))?.[1];
        if (!system) continue;
        const to = addExternal(system, host);
        link(container.id, to, protocolFor(externals.get(to)!), { path, note: `calls ${host}` });
      }
    }
    for (const def of deploy.services.get(container.name) ?? []) {
      for (const [key, value] of def.env) {
        const target = hostOf(key, value, deploy.services);
        if (!target) continue;
        const note = `${key} in ${def.file}`;
        if (containerNames.has(target.host)) {
          link(container.id, `container:${target.host}`, SCHEME_PROTOCOL[target.scheme] ?? 'HTTP', { path: def.file, note });
        } else if (serviceSystem.has(target.host)) {
          linkedServices.add(target.host);
          const to = addExternal(serviceSystem.get(target.host)!, `service ${target.host}`);
          link(container.id, to, SCHEME_PROTOCOL[target.scheme] ?? protocolFor(externals.get(to)!), { path: def.file, note });
        }
      }
    }
  }
  for (const [service, system] of serviceSystem) {
    if (linkedServices.has(service)) {
      const image = deploy.services.get(service)?.find((d) => d.image)?.image;
      if (image) addExternal(system, `image ${image.split('@')[0]}`);
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

  return {
    containers,
    externals: [...externals.values()],
    links: [...links.values()],
    tooling,
    warnings,
  };
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
  if (specifier.startsWith('.') || specifier.startsWith('/')) return '';
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split(/[./]/)[0]!;
}

function protocolFor(external: C4External): string {
  if (external.kind === 'broker') return external.name;
  return SYSTEMS[external.id.slice('ext:'.length)]?.protocol ?? KIND_PROTOCOL[external.kind];
}

function hostOf(key: string, value: string, services: Map<string, ServiceDef[]>): { host: string; scheme: string } | null {
  const url = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/\s]*@)?([^:/?#\s]+)/i.exec(value);
  if (url) return services.has(url[2]!) ? { host: url[2]!, scheme: url[1]!.toLowerCase() } : null;
  const hostPort = /^([a-z0-9][a-z0-9_.-]*):\d+$/i.exec(value);
  if (hostPort) return services.has(hostPort[1]!) ? { host: hostPort[1]!, scheme: '' } : null;
  if (/(HOST|ENDPOINT|SERVER|ADDR)$/.test(key) && services.has(value)) return { host: value, scheme: '' };
  return null;
}
