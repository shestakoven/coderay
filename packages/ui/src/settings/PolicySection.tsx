import { useEffect, useRef, useState } from 'react';
import type { ControlMode, Policy, PolicyHashes, PolicyLevel, PolicyView } from '@ide/protocol';
import { MODE_HINT, MODE_LABEL, levelKey, policyForm, policyFromForm, type PolicyForm } from './policy-form';

const LEVELS: { level: PolicyLevel; title: string }[] = [
  { level: 'ide', title: 'IDE level — every project (~/.ide/policy.json)' },
  { level: 'project', title: 'This project — on this machine only' },
];

const LISTS: { field: 'guarded' | 'harness' | 'outsideAllowed'; label: string }[] = [
  { field: 'guarded', label: 'Guarded paths: always enforced, even when gitignored (gitignore syntax)' },
  { field: 'harness', label: 'Harness paths: plugin state, recorded only (gitignore syntax)' },
  { field: 'outsideAllowed', label: 'Allowed outside the project: never out of plan (absolute or ~/)' },
];

export function PolicySection({ view, busy, onSave, onConfirm }: {
  view: PolicyView;
  busy: boolean;
  onSave: (level: PolicyLevel, policy: Partial<Policy>) => void;
  onConfirm: (hashes: PolicyHashes) => void;
}) {
  const [forms, setForms] = useState(() => ({ ide: policyForm(view, 'ide'), project: policyForm(view, 'project') }));
  const [error, setError] = useState<string | null>(null);
  const keys = useRef({ ide: levelKey(view, 'ide'), project: levelKey(view, 'project') });
  const ideKey = levelKey(view, 'ide');
  const projectKey = levelKey(view, 'project');
  useEffect(() => {
    if (keys.current.ide === ideKey) return;
    keys.current.ide = ideKey;
    setForms((f) => ({ ...f, ide: policyForm(view, 'ide') }));
  }, [ideKey, view]);
  useEffect(() => {
    if (keys.current.project === projectKey) return;
    keys.current.project = projectKey;
    setForms((f) => ({ ...f, project: policyForm(view, 'project') }));
  }, [projectKey, view]);
  const update = (level: PolicyLevel, change: Partial<PolicyForm>) => setForms((f) => ({ ...f, [level]: { ...f[level], ...change } }));
  const save = (level: PolicyLevel) => {
    const result = policyFromForm(forms[level]);
    if ('error' in result) setError(result.error);
    else {
      setError(null);
      onSave(level, result.policy);
    }
  };
  const inheritBox = (level: PolicyLevel, field: keyof Policy) =>
    level === 'project' && (
      <label className="inherit">
        <input type="checkbox" checked={forms.project.inherit[field]} onChange={(event) => update('project', { inherit: { ...forms.project.inherit, [field]: event.target.checked } })} />
        use the IDE value
      </label>
    );
  return (
    <section className="policy">
      <h3>Policy — applies to the next tool call, no restart needed</h3>
      {(view.externalEdits.ide || view.externalEdits.project) && (
        <div className="banner warn">
          <div>
            A policy file changed outside Settings and is ignored until you confirm it: the IDE level falls back to the defaults, the project level to the IDE level. The file now says:
            {view.edited.ide !== null && <pre className="entry">IDE level: {view.edited.ide}</pre>}
            {view.edited.project !== null && <pre className="entry">This project: {view.edited.project}</pre>}
          </div>
          <button disabled={busy} onClick={() => onConfirm(view.hashes)}>Confirm the edits</button>
        </div>
      )}
      {view.problems.map((problem) => <p key={problem} className="problem">{problem}</p>)}
      <div className="policy-levels">
        {LEVELS.map(({ level, title }) => {
          const form = forms[level];
          const off = (field: keyof Policy) => level === 'project' && form.inherit[field];
          return (
            <div key={level} className="policy-level">
              <h4>{title}</h4>
              <label>
                When the agent writes outside the approved plan {inheritBox(level, 'mode')}
                <select disabled={off('mode')} value={form.mode} onChange={(event) => update(level, { mode: event.target.value as ControlMode })}>
                  {(['A', 'B', 'C'] as const).map((mode) => <option key={mode} value={mode}>{MODE_LABEL[mode]}</option>)}
                </select>
                <span className="muted">{MODE_HINT[form.mode]}</span>
              </label>
              <label>
                Approve plans automatically up to this many files (0 = never) {inheritBox(level, 'autoApproveMaxFiles')}
                <input disabled={off('autoApproveMaxFiles')} value={form.autoApproveMaxFiles} onChange={(event) => update(level, { autoApproveMaxFiles: event.target.value })} />
              </label>
              {LISTS.map(({ field, label }) => (
                <label key={field}>
                  {label} {inheritBox(level, field)}
                  <textarea rows={3} disabled={off(field)} value={form[field]} onChange={(event) => update(level, { [field]: event.target.value })} />
                </label>
              ))}
              <button disabled={busy} onClick={() => save(level)}>Save {level === 'ide' ? 'IDE policy' : 'project policy'}</button>
            </div>
          );
        })}
      </div>
      {error && <p className="problem">{error}</p>}
    </section>
  );
}
