import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ChangeView } from '@ide/protocol';
import { invalidateWorktrees } from '../../src/gate/worktrees';
import { Baselines, scanTree } from '../../src/history/baselines';
import { ChangeService } from '../../src/history/changes';
import { Checkpoints } from '../../src/history/checkpoints';
import { IdeWrites } from '../../src/history/ide-writes';
import { RevertService } from '../../src/history/revert';
import { ShadowRepo } from '../../src/history/shadow';
import { DEFAULT_POLICY } from '../../src/policy/policy';
import { openStore } from '../../src/store/store';
import { ActivityLedger, type ToolCall } from '../../src/watchdog/activity';
import type { FsEvent } from '../../src/watchdog/watcher';
import { sessionRecord, tempDir } from '../helpers';
import { addSubmodule, git, isolateGit, monorepoWithWorktree, projectWithWorktree, submoduleSource, tryGit, type WorktreeProject } from '../worktree-fixture';

isolateGit();

const WT = '.worktrees/wt1';
const A = `${WT}/backend/src/a.py`;
const ORIGINAL = 'a = 1\n';
const call = (o: Partial<ToolCall>): ToolCall => ({
  toolUseId: 't1', parentToolUseId: null, tool: 'Write', toolClass: 'file-writer', targets: [], allTracked: false,
  cwdRel: null, background: false, allowedOnce: false, ...o,
});

async function fixture(project?: WorktreeProject) {
  const { root, wt } = project ?? await projectWithWorktree();
  const store = openStore(tempDir('chgwt-store-'));
  store.saveSession(sessionRecord('s1', root));
  const shadow = await ShadowRepo.open(tempDir('chgwt-shadow-'));
  const baselines = new Baselines(store);
  const clock = { now: 1000 };
  const ledger = new ActivityLedger({ now: () => clock.now });
  const ideWrites = new IdeWrites();
  const service = new ChangeService({
    root, policy: DEFAULT_POLICY, shadow, baselines, ideWrites, ledger, store, checkpoints: new Checkpoints(store, () => 's1'),
    sessionId: () => 's1', plans: { gate: () => ({ state: 'none' }) },
  });
  const reverts = new RevertService({ root, shadow, baselines, ideWrites, changes: service, store, sessionId: () => 's1' });
  const ev = (rel: string, exists = true): FsEvent => ({ rel, exists, at: clock.now, wall: Date.now() });
  const put = (rel: string, text: string | Buffer): void => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
  const revert = (...changes: ChangeView[]) => reverts.revertChanges({ changeIds: changes.map((c) => c.id), eventId: null });
  const gitHash = (cwd: string, rel: string): string => git(cwd, 'hash-object', rel).trim();
  return { root, wt, store, shadow, baselines, service, reverts, ledger, ev, put, read, revert, gitHash };
}

const byPath = (changes: ChangeView[], path: string): ChangeView => changes.find((c) => c.path === path)!;

