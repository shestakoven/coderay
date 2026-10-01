import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChangeView, RevertRecordView } from '@ide/protocol';
import { Baselines, scanTree } from '../../src/history/baselines';
import { ChangeService } from '../../src/history/changes';
import { Checkpoints } from '../../src/history/checkpoints';
import { IdeWrites } from '../../src/history/ide-writes';
import { RevertError, RevertService, type RevertServiceOptions } from '../../src/history/revert';
import { ShadowRepo } from '../../src/history/shadow';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore } from '../../src/store/store';
import { ActivityLedger } from '../../src/watchdog/activity';
import type { FsEvent } from '../../src/watchdog/watcher';
import { sessionRecord, tempDir } from '../helpers';

const saved: Record<string, string | undefined> = {};
const ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
beforeAll(() => { for (const [k, v] of Object.entries(ISOLATION)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterAll(() => { for (const k of Object.keys(ISOLATION)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
const put = (root: string, rel: string, text: string | Buffer, mode?: number): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
  if (mode !== undefined) chmodSync(join(root, rel), mode);
};
const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8');

async function fixture(o: {
  files?: Record<string, string | Buffer>; modes?: Record<string, number>; shadow?: (real: ShadowRepo) => ShadowRepo;
  root?: string; revert?: Partial<RevertServiceOptions>;
} = {}) {
  let root = o.root;
  if (!root) {
    root = tempDir('rev-root-');
    sh(root, 'init', '-q');
    const files = o.files ?? { 'a.ts': 'original', 'b.ts': 'b-original' };
    for (const [rel, text] of Object.entries(files)) put(root, rel, text, o.modes?.[rel]);
    sh(root, 'add', '-A');
  }
  const store = openStore(tempDir('rev-store-'));
  store.saveSession(sessionRecord('s1', root));
  const real = await ShadowRepo.open(tempDir('rev-shadow-'));
  const shadow = o.shadow ? o.shadow(real) : real;
  const ideWrites = new IdeWrites();
  const boot = async (seed: boolean) => {
    const baselines = new Baselines(store);
    if (seed) await scanTree(root, DEFAULT_POLICY, shadow, baselines);
    const service = new ChangeService({
      root, policy: DEFAULT_POLICY, shadow, baselines, ideWrites, ledger: new ActivityLedger({ now: () => 1000 }), store,
      checkpoints: new Checkpoints(store, () => 's1'), sessionId: () => 's1', plans: { gate: () => ({ state: 'none' }) },
    });
    const reverts = new RevertService({ root, shadow, baselines, ideWrites, changes: service, store, sessionId: () => 's1', ...o.revert });
    return { baselines, service, reverts };
  };
  const first = await boot(true);
  const state = { ...first };
  const feed = async (rel: string): Promise<void> => {
    const ev: FsEvent = { rel, exists: existsSync(join(root, rel)), at: 1000, wall: Date.now() };
    await state.service.handle(ev);
  };
  const change = async (rel: string, text: string | null, mode?: number): Promise<ChangeView> => {
    if (text === null) rmSync(join(root, rel), { force: true });
    else put(root, rel, text, mode);
    await feed(rel);
    return state.service.changes().filter((c) => c.path === rel).at(-1)!;
  };
  const restart = async (): Promise<void> => { Object.assign(state, await boot(false)); };
  return {
    root, store, shadow, ideWrites, feed, change, restart,
    get baselines() { return state.baselines; }, get service() { return state.service; }, get reverts() { return state.reverts; },
  };
}

const ids = (...changes: ChangeView[]): string[] => changes.map((c) => c.id);

describe('RevertService.revertChanges', () => {
  it('restores a modified file to its before content and labels the write as ide', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'agent version');
    const seen: RevertRecordView[] = [];
    f.reverts.onChange((r) => seen.push(r));
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(read(f.root, 'a.ts')).toBe('original');
    expect(record.files).toEqual([{ path: 'a.ts', outcome: 'restored', reason: null }]);
    expect(record).toMatchObject({ kind: 'watchdog', eventId: 'e1', changeIds: [c.id], undoneAt: null });
    expect(f.service.changes().find((x) => x.id === c.id)?.resolution).toBe('reverted');
    expect(f.reverts.reverts()).toEqual([record]);
    expect(seen).toEqual([record]);
    await f.feed('a.ts');
    expect(f.service.changes().at(-1)).toMatchObject({ path: 'a.ts', origin: 'ide' });
  });

  it('deletes a created file and recreates a deleted one with its mode', async () => {
    const f = await fixture({ files: { 'run.sh': 'echo hi' }, modes: { 'run.sh': 0o755 } });
    const created = await f.change('new.ts', 'fresh');
    const removed = await f.change('run.sh', null);
    const record = await f.reverts.revertChanges({ changeIds: ids(created, removed), eventId: 'e1' });
    expect(record.files).toEqual([
      { path: 'new.ts', outcome: 'deleted', reason: null },
      { path: 'run.sh', outcome: 'recreated', reason: null },
    ]);
    expect(existsSync(join(f.root, 'new.ts'))).toBe(false);
    expect(read(f.root, 'run.sh')).toBe('echo hi');
    expect(statSync(join(f.root, 'run.sh')).mode & 0o777).toBe(0o755);
  });

  it('leaves a file the user edited afterwards untouched and reports a conflict', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'agent version');
    put(f.root, 'a.ts', 'user edit');
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(read(f.root, 'a.ts')).toBe('user edit');
    expect(record.files).toEqual([{ path: 'a.ts', outcome: 'conflict', reason: 'changed again after the agent\'s change' }]);
    expect(f.service.changes().find((x) => x.id === c.id)?.resolution).toBeNull();
  });

  it('conflicts when a later change of the path exists even if the content matches again', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'agent version');
    await f.change('a.ts', 'user edit');
    await f.change('a.ts', 'agent version');
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files[0]).toMatchObject({ outcome: 'conflict', reason: 'changed again after the agent\'s change' });
    expect(read(f.root, 'a.ts')).toBe('agent version');
  });

  it('reports a conflict when the user deleted the file', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'agent version');
    rmSync(join(f.root, 'a.ts'));
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files).toEqual([{ path: 'a.ts', outcome: 'conflict', reason: 'the file was deleted by someone else' }]);
    expect(existsSync(join(f.root, 'a.ts'))).toBe(false);
  });

  it('reports a conflict when the agent deleted the file and something else exists there now', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', null);
    put(f.root, 'a.ts', 'someone recreated me');
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files[0]).toMatchObject({ outcome: 'conflict' });
    expect(read(f.root, 'a.ts')).toBe('someone recreated me');
  });

  it('reports "content not stored" for a 6 MiB file instead of deleting it', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 'x');
    const f = await fixture({ files: { 'big.bin': big } });
    const c = await f.change('big.bin', 'small now');
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files).toEqual([{ path: 'big.bin', outcome: 'conflict', reason: 'content not stored' }]);
    expect(read(f.root, 'big.bin')).toBe('small now');
  });

  it('reports a conflict for an unreadable change', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'agent version');
    f.service.changes().find((x) => x.id === c.id)!.unreadable = true;
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files[0]).toEqual({ path: 'a.ts', outcome: 'conflict', reason: 'the content could not be read' });
    expect(read(f.root, 'a.ts')).toBe('agent version');
  });

  it('never reverts .git/HEAD', async () => {
    const f = await fixture();
    const head = join(f.root, '.git', 'HEAD');
    const before = readFileSync(head, 'utf8');
    writeFileSync(head, 'ref: refs/heads/other\n');
    await f.feed('.git/HEAD');
    const c = f.service.changes().find((x) => x.path === '.git/HEAD')!;
    expect(c).toBeDefined();
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files).toEqual([{ path: '.git/HEAD', outcome: 'not-rolled-back', reason: 'git state is never rolled back' }]);
    expect(readFileSync(head, 'utf8')).toBe('ref: refs/heads/other\n');
    expect(before).not.toBe('ref: refs/heads/other\n');
  });

  it('reverts several changes of one path to the first before content when the last matches', async () => {
    const f = await fixture();
    const c1 = await f.change('a.ts', 'one');
    const c2 = await f.change('a.ts', 'two');
    const record = await f.reverts.revertChanges({ changeIds: ids(c1, c2), eventId: 'e1' });
    expect(record.files).toEqual([{ path: 'a.ts', outcome: 'restored', reason: null }]);
    expect(read(f.root, 'a.ts')).toBe('original');
    expect(f.service.changes().filter((c) => [c1.id, c2.id].includes(c.id)).map((c) => c.resolution)).toEqual(['reverted', 'reverted']);
  });

  it('refuses the first change alone when a later one of the path exists', async () => {
    const f = await fixture();
    const c1 = await f.change('a.ts', 'one');
    await f.change('a.ts', 'two');
    const record = await f.reverts.revertChanges({ changeIds: [c1.id], eventId: 'e1' });
    expect(record.files[0]).toMatchObject({ outcome: 'conflict' });
    expect(read(f.root, 'a.ts')).toBe('two');
  });

  it('reports a conflict when a directory replaced the file', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'agent version');
    rmSync(join(f.root, 'a.ts'));
    mkdirSync(join(f.root, 'a.ts'));
    put(f.root, 'a.ts/inner', 'x');
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files[0]).toMatchObject({ path: 'a.ts', outcome: 'conflict' });
    expect(statSync(join(f.root, 'a.ts')).isDirectory()).toBe(true);
  });

  it('restores a read-only file', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'agent version');
    chmodSync(join(f.root, 'a.ts'), 0o444);
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files[0]).toMatchObject({ outcome: 'restored' });
    expect(read(f.root, 'a.ts')).toBe('original');
  });

  it('refuses to replace a symlink', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'agent version');
    rmSync(join(f.root, 'a.ts'));
    execFileSync('ln', ['-s', 'agent version', join(f.root, 'a.ts')]);
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files[0]).toEqual({ path: 'a.ts', outcome: 'conflict', reason: 'cannot restore a symlink' });
  });

  it('processes the other files and stores the record when one restore throws', async () => {
    const f = await fixture({
      shadow: (real) => {
        const wrapped = Object.create(real) as ShadowRepo;
        wrapped.restore = async (hash, abs, mode) => {
          if (abs.endsWith('a.ts')) throw new Error('disk on fire');
          return real.restore(hash, abs, mode);
        };
        return wrapped;
      },
    });
    const ca = await f.change('a.ts', 'agent a');
    const cb = await f.change('b.ts', 'agent b');
    const record = await f.reverts.revertChanges({ changeIds: ids(ca, cb), eventId: 'e1' });
    expect(record.files).toEqual([
      { path: 'a.ts', outcome: 'conflict', reason: 'disk on fire' },
      { path: 'b.ts', outcome: 'restored', reason: null },
    ]);
    expect(read(f.root, 'b.ts')).toBe('b-original');
    expect(read(f.root, 'a.ts')).toBe('agent a');
    expect(f.store.reverts('s1')).toEqual([record]);
    expect(f.service.changes().find((c) => c.id === ca.id)?.resolution).toBeNull();
    expect(f.service.changes().find((c) => c.id === cb.id)?.resolution).toBe('reverted');
  });

  it('serializes two reverts of the same path', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'agent version');
    const [r1, r2] = await Promise.all([
      f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' }),
      f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e2' }),
    ]);
    expect(r1.files[0]?.outcome).toBe('restored');
    expect(r2.files[0]?.outcome).toBe('conflict');
  });
});

