import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountHome, SYSTEM_HOME } from '../../src/accounts/account-homes';
import type { CodexCommand } from '../../src/agent/codex/command';
import { codexEngine, codexModels, signedOutHint } from '../../src/agent/engines/codex';
import { fakeCodex } from '../fake-codex/fake';
import { tempDir } from '../helpers';

const record = () => join(tempDir('codex-engine-'), 'record.jsonl');

describe('the Codex engine', () => {
  it.each([
    ['ready when it is new enough and signed in, naming the active account', {}, 'work@example.com · Plus', { state: 'ready', hint: null, account: 'work@example.com · Plus' }],
    ['too old below 0.160', { FAKE_CODEX_VERSION: '0.159.9' }, null, { state: 'old', hint: 'Update Codex to 0.160.0 or newer.' }],
    ['an error when it prints no version, so nothing shows it is 0.160 or newer', { command: '/bin/sh', args: ['-c', 'echo codex-cli', 'sh'] }, null, { state: 'error', hint: 'codex --version printed no version.' }],
    ['signed out, with the way in for System', { FAKE_CODEX_ACCOUNT: 'none' }, null, { state: 'signed-out', hint: 'Codex is signed out: run codex login, or add an account in Settings → Accounts.' }],
    ["signed out, with the way back for an account of CodeRay's", { FAKE_CODEX_ACCOUNT: 'none' }, 'work@example.com',
      { state: 'signed-out', hint: 'This Codex account is signed out: remove it in Settings → Accounts and add it again.', account: 'work@example.com' }],
    ['not ready when its app-server fails to say who is signed in', { FAKE_CODEX_CRASH: 'account/read' }, null,
      { state: 'error', hint: 'codex app-server did not start: codex app-server exited (code 1): Error: fake-codex crashed on account/read' }],
    ['missing when nothing runs at the path', { command: '/nonexistent/codex', args: [] }, null, { state: 'missing', hint: 'Install Codex: codex is not on the PATH.' }],
  ])('is %s', async (_, setup: Record<string, string> | CodexCommand, account: string | null, expected) => {
    const codex = 'command' in setup ? setup as CodexCommand : fakeCodex(null, record(), setup);
    const home = account === null ? SYSTEM_HOME : accountHome('codex', '/accounts/a');
    const engine = codexEngine({ command: () => codex, cwd: tempDir('codex-cwd-'), signedOut: () => signedOutHint(home), account: () => account });
    expect(await engine.status()).toEqual({ engine: 'codex', ...expected });
  });
});

describe('codexModels', () => {
  it("lists codex's visible models from every page under the codex: prefix, each with the efforts it takes", async () => {
    expect(await codexModels(fakeCodex(null, record()), tempDir('codex-cwd-'))).toEqual([
      { value: 'codex:gpt-6-luna', name: 'GPT-6-Luna', engine: 'codex', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'codex:gpt-5.6-terra', name: 'GPT-5.6-Terra', engine: 'codex', efforts: ['low', 'medium', 'high', 'ultra'] },
    ]);
  });
});
