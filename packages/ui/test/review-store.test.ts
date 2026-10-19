import { describe, expect, it } from 'vitest';
import { clampListWidth, DEFAULT_PREFS, LIST_WIDTH, loadPrefs, loadRequested, savePrefs, saveRequested, type ReviewPrefs } from '../src/history/review-store';

const memory = () => {
  const data = new Map<string, string>();
  return { data, getItem: (key: string): string | null => data.get(key) ?? null, setItem: (key: string, value: string): void => void data.set(key, value) };
};
type Memory = ReturnType<typeof memory>;
const broken = {
  getItem: (): string => { throw new Error('denied'); },
  setItem: (): void => { throw new Error('quota'); },
};
// Writes `raw` under whichever key the store used for a save, then reads it back through `load`.
const withRaw = <T,>(save: (store: Memory) => void, load: (store: Memory) => T, raw: string): T => {
  const store = memory();
  save(store);
  const [key] = [...store.data.keys()];
  store.data.set(key!, raw);
  return load(store);
};
const defaults: ReviewPrefs = { mode: 'unified', listWidth: 320, showContext: true, view: 'diff' };

describe('loadRequested and saveRequested', () => {
  const rawRequested = (raw: string) => withRaw((s) => saveRequested(s, '/proj', {}), (s) => loadRequested(s, '/proj'), raw);

  it('returns what was saved, including deleted files saved as null', () => {
    const store = memory();
    saveRequested(store, '/proj', { 'a.ts': 'h1', 'gone.ts': null });
    expect(loadRequested(store, '/proj')).toEqual({ 'a.ts': 'h1', 'gone.ts': null });
  });

  it('returns an empty record when nothing was saved', () => {
    expect(loadRequested(memory(), '/proj')).toEqual({});
  });

  it('replaces the earlier save of the same project', () => {
    const store = memory();
    saveRequested(store, '/proj', { 'a.ts': 'h1' });
    saveRequested(store, '/proj', { 'b.ts': 'h2' });
    expect(loadRequested(store, '/proj')).toEqual({ 'b.ts': 'h2' });
  });

  it('can save an empty record', () => {
    const store = memory();
    saveRequested(store, '/proj', { 'a.ts': 'h1' });
    saveRequested(store, '/proj', {});
    expect(loadRequested(store, '/proj')).toEqual({});
  });

  it('keeps projects apart', () => {
    const store = memory();
    saveRequested(store, '/proj/a', { 'a.ts': 'ha' });
    saveRequested(store, '/proj/b', { 'b.ts': 'hb' });
    expect(loadRequested(store, '/proj/a')).toEqual({ 'a.ts': 'ha' });
    expect(loadRequested(store, '/proj/b')).toEqual({ 'b.ts': 'hb' });
    expect(loadRequested(store, '/proj/c')).toEqual({});
  });

  it('does not let a project whose path is a prefix of another read its data', () => {
    const store = memory();
    saveRequested(store, '/proj/app', { 'a.ts': 'h' });
    expect(loadRequested(store, '/proj')).toEqual({});
    expect(loadRequested(store, '/proj/app/sub')).toEqual({});
  });

  it('stores under a key that names the project', () => {
    const store = memory();
    saveRequested(store, '/work/my-project', { 'a.ts': 'h' });
    expect([...store.data.keys()].every((key) => key.includes('/work/my-project'))).toBe(true);
    expect(store.data.size).toBe(1);
  });

  it('stores a JSON object', () => {
    const store = memory();
    saveRequested(store, '/proj', { 'a.ts': 'h1', 'b.ts': null });
    expect(JSON.parse([...store.data.values()][0]!)).toEqual({ 'a.ts': 'h1', 'b.ts': null });
  });

  it.each(['{not json', '', '{', 'undefined'])('returns an empty record for unparsable data %j', (raw) => {
    expect(rawRequested(raw)).toEqual({});
  });

  it.each(['[]', '["a.ts"]', '"text"', '5', 'null', 'true'])('returns an empty record when the data is not an object: %s', (raw) => {
    expect(rawRequested(raw)).toEqual({});
  });

  it('keeps entries whose value is a hash or null and drops all others', () => {
    const raw = JSON.stringify({ ok: 'h', gone: null, number: 5, flag: true, object: {}, list: ['h'], empty: '' });
    expect(rawRequested(raw)).toEqual({ ok: 'h', gone: null, empty: '' });
  });

  it('returns an empty record without storage', () => {
    expect(loadRequested(undefined, '/proj')).toEqual({});
  });

  it('does not throw saving without storage', () => {
    expect(() => saveRequested(undefined, '/proj', { 'a.ts': 'h' })).not.toThrow();
  });

  it('returns an empty record when reading throws', () => {
    expect(loadRequested(broken, '/proj')).toEqual({});
  });

  it('does not throw when writing fails', () => {
    expect(() => saveRequested(broken, '/proj', { 'a.ts': 'h' })).not.toThrow();
  });
});