describe('RevertService review fixes', () => {
  it('refuses when an unselected change of the path lies between the selected ones', async () => {
    const f = await fixture();
    const c1 = await f.change('a.ts', 'one');
    await f.change('a.ts', 'human edit');
    const c3 = await f.change('a.ts', 'three');
    const record = await f.reverts.revertChanges({ changeIds: ids(c1, c3), eventId: 'e1' });
    expect(record.files).toEqual([{ path: 'a.ts', outcome: 'conflict', reason: 'changed again after the agent\'s change' }]);
    expect(read(f.root, 'a.ts')).toBe('three');
  });

  it('keeps an edit made between the check and the commit and reports a conflict', async () => {
    const f = await fixture({ revert: { beforeCommit: async (rel) => { put(f.root, rel, 'user typed this just now'); } } });
    const c = await f.change('a.ts', 'agent version');
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files).toEqual([{ path: 'a.ts', outcome: 'conflict', reason: 'changed again after the agent\'s change' }]);
    expect(read(f.root, 'a.ts')).toBe('user typed this just now');
    expect(readdirSync(f.root).filter((n) => n.includes('.ide-'))).toEqual([]);
  });

  it('keeps an edit made between the check and the delete of a created file', async () => {
    const f = await fixture({ revert: { beforeCommit: async (rel) => { put(f.root, rel, 'user typed this just now'); } } });
    const c = await f.change('new.ts', 'fresh');
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files[0]).toMatchObject({ path: 'new.ts', outcome: 'conflict' });
    expect(read(f.root, 'new.ts')).toBe('user typed this just now');
  });

  it('restores the before mode when the agent changed the exec bit along with the content', async () => {
    const f = await fixture({ files: { 'a.sh': 'echo 1' } });
    const c = await f.change('a.sh', 'echo 2', 0o755);
    expect(c.beforeMode).toBe(0o644);
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files[0]?.outcome).toBe('restored');
    expect(statSync(join(f.root, 'a.sh')).mode & 0o777).toBe(0o644);
  });

  it('recreates a deleted executable with its mode after a restart', async () => {
    const f = await fixture({ files: { 'run.sh': 'echo hi' }, modes: { 'run.sh': 0o755 } });
    const c = await f.change('run.sh', null);
    await f.restart();
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files[0]?.outcome).toBe('recreated');
    expect(statSync(join(f.root, 'run.sh')).mode & 0o777).toBe(0o755);
  });

  it('refuses to restore a file that was a symlink before the agent changed it', async () => {
    const f = await fixture();
    symlinkSync('a.ts', join(f.root, 'link'));
    await f.feed('link');
    const c = await f.change('link', null);
    expect(c.beforeMode).toBe(0o120000);
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files).toEqual([{ path: 'link', outcome: 'conflict', reason: 'cannot restore a symlink' }]);
    expect(existsSync(join(f.root, 'link'))).toBe(false);
  });

  it('refuses when the agent version is not stored, since the revert could not be undone', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', Buffer.alloc(6 * 1024 * 1024, 'y') as unknown as string);
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files).toEqual([{ path: 'a.ts', outcome: 'conflict', reason: 'the agent\'s version is not stored, so the revert could not be undone' }]);
    expect(statSync(join(f.root, 'a.ts')).size).toBe(6 * 1024 * 1024);
  });

  it('still deletes a created file whose content is not stored', async () => {
    const f = await fixture();
    const c = await f.change('huge.bin', Buffer.alloc(6 * 1024 * 1024, 'y') as unknown as string);
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files).toEqual([{ path: 'huge.bin', outcome: 'deleted', reason: null }]);
  });

  it('times out a hung restore, reports a conflict and keeps serving reverts', async () => {
    const f = await fixture({
      shadow: (real) => {
        const wrapped = Object.create(real) as ShadowRepo;
        wrapped.restore = (hash, abs, mode, guard) => (abs.endsWith('a.ts') ? new Promise(() => undefined) : real.restore(hash, abs, mode, guard));
        return wrapped;
      },
      revert: { restoreTimeoutMs: 1000 },
    });
    const ca = await f.change('a.ts', 'agent a');
    const cb = await f.change('b.ts', 'agent b');
    const first = await f.reverts.revertChanges({ changeIds: [ca.id], eventId: 'e1' });
    expect(first.files).toEqual([{ path: 'a.ts', outcome: 'conflict', reason: 'timed out' }]);
    const second = await f.reverts.revertChanges({ changeIds: [cb.id], eventId: 'e2' });
    expect(second.files[0]?.outcome).toBe('restored');
  });

  it('labels every write as ide for a created-then-deleted and a deleted-then-recreated file', async () => {
    const f = await fixture();
    const created = await f.change('new.ts', 'fresh');
    const removed = await f.change('a.ts', null);
    await f.reverts.revertChanges({ changeIds: ids(created, removed), eventId: 'e1' });
    await f.feed('new.ts');
    await f.feed('a.ts');
    expect(f.service.changes().slice(-2)).toMatchObject([{ path: 'new.ts', origin: 'ide', afterHash: null }, { path: 'a.ts', origin: 'ide' }]);
  });

  it('never reverts a file under .git/refs', async () => {
    const f = await fixture();
    mkdirSync(join(f.root, '.git/refs/heads'), { recursive: true });
    writeFileSync(join(f.root, '.git/refs/heads/topic'), 'abc\n');
    await f.feed('.git/refs/heads/topic');
    const c = f.service.changes().find((x) => x.path === '.git/refs/heads/topic')!;
    expect(c).toBeDefined();
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files[0]).toMatchObject({ outcome: 'not-rolled-back' });
    expect(existsSync(join(f.root, '.git/refs/heads/topic'))).toBe(true);
  });

  it('reverts a guarded git file of a linked worktree through its real location', async () => {
    const main = tempDir('rev-main-');
    sh(main, 'init', '-q'); sh(main, 'config', 'user.email', 'a@b'); sh(main, 'config', 'user.name', 'a');
    writeFileSync(join(main, 'a.ts'), 'a');
    sh(main, 'add', '-A'); sh(main, 'commit', '-q', '-m', 'init');
    const wt = join(tempDir('rev-wt-'), 'wt');
    sh(main, 'worktree', 'add', '-q', wt, '-b', 'side');
    const f = await fixture({ root: wt });
    const real = sh(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude').trim();
    const original = readFileSync(real, 'utf8');
    writeFileSync(real, `${original}\nnope\n`);
    await f.feed('.git/info/exclude');
    const c = f.service.changes().find((x) => x.path === '.git/info/exclude')!;
    expect(c).toBeDefined();
    const record = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    expect(record.files).toEqual([{ path: '.git/info/exclude', outcome: 'restored', reason: null }]);
    expect(readFileSync(real, 'utf8')).toBe(original);
  });

  it('undoes what it can and reports a conflict for the rest', async () => {
    const f = await fixture();
    const ca = await f.change('a.ts', 'agent a');
    const cb = await f.change('b.ts', 'agent b');
    const r = await f.reverts.revertChanges({ changeIds: ids(ca, cb), eventId: 'e1' });
    put(f.root, 'b.ts', 'user edit');
    const undone = await f.reverts.undo(r.id);
    expect(undone.files).toEqual([
      { path: 'a.ts', outcome: 'restored', reason: null },
      { path: 'b.ts', outcome: 'conflict', reason: 'changed again after the agent\'s change' },
    ]);
    expect(read(f.root, 'a.ts')).toBe('agent a');
    expect(read(f.root, 'b.ts')).toBe('user edit');
    expect(undone.record.undoneAt).not.toBeNull();
  });
});

