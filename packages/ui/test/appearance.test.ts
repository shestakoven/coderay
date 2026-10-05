import { describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE, FONT_SIZES, appearanceAttributes, loadAppearance, normalizeAppearance, saveAppearance, type Appearance } from '../src/settings/appearance';
import { blockedStorage, memoryStorage } from './memory-storage';

const DEFAULTS: Appearance = { density: 'comfortable', fontSize: 13, reducedMotion: null, canvasDots: true };
const CUSTOM: Appearance = { density: 'compact', fontSize: 16, reducedMotion: false, canvasDots: false };
const KEY = 'ide.appearance';

describe('normalizeAppearance', () => {
  it('starts from comfortable, 13px, the system motion setting and dots on', () => {
    expect(DEFAULT_APPEARANCE).toEqual(DEFAULTS);
    expect(FONT_SIZES).toEqual([12, 13, 14, 15, 16]);
  });

  it.each([null, undefined, 'x', 5, true])('falls back to the defaults for %j', (raw) => {
    expect(normalizeAppearance(raw)).toEqual(DEFAULTS);
  });

  it('keeps a complete valid value and drops unknown keys', () => {
    expect(normalizeAppearance({ ...CUSTOM, extra: 1 })).toEqual(CUSTOM);
  });

  it.each([['compact', 'compact'], ['comfortable', 'comfortable'], ['COMPACT', 'comfortable'], ['cozy', 'comfortable'], [1, 'comfortable']])(
    'reads the density %j as %j',
    (density, expected) => {
      expect(normalizeAppearance({ density }).density).toBe(expected);
    },
  );

  it.each([12, 13, 14, 15, 16])('keeps the font size %i', (fontSize) => {
    expect(normalizeAppearance({ fontSize }).fontSize).toBe(fontSize);
  });

  it.each([99, 11, 17, '14', 13.5, 14.5, null, 0])('replaces the font size %j with 13', (fontSize) => {
    expect(normalizeAppearance({ fontSize }).fontSize).toBe(13);
  });

  it.each([[true, true], [false, false], ['true', null], [1, null], [0, null], [null, null]])('reads reduced motion %j as %j', (reducedMotion, expected) => {
    expect(normalizeAppearance({ reducedMotion }).reducedMotion).toBe(expected);
  });

  it.each([[false, false], [true, true], [0, true], ['false', true], [null, true], [undefined, true]])('reads canvas dots %j as %j', (canvasDots, expected) => {
    expect(normalizeAppearance({ canvasDots }).canvasDots).toBe(expected);
  });
});

describe('loadAppearance and saveAppearance', () => {
  it('uses the defaults without storage', () => {
    expect(loadAppearance(undefined)).toEqual(DEFAULTS);
  });

  it('uses the defaults when nothing is stored', () => {
    expect(loadAppearance(memoryStorage())).toEqual(DEFAULTS);
    expect(loadAppearance(memoryStorage({ 'ide.other': JSON.stringify(CUSTOM) }))).toEqual(DEFAULTS);
  });

  it.each(['{', 'not json', '', 'null', '5', '[]'])('uses the defaults for the stored text %j', (text) => {
    expect(loadAppearance(memoryStorage({ [KEY]: text }))).toEqual(DEFAULTS);
  });

  it('uses the defaults when the store refuses to be read', () => {
    expect(loadAppearance(blockedStorage())).toEqual(DEFAULTS);
  });

  it('reads back a stored value', () => {
    expect(loadAppearance(memoryStorage({ [KEY]: JSON.stringify(CUSTOM) }))).toEqual(CUSTOM);
  });

  it('normalizes stored junk field by field', () => {
    const stored = { density: 'compact', fontSize: '14', reducedMotion: 'yes', canvasDots: 0, extra: true };
    expect(loadAppearance(memoryStorage({ [KEY]: JSON.stringify(stored) }))).toEqual({ ...DEFAULTS, density: 'compact' });
  });

  it('writes the value as JSON under ide.appearance', () => {
    const storage = memoryStorage();
    saveAppearance(storage, CUSTOM);
    expect(storage.length).toBe(1);
    expect(JSON.parse(storage.getItem(KEY)!)).toEqual(CUSTOM);
  });

  it('loads what it saved', () => {
    const storage = memoryStorage();
    const value: Appearance = { density: 'compact', fontSize: 14, reducedMotion: true, canvasDots: true };
    saveAppearance(storage, value);
    expect(loadAppearance(storage)).toEqual(value);
  });

  it('survives a store that refuses writes, or no store at all', () => {
    expect(() => saveAppearance(blockedStorage(), CUSTOM)).not.toThrow();
    expect(() => saveAppearance(undefined, CUSTOM)).not.toThrow();
  });
});

describe('appearanceAttributes', () => {
  it.each(['comfortable', 'compact'] as const)('mirrors the density %s', (density) => {
    expect(appearanceAttributes({ ...DEFAULTS, density }, false).data.density).toBe(density);
  });

  it.each([
    [true, false, 'reduce'],
    [true, true, 'reduce'],
    [false, true, 'full'],
    [false, false, 'full'],
    [null, true, 'reduce'],
    [null, false, 'full'],
  ])('with reduced motion %j and the system reducing %j, sets motion %s', (reducedMotion, system, motion) => {
    expect(appearanceAttributes({ ...DEFAULTS, reducedMotion }, system).data.motion).toBe(motion);
  });

  it.each([[true, 'on'], [false, 'off']] as const)('shows canvas dots %j as %s', (canvasDots, value) => {
    expect(appearanceAttributes({ ...DEFAULTS, canvasDots }, false).data.canvasDots).toBe(value);
  });

  it.each([12, 13, 14, 16])('scales the text for %ipx against the 13px base', (fontSize) => {
    expect(appearanceAttributes({ ...DEFAULTS, fontSize }, false).scale).toBeCloseTo(fontSize / 13, 10);
  });

  it('leaves the default text unscaled', () => {
    expect(appearanceAttributes(DEFAULTS, false)).toEqual({ data: { density: 'comfortable', motion: 'full', canvasDots: 'on' }, scale: 1 });
  });
});