describe('ChangeService for a file of a nested worktree', () => {
  it('takes the before-image of a first write from the worktree index, not as a creation', async () => {
    const f = await fixture();
    const original = f.gitHash(f.wt, 'backend/src/a.py');
    f.put(A, 'a = 2\n');
    await f.service.handle(f.ev(A));
    const [change] = f.service.changes();
    expect(change).toMatchObject({ path: A, beforeHash: original, afterHash: f.gitHash(f.wt, 'backend/src/a.py'), enforcement: 'enforced', beforeMode: 0o644, added: 1, removed: 1 });
    expect((await f.shadow.read(original))?.toString()).toBe(ORIGINAL);
  });

  it('prefers the staged version in the index to the one in HEAD', async () => {
    const f = await fixture();
    f.put(A, 'staged\n');
    git(f.wt, 'add', 'backend/src/a.py');
    const staged = f.gitHash(f.wt, 'backend/src/a.py');
    f.put(A, 'working\n');
    await f.service.handle(f.ev(A));
    expect(f.service.changes()[0]).toMatchObject({ beforeHash: staged, afterHash: f.gitHash(f.wt, 'backend/src/a.py') });
    expect((await f.shadow.read(staged))?.toString()).toBe('staged\n');
  });

  it('falls back to the HEAD version when the index has no entry for the file', async () => {
    const f = await fixture();
    const committed = f.gitHash(f.wt, 'backend/src/a.py');
    git(f.wt, 'rm', '-q', '--cached', 'backend/src/a.py');
    f.put(A, 'working\n');
    await f.service.handle(f.ev(A));
    expect(f.service.changes()[0]).toMatchObject({ beforeHash: committed });
    expect((await f.shadow.read(committed))?.toString()).toBe(ORIGINAL);
  });

  it('records a file the worktree does not have in git as a creation once the IDE has seen the worktree', async () => {
    const f = await fixture();
    await f.service.handle(f.ev(A));
    f.put(`${WT}/backend/src/new.py`, 'new\n');
    await f.service.handle(f.ev(`${WT}/backend/src/new.py`));
    expect(f.service.changes()[0]).toMatchObject({ path: `${WT}/backend/src/new.py`, beforeHash: null, beforeMode: null, enforcement: 'enforced' });
  });

  it('records the mode of the git version as the mode before the change', async () => {
    const f = await fixture();
    git(f.wt, 'update-index', '--chmod=+x', 'backend/src/a.py');
    f.put(A, 'a = 2\n');
    await f.service.handle(f.ev(A));
    expect(f.service.changes()[0]!.beforeMode).toBe(0o755);
  });

  it('records a deletion of a file the worktree has in git, with its git version as the before-image', async () => {
    const f = await fixture();
    const original = f.gitHash(f.wt, 'backend/src/a.py');
    rmSync(join(f.root, A));
    await f.service.handle(f.ev(A, false));
    expect(f.service.changes()[0]).toMatchObject({ path: A, beforeHash: original, afterHash: null });
  });

  it('starts the next change from the previous after-image once the baseline exists', async () => {
    const f = await fixture();
    const original = f.gitHash(f.wt, 'backend/src/a.py');
    f.put(A, 'one\n');
    await f.service.handle(f.ev(A));
    f.put(A, 'two\n');
    await f.service.handle(f.ev(A));
    const [first, second] = f.service.changes();
    expect([first!.beforeHash, second!.beforeHash]).toEqual([original, first!.afterHash]);
    expect(f.baselines.get(A)?.hash).toBe(second!.afterHash);
  });

  it('keeps the baseline of a file the IDE already knows ahead of its git version', async () => {
    const f = await fixture();
    await f.service.handle(f.ev(`${WT}/README.md`));
    f.put(A, 'known\n');
    const known = f.gitHash(f.wt, 'backend/src/a.py');
    f.baselines.set({ path: A, hash: known, stored: false, size: 6, mode: 0o644 });
    f.put(A, 'later\n');
    await f.service.handle(f.ev(A));
    expect(f.service.changes()[0]).toMatchObject({ beforeHash: known });
  });

  it('records no change for a worktree file that is as git has it, and takes it as its baseline', async () => {
    const f = await fixture();
    await f.service.handle(f.ev(A));
    expect(f.service.changes()).toEqual([]);
    expect(f.store.changes('s1')).toEqual([]);
    expect(f.baselines.get(A)?.hash).toBe(f.gitHash(f.wt, 'backend/src/a.py'));
    expect(f.store.baselines().map((b) => b.path)).toContain(A);
  });

  it('records a change for the first real edit after such a silent seed, against the git version', async () => {
    const f = await fixture();
    const original = f.gitHash(f.wt, 'backend/src/a.py');
    await f.service.handle(f.ev(A));
    f.put(A, 'edited\n');
    await f.service.handle(f.ev(A));
    expect(f.service.changes().map((c) => [c.path, c.beforeHash])).toEqual([[A, original]]);
  });

  it('does not track a file the worktree ignores, and tracks the files of the project and of the worktree in one batch, each against its own before-image', async () => {
    const f = await fixture();
    const original = f.gitHash(f.wt, 'backend/src/a.py');
    f.put('backend/src/a.py', 'root baseline\n');
    const rootBaseline = f.gitHash(f.root, 'backend/src/a.py');
    f.baselines.set({ path: 'backend/src/a.py', hash: rootBaseline, stored: false, size: 14, mode: 0o644 });
    f.put(`${WT}/dist/x.js`, 'built\n');
    f.put(A, 'a = 2\n');
    f.put('backend/src/a.py', 'root edited\n');
    await Promise.all([f.service.handle(f.ev(`${WT}/dist/x.js`)), f.service.handle(f.ev(A)), f.service.handle(f.ev('backend/src/a.py'))]);
    expect(f.service.changes().map((c) => [c.path, c.enforcement, c.beforeHash]).sort()).toEqual([
      [A, 'enforced', original],
      ['backend/src/a.py', 'enforced', rootBaseline],
    ]);
    expect(f.baselines.get(`${WT}/dist/x.js`)).toBeUndefined();
  });

  it('asks the worktree repository, not the project one, whether a file is tracked', async () => {
    const f = await fixture();
    f.ledger.allowed(call({ tool: 'Bash', toolClass: 'shell', allTracked: true }));
    f.put(A, 'tracked\n');
    f.put(`${WT}/backend/src/fresh.py`, 'untracked\n');
    await Promise.all([f.service.handle(f.ev(A)), f.service.handle(f.ev(`${WT}/backend/src/fresh.py`))]);
    expect(byPath(f.service.changes(), A).origin).toBe('agent');
    expect(byPath(f.service.changes(), `${WT}/backend/src/fresh.py`).origin).toBe('agent-tool');
  });

  it('finds the git version of a worktree file whose name has spaces, quotes and non-ASCII characters', async () => {
    const f = await fixture();
    const odd = 'we"ird dir/é file.py';
    f.put(`${WT}/${odd}`, 'odd\n');
    git(f.wt, 'add', '-A');
    git(f.wt, 'commit', '-q', '-m', 'odd');
    const original = f.gitHash(f.wt, odd);
    f.put(`${WT}/${odd}`, 'changed\n');
    await f.service.handle(f.ev(`${WT}/${odd}`));
    expect(f.service.changes().map((c) => [c.path, c.beforeHash])).toEqual([[`${WT}/${odd}`, original]]);
  });

  it('takes the git version of a symlink of the worktree for its target text, and a revert refuses the link as it does anywhere in the project', async () => {
    const f = await fixture();
    symlinkSync('src/a.py', join(f.wt, 'backend/link'));
    git(f.wt, 'add', '-A');
    git(f.wt, 'commit', '-q', '-m', 'link');
    const rel = `${WT}/backend/link`;
    const original = git(f.wt, 'rev-parse', 'HEAD:backend/link').trim();
    rmSync(join(f.root, rel));
    symlinkSync('src/other.py', join(f.root, rel));
    await f.service.handle(f.ev(rel));
    expect(f.service.changes()[0]).toMatchObject({ path: rel, beforeHash: original, beforeMode: 0o120000 });
    const record = await f.reverts.revertChanges({ changeIds: [f.service.changes()[0]!.id], eventId: null });
    expect(record.files).toEqual([{ path: rel, outcome: 'conflict', reason: 'cannot restore a symlink' }]);
    expect(readlinkSync(join(f.root, rel))).toBe('src/other.py');
  });

  it('reverts a first write in a worktree to the content the file had, not by deleting it', async () => {
    const f = await fixture();
    f.put(A, 'agent wrote this\n');
    await f.service.handle(f.ev(A));
    const record = await f.reverts.revertChanges({ changeIds: [f.service.changes()[0]!.id], eventId: null });
    expect(record.files.map((file) => [file.path, file.outcome])).toEqual([[A, 'restored']]);
    expect(existsSync(join(f.root, A))).toBe(true);
    expect(f.read(A)).toBe(ORIGINAL);
  });

  it('reverts a first write in a worktree to its original mode', async () => {
    const f = await fixture();
    git(f.wt, 'update-index', '--chmod=+x', 'backend/src/a.py');
    chmodSync(join(f.root, A), 0o755);
    f.put(A, 'agent wrote this\n');
    await f.service.handle(f.ev(A));
    await f.reverts.revertChanges({ changeIds: [f.service.changes()[0]!.id], eventId: null });
    expect([f.read(A), statSync(join(f.root, A)).mode & 0o777]).toEqual([ORIGINAL, 0o755]);
  });

  it('reverts the deletion of a worktree file by recreating it from git', async () => {
    const f = await fixture();
    rmSync(join(f.root, A));
    await f.service.handle(f.ev(A, false));
    const record = await f.reverts.revertChanges({ changeIds: [f.service.changes()[0]!.id], eventId: null });
    expect(record.files.map((file) => [file.path, file.outcome])).toEqual([[A, 'recreated']]);
    expect(f.read(A)).toBe(ORIGINAL);
  });
});

