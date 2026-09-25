import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parse } from 'yaml';

export interface BuildDef {
  context: string;
  dockerfile: string;
  target: string | null;
}

export interface ServiceDef {
  name: string;
  file: string;
  build: BuildDef | null;
  image: string | null;
  commands: string[];
  env: [string, string][];
  mounts: string[];
  ports: boolean;
}

export interface Deploy {
  services: Map<string, ServiceDef[]>;
  files: string[];
  warnings: string[];
}

const COMPOSE_FILE = /^(docker-)?compose([.-][\w-]+)?\.ya?ml$/;

export function readDeploy(root: string): Deploy {
  const services = new Map<string, ServiceDef[]>();
  const warnings: string[] = [];
  const queue = readdirSync(root).filter((name) => COMPOSE_FILE.test(name)).sort();
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file) || !existsSync(join(root, file))) continue;
    seen.add(file);
    let doc: Record<string, unknown>;
    try {
      doc = (parse(readFileSync(join(root, file), 'utf8'), { merge: true }) ?? {}) as Record<string, unknown>;
    } catch (error) {
      warnings.push(`${file}: ${(error as Error).message.split('\n')[0]}`);
      continue;
    }
    for (const include of asArray(doc.include)) {
      const path = typeof include === 'string' ? include : (include as { path?: unknown })?.path;
      if (typeof path === 'string') queue.push(posix.normalize(posix.join(posix.dirname(file), path)));
    }
    for (const [name, raw] of Object.entries((doc.services ?? {}) as Record<string, Record<string, unknown> | null>)) {
      const def = serviceDef(root, file, name, raw ?? {});
      services.set(name, [...(services.get(name) ?? []), def]);
    }
  }
  return { services, files: [...seen], warnings };
}

function serviceDef(root: string, file: string, name: string, raw: Record<string, unknown>): ServiceDef {
  const base = posix.dirname(file);
  const build = buildDef(base, raw.build);
  const dockerfile = build ? readDockerfile(root, posix.join(build.context, build.dockerfile), build.target) : null;
  const entrypoint = commandText(raw.entrypoint);
  const command = commandText(raw.command);
  const launch =
    entrypoint !== null
      ? [entrypoint, command ?? ''].join(' ').trim()
      : command !== null
        ? [dockerfile?.entrypoint ?? '', command].join(' ').trim()
        : [dockerfile?.entrypoint ?? '', dockerfile?.cmd ?? ''].join(' ').trim();
  const commands = launch ? [launch] : [];
  for (const script of scriptsIn(launch)) {
    const body = dockerfile?.scripts.get(script) ?? repoScript(root, build?.context ?? base, script);
    if (body) commands.push(body);
  }
  return {
    name,
    file,
    build,
    image: typeof raw.image === 'string' ? raw.image : null,
    commands,
    env: envPairs(raw.environment),
    mounts: asArray(raw.volumes).flatMap((volume) => mountSource(base, volume)),
    ports: asArray(raw.ports).length > 0,
  };
}

function buildDef(base: string, raw: unknown): BuildDef | null {
  if (typeof raw === 'string') return { context: posix.normalize(posix.join(base, raw)), dockerfile: 'Dockerfile', target: null };
  if (!raw || typeof raw !== 'object') return null;
  const build = raw as { context?: unknown; dockerfile?: unknown; target?: unknown };
  return {
    context: posix.normalize(posix.join(base, typeof build.context === 'string' ? build.context : '.')),
    dockerfile: typeof build.dockerfile === 'string' ? build.dockerfile : 'Dockerfile',
    target: typeof build.target === 'string' ? build.target : null,
  };
}

function commandText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(String).join(' ');
  return null;
}

function envPairs(raw: unknown): [string, string][] {
  if (Array.isArray(raw)) {
    return raw.map(String).map((entry) => {
      const at = entry.indexOf('=');
      return at < 0 ? [entry, ''] : [entry.slice(0, at), entry.slice(at + 1)];
    });
  }
  if (raw && typeof raw === 'object') return Object.entries(raw).map(([key, value]) => [key, value == null ? '' : String(value)]);
  return [];
}

function mountSource(base: string, volume: unknown): string[] {
  const source =
    typeof volume === 'string'
      ? volume.split(':')[0]
      : volume && typeof volume === 'object' && (volume as { type?: unknown }).type === 'bind'
        ? String((volume as { source?: unknown }).source ?? '')
        : '';
  if (!source?.startsWith('.')) return [];
  const path = posix.normalize(posix.join(base, source));
  return path.startsWith('..') ? [] : [path === '.' ? '' : path];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function scriptsIn(command: string): string[] {
  return [...command.matchAll(/(?:^|[\s"'])((?:\/|\.\/)?[\w./-]+\.sh)\b/g)].map((m) => m[1]!);
}

function repoScript(root: string, context: string, script: string): string | null {
  if (script.startsWith('/')) return null;
  const path = join(root, context, script);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

interface Stage {
  name: string | null;
  base: string;
  cmd: string | null;
  entrypoint: string | null;
}

interface Dockerfile {
  cmd: string | null;
  entrypoint: string | null;
  scripts: Map<string, string>;
}

function readDockerfile(root: string, path: string, target: string | null): Dockerfile | null {
  const full = join(root, path);
  if (!existsSync(full)) return null;
  const lines = readFileSync(full, 'utf8').split('\n');
  const stages: Stage[] = [];
  const scripts = new Map<string, string>();
  let pending = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = pending + lines[i]!;
    const heredoc = /^\s*RUN\b.*<<-?\s*['"]?(\w+)['"]?.*>\s*(\S+)/.exec(line);
    if (heredoc) {
      const body: string[] = [];
      for (i += 1; i < lines.length && lines[i]!.trim() !== heredoc[1]; i += 1) body.push(lines[i]!);
      scripts.set(heredoc[2]!, body.join('\n'));
      pending = '';
      continue;
    }
    if (line.endsWith('\\')) {
      pending = line.slice(0, -1) + ' ';
      continue;
    }
    pending = '';
    const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      stages.push({ name: from[2] ?? null, base: from[1]!, cmd: null, entrypoint: null });
      continue;
    }
    const instruction = /^\s*(CMD|ENTRYPOINT)\s+(.+)$/i.exec(line);
    const stage = stages.at(-1);
    if (instruction && stage) {
      const text = instructionText(instruction[2]!);
      if (instruction[1]!.toUpperCase() === 'CMD') stage.cmd = text;
      else stage.entrypoint = text;
    }
  }
  const byName = new Map(stages.filter((s) => s.name).map((s) => [s.name!, s]));
  const chain: Stage[] = [];
  for (let stage = target ? byName.get(target) : stages.at(-1); stage && !chain.includes(stage); stage = byName.get(stage.base)) {
    chain.push(stage);
  }
  return {
    cmd: chain.find((s) => s.cmd !== null)?.cmd ?? null,
    entrypoint: chain.find((s) => s.entrypoint !== null)?.entrypoint ?? null,
    scripts,
  };
}

function instructionText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      return (JSON.parse(trimmed) as unknown[]).map(String).join(' ');
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}
