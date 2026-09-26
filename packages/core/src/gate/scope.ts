import { posix } from 'node:path';

export interface FrozenScope {
  paths: string[];
  globs: string[];
}

export interface ScopeTarget {
  rel: string;
  dir: boolean;
  mkdir: boolean;
}

// Node's glob has no backslash escape; a one-character class matches that character literally.
// A brace group with a comma cannot be escaped this way, because brace expansion runs first.
export const escapeGlob = (path: string): string => path.replace(/[[\]*?]/g, '[$&]').replace(/[+@!](?=\()/g, '[$&]');

const isAncestorOrSelf = (ancestor: string, path: string): boolean =>
  ancestor === '' || ancestor === '.' || ancestor === path || path.startsWith(`${ancestor}/`);

// The segment as a literal name, reading "[x]" as an escaped x; null when it holds a real wildcard.
function literalSegment(segment: string): string | null {
  let text = '';
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i]!;
    if (c === '[' && segment[i + 2] === ']') {
      text += segment[i + 1];
      i += 2;
    } else if ('*?[]{}'.includes(c)) {
      return null;
    } else {
      text += c;
    }
  }
  return text;
}

// The literal directories a glob starts from: "src/lib/**" → "src/lib", "src/*/x/**" → "src", "**" → "".
function globBase(glob: string): string {
  const segments: string[] = [];
  for (const segment of glob.split('/')) {
    const literal = literalSegment(segment);
    if (literal === null) break;
    segments.push(literal);
  }
  return segments.join('/');
}

// The directory a glob covers entirely: "src/lib/**" → "src/lib", "**" → ""; null for any other shape.
function wholeDirectory(glob: string): string | null {
  if (glob === '**') return '';
  if (!glob.endsWith('/**')) return null;
  const segments = glob.slice(0, -3).split('/').map(literalSegment);
  return segments.includes(null) ? null : segments.join('/');
}

export function covers(scope: FrozenScope, target: ScopeTarget): boolean {
  if (scope.globs.some((glob) => posix.matchesGlob(target.rel, glob))) return true;
  if (target.mkdir) {
    return scope.paths.includes(target.rel)
      || scope.paths.some((path) => isAncestorOrSelf(target.rel, posix.dirname(path)))
      || scope.globs.some((glob) => isAncestorOrSelf(target.rel, globBase(glob)));
  }
  if (target.dir) {
    return scope.globs.some((glob) => {
      const dir = wholeDirectory(glob);
      return dir !== null && isAncestorOrSelf(dir, target.rel);
    });
  }
  return scope.paths.includes(target.rel);
}