type F = Awaited<ReturnType<typeof fixture>>;

const nestedMeta = (f: F): Record<string, unknown> => JSON.parse(f.baselines.meta('baselines.nested') ?? '{}');

// Files written now count as settled for a scan that runs a minute later; a file stamped with that later time is still racy.
function aMinuteLater(): Date {
  vi.useFakeTimers({ toFake: ['Date'] });
  onTestFinished(() => { vi.useRealTimers(); });
  const later = new Date(Date.now() + 60_000);
  vi.setSystemTime(later);
  return later;
}

const PLACES = [
  ['gitignored', '.worktrees/wt1'],
  ['not gitignored', 'trees/w1'],
  ['guarded', '.claude/worktrees/w1'],
] as const;

describe.each(PLACES)('ChangeService for a worktree in a %s place that went away', (_kind, dir) => {
  const A = `${dir}/backend/src/a.py`;

  async function seen() {
    const f = await fixture(await projectWithWorktree({}, dir));
    await f.service.handle(f.ev(A));
    expect(f.baselines.get(A)).toBeDefined();
    expect(Object.keys(nestedMeta(f))).toEqual([dir]);
    return f;
  }
  const left = (f: F) => [f.service.changes(), f.store.changes('s1'), f.baselines.paths().filter((path) => path.startsWith(`${dir}/`)), Object.keys(nestedMeta(f))];

  it('records nothing for the files git removed with it, and drops its baselines and meta entry', async () => {
    const f = await seen();
    git(f.root, 'worktree', 'remove', '--force', dir);
    invalidateWorktrees(f.root);
    await Promise.all([f.service.handle(f.ev(A, false)), f.service.handle(f.ev(`${dir}/README.md`, false))]);
    expect(left(f)).toEqual([[], [], [], []]);
  });

  it('records nothing for the files of another repository that took its place', async () => {
    const f = await seen();
    rmSync(f.wt, { recursive: true });
    git(f.root, 'worktree', 'prune');
    git(f.root, 'clone', '-q', f.root, dir);
    invalidateWorktrees(f.root);
    await f.service.handle(f.ev(A));
    expect(left(f)).toEqual([[], [], [], [dir]]);
  });

  it('still records the changes of the project itself in the same batch', async () => {
    const f = await seen();
    git(f.root, 'worktree', 'remove', '--force', dir);
    invalidateWorktrees(f.root);
    f.put('backend/src/a.py', 'a = 2\n');
    await Promise.all([f.service.handle(f.ev(A, false)), f.service.handle(f.ev('backend/src/a.py'))]);
    expect(f.service.changes().map((c) => c.path)).toEqual(['backend/src/a.py']);
  });
});

