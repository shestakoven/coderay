// The background-AI half of `pnpm engines:smoke --engine background [--claude <path>] [--codex <path>] [--opencode <path>] [--ide-home <dir>]
// [--model <opencode model>] [--port <n>] [--only <regexp>] [--keep]`: real cores (main.ts) on the real engines, each engine under sandbox-exec that denies
// ~/.ide, ~/.codex and the owner's opencode homes, with scratch IDE, Codex, Claude and opencode homes. A Codex account the owner signed in through Settings → Accounts
// in a scratch `--ide-home` runs the Codex parts; without one they are NEEDS OWNER. PASS and FAIL check what CodeRay relies on; INFO records
// what an engine did where CodeRay holds either way.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { ENGINE_PRODUCT_NAMES, type BackgroundAiStatus, type BackgroundAiView, type MapSnapshot, type ModelInfo, type SettingsView } from '@ide/protocol';
import { ACCOUNT_DIRS, accountHome, CREDENTIAL_VARS } from '../src/accounts/account-homes';
import { withAppServer } from '../src/agent/codex/app-server';
import { codexCommand, codexUnder } from '../src/agent/codex/command';
import { hideSecrets } from '../src/agent/codex/secrets';
import { opencodeCommand, opencodeEnv } from '../src/agent/opencode/command';
import { AGENTS_IN_USE, backgroundConfig, denyAllProblem, toolOutputGlob } from '../src/agent/opencode/config';
import { shellWrapper, startServer } from '../src/agent/opencode/server';
import { projectDir } from '../src/home';
import { isRecord } from '../src/json';
import { isAlive } from '../src/os-process';