describe('RevertService.undo', () => {
  it('undoes a revert, refuses after a further edit, and refuses a second undo', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'agent version');
    const created = await f.change('new.ts', 'fresh');
    const first = await f.reverts.revertChanges({ changeIds: ids(c, created), eventId: 'e1' });
    const undone = await f.reverts.undo(first.id);
    expect(undone.files).toEqual([
      { path: 'a.ts', outcome: 'restored', reason: null },
      { path: 'new.ts', outcome: 'recreated', reason: null },
    ]);
    expect(undone.record.undoneAt).not.toBeNull();
    expect(read(f.root, 'a.ts')).toBe('agent version');
    expect(read(f.root, 'new.ts')).toBe('fresh');
    expect(f.reverts.reverts()[0]?.undoneAt).toBe(undone.record.undoneAt);
    await expect(f.reverts.undo(first.id)).rejects.toThrow(new RevertError('already undone'));
  });

  it('refuses to undo over a file changed after the revert', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'agent version');
    const r = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    put(f.root, 'a.ts', 'user edit after revert');
    const undone = await f.reverts.undo(r.id);
    expect(undone.files).toEqual([{ path: 'a.ts', outcome: 'conflict', reason: 'changed again after the agent\'s change' }]);
    expect(read(f.root, 'a.ts')).toBe('user edit after revert');
  });

  it('undoes the revert of a deleted file by deleting it again, and of a created file by recreating it', async () => {
    const f = await fixture();
    const d = await f.change('a.ts', null);
    const r = await f.reverts.revertChanges({ changeIds: [d.id], eventId: 'e1' });
    expect(read(f.root, 'a.ts')).toBe('original');
    await f.reverts.undo(r.id);
    expect(existsSync(join(f.root, 'a.ts'))).toBe(false);
  });

  it('labels undo writes as ide', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'agent version');
    const r = await f.reverts.revertChanges({ changeIds: [c.id], eventId: 'e1' });
    await f.feed('a.ts');
    await f.reverts.undo(r.id);
    await f.feed('a.ts');
    expect(f.service.changes().slice(-2).map((x) => x.origin)).toEqual(['ide', 'ide']);
  });

  it('throws for an unknown revert', async () => {
    const f = await fixture();
    await expect(f.reverts.undo('nope')).rejects.toBeInstanceOf(RevertError);
  });
});