describe('ChangeService at the first sight of a worktree', () => {
  async function unseen() {
    const f = await fixture();
    const later = aMinuteLater();
    f.put(`${WT}/old.txt`, 'old\n');
    f.put(`${WT}/racy.txt`, 'racy\n');
    utimesSync(join(f.root, WT, 'racy.txt'), later, later);
    f.put(A, 'a = 2\n');
    await f.service.handle(f.ev(A));
    return f;
  }
  const racy = `${WT}/racy.txt`;

  it('takes the settled files as baselines and leaves the file of the batch and the racy ones to their events', async () => {
    const f = await unseen();
    expect(f.baselines.get(`${WT}/old.txt`)?.hash).toBe(f.gitHash(f.wt, 'old.txt'));
    expect(f.baselines.get(`${WT}/README.md`)?.hash).toBe(f.gitHash(f.wt, 'README.md'));
    expect(f.baselines.get(racy)).toBeUndefined();
    expect(f.service.changes().map((c) => c.path)).toEqual([A]);
  });

  it('records a file left to its event as one whose previous content is not known, with the mode it has', async () => {
    const f = await unseen();
    await f.service.handle(f.ev(racy));
    expect(f.service.changes().at(-1)).toMatchObject({ path: racy, beforeHash: null, beforeMode: 0o644, afterHash: f.gitHash(f.wt, 'racy.txt'), enforcement: 'enforced' });
  });

  it('records the untracked file whose own event brings the worktree into sight the same way', async () => {
    const f = await fixture();
    f.put(`${WT}/scratch.txt`, 'scratch\n');
    await f.service.handle(f.ev(`${WT}/scratch.txt`));
    expect(f.service.changes()).toMatchObject([{ path: `${WT}/scratch.txt`, beforeHash: null, beforeMode: 0o644 }]);
  });

  it('records a file created after the first sight as a creation, with no mode before', async () => {
    const f = await unseen();
    f.put(`${WT}/created.txt`, 'created\n');
    await f.service.handle(f.ev(`${WT}/created.txt`));
    expect(f.service.changes().at(-1)).toMatchObject({ path: `${WT}/created.txt`, beforeHash: null, beforeMode: null });
  });

  it('refuses to revert such a change as a deletion, and leaves the file on disk as it is', async () => {
    const f = await unseen();
    await f.service.handle(f.ev(racy));
    const record = await f.revert(f.service.changes().at(-1)!);
    expect(record.files).toEqual([{ path: racy, outcome: 'conflict', reason: 'the previous content is not known' }]);
    expect([existsSync(join(f.root, racy)), f.read(racy)]).toEqual([true, 'racy\n']);
  });

  it('refuses the whole selection when it starts with such a change, and reverts a later change alone to the content the first left', async () => {
    const f = await unseen();
    await f.service.handle(f.ev(racy));
    f.put(racy, 'racy, then edited\n');
    await f.service.handle(f.ev(racy));
    const [first, second] = f.service.changes().filter((c) => c.path === racy);
    expect(second!.beforeHash).toBe(first!.afterHash);
    expect((await f.revert(first!, second!)).files).toEqual([{ path: racy, outcome: 'conflict', reason: 'the previous content is not known' }]);
    expect(f.read(racy)).toBe('racy, then edited\n');
    expect((await f.revert(second!)).files).toEqual([{ path: racy, outcome: 'restored', reason: null }]);
    expect(f.read(racy)).toBe('racy\n');
  });

  it('still deletes a file the agent created after the first sight when it is reverted', async () => {
    const f = await unseen();
    f.put(`${WT}/created.txt`, 'created\n');
    await f.service.handle(f.ev(`${WT}/created.txt`));
    const record = await f.revert(f.service.changes().at(-1)!);
    expect(record.files.map((file) => [file.outcome, file.reason])).toEqual([['deleted', null]]);
    expect(existsSync(join(f.root, WT, 'created.txt'))).toBe(false);
  });
});

