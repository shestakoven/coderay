import { describe, expect, it } from 'vitest';
import { AT, CALL, codexHooks, SUBAGENT, type RawHook } from './codex-fixture';
import { openTerminal, snapshot, type Terminal } from './terminal-events-harness';

const hooks = codexHooks();
const prompt = (index: number) => (hooks[index] as RawHook).prompt as string;

// Feeds the recorded Codex events as the hooks of the open terminal deliver them: PreToolUse through the gate, the rest through the event hook.
async function codexTerminal() {
  const t = await openTerminal();
  const feed = (from: number, to = from): void => {
    for (const hook of hooks.slice(from, to + 1)) {
      const event = { ...hook, session_id: t.claudeId };
      if (hook.hook_event_name === 'PreToolUse') t.h.session.toolCalled(event);
      else t.h.session.hookEvent(t.ideId, event);
    }
  };
  return { t, feed };
}

const callsOf = (t: Terminal) => t.items().flatMap((item) => (item.kind === 'tool' ? [[item.id, item.tool, item.status, item.parentToolUseId]] : []));

describe('an agent in the terminal that is Codex, followed through its hooks', () => {
  describe('the whole recorded session', () => {
    it('makes two user turns, the first a success and the second stopped with Esc, and leaves none open', async () => {
      const { t, feed } = await codexTerminal();
      feed(0, hooks.length - 1);
      expect(t.turns()).toMatchObject([
        { kind: 'user', closedAt: expect.any(Number), resultSubtype: 'success' },
        { kind: 'user', closedAt: expect.any(Number), resultSubtype: 'error_during_execution' },
      ]);
      expect([t.h.session.hasOpenTurn(), t.h.session.isIdle()]).toEqual([false, true]);
    });

    it('ends every call as ok, the call of the subagent under spawn_agent', async () => {
      const { t, feed } = await codexTerminal();
      feed(0, hooks.length - 1);
      expect(callsOf(t)).toEqual([
        [CALL.bash, 'Bash', 'ok', null],
        [CALL.spawn, 'spawn_agent', 'ok', null],
        [CALL.wait, 'multi_agent_v1wait_agent', 'ok', null],
        [CALL.subBash, 'Bash', 'ok', CALL.spawn],
        [CALL.close, 'multi_agent_v1close_agent', 'ok', null],
      ]);
    });

    it('makes one subagent task of spawn_agent, completed', async () => {
      const { t, feed } = await codexTerminal();
      feed(0, hooks.length - 1);
      expect(t.tasks()).toMatchObject([{ id: SUBAGENT, toolUseId: CALL.spawn, kind: 'subagent', status: 'completed', endedAt: expect.any(Number) }]);
      expect([t.h.session.runningSubagents(), t.heard.taskEnds]).toEqual([0, [CALL.spawn]]);
    });

    it('shows the two prompts of the user, the last message of the subagent as a child message, and the answer of the agent', async () => {
      const { t, feed } = await codexTerminal();
      feed(0, hooks.length - 1);
      expect(t.messages().map((m) => [m.role, m.text, m.parentToolUseId])).toEqual([
        ['user', prompt(AT.prompt), null],
        ['assistant', 'sub done', CALL.spawn],
        ['assistant', 'A done', null],
        ['user', prompt(AT.secondPrompt), null],
      ]);
      expect(t.messages().find((m) => m.text === 'A done')?.turnId).toBe(t.turns()[0]?.id);
    });

    it('tells about the two prompts of the user, five results of calls and one Esc', async () => {
      const { t, feed } = await codexTerminal();
      feed(0, hooks.length - 1);
      expect(t.heard.userMessages).toBe(2);
      expect(t.heard.toolResults.map((info) => [info.toolUseId, info.status, info.parentToolUseId])).toEqual([
        [CALL.bash, 'ok', null], [CALL.spawn, 'ok', null], [CALL.subBash, 'ok', CALL.spawn], [CALL.wait, 'ok', null], [CALL.close, 'ok', null],
      ]);
      expect(t.heard.interrupts).toBe(1);
    });

    it('answers every event with nothing for the agent', async () => {
      const t = await openTerminal();
      const answers = hooks.filter((hook) => hook.hook_event_name !== 'PreToolUse').map((hook) => t.h.session.hookEvent(t.ideId, { ...hook, session_id: t.claudeId }));
      expect(answers.filter((answer) => answer !== null)).toEqual([]);
    });
  });

  describe('the prompt of a subagent', () => {
    it('does not open a turn, add a message of the user or tell that the user wrote', async () => {
      const { t, feed } = await codexTerminal();
      feed(0, AT.subagentStart);
      const before = snapshot(t);
      feed(AT.subagentPrompt);
      expect(snapshot(t)).toBe(before);
      expect([t.turns().length, t.heard.userMessages]).toEqual([1, 1]);
    });
  });

  describe('Interrupt', () => {
    it('closes the open turn as error_during_execution and tells about the interruption', async () => {
      const { t, feed } = await codexTerminal();
      feed(0, AT.secondPrompt);
      expect(t.h.session.hasOpenTurn()).toBe(true);
      feed(AT.interrupt);
      expect(t.turns().at(-1)).toMatchObject({ closedAt: expect.any(Number), resultSubtype: 'error_during_execution' });
      expect([t.h.session.hasOpenTurn(), t.heard.interrupts]).toEqual([false, 1]);
    });

    it('changes nothing when no turn is open', async () => {
      const { t, feed } = await codexTerminal();
      feed(0, AT.stop);
      const before = snapshot(t);
      feed(AT.interrupt);
      expect([snapshot(t), t.heard.interrupts]).toEqual([before, 0]);
    });
  });

  describe('spawn_agent', () => {
    it('starts a subagent task named by the JSON string it returns', async () => {
      const { t, feed } = await codexTerminal();
      feed(0, AT.spawnEnd);
      expect(t.tasks()).toMatchObject([{ id: SUBAGENT, toolUseId: CALL.spawn, kind: 'subagent', endedAt: null }]);
      expect([t.h.session.runningSubagents(), t.h.session.isIdle()]).toEqual([1, false]);
    });

    it('places the calls of the subagent under it and not the calls of the main agent', async () => {
      const { t, feed } = await codexTerminal();
      feed(0, AT.subBashEnd);
      expect(callsOf(t).map(([id, , , parent]) => [id, parent])).toEqual([[CALL.bash, null], [CALL.spawn, null], [CALL.wait, null], [CALL.subBash, CALL.spawn]]);
    });

    it('ends the task and shows the last message of the subagent under it when the subagent stops', async () => {
      const { t, feed } = await codexTerminal();
      feed(0, AT.subagentStop);
      expect(t.tasks()).toMatchObject([{ id: SUBAGENT, endedAt: expect.any(Number) }]);
      expect(t.messages().filter((m) => m.role === 'assistant')).toMatchObject([{ text: 'sub done', parentToolUseId: CALL.spawn }]);
      expect([t.h.session.runningSubagents(), t.heard.taskEnds]).toEqual([0, [CALL.spawn]]);
    });

    it.each([['a string that is not JSON', 'could not spawn'], ['JSON without an agent_id', '{"nickname":"Pascal"}'], ['an object', { agent_id: SUBAGENT }]])(
      'starts no task when it returns %s',
      async (_what, response) => {
        const { t, feed } = await codexTerminal();
        feed(0, AT.spawnStart);
        t.h.session.hookEvent(t.ideId, { ...hooks[AT.spawnEnd], session_id: t.claudeId, tool_response: response });
        expect([t.tasks(), t.h.session.runningSubagents()]).toEqual([[], 0]);
        expect(t.tool(CALL.spawn)).toMatchObject({ status: 'ok' });
      },
    );
  });

  describe('Stop, which Codex gives no list of background tasks', () => {
    it('closes the turn and leaves the running subagent task alone', async () => {
      const { t, feed } = await codexTerminal();
      feed(0, AT.spawnEnd);
      feed(AT.stop);
      expect(t.turns()).toMatchObject([{ closedAt: expect.any(Number), resultSubtype: 'success' }]);
      expect(t.tasks()).toMatchObject([{ id: SUBAGENT, endedAt: null }]);
      expect([t.h.session.runningSubagents(), t.h.session.isIdle(), t.heard.taskEnds]).toEqual([1, false, []]);
    });
  });
});
