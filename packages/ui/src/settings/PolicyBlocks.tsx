import type { PolicyLevel, PolicyView } from '@ide/protocol';
import { BLOCKS, type BlockId } from './categories';
import { Setting } from './controls';
import { AutoApprove, ModeCards, PathList, Provenance } from './PolicyControls';
import type { PathListField } from './path-rules';
import type { PolicyDrafts } from './policy-drafts';
import { editField, resetToInherited, type PolicyForm } from './policy-form';
import type { Policy } from '@ide/protocol';

const FIELD_OF: Partial<Record<BlockId, keyof Policy>> = {
  mode: 'mode', 'auto-approve': 'autoApproveMaxFiles', guarded: 'guarded', harness: 'harness', 'outside-allowed': 'outsideAllowed',
};

export const POLICY_BLOCKS: BlockId[] = ['mode', 'auto-approve', 'guarded', 'harness', 'outside-allowed'];

export function PolicyBlock({ id, view, drafts, scope, onScope }: {
  id: BlockId;
  view: PolicyView;
  drafts: PolicyDrafts;
  scope: PolicyLevel;
  onScope: (scope: PolicyLevel) => void;
}) {
  const field = FIELD_OF[id]!;
  const block = BLOCKS.find((candidate) => candidate.id === id)!;
  const form = drafts.forms[scope];
  const set = (value: string): void => drafts.edit(scope, editField(form, field, value));
  const pinned = scope === 'project' && !form.inherit[field];
  const inherited = scope === 'project' && form.inherit[field];
  const overriddenHere = scope === 'ide' && !drafts.baseline.project.inherit[field];
  const aside = (
    <Provenance
      scope={scope}
      pinned={pinned}
      overriddenHere={overriddenHere}
      onReset={() => drafts.edit('project', resetToInherited(drafts.forms.project, view, field))}
      onShowProject={() => onScope('project')}
    />
  );
  return (
    <Setting id={id} title={block.title} help={block.help} aside={aside} wide>
      <div className={inherited ? 'sw-inherited' : undefined}>{control(id, form, set)}</div>
    </Setting>
  );
}

function control(id: BlockId, form: PolicyForm, set: (value: string) => void) {
  if (id === 'mode') return <ModeCards value={form.mode} onChange={set} />;
  if (id === 'auto-approve') return <AutoApprove value={form.autoApproveMaxFiles} onChange={set} />;
  const field = FIELD_OF[id] as PathListField;
  return <PathList field={field} text={form[field]} onChange={set} />;
}
