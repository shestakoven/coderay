import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerMessage } from '@ide/protocol';
import { isAlive } from '../src/os-process';
import { FAKE_CLAUDE } from './fake-claude/fake';
import { FAKE_CODEX } from './fake-codex/fake';
import { FAKE_OPENCODE } from './fake-opencode/fake';
import { fixture, tempDir, waitFor, writeTree } from './helpers';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));

async function startMain(options: { claude?: string; env?: Record<string, string>; codex?: string; opencode?: string } = {}): Promise<{ messages: ServerMessage[]; socket: WebSocket }> {
  const base = tempDir('main-smoke-');
  const root = join(base, 'project');
  const bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  mkdirSync(join(base, 'ui'));
  await writeTree(root, { 'notes.txt': 'notes\n', 'src/app.ts': 'export const a = 1;\n' });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', MAIN, '--project', root, '--ide-home', join(base, 'home'), '--port', '0', '--ui', join(base, 'ui'), '--claude', options.claude ?? FAKE_CLAUDE,
      ...(options.codex === undefined ? ['--no-codex'] : ['--codex', options.codex]), ...(options.opencode === undefined ? ['--no-opencode'] : ['--opencode', options.opencode])],
    {
      cwd: REPO,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_CLAUDE_SCENARIO: fixture('stream/text-then-wait.jsonl'), IDE_DEFAULT_MODEL: 'sonnet', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += String(chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { output += String(chunk); });
  onTestFinished(async () => {
    child.kill('SIGTERM');
    await exited;
  });
  const url = await waitFor(() => /open: (http:\/\/127\.0\.0\.1:(\d+)\/#token=(\S+))/.exec(output) ?? undefined, `the core address in:\n${output}`, 60_000);
  const socket = new WebSocket(`ws://127.0.0.1:${url[2]}/ws?token=${url[3]}`);
  onTestFinished(() => socket.terminate());
  const messages: ServerMessage[] = [];
  socket.on('message', (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return { messages, socket };
}

// A claude that tells its version and lists Sonnet.
function sonnetClaude(dir: string): string {
  const claude = join(dir, 'claude');
  writeFileSync(claude, [
    '#!/bin/sh',
    "if [ \"$1\" = --version ]; then echo '2.1.296 (Claude Code)'; exit 0; fi",
    'read -r request',
    'printf \'{"type":"control_response","response":{"subtype":"success","request_id":"models","response":{"models":[{"value":"sonnet","displayName":"Sonnet"}]}}}\\n\'',
    'exec cat > /dev/null',
  ].join('\n'), { mode: 0o755 });
  return claude;
}

describe('main.ts', { timeout: 90_000 }, () => {
  it('greets with the history snapshot, errors on a diff for an unknown hash', async () => {
    const { messages, socket } = await startMain();
    const greeting = await waitFor(() => messages.find((m) => m.type === 'history.snapshot'), 'the history snapshot');
    expect(greeting).toMatchObject({ history: { changes: [], events: [], reverts: [] } });

    socket.send(JSON.stringify({ type: 'history.diff', requestId: 'r1', path: 'notes.txt', before: 'f'.repeat(40), after: null }));
    const result = await waitFor(() => messages.find((m) => m.type === 'history.result'), 'the diff result');
    expect(result).toMatchObject({ requestId: 'r1', error: expect.stringMatching(/./) });
    expect(messages.filter((m) => m.type === 'history.result')).toHaveLength(1);
  });

  it('hands neither IDE_NODE nor ELECTRON_RUN_AS_NODE on to the claude it starts', async () => {
    const dir = tempDir('main-env-');
    const seen = join(dir, 'seen');
    const claude = join(dir, 'claude');
    writeFileSync(claude, `#!/bin/sh\nprintf '%s %s\\n' "\${IDE_NODE-unset}" "\${ELECTRON_RUN_AS_NODE-unset}" >> '${seen}'\n`, { mode: 0o755 });
    const { socket } = await startMain({ claude, env: { IDE_NODE: join(dir, 'launcher'), ELECTRON_RUN_AS_NODE: '1' } });
    socket.send(JSON.stringify({ type: 'chat.send', text: 'hello' }));
    expect(await waitFor(() => (existsSync(seen) ? readFileSync(seen, 'utf8').trim() : ''), 'the claude to start')).toBe('unset unset');
  });

  it('answers a request for the models without waiting for claude to tell its version, and the state of each engine once it has', async () => {
    const dir = tempDir('main-version-');
    const answer = join(dir, 'answer');
    const claude = join(dir, 'claude');
    writeFileSync(claude, `#!/bin/sh\nif [ "$1" = --version ]; then while [ ! -e '${answer}' ]; do sleep 0.05; done; fi\nexec '${FAKE_CLAUDE}' "$@"\n`, { mode: 0o755 });
    const { messages, socket } = await startMain({ claude });
    socket.send(JSON.stringify({ type: 'models.list' }));
    const models = await waitFor(() => messages.find((m) => m.type === 'models.snapshot'), 'the models');
    const early = messages.some((m) => m.type === 'engines.snapshot');
    writeFileSync(answer, '');
    const engines = await waitFor(() => messages.find((m) => m.type === 'engines.snapshot'), 'the engines');
    expect([models, early, engines]).toEqual([
      { type: 'models.snapshot', models: [] }, false, { type: 'engines.snapshot', engines: [{ engine: 'claude', state: 'ready', hint: null }] },
    ]);
  });

  it('tells the UI that a new chat needs a model when IDE_DEFAULT_MODEL names none claude takes', async () => {
    const { messages } = await startMain({ env: { IDE_DEFAULT_MODEL: '--evil' } });
    expect(await waitFor(() => messages.find((m) => m.type === 'sessions.snapshot'), 'the chats')).toMatchObject({ sessions: [], next: null });
  });

  it('tells the UI what a new chat starts with, and lists the model a New chat gives the unused chat', async () => {
    const { messages, socket } = await startMain();
    const greeting = await waitFor(() => messages.find((m) => m.type === 'sessions.snapshot'), 'the chats');
    socket.send(JSON.stringify({ type: 'session.new' }));
    await waitFor(() => messages.some((m) => m.type === 'session.patch' && m.patch.session?.status === 'running'), "the new chat's agent");
    socket.send(JSON.stringify({ type: 'session.new', modelChoice: 'opus', effort: 'medium' }));
    const listed = await waitFor(() => messages.find((m) => m.type === 'sessions.snapshot' && m.sessions[0]?.modelChoice === 'opus'), 'the chat on its new model');
    expect([greeting, listed]).toMatchObject([
      { next: { engine: 'claude', modelChoice: 'sonnet', effort: 'medium' } },
      { next: { engine: 'claude', modelChoice: 'opus', effort: 'medium' } },
    ]);
  });

  it("sends every window the engines and the models of the latest account change only, keeps Claude's accounts at the top of the settings for older windows, and refuses an engine without accounts", async () => {
    const dir = tempDir('main-accounts-');
    const claude = join(dir, 'claude');
    // While the test holds a change, its version check and model listing answer only once released, the way a slow earlier change would.
    writeFileSync(claude, [
      '#!/bin/sh',
      `held() { [ -e '${dir}/hold' ] || return 1; echo $$ > '${dir}/held-'"$1"; while [ ! -e '${dir}/release' ]; do sleep 0.02; done; }`,
      'if [ "$1" = --version ]; then',
      "if held version; then echo '1.0.0 (Claude Code)'; else echo '2.1.296 (Claude Code)'; fi",
      'exit 0',
      'fi',
      `n=$(( $(cat '${dir}/listings' 2>/dev/null || echo 0) + 1 )); echo $n > '${dir}/listings'`,
      'read -r request',
      `models="[{\\"value\\":\\"m$n\\",\\"displayName\\":\\"Model $n\\"}]"`,
      "if held listing; then models='[]'; fi",
      'printf \'{"type":"control_response","response":{"subtype":"success","request_id":"models","response":{"models":%s}}}\\n\' "$models"',
      'exec cat > /dev/null',
    ].join('\n'), { mode: 0o755 });
    onTestFinished(() => writeFileSync(join(dir, 'release'), ''));
    const { messages, socket } = await startMain({ claude });
    const send = (message: object): void => socket.send(JSON.stringify(message));
    const models = () => messages.flatMap((m) => (m.type === 'models.snapshot' ? [m.models.map((model) => model.name)] : []));
    const engines = () => messages.flatMap((m) => (m.type === 'engines.snapshot' ? [m.engines.map((engine) => engine.state)] : []));
    const held = (): number[] => ['held-version', 'held-listing'].map((file) => (existsSync(join(dir, file)) ? Number(readFileSync(join(dir, file), 'utf8')) : 0));
    const settings = await waitFor(() => messages.find((m) => m.type === 'settings.snapshot'), 'the settings');
    send({ type: 'account.select', requestId: 'r1', engine: 'codex', id: null });
    const refused = await waitFor(() => messages.find((m) => m.type === 'settings.result' && m.requestId === 'r1'), 'the refusal');
    send({ type: 'models.list' });
    await waitFor(() => models().length === 1 && engines().length === 1, 'the engines and the models');
    writeFileSync(join(dir, 'hold'), '');
    send({ type: 'account.select', requestId: 'r2', engine: 'claude', id: null });
    const pids = await waitFor(() => held().every((pid) => pid > 0) && held(), 'the checks of the earlier change');
    unlinkSync(join(dir, 'hold'));
    send({ type: 'account.select', requestId: 'r3', engine: 'claude', id: null });
    await waitFor(() => models().length === 2 && engines().length === 2, 'the engines and the models of the later change');
    writeFileSync(join(dir, 'release'), '');
    await waitFor(() => pids.every((pid) => !isAlive(pid)), 'the checks of the earlier change to end');
    send({ type: 'models.list' });
    await waitFor(() => models().length === 3 && engines().length === 3, 'the engines and the models again');
    expect([settings.type === 'settings.snapshot' && settings.settings.accounts, refused, models(), engines()]).toEqual([
      { accounts: [], activeId: null, engines: [{ engine: 'claude', accounts: [], activeId: null }], login: { state: 'idle', engine: null, method: null, url: null, userCode: null, error: null } },
      { type: 'settings.result', requestId: 'r1', error: 'Codex has no accounts in this CodeRay.' },
      [['Model 1'], ['Model 3'], ['Model 3']], [['ready'], ['ready'], ['ready']],
    ]);
  });

  it("reports Codex's state beside Claude's, and still lists Claude's models when codex cannot list its own", async () => {
    const { messages, socket } = await startMain({ codex: '/nonexistent/codex' });
    socket.send(JSON.stringify({ type: 'models.list' }));
    const models = await waitFor(() => messages.find((m) => m.type === 'models.snapshot'), 'the models');
    const engines = await waitFor(() => messages.find((m) => m.type === 'engines.snapshot'), 'the engines');
    expect([models, engines]).toEqual([
      { type: 'models.snapshot', models: [], failed: ['codex'] },
      { type: 'engines.snapshot', engines: [{ engine: 'claude', state: 'ready', hint: null }, { engine: 'codex', state: 'missing', hint: 'Install Codex: codex is not on the PATH.' }] },
    ]);
  });

  it("sends Claude's models without waiting for a codex slow to list its own, saying codex's are coming, and every window both once codex has", async () => {
    const dir = tempDir('main-slow-codex-');
    mkdirSync(join(dir, 'home'));
    const { messages, socket } = await startMain({ claude: sonnetClaude(dir), codex: FAKE_CODEX, env: { HOME: join(dir, 'home'), FAKE_CODEX_SLOW: 'model/list', FAKE_CODEX_SLOW_MS: '8000' } });
    const models = () => messages.flatMap((m) => (m.type === 'models.snapshot' ? [[m.models.map((model) => model.name), m.pending]] : []));
    const asked = Date.now();
    socket.send(JSON.stringify({ type: 'models.list' }));
    await waitFor(() => models().length === 1, "Claude's models");
    const waited = Date.now() - asked;
    await waitFor(() => models().length === 2, 'the Codex models', 20_000);
    expect([models(), waited < 6_000]).toEqual([[[['Sonnet'], ['codex']], [['Sonnet', 'GPT-6-Luna', 'GPT-5.6-Terra'], undefined]], true]);
  });

  it("runs opencode beside Claude and Codex, makes a profile from its name, and lists a provider's models once the active profile has its key", async () => {
    const dir = tempDir('main-opencode-');
    mkdirSync(join(dir, 'home'));
    const { messages, socket } = await startMain({ claude: sonnetClaude(dir), codex: FAKE_CODEX, opencode: FAKE_OPENCODE, env: { HOME: join(dir, 'home') } });
    const send = (message: object): void => socket.send(JSON.stringify(message));
    const answers = (requestId: string) => messages.flatMap((m) => ('requestId' in m && m.requestId === requestId ? [m] : []));
    const answered = (requestId: string) => waitFor(() => answers(requestId).find((m) => m.type === 'settings.result'), `the result of ${requestId}`, 20_000);
    const names = (has: string) => waitFor(() => messages.findLast((m) => m.type === 'models.snapshot' && m.models.some((model) => model.name === has)), `the models with ${has}`, 20_000);
    send({ type: 'models.list' });
    const listed = await names('OpenCode Zen · GPT OSS 120B (free)');
    const engines = await waitFor(() => messages.find((m) => m.type === 'engines.snapshot' && m.engines.length === 3), 'all three engines', 20_000);
    send({ type: 'account.login.start', requestId: 'bad', engine: 'opencode', method: 'profile', apiKey: 'a\u0007b' });
    const refused = await answered('bad');
    send({ type: 'account.login.start', requestId: 'r1', engine: 'opencode', method: 'profile', apiKey: '  Work ' });
    await answered('r1');
    const profiles = () => messages.findLast((m) => m.type === 'settings.snapshot')?.settings.accounts.engines.find((engine) => engine.engine === 'opencode');
    const id = (await waitFor(() => profiles()?.accounts[0], 'the profile')).id;
    send({ type: 'account.select', requestId: 'r2', engine: 'opencode', id });
    await answered('r2');
    send({ type: 'account.provider.set', requestId: 'r3', id, providerID: 'openai', apiKey: 'sk-test' });
    await answered('r3');
    const keyed = await names('OpenAI · Stub');
    expect([
      listed.type === 'models.snapshot' && listed.models.map((model) => model.name), engines.type === 'engines.snapshot' && engines.engines.map((engine) => [engine.engine, engine.state]),
      refused, profiles(), answers('r3').map((m) => [m.type, m.type === 'settings.providers' && m.providers.find((p) => p.id === 'openai')?.connected, 'error' in m && m.error]),
      keyed.type === 'models.snapshot' && keyed.models.filter((model) => model.engine === 'opencode').map((model) => model.name),
    ]).toEqual([
      ['Sonnet', 'GPT-6-Luna', 'GPT-5.6-Terra', 'OpenCode Zen · Nemotron 3.5 Lightning (free)', 'OpenCode Zen · GPT OSS 120B (free)'], [['claude', 'ready'], ['codex', 'ready'], ['opencode', 'ready']],
      { type: 'settings.result', requestId: 'bad', error: 'A profile name is 1 to 40 characters without control characters.' },
      { engine: 'opencode', accounts: [{ id, email: 'Work', createdAt: expect.any(Number) }], activeId: id },
      [['settings.providers', true, null], ['settings.result', false, null]],
      ['OpenCode Zen · Nemotron 3.5 Lightning (free)', 'OpenCode Zen · GPT OSS 120B (free)', 'OpenAI · Stub'],
    ]);
  });
});
