import { describe, expect, it } from 'vitest';
import { initialPanels, loadPanels, panelReducer, savePanels, type PanelState } from '../src/layout/panel-state';

const state = (overrides: Partial<PanelState> = {}): PanelState => ({ ...initialPanels, ...overrides });

describe('panelReducer bottom-tab', () => {
  it('starts on the timeline tab with the bottom panel hidden', () => {
    expect(initialPanels.bottomTab).toBe('timeline');
    expect(initialPanels.bottom).toBe(false);
  });

  it('opens the bottom panel on the chosen tab', () => {
    const next = panelReducer(initialPanels, { type: 'bottom-tab', tab: 'terminal' });
    expect(next.bottom).toBe(true);
    expect(next.bottomTab).toBe('terminal');
  });

  it('switches the tab while the panel is already open, keeping it open', () => {
    const next = panelReducer(state({ bottom: true, bottomTab: 'terminal' }), { type: 'bottom-tab', tab: 'timeline' });
    expect(next.bottom).toBe(true);
    expect(next.bottomTab).toBe('timeline');
  });

  it('leaves the left and right panels and their tabs untouched', () => {
    const before = state({ left: false, right: true, leftTab: 'files', rightTab: 'plan' });
    const next = panelReducer(before, { type: 'bottom-tab', tab: 'terminal' });
    expect(next).toMatchObject({ left: false, right: true, leftTab: 'files', rightTab: 'plan' });
  });

  it('does not change the other tabs when they differ from the defaults', () => {
    const next = panelReducer(state({ leftTab: 'details', rightTab: 'plan' }), { type: 'bottom-tab', tab: 'terminal' });
    expect(next.leftTab).toBe('details');
    expect(next.rightTab).toBe('plan');
  });

  it('leaves focus mode and restores the panels hidden by it, with the bottom open on the tab', () => {
    const focused = panelReducer(state({ left: true, right: false, bottom: false }), { type: 'focus' });
    expect(focused.focus).toBe(true);
    const next = panelReducer(focused, { type: 'bottom-tab', tab: 'terminal' });
    expect(next).toMatchObject({ focus: false, before: null, left: true, right: false, bottom: true, bottomTab: 'terminal' });
  });

  it('restores a previously open bottom panel when leaving focus', () => {
    const focused = panelReducer(state({ bottom: true, bottomTab: 'timeline' }), { type: 'focus' });
    const next = panelReducer(focused, { type: 'bottom-tab', tab: 'terminal' });
    expect(next).toMatchObject({ focus: false, left: true, right: true, bottom: true, bottomTab: 'terminal' });
  });

  it('does not mutate the previous state', () => {
    const before = state();
    const copy = { ...before };
    panelReducer(before, { type: 'bottom-tab', tab: 'terminal' });
    expect(before).toEqual(copy);
  });

  it('keeps the chosen tab when the panel is toggled closed and open again', () => {
    let next = panelReducer(initialPanels, { type: 'bottom-tab', tab: 'terminal' });
    next = panelReducer(next, { type: 'toggle', panel: 'bottom' });
    expect(next.bottom).toBe(false);
    next = panelReducer(next, { type: 'toggle', panel: 'bottom' });
    expect(next).toMatchObject({ bottom: true, bottomTab: 'terminal' });
  });
});

describe('bottom tab and storage', () => {
  it('is not persisted: only the three visibility flags are saved', () => {
    const saved: string[] = [];
    savePanels({ setItem: (_k, v) => saved.push(v) }, state({ bottom: true, bottomTab: 'terminal' }));
    expect(JSON.parse(saved[0]!)).toEqual({ left: true, right: true, bottom: true });
  });

  it('loads with the default tab even when the bottom panel was stored open', () => {
    const loaded = loadPanels({ getItem: () => JSON.stringify({ left: true, right: true, bottom: true }) });
    expect(loaded).toMatchObject({ bottom: true, bottomTab: 'timeline' });
  });
});
