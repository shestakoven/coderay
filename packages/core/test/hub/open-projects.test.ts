import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openProjectsFile, parseOpenProjects, readOpenProjects, serializeOpenProjects, writeOpenProjects } from '../../src/hub/open-projects';
import { tempDir } from '../helpers';

const NONE = { roots: [], activeRoot: null };
const file = (value: unknown): string => JSON.stringify(value);

describe('serializeOpenProjects', () => {
  it('writes the version 1 file with the roots in order and the active root', () => {
    const text = serializeOpenProjects({ roots: ['/w/b', '/w/a'], activeRoot: '/w/a' });
    expect(JSON.parse(text)).toEqual({ version: 1, roots: ['/w/b', '/w/a'], activeRoot: '/w/a' });
  });

  it('writes a null active root when nothing is active', () => {
    expect(JSON.parse(serializeOpenProjects({ roots: ['/w/a'], activeRoot: null }))).toEqual({ version: 1, roots: ['/w/a'], activeRoot: null });
  });
});

describe('parseOpenProjects', () => {
  it('reads back what serializeOpenProjects wrote, keeping the order and the active root', () => {
    const value = { roots: ['/w/c', '/w/a', '/w/b'], activeRoot: '/w/a' };
    expect(parseOpenProjects(serializeOpenProjects(value))).toEqual(value);
  });

  it('reads back an empty list', () => {
    expect(parseOpenProjects(serializeOpenProjects(NONE))).toEqual(NONE);
  });

  it.each([
    ['empty text', ''],
    ['not JSON', '{"version":1,'],
    ['JSON null', 'null'],
    ['a JSON number', '42'],
    ['a JSON string', '"/w/a"'],
    ['a JSON array of roots', file(['/w/a'])],
  ])('opens nothing for %s', (_label, text) => {
    expect(parseOpenProjects(text)).toEqual(NONE);
  });

  it.each([
    ['version 2', { version: 2, roots: ['/w/a'], activeRoot: '/w/a' }],
    ['version 0', { version: 0, roots: ['/w/a'], activeRoot: null }],
    ['the version as a string', { version: '1', roots: ['/w/a'], activeRoot: null }],
    ['no version', { roots: ['/w/a'], activeRoot: null }],
  ])('opens nothing for %s', (_label, value) => {
    expect(parseOpenProjects(file(value))).toEqual(NONE);
  });

  it.each([
    ['a string', '/w/a'],
    ['an object', { 0: '/w/a' }],
    ['null', null],
    ['missing', undefined],
  ])('opens nothing when roots is %s', (_label, roots) => {
    expect(parseOpenProjects(file({ version: 1, roots, activeRoot: null }))).toEqual(NONE);
  });

  it('skips entries that are not strings or are empty and keeps the rest in order', () => {
    const roots = ['/w/a', 7, '', null, { path: '/w/x' }, ['/w/y'], true, '/w/b'];
    expect(parseOpenProjects(file({ version: 1, roots, activeRoot: '/w/b' }))).toEqual({ roots: ['/w/a', '/w/b'], activeRoot: '/w/b' });
  });

  it('skips relative roots, which name no folder on their own', () => {
    const roots = ['w/a', '/w/a', '.', '..', '~/code', './b', '/w/b'];
    expect(parseOpenProjects(file({ version: 1, roots, activeRoot: 'w/a' }))).toEqual({ roots: ['/w/a', '/w/b'], activeRoot: null });
  });

  it('keeps the first of duplicate roots, in first-seen order', () => {
    const roots = ['/w/b', '/w/a', '/w/b', '/w/c', '/w/a'];
    expect(parseOpenProjects(file({ version: 1, roots, activeRoot: null })).roots).toEqual(['/w/b', '/w/a', '/w/c']);
  });

  it('drops an active root that is not among the roots', () => {
    expect(parseOpenProjects(file({ version: 1, roots: ['/w/a'], activeRoot: '/w/gone' }))).toEqual({ roots: ['/w/a'], activeRoot: null });
  });

  it('drops an active root that pointed at a skipped entry', () => {
    expect(parseOpenProjects(file({ version: 1, roots: ['/w/a', ''], activeRoot: '' })).activeRoot).toBeNull();
  });

  it.each([
    ['a number', 1],
    ['an array', ['/w/a']],
    ['missing', undefined],
  ])('reads a non-string active root (%s) as none', (_label, activeRoot) => {
    expect(parseOpenProjects(file({ version: 1, roots: ['/w/a'], activeRoot }))).toEqual({ roots: ['/w/a'], activeRoot: null });
  });

  it('keeps the active root when it is not the first root', () => {
    expect(parseOpenProjects(file({ version: 1, roots: ['/w/a', '/w/b', '/w/c'], activeRoot: '/w/c' })).activeRoot).toBe('/w/c');
  });
});

describe('readOpenProjects / writeOpenProjects', () => {
  it('opens nothing when the home has no file yet', () => {
    expect(readOpenProjects(join(tempDir('ide-open-'), 'missing-home'))).toEqual(NONE);
  });

  it('reads back what was written, creating the home', () => {
    const home = join(tempDir('ide-open-'), 'home');
    const value = { roots: ['/w/b', '/w/a'], activeRoot: '/w/b' };
    writeOpenProjects(home, serializeOpenProjects(value));
    expect(readOpenProjects(home)).toEqual(value);
  });

  it('replaces the previous file', () => {
    const home = tempDir('ide-open-');
    writeOpenProjects(home, serializeOpenProjects({ roots: ['/w/a', '/w/b'], activeRoot: '/w/a' }));
    writeOpenProjects(home, serializeOpenProjects({ roots: ['/w/c'], activeRoot: null }));
    expect(readOpenProjects(home)).toEqual({ roots: ['/w/c'], activeRoot: null });
  });

  it('keeps the file private to the user, since it lists the user\'s folders', () => {
    const home = tempDir('ide-open-');
    writeOpenProjects(home, serializeOpenProjects({ roots: ['/w/a'], activeRoot: null }));
    expect(statSync(openProjectsFile(home)).mode & 0o077).toBe(0);
  });

  it('opens nothing for a damaged file instead of throwing', () => {
    const home = tempDir('ide-open-');
    mkdirSync(home, { recursive: true });
    writeFileSync(openProjectsFile(home), '{"version":1,"roots":["/w/a"');
    expect(readOpenProjects(home)).toEqual(NONE);
  });
});
