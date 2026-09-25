const STORAGE_KEY = 'ide.launchToken';

export function launchToken(): string | null {
  const fromUrl = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fromUrl) {
    sessionStorage.setItem(STORAGE_KEY, fromUrl);
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    return fromUrl;
  }
  return sessionStorage.getItem(STORAGE_KEY);
}
