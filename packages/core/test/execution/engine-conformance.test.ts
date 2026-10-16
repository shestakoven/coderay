import { describe, expect, it } from 'vitest';
import { fixture, waitFor } from '../helpers';
import { build } from './harness';

describe('Stop on Codex', () => {
  it('withdraws the plan waiting for an answer when the user stops a Codex chat, as claude cancels its call itself', async () => {
    const b = await build({ scenario: fixture('codex/hang.jsonl'), engine: 'codex' });
    await b.send();
    await waitFor(() => b.session.state().turns.some((turn) => turn.startedAt !== null), 'the turn started');
    const plan = b.rt.gate.plans.propose({ goal: 'Rework app', steps: [{ key: 'edit', title: 'Edit', rationale: '', targets: [{ componentId: 'app', op: 'modify' }] }] });
    await waitFor(() => b.rt.gate.plans.plans().some((proposed) => proposed.status === 'proposed'), 'the plan waits for an answer');
    b.session.stop();
    expect(await plan).toMatchObject({ ok: true, value: { status: 'rejected' } });
  });
});
