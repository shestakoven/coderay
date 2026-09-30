import { createContext, useContext } from 'react';
import type { GateAnswer, GatePromptView } from '@ide/protocol';
import { EMPTY_MARKS, type Marks } from './plan-state';

export interface PlanOverlay {
  marks: Marks;
  dimOthers: boolean;
  focus: { componentIds: string[]; nonce: number } | null;
  prompt: GatePromptView | null;
  answerPrompt(answer: GateAnswer): void;
  onAnchor(anchored: boolean): void;
}

export const PlanOverlayContext = createContext<PlanOverlay>({
  marks: EMPTY_MARKS,
  dimOthers: false,
  focus: null,
  prompt: null,
  answerPrompt: () => undefined,
  onAnchor: () => undefined,
});

export const usePlanOverlay = (): PlanOverlay => useContext(PlanOverlayContext);
