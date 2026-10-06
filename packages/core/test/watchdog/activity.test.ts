import { describe, expect, it } from 'vitest';
import { ActivityLedger, type ToolCall } from '../../src/watchdog/activity';

const call = (o: Partial<ToolCall>): ToolCall => ({
  toolUseId: 't1', parentToolUseId: null, tool: 'Write', toolClass: 'file-writer', targets: [], allTracked: false,
  cwdRel: null, background: false, allowedOnce: false, ...o,
});

function make() {
  const clock = { now: 0 };
  const ledger = new ActivityLedger({ now: () => clock.now });
  return { clock, ledger };
}

describe('ActivityLedger attribution', () => {
  it.each([
    ['a covered write inside its window', 'agent', [call({ targets: ['a.ts'] })], 'a.ts', 100, ['t1']],
    ['a write under a covered directory', 'agent', [call({ targets: ['src'] })], 'src/deep/a.ts', 100, ['t1']],
    ['a directory prefix that is only a name prefix', 'agent-tool', [call({ targets: ['src'] })], 'srcs/a.ts', 100, ['t1']],
    ['a shell call that touches every tracked path', 'agent', [call({ tool: 'Bash', toolClass: 'shell', allTracked: true })], 'any/where.ts', 100, ['t1']],
    ['an uncovered path while a call is open', 'agent-tool', [call({ targets: ['a.ts'] })], 'b.ts', 100, ['t1']],
    ['a path while an mcp call is open', 'agent-tool', [call({ tool: 'mcp__x__y', toolClass: 'mcp' })], 'b.ts', 100, ['t1']],
    ['a path while a subagent call is open', 'agent-tool', [call({ tool: 'Task', toolClass: 'subagent' })], 'b.ts', 100, ['t1']],
    ['nothing open', 'human', [], 'a.ts', 100, []],
    ['a path before the call was allowed', 'human', [call({ targets: ['a.ts'] })], 'a.ts', -1, []],
    ['an idecore call', 'human', [call({ tool: 'mcp__idecore__x', toolClass: 'ide' })], 'a.ts', 100, []],
    ['a read call', 'human', [call({ tool: 'Read', toolClass: 'read' })], 'a.ts', 100, []],
    ['a bookkeeping call', 'human', [call({ tool: 'TaskUpdate', toolClass: 'read' })], 'a.ts', 100, []],
    ['an interactive call', 'human', [call({ tool: 'AskUserQuestion', toolClass: 'interactive' })], 'a.ts', 100, []],
    ['a human save while only propose_plan is open', 'human', [call({ tool: 'mcp__idecore__propose_plan', toolClass: 'ide' })], 'a.ts', 100, []],
  ] as const)('%s is %s', (_name, origin, calls, rel, at, ids) => {
    const { ledger } = make();
    for (const c of calls) ledger.allowed(c);
    const got = ledger.attribute(rel, at);
    expect([got.origin, got.toolUseIds]).toEqual([origin, ids]);
  });

  it('gives agent-tool the ids of all overlapping calls, main agent and subagent', () => {
    const { ledger } = make();
    ledger.allowed(call({ toolUseId: 'a', targets: ['x.ts'] }));
    ledger.allowed(call({ toolUseId: 'b', parentToolUseId: 'task1', tool: 'Bash', toolClass: 'shell' }));
    ledger.allowed(call({ toolUseId: 'c', tool: 'Read', toolClass: 'read' }));
    const got = ledger.attribute('y.ts', 5);
    expect(got.origin).toBe('agent-tool');
    expect([...got.toolUseIds].sort()).toEqual(['a', 'b']);
  });

  it('prefers the covering call for an agent origin and lists only the covering ids', () => {
    const { ledger } = make();
    ledger.allowed(call({ toolUseId: 'a', targets: ['x.ts'] }));
    ledger.allowed(call({ toolUseId: 'b', targets: ['z.ts'] }));
    expect(ledger.attribute('x.ts', 5)).toEqual({ origin: 'agent', toolUseIds: ['a'], allowedOnce: false });
  });

  it('counts a change up to the grace period after the call ended and not after', () => {
    const { clock, ledger } = make();
    ledger.allowed(call({ targets: ['a.ts'] }));
    clock.now = 1000;
    ledger.ended('t1');
    expect(ledger.attribute('b.ts', 2900).origin).toBe('agent-tool');
    expect(ledger.attribute('b.ts', 3000).origin).toBe('agent-tool');
    expect(ledger.attribute('b.ts', 3100).origin).toBe('human');
    expect(ledger.attribute('a.ts', 2900).origin).toBe('agent');
    expect(ledger.attribute('a.ts', 3100).origin).toBe('human');
  });

  it('honours a custom grace', () => {
    const clock = { now: 0 };
    const ledger = new ActivityLedger({ now: () => clock.now, graceMs: 10 });
    ledger.allowed(call({ targets: ['a.ts'] }));
    clock.now = 100;
    ledger.ended('t1');
    expect([ledger.attribute('a.ts', 105).origin, ledger.attribute('a.ts', 111).origin]).toEqual(['agent', 'human']);
  });

  it('treats a call the user allowed once as covering every change in its window', () => {
    const { clock, ledger } = make();
    ledger.allowed(call({ targets: ['a.ts'], allowedOnce: true }));
    expect(ledger.attribute('elsewhere/b.ts', 50)).toEqual({ origin: 'agent', toolUseIds: ['t1'], allowedOnce: true });
    expect(ledger.attribute('a.ts', 50).allowedOnce).toBe(true);
    clock.now = 10;
    ledger.ended('t1');
    expect(ledger.attribute('elsewhere/b.ts', 2010).origin).toBe('agent');
    expect(ledger.attribute('elsewhere/b.ts', 2011).origin).toBe('human');
  });

  it('does not let an allow-once call of a class that never counts cover anything', () => {
    const { ledger } = make();
    ledger.allowed(call({ tool: 'Read', toolClass: 'read', allowedOnce: true }));
    expect(ledger.attribute('a.ts', 1).origin).toBe('human');
  });

  describe('background calls', () => {
    const bg = (o: Partial<ToolCall> = {}) => call({ tool: 'Bash', toolClass: 'shell', background: true, cwdRel: 'server', ...o });

    it('cover only their own directory', () => {
      const { ledger } = make();
      ledger.allowed(bg());
      expect(ledger.attribute('server/x.ts', 5).origin).toBe('agent-tool');
      expect(ledger.attribute('src/y.ts', 5).origin).toBe('human');
    });

    it('cover only their targets when they name some', () => {
      const { ledger } = make();
      ledger.allowed(bg({ cwdRel: null, targets: ['out/log.txt'] }));
      expect(ledger.attribute('out/log.txt', 5).origin).toBe('agent');
      expect(ledger.attribute('src/y.ts', 5).origin).toBe('human');
    });

    it('cover nothing without targets and cwd', () => {
      const { ledger } = make();
      ledger.allowed(bg({ cwdRel: null }));
      expect(ledger.attribute('src/y.ts', 5).origin).toBe('human');
    });

    it('a background shell at the project root covers only its targets, so a dev server leaves human saves human', () => {
      const { ledger } = make();
      ledger.allowed(bg({ cwdRel: '', targets: ['out/log.txt'] }));
      expect(ledger.attribute('src/y.ts', 5).origin).toBe('human');
      expect(ledger.attribute('out/log.txt', 5).origin).toBe('agent');
    });

    it('survive an interrupt', () => {
      const { clock, ledger } = make();
      ledger.allowed(bg());
      clock.now = 10;
      ledger.interrupted();
      expect(ledger.windowOf('t1')).toEqual({ from: 0, to: null });
      expect(ledger.attribute('server/x.ts', 100_000).origin).toBe('agent-tool');
      expect(ledger.runningShell()).toBe(true);
    });

    it('keep counting after the tool call itself ended, until taskEnded', () => {
      const { clock, ledger } = make();
      ledger.allowed(bg());
      clock.now = 100;
      ledger.ended('t1');
      expect(ledger.attribute('server/x.ts', 60_000).origin).toBe('agent-tool');
      clock.now = 70_000;
      ledger.taskEnded('t1');
      expect(ledger.attribute('server/x.ts', 71_000).origin).toBe('agent-tool');
      expect(ledger.attribute('server/x.ts', 72_100).origin).toBe('human');
    });

    it('count as running only until taskEnded', () => {
      const { ledger } = make();
      ledger.allowed(bg());
      expect(ledger.runningShell()).toBe(true);
      ledger.ended('t1');
      expect(ledger.runningShell()).toBe(true);
      ledger.taskEnded('t1');
      expect(ledger.runningShell()).toBe(false);
    });
  });

  describe('interrupted', () => {
    it('keeps an open mcp call active for the linger window, and ends other classes at once', () => {
      const { clock, ledger } = make();
      ledger.allowed(call({ toolUseId: 'm', tool: 'mcp__x__y', toolClass: 'mcp' }));
      ledger.allowed(call({ toolUseId: 'b', tool: 'Bash', toolClass: 'shell' }));
      clock.now = 10;
      ledger.interrupted();
      expect(ledger.attribute('a.ts', 59_000)).toMatchObject({ origin: 'agent-tool', toolUseIds: ['m'] });
      expect(ledger.attribute('a.ts', 60_010).origin).toBe('agent-tool');
      expect(ledger.attribute('a.ts', 61_000).origin).toBe('human');
      expect(ledger.attribute('a.ts', 2_009).toolUseIds).toEqual(['m', 'b']);
      expect(ledger.attribute('a.ts', 2_011).toolUseIds).toEqual(['m']);
    });

    it('does not extend the linger on a second interrupt', () => {
      const { clock, ledger } = make();
      ledger.allowed(call({ tool: 'mcp__x__y', toolClass: 'mcp' }));
      clock.now = 10;
      ledger.interrupted();
      clock.now = 30_000;
      ledger.interrupted();
      expect(ledger.attribute('a.ts', 60_010).origin).toBe('agent-tool');
      expect(ledger.attribute('a.ts', 60_011).origin).toBe('human');
    });

    it('lets an interrupted mcp call end early, with the usual grace', () => {
      const { clock, ledger } = make();
      ledger.allowed(call({ tool: 'mcp__x__y', toolClass: 'mcp' }));
      ledger.interrupted();
      clock.now = 500;
      ledger.ended('t1');
      expect(ledger.attribute('a.ts', 2_400).origin).toBe('agent-tool');
      expect(ledger.attribute('a.ts', 2_600).origin).toBe('human');
    });

    it('does not touch a call that already ended', () => {
      const { clock, ledger } = make();
      ledger.allowed(call({ tool: 'mcp__x__y', toolClass: 'mcp' }));
      clock.now = 100;
      ledger.ended('t1');
      clock.now = 200;
      ledger.interrupted();
      expect(ledger.windowOf('t1')).toEqual({ from: 0, to: 100 });
      expect(ledger.attribute('a.ts', 2_150).origin).toBe('human');
    });

    it('honours a custom linger', () => {
      const clock = { now: 0 };
      const ledger = new ActivityLedger({ now: () => clock.now, lingerMs: 100 });
      ledger.allowed(call({ tool: 'mcp__x__y', toolClass: 'mcp' }));
      ledger.interrupted();
      expect([ledger.attribute('a.ts', 100).origin, ledger.attribute('a.ts', 101).origin]).toEqual(['agent-tool', 'human']);
    });
  });

  describe('views', () => {
    it('windowOf reports open and ended windows and undefined for an unknown call', () => {
      const { clock, ledger } = make();
      clock.now = 7;
      ledger.allowed(call({}));
      expect(ledger.windowOf('t1')).toEqual({ from: 7, to: null });
      clock.now = 9;
      ledger.ended('t1');
      expect(ledger.windowOf('t1')).toEqual({ from: 7, to: 9 });
      expect(ledger.windowOf('nope')).toBeUndefined();
    });

    it('windowOf of a background call ends at taskEnded, not at the tool result', () => {
      const { clock, ledger } = make();
      ledger.allowed(call({ tool: 'Bash', toolClass: 'shell', background: true, cwdRel: '' }));
      clock.now = 3;
      ledger.ended('t1');
      expect(ledger.windowOf('t1')).toEqual({ from: 0, to: null });
      clock.now = 8;
      ledger.taskEnded('t1');
      expect(ledger.windowOf('t1')).toEqual({ from: 0, to: 8 });
    });

    it('runningSubagents counts open background subagent calls only', () => {
      const { ledger } = make();
      ledger.allowed(call({ toolUseId: 'a', tool: 'Task', toolClass: 'subagent', background: true }));
      ledger.allowed(call({ toolUseId: 'b', tool: 'Task', toolClass: 'subagent', background: true }));
      ledger.allowed(call({ toolUseId: 'c', tool: 'Task', toolClass: 'subagent', background: false }));
      ledger.allowed(call({ toolUseId: 'd', tool: 'Bash', toolClass: 'shell', background: true, cwdRel: '' }));
      expect(ledger.runningSubagents()).toBe(2);
      ledger.taskEnded('a');
      expect(ledger.runningSubagents()).toBe(1);
      expect(ledger.runningShell()).toBe(true);
    });

    it('runningShell is false for a foreground shell', () => {
      const { ledger } = make();
      ledger.allowed(call({ tool: 'Bash', toolClass: 'shell' }));
      expect(ledger.runningShell()).toBe(false);
    });

    it('clear forgets every call', () => {
      const { ledger } = make();
      ledger.allowed(call({ tool: 'Bash', toolClass: 'shell', background: true, cwdRel: '' }));
      ledger.clear();
      expect([ledger.attribute('a.ts', 1).origin, ledger.windowOf('t1'), ledger.runningShell(), ledger.runningSubagents()]).toEqual(['human', undefined, false, 0]);
    });

    it('a repeated allowed for the same id replaces the call and keeps the first start', () => {
      const { clock, ledger } = make();
      ledger.allowed(call({ targets: ['a.ts'] }));
      clock.now = 5;
      ledger.allowed(call({ targets: ['b.ts'], allowedOnce: true }));
      expect(ledger.windowOf('t1')).toEqual({ from: 0, to: null });
      expect(ledger.attribute('c.ts', 6).allowedOnce).toBe(true);
    });
  });
});

