import { describe, expect, it, vi } from 'vitest';
import { waitFor } from '../helpers';
import { AWAIT, build, INIT } from './harness';

const scans = vi.hoisted(() => ({ refreshes: [] as boolean[], block: null as Promise<void> | null }));

vi.mock('../../src/history/baselines', async (original) => {
  const actual = await original<typeof import('../../src/history/baselines')>();
  return {
    ...actual,
    scanTree: async (...args: Parameters<typeof actual.scanTree>) => {
      scans.refreshes.push(args[5]?.refresh === true);
      if (scans.block) await scans.block;
      return actual.scanTree(...args);
    },
  };
});

describe('the periodic scan', { timeout: 30_000 }, () => {
  it('runs one full scan after the running one when a turn closes during it', async () => {
    const b = await build({
      scenario: [AWAIT, INIT, '{"fake":"sleep","ms":400}', '{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"$SESSION"}', AWAIT],
      runtime: { reconcileMs: 50 },
    });
    let release!: () => void;
    scans.block = new Promise<void>((resolve) => { release = resolve; });
    scans.refreshes.length = 0;
    b.session.send('go');
    await waitFor(() => b.session.state().turns.some((turn) => turn.closedAt !== null), 'the turn closed');
    scans.block = null;
    release();
    await waitFor(() => scans.refreshes.includes(true), 'a full scan after the running one');
    expect(scans.refreshes.filter(Boolean)).toHaveLength(1);
  });
});
