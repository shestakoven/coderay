import { describe, expect, it } from 'vitest';
import type { MapComponent } from '@ide/protocol';
import type { MapView } from '../../src/map/map-service';
import { buildSnapshot } from '../../src/map/snapshot';
import { indexed, mapStatus } from '../helpers';

const component = (id: string, files: string[], source: MapComponent['source']): MapComponent => ({
  id,
  name: id,
  summary: '',
  description: '',
  files,
  keyFiles: [],
  globs: [],
  source,
  stale: false,
});

const view = (overrides: Partial<MapView> = {}): MapView => ({
  components: [component('ai:api', ['src/api/a.ts'], 'ai'), component('db', ['src/db/b.ts'], 'manual')],
  manualFiles: new Set(['src/db/b.ts']),
  status: mapStatus({ layer: 'ai' }),
  ...overrides,
});

describe('buildSnapshot', () => {
  it('lists each file with its component, manual flag, symbols and parse error', () => {
    const symbol = { name: 'handler', kind: 'function' as const, startLine: 1, endLine: 3, exported: true };
    const files = [
      indexed('src/db/b.ts', 'typescript', [], { parseError: true }),
      indexed('src/api/a.ts', 'typescript', [], { symbols: [symbol] }),
      indexed('src/new.ts', 'typescript', []),
    ];
    expect(buildSnapshot(3, 'demo', files, [], view()).files).toEqual([
      { path: 'src/api/a.ts', lang: 'typescript', componentId: 'ai:api', manualAssignment: false, symbols: [symbol], parseError: false },
      { path: 'src/db/b.ts', lang: 'typescript', componentId: 'db', manualAssignment: true, symbols: [], parseError: true },
      { path: 'src/new.ts', lang: 'typescript', componentId: null, manualAssignment: false, symbols: [], parseError: false },
    ]);
  });

  it('carries the components, the file edges and the map status', () => {
    const edges = [{ from: 'src/api/a.ts', to: 'src/db/b.ts', kind: 'import' as const }];
    const current = view({ status: mapStatus({ layer: 'ai', stale: true, staleReasons: ['3 of 9 files are not in any component'] }) });
    expect(buildSnapshot(3, 'demo', [], edges, current)).toEqual({
      version: 3,
      projectName: 'demo',
      files: [],
      components: current.components,
      fileEdges: edges,
      status: current.status,
    });
  });
});
