import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PolicyLevel, PolicyView } from '@ide/protocol';
import { levelKey, policyChanges, policyForm, type PolicyChange, type PolicyForm } from './policy-form';

type Drafts = Record<PolicyLevel, PolicyForm | null>;
const CLEAN: Drafts = { ide: null, project: null };

export interface PolicyDrafts {
  forms: Record<PolicyLevel, PolicyForm>;
  baseline: Record<PolicyLevel, PolicyForm>;
  changes: PolicyChange[];
  dirtyLevels: PolicyLevel[];
  edit: (level: PolicyLevel, next: PolicyForm) => void;
  discard: () => void;
}

// Unsaved edits live here, above the pages, so switching category never loses them.
export function usePolicyDrafts(view: PolicyView | null): PolicyDrafts | null {
  const baseline = useMemo(() => (view ? { ide: policyForm(view, 'ide'), project: policyForm(view, 'project') } : null), [view]);
  const [drafts, setDrafts] = useState<Drafts>(CLEAN);
  const ideKey = view ? levelKey(view, 'ide') : '';
  const projectKey = view ? levelKey(view, 'project') : '';
  useEffect(() => setDrafts((current) => (current.ide ? { ...current, ide: null } : current)), [ideKey]);
  useEffect(() => setDrafts((current) => (current.project ? { ...current, project: null } : current)), [projectKey]);
  const edit = useCallback((level: PolicyLevel, next: PolicyForm) => setDrafts((current) => ({ ...current, [level]: next })), []);
  const discard = useCallback(() => setDrafts(CLEAN), []);
  return useMemo(() => {
    if (!baseline) return null;
    const forms = { ide: drafts.ide ?? baseline.ide, project: drafts.project ?? baseline.project };
    const changes = [...policyChanges(baseline.ide, forms.ide), ...policyChanges(baseline.project, forms.project)];
    const dirtyLevels = (['ide', 'project'] as const).filter((level) => changes.some((change) => change.level === level));
    return { forms, baseline, changes, dirtyLevels, edit, discard };
  }, [baseline, drafts, edit, discard]);
}
