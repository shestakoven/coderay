const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const MAX_PATH = 1024;

// A URL that names a file on this machine rather than something on the web.
export const isLocalUrl = (url: string): boolean => url !== '' && (/^file:/i.test(url) || (!SCHEME.test(url) && !url.startsWith('//')));

export const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url);

// `bare` admits a lone file name with no directory, which plain prose would turn up far too often.
function imagePath(candidate: string, bare: boolean): string | null {
  if (candidate === '' || candidate.length > MAX_PATH || /[\n\r\t]/.test(candidate) || !IMAGE_EXTENSION.test(candidate)) return null;
  if (/^file:\/\//i.test(candidate)) return candidate;
  if (SCHEME.test(candidate) || candidate.startsWith('//')) return null;
  if (candidate.includes('/')) return candidate;
  return bare ? candidate : null;
}

export const codeImagePath = (code: string): string | null => imagePath(code.trim(), true);

export const linkImagePath = (url: string): string | null => (isLocalUrl(url) ? imagePath(url, true) : null);

export function textImagePaths(text: string): string[] {
  const paths: string[] = [];
  for (const token of text.split(/\s+/)) {
    const trimmed = token.replace(/^[("'`<[]+/, '').replace(/[)"'`>\].,;:!?]+$/, '');
    const path = imagePath(trimmed, false);
    if (path !== null) paths.push(path);
  }
  return paths;
}