describe('clampListWidth', () => {
  it('has the documented bounds and starting width', () => {
    expect(LIST_WIDTH).toEqual({ min: 220, max: 560, initial: 320 });
  });

  it('leaves a width inside the bounds alone', () => {
    expect(clampListWidth(320)).toBe(320);
    expect(clampListWidth(400)).toBe(400);
  });

  it('keeps the bounds themselves', () => {
    expect(clampListWidth(LIST_WIDTH.min)).toBe(LIST_WIDTH.min);
    expect(clampListWidth(LIST_WIDTH.max)).toBe(LIST_WIDTH.max);
  });

  it('raises a width one below the minimum to the minimum', () => {
    expect(clampListWidth(LIST_WIDTH.min - 1)).toBe(LIST_WIDTH.min);
  });

  it('lowers a width one above the maximum to the maximum', () => {
    expect(clampListWidth(LIST_WIDTH.max + 1)).toBe(LIST_WIDTH.max);
  });

  it('clamps extreme and negative values', () => {
    expect(clampListWidth(0)).toBe(LIST_WIDTH.min);
    expect(clampListWidth(-500)).toBe(LIST_WIDTH.min);
    expect(clampListWidth(-Infinity)).toBe(LIST_WIDTH.min);
    expect(clampListWidth(1e9)).toBe(LIST_WIDTH.max);
    expect(clampListWidth(Infinity)).toBe(LIST_WIDTH.max);
  });

  it('rounds a fractional width to a whole pixel', () => {
    expect(clampListWidth(300.4)).toBe(300);
    expect(clampListWidth(300.5)).toBe(301);
    expect(clampListWidth(300.6)).toBe(301);
  });

  it('gives a whole number at the bounds even for fractional values just inside them', () => {
    expect(clampListWidth(LIST_WIDTH.min + 0.4)).toBe(LIST_WIDTH.min);
    expect(clampListWidth(LIST_WIDTH.max - 0.4)).toBe(LIST_WIDTH.max);
  });
});

