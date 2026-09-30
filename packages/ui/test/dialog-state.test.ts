import { describe, expect, it } from 'vitest';
import type { ChangeView, WatchdogEventView } from '@ide/protocol';
import {
  buildAnswer, canExpand, chooseDir, chooseFile, dialogEvent, eventFilePaths, fileDiffRange, fileOptions, groupByDir, initialChoice, markCounts,
  PAGE_FILES, stopAgentLabel, visibleFiles,
} from '../src/history/dialog-state';

let seq = 0;
const change = (o: Partial<ChangeView> = {}): ChangeView => ({
  id: `c${++seq}`, path: 'src/a.ts', beforeHash: null, afterHash: 'h', at: 1, origin: 'agent', enforcement: 'enforced', outOfPlan: true,
  toolUseIds: [], planId: null, planVersion: null, stepKey: null, eventId: null, resolution: null, added: 0, removed: 0, stored: true,
  unreadable: false, beforeMode: null, ...o,
});
const event = (o: Partial<WatchdogEventView> = {}): WatchdogEventView => ({
  id: `e${++seq}`, kind: 'watchdog', mode: 'B', phase: 'pending', resolution: 'pending', changes: [], toolCalls: [], interrupted: false, paused: false,
  runningSubagents: 0, backgroundShell: false, unknownOrigin: false, snapshotSha: null, canExpand: false, defaultAction: null, reason: null, ts: 1,
  resolvedAt: null, ...o,
});
const two = (mode: 'A' | 'B') => event({ mode, changes: [change({ path: 'src/a.ts' }), change({ path: 'lib/b.ts' })] });

describe('initialChoice', () => {
  it('preselects revert for every revertable file in mode A and nothing in mode B', () => {
    const a = initialChoice(event({ mode: 'A', changes: [change({ path: 'src/a.ts' }), change({ path: '.git/HEAD' })] }));
    expect(a.files).toEqual({ 'src/a.ts': 'revert' });
    expect(initialChoice(event({ mode: 'B', changes: [change({ path: 'src/a.ts' })] })).files).toEqual({});
  });
  it('never preselects revert for .git/refs in mode A', () => {
    expect(initialChoice(event({ mode: 'A', changes: [change({ path: '.git/refs/heads/x' })] })).files).toEqual({});
  });
});

describe('fileOptions and chooseFile', () => {
  it('offers only keep for .git/HEAD and .git/refs', () => {
    expect(fileOptions('.git/HEAD')).toEqual(['keep']);
    expect(fileOptions('.git/refs/heads/x')).toEqual(['keep']);
    expect(fileOptions('src/a.ts')).toEqual(['keep', 'revert', 'mine']);
    expect(fileOptions('.git/config')).toEqual(['keep', 'revert', 'mine']);
  });
  it('ignores an answer the file does not offer', () => {
    const c = { files: {} };
    expect(chooseFile(c, '.git/HEAD', 'revert')).toBe(c);
    expect(chooseFile(c, 'src/a.ts', 'mine').files).toEqual({ 'src/a.ts': 'mine' });
  });
});

describe('buildAnswer', () => {
  it('returns no answer until every file is chosen', () => {
    const e = two('B');
    expect(buildAnswer(e, { files: {} })).toBeNull();
    expect(buildAnswer(e, { files: { 'src/a.ts': 'keep' } })).toBeNull();
    expect(buildAnswer(event(), { files: {} })).toBeNull();
  });
  it('collapses equal answers into one and keeps per-file answers when they differ', () => {
    const e = two('B');
    expect(buildAnswer(e, { files: { 'src/a.ts': 'revert', 'lib/b.ts': 'revert' } })).toEqual({ kind: 'all', answer: 'revert' });
    expect(buildAnswer(e, { files: { 'src/a.ts': 'revert', 'lib/b.ts': 'keep' } })).toEqual({ kind: 'files', files: { 'src/a.ts': 'revert', 'lib/b.ts': 'keep' } });
  });
  it('keeps per-file answers when a mode A default meets a keep-only file', () => {
    const e = event({ mode: 'A', changes: [change({ path: 'src/a.ts' }), change({ path: '.git/HEAD' })] });
    const c = chooseFile(initialChoice(e), '.git/HEAD', 'keep');
    expect(buildAnswer(e, c)).toEqual({ kind: 'files', files: { 'src/a.ts': 'revert', '.git/HEAD': 'keep' } });
  });
});

