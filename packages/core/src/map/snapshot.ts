import type { FileEdge, MapSnapshot } from '@ide/protocol';
import type { IndexedFile } from '../model';
import type { MapView } from './map-service';

export function buildSnapshot(
  version: number,
  projectName: string,
  files: IndexedFile[],
  fileEdges: FileEdge[],
  view: MapView,
): MapSnapshot {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const owner = new Map(view.components.flatMap((component) => component.files.map((path) => [path, component.id] as const)));
  return {
    version,
    projectName,
    files: sorted.map((file) => ({
      path: file.path,
      lang: file.lang,
      componentId: owner.get(file.path) ?? null,
      manualAssignment: view.manualFiles.has(file.path),
      symbols: file.symbols,
      parseError: file.parseError,
    })),
    components: view.components,
    fileEdges,
    status: view.status,
  };
}