describe('loadPrefs and savePrefs', () => {
  const rawPrefs = (raw: string): ReviewPrefs => withRaw((s) => savePrefs(s, defaults), (s) => loadPrefs(s), raw);
  const prefs = (stored: unknown): ReviewPrefs => rawPrefs(JSON.stringify(stored));

  it('has the unified view, the starting width and the context shown by default', () => {
    expect(DEFAULT_PREFS).toEqual(defaults);
  });

  it('returns the defaults when nothing was saved', () => {
    expect(loadPrefs(memory())).toEqual(defaults);
  });

  it('returns the defaults without storage', () => {
    expect(loadPrefs(undefined)).toEqual(defaults);
  });

  it('returns what was saved', () => {
    const store = memory();
    savePrefs(store, { mode: 'split', listWidth: 444, showContext: false, view: 'diff' });
    expect(loadPrefs(store)).toEqual({ mode: 'split', listWidth: 444, showContext: false, view: 'diff' });
  });

  it('returns the latest save', () => {
    const store = memory();
    savePrefs(store, { mode: 'split', listWidth: 300, showContext: false, view: 'diff' });
    savePrefs(store, { mode: 'unified', listWidth: 350, showContext: true, view: 'diff' });
    expect(loadPrefs(store)).toEqual({ mode: 'unified', listWidth: 350, showContext: true, view: 'diff' });
  });

  it('does not mix up with the requested changes saved in the same storage', () => {
    const store = memory();
    savePrefs(store, { mode: 'split', listWidth: 400, showContext: false, view: 'diff' });
    saveRequested(store, '/proj', { 'a.ts': 'h' });
    expect(loadPrefs(store)).toEqual({ mode: 'split', listWidth: 400, showContext: false, view: 'diff' });
    expect(loadRequested(store, '/proj')).toEqual({ 'a.ts': 'h' });
  });

  it('stores a JSON object with the preferences', () => {
    const store = memory();
    savePrefs(store, { mode: 'split', listWidth: 400, showContext: false, view: 'diff' });
    expect(JSON.parse([...store.data.values()][0]!)).toEqual({ mode: 'split', listWidth: 400, showContext: false, view: 'diff' });
  });

  it.each(['{not json', '', '{', 'undefined'])('returns the defaults for unparsable data %j', (raw) => {
    expect(rawPrefs(raw)).toEqual(defaults);
  });

  it.each(['"text"', '5', 'null', 'true', '[]', '["split"]'])('returns the defaults when the data is not an object of preferences: %s', (raw) => {
    expect(rawPrefs(raw)).toEqual(defaults);
  });

  it('returns the defaults for fields that are missing', () => {
    expect(prefs({})).toEqual(defaults);
    expect(prefs({ mode: 'split' })).toEqual({ ...defaults, mode: 'split' });
    expect(prefs({ listWidth: 400 })).toEqual({ ...defaults, listWidth: 400 });
    expect(prefs({ showContext: false })).toEqual({ ...defaults, showContext: false });
  });

  it('ignores fields it does not know', () => {
    expect(prefs({ mode: 'split', theme: 'dark', extra: [1] })).toEqual({ ...defaults, mode: 'split' });
  });

  describe('mode', () => {
    it('is split only for the exact string split', () => {
      expect(prefs({ mode: 'split' }).mode).toBe('split');
    });

    it('is unified for unified', () => {
      expect(prefs({ mode: 'unified' }).mode).toBe('unified');
    });

    it.each([['SPLIT'], ['side-by-side'], [''], [null], [1], [true], [['split']], [{}]])('falls back to unified for %j', (mode) => {
      expect(prefs({ mode }).mode).toBe('unified');
    });
  });

  describe('listWidth', () => {
    it('keeps a width inside the bounds', () => {
      expect(prefs({ listWidth: 400 }).listWidth).toBe(400);
    });

    it('raises a width that is too small', () => {
      expect(prefs({ listWidth: 100 }).listWidth).toBe(LIST_WIDTH.min);
      expect(prefs({ listWidth: 0 }).listWidth).toBe(LIST_WIDTH.min);
      expect(prefs({ listWidth: -50 }).listWidth).toBe(LIST_WIDTH.min);
    });

    it('lowers a width that is too large', () => {
      expect(prefs({ listWidth: 9999 }).listWidth).toBe(LIST_WIDTH.max);
    });

    it('rounds a fractional width', () => {
      expect(prefs({ listWidth: 300.4 }).listWidth).toBe(300);
      expect(prefs({ listWidth: 300.6 }).listWidth).toBe(301);
    });

    it('uses the default for a width that is not finite', () => {
      expect(rawPrefs('{"listWidth": 1e999}').listWidth).toBe(LIST_WIDTH.initial);
      expect(rawPrefs('{"listWidth": -1e999}').listWidth).toBe(LIST_WIDTH.initial);
    });

    it.each([['400'], [null], [true], [[400]], [{}], ['']])('uses the default for %j', (listWidth) => {
      expect(prefs({ listWidth }).listWidth).toBe(LIST_WIDTH.initial);
    });
  });

  it('reads the view preference and falls back to the diff', () => {
    const storage = (value: unknown) => ({ getItem: () => JSON.stringify(value) });
    expect(loadPrefs(storage({ view: 'map' })).view).toBe('map');
    expect(loadPrefs(storage({ view: 'nonsense' })).view).toBe('diff');
    expect(loadPrefs(undefined).view).toBe('diff');
  });

  describe('showContext', () => {
    it('is false only when stored as false', () => {
      expect(prefs({ showContext: false }).showContext).toBe(false);
    });

    it('is true when stored as true', () => {
      expect(prefs({ showContext: true }).showContext).toBe(true);
    });

    it.each([['false'], [0], [null], [''], ['no'], [[]]])('stays true for %j', (showContext) => {
      expect(prefs({ showContext }).showContext).toBe(true);
    });
  });

  it('does not throw saving without storage', () => {
    expect(() => savePrefs(undefined, defaults)).not.toThrow();
  });

  it('returns the defaults when reading throws', () => {
    expect(loadPrefs(broken)).toEqual(defaults);
  });

  it('does not throw when writing fails', () => {
    expect(() => savePrefs(broken, defaults)).not.toThrow();
  });
});
