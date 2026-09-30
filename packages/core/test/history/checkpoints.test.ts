import { describe, expect, it } from 'vitest';
import type { ChangeView } from '@ide/protocol';
import { Checkpoints } from '../../src/history/checkpoints';
import { openStore } from '../../src/store/store';
import { sessionRecord, tempDir } from '../helpers';

const change = (path: string, beforeHash: string | null, afterHash: string | null, o: Partial<ChangeView> = {}): ChangeView => ({
  id: `${path}-${afterHash}`, path, beforeHash, afterHash, at: 1, origin: 'agent', enforcement: 'enforced', outOfPlan: false, toolUseIds: ['t'],
  planId: 'p', planVersion: 1, stepKey: 'edit', eventId: null, resolution: null, added: null, removed: null, stored: true, unreadable: false, beforeMode: null, ...o,
});

function setup() {
  const store = openStore(tempDir('cp-store-'));
  store.saveSession(sessionRecord('s1', '/tmp'));
  let session: string | null = 's1';
  let clock = 100;
  const make = () => new Checkpoints(store, () => session, () => (clock += 1));
  return { store, checkpoints: make(), make, setSession: (id: string | null) => { session = id; } };
}

describe('Checkpoints', () => {
  it('keeps the first beforeHash and the last afterHash per path and counts files', () => {
    const { checkpoints } = setup();
    checkpoints.begin('p', 'edit');
    checkpoints.record(change('a.ts', null, 'h1'));
    checkpoints.record(change('a.ts', 'h1', 'h2'));
    checkpoints.record(change('b.ts', 'b0', null));
    expect(checkpoints.manifests('p', 'edit')).toMatchObject({ cycle: 0, before: { 'a.ts': null, 'b.ts': 'b0' }, after: { 'a.ts': 'h2', 'b.ts': null }, sealedAt: null });
    expect(checkpoints.views()).toEqual([{ planId: 'p', stepKey: 'edit', cycle: 0, before: 2, after: null, startedAt: 101, sealedAt: null }]);
  });

  it('ignores a change with no step, another step, or no open cycle', () => {
    const { checkpoints } = setup();
    checkpoints.begin('p', 'edit');
    checkpoints.record(change('a.ts', 'x', 'y', { planId: null, stepKey: null }));
    checkpoints.record(change('a.ts', 'x', 'y', { stepKey: 'other' }));
    expect(checkpoints.manifests('p', 'edit')?.before).toEqual({});
    checkpoints.seal('p', 'edit');
    checkpoints.record(change('late.ts', 'x', 'y'));
    expect(checkpoints.manifests('p', 'edit')?.after).toEqual({});
  });

  it('seals a step and counts its after files', () => {
    const { checkpoints } = setup();
    checkpoints.begin('p', 'edit');
    checkpoints.record(change('a.ts', 'a0', 'a1'));
    checkpoints.seal('p', 'edit');
    expect(checkpoints.views()).toEqual([{ planId: 'p', stepKey: 'edit', cycle: 0, before: 1, after: 1, startedAt: 101, sealedAt: 102 }]);
  });

  it('starts cycle + 1 on a later begin and keeps each cycle apart', () => {
    const { checkpoints } = setup();
    checkpoints.begin('p', 'edit');
    checkpoints.record(change('a.ts', 'a0', 'a1'));
    checkpoints.seal('p', 'edit');
    checkpoints.begin('p', 'edit');
    checkpoints.record(change('b.ts', 'b0', 'b1'));
    expect(checkpoints.manifests('p', 'edit')).toMatchObject({ cycle: 1, before: { 'b.ts': 'b0' }, after: { 'b.ts': 'b1' } });
    expect(checkpoints.views().map((v) => [v.cycle, v.before, v.after])).toEqual([[0, 1, 1], [1, 1, null]]);
    expect(checkpoints.manifests('p', 'nothing')).toBeUndefined();
  });

  it('persists to the store and reloads for the same session only', () => {
    const { store, checkpoints, make, setSession } = setup();
    checkpoints.begin('p', 'edit');
    checkpoints.record(change('a.ts', 'a0', 'a1'));
    checkpoints.seal('p', 'edit');
    expect(store.checkpoints('s1')).toHaveLength(1);
    expect(make().manifests('p', 'edit')).toMatchObject({ before: { 'a.ts': 'a0' }, sealedAt: expect.any(Number) });
    const again = make();
    again.begin('p', 'edit');
    expect(again.manifests('p', 'edit')?.cycle).toBe(1);
    setSession(null);
    expect(again.views()).toEqual([]);
  });
});
