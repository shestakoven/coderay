import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatItem } from '@ide/protocol';
import { argValue } from '../fake-claude/fake';
import { sent } from '../fake-codex/fake';
import { fixture, waitFor } from '../helpers';
import { AWAIT, build, HOLD_OPEN, INIT, type Built } from './harness';

describe('A plan waiting for an answer in a Codex chat', () => {
  it('is withdrawn when the turn ends with its propose_plan call still open, since its answer would reach nobody', async () => {
    const proposing = JSON.stringify({
      method: 'item/started',
      params: { threadId: '$THREAD', turnId: '$TURN', item: { type: 'mcpToolCall', id: 'call-plan', server: 'idecore', tool: 'propose_plan', status: 'inProgress', arguments: {} } },
    });
    const b = await build({ scenario: [codexSay('m1', 'OK'), TURN, proposing], engine: 'codex' });
    b.session.send('hi');
    await closed(b, 1);
    void b.rt.gate.plans.propose({ goal: 'Rework app', steps: [{ key: 'edit', title: 'Edit', rationale: '', targets: [{ componentId: 'app', op: 'modify' }] }] });
    await waitFor(() => b.rt.gate.plans.plans().some((proposed) => proposed.status === 'proposed'), 'the plan waits for an answer');
    b.session.send('plan it');
    await closed(b, 2);
    expect(b.rt.gate.plans.plans().map((plan) => [plan.status, plan.feedback])).toEqual([['withdrawn', "The agent's turn ended while the plan waited for an answer."]]);
  });

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

type EngineName = 'claude' | 'codex';
const RESULT = '{"type":"result","subtype":"success","is_error":false,"result":"","session_id":"$SESSION"}';
const say = (words: string): string => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: words }] }, parent_tool_use_id: null, session_id: '$SESSION' });
const EDIT = JSON.stringify({ fake: 'tool', id: 'toolu_edit', name: 'Edit', input: { file_path: '$CWD/src/other.ts', old_string: 'helo', new_string: 'hello' }, result: 'The file was updated.', apply: true });
const TURN = '{"fake":"await-turn"}';
const codexSay = (id: string, words: string): string =>
  JSON.stringify({ method: 'item/completed', params: { threadId: '$THREAD', turnId: '$TURN', item: { type: 'agentMessage', id, text: words, phase: 'final_answer' } } });
// A command that only reads: it runs in Codex's read-only sandbox and never reaches the gate.
const LS = { type: 'commandExecution', id: 'cmd-ls', command: "/bin/zsh -lc 'ls src'", cwd: '$CWD', commandActions: [{ type: 'listFiles', command: 'ls src' }] };
const codexRead = [
  JSON.stringify({ method: 'item/started', params: { threadId: '$THREAD', turnId: '$TURN', item: { ...LS, status: 'inProgress', aggregatedOutput: null, exitCode: null } } }),
  JSON.stringify({ method: 'item/completed', params: { threadId: '$THREAD', turnId: '$TURN', item: { ...LS, status: 'completed', aggregatedOutput: 'app.ts\nother.ts\n', exitCode: 0 } } }),
];

// The same behaviour in each engine's own words: the suite's assertions are engine-neutral.
const SCENARIOS: Record<'reply' | 'stop' | 'write' | 'resume', Record<EngineName, string | string[]>> = {
  reply: { claude: [AWAIT, INIT, say('OK'), RESULT, AWAIT], codex: [...codexRead, codexSay('m1', 'OK')] },
  stop: { claude: [AWAIT, INIT, HOLD_OPEN, AWAIT, INIT, say('Back.'), RESULT, AWAIT], codex: [HOLD_OPEN, TURN, codexSay('m2', 'Back.')] },
  write: { claude: [AWAIT, INIT, say('Ready.'), RESULT, AWAIT, INIT, EDIT, say('Done.'), RESULT, AWAIT], codex: fixture('codex/patch.jsonl') },
  resume: { claude: [AWAIT, INIT, say('OK'), RESULT, AWAIT, INIT, say('42'), RESULT, AWAIT], codex: fixture('codex/multi-turn.jsonl') },
};
const PREVIEW: Record<EngineName, object> = {
  claude: { kind: 'edit', oldString: 'helo', newString: 'hello' },
  codex: { kind: 'patch', diff: "@@ -1 +1 @@\n-export const other = 'helo';\n+export const other = 'hello';\n" },
};

