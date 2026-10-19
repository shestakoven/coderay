import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateToast } from '../src/desktop/UpdateToast';
import { updateToastVisible, type UpdateState } from '../src/desktop/update-state';
import { useDesktopUpdate } from '../src/desktop/use-desktop-update';
import { mount } from './fake-hooks';

// The UI tests have no DOM, so React's hooks are replaced by ./fake-hooks and the toast's element tree is read directly.
vi.mock('react', async (importOriginal) => {
  const { useEffect, useState } = await import('./fake-hooks');
  return { ...(await importOriginal<typeof import('react')>()), useEffect, useState };
});

const NEXT = '2.0.0';
const GIVE_UP_MS = 10_000;
const at = (phase: UpdateState['phase'], offers: number, version = NEXT): UpdateState => ({ phase, version, percent: null, offers });
const ready = (offers: number, version = NEXT) => at('ready', offers, version);

function shell({ bridge = true } = {}) {
  const listeners = new Set<(state: UpdateState) => void>();
  let answerGet: (state: UpdateState | null) => void = () => undefined;
  const update = {
    get: vi.fn(() => new Promise<UpdateState | null>((resolve) => { answerGet = resolve; })),
    onChange: vi.fn((listener: (state: UpdateState) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
    restart: vi.fn(async () => undefined),
  };
  vi.stubGlobal('window', {
    coderayDesktop: bridge ? { update } : undefined,
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
  });
  return {
    update,
    listeners,
    tell: (state: UpdateState) => listeners.forEach((listener) => listener(state)),
    answer: async (state: UpdateState | null) => {
      answerGet(state);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

const descendants = (node: ReactNode): ReactElement<Record<string, unknown>>[] => {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...descendants(node.props.children as ReactNode)];
};
const textOf = (node: ReactNode): string => {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
};
const buttons = (tree: ReactNode) => descendants(tree).filter((element) => element.type === 'button');
const button = (tree: ReactNode, label: string) => buttons(tree).find((element) => textOf(element.props.children as ReactNode) === label);
const dismiss = (tree: ReactNode) => buttons(tree).find((element) => element.props['aria-label'] === 'Dismiss');
const click = (element: ReactElement<Record<string, unknown>> | undefined) => {
  expect(element).toBeDefined();
  (element?.props.onClick as () => void)();
};
const labels = (tree: ReactNode) => buttons(tree).filter((element) => element.props['aria-label'] === undefined).map((element) => [textOf(element.props.children as ReactNode), element.props.disabled === true]);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('updateToastVisible', () => {
  it('is true only for a ready update whose offer was not answered with Later', () => {
    const rows: [UpdateState | null, number | null][] = [
      [null, null], [null, 0],
      [at('idle', 0), null], [at('checking', 1), null], [at('downloading', 1), 0],
      [ready(0), null], [ready(1), null], [ready(2), 1],
      [ready(1), 1], [ready(0), 0],
    ];
    expect(rows.map(([state, dismissed]) => updateToastVisible(state, dismissed))).toEqual([
      false, false,
      false, false, false,
      true, true, true,
      false, false,
    ]);
  });
});

describe('useDesktopUpdate', () => {
  it('is empty outside the desktop shell, and restarting there does nothing', () => {
    shell({ bridge: false });
    const view = mount(useDesktopUpdate);

    expect(view.output.state).toBeNull();
    expect(() => view.output.restart()).not.toThrow();
  });

  it('stays empty until the shell answers, then shows the answer', async () => {
    const { answer } = shell();
    const view = mount(useDesktopUpdate);
    expect(view.output.state).toBeNull();

    await answer(ready(0));
    expect(view.output.state).toEqual(ready(0));
  });

  it('prefers a change that arrived while the first answer was on its way', async () => {
    const { answer, tell } = shell();
    const view = mount(useDesktopUpdate);

    tell(ready(1));
    await answer(at('downloading', 0));

    expect(view.output.state).toEqual(ready(1));
  });

  it('stops listening on unmount and ignores an answer that arrives after it', async () => {
    const { answer, listeners } = shell();
    const view = mount(useDesktopUpdate);
    expect(listeners.size).toBe(1);

    view.unmount();
    expect(listeners.size).toBe(0);
    await answer(ready(0));
    expect(view.lateUpdates).toBe(0);
  });
});

describe('UpdateToast', () => {
  it('shows nothing outside the shell or before an update is ready, and then names the version and offers Restart and Later', () => {
    shell({ bridge: false });
    expect(mount(UpdateToast).output).toBeNull();

    const { tell } = shell();
    const view = mount(UpdateToast);
    expect(view.output).toBeNull();
    tell(at('downloading', 0));
    expect(view.output).toBeNull();

    tell(ready(0));
    expect(textOf(descendants(view.output).find((element) => element.props.className === 'pt-title')?.props.children as ReactNode)).toBe(`CodeRay ${NEXT} is ready`);
    expect(labels(view.output)).toEqual([['Restart', false], ['Later', false]]);
    expect(dismiss(view.output)).toBeDefined();
  });

  it('asks the shell to restart, shows Restarting… until it gives up after 10 s, and then offers Restart again', () => {
    vi.useFakeTimers();
    const { tell, update } = shell();
    const view = mount(UpdateToast);
    tell(ready(1));

    click(button(view.output, 'Restart'));
    expect(update.restart).toHaveBeenCalledTimes(1);
    expect(labels(view.output)).toEqual([['Restarting…', true], ['Later', true]]);

    vi.advanceTimersByTime(GIVE_UP_MS - 1);
    expect(labels(view.output)).toEqual([['Restarting…', true], ['Later', true]]);
    vi.advanceTimersByTime(1);
    expect(labels(view.output)).toEqual([['Restart', false], ['Later', false]]);
  });

  it('keeps Restarting… for the same version when the shell sends a newer offer, and drops it for another version, giving up 10 s after the latest click', () => {
    vi.useFakeTimers();
    const { tell } = shell();
    const view = mount(UpdateToast);
    tell(ready(1));
    click(button(view.output, 'Restart'));

    tell(ready(2));
    expect(button(view.output, 'Restarting…')).toBeDefined();

    vi.advanceTimersByTime(GIVE_UP_MS / 2);
    tell(ready(0, '3.0.0'));
    expect(labels(view.output)).toEqual([['Restart', false], ['Later', false]]);
    click(button(view.output, 'Restart'));
    vi.advanceTimersByTime(GIVE_UP_MS / 2);
    expect(button(view.output, 'Restarting…')).toBeDefined();
    vi.advanceTimersByTime(GIVE_UP_MS / 2);
    expect(button(view.output, 'Restart')).toBeDefined();
  });

  it('hides for the offer that Later or the cross answered, and comes back with a newer offer', () => {
    const { tell } = shell();
    const view = mount(UpdateToast);

    tell(ready(1));
    click(button(view.output, 'Later'));
    expect(view.output).toBeNull();
    tell(ready(1));
    expect(view.output).toBeNull();

    tell(ready(2));
    expect(button(view.output, 'Later')).toBeDefined();
    click(dismiss(view.output));
    expect(view.output).toBeNull();

    tell(ready(3));
    expect(button(view.output, 'Restart')).toBeDefined();
  });
});
