import type { FileEdge } from '@ide/protocol';
import type { LanguageAdapter } from '../lang/types';
import type { IndexedFile } from '../model';

export function computeFileEdges(files: IndexedFile[], adapters: LanguageAdapter[]): FileEdge[] {
  const known = new Set(files.map((f) => f.path));
  const exists = (path: string) => known.has(path);
  const edges = new Map<string, FileEdge>();
  for (const file of files) {
    const adapter = adapters.find((a) => a.lang === file.lang);
    if (!adapter) continue;
    for (const specifier of file.imports) {
      const to = adapter.resolve(file.path, specifier, exists);
      if (to && to !== file.path) edges.set(`${file.path}\0${to}`, { from: file.path, to, kind: 'import' });
    }
  }
  return [...edges.values()];
}