describe('ActivityLedger attribution scope', () => {
  it('lets a shell that touches every tracked path cover only tracked paths', () => {
    const { ledger } = make();
    ledger.allowed(call({ tool: 'Bash', toolClass: 'shell', allTracked: true }));
    expect(ledger.attribute('new.ts', 100, { tracked: false }).origin).toBe('agent-tool');
    expect(ledger.attribute('old.ts', 100, { tracked: true }).origin).toBe('agent');
    expect(ledger.attribute('old.ts', 100).origin).toBe('agent');
  });

  it('applies a call allowed once only to enforced paths', () => {
    const { ledger } = make();
    ledger.allowed(call({ tool: 'Bash', toolClass: 'shell', allowedOnce: true }));
    expect(ledger.attribute('a.ts', 100, { enforced: false }).origin).toBe('agent-tool');
    expect(ledger.attribute('a.ts', 100, { enforced: true }).origin).toBe('agent');
  });

  it('keeps a background call with all tracked paths from reaching untracked ones', () => {
    const { ledger } = make();
    ledger.allowed(call({ tool: 'Bash', toolClass: 'shell', allTracked: true, background: true }));
    expect(ledger.attribute('new.ts', 100, { tracked: false }).origin).toBe('human');
  });
});

describe('ActivityLedger for a history call', () => {
  it('gives git the files it leaves tracked or deletes under its directory and the root refs, and the agent every other file', () => {
    const { ledger } = make();
    ledger.allowed(call({ tool: 'Bash', toolClass: 'shell', targets: ['pkg/dirty.txt'], history: [{ dir: 'pkg', top: '/p/pkg', head: 'abc' }] }));
    const origin = (rel: string, scope: { tracked?: boolean; deleted?: boolean } = {}) => ledger.attribute(rel, 100, scope).origin;
    expect({
      deletedUnder: origin('pkg/gone.txt', { tracked: false, deleted: true }),
      trackedUnder: origin('pkg/sub/kept.txt', { tracked: true }),
      newUnder: origin('pkg/new.txt', { tracked: false }),
      trackedOutside: origin('other/kept.txt', { tracked: true }),
      deletedOutside: origin('other/gone.txt', { tracked: false, deleted: true }),
      target: origin('pkg/dirty.txt', { tracked: true }),
      head: origin('.git/HEAD', { tracked: false }),
      ref: origin('.git/refs/heads/x', { tracked: false }),
    }).toEqual({
      deletedUnder: 'git', trackedUnder: 'git', newUnder: 'agent-tool', trackedOutside: 'agent-tool', deletedOutside: 'agent-tool',
      target: 'agent', head: 'git', ref: 'git',
    });
  });
});
