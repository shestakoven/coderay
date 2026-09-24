import { describe, expect, it } from 'vitest';
import { folderComponents } from '../../src/map/folder-components';

const summary = (paths: string[]) =>
  folderComponents(paths).map((c) => ({ id: c.id, name: c.name, files: c.files, globs: c.globs }));

describe('folderComponents', () => {
  it('returns no components for an empty project', () => {
    expect(folderComponents([])).toEqual([]);
  });

  it('descends through a single wrapping directory and groups by the next level', () => {
    expect(summary(['src/api/b.ts', 'src/api/a.ts', 'src/db/c.ts', 'src/main.ts'])).toEqual([
      { id: 'folder:src/*', name: 'src (files)', files: ['src/main.ts'], globs: ['src/*'] },
      { id: 'folder:src/api', name: 'api', files: ['src/api/a.ts', 'src/api/b.ts'], globs: ['src/api/**'] },
      { id: 'folder:src/db', name: 'db', files: ['src/db/c.ts'], globs: ['src/db/**'] },
    ]);
  });

  it('keeps root-level files in their own component and does not split directories of a tiny project', () => {
    expect(summary(['setup.py', 'pkg/a.py', 'pkg/sub/b.py'])).toEqual([
      { id: 'folder:./*', name: 'root (files)', files: ['setup.py'], globs: ['*'] },
      { id: 'folder:pkg', name: 'pkg', files: ['pkg/a.py', 'pkg/sub/b.py'], globs: ['pkg/**'] },
    ]);
  });

  it('splits a monorepo into one component per package', () => {
    expect(summary(['packages/core/src/x.ts', 'packages/ui/src/y.tsx']).map((c) => c.id)).toEqual([
      'folder:packages/core',
      'folder:packages/ui',
    ]);
  });

  it('splits a directory that holds more than half of a non-trivial project', () => {
    const packages = Array.from({ length: 12 }, (_, i) => `packages/${i < 8 ? 'core' : 'ui'}/f${i}.ts`);
    expect(folderComponents([...packages, 'scripts/a.mjs', 'vite.config.ts']).map((c) => c.id)).toEqual([
      'folder:./*',
      'folder:packages/core',
      'folder:packages/ui',
      'folder:scripts',
    ]);
  });

  it('marks components as folder-sourced and fresh', () => {
    const [component] = folderComponents(['a/x.ts', 'b/y.ts']);
    expect(component).toMatchObject({ source: 'folder', stale: false, description: '' });
  });
});
