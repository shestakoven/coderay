import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChangeView, WatchdogAnswer, WatchdogEventView } from '@ide/protocol';
import { SessionError } from '../../src/agent/agent-session';
import { waitFor } from '../helpers';
import { build, WAIT_TURN, type Built, type BuildOptions } from './harness';

const HELLO = "export const greeting = 'hello';\n";
const OTHER_ORIGINAL = "export const other = 'helo';\n";
const OTHER_CHANGED = "export const other = 'changed';\n";
const THIRD = "export const third = 'new';\n";

type ExecFlow = Built & {
  runtime: Built['rt'];
  file(rel: string): string;
  exists(rel: string): boolean;
  hookRecords(): { id: string; tool: string; allowed: boolean }[];
  interrupts(): number;
  userMessages(): string[];
  pending(): Promise<WatchdogEventView>;
  answer(event: WatchdogEventView, answer: WatchdogAnswer): Promise<void>;
  change(rel: string): ChangeView;
};

async function execFlow(scenario: string | string[], options: Omit<BuildOptions, 'scenario'> = {}): Promise<ExecFlow> {
  const b = await build({ scenario, ...options });
  const file = (rel: string): string => readFileSync(join(b.root, rel), 'utf8');
  return {
    ...b,
    runtime: b.rt,
    file,
    exists: (rel) => existsSync(join(b.root, rel)),
    hookRecords: () => b.records().flatMap((record) => (record.hook ? [record.hook] : [])),
    interrupts: () => b.records().filter((record) => record.stdin?.type === 'control_request').length,
    userMessages: () => b.records().flatMap((record) => (record.stdin?.type === 'user' ? [String((record.stdin.message as { content: unknown }).content)] : [])),
    pending: () => waitFor(() => b.events().find((event) => event.phase === 'pending'), 'a pending watchdog event'),
    answer: (event, answer) => b.rt.watchdog.answer(event.id, answer),
    change: (rel) => b.changes().findLast((c) => c.path === rel)!,
  };
}

const closedTurns = (f: ExecFlow) => f.session.state().turns.filter((turn) => turn.closedAt !== null);
const resumeMessage = (f: ExecFlow, count = 2) => waitFor(() => (f.userMessages().length >= count ? f.userMessages().at(-1) : undefined), 'the resume message');