const noticesOf = (b: Built): string[] => b.session.state().items.flatMap((item) => (item.kind === 'notice' ? [item.text] : []));
const closed = (b: Built, count: number) => waitFor(() => b.session.state().turns.filter((turn) => turn.closedAt !== null).length === count, `${count} turns closed`);
const says = (b: Built): string[] => b.session.state().items.flatMap((item: ChatItem) => (item.kind === 'message' && item.role === 'assistant' ? [item.text] : []));
const decisionOf = (b: Built) => b.session.state().items.flatMap((item) => (item.kind === 'tool' ? [item.decision] : []))[0];
const other = (b: Built): string => readFileSync(join(b.root, 'src/other.ts'), 'utf8');
const conversation = (b: Built): string | undefined => b.store.session(b.session.sessionId()!)?.engineSessionId;

async function startPlan(b: Built): Promise<void> {
  const outcome = await b.rt.gate.plans.propose({ goal: 'Fix the greeting', steps: [{ key: 'edit', title: 'Fix the greeting', rationale: 'typo', targets: [{ path: 'src/app.ts', op: 'modify' }] }] });
  expect([outcome, b.rt.gate.plans.step({ key: 'edit', phase: 'start' })]).toMatchObject([{ ok: true, value: { status: 'approved' } }, { ok: true }]);
}

describe.each(['claude', 'codex'] as const)('the %s engine', (engine) => {
  const make = (scenario: keyof typeof SCENARIOS, extra: Partial<Parameters<typeof build>[0]> = {}) => build({ scenario: SCENARIOS[scenario][engine], engine, ...extra });

  it('answers a message: the reply comes in and the turn ends, with no notice and nothing the agent ran taken for a fail-open', async () => {
    const b = await make('reply');
    b.session.send('hi');
    await closed(b, 1);
    const decided = b.session.state().items.flatMap((item) => (item.kind === 'tool' && item.decision !== null ? [item.decision] : []));
    expect([says(b), b.session.state().turns[0]?.resultSubtype, noticesOf(b), decided]).toEqual([['OK'], 'success', [], []]);
  });

  it('ends a turn within a second on Stop, and answers the next message', async () => {
    const b = await make('stop');
    await b.send();
    await waitFor(() => b.session.state().turns.some((turn) => turn.startedAt !== null), 'the turn started');
    const before = conversation(b);
    const at = Date.now();
    b.session.stop();
    await closed(b, 1);
    const took = Date.now() - at;
    b.session.send('again');
    await closed(b, 2);
    expect([b.session.state().turns[0]?.resultSubtype, took < 1000, says(b), conversation(b)]).toEqual(['error_during_execution', true, ['Back.'], before]);
  });

  it('holds a write outside the approved plan for the user, showing what it changes, and lets it land once allowed', async () => {
    const b = await make('write', { mode: 'B' });
    b.session.send('ready?');
    await closed(b, 1);
    await startPlan(b);
    b.session.send('fix the other file too');
    const prompt = await waitFor(() => b.rt.gate.gate.pending()[0], 'the write waits for the user');
    b.rt.gate.gate.answer(prompt.id, 'allow-once');
    await closed(b, 2);
    expect([prompt.summary, prompt.preview, other(b), decisionOf(b)]).toMatchObject(['src/other.ts', PREVIEW[engine], "export const other = 'hello';\n", 'ask-approved']);
  });

  it('resumes the same conversation after the core restarts', async () => {
    const b = await make('resume');
    b.session.send('hi');
    await closed(b, 1);
    const before = conversation(b);
    await b.session.close();
    await b.rt.close();
    const again = await build({ scenario: SCENARIOS.resume[engine], engine, from: b });
    again.session.send('again');
    await closed(again, 2);
    const resumed = engine === 'claude'
      ? argValue(again.records().findLast((record) => record.argv !== undefined)?.argv, '--resume')
      : (sent(again.codexRecords(), 'thread/resume')[0] as { threadId?: string } | undefined)?.threadId;
    expect([resumed, typeof before]).toEqual([before, 'string']);
  });

  it('starts no agent while the watchdog is not ready, says why, and answers once it is', async () => {
    const b = await build({ scenario: SCENARIOS.reply[engine], engine, start: false });
    let refused: unknown = null;
    try {
      b.session.send('hi');
    } catch (error) {
      refused = error;
    }
    const said = noticesOf(b);
    await b.rt.start();
    b.session.send('hi');
    await closed(b, 1);
    expect([(refused as { code?: string } | null)?.code, said.some((text) => text.includes('the watchdog is not ready yet')), says(b)]).toEqual(['no-gate', true, ['OK']]);
  });
});
