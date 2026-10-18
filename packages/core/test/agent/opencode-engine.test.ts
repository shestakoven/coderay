import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_HOME } from '../../src/accounts/account-homes';
import { catalogModels, opencodeEngine, opencodeProbe, providerHint } from '../../src/agent/engines/opencode';
import type { OpencodeCommand } from '../../src/agent/opencode/command';
import { fakeOpencode, opencodeRecords } from '../fake-opencode/fake';
import { tempDir, waitFor } from '../helpers';

const dir = () => tempDir('oc-engine-');
const starts = (record: string) => opencodeRecords(record).filter((entry) => entry.pid !== undefined).length;
const script = (body: string): OpencodeCommand => {
  const file = join(dir(), 'opencode.mjs');
  writeFileSync(file, body);
  return { command: process.execPath, args: [file] };
};
const FREE_MODELS = [
  { value: 'opencode:opencode/nemotron-3.5-lightning-free', name: 'OpenCode Zen · Nemotron 3.5 Lightning (free)', engine: 'opencode', efforts: [] },
  { value: 'opencode:opencode/gpt-oss-120b-free', name: 'OpenCode Zen · GPT OSS 120B (free)', engine: 'opencode', efforts: ['low', 'high'] },
];

afterEach(() => {
  vi.useRealTimers();
});

describe('opencodeProbe', () => {
  it.each([
    ['missing', () => ({ command: '/nonexistent/opencode', args: [] }), undefined, 'missing', 'Install opencode: opencode is not on the PATH.'],
    ['hanging on --version', () => script('setInterval(() => {}, 1000);'), 300, 'error', 'opencode --version did not answer in 0.3 s.'],
    ['failing on --version', () => script('process.exit(3);'), undefined, 'error', /^opencode --version failed: Command failed: /],
    ['printing no version', () => script("process.stdout.write('opencode');"), undefined, 'error', 'opencode --version printed no version.'],
    ['old', () => fakeOpencode(null, '/dev/null', { FAKE_OPENCODE_VERSION: '1.18.9' }), undefined, 'old', 'Update opencode to 1.19.0 or newer.'],
    ['not listening', () => fakeOpencode(null, '/dev/null', { FAKE_OPENCODE_NO_LISTEN: '1' }), 1_000, 'error', /^opencode serve did not start: opencode did not say where it listens within 1 s/],
    ['ready', () => fakeOpencode(null, '/dev/null'), undefined, 'ready', null],
  ])('reports opencode %s', async (_name, command, timeoutMs, state, hint) => {
    const { status, models } = await opencodeProbe(command(), dir(), [], timeoutMs);
    expect([status.engine, status.state, hint instanceof RegExp ? hint.test(status.hint ?? '') : status.hint, models.length > 0]).toEqual(['opencode', state, hint instanceof RegExp ? true : hint, state === 'ready']);
  });

  it("lists every connected provider's models with the provider in the name and the variants as efforts, on one server started with the user's servers off", async () => {
    const d = dir();
    const record = join(d, 'rec.jsonl');
    const { status, models } = await opencodeProbe(fakeOpencode(null, record), d, ['usersrv']);
    const configs = opencodeRecords(record).filter((entry) => entry.pid !== undefined).map((entry) => entry.configContent as { mcp: unknown; shell: string });
    // The shell it named was a wrapper of the probe's own, gone with the server.
    expect([status.state, models, configs.map((config) => config.mcp), configs.map((config) => existsSync(config.shell))])
      .toEqual(['ready', FREE_MODELS, [{ usersrv: { enabled: false } }], [false]]);
  });
});

describe('catalogModels', () => {
  it("keeps each model's context limit beside its id and leaves out one whose id cannot be a model id", () => {
    const models = catalogModels({ providers: [null, { id: 'p', name: 'P', models: {
      ok: { id: 'ok', name: 'OK', limit: { context: 4096 }, variants: { x: {}, 'Not An Effort': {} } },
      unknown: { id: 'unknown', name: 'Unknown', limit: { context: 0 } },
      'bad id': { id: 'bad id', name: 'Bad', limit: { context: 1 } },
    } }, { id: 'q', models: { m: { id: 'm' } } }] });
    expect(models).toEqual([
      { value: 'opencode:p/ok', name: 'P · OK', efforts: ['x'], context: 4096 },
      { value: 'opencode:p/unknown', name: 'P · Unknown', efforts: [], context: null },
      { value: 'opencode:q/m', name: 'q · m', efforts: [], context: null },
    ]);
  });
});

describe('the opencode engine', () => {
  it("names the active account, lists the models of the server its status started unless that was over a minute ago, and keeps that server's pid file and shell in the run directory, where the reaper finds an orphan", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const d = dir();
    const run = join(d, 'run');
    const record = join(d, 'rec.jsonl');
    const engine = opencodeEngine({ command: () => fakeOpencode(null, record), cwd: d, userServers: () => [], account: () => 'work', runDir: run });
    const pidFile = waitFor(() => existsSync(run) && readdirSync(run).some((name) => /^opencode-\d+\.pid\.json$/.test(name)), "the probe server's pid file");
    const status = await engine.status();
    const listed = await engine.listModels();
    const afterListing = starts(record);
    vi.setSystemTime(Date.now() + 60_001);
    await engine.listModels();
    const shell = (opencodeRecords(record).find((entry) => entry.pid !== undefined)?.configContent as { shell: string }).shell;
    expect([status, listed, afterListing, starts(record), await pidFile, shell.startsWith(`${run}/`) && existsSync(shell)])
      .toEqual([{ engine: 'opencode', state: 'ready', hint: null, account: 'work' }, FREE_MODELS, 1, 2, true, true]);
  });

  it('tells how to connect the provider a model needs: in a terminal for System, in Settings for a profile', () => {
    expect([providerHint('openai', SYSTEM_HOME), providerHint('openai', { dir: '/profiles/p', env: {}, unset: [], args: [] })]).toEqual([
      'opencode has no provider "openai" connected for this model. Run opencode auth login in a terminal to connect a provider, or pick a free opencode/* model.',
      'opencode has no provider "openai" connected for this model. Add a provider key to this profile in Settings → Accounts, or pick a free opencode/* model.',
    ]);
  });
});
