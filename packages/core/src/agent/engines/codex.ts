import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ENGINE_CAPABILITIES, formatModelId, isEffortFor, parseModelId, type EngineStatus, type ModelInfo } from '@ide/protocol';
import type { AccountHome } from '../../accounts/account-homes';
import { codexBackgroundProblem, CodexModel, pickCodexModel } from '../../models/codex-model';
import { withAppServer } from '../codex/app-server';
import { codexEnv, type CodexCommand } from '../codex/command';
import type { GetAccountResponse, Model, ModelListResponse } from '../codex/protocol';
import type { JsonRpc } from '../codex/rpc';
import { startCodexTransport } from '../codex/transport';
import { isOlderVersion, MIN_CODEX_VERSION } from '../tools';
import type { Engine } from './registry';

const run = promisify(execFile);
const VERSION_TIMEOUT_MS = 10_000;

/** What to do when Codex is signed out: System signs in with codex itself, an account of CodeRay's again in Settings. */
export function signedOutHint(home: AccountHome): string {
  return home.dir === null
    ? 'Codex is signed out: run codex login, or add an account in Settings → Accounts.'
    : 'This Codex account is signed out: remove it in Settings → Accounts and add it again.';
}

export function keyRejectedHint(home: AccountHome): string {
  return home.dir === null
    ? 'OpenAI rejected the API key Codex is signed in with: run codex login with a valid key, or add an account in Settings → Accounts.'
    : 'OpenAI rejected the key of this Codex account: remove it in Settings → Accounts and add it again.';
}

/** Whether codex can run a chat under the given account: found, not older than the verified version, and signed in. */
export async function codexStatus(codex: CodexCommand, cwd: string, signedOut: string, timeoutMs = VERSION_TIMEOUT_MS): Promise<EngineStatus> {
  let stdout: string;
  try {
    ({ stdout } = await run(codex.command, [...codex.args, '--version'], { env: codexEnv(codex), timeout: timeoutMs }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { engine: 'codex', state: 'missing', hint: 'Install Codex: codex is not on the PATH.' };
    if ((error as { killed?: boolean }).killed) return { engine: 'codex', state: 'error', hint: `codex --version did not answer in ${timeoutMs / 1000} s.` };
    return { engine: 'codex', state: 'error', hint: `codex --version failed: ${(error as Error).message.split('\n')[0]}` };
  }
  const version = /\d+\.\d+\.\d+/.exec(stdout)?.[0];
  if (version === undefined) return { engine: 'codex', state: 'error', hint: 'codex --version printed no version.' };
  if (isOlderVersion(version, MIN_CODEX_VERSION)) return { engine: 'codex', state: 'old', hint: `Update Codex to ${MIN_CODEX_VERSION} or newer.` };
  try {
    const answer = await withAppServer(codex, cwd, (rpc) => rpc.request<GetAccountResponse>('account/read', { refreshToken: false }));
    return answer.account === null ? { engine: 'codex', state: 'signed-out', hint: signedOut } : { engine: 'codex', state: 'ready', hint: null };
  } catch (error) {
    return { engine: 'codex', state: 'error', hint: `codex app-server did not start: ${(error as Error).message.split('\n')[0]}` };
  }
}

/** Every page of codex's `model/list`. */
async function modelList(rpc: JsonRpc): Promise<Model[]> {
  const models: Model[] = [];
  let cursor: string | null = null;
  do {
    const page: ModelListResponse = await rpc.request<ModelListResponse>('model/list', cursor === null ? {} : { cursor });
    models.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return models;
}

/** codex's model catalog (not an entitlement check), hidden models left out, each with the efforts it lists. */
export function codexModels(codex: CodexCommand, cwd: string): Promise<ModelInfo[]> {
  return withAppServer(codex, cwd, async (rpc) => (await modelList(rpc)).flatMap((model): ModelInfo[] => {
    const value = formatModelId({ engine: 'codex', model: model.id });
    if (model.hidden || parseModelId(value) === null) return [];
    const efforts = model.supportedReasoningEfforts.map((option) => option.reasoningEffort).filter((effort) => isEffortFor('codex', effort));
    return [{ value, name: model.displayName, engine: 'codex', efforts }];
  }));
}

export interface CodexEngineOptions {
  /** codex under the active Codex account. */
  command: () => CodexCommand;
  cwd: string;
  signedOut: () => string;
  /** The active account's name, or null while Codex has no account of CodeRay's. */
  account?: () => string | null;
  /** The core's run directory, where a background call runs; without it the engine runs none. */
  runDir?: string;
}

export function codexEngine(options: CodexEngineOptions): Engine {
  return {
    id: 'codex',
    capabilities: ENGINE_CAPABILITIES.codex,
    status: async () => {
      const status = await codexStatus(options.command(), options.cwd, options.signedOut());
      const account = options.account?.() ?? null;
      return account === null ? status : { ...status, account };
    },
    listModels: () => codexModels(options.command(), options.cwd),
    start: (launch, sink) => {
      if (!('codex' in launch)) throw new Error(`The Codex engine cannot start a ${launch.engine} chat.`);
      return startCodexTransport(launch, sink);
    },
    background: async (model) => {
      const runDir = options.runDir;
      const ref = model === null ? null : parseModelId(model);
      if (runDir === undefined || (model !== null && ref?.engine !== 'codex')) return null;
      // The version first, from the same app-server: an unverified one is a reason, never a call that fails.
      const picked = await withAppServer(
        options.command(), options.cwd, async (rpc, hello) => codexBackgroundProblem(hello.userAgent) ?? pickCodexModel(await modelList(rpc), ref?.model ?? null), undefined, runDir,
      );
      if (picked === null || typeof picked === 'string') return picked;
      return {
        modelId: formatModelId({ engine: 'codex', model: picked.id }),
        model: new CodexModel({ command: options.command, model: picked.id, effort: picked.effort, runDir }),
      };
    },
  };
}
