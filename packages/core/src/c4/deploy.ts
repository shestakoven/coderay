import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { watch } from 'chokidar';
import { parse, parseAllDocuments } from 'yaml';
import { createIgnoreMatcher } from '../indexer/ignore';
import { isRecord } from '../json';
import { readXcode } from './xcode';

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
  scripts: string[];
}

export interface Deploy {
  services: Map<string, ServiceDef[]>;
  files: string[];
  warnings: string[];
}

const COMPOSE_FILE = /^(docker-)?compose([.-][\w-]+)?\.ya?ml$/;
const DOCKERFILE = /^Dockerfile(\.(?!dockerignore$)[\w-]+)?$/;
const WORKLOAD = /^kind:\s*(Deployment|StatefulSet|DaemonSet|Job|CronJob)\s*$/m;
const TOOLING_NAME = /(^|[-_])(test|tests|e2e|lint|migrate|migrations?)([-_]|$)/;
// Hidden directories (.venv*, .git, worktrees), vendored code and test fixtures hold no deployables of the project.
const SKIPPED_DIR = /^\.|^(vendor|tests?|__tests__|e2e|fixtures|testdata)$/;
// YAML that may hold a compose file or a Kubernetes workload: not hidden CI config (.gitlab-ci.yml) and not a lockfile (pnpm-lock.yaml).
const DEPLOY_YAML = /^[^.].*(?<!(?:^|[-.])lock)\.ya?ml$/;
const MAX_DEPTH = 3;
const MAX_MANIFEST_BYTES = 256 * 1024;

export function readDeploy(root: string): Deploy {
  return readCompose(root, readdirSync(root).filter((name) => COMPOSE_FILE.test(name)).sort());
}

// Test, lint and migration services are listed, not drawn.
export function isTooling(name: string, commands: string[]): boolean {
  return TOOLING_NAME.test(name) || commands.some((c) => /\b(pytest|vitest|jest)\b/.test(c));
}

// A service runs the project's code when it builds from the repository or runs a command over a mounted source directory.
export function runsCode(defs: ServiceDef[], hasSources: (dir: string) => boolean): boolean {
  return defs.some((d) => d.build !== null) || defs.some((d) => d.mounts.some((m) => hasSources(m) && d.commands.length > 0));
}

// Root compose files that run none of the project's code, tests aside, leave its containers to its Dockerfiles (readBuilds).
export function deploysFromBuilds(services: Map<string, ServiceDef[]>, hasSources: (dir: string) => boolean): boolean {
  return ![...services].some(([name, defs]) => runsCode(defs, hasSources) && !isTooling(name, defs.flatMap((d) => d.commands)));
}

// The tree walk and manifest parsing run once per project, again only after watchDeploy sees a deploy file change.
const buildsCache = new Map<string, Deploy>();

