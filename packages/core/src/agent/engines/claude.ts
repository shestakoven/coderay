import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ENGINE_CAPABILITIES, type EngineStatus } from '@ide/protocol';
import { fetchModels } from '../../models/catalog';
import { claudeEnv, type ClaudeCommand } from '../claude-process';
import { startSdkTransport } from '../sdk-transport';
import { isOlderVersion, MIN_CLAUDE_VERSION } from '../tools';
import type { Engine } from './registry';

const run = promisify(execFile);
const VERSION_TIMEOUT_MS = 10_000;

export interface ClaudeEngineOptions {
  /** The claude the core runs, under the active account. */
  command: () => ClaudeCommand;
  cwd: string;
}

export function claudeEngine(options: ClaudeEngineOptions): Engine {
  return {
    id: 'claude',
    capabilities: ENGINE_CAPABILITIES.claude,
    status: () => claudeStatus(options.command()),
    listModels: () => fetchModels(options.command(), options.cwd),
    start: (launch, sink) => startSdkTransport(launch, sink),
  };
}

/** Whether the installed claude can run a chat: found, and not older than the version CodeRay is verified with. */
export async function claudeStatus(claude: ClaudeCommand, timeoutMs = VERSION_TIMEOUT_MS): Promise<EngineStatus> {
  let stdout: string;
  try {
    ({ stdout } = await run(claude.command, [...claude.args, '--version'], { env: claudeEnv(claude), timeout: timeoutMs }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { engine: 'claude', state: 'missing', hint: 'Install Claude Code: claude is not on the PATH.' };
    // execFile kills a claude that outlives the timeout and reports only the signal.
    if ((error as { killed?: boolean }).killed) return { engine: 'claude', state: 'error', hint: `claude --version did not answer in ${timeoutMs / 1000} s.` };
    return { engine: 'claude', state: 'error', hint: `claude --version failed: ${(error as Error).message.split('\n')[0]}` };
  }
  const version = /\d+\.\d+\.\d+/.exec(stdout)?.[0];
  if (version === undefined) return { engine: 'claude', state: 'error', hint: 'claude --version printed no version.' };
  if (isOlderVersion(version, MIN_CLAUDE_VERSION)) return { engine: 'claude', state: 'old', hint: `Update to ≥ ${MIN_CLAUDE_VERSION}: run claude update.` };
  return { engine: 'claude', state: 'ready', hint: null };
}