describe('RevertService review reverts', () => {
  const review = (...changes: ChangeView[]) => ({ changeIds: ids(...changes), eventId: null, kind: 'review' as const });

  it('restores a human edit and records a review revert with no event', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'human edit');
    expect(f.service.changes().find((x) => x.id === c.id)).toMatchObject({ origin: 'human', enforcement: 'enforced' });
    const record = await f.reverts.revertChanges(review(c));
    expect(read(f.root, 'a.ts')).toBe('original');
    expect(record).toMatchObject({ kind: 'review', eventId: null, planId: null, stepKey: null, changeIds: [c.id], undoneAt: null });
    expect(record.files).toEqual([{ path: 'a.ts', outcome: 'restored', reason: null }]);
  });

  it('marks a reverted change as reverted', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'human edit');
    await f.reverts.revertChanges(review(c));
    expect(f.service.changes().find((x) => x.id === c.id)).toMatchObject({ resolution: 'reverted' });
  });

  it('keeps the kind review in the stored record and in the change callback', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'human edit');
    const seen: RevertRecordView[] = [];
    f.reverts.onChange((r) => seen.push(r));
    const record = await f.reverts.revertChanges(review(c));
    expect([f.reverts.reverts().map((r) => r.kind), seen.map((r) => r.kind)]).toEqual([['review'], ['review']]);
    expect(f.reverts.reverts()).toEqual([record]);
  });

  it('reverts a deleted human file by recreating it', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', null);
    const record = await f.reverts.revertChanges(review(c));
    expect(record.files).toEqual([{ path: 'a.ts', outcome: 'recreated', reason: null }]);
    expect(read(f.root, 'a.ts')).toBe('original');
  });

  it('reverts all changes of one file in a single review revert, back to the first before', async () => {
    const f = await fixture();
    const c1 = await f.change('a.ts', 'first edit');
    const c2 = await f.change('a.ts', 'second edit');
    const record = await f.reverts.revertChanges(review(c1, c2));
    expect(read(f.root, 'a.ts')).toBe('original');
    expect(record.files).toEqual([{ path: 'a.ts', outcome: 'restored', reason: null }]);
    expect(f.service.changes().filter((x) => x.path === 'a.ts').map((x) => x.resolution)).toEqual(['reverted', 'reverted']);
  });

  it('leaves a file edited again after the change alone and does not mark it reverted', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'human edit');
    put(f.root, 'a.ts', 'newer edit');
    const record = await f.reverts.revertChanges(review(c));
    expect(read(f.root, 'a.ts')).toBe('newer edit');
    expect(record).toMatchObject({ kind: 'review', files: [{ path: 'a.ts', outcome: 'conflict' }] });
    expect(f.service.changes().find((x) => x.id === c.id)?.resolution).toBeNull();
  });

  it('can be undone like any other revert', async () => {
    const f = await fixture();
    const c = await f.change('a.ts', 'human edit');
    const record = await f.reverts.revertChanges(review(c));
    const undone = await f.reverts.undo(record.id);
    expect(read(f.root, 'a.ts')).toBe('human edit');
    expect(undone.record).toMatchObject({ id: record.id, kind: 'review', undoneAt: expect.any(Number) });
  });
});
