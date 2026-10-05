import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { onTestFinished } from 'vitest';
import type { ChatItem } from '@ide/protocol';
import { AgentSession, type SessionGate } from '../../src/agent/agent-session';
import { systemPrompt } from '../../src/agent/system-prompt';
import { aliveRoute, Canary } from '../../src/gate/canary';
import { removeGateFiles, writeGateFiles } from '../../src/hook/gate-files';
import { projectDir, runDir } from '../../src/home';
import { forceKill, isAlive } from '../../src/os-process';
import { startServer } from '../../src/server/server';
import { openStore } from '../../src/store/store';
import { fakeClaude, readRecords } from '../fake-claude/fake';
import { tempDir } from '../helpers';

const SECRET = 'terminal-secret';
const COMPONENTS = [{ id: 'auth', name: 'Auth' }];
const gateBase = (home: string, root: string, sessionId: string) => `${basename(projectDir(home, root))}-${sessionId}`;
export const flag = (argv: readonly string[] | undefined, name: string) => {
  const at = argv?.indexOf(name) ?? -1;
  return at === -1 ? undefined : argv?.[at + 1];
};
export const noticeTexts = (items: ChatItem[]) => items.flatMap((item) => (item.kind === 'tool' || item.kind === 'prompt' ? [] : [item.text]));

// A claude that ignores the closing of stdin and only stops when it is signalled.
export function stubbornClaude(exitCode?: number): string {
  const file = join(tempDir('ide-scenario-'), 'stubborn.jsonl');
  const steps = exitCode === undefined ? [{ fake: 'ignore-stdin-close' }, { fake: 'hang' }] : [{ fake: 'exit', code: exitCode }];
  writeFileSync(file, steps.map((step) => JSON.stringify(step)).join('\n'));
  return file;
}

export interface Options {
  hooks: 'on' | 'off';
  canaryMs: number;
  scenario?: string;
  gated?: boolean;
}

export async function terminalHarness({ hooks, canaryMs, scenario = 'multi-turn', gated = true }: Options) {
  const home = tempDir('ide-home-');
  const root = tempDir('ide-root-');
  const store = openStore(projectDir(home, root));
  const canary = new Canary();
  const server = await startServer({ port: 0, token: 'ui', snapshot: () => null, routes: [aliveRoute({ secret: SECRET, canary })] });
  const gate: SessionGate = {
    write: (sessionId, events) => ({
      settingsPath: writeGateFiles(runDir(home), gateBase(home, root, sessionId), { url: `http://127.0.0.1:${server.port}/hook`, secret: SECRET, sessionId, events }).settingsPath,
    }),
    remove: (sessionId) => removeGateFiles(runDir(home), gateBase(home, root, sessionId)),
    systemPrompt: () => systemPrompt(COMPONENTS),
    canary,
  };
  const recordFile = join(home, `record-${randomUUID()}.jsonl`);
  const claude = fakeClaude(scenario, recordFile);
  const env: Record<string, string> = { ...claude.env, FAKE_CLAUDE_HOOKS: hooks };
  const input: string[] = [];
  const transcriptsDir = tempDir('ide-transcripts-');
  const session = new AgentSession({
    root, home, store, claude: { ...claude, env }, canaryMs, transcriptsDir, terminalInput: (data) => input.push(data), ...(gated ? { gate } : {}),
  });
  const spawned = () => readRecords(recordFile).flatMap((r) => (r.argv && r.pid ? [{ argv: r.argv, pid: r.pid }] : []));
  onTestFinished(async () => {
    await session.close();
    store.close();
    await server.close();
    for (const { pid } of spawned()) if (isAlive(pid)) forceKill(pid);
  });
  await session.start();
  const gateFiles = () => (existsSync(runDir(home)) ? readdirSync(runDir(home)).filter((name) => /\.(settings|hook|mcp)\.json$/.test(name)) : []);
  return {
    session, store, home, root, env, input, transcriptsDir, spawned, gateFiles,
    userMessages: () => readRecords(recordFile).flatMap((r) => (r.stdin?.type === 'user' ? [r.stdin] : [])),
    ping: () => fetch(`http://127.0.0.1:${server.port}/hook/alive`, {
      method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ sessionId: session.sessionId() }),
    }),
  };
}

export type TerminalHarness = Awaited<ReturnType<typeof terminalHarness>>;
