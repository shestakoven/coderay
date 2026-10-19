import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ENGINE_CAPABILITIES, formatModelId, isEffortFor, parseModelId, type EngineState, type EngineStatus, type ModelInfo } from '@ide/protocol';
import type { AccountHome } from '../../accounts/account-homes';
import { isRecord } from '../../json';
import { opencodeEnv, type OpencodeCommand } from '../opencode/command';
import { inlineConfig } from '../opencode/config';
import { HARDENING_ENV, shellWrapper, withServer } from '../opencode/server';
import { startOpencodeTransport } from '../opencode/transport';
import { isOlderVersion, MIN_OPENCODE_VERSION } from '../tools';
import type { Engine } from './registry';

const run = promisify(execFile);
// How long opencode gets to print its version, and its server to say where it listens.
const PROBE_TIMEOUT_MS = 15_000;
// After it listens: the health check, the catalog, and the stop.
const ANSWER_MS = 5_000;
const REUSE_MS = 60_000;

/** What to do when no provider is connected: System connects one with opencode itself, a profile in Settings. */
export function signedOutHint(home: AccountHome): string {
  return home.dir === null
    ? 'Run opencode auth login in a terminal to connect a provider, or pick a free opencode/* model.'
    : 'Add a provider key to this profile in Settings → Accounts, or pick a free opencode/* model.';
}

/** For a chat whose model is of a provider opencode has not connected (1.19: "Model not found: <provider>/<model>"). */
export function providerHint(providerID: string, home: AccountHome): string {
  return `opencode has no provider "${providerID}" connected for this model. ${signedOutHint(home)}`;
}

export interface CatalogModel { value: string; name: string; efforts: string[]; context: number | null }

const text = (value: unknown, fallback: string): string => (typeof value === 'string' && value !== '' ? value : fallback);

/** The catalog's models with their variants and context limits, as `GET /config/providers` answers. */
export function catalogModels(answer: unknown): CatalogModel[] {
  const providers = isRecord(answer) && Array.isArray(answer.providers) ? answer.providers : [];
  return providers.flatMap((provider: unknown) => {
    if (!isRecord(provider) || typeof provider.id !== 'string' || !isRecord(provider.models)) return [];
    const providerName = text(provider.name, provider.id);
    return Object.values(provider.models).flatMap((model): CatalogModel[] => {
      if (!isRecord(model) || typeof model.id !== 'string') return [];
      const value = formatModelId({ engine: 'opencode', model: `${provider.id}/${model.id}` });
      if (parseModelId(value) === null) return [];
      const efforts = isRecord(model.variants) ? Object.keys(model.variants).filter((variant) => isEffortFor('opencode', variant)) : [];
      const context = isRecord(model.limit) ? model.limit.context : undefined;
      // A context of 0 is a catalog that does not know it, and no meter can be drawn against it.
      return [{ value, name: `${providerName} · ${text(model.name, model.id)}`, efforts, context: typeof context === 'number' && Number.isFinite(context) && context > 0 ? context : null }];
    });
  });
}

export interface OpencodeProbe { status: EngineStatus; models: ModelInfo[] }

const firstLine = (error: unknown): string => (error as Error).message.split('\n')[0] ?? '';

/**
 * One short-lived server answers both: the state (missing, old, error, ready) and, when ready, the models. It never rejects.
 * With `runDir` the server's pid file and shell wrapper live there, so a core killed mid-probe leaves the reaper an orphan to find.
 */
export async function opencodeProbe(command: OpencodeCommand, cwd: string, userServers: string[], timeoutMs = PROBE_TIMEOUT_MS, runDir?: string): Promise<OpencodeProbe> {
  const notReady = (state: EngineState, hint: string): OpencodeProbe => ({ status: { engine: 'opencode', state, hint }, models: [] });
  let stdout: string;
  try {
    ({ stdout } = await run(command.command, [...command.args, '--version'], { env: opencodeEnv(command, HARDENING_ENV), timeout: timeoutMs }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return notReady('missing', 'Install opencode: opencode is not on the PATH.');
    if ((error as { killed?: boolean }).killed) return notReady('error', `opencode --version did not answer in ${timeoutMs / 1000} s.`);
    return notReady('error', `opencode --version failed: ${firstLine(error)}`);
  }
  const version = /\d+\.\d+\.\d+/.exec(stdout)?.[0];
  if (version === undefined) return notReady('error', 'opencode --version printed no version.');
  if (isOlderVersion(version, MIN_OPENCODE_VERSION)) return notReady('old', `Update opencode to ${MIN_OPENCODE_VERSION} or newer.`);
  // The server runs no command, but its config names a shell, and only the wrapper may be one.
  let own: string | null = null;
  try {
    const dir = runDir ?? (own = mkdtempSync(join(tmpdir(), 'coderay-opencode-probe-')));
    const configContent = inlineConfig({ config: {}, names: [] }, userServers, shellWrapper(dir));
    // The listening timeout ends first, so a server that never listens is reported with the reason it gave.
    const answer = await withServer(command, cwd, (client) => client.get('/config/providers'), { configContent, listenTimeoutMs: timeoutMs, pidDir: runDir }, timeoutMs + ANSWER_MS);
    const models = catalogModels(answer).map(({ value, name, efforts }): ModelInfo => ({ value, name, engine: 'opencode', efforts }));
    return { status: { engine: 'opencode', state: 'ready', hint: null }, models };
  } catch (error) {
    return notReady('error', `opencode serve did not start: ${firstLine(error)}`);
  } finally {
    if (own !== null) rmSync(own, { recursive: true, force: true });
  }
}

export async function opencodeStatus(command: OpencodeCommand, cwd: string, userServers: string[], timeoutMs?: number): Promise<EngineStatus> {
  return (await opencodeProbe(command, cwd, userServers, timeoutMs)).status;
}

export async function opencodeModels(command: OpencodeCommand, cwd: string, userServers: string[]): Promise<ModelInfo[]> {
  return (await opencodeProbe(command, cwd, userServers)).models;
}

export interface OpencodeEngineOptions {
  /** opencode under the active profile. */
  command: () => OpencodeCommand;
  cwd: string;
  /** The user's MCP servers, switched off by name on every server CodeRay starts. */
  userServers: () => string[];
  /** The active profile's name, or null while opencode has no profile of CodeRay's. */
  account?: () => string | null;
  /** The core's run directory, for the probe server's pid file and shell wrapper. */
  runDir?: string;
}

export function opencodeEngine(options: OpencodeEngineOptions): Engine {
  // A refresh asks for the state, then the models: both come from the one server the state started.
  let last: { at: number; probe: Promise<OpencodeProbe> } | null = null;
  const probe = (): Promise<OpencodeProbe> => {
    const started = opencodeProbe(options.command(), options.cwd, options.userServers(), undefined, options.runDir);
    last = { at: Date.now(), probe: started };
    return started;
  };
  return {
    id: 'opencode',
    capabilities: ENGINE_CAPABILITIES.opencode,
    status: async () => {
      const { status } = await probe();
      const account = options.account?.() ?? null;
      return account === null ? status : { ...status, account };
    },
    listModels: async () => (await (last !== null && Date.now() - last.at < REUSE_MS ? last.probe : probe())).models,
    start: (launch, sink) => {
      if (!('opencode' in launch)) throw new Error(`The opencode engine cannot start a ${launch.engine} chat.`);
      return startOpencodeTransport(launch, sink);
    },
  };
}
