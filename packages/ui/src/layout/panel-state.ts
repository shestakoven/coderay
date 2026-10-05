export type LeftTab = 'components' | 'files' | 'details';
export type RightTab = 'agent' | 'plan' | 'review';
export type BottomTab = 'timeline' | 'terminal';

interface Visibility {
  left: boolean;
  right: boolean;
  bottom: boolean;
}

export interface PanelState extends Visibility {
  focus: boolean;
  leftTab: LeftTab;
  rightTab: RightTab;
  bottomTab: BottomTab;
  before: Visibility | null;
}

export type PanelAction =
  | { type: 'toggle'; panel: keyof Visibility }
  | { type: 'focus' }
  | { type: 'left-tab'; tab: LeftTab }
  | { type: 'right-tab'; tab: RightTab }
  | { type: 'bottom-tab'; tab: BottomTab }
  | { type: 'plan-shown' }
  | { type: 'node-selected' }
  | { type: 'selection-cleared' }
  | { type: 'attention' };

export const initialPanels: PanelState = { left: true, right: true, bottom: false, focus: false, leftTab: 'components', rightTab: 'agent', bottomTab: 'timeline', before: null };

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
    case 'bottom-tab':
      return { ...leaveFocus(state), bottom: true, bottomTab: action.tab };
    case 'plan-shown':
      return { ...leaveFocus(state), right: true, rightTab: 'plan' };
    case 'node-selected':
      return { ...leaveFocus(state), left: true, leftTab: 'details' };
    case 'selection-cleared':
      return state.leftTab === 'details' ? { ...state, leftTab: 'components' } : state;
    case 'attention':
      return { ...leaveFocus(state), right: true, rightTab: 'agent' };
  }
}

const STORAGE_KEY = 'ide.panels';
const keyOf = (scope: string | undefined): string => (scope ? `${STORAGE_KEY}.${scope}` : STORAGE_KEY);

// A project without saved layout starts from the last layout any project used.
export function loadPanels(storage: Pick<Storage, 'getItem'> | undefined, scope?: string): PanelState {
  try {
    const raw = storage?.getItem(keyOf(scope)) ?? storage?.getItem(STORAGE_KEY);
    if (!raw) return initialPanels;
    const value = JSON.parse(raw) as Partial<Visibility>;
    const flag = (key: keyof Visibility): boolean => (typeof value[key] === 'boolean' ? value[key] : initialPanels[key]);
    return { ...initialPanels, left: flag('left'), right: flag('right'), bottom: flag('bottom') };
  } catch {
    return initialPanels;
  }
}

export function savePanels(storage: Pick<Storage, 'setItem'> | undefined, state: PanelState, scope?: string): void {
  try {
    const stored = state.focus ? (state.before ?? initialPanels) : state;
    const value = JSON.stringify({ left: stored.left, right: stored.right, bottom: stored.bottom });
    storage?.setItem(keyOf(scope), value);
    if (scope) storage?.setItem(STORAGE_KEY, value);
  } catch {
    // storage can be blocked; the layout then resets on reload
  }
}
