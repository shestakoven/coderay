import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYSTEM_HOME } from '../../src/accounts/account-homes';
import { codexModels, codexStatus, signedOutHint } from '../../src/agent/engines/codex';
import { fakeCodex } from '../fake-codex/fake';
import { tempDir } from '../helpers';

const record = () => join(tempDir('codex-engine-'), 'record.jsonl');

describe('codexStatus', () => {
  it.each([
    ['ready when it is new enough and signed in', {}, { state: 'ready', hint: null }],
    ['too old below 0.160', { FAKE_CODEX_VERSION: '0.159.9' }, { state: 'old', hint: 'Update Codex to 0.160.0 or newer.' }],
    ['signed out, with the way in for System', { FAKE_CODEX_ACCOUNT: 'none' }, { state: 'signed-out', hint: 'Codex is signed out: run codex login, or add an account in Settings → Accounts.' }],
  ])('is %s', async (_, env, expected) => {
    expect(await codexStatus(fakeCodex(null, record(), env), tempDir('codex-cwd-'), signedOutHint(SYSTEM_HOME))).toEqual({ engine: 'codex', ...expected });
  });

  it('says codex is missing when nothing runs at the path', async () => {
    expect(await codexStatus({ command: '/nonexistent/codex', args: [] }, tempDir('codex-cwd-'), signedOutHint(SYSTEM_HOME)))
      .toEqual({ engine: 'codex', state: 'missing', hint: 'Install Codex: codex is not on the PATH.' });
  });
});

describe('codexModels', () => {
  it("lists codex's visible models under the codex: prefix, each with the efforts it takes", async () => {
    expect(await codexModels(fakeCodex(null, record()), tempDir('codex-cwd-'))).toEqual([
      { value: 'codex:gpt-6-luna', name: 'GPT-6-Luna', engine: 'codex', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'codex:gpt-5.6-terra', name: 'GPT-5.6-Terra', engine: 'codex', efforts: ['low', 'medium', 'high', 'ultra'] },
    ]);
  });
});
