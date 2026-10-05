import type { FileEdge } from '@ide/protocol';
import type { LanguageAdapter } from '../lang/types';
import type { IndexedFile } from '../model';

export function computeFileEdges(files: IndexedFile[], adapters: LanguageAdapter[]): FileEdge[] {
  const targetsOf = resolver(files);
  const edges = new Map<string, FileEdge>();
  for (const file of files) {
    const adapter = adapters.find((a) => a.lang === file.lang);
    if (!adapter) continue;
    for (const specifier of file.imports) {
      for (const to of targetsOf(adapter, file, specifier)) {
        if (to !== file.path) edges.set(`${file.path}\0${to}`, { from: file.path, to, kind: 'import' });
      }
    }
  }
  return [...edges.values()];
}

export function unresolvedImports(files: IndexedFile[], adapters: LanguageAdapter[]): Map<string, string[]> {
  const targetsOf = resolver(files);
  const result = new Map<string, string[]>();
  for (const file of files) {
    const adapter = adapters.find((a) => a.lang === file.lang);
    if (!adapter) continue;
    const missing = file.imports.filter((specifier) => targetsOf(adapter, file, specifier).length === 0);
    if (missing.length > 0) result.set(file.path, missing);
  }
  return result;
}

function resolver(files: IndexedFile[]): (adapter: LanguageAdapter, file: IndexedFile, specifier: string) => string[] {
  const known = new Set(files.map((f) => f.path));
  const exists = (path: string) => known.has(path);
  const providers = new Map<string, string[]>();
  for (const file of files) {
    for (const name of file.provides ?? []) {
      const key = `${file.lang}\0${name}`;
      providers.set(key, [...(providers.get(key) ?? []), file.path]);
    }
  }
  return (adapter, file, specifier) => {
    if (adapter.resolveAll) return adapter.resolveAll(specifier, (name) => providers.get(`${file.lang}\0${name}`) ?? []);
    const to = adapter.resolve(file.path, specifier, exists);
    return to ? [to] : [];
  };
}
