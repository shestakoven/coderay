import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@ide/protocol';
import { formatAgo, initialStart, isWorking, PHASE_LABEL, startReducer, type StartState } from '../src/project/start-state';

const server = (state: StartState, message: ServerMessage) => startReducer(state, { type: 'server', message });
const working = (kind: 'create' | 'clone', requestId = 'r1'): StartState => startReducer(initialStart, { type: 'begin', kind, requestId });

describe('startReducer views', () => {
  it('switches the view and clears the error', () => {
    const failed: StartState = { ...initialStart, error: 'old' };
    expect(startReducer(failed, { type: 'view', view: 'clone' })).toEqual({ view: 'clone', work: null, error: null });
  });

  it('ignores a view change while a create or clone is working', () => {
    const busy = working('clone');
    expect(startReducer(busy, { type: 'view', view: 'home' })).toBe(busy);
  });
});

describe('startReducer begin', () => {
  it('records the work, with no progress yet, and clears the error', () => {
    const s = startReducer({ ...initialStart, view: 'create', error: 'old' }, { type: 'begin', kind: 'create', requestId: 'r1' });
    expect(s).toEqual({ view: 'create', work: { kind: 'create', requestId: 'r1', phase: null, percent: null }, error: null });
    expect(isWorking(s)).toBe(true);
    expect(isWorking(initialStart)).toBe(false);
  });
});

describe('startReducer clone progress', () => {
  it('records phase and percent for the working request', () => {
    const s = server(working('clone'), { type: 'project.clone.progress', requestId: 'r1', phase: 'receiving', percent: 42 });
    expect(s.work).toEqual({ kind: 'clone', requestId: 'r1', phase: 'receiving', percent: 42 });
  });

  it('ignores progress for another request and progress when nothing is working', () => {
    const busy = working('clone');
    expect(server(busy, { type: 'project.clone.progress', requestId: 'other', phase: 'receiving', percent: 1 })).toBe(busy);
    expect(server(initialStart, { type: 'project.clone.progress', requestId: 'r1', phase: 'receiving', percent: 1 })).toBe(initialStart);
  });
});

describe('startReducer results', () => {
  it.each([
    ['create', 'project.create.result'],
    ['clone', 'project.clone.result'],
  ] as const)('a failed %s stops the work and shows the error', (kind, type) => {
    const s = server(working(kind), { type, requestId: 'r1', error: 'fatal: nope' } as ServerMessage);
    expect(s).toMatchObject({ work: null, error: 'fatal: nope' });
  });

  it.each(['project.create.result', 'project.clone.result'] as const)('a successful %s keeps waiting for the restart', (type) => {
    const busy = working(type === 'project.create.result' ? 'create' : 'clone');
    const s = server(busy, { type, requestId: 'r1', error: null } as ServerMessage);
    expect(s).toEqual(busy);
    expect(isWorking(s)).toBe(true);
  });

  it('ignores a result for another request and a result when nothing is working', () => {
    const busy = working('create');
    expect(server(busy, { type: 'project.create.result', requestId: 'other', error: 'x' })).toBe(busy);
    expect(server(initialStart, { type: 'project.create.result', requestId: 'r1', error: 'x' })).toBe(initialStart);
  });

  it('ignores unrelated server messages', () => {
    const busy = working('clone');
    expect(server(busy, { type: 'chat.stopped' } as unknown as ServerMessage)).toBe(busy);
  });
});

describe('PHASE_LABEL', () => {
  it('has a distinct label for every clone phase', () => {
    expect(new Set(Object.values(PHASE_LABEL)).size).toBe(5);
    expect(Object.keys(PHASE_LABEL).sort()).toEqual(['checking-out', 'compressing', 'counting', 'receiving', 'resolving']);
  });
});

describe('formatAgo', () => {
  const now = Date.UTC(2026, 9, 2, 12, 0, 0);
  const ago = (ms: number) => formatAgo(now, now - ms);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it.each([
    [0, 'just now'],
    [59_000, 'just now'],
    [MIN, '1 min ago'],
    [59 * MIN, '59 min ago'],
    [HOUR, '1 h ago'],
    [23 * HOUR, '23 h ago'],
    [DAY, '1 d ago'],
    [29 * DAY, '29 d ago'],
    [30 * DAY, '1 mo ago'],
    [364 * DAY, '12 mo ago'],
    [365 * DAY, '1 y ago'],
  ])('%d ms is %j', (ms, text) => {
    expect(ago(ms)).toBe(text);
  });

  it('treats a time in the future as just now', () => {
    expect(formatAgo(now, now + HOUR)).toBe('just now');
  });
});
