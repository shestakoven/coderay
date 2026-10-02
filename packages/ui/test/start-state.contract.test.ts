import { describe, expect, it } from 'vitest';
import type { ClonePhase, ServerMessage } from '@ide/protocol';
import { formatAgo, initialStart, isWorking, PHASE_LABEL, startReducer, type StartState } from '../src/project/start-state';

const server = (state: StartState, message: ServerMessage) => startReducer(state, { type: 'server', message });
const progress = (requestId: string, phase: ClonePhase, percent: number): ServerMessage => ({ type: 'project.clone.progress', requestId, phase, percent });
const cloneResult = (requestId: string, error: string | null): ServerMessage => ({ type: 'project.clone.result', requestId, error });
const createResult = (requestId: string, error: string | null): ServerMessage => ({ type: 'project.create.result', requestId, error });

const cloning = (requestId = 'k1'): StartState => ({ view: 'clone', work: { kind: 'clone', requestId, phase: null, percent: null }, error: null });
const creating = (requestId = 'c1'): StartState => ({ view: 'create', work: { kind: 'create', requestId, phase: null, percent: null }, error: null });

describe('startReducer views', () => {
  it('starts on the home view, idle, with no error', () => {
    expect(initialStart).toEqual({ view: 'home', work: null, error: null });
    expect(isWorking(initialStart)).toBe(false);
  });

  it.each(['create', 'clone', 'home'] as const)('switches to the %s view', (view) => {
    const from: StartState = { view: view === 'home' ? 'clone' : 'home', work: null, error: null };
    expect(startReducer(from, { type: 'view', view })).toEqual({ view, work: null, error: null });
  });
});

describe('startReducer begin', () => {
  it('starts a clone with no phase or percent yet, keeping the view', () => {
    const state = startReducer({ view: 'clone', work: null, error: null }, { type: 'begin', kind: 'clone', requestId: 'k1' });
    expect(state).toEqual(cloning('k1'));
    expect(isWorking(state)).toBe(true);
  });

  it('starts a create, keeping the view', () => {
    const state = startReducer({ view: 'create', work: null, error: null }, { type: 'begin', kind: 'create', requestId: 'c1' });
    expect(state).toEqual(creating('c1'));
    expect(isWorking(state)).toBe(true);
  });

  it('clears the previous error when work begins again', () => {
    const failed: StartState = { view: 'clone', work: null, error: 'fatal: old' };
    expect(startReducer(failed, { type: 'begin', kind: 'clone', requestId: 'k2' })).toEqual(cloning('k2'));
  });
});

describe('startReducer clone progress', () => {
  it('records phase and percent for the running clone', () => {
    expect(server(cloning(), progress('k1', 'receiving', 40))).toEqual({
      view: 'clone', work: { kind: 'clone', requestId: 'k1', phase: 'receiving', percent: 40 }, error: null,
    });
  });

  it('a later update replaces phase and percent', () => {
    const first = server(cloning(), progress('k1', 'receiving', 100));
    expect(server(first, progress('k1', 'resolving', 5)).work).toEqual({ kind: 'clone', requestId: 'k1', phase: 'resolving', percent: 5 });
  });

  it('records a 0 percent update', () => {
    expect(server(cloning(), progress('k1', 'counting', 0)).work).toMatchObject({ phase: 'counting', percent: 0 });
  });

  it('ignores progress for another request, returning the same object', () => {
    const state = cloning('k1');
    expect(server(state, progress('k0', 'receiving', 50))).toBe(state);
  });

  it('ignores progress when nothing runs, returning the same object', () => {
    const state: StartState = { view: 'clone', work: null, error: 'fatal: x' };
    expect(server(state, progress('k1', 'receiving', 50))).toBe(state);
  });
});

describe('startReducer results', () => {
  it('a failed clone stops work, keeps the clone view and shows git\'s line', () => {
    const running = server(cloning(), progress('k1', 'receiving', 70));
    expect(server(running, cloneResult('k1', 'fatal: repository not found'))).toEqual({
      view: 'clone', work: null, error: 'fatal: repository not found',
    });
  });

  it('a failed create stops work, keeps the create view and shows the error', () => {
    const state = server(creating(), createResult('c1', 'already exists'));
    expect(state).toEqual({ view: 'create', work: null, error: 'already exists' });
    expect(isWorking(state)).toBe(false);
  });

  it('a successful result leaves no error', () => {
    expect(server(cloning(), cloneResult('k1', null)).error).toBeNull();
    expect(server(creating(), createResult('c1', null)).error).toBeNull();
  });

  it.each([
    ['a clone result for another request', cloning('k1'), cloneResult('k9', 'fatal: x')],
    ['a create result for another request', creating('c1'), createResult('c9', 'boom')],
    ['a clone result while idle', { view: 'clone', work: null, error: null } as StartState, cloneResult('k1', 'fatal: x')],
    ['a create result while idle', { view: 'create', work: null, error: null } as StartState, createResult('c1', 'boom')],
    ['an unrelated message', cloning('k1'), { type: 'fs.list.result', requestId: 'k1', path: '/', parent: null, entries: [], error: null } as ServerMessage],
  ])('ignores %s, returning the same object', (_label, state, message) => {
    expect(server(state, message)).toBe(state);
  });
});

describe('PHASE_LABEL', () => {
  it('labels every clone phase and nothing else', () => {
    expect(Object.keys(PHASE_LABEL).sort()).toEqual(['checking-out', 'compressing', 'counting', 'receiving', 'resolving']);
    for (const label of Object.values(PHASE_LABEL)) expect(label.trim().length).toBeGreaterThan(0);
  });
});

describe('formatAgo boundaries', () => {
  const now = 1_800_000_000_000;
  const ago = (ms: number) => formatAgo(now, now - ms);
  const S = 1000;
  const M = 60 * S;
  const H = 60 * M;
  const D = 24 * H;

  it.each([
    [0, 'just now'],
    [59 * S + 999, 'just now'],
    [M, '1 min ago'],
    [2 * M - 1, '1 min ago'],
    [59 * M + 59 * S, '59 min ago'],
    [H, '1 h ago'],
    [2 * H - 1, '1 h ago'],
    [23 * H + 59 * M, '23 h ago'],
    [D, '1 d ago'],
    [2 * D - 1, '1 d ago'],
  ])('%d ms ago -> %s', (ms, text) => {
    expect(ago(ms)).toBe(text);
  });

  it('never shows a negative age for a time slightly in the future (assumption: clock skew reads as just now)', () => {
    expect(formatAgo(now, now + 5 * S)).toBe('just now');
  });
});
