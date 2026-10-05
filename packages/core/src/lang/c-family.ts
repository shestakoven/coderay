import { posix } from 'node:path';
import { Parser, Query, type Node } from 'web-tree-sitter';
import type { Lang, MapSymbol, SymbolKind } from '@ide/protocol';
import { loadGrammar, symbolOf } from './tree-sitter';
import type { LanguageAdapter } from './types';

const HEADER_EXTENSIONS = ['.h', '.hh', '.hpp', '.hxx'];
const C_EXTENSIONS = ['.c'];
const CPP_EXTENSIONS = [...HEADER_EXTENSIONS, '.cc', '.cpp', '.cxx'];
const INCLUDE_ROOTS = ['', 'include', 'src'];

const IMPORTS_QUERY = '(preproc_include path: [(string_literal (string_content) @quoted) (system_lib_string) @angled])';

const TAG_KINDS: Record<string, SymbolKind> = {
  struct_specifier: 'class',
  union_specifier: 'class',
  class_specifier: 'class',
  enum_specifier: 'enum',
};
const TRANSPARENT = new Set([
  'preproc_ifdef',
  'preproc_if',
  'preproc_else',
  'preproc_elif',
  'preproc_elifdef',
  'linkage_specification',
  'namespace_definition',
  'declaration_list',
]);
const DECLARATOR_WRAPPERS = new Set([
  'pointer_declarator',
  'reference_declarator',
  'parenthesized_declarator',
  'array_declarator',
  'init_declarator',
  'attributed_declarator',
]);
const DECLARED_NAMES = new Set(['identifier', 'field_identifier', 'type_identifier', 'qualified_identifier', 'destructor_name', 'operator_name']);

const C_GRAMMAR = 'tree-sitter-c/tree-sitter-c.wasm';

export const createCAdapter = (): Promise<LanguageAdapter> => createAdapter('c', C_GRAMMAR, C_EXTENSIONS);

export async function createCppAdapter(): Promise<LanguageAdapter> {
  const [cpp, c] = await Promise.all([createAdapter('cpp', 'tree-sitter-cpp/tree-sitter-cpp.wasm', CPP_EXTENSIONS), createAdapter('c', C_GRAMMAR, C_EXTENSIONS)]);
  return {
    ...cpp,
    // A `.h` may be C: macro-decorated C declarations (`API(int) f(void);`) come out wrong under the C++ grammar.
    parse(path, source) {
      const parsed = cpp.parse(path, source);
      if (!parsed.parseError || posix.extname(path) !== '.h') return parsed;
      const asC = c.parse(path, source);
      return asC.parseError ? parsed : asC;
    },
  };
}

async function createAdapter(lang: Lang, wasmModule: string, extensions: string[]): Promise<LanguageAdapter> {
  const language = await loadGrammar(wasmModule);
  const parser = new Parser();
  parser.setLanguage(language);
  const importsQuery = new Query(language, IMPORTS_QUERY);

  return {
    lang,
    handles: (path) => extensions.includes(posix.extname(path)),
    parse(path, source) {
      const tree = parser.parse(source);
      if (!tree) return { imports: [], symbols: [], parseError: true };
      try {
        const rootNode = tree.rootNode;
        const header = HEADER_EXTENSIONS.includes(posix.extname(path));
        const specifiers = importsQuery.captures(rootNode).map((c) => (c.name === 'angled' ? c.node.text.slice(1, -1) : c.node.text));
        return {
          imports: [...new Set(specifiers)],
          symbols: rootNode.namedChildren.flatMap((statement) => symbolsOf(statement, header)),
          parseError: rootNode.hasError,
        };
      } finally {
        tree.delete();
      }
    },
    resolve(fromPath, specifier, exists) {
      for (let dir = posix.dirname(fromPath); ; dir = posix.dirname(dir)) {
        for (const root of INCLUDE_ROOTS) {
          const candidate = posix.normalize(posix.join(dir, root, specifier));
          if (!candidate.startsWith('..') && exists(candidate)) return candidate;
        }
        if (dir === '.') return null;
      }
    },
  };
}

function symbolsOf(node: Node, header: boolean, templated?: Node): MapSymbol[] {
  if (node.type === 'template_declaration') return node.namedChildren.flatMap((child) => symbolsOf(child, header, node));
  if (TRANSPARENT.has(node.type)) return node.namedChildren.flatMap((child) => symbolsOf(child, header));
  const range = templated ?? node;
  const exported = !isStatic(node);

  const tagKind = TAG_KINDS[node.type];
  if (tagKind) {
    const name = node.childForFieldName('name');
    return name && node.childForFieldName('body') ? [symbolOf(name.text, tagKind, range, true)] : [];
  }
  switch (node.type) {
    case 'function_definition': {
      const found = declarator(node.childForFieldName('declarator'));
      return found ? [symbolOf(found.name, 'function', range, exported)] : [];
    }
    case 'declaration':
      return node.childrenForFieldName('declarator').flatMap((child) => {
        const found = declarator(child);
        if (!found) return [];
        if (!found.isFunction) return [symbolOf(found.name, 'variable', range, exported)];
        return header ? [symbolOf(found.name, 'function', range, exported)] : [];
      });
    case 'type_definition':
      return node.childrenForFieldName('declarator').flatMap((child) => {
        const found = declarator(child);
        return found ? [symbolOf(found.name, 'type', range, true)] : [];
      });
    case 'alias_declaration': {
      const name = node.childForFieldName('name');
      return name ? [symbolOf(name.text, 'type', range, true)] : [];
    }
    default:
      return [];
  }
}

function declarator(start: Node | null): { name: string; isFunction: boolean } | null {
  let current = start;
  let isFunction = false;
  while (current) {
    if (DECLARED_NAMES.has(current.type)) return { name: current.text, isFunction };
    if (current.type === 'function_declarator') isFunction = true;
    else if (!DECLARATOR_WRAPPERS.has(current.type)) return null;
    current = current.childForFieldName('declarator') ?? current.namedChildren[0] ?? null;
  }
  return null;
}

function isStatic(node: Node): boolean {
  return node.namedChildren.some((child) => child.type === 'storage_class_specifier' && child.text === 'static');
}
