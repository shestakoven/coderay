import { createRequire } from 'node:module';
import { Language, Parser, type Node } from 'web-tree-sitter';
import type { MapSymbol, SymbolKind } from '@ide/protocol';

const require = createRequire(import.meta.url);
let ready: Promise<void> | undefined;

export async function loadGrammar(wasmModule: string): Promise<Language> {
  ready ??= Parser.init();
  await ready;
  return Language.load(require.resolve(wasmModule));
}

export function symbolOf(name: string, kind: SymbolKind, node: Node, exported: boolean): MapSymbol {
  return { name, kind, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, exported };
}
