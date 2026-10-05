import { posix } from 'node:path';
import { Parser, Query, type Node } from 'web-tree-sitter';
import type { MapSymbol, SymbolKind } from '@ide/protocol';
import { loadGrammar, symbolOf } from './tree-sitter';
import type { LanguageAdapter } from './types';

const USINGS_QUERY = '(using_directive) @using';
const TYPE_KINDS: Record<string, SymbolKind> = {
  class_declaration: 'class',
  record_declaration: 'class',
  struct_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  delegate_declaration: 'type',
};

interface Declarations {
  namespaces: Set<string>;
  symbols: MapSymbol[];
}

export async function createCSharpAdapter(): Promise<LanguageAdapter> {
  const language = await loadGrammar('tree-sitter-c-sharp/tree-sitter-c_sharp.wasm');
  const parser = new Parser();
  parser.setLanguage(language);
  const usingsQuery = new Query(language, USINGS_QUERY);

  return {
    lang: 'csharp',
    handles: (path) => posix.extname(path) === '.cs',
    parse(_path, source) {
      const tree = parser.parse(source);
      if (!tree) return { imports: [], symbols: [], parseError: true };
      try {
        const rootNode = tree.rootNode;
        const found: Declarations = { namespaces: new Set(), symbols: [] };
        collect(rootNode.namedChildren, '', found);
        return {
          imports: [...new Set(usingsQuery.captures(rootNode).flatMap((c) => importedNamespace(c.node)))],
          provides: [...found.namespaces],
          symbols: found.symbols,
          parseError: rootNode.hasError,
        };
      } finally {
        tree.delete();
      }
    },
    resolve: () => null,
    resolveAll(specifier, providers) {
      const direct = providers(specifier);
      if (direct.length > 0 || !specifier.includes('.')) return direct;
      // A using may name a type (alias, using static), so one miss retries the enclosing namespace.
      return providers(specifier.slice(0, specifier.lastIndexOf('.')));
    },
  };
}

function importedNamespace(using: Node): string[] {
  const alias = using.childForFieldName('name');
  const target = using.namedChildren.find((child) => child.id !== alias?.id && (child.type === 'identifier' || child.type === 'qualified_name'));
  if (!target) return [];
  const name = target.text.replace(/\s+/g, '');
  if (!using.children.some((child) => child.type === 'static')) return [name];
  return name.includes('.') ? [name.slice(0, name.lastIndexOf('.'))] : [];
}

function collect(nodes: Node[], scope: string, found: Declarations): void {
  let current = scope;
  for (const node of nodes) {
    if (node.type === 'namespace_declaration' || node.type === 'file_scoped_namespace_declaration') {
      const name = node.childForFieldName('name')?.text.replace(/\s+/g, '');
      if (!name) continue;
      const full = current ? `${current}.${name}` : name;
      found.namespaces.add(full);
      if (node.type === 'file_scoped_namespace_declaration') current = full;
      else collect(node.childForFieldName('body')?.namedChildren ?? [], full, found);
      continue;
    }
    const kind = TYPE_KINDS[node.type];
    const name = node.childForFieldName('name');
    if (!kind || !name) continue;
    const fileLocal = node.namedChildren.some((child) => child.type === 'modifier' && child.text === 'file');
    found.symbols.push(symbolOf(name.text, kind, node, !fileLocal));
  }
}
