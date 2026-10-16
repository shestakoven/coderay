import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { formatModelId, isEffortFor, parseModelId, type EngineStatus, type ModelInfo } from '@ide/protocol';
import type { AccountHome } from '../../accounts/account-homes';
import { withAppServer } from '../codex/app-server';
import { codexEnv, type CodexCommand } from '../codex/command';
import type { GetAccountResponse, ModelListResponse } from '../codex/protocol';
import { isOlderVersion, MIN_CODEX_VERSION } from '../tools';

const run = promisify(execFile);
const VERSION_TIMEOUT_MS = 10_000;

/** What to do when Codex is signed out: System signs in with codex itself, an account of CodeRay's again in Settings. */
export function signedOutHint(home: AccountHome): string {
  return home.dir === null
    ? 'Codex is signed out: run codex login, or add an account in Settings → Accounts.'
    : 'This Codex account is signed out: remove it in Settings → Accounts and add it again.';
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

/** codex's model catalog (not an entitlement check), hidden models left out, each with the efforts it lists. */
export function codexModels(codex: CodexCommand, cwd: string): Promise<ModelInfo[]> {
  return withAppServer(codex, cwd, async (rpc) => {
    const models: ModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const page: ModelListResponse = await rpc.request<ModelListResponse>('model/list', cursor === null ? {} : { cursor });
      for (const model of page.data) {
        const value = formatModelId({ engine: 'codex', model: model.id });
        if (model.hidden || parseModelId(value) === null) continue;
        const efforts = model.supportedReasoningEfforts.map((option) => option.reasoningEffort).filter((effort) => isEffortFor('codex', effort));
        models.push({ value, name: model.displayName, engine: 'codex', efforts });
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return models;
  });
}
