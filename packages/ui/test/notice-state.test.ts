import { describe, expect, it } from 'vitest';
import { noticesReducer, type NoticeItem } from '../src/project/notice-state';
import type { StatusKind } from '../src/project/project-status';

const notice = (id: string, projectId: string | null, kind: NoticeItem['kind'] = 'attention'): NoticeItem =>
  ({ id, projectId, kind, title: `${projectId ?? 'IDE'} title`, body: `${id} body` });
const add = (state: NoticeItem[], item: NoticeItem) => noticesReducer(state, { type: 'add', notice: item });
const addAll = (items: NoticeItem[]) => items.reduce(add, [] as NoticeItem[]);
const ids = (state: NoticeItem[]) => state.map((item) => item.id).sort();

describe('noticesReducer add', () => {
  it('adds a notice', () => {
    expect(add([], notice('n1', 'a'))).toEqual([notice('n1', 'a')]);
  });

  it('replaces the notice of the same project', () => {
    const state = addAll([notice('n1', 'a', 'attention'), notice('n2', 'b')]);
    const next = add(state, notice('n3', 'a', 'error'));
    expect(ids(next)).toEqual(['n2', 'n3']);
    expect(next.find((item) => item.projectId === 'a')).toEqual(notice('n3', 'a', 'error'));
  });

  it('never replaces with a notice that belongs to no project', () => {
    const state = addAll([notice('n1', null), notice('n2', 'a')]);
    expect(ids(add(state, notice('n3', null)))).toEqual(['n1', 'n2', 'n3']);
  });

  it('keeps a notice that belongs to no project when a project notice arrives', () => {
    expect(ids(addAll([notice('n1', null), notice('n2', 'a'), notice('n3', 'a')]))).toEqual(['n1', 'n3']);
  });

  it('keeps only the newest four', () => {
    const state = addAll([notice('n1', 'a'), notice('n2', 'b'), notice('n3', 'c'), notice('n4', 'd'), notice('n5', 'e')]);
    expect(ids(state)).toEqual(['n2', 'n3', 'n4', 'n5']);
  });

  it('keeps four when a replacement makes room', () => {
    const state = addAll([notice('n1', 'a'), notice('n2', 'b'), notice('n3', 'c'), notice('n4', 'd'), notice('n5', 'a')]);
    expect(ids(state)).toEqual(['n2', 'n3', 'n4', 'n5']);
  });

  it('counts notices of no project toward the limit', () => {
    const state = addAll([notice('n1', null), notice('n2', null), notice('n3', null), notice('n4', null), notice('n5', null), notice('n6', null)]);
    expect(ids(state)).toEqual(['n3', 'n4', 'n5', 'n6']);
  });

  it('leaves the previous list untouched', () => {
    const state = addAll([notice('n1', 'a'), notice('n2', 'b'), notice('n3', 'c'), notice('n4', 'd')]);
    const copy = structuredClone(state);
    add(state, notice('n5', 'a'));
    add(state, notice('n6', 'e'));
    expect(state).toEqual(copy);
  });
});

describe('noticesReducer dismiss', () => {
  it('removes the notice with the id', () => {
    expect(ids(noticesReducer(addAll([notice('n1', 'a'), notice('n2', 'b')]), { type: 'dismiss', id: 'n1' }))).toEqual(['n2']);
  });

  it('keeps everything for an unknown id', () => {
    const state = addAll([notice('n1', 'a'), notice('n2', null)]);
    expect(noticesReducer(state, { type: 'dismiss', id: 'nope' })).toEqual(state);
  });
});

describe.each(['shown', 'gone'] as const)('noticesReducer %s', (type) => {
  it('removes every notice of the project and nothing else', () => {
    const state = [notice('n1', 'a', 'attention'), notice('n2', 'b'), notice('n3', 'a', 'done'), notice('n4', null)];
    expect(ids(noticesReducer(state, { type, projectId: 'a' }))).toEqual(['n2', 'n4']);
  });

  it('keeps everything when the project has no notice', () => {
    const state = [notice('n1', 'a'), notice('n2', null)];
    expect(noticesReducer(state, { type, projectId: 'zzz' })).toEqual(state);
  });
});

describe('noticesReducer status', () => {
  const kinds: StatusKind[] = ['working', 'attention', 'idle', 'error'];
  // Rows: the notice kind; columns: the new status kind; cell: does the notice survive?
  const survives: Record<NoticeItem['kind'], Record<StatusKind, boolean>> = {
    attention: { working: false, attention: true, idle: false, error: false },
    error: { working: false, attention: false, idle: false, error: true },
    done: { working: true, attention: true, idle: true, error: true },
  };
  const cases = Object.entries(survives).flatMap(([noticeKind, row]) =>
    kinds.map((status) => [noticeKind, status, row[status]] as [NoticeItem['kind'], StatusKind, boolean]));

  it.each(cases)('a %s notice when the project turns %s survives: %s', (noticeKind, status, kept) => {
    const state = [notice('mine', 'a', noticeKind)];
    expect(noticesReducer(state, { type: 'status', projectId: 'a', kind: status }).map((item) => item.id)).toEqual(kept ? ['mine'] : []);
  });

  it('leaves the notices of other projects and of no project alone', () => {
    const state = [notice('n1', 'a', 'attention'), notice('n2', 'b', 'attention'), notice('n3', null, 'error'), notice('n4', 'b', 'error')];
    expect(ids(noticesReducer(state, { type: 'status', projectId: 'a', kind: 'working' }))).toEqual(['n2', 'n3', 'n4']);
  });
});