// A project whose root compose files run none of its code is deployed from its Dockerfiles. Each service of a compose file in a
// subdirectory that builds one is a service of its own, and a Dockerfile no such service builds is a service named after its
// directory (with the suffix of a Dockerfile.<suffix>), which is its build context. A service that only runs an image joins the
// built service of its name. A name two built services share gets their parent directory in front, or else their whole path.
// A Kubernetes workload whose container is named after a service or runs its image adds its environment and ports.
export function readBuilds(root: string): Deploy {
  const cached = buildsCache.get(root);
  if (cached) return cached;
  const project = basename(resolve(root));
  const found = findDeployFiles(root);
  const compose = readCompose(root, found.compose);
  const warnings = [...compose.warnings];
  const services = new Map<string, ServiceDef[]>();
  const add = (name: string, defs: ServiceDef[]): void => {
    services.set(name, [...(services.get(name) ?? []), ...defs]);
  };
  const named: { name: string; parent: string; path: string; defs: ServiceDef[] }[] = [];
  const built = new Set<string>();
  for (const [name, defs] of compose.services) {
    const projects = new Map<string, ServiceDef[]>();
    for (const def of defs) projects.set(posix.dirname(def.file), [...(projects.get(posix.dirname(def.file)) ?? []), def]);
    for (const [dir, group] of projects) {
      if (!group.some((d) => d.build)) {
        add(name, group);
        continue;
      }
      if (!isTooling(name, group.flatMap((d) => d.commands))) for (const d of group) if (d.build) built.add(posix.join(d.build.context, d.build.dockerfile));
      named.push({ name, parent: dir, path: `${dir}/${name}`, defs: group });
    }
  }
  for (const file of found.dockerfiles.filter((f) => !built.has(f))) {
    const dir = posix.dirname(file);
    const variant = /^Dockerfile\.(.+)$/.exec(posix.basename(file))?.[1];
    const name = `${dir === '.' ? project : posix.basename(dir)}${variant ? `-${variant}` : ''}`;
    const def = serviceDef(root, file, name, { build: { context: '.', dockerfile: posix.basename(file) } }, warnings);
    named.push({ name, parent: posix.dirname(dir), path: file, defs: [def] });
  }
  const short = named.map((n) =>
    named.filter((m) => m.name === n.name).length > 1 ? `${n.parent === '.' ? project : posix.basename(n.parent)}-${n.name}` : n.name,
  );
  named.forEach((n, i) => {
    const name = short.filter((s) => s === short[i]).length > 1 ? n.path : short[i]!;
    services.set(name, [...n.defs, ...(services.get(name) ?? [])]);
  });
  const manifests: string[] = [];
  for (const file of found.manifests) {
    const containers = workloadContainers(root, file, warnings);
    if (containers.length === 0) continue;
    manifests.push(file);
    for (const container of containers) {
      const repo = (container.image ?? '').split('@')[0]!.replace(/:[\w.-]+$/, '').split('/').at(-1)!;
      const name = services.has(container.name) ? container.name : [...services.keys()].find((s) => repo === s || repo.endsWith(`-${s}`));
      if (name && services.get(name)!.some((d) => d.build)) add(name, [container]);
    }
  }
  const builds = { services, files: [...compose.files, ...found.dockerfiles, ...manifests], warnings };
  buildsCache.set(root, builds);
  return builds;
}

function readCompose(root: string, files: string[]): Deploy {
  const services = new Map<string, ServiceDef[]>();
  const warnings: string[] = [];
  const queue = [...files];
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
      const def = serviceDef(root, file, name, raw ?? {}, warnings);
      services.set(name, [...(services.get(name) ?? []), def]);
    }
  }
  return { services, files: [...seen], warnings };
}

const WATCH_DEBOUNCE_MS = 300;

// Compose files, the files they include, Dockerfiles, the scripts they run, Kubernetes workloads and XcodeGen specs are not
// indexed, so they get their own watch: a tree watch for those that may appear where readBuilds looks, a file watch for the rest.
export function watchDeploy(root: string, onChange: () => void): { close(): Promise<void> } {
  let timer: NodeJS.Timeout | undefined;
  let fromBuilds = false;
  buildsCache.delete(root);
  const deployFiles = (): Set<string> => {
    const deploy = readDeploy(root);
    // Only a build counts here, so the watch reads the Dockerfiles whenever the model may.
    fromBuilds = deploysFromBuilds(deploy.services, () => false);
    const builds = fromBuilds ? readBuilds(root) : null;
    const defs = [...deploy.services.values(), ...(builds?.services.values() ?? [])].flat();
    const used = defs.flatMap((d) => [...(d.build ? [posix.join(d.build.context, d.build.dockerfile)] : []), ...d.scripts]);
    return new Set([...deploy.files, ...used, ...(builds?.files ?? []), ...readXcode(root).files].map((path) => join(root, path)));
  };
  let watched = deployFiles();
  const isIgnored = createIgnoreMatcher(root);
  const options = { ignoreInitial: true, followSymlinks: false, ignorePermissionErrors: true };
  const treeWatcher = watch(root, {
    ...options,
    depth: MAX_DEPTH,
    ignored: (path: string, stats?: { isFile(): boolean }) => {
      const rel = relative(root, path).split(sep).join('/');
      if (rel === '') return false;
      if (SKIPPED_DIR.test(basename(path))) return true;
      let isFile: boolean;
      try {
        isFile = stats ? stats.isFile() : statSync(path).isFile();
      } catch {
        return false;
      }
      return isFile ? !(DOCKERFILE.test(basename(path)) || DEPLOY_YAML.test(basename(path))) || isIgnored(rel, false) : isIgnored(rel, true);
    },
  });
  const fileWatcher = watch([...watched], options);
  const changed = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      buildsCache.delete(root);
      try {
        const next = deployFiles();
        fileWatcher.add([...next].filter((path) => !watched.has(path)));
        fileWatcher.unwatch([...watched].filter((path) => !next.has(path)));
        watched = next;
      } catch (error) {
        console.error('c4: deploy watch error', error);
      }
      onChange();
    }, WATCH_DEBOUNCE_MS);
  };
  treeWatcher.on('all', (_event, path) => {
    if (fromBuilds || (dirname(path) === root && COMPOSE_FILE.test(basename(path)))) changed();
  });
  fileWatcher.on('all', changed);
  for (const w of [treeWatcher, fileWatcher]) w.on('error', (error) => console.error('c4: deploy watch error', error));
  return {
    close: async () => {
      clearTimeout(timer);
      buildsCache.delete(root);
      await Promise.all([treeWatcher.close(), fileWatcher.close()]);
    },
  };
}