describe('ChangeService for a file that lands in a worktree the IDE has already seen', () => {
  const BROUGHT = `${WT}/backend/src/brought.py`;

  it.each([
    ['the event of another file', (f: F) => f.service.handle(f.ev(A))],
    ['a scan', (f: F) => scanTree(f.root, DEFAULT_POLICY, f.shadow, f.baselines).then(() => undefined)],
  ])('records a file git brings from another branch as a creation, as it does in the project itself, once %s has seen the worktree', async (_how, see) => {
    const f = await fixture();
    git(f.wt, 'checkout', '-q', '-b', 'other');
    f.put(BROUGHT, 'brought\n');
    git(f.wt, 'add', '-A');
    git(f.wt, 'commit', '-q', '-m', 'other');
    git(f.wt, 'checkout', '-q', '-');
    await see(f);
    git(f.wt, 'checkout', '-q', 'other');
    await f.service.handle(f.ev(BROUGHT));
    expect(f.service.changes()).toMatchObject([{ path: BROUGHT, beforeHash: null, beforeMode: null, afterHash: f.gitHash(f.wt, 'backend/src/brought.py'), enforcement: 'enforced' }]);
  });

  it('records nothing for the .git link of a worktree that the project does not ignore: it is not a file of the project', async () => {
    const f = await fixture(await projectWithWorktree({}, 'trees/w1'));
    await f.service.handle(f.ev('trees/w1/.git'));
    expect(f.service.changes()).toEqual([]);
  });

  it('still takes a file of the checkout the IDE first saw, that landed after it looked, as it is', async () => {
    const f = await fixture();
    git(f.wt, 'rm', '-q', 'backend/src/other.py');
    await f.service.handle(f.ev(A));
    git(f.wt, 'checkout', '-q', 'HEAD', '--', 'backend/src/other.py');
    await f.service.handle(f.ev(`${WT}/backend/src/other.py`));
    expect(f.service.changes()).toEqual([]);
    expect(f.baselines.get(`${WT}/backend/src/other.py`)?.hash).toBe(f.gitHash(f.wt, 'backend/src/other.py'));
  });
});

