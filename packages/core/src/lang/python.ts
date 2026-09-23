import { posix } from 'node:path';
import { Parser, Query, type Node } from 'web-tree-sitter';
import type { MapSymbol } from '@ide/protocol';
import { loadGrammar, symbolOf } from './tree-sitter';
import type { LanguageAdapter } from './types';

const IMPORTS_QUERY = '[(import_statement) (import_from_statement)] @import';
const SOURCE_ROOTS = ['', 'src'];

export async function createPythonAdapter(): Promise<LanguageAdapter> {
  const language = await loadGrammar('tree-sitter-python/tree-sitter-python.wasm');
  const parser = new Parser();
  parser.setLanguage(language);
  const importsQuery = new Query(language, IMPORTS_QUERY);

  return {
    lang: 'python',
    handles: (path) => path.endsWith('.py') || path.endsWith('.pyi'),
    parse(_path, source) {
      const tree = parser.parse(source);
      if (!tree) return { imports: [], symbols: [], parseError: true };
      try {
        const rootNode = tree.rootNode;
        return {
          imports: [...new Set(importsQuery.captures(rootNode).flatMap((c) => importSpecifiers(c.node)))],
          symbols: rootNode.namedChildren.flatMap(topLevelSymbols),
          parseError: rootNode.hasError,
        };
      } finally {
        tree.delete();
      }
    },
    resolve(fromPath, specifier, exists) {
      const dots = specifier.length - specifier.replace(/^\.+/, '').length;
      const parts = specifier.slice(dots).split('.').filter(Boolean);
      const bases = dots > 0 ? [posix.join(packageDir(fromPath, dots), ...parts)] : SOURCE_ROOTS.map((r) => posix.join(r, ...parts));
      for (const base of bases) {
        const hit = [`${base}.py`, `${base}.pyi`, posix.join(base, '__init__.py')].find(exists);
        if (hit) return hit;
      }
      return null;
    },
  };
}

function packageDir(fromPath: string, dots: number): string {
  let dir = posix.dirname(fromPath);
  for (let level = 1; level < dots; level += 1) dir = posix.dirname(dir);
  return dir;
}

function importSpecifiers(node: Node): string[] {
  const names = node
    .childrenForFieldName('name')
    .map((n) => (n.type === 'aliased_import' ? n.childForFieldName('name')?.text : n.text))
    .filter((n): n is string => Boolean(n));
  if (node.type === 'import_statement') return names;
  const moduleName = node.childForFieldName('module_name')?.text;
  if (!moduleName) return [];
  return [moduleName, ...names.map((name) => (moduleName.endsWith('.') ? moduleName + name : `${moduleName}.${name}`))];
}

function topLevelSymbols(statement: Node): MapSymbol[] {
  const definition = statement.type === 'decorated_definition' ? statement.childForFieldName('definition') : statement;
  if (definition?.type === 'function_definition' || definition?.type === 'class_definition') {
    const name = definition.childForFieldName('name');
    const kind = definition.type === 'class_definition' ? 'class' : 'function';
    return name ? [symbolOf(name.text, kind, statement, !name.text.startsWith('_'))] : [];
  }
  if (statement.type === 'expression_statement') {
    const assignment = statement.namedChildren[0];
    const left = assignment?.type === 'assignment' ? assignment.childForFieldName('left') : null;
    return left?.type === 'identifier' ? [symbolOf(left.text, 'variable', statement, !left.text.startsWith('_'))] : [];
  }
  return [];
}
