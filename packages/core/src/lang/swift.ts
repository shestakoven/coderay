import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Query, type Node } from 'web-tree-sitter';
import type { MapSymbol, SymbolKind } from '@ide/protocol';
import { loadGrammarFile, symbolOf } from './tree-sitter';
import type { LanguageAdapter } from './types';

const IMPORTS_QUERY = '(import_declaration (identifier (simple_identifier) @module))';
const SWIFTPM_TARGET = /(?:^|\/)Sources\/([^/]+)\/./;
const PRIVATE_LEVELS = new Set(['private', 'fileprivate']);
const TYPE_KINDS: Record<string, SymbolKind> = { class: 'class', struct: 'class', actor: 'class', enum: 'enum' };

export async function createSwiftAdapter(): Promise<LanguageAdapter> {
  const language = await loadGrammarFile(fileURLToPath(new URL('../../grammars/tree-sitter-swift.wasm', import.meta.url)));
  const parser = new Parser();
  parser.setLanguage(language);
  const importsQuery = new Query(language, IMPORTS_QUERY);

  return {
    lang: 'swift',
    handles: (path) => posix.extname(path) === '.swift',
    parse(path, source) {
      const tree = parser.parse(source);
      if (!tree) return { imports: [], symbols: [], parseError: true };
      try {
        const rootNode = tree.rootNode;
        // The query matches every component of a dotted name; only the first one is the module.
        const modules = importsQuery.captures(rootNode).filter((c) => c.node.parent?.firstNamedChild?.id === c.node.id);
        const target = SWIFTPM_TARGET.exec(path)?.[1];
        return {
          imports: [...new Set(modules.map((c) => c.node.text))],
          provides: target ? [target] : [],
          symbols: rootNode.namedChildren.flatMap(topLevelSymbols),
          parseError: rootNode.hasError,
        };
      } finally {
        tree.delete();
      }
    },
    resolve: () => null,
    resolveAll: (specifier, providers) => providers(specifier),
  };
}

function topLevelSymbols(statement: Node): MapSymbol[] {
  const exported = !statement.namedChildren.some(
    (child) => child.type === 'modifiers' && child.namedChildren.some((m) => m.type === 'visibility_modifier' && PRIVATE_LEVELS.has(m.text)),
  );
  switch (statement.type) {
    case 'class_declaration': {
      const keyword = statement.children.find((child) => !child.isNamed && child.type in TYPE_KINDS)?.type;
      const name = statement.childForFieldName('name');
      return keyword && name ? [symbolOf(name.text, TYPE_KINDS[keyword]!, statement, exported)] : [];
    }
    case 'protocol_declaration':
      return named(statement, 'interface', exported);
    case 'typealias_declaration':
      return named(statement, 'type', exported);
    case 'function_declaration':
      return named(statement, 'function', exported);
    case 'property_declaration':
      return statement
        .childrenForFieldName('name')
        .flatMap((pattern) => {
          const name = pattern.childForFieldName('bound_identifier');
          return name ? [symbolOf(name.text, 'variable', statement, exported)] : [];
        });
    default:
      return [];
  }
}

function named(statement: Node, kind: SymbolKind, exported: boolean): MapSymbol[] {
  const name = statement.childForFieldName('name');
  return name ? [symbolOf(name.text, kind, statement, exported)] : [];
}