describe('ChangeService for a worktree whose checkout differs from the blobs git keeps', () => {
  const raw = (f: F, rel: string): string => git(f.wt, 'hash-object', '--no-filters', rel).trim();
  const sameAsCheckout = (f: F, rel: string, bytes: Buffer): boolean => readFileSync(join(f.root, rel)).equals(bytes);
  const rot = (root: string): void => {
    git(root, 'config', 'filter.rot.clean', 'tr a-z A-Z');
    git(root, 'config', 'filter.rot.smudge', 'tr A-Z a-z');
  };
  const NOTES = `${WT}/notes.txt`;
  const withRot = () => projectWithWorktree({ '.gitattributes': '*.txt filter=rot\n', 'notes.txt': 'hello\n' }, WT, rot);
  const withCrlf = () => projectWithWorktree({ '.gitattributes': '* text eol=crlf\n' });

  it('records no change for the files of a checkout converted to CRLF', async () => {
    const f = await fixture(await withCrlf());
    expect(readFileSync(join(f.root, A), 'utf8')).toBe('a = 1\r\n');
    await Promise.all(['README.md', 'backend/src/a.py', 'backend/src/other.py', '.gitignore', '.gitattributes'].map((rel) => f.service.handle(f.ev(`${WT}/${rel}`))));
    expect([f.service.changes(), f.store.changes('s1')]).toEqual([[], []]);
  });

  it('records a real edit against the CRLF file git would check out, and a revert restores those bytes exactly', async () => {
    const f = await fixture(await withCrlf());
    const original = readFileSync(join(f.root, A));
    f.put(A, 'a = 2\r\n');
    await f.service.handle(f.ev(A));
    const [change] = f.service.changes();
    expect(change).toMatchObject({ path: A, enforcement: 'enforced', beforeMode: 0o644 });
    expect((await f.shadow.read(change!.beforeHash!))?.equals(original)).toBe(true);
    expect((await f.revert(change!)).files).toEqual([{ path: A, outcome: 'restored', reason: null }]);
    expect(sameAsCheckout(f, A, original)).toBe(true);
  });

  it('records a real edit against the file as a clean/smudge filter checks it out, and a revert restores it', async () => {
    const f = await fixture(await withRot());
    const original = readFileSync(join(f.root, NOTES));
    expect(original.toString()).toBe('hello\n');
    f.put(NOTES, 'hello world\n');
    await f.service.handle(f.ev(NOTES));
    const [change] = f.service.changes();
    expect((await f.shadow.read(change!.beforeHash!))?.equals(original)).toBe(true);
    await f.revert(change!);
    expect(sameAsCheckout(f, NOTES, original)).toBe(true);
  });

  it('judges an untouched file as git does even when its smudge filter cannot run any more', async () => {
    const f = await fixture(await withRot());
    git(f.wt, 'config', 'filter.rot.required', 'true');
    git(f.wt, 'config', 'filter.rot.smudge', 'false');
    await f.service.handle(f.ev(NOTES));
    expect(f.service.changes()).toEqual([]);
    expect(f.baselines.get(NOTES)?.hash).toBe(raw(f, 'notes.txt'));
  });

  it('still records a real edit of a file whose smudge filter cannot run, with the blob git keeps as the before-image', async () => {
    const f = await fixture(await withRot());
    git(f.wt, 'config', 'filter.rot.required', 'true');
    git(f.wt, 'config', 'filter.rot.smudge', 'false');
    f.put(NOTES, 'hello world\n');
    await f.service.handle(f.ev(NOTES));
    expect(f.service.changes()).toMatchObject([{ path: NOTES, beforeHash: git(f.wt, 'rev-parse', 'HEAD:notes.txt').trim(), afterHash: raw(f, 'notes.txt') }]);
  });
});

