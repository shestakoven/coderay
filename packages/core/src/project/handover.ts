import { spawn } from 'node:child_process';
import { coreEnv, nodeExecutable } from '../node-exec';

// The token travels over stdin: argv is visible to every process and the environment is inherited by the agent.
export async function spawnSuccessor(args: string[], token: string): Promise<void> {
  const child = spawn(nodeExecutable(), [...process.execArgv, process.argv[1] ?? '', ...args, '--token-stdin'], {
    detached: true,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: coreEnv(),
  });
  await new Promise<void>((resolve) => child.stdin.end(token, () => resolve()));
  child.unref();
}
