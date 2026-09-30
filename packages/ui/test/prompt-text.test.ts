import { describe, expect, it } from 'vitest';
import type { GatePromptView, GateTarget } from '@ide/protocol';
import { mapAnchor, prefixed, promptHint, promptTarget } from '../src/plan/prompt-text';

const prompt = (targets: GateTarget[], tool = 'Edit'): GatePromptView => ({
  id: 'g1', toolUseId: 't1', parentToolUseId: null, tool, summary: 'src/x.ts', preview: { kind: 'input', text: '{}', truncated: false },
  reason: null, targets, canExpand: true, planId: 'p', mode: 'B', status: 'pending', answer: null, ts: 1,
});
const target = (path: string, overrides: Partial<GateTarget> = {}): GateTarget => ({ path, kind: 'enforced', inScope: false, deleting: false, componentId: 'app', ...overrides });

describe('prompt text', () => {
  it('names the first target outside the plan', () => {
    expect(promptTarget(prompt([target('src/a.ts', { inScope: true }), target('src/b.ts')]))?.path).toBe('src/b.ts');
  });

  it('explains why the call waits', () => {
    expect([
      promptHint(prompt([target('src/b.ts')])),
      promptHint(prompt([target('/etc/hosts', { kind: 'outside', componentId: null })])),
      promptHint(prompt([target('src/c.ts', { inScope: true }), target('$OUT', { kind: 'unresolved', componentId: null })])),
      promptHint(prompt([], 'BrandNewTool')),
    ]).toEqual([
      'src/b.ts is not in the approved plan. The call waits for your answer.',
      '/etc/hosts is outside the project. The call waits for your answer.',
      '$OUT cannot be known before the call runs. The call waits for your answer.',
      'The IDE does not know the tool BrandNewTool. The call waits for your answer.',
    ]);
  });

  it('prefixes lines, cuts long text and ignores a final newline', () => {
    expect([prefixed('+ ', 'a\nb\nc', 2), prefixed('+ ', 'a\n')]).toEqual(['+ a\n+ b\n+ … 1 more line', '+ a']);
  });

  it('anchors a prompt at the target file when it is visible, else at its component, else nowhere', () => {
    const view = prompt([target('src/b.ts')]);
    expect([
      mapAnchor(view, new Set(['app', 'src/b.ts'])),
      mapAnchor(view, new Set(['app'])),
      mapAnchor(prompt([target('/etc/hosts', { kind: 'outside', componentId: null })]), new Set(['app'])),
    ]).toEqual(['src/b.ts', 'app', null]);
  });
});
