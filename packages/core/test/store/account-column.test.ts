import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { openStore, type SessionRecord } from '../../src/store/store';
import { DatabaseSync } from '../../src/store/sqlite';
import { tempDir } from '../helpers';

const session = (id: string, overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id, claudeSessionId: `claude-${id}`, cwd: '/project', status: 'stopped', model: null, modelChoice: null, effort: null, cliVersion: null,
  pid: null, launchId: null, conversationStarted: true, startedAt: 1, accountId: null, ...overrides,
});

function freshStore(dir: string) {
  const store = openStore(dir);
  onTestFinished(() => store.close());
  return store;
}

function schemaSixHistory(): string {
  const dir = tempDir('ide-store-');
  const first = openStore(dir);
  first.saveSession(session('old', { startedAt: 7 }));
  first.close();
  const db = new DatabaseSync(join(dir, 'history.sqlite'));
  db.exec('ALTER TABLE sessions DROP COLUMN account_id; ALTER TABLE baselines DROP COLUMN sig; PRAGMA user_version = 6');
  db.close();
  return dir;
}

const userVersion = (dir: string): number => {
  const db = new DatabaseSync(join(dir, 'history.sqlite'));
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  db.close();
  return user_version;
};

describe('session account column', () => {
  it('keeps the account a session was started under', () => {
    const accountId = randomUUID();
    const store = freshStore(tempDir('ide-store-'));
    store.saveSession(session('s1', { accountId }));
    store.saveSession(session('s2'));
    expect([store.session('s1')?.accountId, store.session('s2')?.accountId]).toStrictEqual([accountId, null]);
  });

  it('keeps the account across a reopen of the history', () => {
    const dir = tempDir('ide-store-');
    const accountId = randomUUID();
    const first = openStore(dir);
    first.saveSession(session('s1', { accountId }));
    first.close();
    expect(freshStore(dir).session('s1')?.accountId).toBe(accountId);
  });
});

describe('schema 7 migration', () => {
  it('reads a session written before accounts existed as started under System', () => {
    const store = freshStore(schemaSixHistory());
    expect(store.session('old')).toMatchObject({ id: 'old', startedAt: 7, accountId: null });
  });

  it('moves a version 6 history to the current version', () => {
    const dir = schemaSixHistory();
    freshStore(dir).close();
    expect(userVersion(dir)).toBe(8);
  });

  it('stores an account on a migrated history', () => {
    const accountId = randomUUID();
    const store = freshStore(schemaSixHistory());
    store.saveSession(session('old', { startedAt: 7, accountId }));
    expect(store.session('old')?.accountId).toBe(accountId);
  });
});
