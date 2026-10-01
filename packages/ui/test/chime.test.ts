import { describe, expect, it } from 'vitest';
import type { PlanView } from '@ide/protocol';
import { chimeKey } from '../src/plan/chime';

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
