import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { onTestFinished, vi } from 'vitest';
import type { ChangeView, ControlMode, WatchdogEventView } from '@ide/protocol';
import { AgentSession } from '../../src/agent/agent-session';
import { createExecutionRuntime, type ExecutionRuntime, type ExecutionRuntimeOptions } from '../../src/execution/runtime';
import { projectDir } from '../../src/home';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { startServer, type RunningServer } from '../../src/server/server';
import { openStore, type Store } from '../../src/store/store';
import { fakeClaude, readRecords, type FakeRecord } from '../fake-claude/fake';
import { codexRecords, fakeCodex, type CodexRecord } from '../fake-codex/fake';
import { fakeOpencode, opencodeHomes, opencodeRecords, type OpencodeRecord } from '../fake-opencode/fake';
import { LUNA, NEMOTRON, SONNET, tempDir, waitFor, writeTree } from '../helpers';

export const FILES = { 'src/app.ts': "export const greeting = 'helo';\n", 'src/other.ts': "export const other = 'helo';\n", 'notes.txt': 'notes\n' };
export const COMPONENTS = [{ id: 'app', name: 'App', files: ['src/app.ts', 'src/other.ts'], globs: [] }];
export const INIT = '{"type":"system","subtype":"init","cwd":"$CWD","session_id":"$SESSION","mcp_servers":[],"model":"claude-haiku-4-5-20251001","permissionMode":"bypassPermissions","claude_code_version":"2.1.296"}';
export const AWAIT = '{"fake":"await-user"}';
export const HOLD_OPEN = '{"fake":"sleep","ms":60000}';
export const mcpWrite = (id: string, files: { path: string; content: string }[], extra: object = {}): string =>
  JSON.stringify({ fake: 'mcp-write', id, server: 'other', tool: 'write', files, ...extra });

export interface Built {
  rt: ExecutionRuntime;
  session: AgentSession;
  store: Store;
  root: string;
  home: string;
  shadowDir: string;
  generate: ReturnType<typeof vi.fn>;
  records(): FakeRecord[];
  codexRecords(): CodexRecord[];
  opencodeRecords(): OpencodeRecord[];
  // What the core typed into the agent's terminal.
  typed: string[];
  send(): Promise<void>;
  write(rel: string, content: string): void;
  changes(): ChangeView[];
  events(): WatchdogEventView[];
  close(): Promise<void>;
}

export interface BuildOptions {
  scenario: string | string[];
  from?: Built;
  sessionStart?: boolean;
  mode?: ControlMode;
  runtime?: Partial<ExecutionRuntimeOptions>;
  start?: boolean;
  files?: Record<string, string>;
  claudeEnv?: Record<string, string>;
  canaryMs?: number;
  engine?: 'claude' | 'codex' | 'opencode';
  codexEnv?: Record<string, string>;
  opencodeEnv?: Record<string, string>;
}

const DEFAULT_MODELS = { claude: SONNET, codex: LUNA, opencode: NEMOTRON };

let builds = 0;

export async function build(options: BuildOptions): Promise<Built> {
  const n = (builds += 1);
  const home = options.from?.home ?? tempDir('rt-home-');
  const root = options.from?.root ?? tempDir('rt-root-');
  if (!options.from) {
    await writeTree(root, { ...FILES, ...options.files });
    execFileSync('git', ['init', '-q'], { cwd: root });
  }
  const scenarioPath = Array.isArray(options.scenario) ? join(home, `scenario-${n}.jsonl`) : options.scenario;
  if (Array.isArray(options.scenario)) writeFileSync(scenarioPath, `${options.scenario.join('\n')}\n`);
  const shadowDir = options.from?.shadowDir ?? join(home, 'shadow.git');
  const store = options.from?.store ?? openStore(projectDir(home, root));
  const policy = { ...DEFAULT_POLICY, mode: options.mode ?? 'B' };
  const generate = vi.fn(async () => ({ summary: 'Changed the greeting.' }));
  let server: RunningServer | undefined;
  const rt = createExecutionRuntime({
    root, home, store, policy: () => policy, components: () => COMPONENTS,
    port: () => server?.port ?? 0, userHome: tempDir('rt-user-home-'), tempRoots: [],
    shadowDir, watcherSettleMs: 20, watchdogSettleMs: 100, summaryDebounceMs: 20,
    provider: { fast: { generate } }, files: () => [],
    ...options.runtime,
  });
  const typed: string[] = [];
  const recordFile = join(home, `record-${n}.jsonl`);
  const fake = fakeClaude(scenarioPath, recordFile);
  const codexRecord = join(home, `codex-record-${n}.jsonl`);
  const codex = options.engine === 'codex' ? fakeCodex(scenarioPath, codexRecord, options.codexEnv) : undefined;
  // One per home, as opencode's database: a core started again on the same home finds the sessions and the progress of the last one.
  const opencodeRecord = join(home, 'opencode-record.jsonl');
  const opencode = options.engine === 'opencode' ? fakeOpencode(scenarioPath, opencodeRecord, { ...opencodeHomes(home), ...options.opencodeEnv }) : undefined;
  const session = new AgentSession({
    root, home, store, claude: { ...fake, env: { ...fake.env, ...options.claudeEnv } }, canaryMs: options.canaryMs ?? 5_000,
    ...(codex ? { codex } : {}), ...(opencode ? { opencode } : {}), defaultModel: DEFAULT_MODELS[options.engine ?? 'claude'],
    mcpServers: () => ({ idecore: rt.gate.mcpEntry() }), ...rt.sessionOptions, terminalInput: (data) => typed.push(data),
  });
  rt.attach(session);
  server = await startServer({ port: 0, token: 'ui', snapshot: () => null, routes: rt.gate.routes });
  const running = server;
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => (closed ??= (async () => {
    await session.close();
    await rt.close();
    await running.close();
    if (!options.from) store.close();
  })());
  onTestFinished(close);
  if (options.sessionStart !== false) await session.start();
  if (options.start !== false) await rt.start();
  return {
    rt, session, store, root, home, shadowDir, generate,
    records: () => readRecords(recordFile), codexRecords: () => codexRecords(codexRecord), opencodeRecords: () => opencodeRecords(opencodeRecord), typed,
    send: async () => {
      session.send('go');
      await waitFor(() => session.hasOpenTurn(), 'turn open');
    },
    write: (rel, content) => writeFileSync(join(root, rel), content),
    changes: () => rt.changes.changes(),
    events: () => rt.watchdog.events(),
    close,
  };
}

export const OUT_OF_PLAN = [AWAIT, INIT, mcpWrite('toolu_w', [{ path: 'src/x.ts', content: 'x\n' }]), HOLD_OPEN, AWAIT];
export const WAIT_TURN = [AWAIT, INIT, HOLD_OPEN, AWAIT];
export const pendingEvent = (b: Built) => waitFor(() => b.events().find((event) => event.phase === 'pending'), 'a pending watchdog event');

