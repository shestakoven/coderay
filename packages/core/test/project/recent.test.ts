import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RecentProjects } from '../../src/project/recent';
import { tempDir } from '../helpers';

function dirs(root: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const path = join(root, `p${String(i).padStart(2, '0')}`);
    mkdirSync(path);
    return path;
  });
}

function tickingClock() {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 10));
}

describe('RecentProjects', () => {
  it('lists nothing when no file exists', () => {
    expect(new RecentProjects(tempDir('ide-home-')).list()).toEqual([]);
  });

  it('records a project with its folder name', () => {
    const home = tempDir('ide-home-');
    const [path] = dirs(tempDir('ide-proj-'), 1);
    const recent = new RecentProjects(home);
    recent.add(path!);
    expect(recent.list()).toMatchObject([{ path, name: 'p00' }]);
  });

  it('puts the most recently added project first', () => {
    tickingClock();
    const [a, b] = dirs(tempDir('ide-proj-'), 2);
    const recent = new RecentProjects(tempDir('ide-home-'));
    recent.add(a!);
    recent.add(b!);
    expect(recent.list().map((p) => p.path)).toEqual([b, a]);
  });

  it('does not duplicate a re-added project and moves it to the front', () => {
    tickingClock();
    const [a, b, c] = dirs(tempDir('ide-proj-'), 3);
    const recent = new RecentProjects(tempDir('ide-home-'));
    recent.add(a!);
    recent.add(b!);
    recent.add(c!);
    recent.add(a!);
    expect(recent.list().map((p) => p.path)).toEqual([a, c, b]);
  });

  it('keeps only the 12 most recent projects', () => {
    tickingClock();
    const paths = dirs(tempDir('ide-proj-'), 14);
    const recent = new RecentProjects(tempDir('ide-home-'));
    for (const path of paths) recent.add(path);
    const listed = recent.list().map((p) => p.path);
    expect(listed).toHaveLength(12);
    expect(listed[0]).toBe(paths[13]);
    expect(listed).not.toContain(paths[0]);
    expect(listed).not.toContain(paths[1]);
  });

  it('drops projects whose folder no longer exists', () => {
    const root = tempDir('ide-proj-');
    const [a, b] = dirs(root, 2);
    const recent = new RecentProjects(tempDir('ide-home-'));
    recent.add(a!);
    recent.add(b!);
    writeFileSync(join(root, 'file'), 'x');
    recent.add(join(root, 'file'));
    recent.add(join(root, 'gone'));
    expect(recent.list().map((p) => p.path).sort()).toEqual([a, b].sort());
  });

  it('drops an entry whose path is a file', () => {
    const root = tempDir('ide-proj-');
    writeFileSync(join(root, 'f'), 'x');
    const recent = new RecentProjects(tempDir('ide-home-'));
    recent.add(join(root, 'f'));
    expect(recent.list()).toEqual([]);
  });

  it('persists across instances sharing an ide home', () => {
    const home = tempDir('ide-home-');
    const [a] = dirs(tempDir('ide-proj-'), 1);
    new RecentProjects(home).add(a!);
    expect(new RecentProjects(home).list().map((p) => p.path)).toEqual([a]);
  });

  it('creates the ide home when it does not exist yet', () => {
    const home = join(tempDir('ide-home-'), 'nested', 'home');
    const [a] = dirs(tempDir('ide-proj-'), 1);
    new RecentProjects(home).add(a!);
    expect(new RecentProjects(home).list()).toHaveLength(1);
  });

  it('tolerates a corrupt file and recovers on the next add', () => {
    const home = tempDir('ide-home-');
    const [a] = dirs(tempDir('ide-proj-'), 1);
    writeFileSync(join(home, 'recent-projects.json'), '{not json');
    const recent = new RecentProjects(home);
    expect(recent.list()).toEqual([]);
    recent.add(a!);
    expect(recent.list().map((p) => p.path)).toEqual([a]);
  });

  it('ignores a file with the wrong shape and skips malformed items', () => {
    const home = tempDir('ide-home-');
    const [a] = dirs(tempDir('ide-proj-'), 1);
    const file = join(home, 'recent-projects.json');
    writeFileSync(file, '{"projects":"nope"}');
    expect(new RecentProjects(home).list()).toEqual([]);
    writeFileSync(file, JSON.stringify({ projects: [{ path: 1 }, null, { path: a, name: 'p00', openedAt: 5 }, { path: a, name: 'x' }] }));
    expect(new RecentProjects(home).list()).toEqual([{ path: a, name: 'p00', openedAt: 5 }]);
  });

  it('lists projects newest first even when the file is stored out of order', () => {
    const home = tempDir('ide-home-');
    const [a, b, c] = dirs(tempDir('ide-proj-'), 3);
    const item = (path: string, openedAt: number) => ({ path, name: 'n', openedAt });
    writeFileSync(join(home, 'recent-projects.json'), JSON.stringify({ projects: [item(a!, 1), item(c!, 3), item(b!, 2)] }));
    expect(new RecentProjects(home).list().map((p) => p.path)).toEqual([c, b, a]);
  });

  it('writes the file readable only by its owner', () => {
    const home = tempDir('ide-home-');
    const [a] = dirs(tempDir('ide-proj-'), 1);
    new RecentProjects(home).add(a!);
    expect(statSync(join(home, 'recent-projects.json')).mode & 0o777).toBe(0o600);
  });
});