function serviceDef(root: string, file: string, name: string, raw: Record<string, unknown>, warnings: string[]): ServiceDef {
  const base = posix.dirname(file);
  const build = buildDef(base, raw.build);
  const dockerfile = build ? readDockerfile(root, posix.join(build.context, build.dockerfile), build.target, warnings) : null;
  const entrypoint = commandText(raw.entrypoint);
  const command = commandText(raw.command);
  const launch =
    entrypoint !== null
      ? [entrypoint, command ?? ''].join(' ').trim()
      : command !== null
        ? [dockerfile?.entrypoint ?? '', command].join(' ').trim()
        : [dockerfile?.entrypoint ?? '', dockerfile?.cmd ?? ''].join(' ').trim();
  const commands = launch ? [launch] : [];
  const scripts: string[] = [];
  for (const script of scriptsIn(launch)) {
    const inline = dockerfile?.scripts.get(script) ?? scriptOnPath(dockerfile?.scripts, script);
    const path = inline === undefined ? repoScript(root, build?.context ?? base, script, dockerfile?.copies ?? []) : null;
    if (path) scripts.push(path);
    const body = inline ?? (path ? readText(root, path, warnings) : null);
    // A commented-out line of a script runs nothing.
    if (body) commands.push(body.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n'));
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
    scripts,
  };
}

function findDeployFiles(root: string): { compose: string[]; dockerfiles: string[]; manifests: string[] } {
  const isIgnored = createIgnoreMatcher(root);
  const found = { compose: [] as string[], dockerfiles: [] as string[], manifests: [] as string[] };
  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIPPED_DIR.test(entry.name) && !isIgnored(path, true)) walk(path, depth + 1);
      } else if (!entry.isFile() || isIgnored(path, false)) {
        continue;
      } else if (DOCKERFILE.test(entry.name)) {
        found.dockerfiles.push(path);
      } else if (COMPOSE_FILE.test(entry.name)) {
        if (dir) found.compose.push(path);
      } else if (DEPLOY_YAML.test(entry.name)) {
        found.manifests.push(path);
      }
    }
  };
  walk('', 0);
  return { compose: found.compose.sort(), dockerfiles: found.dockerfiles.sort(), manifests: found.manifests.sort() };
}

