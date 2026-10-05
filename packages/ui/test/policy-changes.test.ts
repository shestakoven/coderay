import { describe, expect, it } from 'vitest';
import type { ControlMode, Policy, PolicyView } from '@ide/protocol';
import {
  MODE_HINT, MODE_LABEL, MODE_SUMMARY, MODE_WHEN, SCOPE_LABEL, autoApproveError, editField, joinLines, lines, policyChanges, policyForm,
  policyFromForm, resetToInherited, type PolicyForm,
} from '../src/settings/policy-form';

const ide: Policy = { mode: 'B', guarded: ['.env*', '.claude/'], harness: ['.omc/'], outsideAllowed: ['~/.claude/plans/'], autoApproveMaxFiles: 3 };
const view = (project: Partial<Policy> = {}): PolicyView => ({
  ide, project, effective: { ...ide, ...project }, hashes: { ide: 'a', project: 'b' }, externalEdits: { ide: false, project: false },
  edited: { ide: null, project: null }, problems: [],
});
const projectForm = (project: Partial<Policy> = {}): PolicyForm => policyForm(view(project), 'project');
const ideForm = (): PolicyForm => policyForm(view(), 'ide');
const pinned = (form: PolicyForm, field: keyof Policy, value: string): PolicyForm => ({ ...form, [field]: value, inherit: { ...form.inherit, [field]: false } });
const inherited = (form: PolicyForm, field: keyof Policy): PolicyForm => ({ ...form, inherit: { ...form.inherit, [field]: true } });
const texts = (saved: PolicyForm, draft: PolicyForm): string[] => policyChanges(saved, draft).map((change) => change.text);
const ALL_PINNED: Partial<Policy> = { mode: 'A', autoApproveMaxFiles: 9, guarded: ['x'], harness: ['h'], outsideAllowed: ['/o'] };

describe('autoApproveError', () => {
  it.each(['0', '50', ' 7 ', '3', '1', '49'])('accepts %j', (text) => {
    expect(autoApproveError(text)).toBeNull();
  });

  it.each(['', '  ', 'abc', '-1', '51', '2.5', '100', '3 files'])('explains that %j is not a limit', (text) => {
    expect(autoApproveError(text)).toBe('Use a whole number from 0 to 50.');
  });

  it.each(['abc', '  ', '-1'])('keeps the form from saving the limit %j', (text) => {
    expect(policyFromForm({ ...ideForm(), autoApproveMaxFiles: text })).toEqual({ error: 'The automatic approval limit must be a whole number from 0 to 50.' });
  });

  it('saves the boundary limits', () => {
    expect(policyFromForm({ ...ideForm(), autoApproveMaxFiles: '0' })).toMatchObject({ policy: { autoApproveMaxFiles: 0 } });
    expect(policyFromForm({ ...ideForm(), autoApproveMaxFiles: ' 50 ' })).toMatchObject({ policy: { autoApproveMaxFiles: 50 } });
  });
});

describe('lines and joinLines', () => {
  it('trims every line and drops the blank ones', () => {
    expect(lines('  a \n\n b\r\n   \n\tc\t')).toEqual(['a', 'b', 'c']);
  });

  it('reads an empty text as no lines', () => {
    expect(lines('')).toEqual([]);
    expect(lines('\n \n')).toEqual([]);
  });

  it('joins items one per line', () => {
    expect(joinLines(['a', 'b c', 'd'])).toBe('a\nb c\nd');
    expect(joinLines([])).toBe('');
  });

  it('round-trips a clean list', () => {
    expect(lines(joinLines(['.env*', 'secrets/**']))).toEqual(['.env*', 'secrets/**']);
  });
});

describe('editField', () => {
  it('sets the value and pins only that field, in a new form', () => {
    const form = projectForm();
    const before = structuredClone(form);
    const next = editField(form, 'guarded', 'secrets/**');
    expect(next).toEqual({ ...before, guarded: 'secrets/**', inherit: { ...before.inherit, guarded: false } });
    expect(form).toEqual(before);
    expect(next).not.toBe(form);
    expect(next.inherit).not.toBe(form.inherit);
  });

  it('pins the mode with the new letter', () => {
    const next = editField(projectForm(), 'mode', 'C');
    expect(next.mode).toBe('C');
    expect(next.inherit).toEqual({ mode: false, autoApproveMaxFiles: true, guarded: true, harness: true, outsideAllowed: true });
  });

  it('keeps an already pinned field pinned', () => {
    const next = editField(projectForm({ autoApproveMaxFiles: 5 }), 'autoApproveMaxFiles', '7');
    expect(next).toMatchObject({ autoApproveMaxFiles: '7', inherit: { autoApproveMaxFiles: false } });
  });
});

