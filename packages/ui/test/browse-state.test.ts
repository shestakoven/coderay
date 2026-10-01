import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@ide/protocol';
import { browseReducer, initialBrowse, isOpening, joinPath, type BrowseState } from '../src/project/browse-state';

const entries = [{ name: 'app', isGit: true }, { name: 'docs', isGit: false }];
const listResult = (requestId: string, over: Record<string, unknown> = {}): ServerMessage =>
  ({ type: 'fs.list.result', requestId, path: '/home/u', parent: '/home', entries, error: null, ...over }) as ServerMessage;
const openResult = (requestId: string, error: string | null): ServerMessage => ({ type: 'project.open.result', requestId, error });
const server = (s: BrowseState, message: ServerMessage) => browseReducer(s, { type: 'server', message });

describe('browseReducer fs.list.result', () => {
  it('records the listing for the pending request and clears pending', () => {
    const pending = browseReducer(initialBrowse, { type: 'list', requestId: 'r1' });
    expect(pending.pending).toBe('r1');
    expect(server(pending, listResult('r1'))).toEqual({ ...initialBrowse, path: '/home/u', parent: '/home', entries, pending: null });
  });

  it('clears an earlier error on success', () => {
    const failed: BrowseState = { ...initialBrowse, pending: 'r2', error: 'old' };
    expect(server(failed, listResult('r2')).error).toBeNull();
  });

  it('ignores a result for a stale request id', () => {
    const pending = browseReducer(initialBrowse, { type: 'list', requestId: 'r2' });
    expect(server(pending, listResult('r1'))).toBe(pending);
  });

  it('ignores a result when nothing is pending', () => {
    expect(server(initialBrowse, listResult('r1'))).toBe(initialBrowse);
  });

  it('keeps the previous listing when the list request fails', () => {
    const shown: BrowseState = { ...initialBrowse, path: '/a', parent: '/', entries, pending: 'r3' };
    const s = server(shown, listResult('r3', { path: '/x', parent: null, entries: [], error: 'Folder not found' }));
    expect(s).toEqual({ ...shown, pending: null, error: 'Folder not found' });
  });

  it('clears the error when a new list starts', () => {
    const s = browseReducer({ ...initialBrowse, error: 'bad' }, { type: 'list', requestId: 'r' });
    expect(s.error).toBeNull();
  });

  it('does not treat a project.open result as a list result', () => {
    const pending = browseReducer(initialBrowse, { type: 'list', requestId: 'same' });
    expect(server(pending, openResult('same', null))).toBe(pending);
  });
});

describe('browseReducer project.open.result', () => {
  it('keeps opening set on success so the UI waits for the restart', () => {
    const opening = browseReducer(initialBrowse, { type: 'open', requestId: 'o1' });
    const s = server(opening, openResult('o1', null));
    expect(s.opening).toBe('o1');
    expect(s.error).toBeNull();
  });

  it('clears opening and shows the error on failure', () => {
    const opening = browseReducer(initialBrowse, { type: 'open', requestId: 'o1' });
    const s = server(opening, openResult('o1', 'That folder does not exist or is not readable.'));
    expect(s.opening).toBeNull();
    expect(s.error).toBe('That folder does not exist or is not readable.');
  });

  it('ignores a result for an unknown request id', () => {
    const opening = browseReducer(initialBrowse, { type: 'open', requestId: 'o1' });
    expect(server(opening, openResult('other', 'boom'))).toBe(opening);
  });

  it('ignores a result when nothing is opening', () => {
    expect(server(initialBrowse, openResult('o1', 'boom'))).toBe(initialBrowse);
  });

  it('clears an earlier error when opening starts', () => {
    const s = browseReducer({ ...initialBrowse, error: 'old' }, { type: 'open', requestId: 'o' });
    expect(s).toMatchObject({ opening: 'o', error: null });
  });

  it('does not touch the listing', () => {
    const shown: BrowseState = { ...initialBrowse, path: '/a', entries, opening: 'o1' };
    const s = server(shown, openResult('o1', 'boom'));
    expect([s.path, s.entries]).toEqual(['/a', entries]);
  });
});

describe('browseReducer misc', () => {
  it('reset returns to the initial state', () => {
    const busy: BrowseState = { path: '/a', parent: '/', entries, error: 'e', pending: 'p', opening: 'o' };
    expect(browseReducer(busy, { type: 'reset' })).toEqual(initialBrowse);
  });

  it('ignores unrelated server messages', () => {
    const s = browseReducer(initialBrowse, { type: 'list', requestId: 'r' });
    expect(server(s, { type: 'chat.stopped' } as unknown as ServerMessage)).toBe(s);
  });
});

describe('joinPath', () => {
  it('adds a separator when the base has no trailing slash', () => {
    expect(joinPath('/home/u', 'app')).toBe('/home/u/app');
  });

  it('does not double the separator when the base ends with a slash', () => {
    expect(joinPath('/home/u/', 'app')).toBe('/home/u/app');
    expect(joinPath('/', 'etc')).toBe('/etc');
  });
});

describe('isOpening', () => {
  it('is true only while an open request is set', () => {
    expect(isOpening(initialBrowse)).toBe(false);
    expect(isOpening({ ...initialBrowse, opening: 'o' })).toBe(true);
    expect(isOpening({ ...initialBrowse, pending: 'p' })).toBe(false);
  });
});