describe('the watchdog flows on the fake claude', { timeout: 30_000 }, () => {
  it('interrupts, pauses, snapshots and reverts nothing before the answer for an out-of-plan write of an MCP tool', async () => {
    const f = await execFlow('exec-mcp-write-out-of-plan');
    await f.send();
    const event = await f.pending();
    expect(event.changes.map((c) => c.path).sort()).toEqual(['src/other.ts', 'src/third.ts']);
    expect([event.kind, event.interrupted, event.snapshotSha]).toEqual(['watchdog', true, expect.stringMatching(/^[0-9a-f]{40}$/)]);
    expect([f.interrupts(), f.runtime.hold.isHeld(), f.runtime.reverts.reverts()]).toEqual([1, true, []]);
    expect([f.file('src/app.ts'), f.file('src/other.ts'), f.file('src/third.ts')]).toEqual([HELLO, OTHER_CHANGED, THIRD]);
    await f.answer(event, { kind: 'all', answer: 'keep' });
    expect([f.file('src/other.ts'), f.file('src/third.ts'), f.runtime.hold.isHeld()]).toEqual([OTHER_CHANGED, THIRD, false]);
  });

  it('records a write to a gitignored or harness path without interrupting, and interrupts for a guarded path', async () => {
    const f = await execFlow('exec-mcp-write-paths', { files: { '.gitignore': 'dist/\n' } });
    await f.send();
    await waitFor(() => closedTurns(f).length === 1, 'the first turn closed');
    const recorded = await waitFor(() => (['dist/out.js', '.omc/note.txt'].every((p) => f.changes().some((c) => c.path === p)) ? f.changes() : undefined), 'the recorded changes');
    expect(recorded.filter((c) => c.path === 'dist/out.js' || c.path === '.omc/note.txt').map((c) => [c.path, c.origin, c.enforcement, c.outOfPlan]))
      .toEqual(expect.arrayContaining([['dist/out.js', 'agent-tool', 'recorded', false], ['.omc/note.txt', 'agent-tool', 'recorded', false]]));
    await f.runtime.changes.idle();
    expect([f.events(), f.interrupts(), f.runtime.hold.isHeld()]).toEqual([[], 0, false]);
    f.session.send('again');
    const event = await f.pending();
    expect(event.changes.map((c) => [c.path, c.enforcement])).toEqual([['.env', 'enforced']]);
    expect([event.interrupted, f.interrupts(), f.runtime.hold.isHeld()]).toEqual([true, 1, true]);
  });

  it('answers keep with the resume message and no revert', async () => {
    const f = await execFlow('exec-mcp-write-out-of-plan');
    await f.send();
    const event = await f.pending();
    await f.answer(event, { kind: 'all', answer: 'keep' });
    const text = await resumeMessage(f);
    expect(text).toContain('Kept as you wrote them: src/other.ts, src/third.ts.');
    expect([f.runtime.reverts.reverts(), f.file('src/other.ts'), f.file('src/third.ts')]).toEqual([[], OTHER_CHANGED, THIRD]);
    expect(f.events().map((e) => [e.phase, e.resolution])).toEqual([['resolved', 'kept']]);
  });

  it('answers revert by restoring the files to before, and the revert can be undone', async () => {
    const f = await execFlow('exec-mcp-write-out-of-plan');
    await f.send();
    const event = await f.pending();
    const before = new Map(event.changes.map((c) => [c.path, c.beforeHash]));
    await f.answer(event, { kind: 'all', answer: 'revert' });
    expect([f.file('src/other.ts'), f.exists('src/third.ts')]).toEqual([OTHER_ORIGINAL, false]);
    const record = f.runtime.reverts.reverts().at(-1)!;
    expect(record.files.map((file) => [file.path, file.outcome])).toEqual([['src/other.ts', 'restored'], ['src/third.ts', 'deleted']]);
    expect(before.get('src/other.ts')).toEqual(expect.any(String));
    expect(before.get('src/third.ts')).toBeNull();
    expect(await resumeMessage(f)).toContain('Restored to their earlier content: src/other.ts, src/third.ts.');
    await f.runtime.reverts.undo(record.id);
    expect([f.file('src/other.ts'), f.file('src/third.ts')]).toEqual([OTHER_CHANGED, THIRD]);
  });

  it('gives a mixed event for per-file answers', async () => {
    const f = await execFlow('exec-mcp-write-out-of-plan');
    await f.send();
    const event = await f.pending();
    await f.answer(event, { kind: 'files', files: { 'src/other.ts': 'keep', 'src/third.ts': 'revert' } });
    expect([f.file('src/other.ts'), f.exists('src/third.ts')]).toEqual([OTHER_CHANGED, false]);
    expect(f.events().map((e) => [e.phase, e.resolution])).toEqual([['resolved', 'mixed']]);
    expect([f.change('src/other.ts').resolution, f.change('src/third.ts').resolution]).toEqual(['kept', 'reverted']);
  });

  it('flags in mode C without an interrupt or a hold', async () => {
    const f = await execFlow('exec-mcp-write-out-of-plan', { mode: 'C' });
    await f.send();
    const event = await waitFor(() => f.events().find((e) => e.changes.length === 2), 'a flagged event with both files');
    expect([event.phase, event.resolution, event.interrupted]).toEqual(['resolved', 'flagged', false]);
    expect([f.interrupts(), f.runtime.hold.isHeld(), f.change('src/other.ts').resolution, f.exists('src/third.ts')]).toEqual([0, false, 'flagged', true]);
  });

  it('relabels the change human when the user says this was their edit', async () => {
    const f = await execFlow('exec-mcp-write-out-of-plan');
    await f.send();
    const event = await f.pending();
    await f.answer(event, { kind: 'all', answer: 'mine' });
    expect(f.change('src/other.ts')).toMatchObject({ origin: 'human', resolution: 'relabeled-human' });
    expect(f.file('src/other.ts')).toBe(OTHER_CHANGED);
    expect(await resumeMessage(f)).toContain('Edited by the user, not by you: src/other.ts, src/third.ts.');
  });

  it('does not raise the watchdog again for a shell write the user approved at the prompt', async () => {
    const f = await execFlow('exec-shell-ask');
    await f.send();
    const prompt = await waitFor(() => f.runtime.gate.gate.prompts().find((p) => p.status === 'pending'), 'the prompt');
    f.runtime.gate.gate.answer(prompt.id, 'allow-once');
    await waitFor(() => closedTurns(f).length === 1, 'the turn closed');
    const change = await waitFor(() => f.changes().find((c) => c.path === 'src/other.ts'), 'the change');
    await f.runtime.changes.idle();
    await f.runtime.watchdog.quiesce();
    expect([change.origin, change.outOfPlan, f.events(), f.interrupts(), f.runtime.hold.isHeld()]).toEqual(['agent', false, [], 0, false]);
  });

  it('does not treat a human edit during plan review as out of plan', async () => {
    const f = await execFlow('gate-big-plan');
    await f.send();
    await waitFor(() => f.runtime.gate.plans.plans().find((plan) => plan.status === 'proposed'), 'the plan waiting for review');
    f.write('src/other.ts', "export const other = 'by hand';\n");
    const change = await waitFor(() => f.changes().find((c) => c.path === 'src/other.ts'), 'the change');
    await f.runtime.changes.idle();
    await f.runtime.watchdog.quiesce();
    expect([change.origin, change.outOfPlan, f.events(), f.interrupts(), f.runtime.hold.isHeld()]).toEqual(['human', false, [], 0, false]);
  });

  it('keeps the turns of an agent-initiated turn and of the next user message apart', async () => {
    const f = await execFlow('exec-agent-initiated', { mode: 'C' });
    await f.send();
    await waitFor(() => closedTurns(f).length === 2, 'the agent-initiated turn closed');
    f.session.send('next');
    await waitFor(() => closedTurns(f).length === 3, 'the follow-up turn closed');
    const { turns, items } = f.session.state();
    const textsOf = (turnId: string) => items.filter((item) => item.turnId === turnId && item.kind === 'message').map((item) => (item.kind === 'message' ? item.text : ''));
    expect(turns.map((turn) => [turn.kind, textsOf(turn.id)])).toEqual([
      ['user', ['go', 'Starting.']],
      ['agent-initiated', ['The subagent finished.']],
      ['user', ['next', 'NEXT']],
    ]);
    const late = items.find((item) => item.kind === 'tool' && item.id === 'toolu_late');
    expect(late?.turnId).toBe(turns[1]!.id);
    const change = await waitFor(() => f.changes().find((c) => c.path === 'src/other.ts' && c.resolution !== null), 'the flagged change');
    expect([change.origin, change.toolUseIds, change.resolution, f.events().map((e) => e.resolution)]).toEqual(['agent-tool', ['toolu_late'], 'flagged', ['flagged']]);
  });

  it('closes the turn, task and prompt of a crashed process and releases a hold', async () => {
    const f = await execFlow('exec-crash-open-state');
    await f.send();
    const open = await waitFor(() => {
      const { items, tasks } = f.session.state();
      return tasks.some((task) => task.status === 'running') && items.some((item) => item.kind === 'prompt' && item.status === 'pending') ? true : undefined;
    }, 'a running task and a pending prompt');
    expect(open).toBe(true);
    f.runtime.hold.hold('a hold left by the dead process');
    const pid = f.records().find((record) => record.pid !== undefined)!.pid!;
    process.kill(pid, 'SIGKILL');
    await waitFor(() => f.session.state().session?.status === 'crashed', 'the session crashed');
    const { turns, items, tasks } = f.session.state();
    expect(turns.map((turn) => [turn.closedAt !== null, turn.resultSubtype])).toEqual([[true, 'crashed']]);
    expect(tasks.map((task) => [task.status, task.endedAt !== null])).toEqual([['unfinished', true]]);
    expect(items.filter((item) => item.kind === 'prompt').map((item) => item.status)).toEqual(['dropped']);
    await waitFor(() => !f.runtime.hold.isHeld(), 'the hold released');
  });

  it('raises the changes made while the core was down after an unclean stop as one unknown event', async () => {
    const first = await execFlow(WAIT_TURN);
    await first.send();
    await first.session.close();
    await first.rt.close();
    first.store.saveSession({ ...first.store.latestSession()!, status: 'running' });
    writeFileSync(join(first.root, 'src/app.ts'), HELLO);
    writeFileSync(join(first.root, 'src/other.ts'), OTHER_CHANGED);
    const again = await execFlow(WAIT_TURN, { from: first });
    const events = again.events();
    expect(events.map((e) => [e.kind, e.phase, e.unknownOrigin, e.changes.map((c) => [c.path, c.origin]).sort()])).toEqual([
      ['watchdog', 'pending', true, [['src/app.ts', 'unknown'], ['src/other.ts', 'unknown']]],
    ]);
    expect(again.runtime.hold.isHeld()).toBe(true);
  });

  it('does not turn a human save outside a background shell\'s targets into an agent change', async () => {
    const f = await execFlow('exec-background-shell');
    await f.send();
    const own = await waitFor(() => f.changes().find((c) => c.path === 'src/build.log'), 'the shell write');
    expect(f.session.state().tasks.some((task) => task.kind === 'shell' && task.status === 'running')).toBe(true);
    f.write('notes.txt', 'edited by hand\n');
    const human = await waitFor(() => f.changes().find((c) => c.path === 'notes.txt'), 'the human save');
    await f.runtime.changes.idle();
    await f.runtime.watchdog.quiesce();
    expect([own.origin, own.outOfPlan, human.origin, human.outOfPlan, f.events(), f.interrupts()]).toEqual(['agent', false, 'human', false, [], 0]);
  });

  it('re-attributes the changes in the window of a call the hook never judged', async () => {
    const f = await execFlow('exec-fail-open');
    await f.send();
    const event = await waitFor(() => f.events().find((e) => e.kind === 'fail-open' && e.phase === 'pending' && e.changes.length === 2), 'a pending fail-open event with both files');
    expect(f.hookRecords().map((hook) => hook.id)).not.toContain('toolu_f');
    expect(event.changes.map((c) => [c.path, c.origin, c.toolUseIds]).sort()).toEqual([
      ['src/other.ts', 'agent-tool', ['toolu_f']],
      ['src/third.ts', 'agent-tool', ['toolu_f']],
    ]);
    expect(f.events().length).toBe(1);
  });

  it('rolls a step back without touching harness and recorded-only files, and previews the agent-tool files', async () => {
    const f = await execFlow('exec-step-rollback', { files: { '.gitignore': 'dist/\n' } });
    await f.send();
    await waitFor(() => closedTurns(f).length === 1, 'the turn closed');
    await waitFor(() => ['src/other.ts', 'dist/out.js', '.omc/note.txt'].every((rel) => f.changes().some((c) => c.path === rel)), 'the changes recorded');
    f.session.send('finish');
    const plan = await waitFor(() => f.runtime.gate.plans.plans().find((p) => p.status === 'done'), 'the plan done');
    await waitFor(() => f.runtime.checkpoints.views().find((view) => view.sealedAt !== null), 'the sealed checkpoint');
    await waitFor(() => closedTurns(f).length === 2, 'the second turn closed');
    await f.runtime.changes.idle();
    const preview = await f.runtime.reverts.previewStepRollback(plan.id, 'edit');
    expect(preview).toMatchObject({ allowed: true, autoFiles: ['src/app.ts'], confirmFiles: ['src/other.ts'] });
    expect(preview.notRolledBack.map((file) => file.path).sort()).toEqual(['.omc/note.txt', 'dist/out.js']);
    await f.runtime.reverts.rollbackStep(plan.id, 'edit', ['src/other.ts']);
    expect([f.file('src/app.ts'), f.file('src/other.ts')]).toEqual(["export const greeting = 'helo';\n", OTHER_ORIGINAL]);
    expect([f.file('dist/out.js'), f.file('.omc/note.txt')]).toEqual(['built\n', 'note\n']);
  });

  describe('with an async subagent running', () => {
    const paused = async () => {
      const f = await execFlow('exec-subagent-out-of-plan');
      await f.send();
      const event = await f.pending();
      await waitFor(() => closedTurns(f).length === 1, 'the first turn closed');
      return { f, event };
    };

    it('pauses without interrupting, holds the subagent\'s next call, and lets it continue after the answer', async () => {
      const { f, event } = await paused();
      expect([event.paused, event.interrupted, event.runningSubagents, f.interrupts(), f.runtime.hold.isHeld()]).toEqual([true, false, 1, 0, true]);
      f.session.send('go on');
      await waitFor(() => f.runtime.hold.waiting() > 0, 'the subagent call held');
      expect(f.file('src/app.ts')).toBe("export const greeting = 'helo';\n");
      await f.answer(event, { kind: 'all', answer: 'keep' });
      await waitFor(() => f.file('src/app.ts') === HELLO, 'the held call continued');
      await f.runtime.changes.idle();
      await f.runtime.watchdog.quiesce();
      expect([f.events().length, f.interrupts(), f.userMessages()]).toEqual([1, 0, ['go', 'go on']]);
    });

    it('does not interrupt the turn that is open while the subagent writes out of plan', async () => {
      const f = await execFlow('exec-subagent-open-turn');
      await f.send();
      await waitFor(() => closedTurns(f).length === 1, 'the first turn closed');
      f.session.send('go on');
      const event = await f.pending();
      expect(f.session.hasOpenTurn()).toBe(true);
      expect([event.paused, event.interrupted, event.runningSubagents, f.interrupts(), f.runtime.hold.isHeld()]).toEqual([true, false, 1, 0, true]);
    });

    it('interrupts on Stop agent and names the subagent in the resume message', async () => {
      const { f, event } = await paused();
      f.session.send('go on');
      await waitFor(() => f.runtime.hold.waiting() > 0, 'the subagent call held');
      f.runtime.watchdog.stopAgent(event.id);
      expect([f.events()[0]!.interrupted, f.interrupts()]).toEqual([true, 1]);
      await f.answer(event, { kind: 'all', answer: 'keep' });
      const text = await resumeMessage(f, 3);
      expect(text).toContain('Stopped with it: Fix other files; their unfinished work is lost.');
      expect(f.file('src/app.ts')).toBe("export const greeting = 'helo';\n");
    });
  });

  it('refuses a message when the session-start hook never reports', async () => {
    const f = await execFlow(WAIT_TURN, { claudeEnv: { FAKE_CLAUDE_HOOKS: 'off' }, canaryMs: 200 });
    f.session.send('go');
    await waitFor(() => f.session.state().session?.status === 'refused', 'the session refused');
    expect(() => f.session.send('again')).toThrow(new SessionError('hook-off'));
    expect(f.userMessages()).toEqual([]);
  });

  it('raises a 300-file burst from a background shell as one event, and revert restores all 300', async () => {
    const f = await execFlow('exec-background-burst', { files: { 'burst/gen.sh': 'i=1\nwhile [ $i -le 300 ]; do echo $i > f$i.txt; i=$((i+1)); done\n' } });
    await f.send();
    const event = await waitFor(() => f.events().find((e) => e.phase === 'pending' && e.changes.length === 300), 'one event with 300 changes');
    expect([f.events().length, event.interrupted, event.backgroundShell]).toEqual([1, true, true]);
    const files = Array.from({ length: 300 }, (_, i) => `burst/f${i + 1}.txt`);
    expect(files.every((rel) => f.exists(rel))).toBe(true);
    await f.answer(event, { kind: 'all', answer: 'revert' });
    expect(files.filter((rel) => f.exists(rel))).toEqual([]);
    expect(f.exists('burst/gen.sh')).toBe(true);
  });

  it('makes the next small plan wait after a Reject until the user\'s next message', async () => {
    const f = await execFlow('exec-reject-then-small-plan');
    await f.send();
    const plans = () => f.runtime.gate.plans;
    const big = await waitFor(() => plans().plans().find((p) => p.goal === 'Fix everything' && p.status === 'proposed'), 'the big plan waiting');
    plans().answer(big.id, big.version, { kind: 'reject', feedback: '' });
    const small = await waitFor(() => plans().plans().find((p) => p.goal === 'Fix the greeting' && p.status === 'proposed'), 'the small plan waiting');
    expect(small.review.auto).toBe(false);
    expect(small.review.notes).toContain('You rejected the previous plan; this plan waits for you.');
    f.session.stop();
    await waitFor(() => plans().plans().find((p) => p.goal === 'Fix the greeting')?.status === 'withdrawn', 'the small plan withdrawn');
    await waitFor(() => closedTurns(f).length === 1, 'the turn closed');
    f.session.send('go on');
    const next = await waitFor(() => plans().plans().find((p) => p.goal === 'Fix the other file' && p.status !== 'proposed'), 'the next plan decided');
    expect([next.status, next.approvedBy, next.review.auto]).toEqual(['approved', 'auto', true]);
  });
});