describe('resetToInherited', () => {
  it.each([
    ['mode', 'B'],
    ['autoApproveMaxFiles', '3'],
    ['guarded', '.env*\n.claude/'],
    ['harness', '.omc/'],
    ['outsideAllowed', '~/.claude/plans/'],
  ] as const)('hands %s back to the all-projects value %j', (field, ideText) => {
    const form = projectForm(ALL_PINNED);
    const before = structuredClone(form);
    const next = resetToInherited(form, view(ALL_PINNED), field);
    expect(next).toEqual({ ...before, [field]: ideText, inherit: { ...before.inherit, [field]: true } });
    expect(form).toEqual(before);
  });

  it('replaces an unsaved project value with the saved all-projects one', () => {
    const draft = editField(projectForm(ALL_PINNED), 'guarded', 'unsaved/**');
    expect(resetToInherited(draft, view(ALL_PINNED), 'guarded')).toMatchObject({ guarded: '.env*\n.claude/', inherit: { guarded: true } });
  });

  it('takes the value from the all-projects level of the view, not from a form', () => {
    const changedIde: PolicyView = { ...view(ALL_PINNED), ide: { ...ide, mode: 'C', autoApproveMaxFiles: 0 } };
    const form = projectForm(ALL_PINNED);
    expect(resetToInherited(form, changedIde, 'mode').mode).toBe('C');
    expect(resetToInherited(form, changedIde, 'autoApproveMaxFiles').autoApproveMaxFiles).toBe('0');
  });
});

