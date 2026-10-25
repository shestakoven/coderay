import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BackgroundAiView } from '@ide/protocol';
import { Onboarding } from '../src/onboarding/Onboarding';
import { Dot } from '../src/settings/controls';
import { mount } from './fake-hooks';

// The UI tests have no DOM, so React's hooks are replaced by ./fake-hooks and the screen's element tree is read directly.
vi.mock('react', async (importOriginal) => {
  const { useEffect, useRef, useState } = await import('./fake-hooks');
  return { ...(await importOriginal<typeof import('react')>()), useEffect, useRef, useState };
});

type Element = ReactElement<Record<string, unknown>>;

const descendants = (node: ReactNode): Element[] => {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...descendants(node.props.children as ReactNode)];
};
const textOf = (node: ReactNode): string => {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
};
const all = (tree: ReactNode, type: string): Element[] => descendants(tree).filter((element) => element.type === type);
const rows = (tree: ReactNode): string[] => all(tree, 'li').map((row) => textOf(row.props.children as ReactNode));
const tones = (tree: ReactNode): unknown[] => all(tree, 'li').map((row) => descendants(row.props.children as ReactNode).find((element) => element.type === Dot)?.props.tone);
const buttons = (tree: ReactNode): Element[] => all(tree, 'button');
const labels = (tree: ReactNode): string[] => buttons(tree).map((button) => textOf(button.props.children as ReactNode));
const press = (tree: ReactNode, label: string): void => (buttons(tree).find((button) => textOf(button.props.children as ReactNode) === label)!.props.onClick as () => void)();
const foot = (tree: ReactNode): string => textOf(descendants(tree).find((element) => element.props.className === 'ob-foot')?.props.children as ReactNode);

const view: BackgroundAiView = {
  choice: { mode: 'auto' }, onboarded: false, status: { state: 'ready', engine: 'opencode', modelId: 'opencode:opencode/x', note: null },
  options: [
    { engine: 'claude', status: { engine: 'claude', state: 'missing', hint: 'Install Claude Code: claude is not on the PATH.' }, models: [] },
    { engine: 'codex', status: { engine: 'codex', state: 'signed-out', hint: 'Codex is signed out: run codex login.' }, models: [] },
    { engine: 'opencode', status: { engine: 'opencode', state: 'ready', hint: null }, models: [] },
  ],
};
const handlers = () => ({ onUseFound: vi.fn(), onChoose: vi.fn(), onWithoutAi: vi.fn(), onSkip: vi.fn() });
const key = (init: { key: string; metaKey?: boolean }) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...init });

describe('Onboarding', () => {
  it('is a modal dialog that lists every engine with its state, hint and the one in use, wires each answer, and Esc skips', () => {
    const on = handlers();
    const screen = mount(() => Onboarding({ view, ...on }));
    const dialog = descendants(screen.output).find((element) => element.props.role === 'dialog')!;
    const title = descendants(screen.output).find((element) => element.props.id === dialog.props['aria-labelledby']);
    expect([dialog.props['aria-modal'], textOf(title?.props.children as ReactNode)]).toEqual(['true', 'Background AI']);
    expect(rows(screen.output)).toEqual([
      'Claude CodeNot installedInstall Claude Code: claude is not on the PATH.', 'CodexSigned outCodex is signed out: run codex login.', 'opencodeReadyIn use',
    ]);
    expect(tones(screen.output)).toEqual(['muted', 'warn', 'ok']);
    expect(labels(screen.output)).toEqual(["Use what's found", 'Choose an engine…', 'Continue without AI', 'Skip']);
    for (const label of labels(screen.output)) press(screen.output, label);
    expect([on.onUseFound, on.onChoose, on.onWithoutAi, on.onSkip].map((handler) => handler.mock.calls.length)).toEqual([1, 1, 1, 1]);
    expect(foot(screen.output)).toContain('Skip keeps Auto: the first engine that becomes ready is used.');
    const keyDown = dialog.props.onKeyDown as (event: ReturnType<typeof key>) => void;
    const plain = key({ key: 'f' });
    const shortcut = key({ key: ',', metaKey: true });
    keyDown(plain);
    keyDown(shortcut);
    expect([plain.stopPropagation.mock.calls.length, shortcut.stopPropagation.mock.calls.length, on.onSkip.mock.calls.length]).toEqual([1, 0, 1]);
    const escape = key({ key: 'Escape' });
    keyDown(escape);
    expect([on.onSkip.mock.calls.length, escape.preventDefault.mock.calls.length]).toEqual([2, 1]);
  });

  it("with no engine ready offers Continue without AI, not Use what's found, and Skip keeps the AI off", () => {
    const on = handlers();
    const none: BackgroundAiView = {
      ...view, choice: { mode: 'off' }, status: { state: 'off', reason: 'choice', engine: null, hint: 'h' },
      options: view.options.map((option) => ({ ...option, status: { ...option.status!, state: 'missing' as const } })),
    };
    const screen = mount(() => Onboarding({ view: none, ...on }));
    expect([labels(screen.output), rows(screen.output).some((row) => row.includes('In use'))]).toEqual([['Choose an engine…', 'Continue without AI', 'Skip'], false]);
    press(screen.output, 'Continue without AI');
    expect([on.onWithoutAi.mock.calls.length, foot(screen.output)]).toEqual([1, expect.stringContaining('Skip keeps the background AI off.')]);
  });

  it('while the engines are checked, the rows say so even of the engine already in use, and only Choose and Skip are offered, whatever is ready already', () => {
    const checking: BackgroundAiView = {
      ...view, choice: { mode: 'engine', engine: 'claude', model: null }, status: { state: 'ready', engine: 'claude', modelId: 'haiku', note: null },
      options: view.options.map((option) => (option.engine === 'opencode' ? option : { ...option, status: null })),
    };
    const screen = mount(() => Onboarding({ view: checking, ...handlers() }));
    expect(rows(screen.output)).toEqual(['Claude CodeChecking…', 'CodexChecking…', 'opencodeReady']);
    expect([labels(screen.output), tones(screen.output), all(screen.output, 'ul')[0]?.props['aria-busy']]).toEqual([['Choose an engine…', 'Skip'], ['muted', 'muted', 'ok'], true]);
    expect(foot(screen.output)).toContain('Skip keeps Claude Code.');
  });
});
