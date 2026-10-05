import { describe, expect, it } from 'vitest';
import { matchShortcut, type KeyLike } from '../src/project/shortcuts';

const press = (key: string, mods: Partial<Omit<KeyLike, 'key'>> = {}): KeyLike => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const cmd = { metaKey: true };
const ctrl = { ctrlKey: true };

describe('matchShortcut Ctrl+Tab', () => {
  it.each([true, false])('cycles forward with Ctrl+Tab (mac %s)', (mac) => {
    expect(matchShortcut(press('Tab', ctrl), mac)).toEqual({ type: 'cycle', dir: 1 });
  });

  it.each([true, false])('cycles back with Ctrl+Shift+Tab (mac %s)', (mac) => {
    expect(matchShortcut(press('Tab', { ctrlKey: true, shiftKey: true }), mac)).toEqual({ type: 'cycle', dir: -1 });
  });

  it.each([
    ['Tab alone', press('Tab')],
    ['Shift+Tab', press('Tab', { shiftKey: true })],
    ['Cmd+Tab', press('Tab', cmd)],
    ['Cmd+Ctrl+Tab', press('Tab', { metaKey: true, ctrlKey: true })],
    ['Alt+Ctrl+Tab', press('Tab', { altKey: true, ctrlKey: true })],
    ['Alt+Ctrl+Shift+Tab', press('Tab', { altKey: true, ctrlKey: true, shiftKey: true })],
  ])('ignores %s', (_, event) => {
    expect([matchShortcut(event, true), matchShortcut(event, false)]).toEqual([null, null]);
  });
});

describe.each([
  ['mac', true, cmd, ctrl],
  ['other platforms', false, ctrl, cmd],
] as const)('matchShortcut command key on %s', (_, mac, command, wrong) => {
  it.each([
    ['p', { type: 'palette' }],
    ['t', { type: 'new' }],
    ['o', { type: 'open-folder' }],
    ['w', { type: 'close' }],
  ])('maps %s', (key, shortcut) => {
    expect(matchShortcut(press(key, command), mac)).toEqual(shortcut);
  });

  it('ignores the case of the key', () => {
    expect([matchShortcut(press('P', command), mac), matchShortcut(press('W', command), mac)]).toEqual([{ type: 'palette' }, { type: 'close' }]);
  });

  it.each([1, 2, 5, 8, 9])('jumps to tab %d', (n) => {
    expect(matchShortcut(press(String(n), command), mac)).toEqual({ type: 'jump', key: n });
  });

  it.each(['0', 'x', 'k', 'Enter', 'pp'])('ignores the command key with %j', (key) => {
    expect(matchShortcut(press(key, command), mac)).toBeNull();
  });

  it('ignores the keys without the command key', () => {
    expect(['p', 't', 'o', 'w', '1'].map((key) => matchShortcut(press(key), mac))).toEqual([null, null, null, null, null]);
  });

  it('ignores the command key of the other platform', () => {
    expect(['p', 't', 'o', 'w', '1'].map((key) => matchShortcut(press(key, wrong), mac))).toEqual([null, null, null, null, null]);
  });

  it('ignores both command keys held together', () => {
    expect(['p', '1'].map((key) => matchShortcut(press(key, { metaKey: true, ctrlKey: true }), mac))).toEqual([null, null]);
  });

  it.each([
    ['Shift', { shiftKey: true }],
    ['Alt', { altKey: true }],
  ])('ignores the command key with an extra %s', (_, extra) => {
    expect(['p', 't', 'o', 'w', '1'].map((key) => matchShortcut(press(key, { ...command, ...extra }), mac))).toEqual([null, null, null, null, null]);
  });
});
