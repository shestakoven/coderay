import { describe, expect, it } from 'vitest';
import { initialPanels, loadPanels, panelReducer, savePanels, type PanelState } from '../src/layout/panel-state';

const state = (overrides: Partial<PanelState> = {}): PanelState => ({ ...initialPanels, ...overrides });
const visible = (s: PanelState) => ({ left: s.left, right: s.right, bottom: s.bottom });

describe('panelReducer toggle', () => {
  it('flips only the toggled panel', () => {
    expect(visible(panelReducer(initialPanels, { type: 'toggle', panel: 'left' }))).toEqual({ left: false, right: true, bottom: false });
    expect(visible(panelReducer(initialPanels, { type: 'toggle', panel: 'right' }))).toEqual({ left: true, right: false, bottom: false });
    expect(visible(panelReducer(initialPanels, { type: 'toggle', panel: 'bottom' }))).toEqual({ left: true, right: true, bottom: true });
  });

  it('toggling twice returns to the original visibility', () => {
    const once = panelReducer(initialPanels, { type: 'toggle', panel: 'bottom' });
    expect(visible(panelReducer(once, { type: 'toggle', panel: 'bottom' }))).toEqual(visible(initialPanels));
  });
});

describe('panelReducer focus', () => {
  it('hides every panel and enters focus', () => {
    const s = panelReducer(initialPanels, { type: 'focus' });
    expect(s.focus).toBe(true);
    expect(visible(s)).toEqual({ left: false, right: false, bottom: false });
  });

  it('restores exactly the previous visibility when focus is left, including an open bottom panel', () => {
    const start = state({ left: false, right: true, bottom: true });
    const restored = panelReducer(panelReducer(start, { type: 'focus' }), { type: 'focus' });
    expect(restored.focus).toBe(false);
    expect(visible(restored)).toEqual({ left: false, right: true, bottom: true });
    expect(restored.before).toBeNull();
  });

  it('does not carry a stale snapshot into the next focus session', () => {
    const first = panelReducer(state({ bottom: true }), { type: 'focus' });
    const open = panelReducer(first, { type: 'focus' });
    const changed = panelReducer(open, { type: 'toggle', panel: 'bottom' });
    const again = panelReducer(panelReducer(changed, { type: 'focus' }), { type: 'focus' });
    expect(visible(again)).toEqual({ left: true, right: true, bottom: false });
  });

  it('keeps tabs unchanged across focus', () => {
    const start = state({ leftTab: 'files', rightTab: 'details' });
    const s = panelReducer(panelReducer(start, { type: 'focus' }), { type: 'focus' });
    expect([s.leftTab, s.rightTab]).toEqual(['files', 'details']);
  });
});

describe('panelReducer leaving focus', () => {
  const inFocus = panelReducer(state({ left: true, right: false, bottom: true }), { type: 'focus' });

  it('toggling a panel in focus restores the others and flips the toggled one', () => {
    const s = panelReducer(inFocus, { type: 'toggle', panel: 'left' });
    expect(s.focus).toBe(false);
    expect(visible(s)).toEqual({ left: false, right: false, bottom: true });
    expect(s.before).toBeNull();
  });

  it('choosing a left tab in focus restores the others and shows left on that tab', () => {
    const s = panelReducer(inFocus, { type: 'left-tab', tab: 'files' });
    expect(s).toMatchObject({ focus: false, left: true, right: false, bottom: true, leftTab: 'files' });
  });

  it('choosing a right tab in focus restores the others and shows right on that tab', () => {
    const s = panelReducer(inFocus, { type: 'right-tab', tab: 'details' });
    expect(s).toMatchObject({ focus: false, left: true, right: true, bottom: true, rightTab: 'details' });
  });

  it('a left tab outside focus changes nothing but the tab and left visibility', () => {
    const s = panelReducer(state({ left: false, bottom: true }), { type: 'left-tab', tab: 'plan' });
    expect(s).toMatchObject({ left: true, right: true, bottom: true, leftTab: 'plan', focus: false });
  });
});

