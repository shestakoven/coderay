import type { MapSnapshot } from '@ide/protocol';
import { computeFileEdges } from '../graph/edges';
import type { LanguageAdapter } from '../lang/types';
import type { IndexedFile } from '../model';
import { folderComponents } from './folder-components';

export function buildSnapshot(
  version: number,
  projectName: string,
  files: IndexedFile[],
  adapters: LanguageAdapter[],
): MapSnapshot {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const components = folderComponents(sorted.map((f) => f.path));
  const owner = new Map(components.flatMap((c) => c.files.map((path) => [path, c.id] as const)));
  return {
    version,
    projectName,
    files: sorted.map((f) => ({
      path: f.path,
      lang: f.lang,
      componentId: owner.get(f.path) ?? null,
      symbols: f.symbols,
      parseError: f.parseError,
    })),
    components,
    fileEdges: computeFileEdges(sorted, adapters),
  };
}
