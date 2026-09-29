import { describe, expect, it } from 'vitest';
import type { Policy, PolicyView } from '@ide/protocol';
import { levelKey, policyForm, policyFromForm, withMode } from '../src/settings/policy-form';

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

  it.each(['1.5', '', '-1'])('refuses the limit %j', (value) => {
    expect('error' in policyFromForm({ ...policyForm(view(), 'ide'), autoApproveMaxFiles: value })).toBe(true);
  });

  it('keys a level by its own hash and external-edit flag, so saving one level leaves the other key alone', () => {
    const before = view();
    const ideSaved: PolicyView = { ...before, hashes: { ...before.hashes, ide: 'a2' } };
    expect(levelKey(ideSaved, 'ide')).not.toBe(levelKey(before, 'ide'));
    expect(levelKey(ideSaved, 'project')).toBe(levelKey(before, 'project'));
    expect(levelKey({ ...before, externalEdits: { ide: false, project: true } }, 'project')).not.toBe(levelKey(before, 'project'));
    expect(levelKey({ ...before, externalEdits: { ide: false, project: true } }, 'ide')).toBe(levelKey(before, 'ide'));
  });

  it('changes only the mode of the project override', () => {
    expect(withMode(view({ guarded: ['x'] }), 'C')).toEqual({ guarded: ['x'], mode: 'C' });
  });
});