describe('panelReducer reveal events', () => {
  it('plan-shown opens the left panel on the plan tab', () => {
    const s = panelReducer(state({ left: false, leftTab: 'files' }), { type: 'plan-shown' });
    expect(s).toMatchObject({ left: true, leftTab: 'plan' });
  });

  it('plan-shown leaves focus and restores the other panels', () => {
    const s = panelReducer(panelReducer(state({ bottom: true }), { type: 'focus' }), { type: 'plan-shown' });
    expect(s).toMatchObject({ focus: false, left: true, right: true, bottom: true, leftTab: 'plan' });
  });

  it('node-selected opens the right panel on details', () => {
    const s = panelReducer(state({ right: false, rightTab: 'agent' }), { type: 'node-selected' });
    expect(s).toMatchObject({ right: true, rightTab: 'details' });
  });

  it('node-selected leaves focus', () => {
    const s = panelReducer(panelReducer(initialPanels, { type: 'focus' }), { type: 'node-selected' });
    expect(s).toMatchObject({ focus: false, right: true, left: true, rightTab: 'details' });
  });

  it('attention opens the right panel on agent', () => {
    const s = panelReducer(state({ right: false, rightTab: 'details' }), { type: 'attention' });
    expect(s).toMatchObject({ right: true, rightTab: 'agent' });
  });

  it('attention leaves focus and restores the other panels', () => {
    const s = panelReducer(panelReducer(state({ bottom: true }), { type: 'focus' }), { type: 'attention' });
    expect(s).toMatchObject({ focus: false, left: true, right: true, bottom: true, rightTab: 'agent' });
  });
});

describe('panelReducer selection-cleared', () => {
  it('switches the details tab back to agent without touching visibility', () => {
    const start = state({ rightTab: 'details', right: false, bottom: true });
    expect(panelReducer(start, { type: 'selection-cleared' })).toEqual({ ...start, rightTab: 'agent' });
  });

  it('does nothing on the agent tab', () => {
    const start = state({ rightTab: 'agent', right: false });
    expect(panelReducer(start, { type: 'selection-cleared' })).toBe(start);
  });

  it('does not leave focus', () => {
    const focused = panelReducer(state({ rightTab: 'details' }), { type: 'focus' });
    const s = panelReducer(focused, { type: 'selection-cleared' });
    expect(s.focus).toBe(true);
    expect(s.before).toEqual(focused.before);
    expect(s.rightTab).toBe('agent');
  });
});

describe('loadPanels', () => {
  const reading = (value: string | null | undefined) => ({ getItem: () => value as string | null });

  it('returns defaults without storage', () => {
    expect(loadPanels(undefined)).toEqual(initialPanels);
  });

  it('returns defaults when the key is missing', () => {
    expect(loadPanels(reading(null))).toEqual(initialPanels);
  });

  it('returns defaults for corrupt JSON', () => {
    expect(loadPanels(reading('{nope'))).toEqual(initialPanels);
  });

  it('returns defaults for a JSON null or non-object', () => {
    expect(loadPanels(reading('null'))).toEqual(initialPanels);
    expect(loadPanels(reading('7'))).toEqual(initialPanels);
  });

  it('returns defaults when getItem throws', () => {
    expect(loadPanels({ getItem: () => { throw new Error('blocked'); } })).toEqual(initialPanels);
  });

  it('restores stored visibility', () => {
    expect(loadPanels(reading('{"left":false,"right":false,"bottom":true}'))).toEqual({ ...initialPanels, left: false, right: false, bottom: true });
  });

  it('falls back field by field when a field has the wrong type or is absent', () => {
    expect(loadPanels(reading('{"left":"no","right":false}'))).toEqual({ ...initialPanels, left: true, right: false, bottom: false });
    expect(loadPanels(reading('{"bottom":true,"left":0}'))).toEqual({ ...initialPanels, left: true, right: true, bottom: true });
  });

  it('never restores focus or a snapshot from storage', () => {
    const s = loadPanels(reading('{"left":false,"focus":true,"before":{"left":false}}'));
    expect(s.focus).toBe(false);
    expect(s.before).toBeNull();
  });
});

describe('savePanels', () => {
  const recording = () => {
    const writes: [string, string][] = [];
    return { writes, storage: { setItem: (k: string, v: string) => void writes.push([k, v]) } };
  };

  it('persists the three visibility flags under ide.panels', () => {
    const { writes, storage } = recording();
    savePanels(storage, state({ left: false, right: true, bottom: true, leftTab: 'files' }));
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe('ide.panels');
    expect(JSON.parse(writes[0]![1])).toEqual({ left: false, right: true, bottom: true });
  });

  it('persists the visibility from before focus while in focus', () => {
    const { writes, storage } = recording();
    const focused = panelReducer(state({ left: false, right: true, bottom: true }), { type: 'focus' });
    savePanels(storage, focused);
    expect(JSON.parse(writes[0]![1])).toEqual({ left: false, right: true, bottom: true });
  });

  it('round-trips through loadPanels', () => {
    const store = new Map<string, string>();
    const storage = { setItem: (k: string, v: string) => void store.set(k, v), getItem: (k: string) => store.get(k) ?? null };
    savePanels(storage, state({ left: false, bottom: true }));
    expect(loadPanels(storage)).toMatchObject({ left: false, right: true, bottom: true });
  });

  it('swallows a throwing storage and accepts no storage', () => {
    expect(() => savePanels({ setItem: () => { throw new Error('quota'); } }, initialPanels)).not.toThrow();
    expect(() => savePanels(undefined, initialPanels)).not.toThrow();
  });
});
