import type { PlanStepView, PlanView, RollbackPreview } from '@ide/protocol';
import type { NodeChanges } from './history-state';
import { canSend, runningTasks, type ChatState } from '../chat/chat-state';

export type RollbackStage = 'idle' | 'previewing' | 'confirming' | 'running' | 'done' | 'error';
export interface RollbackState {
  stage: RollbackStage;
  planId: string;
  stepKey: string;
  preview: RollbackPreview | null;
  confirm: ReadonlySet<string>;
  error: string | null;
  requestId: string | null;
}
export type RollbackAction =
  | { type: 'open'; planId: string; stepKey: string; requestId: string }
  | { type: 'preview'; preview: RollbackPreview }
  | { type: 'toggle'; path: string }
  | { type: 'run'; requestId: string }
  | { type: 'result'; error: string | null }
  | { type: 'close' };

export function rollbackReducer(s: RollbackState | null, a: RollbackAction): RollbackState | null {
  switch (a.type) {
    case 'open':
      return { stage: 'previewing', planId: a.planId, stepKey: a.stepKey, preview: null, confirm: new Set(), error: null, requestId: a.requestId };
    case 'close':
      return null;
    case 'preview':
      return s?.stage === 'previewing' ? { ...s, stage: 'confirming', preview: a.preview, confirm: new Set(), requestId: null } : s;
    case 'toggle': {
      if (s?.stage !== 'confirming' || !s.preview?.confirmFiles.includes(a.path)) return s;
      const confirm = new Set(s.confirm);
      if (!confirm.delete(a.path)) confirm.add(a.path);
      return { ...s, confirm };
    }
    case 'run':
      return s?.stage === 'confirming' ? { ...s, stage: 'running', requestId: a.requestId } : s;
    case 'result':
      return s?.stage === 'running' || s?.stage === 'previewing' ? { ...s, stage: a.error === null && s.stage === 'running' ? 'done' : 'error', error: a.error, requestId: null } : s;
  }
}

export const canConfirmRollback = (s: RollbackState): boolean =>
  s.stage === 'confirming' && s.preview !== null && s.preview.allowed && (s.preview.autoFiles.length > 0 || s.preview.confirmFiles.length > 0);

export const canOfferRollback = (chat: ChatState, plan: PlanView | null, step: PlanStepView): boolean =>
  plan !== null && plan.steps.some((s) => s.key === step.key) && canSend(chat) && runningTasks(chat).length === 0;

export const changeLine = (c: NodeChanges): string => `+${c.added} \u2212${c.removed} \u00b7 ${c.files.length} file${c.files.length === 1 ? '' : 's'}`;
