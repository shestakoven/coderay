import { describe, expect, it } from 'vitest';
import type { ReviewItem, ReviewSection } from '../src/history/review-model';
import type { Decisions } from '../src/history/review-flow';
import { categoryOf, filterSections, isImage, type FileCategory } from '../src/history/review-list';

const item = (path: string, o: Partial<ReviewItem> = {}): ReviewItem => ({
  path, ids: [`id-${path}`], before: 'before', after: `${path}#1`, added: 0, removed: 0,
  toolUseIds: [], eventIds: [], reverted: false, revertId: null, renamedFrom: null, ...o,
});
const section = (key: string, files: ReviewItem[], o: Partial<ReviewSection> = {}): ReviewSection => ({
  key, title: key, outOfPlan: false, summary: null, added: 0, removed: 0, files,
  planId: null, stepKey: null, rationale: null, stepNo: null, stepTotal: 0, ...o,
});
const none: Decisions = { reviewed: {}, requested: {} };
const filter = (query: string, onlyPending = false) => ({ query, onlyPending });
const names = (sections: ReviewSection[]): string[][] => sections.map((s) => s.files.map((f) => f.path));

describe('filterSections', () => {
  const sections = [
    section('s1', [item('src/app.ts'), item('src/Readme.md'), item('lib/util.ts')]),
    section('s2', [item('docs/guide.md'), item('src/app.test.ts')]),
  ];

  it('returns the very same array for an empty query', () => {
    expect(filterSections(sections, filter(''), none)).toBe(sections);
  });

  it('returns the very same array for a query of only whitespace', () => {
    expect(filterSections(sections, filter(' \t  '), none)).toBe(sections);
  });

  it('keeps only the files whose path contains the query', () => {
    expect(names(filterSections(sections, filter('app'), none))).toEqual([['src/app.ts'], ['src/app.test.ts']]);
  });

  it('matches anywhere in the path, not only at the start', () => {
    expect(names(filterSections(sections, filter('til'), none))).toEqual([['lib/util.ts']]);
  });

  it('matches directory names', () => {
    expect(names(filterSections(sections, filter('docs'), none))).toEqual([['docs/guide.md']]);
  });

  it('ignores case in both the query and the path', () => {
    expect(names(filterSections(sections, filter('README'), none))).toEqual([['src/Readme.md']]);
    expect(names(filterSections(sections, filter('SRC/APP'), none))).toEqual([['src/app.ts'], ['src/app.test.ts']]);
  });

  it('needs every word of the query to appear in the path', () => {
    expect(names(filterSections(sections, filter('src test'), none))).toEqual([['src/app.test.ts']]);
  });

  it('accepts the words in any order', () => {
    expect(names(filterSections(sections, filter('test src'), none))).toEqual([['src/app.test.ts']]);
  });

  it('splits words on any whitespace and ignores surrounding whitespace', () => {
    expect(names(filterSections(sections, filter('  src \t  test  '), none))).toEqual([['src/app.test.ts']]);
  });

  it('shows nothing when one of the words matches no file', () => {
    expect(filterSections(sections, filter('src nonexistent'), none)).toEqual([]);
  });

  it('shows nothing when no file matches', () => {
    expect(filterSections(sections, filter('zzz'), none)).toEqual([]);
  });

  it('drops a section that has no matching files and keeps the others', () => {
    const out = filterSections(sections, filter('guide'), none);
    expect(out.map((s) => s.key)).toEqual(['s2']);
  });

  it('keeps the totals and details of a section whose files were filtered', () => {
    const withTotals = [section('s', [item('a.ts'), item('b.ts')], { added: 10, removed: 4, title: 'Step', stepNo: 2, stepTotal: 3 })];
    const [out] = filterSections(withTotals, filter('a.ts'), none);
    expect(out).toMatchObject({ key: 's', title: 'Step', added: 10, removed: 4, stepNo: 2, stepTotal: 3 });
    expect(out!.files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('matches the old path of a renamed file', () => {
    const renamed = [section('s', [item('new/place.ts', { renamedFrom: 'old/home.ts' }), item('other.ts')])];
    expect(names(filterSections(renamed, filter('home'), none))).toEqual([['new/place.ts']]);
    expect(names(filterSections(renamed, filter('place'), none))).toEqual([['new/place.ts']]);
  });

  it('lets one word match the new path and another the old path', () => {
    const renamed = [section('s', [item('new/place.ts', { renamedFrom: 'old/home.ts' })])];
    expect(names(filterSections(renamed, filter('place home'), none))).toEqual([['new/place.ts']]);
  });

  it('does not match words that only span the new and the old path together', () => {
    const renamed = [section('s', [item('abc.ts', { renamedFrom: 'def.ts' })])];
    expect(filterSections(renamed, filter('tsdef'), none)).toEqual([]);
    expect(filterSections(renamed, filter('ts def'), none)).not.toEqual([]);
  });

  it('does not modify the sections it is given', () => {
    const input = [section('s', [item('a.ts'), item('b.ts')])];
    filterSections(input, filter('a.ts'), none);
    expect(input[0]!.files).toHaveLength(2);
  });

  describe('only pending', () => {
    const files = [
      item('pending.ts', { after: 'h' }),
      item('accepted.ts', { after: 'h' }),
      item('requested.ts', { after: 'h' }),
      item('reverted.ts', { after: 'h', reverted: true }),
      item('changed.ts', { after: 'new' }),
      item('revised.ts', { after: 'new' }),
    ];
    const decisions: Decisions = { reviewed: { 'accepted.ts': 'h', 'changed.ts': 'old' }, requested: { 'requested.ts': 'h', 'revised.ts': 'old' } };
    const all = [section('s', files)];

    it('hides accepted, requested and reverted files', () => {
      const shown = names(filterSections(all, filter('', true), decisions))[0]!;
      expect(shown).not.toContain('accepted.ts');
      expect(shown).not.toContain('requested.ts');
      expect(shown).not.toContain('reverted.ts');
    });

    it('keeps pending, changed and revised files', () => {
      expect(names(filterSections(all, filter('', true), decisions))).toEqual([['pending.ts', 'changed.ts', 'revised.ts']]);
    });

    it('drops a section where everything is decided', () => {
      const decided = [section('done', [item('a.ts', { after: 'h' })]), section('open', [item('b.ts')])];
      const out = filterSections(decided, filter('', true), { reviewed: { 'a.ts': 'h' }, requested: {} });
      expect(out.map((s) => s.key)).toEqual(['open']);
    });

    it('shows nothing when everything is decided', () => {
      const out = filterSections([section('done', [item('a.ts', { after: 'h' })])], filter('', true), { reviewed: { 'a.ts': 'h' }, requested: {} });
      expect(out).toEqual([]);
    });

    it('combines with the query', () => {
      expect(names(filterSections(all, filter('ed.ts', true), decisions))).toEqual([['changed.ts', 'revised.ts']]);
    });

    it('does not hide decided files from a query without the switch', () => {
      expect(names(filterSections(all, filter('ed.ts', false), decisions))).toEqual([['accepted.ts', 'requested.ts', 'reverted.ts', 'changed.ts', 'revised.ts']]);
    });

    it('does not hide anything without the switch', () => {
      expect(filterSections(all, filter('', false), decisions)).toBe(all);
    });

    it('still lists pending files when nothing was decided', () => {
      expect(names(filterSections(all, filter('', true), none))).toEqual([files.filter((f) => !f.reverted).map((f) => f.path)]);
    });
  });
});

describe('categoryOf', () => {
  const table: [FileCategory, string[]][] = [
    ['code', ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'go', 'rs', 'java', 'rb', 'c', 'h', 'cpp', 'swift', 'kt']],
    ['style', ['css', 'scss', 'less', 'html']],
    ['data', ['json', 'yml', 'yaml', 'toml', 'csv', 'lock', 'xml']],
    ['doc', ['md', 'mdx', 'txt', 'rst']],
    ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'avif', 'svg']],
    ['shell', ['sh', 'bash', 'zsh']],
  ];

  it.each(table.flatMap(([category, extensions]) => extensions.map((extension): [string, FileCategory] => [extension, category])))(
    'puts .%s files in %s',
    (extension, category) => {
      expect(categoryOf(`src/file.${extension}`)).toBe(category);
    },
  );

  it('treats svg as an image, not as code or data', () => {
    expect(categoryOf('assets/logo.svg')).toBe('image');
  });

  it('ignores the case of the extension', () => {
    expect(categoryOf('src/APP.TS')).toBe('code');
    expect(categoryOf('Photo.PNG')).toBe('image');
    expect(categoryOf('README.Md')).toBe('doc');
  });

  it('looks only at the last extension', () => {
    expect(categoryOf('src/app.test.ts')).toBe('code');
    expect(categoryOf('types/app.d.ts')).toBe('code');
    expect(categoryOf('dist/archive.ts.gz')).toBe('other');
    expect(categoryOf('notes.md.bak')).toBe('other');
  });

  it('puts files without an extension in other', () => {
    expect(categoryOf('README')).toBe('other');
    expect(categoryOf('LICENSE')).toBe('other');
    expect(categoryOf('bin/run')).toBe('other');
  });

  it.each(['Dockerfile', 'Makefile', 'dockerfile', 'MAKEFILE', 'docker/Dockerfile', 'a/b/Makefile'])('treats %s as a shell file', (path) => {
    expect(categoryOf(path)).toBe('shell');
  });

  it('does not treat other names that merely contain Dockerfile or Makefile as shell files', () => {
    expect(categoryOf('Dockerfile.dev')).toBe('other');
    expect(categoryOf('my-Makefile')).toBe('other');
    expect(categoryOf('docker/Dockerfile/readme')).toBe('other');
  });

  it('ignores dots in directory names', () => {
    expect(categoryOf('pkg.ts/README')).toBe('other');
    expect(categoryOf('v1.2/Makefile')).toBe('shell');
    expect(categoryOf('a.b/c')).toBe('other');
    expect(categoryOf('dir.md/data')).toBe('other');
  });

  it('puts an unknown extension in other', () => {
    expect(categoryOf('a.unknownext')).toBe('other');
    expect(categoryOf('a.t')).toBe('other');
  });

  it('copes with dotfiles', () => {
    expect(categoryOf('.env')).toBe('data');
    expect(categoryOf('apps/web/.env')).toBe('data');
    expect(categoryOf('.gitignore')).toBe('other');
    expect(categoryOf('.env.local')).toBe('other');
    expect(categoryOf('.eslintrc.json')).toBe('data');
  });

  it('copes with empty and odd paths', () => {
    expect(categoryOf('')).toBe('other');
    expect(categoryOf('.')).toBe('other');
    expect(categoryOf('file.')).toBe('other');
    expect(categoryOf('dir/')).toBe('other');
  });

  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'])('does not mistake the extension .%s for a property of the table', (extension) => {
    expect(categoryOf(`file.${extension}`)).toBe('other');
  });
});

describe('isImage', () => {
  it.each(['a.png', 'photo.JPG', 'icon.ico', 'logo.svg', 'dir/pic.webp'])('is true for %s', (path) => {
    expect(isImage(path)).toBe(true);
  });

  it.each(['a.ts', 'a.md', 'a.css', 'README', 'png', 'dir.png/file'])('is false for %s', (path) => {
    expect(isImage(path)).toBe(false);
  });
});
