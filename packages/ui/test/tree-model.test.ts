import { describe, expect, it } from 'vitest';
import { buildFileTree, matchesFilter, type FileTreeNode } from '../src/layout/tree-model';

const names = (nodes: FileTreeNode[]) => nodes.map((n) => n.name);

describe('buildFileTree', () => {
  it('returns an empty list for no paths', () => {
    expect(buildFileTree([])).toEqual([]);
  });

  it('nests files under their folders with full paths', () => {
    const [src] = buildFileTree(['src/a/b.ts']);
    expect(src).toMatchObject({ name: 'src', path: 'src', file: false });
    const a = src!.children[0]!;
    expect(a).toMatchObject({ name: 'a', path: 'src/a', file: false });
    expect(a.children).toEqual([{ name: 'b.ts', path: 'src/a/b.ts', children: [], file: true }]);
  });

  it('shares one folder node between files in the same folder', () => {
    const tree = buildFileTree(['src/a.ts', 'src/b.ts']);
    expect(tree).toHaveLength(1);
    expect(names(tree[0]!.children)).toEqual(['a.ts', 'b.ts']);
  });

  it('lists folders before files at every level', () => {
    const tree = buildFileTree(['a.ts', 'zdir/x.ts', 'z.ts', 'zdir/adir/y.ts']);
    expect(names(tree)).toEqual(['zdir', 'a.ts', 'z.ts']);
    expect(names(tree[0]!.children)).toEqual(['adir', 'x.ts']);
  });

  it('sorts case-insensitively', () => {
    expect(names(buildFileTree(['b.ts', 'A.ts', 'c.ts', 'B2.ts']))).toEqual(['A.ts', 'b.ts', 'B2.ts', 'c.ts']);
    expect(names(buildFileTree(['b/x', 'A/x', 'C/x']))).toEqual(['A', 'b', 'C']);
    expect(names(buildFileTree(['Zed/x', 'alpha/x']))).toEqual(['alpha', 'Zed']);
  });

  it('keeps a file and a folder with the same name separate', () => {
    const tree = buildFileTree(['lib', 'lib/index.ts']);
    expect(tree).toHaveLength(2);
    expect(tree.map((n) => [n.name, n.file])).toEqual([['lib', false], ['lib', true]]);
    expect(names(tree[0]!.children)).toEqual(['index.ts']);
    expect(tree[1]!.children).toEqual([]);
  });

  it('does not duplicate a repeated path', () => {
    expect(buildFileTree(['a/b.ts', 'a/b.ts'])[0]!.children).toHaveLength(1);
  });
});

describe('matchesFilter', () => {
  it('matches case-insensitively in both directions', () => {
    expect(matchesFilter('SrcFile.TS', 'srcfile')).toBe(true);
    expect(matchesFilter('srcfile.ts', 'SRCFILE')).toBe(true);
  });

  it('matches a substring anywhere', () => {
    expect(matchesFilter('packages/ui/App.tsx', 'ui/app')).toBe(true);
  });

  it('rejects text without the substring', () => {
    expect(matchesFilter('App.tsx', 'zzz')).toBe(false);
  });

  it('trims the filter before matching', () => {
    expect(matchesFilter('App.tsx', '  app  ')).toBe(true);
  });

  it('does not trim the text', () => {
    expect(matchesFilter('a b', 'a b')).toBe(true);
    expect(matchesFilter('ab', 'a b')).toBe(false);
  });

  it('matches everything for an empty or whitespace filter', () => {
    expect(matchesFilter('anything', '')).toBe(true);
    expect(matchesFilter('anything', '   ')).toBe(true);
    expect(matchesFilter('', '')).toBe(true);
  });
});
