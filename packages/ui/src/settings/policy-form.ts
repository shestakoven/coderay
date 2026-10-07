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

export const MODE_SUMMARY: Record<ControlMode, string> = {
  A: 'The write is denied. If one slips through, the agent pauses and the change is reverted unless you keep it.',
  B: 'The write waits for your answer: allow once, expand the plan, or deny.',
  C: 'The write goes through and the changed node is flagged on the map. The agent keeps going.',
};

export const MODE_WHEN: Record<ControlMode, string> = {
  A: 'Strictest. For unattended runs and code you cannot afford to see change by surprise.',
  B: 'A good default. You decide each time, with the agent\'s reason in front of you.',
  C: 'Quietest. For exploring and scratch work, when you review the flagged nodes afterwards.',
};

export const MODE_TITLE = `When the agent writes outside the approved plan:\n${(['A', 'B', 'C'] as const).map((mode) => `• ${MODE_HINT[mode]}`).join('\n')}`;

export const FIELD_LABEL: Record<keyof Policy, string> = {
  mode: 'Control mode',
  autoApproveMaxFiles: 'Automatic approval',
  guarded: 'Guarded paths',
  harness: 'Harness paths',
  outsideAllowed: 'Allowed outside the project',
};

export const SCOPE_LABEL: Record<PolicyLevel, string> = { ide: 'All projects', project: 'This project' };

const FIELDS: (keyof Policy)[] = ['mode', 'autoApproveMaxFiles', 'guarded', 'harness', 'outsideAllowed'];
const LIST_FIELDS = ['guarded', 'harness', 'outsideAllowed'] as const;
export type ListField = (typeof LIST_FIELDS)[number];

export const lines = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter(Boolean);
export const joinLines = (items: string[]): string => items.join('\n');

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

export function autoApproveError(text: string): string | null {
  const value = Number(text.trim());
  if (text.trim() === '' || !Number.isInteger(value) || value < 0 || value > 50) return 'Use a whole number from 0 to 50.';
  return null;
}

export function policyFromForm(form: PolicyForm): { policy: Partial<Policy> } | { error: string } {
  if (autoApproveError(form.autoApproveMaxFiles)) {
    return { error: 'The automatic approval limit must be a whole number from 0 to 50.' };
  }
  const max = Number(form.autoApproveMaxFiles.trim());
  const full: Policy = {
    mode: form.mode, autoApproveMaxFiles: max, guarded: lines(form.guarded), harness: lines(form.harness), outsideAllowed: lines(form.outsideAllowed),
  };
  if (form.level === 'ide') return { policy: full };
  return { policy: Object.fromEntries(FIELDS.filter((field) => !form.inherit[field]).map((field) => [field, full[field]])) as Partial<Policy> };
}

export const withMode = (view: PolicyView, mode: ControlMode): Partial<Policy> => ({ ...view.project, mode });

export const levelKey = (view: PolicyView, level: PolicyLevel): string => `${view.hashes[level]}|${view.externalEdits[level]}`;

const fieldText = (policy: Policy, field: keyof Policy): string =>
  field === 'guarded' || field === 'harness' || field === 'outsideAllowed' ? joinLines(policy[field]) : String(policy[field]);

// Hands a project field back to the IDE value (the saved one, not an unsaved draft of the IDE level).
export function resetToInherited(form: PolicyForm, view: PolicyView, field: keyof Policy): PolicyForm {
  return { ...form, [field]: fieldText(view.ide, field), inherit: { ...form.inherit, [field]: true } };
}

// Any edit of a project field pins it, so the field stops following the IDE value.
export function editField(form: PolicyForm, field: keyof Policy, value: string): PolicyForm {
  return { ...form, [field]: value, inherit: { ...form.inherit, [field]: false } };
}

export interface PolicyChange {
  level: PolicyLevel;
  field: keyof Policy;
  text: string;
}

const modeText = (mode: ControlMode): string => MODE_LABEL[mode];
const limitText = (text: string): string => (text.trim() === '0' ? 'off' : `up to ${text.trim()} ${text.trim() === '1' ? 'file' : 'files'}`);

function listDelta(before: string, after: string): string {
  const was = lines(before);
  const now = lines(after);
  return [...now.filter((item) => !was.includes(item)).map((item) => `+ ${item}`), ...was.filter((item) => !now.includes(item)).map((item) => `− ${item}`)].join(', ');
}

function valueText(form: PolicyForm, field: keyof Policy): string {
  if (field === 'mode') return modeText(form.mode);
  if (field === 'autoApproveMaxFiles') return limitText(form.autoApproveMaxFiles);
  return lines(form[field]).join(', ');
}

// What saving would change, one readable line per field. Compares the draft with what the core last reported.
export function policyChanges(saved: PolicyForm, draft: PolicyForm): PolicyChange[] {
  const changes: PolicyChange[] = [];
  for (const field of FIELDS) {
    const level = draft.level;
    const label = FIELD_LABEL[field];
    const wasInherited = saved.inherit[field];
    const nowInherited = draft.inherit[field];
    if (wasInherited && nowInherited) continue;
    if (nowInherited) {
      changes.push({ level, field, text: `${label}: follows all projects again` });
      continue;
    }
    if (wasInherited) {
      const isList = field !== 'mode' && field !== 'autoApproveMaxFiles';
      const shown = isList ? listDelta(saved[field as ListField], draft[field as ListField]) || 'same list as all projects' : valueText(draft, field);
      changes.push({ level, field, text: `${label}: ${shown}, set for this project` });
      continue;
    }
    if (field === 'mode') {
      if (saved.mode !== draft.mode) changes.push({ level, field, text: `${label}: ${modeText(saved.mode)} → ${modeText(draft.mode)}` });
    } else if (field === 'autoApproveMaxFiles') {
      if (saved.autoApproveMaxFiles.trim() !== draft.autoApproveMaxFiles.trim()) {
        changes.push({ level, field, text: `${label}: ${limitText(saved.autoApproveMaxFiles)} → ${limitText(draft.autoApproveMaxFiles)}` });
      }
    } else {
      const delta = listDelta(saved[field], draft[field]);
      if (delta !== '') changes.push({ level, field, text: `${label}: ${delta}` });
    }
  }
  return changes;
}