// The containers of the Kubernetes workloads in a manifest. Helm templates are not YAML until rendered and are skipped.
function workloadContainers(root: string, file: string, warnings: string[]): ServiceDef[] {
  let text: string;
  try {
    if (statSync(join(root, file)).size > MAX_MANIFEST_BYTES) return [];
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    return [];
  }
  if (!WORKLOAD.test(text)) return [];
  const containers: ServiceDef[] = [];
  for (const doc of parseAllDocuments(text)) {
    if (doc.errors.length > 0) continue;
    let manifest: unknown;
    try {
      manifest = doc.toJS();
    } catch (error) {
      warnings.push(`${file}: ${(error as Error).message.split('\n')[0]}`);
      continue;
    }
    if (!isRecord(manifest) || !isRecord(manifest.spec)) continue;
    const job = manifest.kind === 'CronJob' && isRecord(manifest.spec.jobTemplate) ? manifest.spec.jobTemplate.spec : null;
    const template = isRecord(job) ? job.template : manifest.spec.template;
    const pod = isRecord(template) && isRecord(template.spec) ? template.spec : {};
    for (const container of asArray(pod.containers).filter(isRecord)) {
      containers.push({
        name: typeof container.name === 'string' ? container.name : '',
        file,
        build: null,
        image: typeof container.image === 'string' ? container.image : null,
        commands: [],
        env: asArray(container.env)
          .filter(isRecord)
          .map((e): [string, string] => [String(e.name ?? ''), typeof e.value === 'string' || typeof e.value === 'number' ? String(e.value) : '']),
        mounts: [],
        ports: asArray(container.ports).length > 0,
        scripts: [],
      });
    }
  }
  return containers;
}

function buildDef(base: string, raw: unknown): BuildDef | null {
  const build = typeof raw === 'string' ? { context: raw } : raw && typeof raw === 'object' ? (raw as { context?: unknown; dockerfile?: unknown; target?: unknown }) : null;
  if (!build) return null;
  const context = posix.normalize(posix.join(base, typeof build.context === 'string' ? build.context : '.'));
  // A build context outside the project is not its code.
  if (context.startsWith('..')) return null;
  return {
    context,
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

// A command may run a script by its bare name when the Dockerfile wrote it into a directory on the PATH.
function scriptOnPath(scripts: Map<string, string> | undefined, script: string): string | undefined {
  if (!scripts || script.includes('/')) return undefined;
  return [...scripts].find(([path]) => path.endsWith(`/${script}`))?.[1];
}

// An unreadable file (no permission, a directory) is a warning, not a failure: the other deploy files still count.
function readText(root: string, path: string, warnings: string[]): string | null {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch (error) {
    warnings.push(`${path}: ${(error as Error).message.split('\n')[0]}`);
    return null;
  }
}

// The repository path of a script the command runs: relative to the build context, or at the absolute path a COPY placed it.
function repoScript(root: string, context: string, script: string, copies: [string, string][]): string | null {
  const sources = script.startsWith('/') ? [...copies].reverse().flatMap(([dest, src]) => copiedFrom(dest, src, script)) : [script];
  return sources.map((source) => posix.normalize(posix.join(context, source))).find((path) => !path.startsWith('..') && existsSync(join(root, path))) ?? null;
}

function copiedFrom(dest: string, src: string, script: string): string[] {
  if (script === dest) return [src];
  const dir = dest.endsWith('/') ? dest : `${dest}/`;
  if (!script.startsWith(dir)) return [];
  const rest = script.slice(dir.length);
  return rest === posix.basename(src) ? [src, posix.join(src, rest)] : [posix.join(src, rest)];
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
  copies: [string, string][];
}

function readDockerfile(root: string, path: string, target: string | null, warnings: string[]): Dockerfile | null {
  if (path.startsWith('..') || !existsSync(join(root, path))) return null;
  const text = readText(root, path, warnings);
  if (text === null) return null;
  const lines = text.split('\n');
  const stages: Stage[] = [];
  const scripts = new Map<string, string>();
  const copies: [string, string][] = [];
  let pending = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = pending + lines[i]!;
    const marker = /^\s*RUN\b.*<<-?\s*['"]?(\w+)['"]?/.exec(line)?.[1];
    const target = marker ? /[^<]>\s*([^\s<>]+)/.exec(line)?.[1] : undefined;
    if (marker && target) {
      const body: string[] = [];
      for (i += 1; i < lines.length && lines[i]!.trim() !== marker; i += 1) body.push(lines[i]!);
      scripts.set(target, body.join('\n'));
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
    const copy = /^\s*COPY\s+((?:--\S+\s+)*)(\S+)\s+(\S+)\s*$/i.exec(line);
    if (copy && !copy[1]!.includes('--from')) copies.push([copy[3]!, copy[2]!]);
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
    copies,
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
