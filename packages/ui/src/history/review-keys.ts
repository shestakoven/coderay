export const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

// Letters are read from the physical key, so the shortcuts work in any keyboard layout (and with Caps Lock);
// Shift+letter stays distinct (upper case) so it never triggers a plain shortcut.
export function keyOf(event: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey'>): string {
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
  if (letter) return event.shiftKey ? letter : letter.toLowerCase();
  if (event.key === '?') return '?';
  if (event.code === 'Slash') return event.shiftKey ? '?' : '/';
  return event.key;
}

// Keys belong to the review only while focus is in it (or nowhere): a click in the chat must not make `a` accept a file.
export const focusIsHere = (root: Element | null, target: EventTarget | null): boolean =>
  typeof Node === 'undefined' || !(target instanceof Node) || target === document.body || target === document.documentElement || (root?.contains(target) ?? false);

export interface Shortcut {
  keys: string[];
  does: string;
}

export const SHORTCUTS: { title: string; items: Shortcut[] }[] = [
  { title: 'Files', items: [
    { keys: ['j', 'k'], does: 'Next and previous file' },
    { keys: ['/'], does: 'Filter the list' },
    { keys: ['esc'], does: 'Exit the review' },
  ] },
  { title: 'The diff', items: [
    { keys: ['n', 'p'], does: 'Next and previous hunk' },
    { keys: ['s'], does: 'Switch between unified and split' },
    { keys: ['i'], does: 'Show or hide why the change exists' },
    { keys: ['c'], does: 'Comment on the current hunk' },
    { keys: ['⌘', '↵'], does: 'Save the comment' },
  ] },
  { title: 'Decisions', items: [
    { keys: ['a'], does: 'Accept the file' },
    { keys: ['u'], does: 'Undo the last accept' },
    { keys: ['r'], does: 'Revert the file' },
    { keys: ['?'], does: 'Show this list' },
  ] },
];
