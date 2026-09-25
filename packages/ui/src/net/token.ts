const STORAGE_KEY = 'ide.launchToken';

export function hashToken(hash: string): string | null {
  return new URLSearchParams(hash.slice(1)).get('token');
}

export function launchToken(): string | null {
  const fromUrl = hashToken(location.hash);
  if (fromUrl) {
    sessionStorage.setItem(STORAGE_KEY, fromUrl);
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    return fromUrl;
  }
  return sessionStorage.getItem(STORAGE_KEY);
}