describe('ChangeService for paths inside a submodule', () => {
  it('leaves the files of a submodule of the project out of a batch and records the others in it correctly', async () => {
    const lib = await submoduleSource();
    const f = await fixture(await projectWithWorktree({}, WT, (root) => addSubmodule(root, lib, 'vendor/lib')));
    f.baselines.set({ path: 'backend/src/a.py', hash: f.gitHash(f.root, 'backend/src/a.py'), stored: false, size: 6, mode: 0o644 });
    f.put('vendor/lib/lib.py', 'changed in the submodule\n');
    f.put('dist/x.js', 'built\n');
    f.put('backend/src/a.py', 'a = 2\n');
    await Promise.all(['vendor/lib/lib.py', 'dist/x.js', 'backend/src/a.py'].map((rel) => f.service.handle(f.ev(rel))));
    expect(f.service.changes().map((c) => c.path)).toEqual(['backend/src/a.py']);
    expect(f.baselines.get('vendor/lib/lib.py')).toBeUndefined();
  });

  it('leaves the files of a submodule of the worktree out of a batch and records the others in it correctly', async () => {
    const lib = await submoduleSource();
    const f = await fixture(await projectWithWorktree({}, WT, (root) => addSubmodule(root, lib, 'vendor/lib')));
    git(f.wt, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init');
    f.put(`${WT}/vendor/lib/lib.py`, 'changed in the submodule\n');
    f.put(`${WT}/dist/x.js`, 'built\n');
    f.put(A, 'a = 2\n');
    await Promise.all([`${WT}/vendor/lib/lib.py`, `${WT}/dist/x.js`, A].map((rel) => f.service.handle(f.ev(rel))));
    expect(f.service.changes().map((c) => c.path)).toEqual([A]);
    expect(f.baselines.get(`${WT}/vendor/lib/lib.py`)).toBeUndefined();
  });
});

describe('ChangeService for a project that is a directory of a larger repository', () => {
  const INSIDE = '.worktrees/wt1/packages/app/src/a.py';
  const OUTSIDE = '.worktrees/wt1/packages/other/x.py';
  const monorepo = async () => fixture(await monorepoWithWorktree());

  it('takes the version git has in the worktree for the file of the project as its before-image', async () => {
    const f = await monorepo();
    const original = f.gitHash(f.wt, 'packages/app/src/a.py');
    f.put(INSIDE, 'a = 2\n');
    await f.service.handle(f.ev(INSIDE));
    expect(f.service.changes()).toMatchObject([{ path: INSIDE, enforcement: 'enforced', beforeHash: original, afterHash: f.gitHash(f.wt, 'packages/app/src/a.py') }]);
  });

  it('does not track a file of the worktree beyond the part that holds the project, even in the same batch', async () => {
    const f = await monorepo();
    f.put(INSIDE, 'a = 2\n');
    f.put(OUTSIDE, 'x = 2\n');
    await Promise.all([f.service.handle(f.ev(INSIDE)), f.service.handle(f.ev(OUTSIDE))]);
    expect(f.service.changes().map((c) => c.path)).toEqual([INSIDE]);
    expect(f.baselines.get(OUTSIDE)).toBeUndefined();
  });

  it('baselines at the first sight only the part of the worktree that holds the project', async () => {
    const f = await monorepo();
    aMinuteLater();
    f.put(INSIDE, 'a = 2\n');
    await f.service.handle(f.ev(INSIDE));
    const seen = f.baselines.paths().filter((path) => path.startsWith('.worktrees/wt1/'));
    expect(seen).toEqual(expect.arrayContaining(['.worktrees/wt1/packages/app/src/other.py', INSIDE]));
    expect(seen).not.toContain(OUTSIDE);
    expect(seen).not.toContain('.worktrees/wt1/README.md');
  });
});

describe('ChangeService for a worktree with an unfinished merge', () => {
  const OTHER = `${WT}/backend/src/other.py`;

  async function conflicted() {
    const f = await fixture();
    git(f.wt, 'checkout', '-q', '-b', 'side');
    f.put(A, 'a = side\n');
    f.put(OTHER, 'other = side\n');
    git(f.wt, 'commit', '-q', '-a', '-m', 'side');
    git(f.wt, 'checkout', '-q', 'wt1');
    f.put(A, 'a = ours\n');
    git(f.wt, 'commit', '-q', '-a', '-m', 'ours');
    tryGit(f.wt, 'merge', 'side');
    expect(git(f.wt, 'ls-files', '-u', '--', 'backend/src/a.py')).not.toBe('');
    f.put(A, 'a = resolved\n');
    f.put(OTHER, 'other = edited\n');
    await Promise.all([f.service.handle(f.ev(A)), f.service.handle(f.ev(OTHER))]);
    return f;
  }

  it('takes the HEAD version as the before-image of a conflicted file, whatever stages the index holds for it', async () => {
    const f = await conflicted();
    const change = f.service.changes().find((c) => c.path === A)!;
    expect(change.beforeHash).toBe(git(f.wt, 'rev-parse', 'HEAD:backend/src/a.py').trim());
    expect((await f.shadow.read(change.beforeHash!))?.toString()).toBe('a = ours\n');
  });

  it('takes the merged index entry, not the HEAD one, as the before-image of a file the merge staged cleanly', async () => {
    const f = await conflicted();
    const change = f.service.changes().find((c) => c.path === OTHER)!;
    expect((await f.shadow.read(change.beforeHash!))?.toString()).toBe('other = side\n');
    expect(change.beforeHash).not.toBe(git(f.wt, 'rev-parse', 'HEAD:backend/src/other.py').trim());
  });
});

describe('ChangeService for an intent-to-add file in a worktree', () => {
  it('does not take the empty blob of "git add -N" as the before-image of a file HEAD has', async () => {
    const f = await fixture();
    git(f.wt, 'rm', '-q', '--cached', 'backend/src/a.py');
    git(f.wt, 'add', '-N', 'backend/src/a.py');
    expect(git(f.wt, 'ls-files', '-s', '--', 'backend/src/a.py')).toContain('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    f.put(A, 'a = 2\n');
    await f.service.handle(f.ev(A));
    const [change] = f.service.changes();
    expect(change!.beforeHash).toBe(git(f.wt, 'rev-parse', 'HEAD:backend/src/a.py').trim());
    await f.revert(change!);
    expect(f.read(A)).toBe(ORIGINAL);
  });

  it('knows no previous content for a new file that is only intent-to-add, and a revert does not blank it', async () => {
    const f = await fixture();
    f.put(`${WT}/scratch.txt`, 'scratch\n');
    git(f.wt, 'add', '-N', 'scratch.txt');
    await f.service.handle(f.ev(`${WT}/scratch.txt`));
    const [change] = f.service.changes();
    expect(change).toMatchObject({ beforeHash: null, beforeMode: 0o644 });
    expect((await f.revert(change!)).files.map((file) => file.outcome)).toEqual(['conflict']);
    expect(f.read(`${WT}/scratch.txt`)).toBe('scratch\n');
  });
});

describe('ChangeService.markUnsighted', () => {
  it('makes the next event of a file with no baseline record unknown previous content, and leaves a file with a baseline alone', async () => {
    const f = await fixture();
    await f.service.handle(f.ev(A));
    const known = f.baselines.get(A)!;
    f.put(`${WT}/scratch.txt`, 'scratch\n');
    f.service.markUnsighted([`${WT}/scratch.txt`, A]);
    f.put(A, 'a = 2\n');
    await Promise.all([f.service.handle(f.ev(`${WT}/scratch.txt`)), f.service.handle(f.ev(A))]);
    const byPath = (path: string) => f.service.changes().find((c) => c.path === path)!;
    expect(byPath(`${WT}/scratch.txt`)).toMatchObject({ beforeHash: null, beforeMode: 0o644 });
    expect(byPath(A)).toMatchObject({ beforeHash: known.hash, beforeMode: known.mode });
  });

  it('ignores a file that has a baseline when it is marked, even if the baseline is gone by the time its event comes', async () => {
    const f = await fixture();
    await f.service.handle(f.ev(A));
    const scratch = `${WT}/scratch.txt`;
    f.put(scratch, 'scratch\n');
    f.baselines.set({ path: scratch, hash: f.gitHash(f.wt, 'scratch.txt'), stored: false, size: 8, mode: 0o644 });
    f.service.markUnsighted([scratch]);
    f.baselines.remove(scratch);
    f.put(scratch, 'scratch again\n');
    await f.service.handle(f.ev(scratch));
    expect(f.service.changes()).toMatchObject([{ path: scratch, beforeHash: null, beforeMode: null }]);
  });

  it('is forgotten once the file has been recorded', async () => {
    const f = await fixture();
    await f.service.handle(f.ev(A));
    f.put(`${WT}/scratch.txt`, 'scratch\n');
    f.service.markUnsighted([`${WT}/scratch.txt`]);
    await f.service.handle(f.ev(`${WT}/scratch.txt`));
    rmSync(join(f.root, WT, 'scratch.txt'));
    await f.service.handle(f.ev(`${WT}/scratch.txt`, false));
    f.put(`${WT}/scratch.txt`, 'again\n');
    await f.service.handle(f.ev(`${WT}/scratch.txt`));
    expect(f.service.changes().map((c) => [c.beforeHash === null, c.afterHash === null, c.beforeMode !== null])).toEqual([[true, false, true], [false, true, true], [true, false, false]]);
  });
});

describe('ChangeService for a repository that is not a worktree of the project', () => {
  async function withClones() {
    const f = await fixture(await projectWithWorktree({ '.gitignore': '.worktrees/\ndist/\nvendor/\n' }));
    git(f.root, 'clone', '-q', f.root, join(f.root, 'vendor/clone1'));
    git(f.root, 'clone', '-q', f.root, join(f.root, 'deps/foo'));
    return f;
  }

  it('records nothing for a file of a clone in an ignored directory', async () => {
    const f = await withClones();
    f.put('vendor/clone1/backend/src/a.py', 'a = 2\n');
    await f.service.handle(f.ev('vendor/clone1/backend/src/a.py'));
    expect([f.service.changes(), f.baselines.paths().filter((path) => path.startsWith('vendor/'))]).toEqual([[], []]);
  });

  it('records a file of a clone the project does not ignore as a file of the project, by its own path and with no git before-image', async () => {
    const f = await withClones();
    f.put('deps/foo/backend/src/a.py', 'a = 2\n');
    await f.service.handle(f.ev('deps/foo/backend/src/a.py'));
    expect(f.service.changes()).toMatchObject([{ path: 'deps/foo/backend/src/a.py', beforeHash: null, beforeMode: null, enforcement: 'enforced' }]);
    expect(Object.keys(nestedMeta(f))).toEqual([]);
  });
});