describe('directories', () => {
  const e = event({ changes: [change({ path: 'src/a.ts' }), change({ path: 'src/b.ts' }), change({ path: 'lib/c.ts' }), change({ path: 'root.txt' }), change({ path: 'src/a.ts' })] });
  it('groups by directory with sorted unique paths', () => {
    expect(groupByDir(e).map((g) => [g.dir, g.paths])).toEqual([['.', ['root.txt']], ['lib', ['lib/c.ts']], ['src', ['src/a.ts', 'src/b.ts']]]);
  });
  it('sets a whole directory at once and reports mixed', () => {
    const src = groupByDir(e)[2]!;
    let c = chooseDir({ files: {} }, src, 'revert');
    expect(c.files).toEqual({ 'src/a.ts': 'revert', 'src/b.ts': 'revert' });
    expect(groupByDir(e, c)[2]!.answer).toBe('revert');
    expect(groupByDir(e, c)[1]!.answer).toBeNull();
    c = chooseFile(c, 'src/b.ts', 'keep');
    expect(groupByDir(e, c)[2]!.answer).toBe('mixed');
  });
  it('leaves keep-only files out of a directory revert', () => {
    const g = event({ changes: [change({ path: '.git/HEAD' }), change({ path: '.git/config' })] });
    const c = chooseDir({ files: {} }, groupByDir(g)[0]!, 'revert');
    expect(c.files).toEqual({ '.git/config': 'revert' });
  });
});

describe('visibleFiles', () => {
  const many = (n: number) => event({ changes: Array.from({ length: n }, (_, i) => change({ path: `gen/f${String(i).padStart(3, '0')}.ts` })) });
  const count = (g: { paths: string[] }[]) => g.reduce((n, x) => n + x.paths.length, 0);
  it('shows 100 of 300 files and hides the rest until expanded', () => {
    const groups = groupByDir(many(300));
    const { shown, hidden } = visibleFiles(groups, false);
    expect(PAGE_FILES).toBe(100);
    expect(count(shown)).toBe(100);
    expect(hidden).toBe(200);
    expect(shown[0]!.paths[99]).toBe('gen/f099.ts');
    const all = visibleFiles(groups, true);
    expect(count(all.shown)).toBe(300);
    expect(all.hidden).toBe(0);
  });
  it('shows exactly 100 files without hiding any', () => {
    expect(visibleFiles(groupByDir(many(100)), false).hidden).toBe(0);
    expect(visibleFiles(groupByDir(many(101)), false).hidden).toBe(1);
  });
  it('cuts across directories', () => {
    const e = event({ changes: [...Array.from({ length: 60 }, (_, i) => change({ path: `a/f${i}` })), ...Array.from({ length: 60 }, (_, i) => change({ path: `b/f${i}` }))] });
    const { shown, hidden } = visibleFiles(groupByDir(e), false);
    expect(shown.map((g) => g.paths.length)).toEqual([60, 40]);
    expect(hidden).toBe(20);
  });
});

describe('agent controls', () => {
  it('labels the stop button only when the agent was not interrupted and subagents run', () => {
    expect(stopAgentLabel(event({ runningSubagents: 2 }))).toBe('Stop agent (stops 2 subagents)');
    expect(stopAgentLabel(event({ runningSubagents: 1 }))).toBe('Stop agent (stops 1 subagent)');
    expect(stopAgentLabel(event({ runningSubagents: 2, interrupted: true }))).toBeNull();
    expect(stopAgentLabel(event({ runningSubagents: 0 }))).toBeNull();
  });
  it('mirrors canExpand from the event', () => {
    expect(canExpand(event({ canExpand: true }))).toBe(true);
    expect(canExpand(event({ canExpand: false }))).toBe(false);
  });
});

describe('diff range, marks and event selection', () => {
  it('takes the earliest before and the latest after hash of a path', () => {
    const e = event({ changes: [change({ path: 'x', at: 5, beforeHash: 'b2', afterHash: 'a2' }), change({ path: 'x', at: 2, beforeHash: 'b1', afterHash: 'a1' })] });
    expect(fileDiffRange(e, 'x')).toEqual({ before: 'b1', after: 'a2' });
    expect(fileDiffRange(e, 'nope')).toBeNull();
  });
  it('counts marks per node and skips unplaced targets', () => {
    expect([...markCounts(['n1', 'n2', 'n1', null])]).toEqual([['n1', 2], ['n2', 1]]);
  });
  it('marks files of unresolved events only and opens the dialog for the oldest pending event', () => {
    const resolved = event({ phase: 'resolved', changes: [change({ path: 'done.ts' })] });
    const collecting = event({ phase: 'collecting', ts: 1, changes: [change({ path: 'c.ts' })] });
    const late = event({ ts: 9, changes: [change({ path: 'late.ts' })] });
    const early = event({ ts: 4, changes: [change({ path: 'early.ts' })] });
    expect([...eventFilePaths([resolved, collecting, late, early])].sort()).toEqual(['c.ts', 'early.ts', 'late.ts']);
    expect(dialogEvent([resolved, collecting, late, early])).toBe(early);
    expect(dialogEvent([resolved])).toBeNull();
  });
});