describe('policyChanges', () => {
  it('reports nothing for an untouched draft', () => {
    expect(policyChanges(projectForm(), projectForm())).toEqual([]);
    expect(policyChanges(projectForm(ALL_PINNED), projectForm(ALL_PINNED))).toEqual([]);
    expect(policyChanges(ideForm(), ideForm())).toEqual([]);
  });

  it('ignores the text of a field that stays inherited', () => {
    const saved = projectForm();
    const draft = { ...saved, mode: 'C' as ControlMode, autoApproveMaxFiles: '40', guarded: 'other/**', harness: '', outsideAllowed: '/x' };
    expect(policyChanges(saved, draft)).toEqual([]);
  });

  it.each([
    ['mode', 'Control mode'],
    ['autoApproveMaxFiles', 'Automatic approval'],
    ['guarded', 'Guarded paths'],
    ['harness', 'Harness paths'],
    ['outsideAllowed', 'Allowed outside the project'],
  ] as const)('says %s follows all projects again once the draft inherits it', (field, label) => {
    const saved = projectForm(ALL_PINNED);
    expect(policyChanges(saved, inherited(saved, field))).toEqual([{ level: 'project', field, text: `${label}: follows all projects again` }]);
  });

  it('reports a field going back to inherited even when its text did not change', () => {
    const saved = projectForm({ mode: 'B' });
    expect(texts(saved, inherited(saved, 'mode'))).toEqual(['Control mode: follows all projects again']);
  });

  describe('a field pinned for the first time', () => {
    it.each([
      ['A', 'Control mode: Block, set for this project'],
      ['B', 'Control mode: Ask me, set for this project'],
      ['C', 'Control mode: Allow and flag, set for this project'],
    ] as const)('names the mode %s even when it equals the inherited one', (mode, text) => {
      expect(texts(projectForm(), pinned(projectForm(), 'mode', mode))).toEqual([text]);
    });

    it.each([
      ['0', 'Automatic approval: off, set for this project'],
      [' 0 ', 'Automatic approval: off, set for this project'],
      ['7', 'Automatic approval: up to 7 files, set for this project'],
      [' 12 ', 'Automatic approval: up to 12 files, set for this project'],
      ['3', 'Automatic approval: up to 3 files, set for this project'],
    ])('describes the limit %j', (limit, text) => {
      expect(texts(projectForm(), pinned(projectForm(), 'autoApproveMaxFiles', limit))).toEqual([text]);
    });

    it.each([
      ['guarded', '.env*\n.claude/\nsecrets/', 'Guarded paths: + secrets/, set for this project'],
      ['guarded', 'secrets/\n.env*', 'Guarded paths: + secrets/, − .claude/, set for this project'],
      ['guarded', '', 'Guarded paths: − .env*, − .claude/, set for this project'],
      ['harness', '.omc/\n.cache/', 'Harness paths: + .cache/, set for this project'],
      ['outsideAllowed', '~/notes/', 'Allowed outside the project: + ~/notes/, − ~/.claude/plans/, set for this project'],
    ] as const)('shows only the delta of %s against the inherited list', (field, text, expected) => {
      expect(texts(projectForm(), pinned(projectForm(), field, text))).toEqual([expected]);
    });

    it.each(['', '\n  \n'])('says an empty pinned list %j over an empty inherited one is the same list as all projects', (text) => {
      const emptyHarness: PolicyView = { ...view(), ide: { ...ide, harness: [] }, effective: { ...ide, harness: [] } };
      const saved = policyForm(emptyHarness, 'project');
      expect(saved).toMatchObject({ harness: '', inherit: { harness: true } });
      expect(texts(saved, pinned(saved, 'harness', text))).toEqual(['Harness paths: same list as all projects, set for this project']);
    });

    it('lists only removals when a pinned draft empties the inherited list', () => {
      expect(texts(projectForm(), pinned(projectForm(), 'harness', ''))).toEqual(['Harness paths: − .omc/, set for this project']);
      expect(texts(projectForm(), pinned(projectForm(), 'guarded', '  \n'))).toEqual(['Guarded paths: − .env*, − .claude/, set for this project']);
    });

    it.each(['.claude/\n.env*', ' .env* \n\n.claude/ '])('says a pinned list %j is the same list as all projects', (text) => {
      expect(texts(projectForm(), pinned(projectForm(), 'guarded', text))).toEqual(['Guarded paths: same list as all projects, set for this project']);
    });
  });

  describe('a field pinned before and after', () => {
    it.each([
      ['B', 'A', 'Control mode: Ask me → Block'],
      ['A', 'C', 'Control mode: Block → Allow and flag'],
      ['C', 'B', 'Control mode: Allow and flag → Ask me'],
    ] as const)('shows the mode going from %s to %s', (from, to, text) => {
      expect(texts(projectForm({ mode: from }), pinned(projectForm({ mode: from }), 'mode', to))).toEqual([text]);
    });

    it('reports no change when the mode is set to the same value again', () => {
      expect(policyChanges(projectForm({ mode: 'A' }), pinned(projectForm({ mode: 'A' }), 'mode', 'A'))).toEqual([]);
    });

    it.each([
      [3, '0', 'Automatic approval: up to 3 files → off'],
      [0, '5', 'Automatic approval: off → up to 5 files'],
      [3, ' 12 ', 'Automatic approval: up to 3 files → up to 12 files'],
      [3, '4', 'Automatic approval: up to 3 files → up to 4 files'],
    ])('shows the limit going from %i to %j', (from, to, text) => {
      const saved = projectForm({ autoApproveMaxFiles: from });
      expect(texts(saved, pinned(saved, 'autoApproveMaxFiles', to))).toEqual([text]);
    });

    it.each(['3', ' 3 ', '3\n'])('treats the limit %j as unchanged from 3', (text) => {
      const saved = projectForm({ autoApproveMaxFiles: 3 });
      expect(policyChanges(saved, pinned(saved, 'autoApproveMaxFiles', text))).toEqual([]);
    });

    it('lists additions in draft order, then removals in saved order', () => {
      const saved = projectForm({ guarded: ['c', 'x', 'd'] });
      expect(texts(saved, pinned(saved, 'guarded', 'b\nx\na'))).toEqual(['Guarded paths: + b, + a, − c, − d']);
    });

    it('matches the contract example', () => {
      const saved = projectForm({ guarded: ['c'] });
      expect(texts(saved, pinned(saved, 'guarded', 'a\nb'))).toEqual(['Guarded paths: + a, + b, − c']);
    });

    it.each([
      ['b\na', 'reordered'],
      ['a\nb', 'identical'],
      [' a \n\n b \n', 'padded with blanks'],
    ])('reports no change for a list that is only %s (%s)', (text) => {
      const saved = projectForm({ guarded: ['a', 'b'] });
      expect(policyChanges(saved, pinned(saved, 'guarded', text))).toEqual([]);
    });

    it('reads the saved list line by line too, ignoring its padding and blank lines', () => {
      const saved = { ...projectForm({ guarded: ['a', 'b'] }), guarded: ' a \n\nb\n' };
      expect(policyChanges(saved, pinned(saved, 'guarded', 'a\nb'))).toEqual([]);
      expect(texts(saved, pinned(saved, 'guarded', 'b\nc'))).toEqual(['Guarded paths: + c, − a']);
    });

    it('labels each list field', () => {
      const saved = projectForm(ALL_PINNED);
      expect(texts(saved, pinned(saved, 'harness', 'h\nh2'))).toEqual(['Harness paths: + h2']);
      expect(texts(saved, pinned(saved, 'outsideAllowed', ''))).toEqual(['Allowed outside the project: − /o']);
    });
  });

  it('treats the all-projects level as pinned everywhere', () => {
    const saved = ideForm();
    const draft = { ...saved, mode: 'A' as ControlMode, autoApproveMaxFiles: '0', harness: '.omc/\n.cache/' };
    expect(policyChanges(saved, draft)).toEqual([
      { level: 'ide', field: 'mode', text: 'Control mode: Ask me → Block' },
      { level: 'ide', field: 'autoApproveMaxFiles', text: 'Automatic approval: up to 3 files → off' },
      { level: 'ide', field: 'harness', text: 'Harness paths: + .cache/' },
    ]);
  });

  it('lists the changes of several fields in field order, whatever order they were edited in', () => {
    const saved = projectForm({ mode: 'B', guarded: ['a'] });
    let draft = pinned(saved, 'outsideAllowed', '~/.claude/plans/\n/tmp/x');
    draft = inherited(draft, 'guarded');
    draft = pinned(draft, 'harness', '');
    draft = pinned(draft, 'autoApproveMaxFiles', '10');
    draft = pinned(draft, 'mode', 'C');
    expect(policyChanges(saved, draft)).toEqual([
      { level: 'project', field: 'mode', text: 'Control mode: Ask me → Allow and flag' },
      { level: 'project', field: 'autoApproveMaxFiles', text: 'Automatic approval: up to 10 files, set for this project' },
      { level: 'project', field: 'guarded', text: 'Guarded paths: follows all projects again' },
      { level: 'project', field: 'harness', text: 'Harness paths: − .omc/, set for this project' },
      { level: 'project', field: 'outsideAllowed', text: 'Allowed outside the project: + /tmp/x, set for this project' },
    ]);
  });

  it('takes the level of each change from the draft', () => {
    const saved = { ...ideForm(), level: 'project' as const };
    expect(policyChanges(saved, { ...ideForm(), mode: 'C' })).toEqual([{ level: 'ide', field: 'mode', text: 'Control mode: Ask me → Allow and flag' }]);
  });
});

describe('mode and scope wording', () => {
  it('names the modes', () => {
    expect(MODE_LABEL).toEqual({ A: 'Block', B: 'Ask me', C: 'Allow and flag' });
  });

  it.each([
    ['MODE_HINT', MODE_HINT],
    ['MODE_SUMMARY', MODE_SUMMARY],
    ['MODE_WHEN', MODE_WHEN],
  ])('gives %s a distinct, non-empty text for every mode', (_, texts) => {
    expect(Object.keys(texts).sort()).toEqual(['A', 'B', 'C']);
    for (const text of Object.values(texts)) expect(text.trim()).not.toBe('');
    expect(new Set(Object.values(texts)).size).toBe(3);
  });

  it('names the scopes', () => {
    expect(SCOPE_LABEL).toEqual({ ide: 'All projects', project: 'This project' });
  });
});
