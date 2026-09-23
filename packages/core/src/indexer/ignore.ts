import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ignore from 'ignore';

const ALWAYS_IGNORED = new Set(['.git', 'node_modules', '.ide', '.superpowers', '__pycache__', '.venv', 'venv']);

export type IgnoreMatcher = (relPath: string, isDir: boolean) => boolean;

export function createIgnoreMatcher(root: string): IgnoreMatcher {
  const rules = ignore();
  const gitignore = join(root, '.gitignore');
  if (existsSync(gitignore)) rules.add(readFileSync(gitignore, 'utf8'));
  return (relPath, isDir) => {
    if (relPath === '') return false;
    if (relPath.split('/').some((segment) => ALWAYS_IGNORED.has(segment))) return true;
    return rules.ignores(isDir ? `${relPath}/` : relPath);
  };
}
