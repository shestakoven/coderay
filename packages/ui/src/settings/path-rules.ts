export type PathListField = 'guarded' | 'harness' | 'outsideAllowed';

const CONTROL = /[\u0000-\u001f\u007f]/;
const hasParentSegment = (pattern: string): boolean => pattern.split('/').includes('..');

// The first member of a class never closes it, and a backslash escapes the next character.
function closingBracket(pattern: string, open: number): number {
  let at = open + 1;
  if (pattern[at] === '\\') at += 1;
  for (at += 1; at < pattern.length; at += 1) {
    if (pattern[at] === '\\') at += 1;
    else if (pattern[at] === ']') return at;
  }
  return -1;
}

function hasUnclosedBracket(pattern: string): boolean {
  for (let at = 0; at < pattern.length; at += 1) {
    if (pattern[at] === '\\') {
      at += 1;
    } else if (pattern[at] === '[') {
      const close = closingBracket(pattern, at);
      if (close === -1) return true;
      at = close;
    }
  }
  return false;
}

function checkGitignore(pattern: string): string | null {
  if (pattern.startsWith('#')) return 'A leading # starts a comment. Write \\# to match a name that begins with #.';
  if (pattern === '!') return 'Add a pattern after the !.';
  const body = pattern.startsWith('!') ? pattern.slice(1) : pattern;
  if (body.startsWith('~')) return 'Use a path inside the project. Places outside it go under "Allowed outside the project".';
  if (body.startsWith('./')) return 'Patterns are relative to the project root. Drop the leading ./';
  if (hasParentSegment(body)) return 'Parent segments (..) are not supported.';
  if (/(^|[^\\])(\\\\)*\\$/.test(body)) return 'A trailing backslash escapes nothing.';
  if (/\*{3,}/.test(body)) return 'Use * or ** — three or more asterisks in a row are not valid.';
  if (hasUnclosedBracket(body)) return 'There is a [ without a closing ].';
  return null;
}

function checkOutside(pattern: string): string | null {
  if (!pattern.startsWith('/') && !pattern.startsWith('~/')) return 'Use an absolute path or start with ~/';
  if (pattern === '/' || pattern === '~/') return 'That would allow every path. Name a folder.';
  if (hasParentSegment(pattern)) return 'Parent segments (..) are not supported.';
  return null;
}

export function checkPattern(field: PathListField, raw: string): string | null {
  const pattern = raw.trim();
  if (pattern === '') return 'Enter a path or pattern.';
  if (CONTROL.test(pattern)) return 'Use one pattern per line, without control characters.';
  return field === 'outsideAllowed' ? checkOutside(pattern) : checkGitignore(pattern);
}

export function addPattern(field: PathListField, list: string[], raw: string): { list: string[] } | { error: string } {
  const error = checkPattern(field, raw);
  if (error) return { error };
  const pattern = raw.trim();
  if (list.includes(pattern)) return { error: 'This pattern is already in the list.' };
  return { list: [...list, pattern] };
}

export function replacePattern(field: PathListField, list: string[], index: number, raw: string): { list: string[] } | { error: string } {
  const error = checkPattern(field, raw);
  if (error) return { error };
  const pattern = raw.trim();
  if (list.some((item, at) => at !== index && item === pattern)) return { error: 'This pattern is already in the list.' };
  return { list: list.map((item, at) => (at === index ? pattern : item)) };
}

export const removePattern = (list: string[], index: number): string[] => list.filter((_, at) => at !== index);
