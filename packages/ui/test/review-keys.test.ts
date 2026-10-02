import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusIsHere, keyOf, SHORTCUTS, typing } from '../src/history/review-keys';

// The UI tests run without a DOM, so the element class `typing` checks against is stood in for.
class FakeElement {
  constructor(readonly tagName: string, readonly isContentEditable = false) {}
}
const withDom = (): void => void vi.stubGlobal('HTMLElement', FakeElement);
const element = (tagName: string, isContentEditable = false) => new FakeElement(tagName, isContentEditable) as unknown as EventTarget;

afterEach(() => vi.unstubAllGlobals());

describe('typing', () => {
  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('is true for a %s element', (tagName) => {
    withDom();
    expect(typing(element(tagName))).toBe(true);
  });

  it('is true for an editable element of any tag', () => {
    withDom();
    expect(typing(element('DIV', true))).toBe(true);
    expect(typing(element('SPAN', true))).toBe(true);
  });

  it.each(['BUTTON', 'DIV', 'A', 'BODY', 'SPAN', 'LI', 'LABEL'])('is false for a %s element that is not editable', (tagName) => {
    withDom();
    expect(typing(element(tagName))).toBe(false);
  });

  it('is false when there is no target', () => {
    withDom();
    expect(typing(null)).toBe(false);
  });

  it('is false for an event target that is not an element', () => {
    withDom();
    expect(typing(new EventTarget())).toBe(false);
    expect(typing({ tagName: 'INPUT', isContentEditable: true } as unknown as EventTarget)).toBe(false);
  });

  it('is false for an input-like tag name that is not exactly one of the three', () => {
    withDom();
    expect(typing(element('INPUTS'))).toBe(false);
    expect(typing(element('TEXTAREAS'))).toBe(false);
  });
});

