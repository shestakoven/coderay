import { describe, expect, it } from 'vitest';
import type { ChangeView, CheckpointView, HistoryView } from '@ide/protocol';
import { changeIndex, nodeChanges, nodeStateClass, type NodeState } from '../src/history/history-state';
import { changeLine } from '../src/history/timeline-state';
import { demoSnapshot } from './snapshot';

describe('nodeStateClass', () => {
  it.each([
    [['modified', 'out-of-plan'], 'out-of-plan'],
    [['out-of-plan', 'modified', 'in-progress'], 'out-of-plan'],
    [['modified', 'in-progress'], 'in-progress'],
    [['modified'], 'modified'],
    [[], ''],
  ])('picks %j → %s', (states, cls) => {
    expect(nodeStateClass(states as NodeState[])).toBe(cls);
  });
});

const view = (o: Partial<HistoryView> = {}): HistoryView => ({ changes: [], events: [], reverts: [], checkpoints: [], gateEvents: [], summaries: [], ...o });
const change = (o: Partial<ChangeView>): ChangeView => ({
  id: 'c1', path: 'x.ts', beforeHash: null, afterHash: 'h', at: 1, origin: 'agent', enforcement: 'enforced', outOfPlan: false, toolUseIds: [], planId: null,
  planVersion: null, stepKey: null, eventId: null, resolution: null, added: 3, removed: 1, stored: true, unreadable: false, beforeMode: null, ...o,
});
const open: CheckpointView = { planId: 'p', stepKey: 'a', cycle: 0, before: 1, after: null, startedAt: 1, sealedAt: null };

describe('changeIndex', () => {
  it('is empty without history', () => {
    expect(changeIndex(view(), null).size).toBe(0);
  });

  it('indexes touched files with their derived state and the node line', () => {
    const path = 'src/api/a.ts';
    const h = view({ changes: [change({ path, planId: 'p', stepKey: 'a' })], checkpoints: [open] });
    const index = changeIndex(h, demoSnapshot());
    const found = index.get(path)!;
    expect(nodeStateClass(found.states)).toBe('in-progress');
    expect(found).toEqual(nodeChanges(h, demoSnapshot(), path));
    expect(changeLine(found)).toBe('+3 −1 · 1 file');
    expect(index.get('folder:src/api')?.files).toEqual([path]);
  });

  it('marks an unresolved out-of-plan change', () => {
    const path = 'src/api/a.ts';
    const found = changeIndex(view({ changes: [change({ path, outOfPlan: true })] }), demoSnapshot()).get(path)!;
    expect(nodeStateClass(found.states)).toBe('out-of-plan');
  });
});
