import { createContext, useContext } from 'react';
import type { GateAnswer, GatePromptView } from '@ide/protocol';
import type { NodeChanges } from '../history/history-state';
import { EMPTY_MARKS, type Marks } from './plan-state';

export interface PlanOverlay {
  marks: Marks;
  dimOthers: boolean;
  focus: { componentIds: string[]; nonce: number } | null;
  prompt: GatePromptView | null;
  prompts: GatePromptView[];
  eventFiles: Set<string>;
  changes: Map<string, NodeChanges>;
  highlight: Set<string>;
  answerPrompt(answer: GateAnswer): void;
  onAnchor(anchored: boolean): void;
}

export const PlanOverlayContext = createContext<PlanOverlay>({
  marks: EMPTY_MARKS,
  dimOthers: false,
  focus: null,
  prompt: null,
  prompts: [],
  eventFiles: new Set(),
  changes: new Map(),
  highlight: new Set(),
  answerPrompt: () => undefined,
  onAnchor: () => undefined,
});

export const usePlanOverlay = (): PlanOverlay => useContext(PlanOverlayContext);

export const PendingCountsContext = createContext<Map<string, number>>(new Map());
