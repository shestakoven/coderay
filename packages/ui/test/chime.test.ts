import { describe, expect, it } from 'vitest';
import type { PlanView } from '@ide/protocol';
import { chimeKey, finishedWorking } from '../src/plan/chime';

const plan = (status: PlanView['status'], version = 1): PlanView => ({ id: 'p1', version, status }) as PlanView;

describe('chimeKey', () => {
  it('is null without a plan', () => {
    expect(chimeKey(null)).toBeNull();
  });

  it('identifies a proposed plan by id and version, so a new version chimes again', () => {
    expect([chimeKey(plan('proposed')), chimeKey(plan('proposed', 2))]).toEqual(['p1@1', 'p1@2']);
  });

  it.each(['approved', 'rejected', 'changes-requested', 'withdrawn'] as const)('is null once the plan is %s', (status) => {
    expect(chimeKey(plan(status))).toBeNull();
  });
});

describe('finishedWorking', () => {
  const at = (chatId: string | null, busy: boolean) => ({ chatId, busy });

  it('is true when the agent of the same chat goes from busy to idle', () => {
    expect(finishedWorking(at('a', true), at('a', false), false)).toBe(true);
  });

  it('is false when the user stopped the agent', () => {
    expect(finishedWorking(at('a', true), at('a', false), true)).toBe(false);
  });

  it.each([
    ['still busy', at('a', true), at('a', true)],
    ['idle all along', at('a', false), at('a', false)],
    ['starting to work', at('a', false), at('a', true)],
    ['switching from a busy chat to an idle one', at('a', true), at('b', false)],
    ['the first state after loading', null, at('a', false)],
    ['a chat that did not exist yet', at(null, true), at(null, false)],
  ])('is false for %s', (_name, before, after) => {
    expect(finishedWorking(before, after, false)).toBe(false);
  });
});
