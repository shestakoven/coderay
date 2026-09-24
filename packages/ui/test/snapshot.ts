import type { MapSnapshot } from '@ide/protocol';

const component = (id: string, files: string[]) => ({
  id, name: id.replace('folder:src/', ''), description: '', files, globs: [], source: 'folder' as const, stale: false,
});
const file = (path: string, componentId: string, parseError = false) => ({
  path, lang: 'typescript' as const, componentId, symbols: [], parseError,
});
const edge = (from: string, to: string) => ({ from, to, kind: 'import' as const });

export const demoSnapshot = (version = 1): MapSnapshot => ({
  version,
  projectName: 'demo',
  components: [component('folder:src/api', ['src/api/a.ts', 'src/api/b.ts']), component('folder:src/db', ['src/db/c.ts'])],
  files: [file('src/api/a.ts', 'folder:src/api'), file('src/api/b.ts', 'folder:src/api'), file('src/db/c.ts', 'folder:src/db', true)],
  fileEdges: [edge('src/api/a.ts', 'src/db/c.ts'), edge('src/api/b.ts', 'src/db/c.ts'), edge('src/api/a.ts', 'src/api/b.ts')],
});
