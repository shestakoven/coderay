import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BackgroundAiStatus, BackgroundAiView, MapOverview } from '@ide/protocol';
import { OverviewPending } from '../src/overview/OverviewView';
import { BackgroundAiBlock } from '../src/settings/BackgroundAiBlock';
import { Dot, Segmented } from '../src/settings/controls';
import { mount } from './fake-hooks';

// The UI tests have no DOM, so React's hooks are replaced by ./fake-hooks and the block's element tree is read directly.
vi.mock('react', async (importOriginal) => {
  const { useEffect, useState } = await import('./fake-hooks');
  return { ...(await importOriginal<typeof import('react')>()), useEffect, useState };
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
const statusOf = (tree: ReactNode): Element | undefined => descendants(tree).find((element) => element.props.role === 'status');
const status = (tree: ReactNode): string => textOf(statusOf(tree)?.props.children as ReactNode);
const toneOf = (tree: ReactNode): unknown => descendants(statusOf(tree)?.props.children as ReactNode).find((element) => element.type === Dot)?.props.tone;
const radio = (tree: ReactNode, label: string): void => {
  const group = descendants(tree).find((element) => element.type === Segmented)!.props as { options: { value: string; label: string }[]; onChange: (value: string) => void };
  group.onChange(group.options.find((option) => option.label === label)!.value);
};
const select = (tree: ReactNode, label: string): Element | undefined => {
  const field = descendants(tree).find((element) => element.type === 'label' && textOf((element.props.children as ReactNode[])[0]) === label);
  return descendants(field?.props.children as ReactNode).find((element) => element.type === 'select');
};
const choose = (tree: ReactNode, label: string, value: string): void => (select(tree, label)!.props.onChange as (event: unknown) => void)({ target: { value } });

const view: BackgroundAiView = {
  choice: { mode: 'auto' }, onboarded: true,
  status: { state: 'ready', engine: 'codex', modelId: 'codex:gpt-5.1-codex-mini', note: null },
  options: [
    { engine: 'claude', status: { engine: 'claude', state: 'missing', hint: 'Install Claude Code.' }, models: [] },
    { engine: 'codex', status: { engine: 'codex', state: 'ready', hint: null }, models: [{ value: 'codex:gpt-6', name: 'GPT-6', engine: 'codex', efforts: [] }, { value: 'codex:gpt-5.1-codex-mini', name: 'GPT-5.1 Codex mini', engine: 'codex', efforts: [] }] },
    { engine: 'opencode', status: null, models: [] },
  ],
};
const ready = { state: 'ready', engine: 'codex', modelId: 'codex:gpt-5.1-codex-mini', note: null } as const;
const OFF: BackgroundAiStatus = { state: 'off', reason: 'choice', engine: null, hint: 'Background AI is off. Turn it on in Settings → Background AI.' };

describe('BackgroundAiBlock', () => {
  it('says which engine is ready without naming the model, and saves an explicit engine and model', () => {
    const onSave = vi.fn();
    const block = mount(() => BackgroundAiBlock({ view, onSave, onShowFirstRun: () => undefined }));
    expect([status(block.output), select(block.output, 'Engine')]).toEqual(['Ready · Codex', undefined]);
    radio(block.output, 'Choose an engine');
    expect(onSave).toHaveBeenLastCalledWith({ mode: 'engine', engine: 'codex', model: null });
    expect(descendants(select(block.output, 'Engine')!.props.children as ReactNode).filter((element) => element.type === 'option').map((option) => textOf(option.props.children as ReactNode)))
      .toEqual(['Claude Code · Not installed', 'Codex · Ready', 'opencode · Checking…']);
    choose(block.output, 'Model', 'codex:gpt-6');
    radio(block.output, 'Choose an engine');
    expect(onSave).toHaveBeenLastCalledWith({ mode: 'engine', engine: 'codex', model: 'codex:gpt-6' });
    choose(block.output, 'Engine', 'claude');
    expect([onSave.mock.lastCall?.[0], select(block.output, 'Model')!.props.disabled, onSave.mock.calls.length]).toEqual([{ mode: 'engine', engine: 'claude', model: null }, true, 3]);
    radio(block.output, 'Auto');
    radio(block.output, 'Choose an engine');
    expect(onSave).toHaveBeenLastCalledWith({ mode: 'engine', engine: 'claude', model: null });
  });

  it('Off saves at once, a choice made in another window shows, and the block and the empty overview say why the AI is off', () => {
    const onSave = vi.fn();
    let current = view;
    const block = mount(() => BackgroundAiBlock({ view: current, onSave, onShowFirstRun: () => undefined }));
    radio(block.output, 'Off');
    expect(onSave).toHaveBeenLastCalledWith({ mode: 'off' });
    current = { ...view, choice: { mode: 'engine', engine: 'codex', model: 'codex:gone' }, status: { ...ready, note: 'Claude Code failed: Not logged in · Please run /login · opencode is too old' } };
    block.rerender();
    const model = select(block.output, 'Model')!;
    expect([select(block.output, 'Engine')?.props.value, model.props.value, textOf(descendants(model.props.children as ReactNode).at(-1)?.props.children as ReactNode), status(block.output)])
      .toEqual(['codex', 'codex:gone', 'codex:gone', 'Ready · CodexClaude Code failed: Not logged in · Please run /loginopencode is too old']);
    // That choice is also the one "Choose an engine" comes back to after Auto.
    radio(block.output, 'Auto');
    radio(block.output, 'Choose an engine');
    expect(onSave).toHaveBeenLastCalledWith({ mode: 'engine', engine: 'codex', model: 'codex:gone' });
    current = { ...view, status: { state: 'checking' } };
    block.rerender();
    const checking = status(block.output);
    current = { ...view, choice: { mode: 'off' }, status: OFF };
    block.rerender();
    const offStatus = status(block.output);
    const unavailable = { ...OFF, reason: 'unavailable', engine: 'codex', hint: 'Codex is signed out: run codex login. Choose another engine in Settings → Background AI.' } as const;
    current = { ...view, choice: { mode: 'engine', engine: 'codex', model: null }, status: unavailable };
    block.rerender();
    const unavailableStatus = [status(block.output), toneOf(block.output)];
    current = { ...view, status: { ...OFF, reason: 'none', hint: 'Claude Code failed: Not logged in · Please run /login · Codex failed: x. The map and chat work without an AI engine.' } };
    block.rerender();
    const empty = (overview: MapOverview, backgroundAi: BackgroundAiStatus) =>
      renderToStaticMarkup(<OverviewPending overview={overview} backgroundAi={backgroundAi} onRebuild={() => undefined} onOpenSettings={() => undefined} />);
    const failed: MapOverview = { state: 'failed', error: OFF.hint, basedOnCurrentMap: true, groups: [], links: [], labels: [] };
    expect([checking, offStatus, unavailableStatus, status(block.output)]).toEqual([
      'Checking the engines…', 'Background AI is off. No background calls are made; new groupings, summaries and overviews wait until you turn it on.',
      ['Codex is signed out: run codex login. Choose another engine.', 'warn'],
      'No engine can run the background AI right now.Claude Code failed: Not logged in · Please run /loginCodex failed: x. The map and chat work without an AI engine.',
    ]);
    expect([empty(failed, OFF), empty({ ...failed, state: 'waiting', error: null }, unavailable), empty(failed, view.status)].map((html) => [
      html.includes(OFF.hint) || html.includes(unavailable.hint), html.includes('>Open Settings<'), html.includes('>Try again<'),
    ])).toEqual([[true, true, false], [true, true, false], [true, false, true]]);
    // Without an earlier pick, "Choose an engine" starts on the engine Auto runs on now, even one the probe has not answered for; with none, on the first one it calls ready.
    const fresh = mount(() => BackgroundAiBlock({ view: { ...view, status: { ...ready, engine: 'opencode' } }, onSave, onShowFirstRun: () => undefined }));
    radio(fresh.output, 'Choose an engine');
    expect(onSave).toHaveBeenLastCalledWith({ mode: 'engine', engine: 'opencode', model: null });
    const idle = mount(() => BackgroundAiBlock({ view: { ...view, status: { ...OFF, reason: 'none', hint: 'Codex failed: x.' } }, onSave, onShowFirstRun: () => undefined }));
    radio(idle.output, 'Choose an engine');
    expect(onSave).toHaveBeenLastCalledWith({ mode: 'engine', engine: 'codex', model: null });
  });
});
