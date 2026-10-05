export type ProjectShortcut =
  | { type: 'palette' }
  | { type: 'new' }
  | { type: 'open-folder' }
  | { type: 'close' }
  | { type: 'jump'; key: number }
  | { type: 'cycle'; dir: 1 | -1 };

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

// The command key: Cmd on macOS, Ctrl elsewhere. Ctrl+Tab cycles on every platform.
export function matchShortcut(event: KeyLike, mac: boolean): ProjectShortcut | null {
  if (event.key === 'Tab' && event.ctrlKey && !event.metaKey && !event.altKey) return { type: 'cycle', dir: event.shiftKey ? -1 : 1 };
  const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!command || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'p') return { type: 'palette' };
  if (key === 't') return { type: 'new' };
  if (key === 'o') return { type: 'open-folder' };
  if (key === 'w') return { type: 'close' };
  if (/^[1-9]$/.test(key)) return { type: 'jump', key: Number(key) };
  return null;
}

export const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