export interface BackgroundSmokeOptions { claude: string; codex: string; opencode: string; model: string; ideHome?: string; port: number; only?: string; keep: boolean }

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const EXAMPLE = join(REPO, 'examples', 'py-app');
const MISSING = '/nonexistent';
const OWNER_OPENCODE = ['.config/opencode', '.local/share/opencode', '.local/state/opencode', '.cache/opencode'];
const XDG = { XDG_DATA_HOME: 'data', XDG_CONFIG_HOME: 'config', XDG_STATE_HOME: 'state', XDG_CACHE_HOME: 'cache' } as const;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const SPIKE_MCP = { mcp: { spike: { type: 'local', command: ['node', '-e', 'setInterval(()=>{},1e9)'] } } };
const SESSION_TITLE = 'CodeRay background call';
const GROUPING_MS = 420_000;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** The owner's homes no smoke may read or write: CodeRay's, Codex's and opencode's four. */
export const ownerHomes = (owner: string): string[] => [join(owner, '.ide'), join(owner, '.codex'), ...OWNER_OPENCODE.map((dir) => join(owner, dir))];

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * Why the smoke may not run with these homes: one that is, lies inside or holds an owner home (`XDG_CONFIG_HOME=~/.config` holds opencode's),
 * links resolved; null when none does.
 */
export function scratchProblem(homes: ReadonlyArray<readonly [string, string | undefined]>, owner = homedir()): string | null {
  const roots = ownerHomes(owner).map(real);
  for (const [name, value] of homes) {
    if (value === undefined || value === '') continue;
    const path = real(value);
    const root = roots.find((candidate) => within(path, candidate) || within(candidate, path));
    if (root !== undefined) return `${name} (${value}) overlaps the owner's ${root}: the background smoke runs only in scratch homes`;
  }
  return null;
}

/** Every home a run would touch: the IDE home given, the environment's Codex and XDG homes, and each engine's account homes in that IDE home. */
export function homesOf(ideHome: string | undefined, env: NodeJS.ProcessEnv): Array<readonly [string, string | undefined]> {
  const used = ideHome ?? env.IDE_HOME;
  const accounts = used === undefined ? [] : Object.entries(ACCOUNT_DIRS).flatMap(([engine, dir]) => {
    const parent = join(used, dir);
    const name = ENGINE_PRODUCT_NAMES[engine as keyof typeof ACCOUNT_DIRS];
    return existsSync(parent) ? readdirSync(parent).map((id) => [`the ${name} account home ${id}`, join(parent, id)] as const) : [];
  });
  return [
    ['--ide-home', ideHome], ['IDE_HOME', env.IDE_HOME], ['CODEX_HOME', env.CODEX_HOME],
    ...Object.keys(env).filter((name) => name.startsWith('XDG_')).map((name) => [name, env[name]] as const),
    ...accounts,
  ];
}

type Verdict = 'PASS' | 'FAIL' | 'INFO' | 'NEEDS OWNER';
interface StatusAt { at: number; status: BackgroundAiStatus }
interface GroupingAt { at: number; grouping: string; error: string | null; groupedAt: string | null; layer: string }

interface Core {
  pid: number;
  startedAt: number;
  log: () => string[];
  send: (message: Record<string, unknown>) => void;
  /** Sends a request with a fresh id and waits for its settings.result; the error, or null. */
  request: (message: Record<string, unknown>) => Promise<string | null>;
  map: () => MapSnapshot | null;
  settings: () => SettingsView | null;
  view: () => BackgroundAiView | null;
  views: BackgroundAiView[];
  statuses: StatusAt[];
  groupings: GroupingAt[];
  overviews: Array<{ at: number; state: string }>;
  stop: () => Promise<void>;
}

export async function runBackgroundSmoke(options: BackgroundSmokeOptions): Promise<number> {
  const owner = homedir();
  const given = options.ideHome ?? process.env.IDE_HOME;
  const refused = scratchProblem(homesOf(options.ideHome, process.env), owner);
  if (refused !== null) {
    console.error(`REFUSED ${refused}`);
    return 2;
  }
  const tmp = realpathSync(tmpdir());
  const root = mkdtempSync(join(tmp, 'coderay-bg-smoke-'));
  const home = given === undefined ? mkdtempSync(join(tmp, 'bg-ide.')) : resolve(given);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // `hidden` never reaches the output (core tokens, passwords, the bogus key); `searched` is what the final grep looks for in the home.
  const hidden = new Set<string>();
  const searched = new Set<string>();
  const scrub = (line: string): string =>
    [...hidden].reduce((out, secret) => out.replaceAll(secret, '…'), hideSecrets(line)).replace(EMAIL, '[e-mail hidden]').replaceAll(home, '$IDE_HOME').replaceAll(root, '$SCRATCH').replaceAll(tmp, '$TMP').replaceAll(owner, '$HOME');
  const say = (line: string): void => console.log(scrub(line));
  let failed = 0;
  const only = options.only === undefined ? null : new RegExp(options.only, 'i');
  const verdict = (kind: Verdict, name: string, text = ''): void => {
    if (kind === 'FAIL') failed += 1;
    say(`${kind} ${name}${text === '' ? '' : `: ${text}`}`);
  };
  const check = (name: string, problem: string | null, detail = ''): void => verdict(problem === null ? 'PASS' : 'FAIL', name, problem ?? detail);

  // Scratch homes for every engine; the sandbox makes a path that escapes them fail loudly instead of reaching the owner's.
  const aux = join(root, 'aux');
  const xdg = Object.fromEntries(Object.entries(XDG).map(([name, sub]) => [name, join(root, 'xdg', sub)])) as Record<keyof typeof XDG, string>;
  const codexHome = join(root, 'codex-home');
  const claudeHome = join(root, 'claude-system');
  const project = join(root, 'project');
  const ui = join(root, 'ui');
  for (const dir of [aux, ...Object.values(xdg), codexHome, claudeHome, ui, join(aux, 'bin')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The System Codex never runs here (an account is always active), and if it did it would read only this home's file store, not the keychain.
  writeFileSync(join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
  cpSync(EXAMPLE, project, { recursive: true });
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: project, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'smoke');
  const denied = ownerHomes(owner);
  // The codex binary lives under ~/.codex/packages: readable, while its auth, config and sessions stay denied.
  writeFileSync(join(aux, 'deny.sb'), `(version 1)\n(allow default)\n(deny file-read* file-write* ${denied.map((path) => `(subpath ${JSON.stringify(path)})`).join(' ')})\n(allow file-read* (subpath ${JSON.stringify(join(owner, '.codex', 'packages'))}))\n`);
  const marker = `bg-${randomBytes(6).toString('hex')}`;

  // Each engine behind a wrapper that writes one line per start (seconds, then the arguments' head; Claude runs are counted from it) and
  // execs it in the sandbox. The core itself runs outside one: the setuid ps it reads process trees and pid records with cannot run inside.
  const which = (name: string, path: string): string => {
    if (path === MISSING) return MISSING;
    const found = execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', path], { encoding: 'utf8' }).trim();
    const wrapper = join(aux, 'bin', name);
    writeFileSync(wrapper, `#!/bin/sh\nprintf '%s %s\\n' "$(date +%s)" "$(printf '%s' "$*" | cut -c1-120)" >> '${join(aux, `${name}.starts`)}'\nexec /usr/bin/sandbox-exec -f '${join(aux, 'deny.sb')}' '${found}' "$@"\n`, { mode: 0o755 });
    return wrapper;
  };
  const engines = { claude: which('claude', options.claude), codex: which('codex', options.codex), opencode: which('opencode', options.opencode) };
  // The servers the smoke starts itself, through the same sandboxed wrapper.
  const ownServer = (userServers: string[]) => startServer({ ...opencodeCommand(engines.opencode), env: { ...xdg, CODERAY_BG_SMOKE: marker } }, {
    cwd: aux, configContent: backgroundConfig(shellWrapper(join(aux, 'run')), userServers), pidDir: join(aux, 'run'),
  });
  const starts = (name: string, since: number): string[] => {
    const file = join(aux, `${name}.starts`);
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '' && Number(line.split(' ')[0]) * 1000 >= since - 1000) : [];
  };
  // Every engine start this run logged, the smoke's own included: a count before and after a core is exact where seconds are not.
  const allStarts = (): number => ['claude', 'codex', 'opencode'].reduce((sum, name) => sum + starts(name, 0).length, 0);

  const coreEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const drop = new Set(['IDE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDECODE', ...Object.values(CREDENTIAL_VARS).flat()]);
    for (const name of Object.keys(env)) if (drop.has(name) || /^(XDG_|OPENCODE_|CLAUDE_CODE_)/.test(name)) delete env[name];
    return { ...env, ...xdg, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, DISABLE_AUTOUPDATER: '1', CODERAY_BG_SMOKE: marker };
  };

  // Accounts: a signed-out Claude and Codex account of CodeRay's (their homes empty), next to any the owner signed in in a given home.
  interface Accounts { accounts: Array<{ id: string; email: string; createdAt: number; plan?: string }>; activeId: string | null }
  const accountsFile = join(home, 'accounts.json');
  const readAccounts = (): Record<string, unknown> => (existsSync(accountsFile) ? JSON.parse(readFileSync(accountsFile, 'utf8')) as Record<string, unknown> : {});
  const listOf = (file: Record<string, unknown>, engine: 'claude' | 'codex'): Accounts => {
    const section = engine === 'claude' ? file : file[engine];
    return isRecord(section) && Array.isArray(section.accounts) ? { accounts: section.accounts as Accounts['accounts'], activeId: typeof section.activeId === 'string' ? section.activeId : null } : { accounts: [], activeId: null };
  };
  const writeAccounts = (engine: 'claude' | 'codex', list: Accounts): void => {
    const file = readAccounts();
    const next = engine === 'claude' ? { ...file, accounts: list.accounts, activeId: list.activeId } : { ...file, [engine]: list };
    writeFileSync(accountsFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  };
  const seed = (engine: 'claude' | 'codex'): string => {
    const id = randomUUID();
    mkdirSync(join(home, `${engine}-accounts`, id), { recursive: true, mode: 0o700 });
    const list = listOf(readAccounts(), engine);
    writeAccounts(engine, { accounts: [...list.accounts, { id, email: 'smoke, signed out', createdAt: Date.now() }], activeId: list.activeId });
    return id;
  };
  const activate = (engine: 'claude' | 'codex', id: string | null): void => writeAccounts(engine, { ...listOf(readAccounts(), engine), activeId: id });
  const signedIn = listOf(readAccounts(), 'codex').accounts.filter((account) => existsSync(join(home, 'codex-accounts', account.id, 'auth.json'))).map((account) => account.id);
  const claudeOut = seed('claude');
  const codexOut = seed('codex');
  // A Codex home is set up by its first app-server; two starting at once on an empty home race, and one fails on its sqlite state. A sign-in
  // gives a real account that first start; the seeded one gets it here.
  if (engines.codex !== MISSING) {
    await withAppServer(codexUnder(codexCommand(engines.codex), accountHome('codex', join(home, 'codex-accounts', codexOut))), aux, (rpc) => rpc.request('account/read', { refreshToken: false }))
      .catch(() => undefined);
  }
  const codexIn = signedIn[0] ?? null;
  const store = join(home, 'background-ai.json');
  const writeStore = (value: unknown): void => writeFileSync(store, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const runDir = join(home, 'run');
  const stateDir = projectDir(home, project);
  const coreLog = join(home, 'core.log');

  // Processes this run started carry the marker in their environment, which `ps -E` shows for every non-platform binary of this user.
  // `command` is the arguments alone: the environment (a config naming the shell wrapper or an MCP command) would match the patterns below.
  const table = (flags: string): Map<number, string> => new Map(execFileSync('ps', [flags, '-A', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 256 << 20 }).split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s(.*)$/.exec(line);
      return match === null ? [] : [[Number(match[1]), match[2]!] as const];
    }));
  const marked = (): Array<{ pid: number; command: string }> => {
    const ours = [...table('-wwE')].filter(([, line]) => line.includes(`CODERAY_BG_SMOKE=${marker}`)).map(([pid]) => pid);
    const args = table('-ww');
    return ours.flatMap((pid) => (args.has(pid) ? [{ pid, command: args.get(pid)! }] : []));
  };
  const kind = (command: string): string =>
    /setInterval\(\(\)=>\{\},1e9\)/.test(command) ? 'node -e setInterval (the spike MCP server)'
      : / serve --port/.test(command) ? 'opencode serve'
        : /app-server/.test(command) ? 'codex app-server'
          : /--json-schema/.test(command) ? 'claude -p (a background call)'
            : /main\.ts/.test(command) ? 'a core' : command.split(' ')[0]!.split('/').pop()!;
  const leftovers = async (graceMs: number): Promise<string[]> => {
    const end = Date.now() + graceMs;
    for (;;) {
      const left = marked().filter((entry) => /--json-schema|serve --port|app-server|setInterval|main\.ts/.test(entry.command));
      if (left.length === 0 || Date.now() > end) return left.map((entry) => `${kind(entry.command)} (pid ${entry.pid})`);
      await pause(250);
    }
  };
  const pidFiles = (): string[] => (existsSync(runDir) ? readdirSync(runDir).filter((name) => /\.pid\.json$/.test(name)) : []);
  const modelDirs = (): string[] => (existsSync(runDir) ? readdirSync(runDir).filter((name) => name.startsWith('model-')) : []);
  // An opencode server's password, read from its environment, so the final grep can look for it; never printed.
  const learnt = new Set<number>();
  const learnPassword = (pid: number): void => {
    if (learnt.has(pid)) return;
    learnt.add(pid);
    try {
      const line = execFileSync('ps', ['-wwE', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      const found = /OPENCODE_SERVER_PASSWORD=([0-9a-f]{64})/.exec(line)?.[1];
      if (found !== undefined) {
        hidden.add(found);
        searched.add(found);
      }
    } catch {
      // Gone already.
    }
  };
  const until = async (test: () => boolean, ms: number, every = 250): Promise<boolean> => {
    const end = Date.now() + ms;
    while (!test()) {
      if (Date.now() > end) return false;
      await pause(every);
    }
    return true;
  };

  async function startCore(label: string, bins: { claude: string; codex: string | null; opencode: string | null }): Promise<Core> {
    appendFileSync(coreLog, `\n--- ${label}: ${new Date().toISOString()} ---\n`, { mode: 0o600 });
    const args = [
      '--import', 'tsx', MAIN, '--project', project, '--ide-home', home, '--port', String(options.port), '--ui', ui,
      '--claude', bins.claude, ...(bins.codex === null ? ['--no-codex'] : ['--codex', bins.codex]), ...(bins.opencode === null ? ['--no-opencode'] : ['--opencode', bins.opencode]),
    ];
    const child: ChildProcess = spawn(process.execPath, args, { cwd: REPO, env: coreEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const startedAt = Date.now();
    // An opencode server of a background call lives a few seconds: its pid file is looked at often, and its password learnt while it runs.
    const learner = setInterval(() => {
      for (const name of pidFiles().filter((file) => file.startsWith('opencode-'))) learnPassword(Number(/\d+/.exec(name)?.[0]));
    }, 200);
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    const lines: string[] = [];
    let partial = '';
    const take = (chunk: Buffer): void => {
      appendFileSync(coreLog, chunk, { mode: 0o600 });
      partial += String(chunk);
      const parts = partial.split('\n');
      partial = parts.pop() ?? '';
      lines.push(...parts);
    };
    child.stdout!.on('data', take);
    child.stderr!.on('data', take);
    const address = await until(() => lines.some((line) => /open: http:\/\/127\.0\.0\.1:\d+\/#token=\S+/.test(line)) || child.exitCode !== null, 120_000);
    const found = lines.map((line) => /open: http:\/\/127\.0\.0\.1:(\d+)\/#token=(\S+)/.exec(line)).find((match) => match !== null);
    if (!address || found === undefined || found === null) {
      clearInterval(learner);
      child.kill('SIGKILL');
      throw new Error(`the core did not start: ${lines.slice(-3).join(' | ')}`);
    }
    hidden.add(found[2]!);
    const socket = new WebSocket(`ws://127.0.0.1:${found[1]}/ws?token=${found[2]}`);
    let map: MapSnapshot | null = null;
    let settings: SettingsView | null = null;
    const results = new Map<string, string | null>();
    const views: BackgroundAiView[] = [];
    const statuses: StatusAt[] = [];
    const groupings: GroupingAt[] = [];
    const overviews: Array<{ at: number; state: string }> = [];
    const noteStatus = (status: BackgroundAiStatus): void => {
      if (JSON.stringify(statuses.at(-1)?.status) !== JSON.stringify(status)) statuses.push({ at: Date.now(), status });
    };
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as { type: string; snapshot?: MapSnapshot; settings?: SettingsView; requestId?: string; error?: string | null };
      if (message.type === 'map.snapshot' && message.snapshot) {
        map = message.snapshot;
        const { status } = message.snapshot;
        noteStatus(status.backgroundAi);
        const last = groupings.at(-1);
        if (last === undefined || last.grouping !== status.grouping || last.groupedAt !== status.groupedAt || last.layer !== status.layer) {
          groupings.push({ at: Date.now(), grouping: status.grouping, error: status.groupingError, groupedAt: status.groupedAt, layer: status.layer });
        }
        const overview = message.snapshot.overview?.state ?? 'none';
        if (overviews.at(-1)?.state !== overview) overviews.push({ at: Date.now(), state: overview });
      } else if (message.type === 'settings.snapshot' && message.settings) {
        settings = message.settings;
        views.push(message.settings.backgroundAi);
        noteStatus(message.settings.backgroundAi.status);
      } else if (message.type === 'settings.result' && message.requestId !== undefined) {
        results.set(message.requestId, message.error ?? null);
      }
    });
    await new Promise<void>((done, fail) => {
      socket.once('open', () => done());
      socket.once('error', fail);
    });
    const send = (message: Record<string, unknown>): void => socket.send(JSON.stringify(message));
    send({ type: 'settings.get' });
    return {
      pid: child.pid!, startedAt, log: () => lines, send, views, statuses, groupings, overviews,
      request: async (message) => {
        const requestId = randomUUID();
        send({ ...message, requestId });
        await until(() => results.has(requestId), 30_000);
        return results.has(requestId) ? results.get(requestId)! : 'no answer in 30 s';
      },
      map: () => map,
      settings: () => settings,
      view: () => settings?.backgroundAi ?? null,
      stop: async () => {
        clearInterval(learner);
        socket.terminate();
        child.kill('SIGTERM');
        const gone = await Promise.race([exited.then(() => true), pause(30_000).then(() => false)]);
        if (!gone) {
          child.kill('SIGKILL');
          await exited;
        }
      },
    };
  }

  // The model Smokes 4–6 choose: --model when opencode lists it, else a free one. Auto's own pick can be a model opencode has since deprecated.
  const freeModel = (models: ModelInfo[]): ModelInfo | undefined =>
    models.find((model) => model.value === `opencode:${options.model}`) ?? models.find((model) => /free/i.test(model.value)) ?? models[0];
  const status = (core: Core): BackgroundAiStatus | null => core.map()?.status.backgroundAi ?? core.view()?.status ?? null;
  const describe = (value: BackgroundAiStatus | null): string => {
    if (value === null) return 'no status yet';
    if (value.state === 'checking') return 'checking';
    if (value.state === 'ready') return `ready · ${value.engine} (${value.modelId})${value.note === null ? '' : `, note "${value.note}"`}`;
    return `off (${value.reason}${value.engine === null ? '' : `, ${value.engine}`}): "${value.hint}"`;
  };
  const failureLines = (core: Core, engine = ''): string[] => core.log().filter((line) => line.startsWith(`background AI: ${engine}`) && line.includes(' failed: '));
  const regroupFailed = (core: Core): number => core.log().filter((line) => line.startsWith('map: regroup failed')).length;
  // A regroup the smoke asked for: the outcome of the first grouping that starts after `since` (or none started: skipped).
  async function regroup(core: Core, startMs = 30_000): Promise<{ outcome: 'done' | 'failed' | 'skipped' | 'timeout'; error: string | null; ms: number }> {
    // A grouping already running is waited for first: a regroup asked for meanwhile would join it.
    await until(() => core.map()?.status.grouping !== 'running', GROUPING_MS, 500);
    const since = Date.now();
    core.send({ type: 'map.regroup' });
    const began = await until(() => core.groupings.some((entry) => entry.at >= since && entry.grouping === 'running'), startMs);
    if (!began) return { outcome: 'skipped', error: null, ms: Date.now() - since };
    const ended = await until(() => {
      const from = core.groupings.findIndex((entry) => entry.at >= since && entry.grouping === 'running');
      return core.groupings.slice(from + 1).some((entry) => entry.grouping !== 'running');
    }, GROUPING_MS, 500);
    const from = core.groupings.findIndex((entry) => entry.at >= since && entry.grouping === 'running');
    const end = core.groupings.slice(from + 1).find((entry) => entry.grouping !== 'running');
    if (!ended || end === undefined) return { outcome: 'timeout', error: null, ms: Date.now() - since };
    return { outcome: end.grouping === 'failed' ? 'failed' : 'done', error: end.error, ms: end.at - since };
  }
  async function stopCore(core: Core, name: string): Promise<void> {
    await core.stop();
    const left = await leftovers(5_000);
    check(`${name}: no engine process of the scratch homes outlives the core`, left.length === 0 ? null : left.join(', '));
  }
  const needsOwner = (name: string, steps: string): void => verdict('NEEDS OWNER', name, steps);
  const ownerSteps = 'start `pnpm core --project examples/py-app --ide-home "$(mktemp -d /tmp/bg-ide.XXXX)" --port 4319 --ui packages/ui/dist` (after `pnpm --filter @ide/ui build`), '
    + 'sign a Codex account in through Settings → Accounts → Codex in that window, stop the core, then run `pnpm engines:smoke --engine background --ide-home <that dir>`';

  const smokes: Array<{ name: string; run: () => Promise<void> }> = [
    { name: 'Smoke 1 — no engine, then Off', run: async () => {
      rmSync(store, { force: true });
      const startsBefore = allStarts();
      const core = await startCore('smoke 1', { claude: MISSING, codex: MISSING, opencode: MISSING });
      try {
        const known = await until(() => (core.view()?.options.length ?? 0) === 3 && core.view()!.options.every((option) => option.status?.state === 'missing'), 120_000);
        const view = core.view();
        check('Smoke 1: the first-run view lists Claude Code, Codex and opencode as not installed, and is not answered yet',
          known && view?.onboarded === false ? null : `options ${JSON.stringify(view?.options.map((option) => [option.engine, option.status?.state ?? 'checking']))}, onboarded ${String(view?.onboarded)}`);
        verdict('INFO', 'Smoke 1: rows before the probe answered ("Checking…")', core.views.some((entry) => entry.options.some((option) => option.status === null)) ? 'seen' : 'not seen: the probe answered before the first snapshot');
        const answers = [await core.request({ type: 'background-ai.onboarded', onboarded: true }), await core.request({ type: 'background-ai.save', choice: { mode: 'off' } })];
        const off = await until(() => { const now = status(core); return now?.state === 'off' && now.reason === 'choice'; }, 30_000);
        check('Smoke 1: "Continue without AI" turns the background AI off by choice', off && answers.every((answer) => answer === null) ? null : `answers ${JSON.stringify(answers)}, status ${describe(status(core))}`);
        const stored = existsSync(store) ? readFileSync(store, 'utf8') : 'missing';
        check('Smoke 1: background-ai.json is {"choice":{"mode":"off"},"onboarded":true}', stored !== 'missing' && JSON.stringify(JSON.parse(stored)) === '{"choice":{"mode":"off"},"onboarded":true}' ? null : stored);
        const asked = await regroup(core, 15_000);
        await until(() => core.map() !== null, 30_000);
        const snapshot = core.map();
        const failedGrouping = core.groupings.some((entry) => entry.grouping === 'failed');
        check('Smoke 1: Off groups nothing and shows no failed grouping (a regroup asked for is skipped)',
          !failedGrouping && asked.outcome === 'skipped' && snapshot?.status.layer === 'folder' && regroupFailed(core) === 0 && failureLines(core).length === 0
            ? null : `regroup ${asked.outcome}, layer ${snapshot?.status.layer}, grouping states ${core.groupings.map((entry) => entry.grouping).join(' → ')}, ${failureLines(core).length} failure lines`);
        const state = join(stateDir, 'regroup-state.json');
        const failures = existsSync(state) ? (JSON.parse(readFileSync(state, 'utf8')) as { failures?: number }).failures : null;
        check('Smoke 1: regroup-state.json counts no failure', failures === null || failures === 0 ? null : `failures ${String(failures)}`, failures === null ? 'absent (no grouping was scheduled)' : '');
        const warnings = snapshot?.c4?.warnings ?? [];
        check('Smoke 1: the C4 warnings repeat none', new Set(warnings).size === warnings.length ? null : warnings.join(' | '));
        verdict('INFO', 'Smoke 1: C4 warnings under Off', warnings.join(' | ') || 'none');
        verdict('INFO', 'Smoke 1: the overview under Off', `${snapshot?.overview?.state ?? 'none'}${snapshot?.overview?.error ? `: ${snapshot.overview.error}` : ''}`);
        await core.request({ type: 'background-ai.save', choice: { mode: 'auto' } });
        const none = await until(() => { const now = status(core); return now?.state === 'off' && now.reason === 'none'; }, 60_000);
        const hint = status(core);
        check('Smoke 1: Auto with no engine is off with the install hint', none && hint?.state === 'off' && hint.hint.startsWith('No AI engine is installed') ? null : describe(hint));
        check('Smoke 1: no engine was started', allStarts() === startsBefore && pidFiles().length === 0 ? null : 'a start was logged or a pid file exists');
      } finally {
        await stopCore(core, 'Smoke 1');
      }
    } },

    { name: 'Smoke 2 — Codex comes in without a restart', run: async () => {
      writeStore({ choice: { mode: 'auto' }, onboarded: true });
      activate('codex', codexOut);
      const core = await startCore('smoke 2', { claude: MISSING, codex: engines.codex, opencode: null });
      try {
        const off = await until(() => { const now = status(core); return now?.state === 'off' && /Codex/.test(now.hint); }, 120_000);
        const hint = status(core);
        check('Smoke 2: with the Codex account signed out Auto is off and says so', off && hint?.state === 'off' && /signed out|sign in/i.test(hint.hint) ? null : describe(hint), describe(hint));
        const asked = await regroup(core, 15_000);
        check('Smoke 2: signed out, the map does not group and nothing fails', asked.outcome === 'skipped' && !core.groupings.some((entry) => entry.grouping === 'failed') && failureLines(core).length === 0 && core.map()?.status.layer === 'folder'
          ? null : `regroup ${asked.outcome}, ${failureLines(core).length} failure lines, layer ${core.map()?.status.layer}`);
        if (codexIn === null) {
          needsOwner('Smoke 2: sign-in without a restart → ready · Codex, the map groups, the overview fills and survives an account switch, no app-server, no files, no rollout (Q1, Q2, Q8)', ownerSteps);
          return;
        }
        const sessions = (): string[] => {
          const dir = join(home, 'codex-accounts', codexIn, 'sessions');
          return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];
        };
        const before = sessions();
        const groupedBefore = core.map()?.status.groupedAt ?? null;
        const at = Date.now();
        // An account switch stands in for the sign-in: both end in the same account change and engines probe.
        await core.request({ type: 'account.select', engine: 'codex', id: codexIn });
        const ready = await until(() => { const now = status(core); return now?.state === 'ready' && now.engine === 'codex'; }, 180_000);
        check('Smoke 2: after the sign-in the status is ready · Codex without a restart', ready ? null : describe(status(core)), `${seconds(Date.now() - at)}, ${describe(status(core))}`);
        const grouped = await until(() => core.groupings.some((entry) => entry.at >= at && entry.layer === 'ai' && entry.grouping === 'idle' && entry.groupedAt !== groupedBefore), GROUPING_MS, 500);
        const outcome = grouped ? { outcome: 'done', error: null } : await regroup(core);
        check('Smoke 2: the map groups on Codex (Q1: the real grouping schema; Q2: no tool started, or the tripwire would have failed it)', grouped || outcome.outcome === 'done' ? null : `${outcome.outcome}: ${outcome.error ?? ''}`, `${seconds(Date.now() - at)}`);
        if (core.map()?.overview?.state !== 'ready') core.send({ type: 'map.overview' });
        const filled = await until(() => core.map()?.overview?.state === 'ready', GROUPING_MS, 500);
        check('Smoke 2: the overview fills', filled ? null : `${core.map()?.overview?.state}: ${core.map()?.overview?.error ?? ''}`);
        const kept = JSON.stringify(core.map()?.overview?.groups ?? []);
        const switched = Date.now();
        await core.request({ type: 'account.select', engine: 'codex', id: codexOut });
        await until(() => status(core)?.state === 'off', 120_000);
        await core.request({ type: 'account.select', engine: 'codex', id: codexIn });
        await until(() => status(core)?.state === 'ready', 120_000);
        await pause(20_000);
        const rebuilt = core.overviews.some((entry) => entry.at >= switched && entry.state === 'running');
        check('Smoke 2: the overview survives a second account switch (not generated again)', !rebuilt && JSON.stringify(core.map()?.overview?.groups ?? []) === kept ? null : `overview states since the switch: ${core.overviews.filter((entry) => entry.at >= switched).map((entry) => entry.state).join(' → ')}`);
        await until(() => core.map()?.status.grouping !== 'running' && core.map()?.overview?.state !== 'running', GROUPING_MS, 500);
        const servers = await until(() => !marked().some((entry) => /app-server/.test(entry.command)), 10_000);
        check('Smoke 2: after the calls no codex app-server of the scratch homes runs', servers ? null : 'one still runs');
        check('Smoke 2: the calls left no file in the project', git('status', '--porcelain') === '' ? null : git('status', '--porcelain'));
        check('Smoke 2: the run directory keeps no model-* directory', modelDirs().length === 0 ? null : modelDirs().join(', '));
        const added = sessions().filter((entry) => !before.includes(entry));
        check("Smoke 2: the account home's sessions/ gained no rollout (Q8)", added.length === 0 ? null : `${added.length} new entries`);
      } finally {
        await stopCore(core, 'Smoke 2');
      }
    } },

    { name: 'Smoke 3 — handover from a signed-out Claude', run: async () => {
      writeStore({ choice: { mode: 'auto' }, onboarded: true });
      rmSync(join(xdg.XDG_CONFIG_HOME, 'opencode'), { recursive: true, force: true });
      activate('claude', claudeOut);
      activate('codex', codexIn ?? codexOut);
      const landing = codexIn === null ? 'opencode' : 'codex';
      const core = await startCore('smoke 3', { claude: engines.claude, codex: engines.codex, opencode: engines.opencode });
      try {
        const onClaude = await until(() => { const now = status(core); return now?.state === 'ready' && now.engine === 'claude'; }, 180_000);
        check('Smoke 3: Claude on the PATH with a signed-out account is picked first (its --version answers)', onClaude ? null : describe(status(core)), describe(status(core)));
        const asked = Date.now();
        const groupedBefore = core.map()?.status.groupedAt ?? null;
        if (core.map()?.status.grouping !== 'running') core.send({ type: 'map.regroup' });
        const failedOnClaude = await until(() => failureLines(core, 'Claude Code').length > 0, 240_000);
        const failedAt = Date.now();
        const moved = await until(() => { const now = status(core); return now?.state === 'ready' && now.engine !== 'claude'; }, 240_000);
        const movedAt = Date.now();
        const now = status(core);
        check(`Smoke 3: the first call fails on Claude and the next lands on ${landing}, with the reason in the status note`,
          failedOnClaude && moved && now?.state === 'ready' && now.engine === landing && (now.note ?? '').startsWith('Claude Code failed:') ? null : `${failureLines(core, 'Claude Code').length} Claude failure lines; ${describe(now)}`,
          `failed after ${seconds(failedAt - asked)}, ${landing} picked ${seconds(movedAt - failedAt)} later: ${describe(now)}`);
        const groupedNow = (): boolean => core.groupings.some((entry) => entry.at >= failedAt && entry.grouping === 'idle' && entry.layer === 'ai' && entry.groupedAt !== null && entry.groupedAt !== groupedBefore);
        // A grouping that failed on the new engine too, with nothing left to pick, ends the wait.
        await until(() => groupedNow() || (core.groupings.some((entry) => entry.at >= failedAt && entry.grouping === 'failed') && status(core)?.state === 'off'), GROUPING_MS, 500);
        const grouped = groupedNow();
        const last = core.groupings.at(-1);
        verdict(grouped ? 'PASS' : 'INFO', `Smoke 3: the map groups on ${landing} after the handover, without a restart`, grouped ? `${seconds(Date.now() - asked)} after the regroup was asked` : `not grouped: ${last?.grouping} ${last?.error ?? ''}`);
        const again = await regroup(core);
        verdict('INFO', `Smoke 3: one more regroup on ${landing}`, `${again.outcome} in ${seconds(again.ms)}${again.error ? `: ${again.error}` : ''}`);
        const window = Date.now() - failedAt;
        // A background call is the claude run with --json-schema; the failing call's own retries end before its log line.
        const later = starts('claude', failedAt + 2_000).filter((line) => line.includes('--json-schema'));
        check('Smoke 3: Claude is not run again for a background call after it failed (parked for 10 minutes)', later.length === 0 && failureLines(core, 'Claude Code').length === 1 ? null : `${later.length} claude -p starts, ${failureLines(core, 'Claude Code').length} failure lines`, `watched ${seconds(window)} of the 10 minutes`);
        verdict('INFO', 'Smoke 3: the failure line', failureLines(core, 'Claude Code')[0] ?? 'none');
        verdict('INFO', 'Smoke 3: status transitions', core.statuses.map((entry) => `+${seconds(entry.at - core.startedAt)} ${describe(entry.status)}`).join(' → '));
      } finally {
        await stopCore(core, 'Smoke 3');
      }
    } },

    { name: 'Smoke 4 — opencode chosen, a user MCP server, then gone', run: async () => {
      const userConfig = join(xdg.XDG_CONFIG_HOME, 'opencode');
      mkdirSync(userConfig, { recursive: true });
      writeFileSync(join(userConfig, 'opencode.json'), JSON.stringify(SPIKE_MCP));
      writeStore({ choice: { mode: 'auto' }, onboarded: true });
      activate('codex', codexIn ?? codexOut);
      let chosen: ModelInfo | undefined;
      const core = await startCore('smoke 4', { claude: MISSING, codex: engines.codex, opencode: engines.opencode });
      let spikeSeen = 0;
      const watch = setInterval(() => {
        try {
          if (marked().some((entry) => /setInterval\(\(\)=>\{\},1e9\)/.test(entry.command))) spikeSeen += 1;
        } catch {
          // ps failed once under load: the next tick looks again.
        }
      }, 1_000);
      try {
        const listed = await until(() => (core.view()?.options.find((option) => option.engine === 'opencode')?.models.length ?? 0) > 0, 180_000);
        const models = core.view()?.options.find((option) => option.engine === 'opencode')?.models ?? [];
        chosen = freeModel(models);
        check('Smoke 4: the user MCP server does not stop the probe: opencode lists its models', listed && chosen !== undefined ? null : describe(status(core)), `${models.length} models; chosen ${chosen?.value}`);
        if (chosen === undefined) return;
        const answer = await core.request({ type: 'background-ai.save', choice: { mode: 'engine', engine: 'opencode', model: chosen.value } });
        const ready = await until(() => { const now = status(core); return now?.state === 'ready' && now.engine === 'opencode' && now.modelId === chosen!.value; }, 120_000);
        check('Smoke 4: Choose an engine → opencode → a free model is ready', answer === null && ready ? null : `${answer ?? ''} ${describe(status(core))}`);
        const outcomes = [];
        for (let round = 0; round < 3; round += 1) outcomes.push(await regroup(core));
        const done = outcomes.filter((entry) => entry.outcome === 'done').length;
        const misses = outcomes.filter((entry) => /JSON|schema/i.test(entry.error ?? '')).length;
        const refusal = core.log().filter((line) => /would start the MCP server|would allow|would ask/.test(line));
        verdict(done > 0 ? 'PASS' : 'INFO', 'Smoke 4: the map groups on the free model with the user MCP server present', outcomes.map((entry) => `${entry.outcome} in ${seconds(entry.ms)}${entry.error ? ` (${entry.error})` : ''}`).join('; '));
        check('Smoke 4: no "would start the MCP server" refusal', refusal.length === 0 ? null : refusal.join(' | '));
        check('Smoke 4: the user MCP server (node -e setInterval) never ran during the calls', spikeSeen === 0 ? null : `seen on ${spikeSeen} ticks`);
        verdict('INFO', 'Smoke 4: schema misses over three regroups (one failure parks opencode for 10 minutes)', `${misses} of 3; ${failureLines(core).length} failure lines: ${failureLines(core).join(' | ') || 'none'}`);
        // Q7: the profile's own server lists no background session afterwards.
        const listing = ownServer(['spike']);
        hidden.add(listing.password);
        try {
          const { client } = await listing.ready;
          const sessions = await client.get<unknown>('/session');
          const titles = Array.isArray(sessions) ? sessions.map((session) => (isRecord(session) ? String(session.title) : '?')) : [];
          check("Smoke 4: the profile's GET /session lists no background session afterwards (Q7)", titles.includes(SESSION_TITLE) ? `${titles.filter((title) => title === SESSION_TITLE).length} left` : null, `${titles.length} sessions`);
        } finally {
          await listing.kill();
        }
      } finally {
        clearInterval(watch);
        await stopCore(core, 'Smoke 4');
      }
      const again = await startCore('smoke 4, opencode gone', { claude: MISSING, codex: engines.codex, opencode: MISSING });
      try {
        const off = await until(() => { const now = status(again); return now?.state === 'off' && now.reason === 'unavailable'; }, 120_000);
        const now = status(again);
        check('Smoke 4: with opencode gone the explicit choice is off ("opencode is not installed … Choose another engine")',
          off && now?.state === 'off' && now.engine === 'opencode' && /opencode is not installed/i.test(now.hint) && /Choose another engine/.test(now.hint) ? null : describe(now), describe(now));
        const stored = JSON.parse(readFileSync(store, 'utf8')) as { choice?: { mode?: string; engine?: string } };
        check('Smoke 4: Auto is not applied in its place', stored.choice?.mode === 'engine' && stored.choice.engine === 'opencode' ? null : JSON.stringify(stored.choice));
        await again.request({ type: 'background-ai.save', choice: { mode: 'auto' } });
        if (codexIn === null) {
          await until(() => status(again)?.state === 'off' && (status(again) as { reason?: string }).reason === 'none', 120_000);
          verdict('INFO', 'Smoke 4: Auto with the Codex account signed out', describe(status(again)));
          needsOwner('Smoke 4: after switching to Auto, Codex answers', ownerSteps);
          return;
        }
        const ready = await until(() => { const value = status(again); return value?.state === 'ready' && value.engine === 'codex'; }, 180_000);
        const grouped = ready ? await regroup(again) : { outcome: 'not ready', error: null, ms: 0 };
        check('Smoke 4: after switching to Auto, Codex answers', grouped.outcome === 'done' ? null : `${describe(status(again))}; ${grouped.outcome} ${grouped.error ?? ''}`);
      } finally {
        await stopCore(again, 'Smoke 4 (opencode gone)');
      }
    } },

    { name: 'Smoke 6 — a user allow in opencode\'s config', run: async () => {
      const userConfig = join(xdg.XDG_CONFIG_HOME, 'opencode');
      mkdirSync(userConfig, { recursive: true });
      writeFileSync(join(userConfig, 'opencode.json'), JSON.stringify({ permission: { bash: 'allow' } }));
      const echo = ownServer([]);
      hidden.add(echo.password);
      let predicted: string | null = null;
      try {
        const { client } = await echo.ready;
        const agents = await client.get<unknown>('/agent');
        predicted = denyAllProblem(agents, toolOutputGlob(opencodeEnv({ ...opencodeCommand(engines.opencode), env: xdg })));
        const build = Array.isArray(agents) ? agents.find((agent) => isRecord(agent) && agent.name === 'build') : undefined;
        const rules = isRecord(build) && Array.isArray(build.permission) ? build.permission.map((rule) => (isRecord(rule) ? `${String(rule.permission)} ${String(rule.pattern)} ${String(rule.action)}` : '?')) : [];
        const lastDeny = rules.lastIndexOf('* * deny');
        const userAllow = rules.findIndex((rule) => rule.startsWith('bash ') && rule.endsWith(' allow'));
        verdict('INFO', 'Smoke 6: GET /agent echo of the build agent', `${rules.length} rules; the user's bash allow at ${userAllow}, the last * * deny at ${lastDeny} (${userAllow > lastDeny ? 'after' : 'before'} it); denyAllProblem: ${predicted ?? 'none'}; agents in use: ${AGENTS_IN_USE.join(', ')}`);
        verdict('INFO', 'Smoke 6: the build agent\'s rules', rules.join(' | '));
      } finally {
        await echo.kill();
      }
      // Chosen before the core starts: its own first grouping makes the first call, and a failed call parks opencode for the rest.
      writeStore({ choice: { mode: 'engine', engine: 'opencode', model: `opencode:${options.model}` }, onboarded: true });
      const listed = await startCore('smoke 6', { claude: MISSING, codex: null, opencode: engines.opencode });
      let shellRan = 0;
      const watch = setInterval(() => {
        try {
          if (marked().some((entry) => /^\S*opencode-shell\//.test(entry.command))) shellRan += 1;
        } catch {
          // The next tick looks again.
        }
      }, 1_000);
      try {
        await until(() => { const now = status(listed); return now !== null && now.state !== 'checking'; }, 180_000);
        const outcome = status(listed)?.state === 'ready' ? await regroup(listed) : { outcome: 'not ready', error: null, ms: 0 };
        const refusals = listed.log().filter((line) => /would allow bash/.test(line));
        const failure = failureLines(listed, 'opencode')[0] ?? null;
        const happened = refusals.length > 0 ? `refused: "${refusals[0]}" (${refusals.length} line(s)); status ${describe(status(listed))}`
          : failure !== null ? `not refused: the call reached the model and failed there: ${failure}` : `answered: regroup ${outcome.outcome}${outcome.error ? ` (${outcome.error})` : ''}`;
        verdict('INFO', 'Smoke 6: what a user-global bash allow did', happened);
        check('Smoke 6: what happened matches the echo (a refusal once when the allow comes after the deny, else the deny wins)',
          predicted === null ? (refusals.length === 0 ? null : 'refused though the deny came last') : (refusals.length === 1 && status(listed)?.state === 'off' ? null : `${refusals.length} refusal lines, ${describe(status(listed))}`));
        check('Smoke 6: no tool ran (no process in the shell wrapper)', shellRan === 0 ? null : `seen on ${shellRan} ticks`);
      } finally {
        clearInterval(watch);
        await stopCore(listed, 'Smoke 6');
        rmSync(join(xdg.XDG_CONFIG_HOME, 'opencode'), { recursive: true, force: true });
      }
    } },

    { name: 'Smoke 5 — Stop and abort mid-call', run: async () => {
      rmSync(join(xdg.XDG_CONFIG_HOME, 'opencode'), { recursive: true, force: true });
      // Chosen before the core starts, so the core's own first call is the one caught: one asked for later could find opencode parked.
      writeStore({ choice: { mode: 'engine', engine: 'opencode', model: `opencode:${options.model}` }, onboarded: true });
      const core = await startCore('smoke 5', { claude: MISSING, codex: null, opencode: engines.opencode });
      try {
        const own = (): boolean => modelDirs().some((dir) => dir.startsWith(`model-${core.pid}-`));
        let started = await until(own, 60_000, 100);
        if (!started && status(core)?.state === 'ready') {
          core.send({ type: 'map.regroup' });
          started = await until(own, 60_000, 100);
        }
        // The call's server is the one whose working directory is the call's model directory; the probe's is the project.
        const cwdOf = (pid: number): string => {
          try {
            return execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').find((line) => line.startsWith('n'))?.slice(1) ?? '';
          } catch {
            return '';
          }
        };
        const served = started && await until(() => own() && pidFiles().some((file) => file.startsWith('opencode-')), 10_000, 50);
        const pids = pidFiles().filter((file) => file.startsWith('opencode-')).map((file) => Number(/\d+/.exec(file)?.[0]));
        const inCall = pids.filter((pid) => cwdOf(pid).startsWith(join(runDir, `model-${core.pid}-`)));
        verdict('INFO', 'Smoke 5: caught mid-call', `${pids.length} opencode server(s) running, ${inCall.length} of them in the call's directory; status ${describe(status(core))}`);
        if (!served) {
          const seen = pidFiles().map((file) => `${file} in ${cwdOf(Number(/\d+/.exec(file)?.[0])) || 'no cwd'}`).join(', ') || 'no pid file';
          verdict('FAIL', 'Smoke 5: no opencode call was caught running', `${started ? `a model directory (${modelDirs().join(', ')}), but no server in it: ${seen}` : 'no model directory'}; ${describe(status(core))}`);
          return;
        }
        const at = Date.now();
        await core.stop();
        const gone = await until(() => pids.every((pid) => !isAlive(pid)), 5_000, 100);
        const left = await leftovers(0);
        check('Smoke 5: closing the project mid-call leaves no opencode serve of the scratch home within 5 s', gone && left.length === 0 ? null : `alive: ${pids.filter((pid) => isAlive(pid)).join(', ')}; ${left.join(', ')}`, `${seconds(Date.now() - at)}`);
        check('Smoke 5: the pid directory is empty', pidFiles().length === 0 ? null : pidFiles().join(', '));
        verdict('INFO', 'Smoke 5: model-* directories after the stop (the next core sweeps them)', modelDirs().join(', ') || 'none');
      } finally {
        await core.stop();
      }
      needsOwner('Smoke 5: the same on Codex (a regroup on Codex, then close the project mid-turn)', ownerSteps);
    } },

    { name: 'Smoke 7 — secrets', run: async () => {
      // A key that looks real to the masks and that OpenAI rejects; it lives only in this run and in the scratch account's auth.json.
      const bogus = `sk-proj-${randomBytes(24).toString('hex')}`;
      hidden.add(bogus);
      searched.add(bogus);
      writeStore({ choice: { mode: 'auto' }, onboarded: true });
      const core = await startCore('smoke 7', { claude: MISSING, codex: engines.codex, opencode: null });
      try {
        await until(() => core.settings() !== null, 30_000);
        const before = new Set(core.settings()?.accounts.engines.find((entry) => entry.engine === 'codex')?.accounts.map((account) => account.id) ?? []);
        const started = await core.request({ type: 'account.login.start', engine: 'codex', method: 'api-key', apiKey: bogus });
        const added = await until(() => (core.settings()?.accounts.engines.find((entry) => entry.engine === 'codex')?.accounts ?? []).some((account) => !before.has(account.id)) || core.settings()?.accounts.login.state === 'error', 120_000);
        const account = core.settings()?.accounts.engines.find((entry) => entry.engine === 'codex')?.accounts.find((entry) => !before.has(entry.id));
        if (!added || account === undefined) {
          verdict('FAIL', 'Smoke 7: the API-key account was not added', `${started ?? ''} ${core.settings()?.accounts.login.error ?? ''}`);
          return;
        }
        await core.request({ type: 'account.select', engine: 'codex', id: account.id });
        const picked = await until(() => { const now = status(core); return now !== null && now.state !== 'checking' && (now.state === 'ready' || /Codex/.test(now.hint)); }, 180_000);
        verdict('INFO', 'Smoke 7: the API-key account once selected', picked ? describe(status(core)) : `not settled: ${describe(status(core))}`);
        if (status(core)?.state === 'ready') await regroup(core);
        await until(() => { const now = status(core); return now?.state === 'off' && /Codex/.test(now.hint); }, 180_000, 500);
        const seen = [...core.statuses.map((entry) => JSON.stringify(entry.status)), JSON.stringify(core.settings()?.accounts ?? {})];
        const leaked = seen.some((text) => text.includes(bogus));
        const hint = status(core);
        check('Smoke 7: no status, note, hint or account view carries the key', leaked ? 'the key is shown' : null);
        verdict(hint?.state === 'off' && hint.hint.includes('[key hidden]') ? 'PASS' : 'INFO', 'Smoke 7: the hint after OpenAI rejected the key', describe(hint));
      } finally {
        await stopCore(core, 'Smoke 7');
      }
    } },
  ];

  // Paths only, unscrubbed: a kept home is the one to look into.
  console.log(`INFO $IDE_HOME = ${home}${options.keep || given !== undefined ? '' : ' (removed at the end)'}; $SCRATCH = ${root}; Codex accounts signed in by the owner: ${signedIn.length}`);
  try {
    for (const smoke of smokes) {
      if (only !== null && !only.test(smoke.name)) continue;
      const at = Date.now();
      say(`--- ${smoke.name}`);
      try {
        await smoke.run();
      } catch (error) {
        verdict('FAIL', `${smoke.name} threw`, (error as Error).message);
      }
      say(`INFO ${smoke.name} took ${seconds(Date.now() - at)}`);
    }
    // Smoke 7, after every smoke: the log and the store keep no key, token or password, and no file of the home keeps an opencode password.
    const texts = [coreLog, store].filter((file) => existsSync(file)).map((file) => readFileSync(file, 'utf8'));
    // The brief's grep is literal; "sk-" also matches words such as "task-", so a key is "sk-" not inside a word, followed by key characters.
    const literal = texts.flatMap((text) => text.match(/sk-|eyJ|OPENCODE_SERVER_PASSWORD/g) ?? []);
    const keys = texts.flatMap((text) => text.match(/(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}|eyJ[\w-]{8,}\.|OPENCODE_SERVER_PASSWORD/g) ?? []);
    const known = [...searched].filter((secret) => texts.some((text) => text.includes(secret)));
    const masked = texts.reduce((sum, text) => sum + (text.match(/\[key hidden\]/g) ?? []).length, 0);
    check("Smoke 7: core.log and background-ai.json keep no key, token or opencode password (grep 'sk-|eyJ|OPENCODE_SERVER_PASSWORD|<the bogus key>')",
      keys.length === 0 && known.length === 0 ? null : `${keys.length} key-shaped matches, ${known.length} known secrets`,
      `literal grep: ${literal.length} match(es); "[key hidden]" in the log: ${masked}`);
    const passwords = [...searched].filter((secret) => /^[0-9a-f]{64}$/.test(secret));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'models') walk(path);
        else if (entry.isFile() && statSync(path).size < 8 << 20 && passwords.some((password) => readFileSync(path, 'utf8').includes(password))) files.push(path);
      }
    };
    walk(home);
    if (passwords.length === 0) verdict('INFO', 'Smoke 7: no opencode server password was learned (no opencode call ran), so none was looked for');
    else check(`Smoke 7: no file under $IDE_HOME keeps an opencode server password (${passwords.length} learned from running servers)`, files.length === 0 ? null : files.join(', '));
  } finally {
    const left = await leftovers(5_000);
    for (const entry of marked()) {
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
    check('the run leaves no process of its scratch homes', left.length === 0 ? null : left.join(', '));
    if (!options.keep && given === undefined) rmSync(home, { recursive: true, force: true });
    if (!options.keep) rmSync(root, { recursive: true, force: true });
    say(`${failed === 0 ? 'all checks passed' : `${failed} failed`}${options.keep ? '; kept $IDE_HOME and $SCRATCH' : ''}`);
  }
  return failed === 0 ? 0 : 1;
}
