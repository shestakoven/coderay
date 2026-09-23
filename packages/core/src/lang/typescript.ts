import { posix, relative, sep } from 'node:path';
import { createPathsMatcher, getTsconfig } from 'get-tsconfig';
import { Parser, Query, type Language, type Node } from 'web-tree-sitter';
import type { MapSymbol, SymbolKind } from '@ide/protocol';
import { loadGrammar, symbolOf } from './tree-sitter';
import type { LanguageAdapter } from './types';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_TO_TS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

const DECLARATION_KINDS: Record<string, SymbolKind> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
};

const IMPORTS_QUERY = `
(import_statement source: (string (string_fragment) @spec))
(export_statement source: (string (string_fragment) @spec))
(call_expression function: (identifier) @fn (#eq? @fn "require") arguments: (arguments (string (string_fragment) @spec)))
(call_expression function: (import) arguments: (arguments (string (string_fragment) @spec)))
`;

interface Grammar {
  parser: Parser;
  imports: Query;
}

export async function createTypeScriptAdapter(root: string): Promise<LanguageAdapter> {
  const [ts, tsx] = await Promise.all([
    loadGrammar('tree-sitter-typescript/tree-sitter-typescript.wasm'),
    loadGrammar('tree-sitter-typescript/tree-sitter-tsx.wasm'),
  ]);
  const grammars = { ts: grammarFor(ts), tsx: grammarFor(tsx) };
  const tsconfig = getTsconfig(root);
  const matchPaths = tsconfig ? createPathsMatcher(tsconfig) : null;

  return {
    lang: 'typescript',
    handles: (path) => SOURCE_EXTENSIONS.includes(posix.extname(path)),
    parse(path, source) {
      const { parser, imports } = /\.[jt]sx$/.test(path) ? grammars.tsx : grammars.ts;
      const tree = parser.parse(source);
      if (!tree) return { imports: [], symbols: [], parseError: true };
      try {
        const rootNode = tree.rootNode;
        return {
          imports: [...new Set(imports.captures(rootNode).filter((c) => c.name === 'spec').map((c) => c.node.text))],
          symbols: rootNode.namedChildren.flatMap(topLevelSymbols),
          parseError: rootNode.hasError,
        };
      } finally {
        tree.delete();
      }
    },
    resolve(fromPath, specifier, exists) {
      const bases = specifier.startsWith('.')
        ? [posix.join(posix.dirname(fromPath), specifier)]
        : (matchPaths?.(specifier) ?? []).map((abs) => relative(root, abs).split(sep).join('/'));
      for (const base of bases) {
        if (base.startsWith('..')) continue;
        const hit = candidates(base).find(exists);
        if (hit) return hit;
      }
      return null;
    },
  };
}

function grammarFor(language: Language): Grammar {
  const parser = new Parser();
  parser.setLanguage(language);
  return { parser, imports: new Query(language, IMPORTS_QUERY) };
}

function candidates(base: string): string[] {
  const ext = posix.extname(base);
  const swapped = (JS_TO_TS[ext] ?? []).map((replacement) => base.slice(0, -ext.length) + replacement);
  return [
    base,
    ...swapped,
    ...RESOLVE_EXTENSIONS.map((e) => base + e),
    ...RESOLVE_EXTENSIONS.map((e) => posix.join(base, `index${e}`)),
  ];
}

function topLevelSymbols(statement: Node): MapSymbol[] {
  const exported = statement.type === 'export_statement';
  const declaration = exported ? statement.childForFieldName('declaration') : statement;
  if (!declaration) return [];
  const kind = DECLARATION_KINDS[declaration.type];
  if (kind) {
    const name = declaration.childForFieldName('name');
    return name ? [symbolOf(name.text, kind, statement, exported)] : [];
  }
  if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
    return declaration.namedChildren
      .filter((child) => child.type === 'variable_declarator')
      .flatMap((declarator) => {
        const name = declarator.childForFieldName('name');
        return name?.type === 'identifier' ? [symbolOf(name.text, 'variable', statement, exported)] : [];
      });
  }
  return [];
}