describe('SHORTCUTS', () => {
  const items = SHORTCUTS.flatMap((group) => group.items);
  const keys = items.flatMap((item) => item.keys.map((key) => key.toLowerCase()));

  it('has at least one group', () => {
    expect(SHORTCUTS.length).toBeGreaterThan(0);
  });

  it('gives every group a title and at least one shortcut', () => {
    for (const group of SHORTCUTS) {
      expect(group.title.trim(), 'title').not.toBe('');
      expect(group.items.length, group.title).toBeGreaterThan(0);
    }
  });

  it('gives every group a different title', () => {
    const titles = SHORTCUTS.map((group) => group.title.trim().toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('gives every shortcut at least one non-empty key', () => {
    for (const item of items) {
      expect(item.keys.length, item.does).toBeGreaterThan(0);
      for (const key of item.keys) expect(key.trim(), item.does).not.toBe('');
    }
  });

  it('describes every shortcut', () => {
    for (const item of items) expect(item.does.trim().length, item.keys.join('+')).toBeGreaterThanOrEqual(3);
  });

  it('does not use one key for two shortcuts', () => {
    const seen = new Map<string, string>();
    for (const item of items) {
      for (const key of item.keys.map((k) => k.toLowerCase())) {
        expect(seen.get(key), `${key} is used by "${seen.get(key)}" and "${item.does}"`).toBeUndefined();
        seen.set(key, item.does);
      }
    }
  });

  it('does not describe two shortcuts the same way', () => {
    const texts = items.map((item) => item.does.trim().toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);
  });

  it.each(['j', 'k', 'n', 'p', 'a', 'u', 'r', 'c', 'i', 's', '/', '?', 'esc'])('documents the %s key', (key) => {
    expect(keys).toContain(key);
  });
});

describe('keyOf', () => {
  const press = (key: string, code: string, shiftKey = false) => keyOf({ key, code, shiftKey });
  const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

  it.each(letters)('reads the physical key %s as its lower-case letter', (letter) => {
    expect(press(letter.toLowerCase(), `Key${letter}`)).toBe(letter.toLowerCase());
  });

  it.each(letters)('reads Shift plus the physical key %s as the upper-case letter', (letter) => {
    expect(press(letter, `Key${letter}`, true)).toBe(letter);
  });

  it('reads a letter of a Russian layout from the physical key', () => {
    expect(press('ф', 'KeyA')).toBe('a');
    expect(press('я', 'KeyZ')).toBe('z');
    expect(press('о', 'KeyJ')).toBe('j');
  });

  it('reads Shift plus a letter of a Russian layout as the upper-case letter', () => {
    expect(press('Ф', 'KeyA', true)).toBe('A');
  });

  it('reads a letter typed with Caps Lock on, without Shift, as the lower-case letter', () => {
    expect(press('A', 'KeyA', false)).toBe('a');
    expect(press('Ф', 'KeyA', false)).toBe('a');
  });

  it('reads a letter typed with Shift while Caps Lock is on as the upper-case letter', () => {
    expect(press('a', 'KeyA', true)).toBe('A');
  });

  it('reads a dead key by its physical letter', () => {
    expect(press('Dead', 'KeyE')).toBe('e');
  });

  it('never gives Shift plus a letter the same value as the plain letter', () => {
    for (const letter of letters) expect(press(letter, `Key${letter}`, true)).not.toBe(press(letter.toLowerCase(), `Key${letter}`));
  });

  it('reads a question mark as a question mark even on the slash key without Shift', () => {
    expect(press('?', 'Slash', false)).toBe('?');
  });

  it('reads a question mark typed from another key as a question mark', () => {
    expect(press('?', 'Digit7', true)).toBe('?');
    expect(press('?', 'Slash', true)).toBe('?');
  });

  it('reads the slash key without Shift as a slash', () => {
    expect(press('/', 'Slash')).toBe('/');
  });

  it('reads the slash key of a Russian layout as a slash', () => {
    expect(press('.', 'Slash')).toBe('/');
  });

  it('reads Shift plus the slash key as a question mark', () => {
    expect(press(',', 'Slash', true)).toBe('?');
    expect(press('/', 'Slash', true)).toBe('?');
  });

  it.each([
    ['Escape', 'Escape'],
    ['ArrowDown', 'ArrowDown'],
    ['ArrowUp', 'ArrowUp'],
    ['Enter', 'Enter'],
    ['Tab', 'Tab'],
    ['Backspace', 'Backspace'],
    [' ', 'Space'],
    ['1', 'Digit1'],
    ['0', 'Digit0'],
    ['!', 'Digit1'],
    ['Meta', 'MetaLeft'],
  ])('passes the key %j (code %s) through', (key, code) => {
    expect(press(key, code)).toBe(key);
  });

  it('passes Shift plus a non-letter key through unchanged', () => {
    expect(press('Enter', 'Enter', true)).toBe('Enter');
    expect(press('Tab', 'Tab', true)).toBe('Tab');
  });

  it('does not take a code that is not a letter key for a letter', () => {
    expect(press('!', 'Key1', true)).toBe('!');
    expect(press('x', 'Keyboard')).toBe('x');
    expect(press('x', 'KeyAA')).toBe('x');
    expect(press('x', 'MyKeyA')).toBe('x');
  });

  it('does not take a numpad or digit code for a letter', () => {
    expect(press('1', 'Numpad1')).toBe('1');
    expect(press('5', 'Digit5')).toBe('5');
  });
});

describe('focusIsHere', () => {
  class FakeNode {
    readonly children: FakeNode[] = [];
    add(child: FakeNode): FakeNode {
      this.children.push(child);
      return child;
    }
    contains(other: unknown): boolean {
      return other === this || this.children.some((child) => child.contains(other));
    }
  }
  const body = new FakeNode();
  const html = new FakeNode();
  const dom = () => {
    const root = new FakeNode();
    const child = root.add(new FakeNode());
    const grandchild = child.add(new FakeNode());
    const outside = body.add(new FakeNode());
    return { root: root as unknown as Element, child: child as unknown as EventTarget, grandchild: grandchild as unknown as EventTarget, outside: outside as unknown as EventTarget };
  };
  const as = (node: FakeNode): EventTarget => node as unknown as EventTarget;
  const withDocument = (): void => {
    vi.stubGlobal('Node', FakeNode);
    vi.stubGlobal('document', { body, documentElement: html });
  };

  it('is true when nothing has focus', () => {
    withDocument();
    expect(focusIsHere(dom().root, null)).toBe(true);
  });

  it('is true when the target is not a node, such as the window', () => {
    withDocument();
    expect(focusIsHere(dom().root, new EventTarget())).toBe(true);
    expect(focusIsHere(dom().root, {} as EventTarget)).toBe(true);
  });

  it('is true when the document body has focus', () => {
    withDocument();
    expect(focusIsHere(dom().root, as(body))).toBe(true);
  });

  it('is true when the root element of the document has focus', () => {
    withDocument();
    expect(focusIsHere(dom().root, as(html))).toBe(true);
  });

  it('is true for the review root itself', () => {
    withDocument();
    const { root } = dom();
    expect(focusIsHere(root, root as unknown as EventTarget)).toBe(true);
  });

  it('is true for a child and a deeper descendant of the review root', () => {
    withDocument();
    const { root, child, grandchild } = dom();
    expect(focusIsHere(root, child)).toBe(true);
    expect(focusIsHere(root, grandchild)).toBe(true);
  });

  it('is false for a node outside the review root', () => {
    withDocument();
    const { root, outside } = dom();
    expect(focusIsHere(root, outside)).toBe(false);
  });

  it('is false for a node that is in a different tree than the review root', () => {
    withDocument();
    const { root } = dom();
    expect(focusIsHere(root, as(new FakeNode()))).toBe(false);
  });

  it('is false for an element when there is no review root', () => {
    withDocument();
    expect(focusIsHere(null, dom().child)).toBe(false);
  });

  it('is still true for nothing, the body and the document element when there is no review root', () => {
    withDocument();
    expect(focusIsHere(null, null)).toBe(true);
    expect(focusIsHere(null, as(body))).toBe(true);
    expect(focusIsHere(null, as(html))).toBe(true);
  });
});
