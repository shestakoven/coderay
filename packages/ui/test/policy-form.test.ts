import { describe, expect, it } from 'vitest';
import type { Policy, PolicyView } from '@ide/protocol';
import { policyForm, policyFromForm, withMode } from '../src/settings/policy-form';

const ide: Policy = { mode: 'B', guarded: ['.env*', '.claude/'], harness: ['.omc/'], outsideAllowed: ['~/.claude/plans/'], autoApproveMaxFiles: 3 };
const view = (project: Partial<Policy> = {}): PolicyView => ({
  ide, project, effective: { ...ide, ...project }, hashes: { ide: 'a', project: 'b' }, externalEdits: { ide: false, project: false },
  edited: { ide: null, project: null }, problems: [],
});

describe('policy form', () => {
  it('shows the IDE level with every field set, and the project level with inherited fields marked', () => {
    expect(policyForm(view(), 'ide')).toMatchObject({ mode: 'B', autoApproveMaxFiles: '3', guarded: '.env*\n.claude/', inherit: { mode: false, guarded: false } });
    expect(policyForm(view({ mode: 'A' }), 'project')).toMatchObject({ mode: 'A', inherit: { mode: false, guarded: true, autoApproveMaxFiles: true } });
  });

  it('turns the project form into an override of only the fields it does not inherit, trimming list lines', () => {
    const form = { ...policyForm(view(), 'project'), guarded: ' .env*\n\nsecrets/ ', inherit: { ...policyForm(view(), 'project').inherit, guarded: false } };
    expect(policyFromForm(form)).toEqual({ policy: { guarded: ['.env*', 'secrets/'] } });
  });

  it('refuses a limit outside 0–50', () => {
    expect(policyFromForm({ ...policyForm(view(), 'ide'), autoApproveMaxFiles: '51' })).toEqual({ error: 'The automatic approval limit must be a whole number from 0 to 50.' });
  });

  it('changes only the mode of the project override', () => {
    expect(withMode(view({ guarded: ['x'] }), 'C')).toEqual({ guarded: ['x'], mode: 'C' });
  });
});
