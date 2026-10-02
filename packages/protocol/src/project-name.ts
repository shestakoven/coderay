const MAX_NAME_BYTES = 255;

export function validateProjectName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Enter a folder name.';
  if (trimmed === '.' || trimmed === '..') return 'That name is not allowed.';
  if (/[\/\0]/.test(trimmed)) return 'The name cannot contain "/" or a null character.';
  if (new TextEncoder().encode(trimmed).length > MAX_NAME_BYTES) return 'The name is too long (255 bytes at most).';
  return null;
}

export function projectNameFromUrl(url: string): string {
  const stripped = url.trim().replace(/[\/\\]+$/, '').replace(/\.git$/i, '');
  return stripped.split(/[\/\\:]/).pop() ?? '';
}
