export type LeftTab = 'plan' | 'components' | 'files';
export type RightTab = 'agent' | 'details';

interface Visibility {
  left: boolean;
  right: boolean;
  bottom: boolean;
}

export interface PanelState extends Visibility {
  focus: boolean;
  leftTab: LeftTab;
  rightTab: RightTab;
  before: Visibility | null;
}

export type PanelAction =
  | { type: 'toggle'; panel: keyof Visibility }
  | { type: 'focus' }
  | { type: 'left-tab'; tab: LeftTab }
  | { type: 'right-tab'; tab: RightTab }
  | { type: 'plan-shown' }
  | { type: 'node-selected' }
  | { type: 'selection-cleared' }
  | { type: 'attention' };

export const initialPanels: PanelState = { left: true, right: true, bottom: false, focus: false, leftTab: 'components', rightTab: 'agent', before: null };

const visibility = ({ left, right, bottom }: PanelState): Visibility => ({ left, right, bottom });

function leaveFocus(state: PanelState): PanelState {
  if (!state.focus) return state;
  return { ...state, ...(state.before ?? { left: true, right: true, bottom: false }), focus: false, before: null };
}

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case 'toggle': {
      const base = leaveFocus(state);
      return { ...base, [action.panel]: !base[action.panel] };
    }
    case 'focus':
      if (state.focus) return leaveFocus(state);
      return { ...state, left: false, right: false, bottom: false, focus: true, before: visibility(state) };
    case 'left-tab':
      return { ...leaveFocus(state), left: true, leftTab: action.tab };
    case 'right-tab':
      return { ...leaveFocus(state), right: true, rightTab: action.tab };
    case 'plan-shown':
      return { ...leaveFocus(state), left: true, leftTab: 'plan' };
    case 'node-selected':
      return { ...leaveFocus(state), right: true, rightTab: 'details' };
    case 'selection-cleared':
      return state.rightTab === 'details' ? { ...state, rightTab: 'agent' } : state;
    case 'attention':
      return { ...leaveFocus(state), right: true, rightTab: 'agent' };
  }
}

const STORAGE_KEY = 'ide.panels';

export function loadPanels(storage: Pick<Storage, 'getItem'> | undefined): PanelState {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return initialPanels;
    const value = JSON.parse(raw) as Partial<Visibility>;
    const flag = (key: keyof Visibility): boolean => (typeof value[key] === 'boolean' ? value[key] : initialPanels[key]);
    return { ...initialPanels, left: flag('left'), right: flag('right'), bottom: flag('bottom') };
  } catch {
    return initialPanels;
  }
}

export function savePanels(storage: Pick<Storage, 'setItem'> | undefined, state: PanelState): void {
  try {
    const stored = state.focus ? (state.before ?? initialPanels) : state;
    storage?.setItem(STORAGE_KEY, JSON.stringify({ left: stored.left, right: stored.right, bottom: stored.bottom }));
  } catch {
    // storage can be blocked; the layout then resets on reload
  }
}
