import type { ControlMode, Policy, PolicyLevel, PolicyView } from '@ide/protocol';

export interface PolicyForm {
  level: PolicyLevel;
  mode: ControlMode;
  autoApproveMaxFiles: string;
  guarded: string;
  harness: string;
  outsideAllowed: string;
  inherit: Record<keyof Policy, boolean>;
}

export const MODE_LABEL: Record<ControlMode, string> = { A: 'Block', B: 'Ask me', C: 'Allow and flag' };

export const MODE_HINT: Record<ControlMode, string> = {
  A: 'Block: a write outside the approved plan is denied. If one slips through afterwards, the agent is paused and the change is reverted unless you keep it.',
  B: 'Ask me: a write outside the approved plan waits for your answer (allow once, expand the plan, or deny).',
  C: 'Allow and flag: the write goes through and the changed node is flagged on the map. The agent is not interrupted.',
};

export const MODE_TITLE = `When the agent writes outside the approved plan:\n${(['A', 'B', 'C'] as const).map((mode) => `\u2022 ${MODE_HINT[mode]}`).join('\n')}`;

const FIELDS: (keyof Policy)[] = ['mode', 'autoApproveMaxFiles', 'guarded', 'harness', 'outsideAllowed'];
const lines = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter(Boolean);

export function policyForm(view: PolicyView, level: PolicyLevel): PolicyForm {
  const source = level === 'ide' ? view.ide : view.effective;
  return {
    level,
    mode: source.mode,
    autoApproveMaxFiles: String(source.autoApproveMaxFiles),
    guarded: source.guarded.join('\n'),
    harness: source.harness.join('\n'),
    outsideAllowed: source.outsideAllowed.join('\n'),
    inherit: Object.fromEntries(FIELDS.map((field) => [field, level === 'project' && !Object.hasOwn(view.project, field)])) as Record<keyof Policy, boolean>,
  };
}

export function policyFromForm(form: PolicyForm): { policy: Partial<Policy> } | { error: string } {
  const max = Number(form.autoApproveMaxFiles.trim());
  if (form.autoApproveMaxFiles.trim() === '' || !Number.isInteger(max) || max < 0 || max > 50) {
    return { error: 'The automatic approval limit must be a whole number from 0 to 50.' };
  }
  const full: Policy = {
    mode: form.mode, autoApproveMaxFiles: max, guarded: lines(form.guarded), harness: lines(form.harness), outsideAllowed: lines(form.outsideAllowed),
  };
  if (form.level === 'ide') return { policy: full };
  return { policy: Object.fromEntries(FIELDS.filter((field) => !form.inherit[field]).map((field) => [field, full[field]])) as Partial<Policy> };
}

export const withMode = (view: PolicyView, mode: ControlMode): Partial<Policy> => ({ ...view.project, mode });

export const levelKey = (view: PolicyView, level: PolicyLevel): string => `${view.hashes[level]}|${view.externalEdits[level]}`;
