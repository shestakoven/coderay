import { describe, expect, it } from 'vitest';
import { OpencodeEvents, toolName } from '../../src/agent/opencode/events';

const S = 'ses_1';
const part = (extra: object) => ({ type: 'message.part.updated', properties: { part: { id: 'prt_1', sessionID: S, messageID: 'msg_1', ...extra } } });
// As 1.19 records them: a pending part carries no input yet, a running one the whole input.
const tool = (callID: string, name: string, state: object, input: object = {}, sessionID = S) =>
  part({ id: `prt_${callID}`, type: 'tool', callID, tool: name, state: { input, ...state }, sessionID });
const delta = (partID: string, text: string, sessionID = S, field = 'text') => ({ type: 'message.part.delta', properties: { sessionID, messageID: 'msg_1', partID, field, delta: text } });
const idle = (sessionID = S) => ({ type: 'session.idle', properties: { sessionID } });
const error = (name: string, message: string, sessionID: string | null = S) =>
  ({ type: 'session.error', properties: { ...(sessionID === null ? {} : { sessionID }), error: { name, data: { message } } } });

function events(servers = ['idecore']): OpencodeEvents {
  const e = new OpencodeEvents(servers);
  e.session(S, 'opencode/nemotron-3.5-lightning-free', '1.19.0', 262144);
  return e;
}

describe('toolName', () => {
  it.each([
    ['bash', {}, 'Bash'], ['read', {}, 'Read'], ['glob', {}, 'Glob'], ['grep', {}, 'Grep'], ['list', {}, 'LS'], ['webfetch', {}, 'WebFetch'], ['websearch', {}, 'WebSearch'], ['codesearch', {}, 'Grep'], ['lsp', {}, 'LSP'], ['task', {}, 'Task'], ['todowrite', {}, 'TodoWrite'], ['question', {}, 'AskUserQuestion'], ['skill', {}, 'Skill'],
    ['edit', { filePath: '/p/a.ts', oldString: 'a', newString: 'b' }, 'Edit'], ['edit', { filePath: '/p/new.ts', oldString: '', newString: 'x' }, 'Write'], ['write', { filePath: '/p/new.ts', content: 'x' }, 'Write'],
    ['apply_patch', { patchText: '*** Update File: a.ts' }, 'Edit'], ['apply_patch', { patchText: '*** Add File: new.ts\n+x' }, 'Write'], ['apply_patch', { patchText: '*** Add File: new.ts\n+x\n*** Delete File: old.ts' }, 'Edit'],
    ['idecore_propose_plan', {}, 'mcp__idecore__propose_plan'], ['files_list_dir', {}, 'mcp__files__list_dir'], ['files_x_list', {}, 'mcp__files_x__list'], ['unknown_thing', {}, 'unknown_thing'],
  ])('%s → %s', (name, input, expected) => {
    expect(toolName(name, input, ['idecore', 'files', 'files_x'])).toBe(expected);
  });
});

describe('OpencodeEvents', () => {
  it("streams the reply's deltas, replaces them with the completed text, and reads reasoning as thinking, never as the reply", () => {
    const e = events();
    const out = [
      ...e.handle(part({ id: 'prt_u', type: 'text', text: 'Say OK' })),
      // 1.19 streams reasoning as `text` deltas of a part it shows only once it ends.
      ...e.handle(delta('prt_r', 'hm')),
      ...e.handle(part({ id: 'prt_r', type: 'reasoning', text: 'hm', time: { start: 1, end: 2 } })),
      ...e.handle(part({ id: 'prt_e', type: 'reasoning', text: '', time: { start: 2, end: 3 } })),
      ...e.handle(part({ type: 'text', text: '', time: { start: 3 } })),
      ...e.handle(delta('prt_1', 'O')),
      // Only a text field is the reply's.
      ...e.handle(delta('prt_1', '{}', S, 'metadata')),
      ...e.handle(delta('prt_1', 'K')),
      ...e.handle(part({ type: 'text', text: 'OK', time: { start: 3, end: 4 } })),
    ];
    expect(out).toEqual([
      { type: 'assistant', parentToolUseId: null, blocks: [{ kind: 'thinking', text: 'hm' }] },
      { type: 'text_delta', parentToolUseId: null, text: 'O' }, { type: 'text_delta', parentToolUseId: null, text: 'K' },
      { type: 'assistant', parentToolUseId: null, blocks: [{ kind: 'text', text: 'OK' }] },
    ]);
  });

  it("shows a tool once when it runs, with Claude's name and the file path or command, and its result once when it ends, rejected when the user said no, failed when its command did", () => {
    const e = events();
    const edit = { filePath: '/p/a.ts', oldString: 'a', newString: 'b' };
    const out = [
      ...e.handle(tool('c1', 'edit', { status: 'pending' })),
      ...e.handle(tool('c1', 'edit', { status: 'running' }, edit)),
      ...e.handle(tool('c1', 'edit', { status: 'running' }, edit)),
      ...e.handle(tool('c1', 'edit', { status: 'error', error: 'The user rejected permission to use this specific tool call with the following feedback: no' }, edit)),
      ...e.handle(tool('c2', 'bash', { status: 'running' }, { command: 'ls', workdir: '/p/sub', description: 'list' })),
      ...e.handle(tool('c2', 'bash', { status: 'completed', output: 'a\nb\n', metadata: { exit: 0 } }, { command: 'ls', workdir: '/p/sub', description: 'list' })),
      ...e.handle(tool('c3', 'bash', { status: 'running' }, { command: 'false' })),
      ...e.handle(tool('c3', 'bash', { status: 'completed', output: '', metadata: { exit: 1 } }, { command: 'false' })),
      ...e.handle(tool('c4', 'apply_patch', { status: 'running' }, { patchText: '*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** Add File: new.ts\n+x\n*** End Patch' })),
    ];
    expect(out).toEqual([
      { type: 'assistant', parentToolUseId: null, blocks: [{ kind: 'tool_use', id: 'c1', name: 'Edit', input: { file_path: '/p/a.ts' } }] },
      { type: 'user', parentToolUseId: null, toolResults: [{ toolUseId: 'c1', isError: true, rejected: true, text: 'The user rejected permission to use this specific tool call with the following feedback: no', images: [] }] },
      { type: 'assistant', parentToolUseId: null, blocks: [{ kind: 'tool_use', id: 'c2', name: 'Bash', input: { command: 'ls', workdir: '/p/sub' } }] },
      { type: 'user', parentToolUseId: null, toolResults: [{ toolUseId: 'c2', isError: false, rejected: false, text: 'a\nb\n', images: [] }] },
      { type: 'assistant', parentToolUseId: null, blocks: [{ kind: 'tool_use', id: 'c3', name: 'Bash', input: { command: 'false' } }] },
      { type: 'user', parentToolUseId: null, toolResults: [{ toolUseId: 'c3', isError: true, rejected: false, text: '', images: [] }] },
      { type: 'assistant', parentToolUseId: null, blocks: [{ kind: 'tool_use', id: 'c4', name: 'Edit', input: { file_path: 'a.ts', files: ['a.ts', 'new.ts'] } }] },
    ]);
  });

  it("opens a turn with the chat's model and skills, reads the meter from the last step's whole prompt against the model's limit, and ends the turn on idle", () => {
    const e = events();
    e.setModel('opencode/big-pickle', 200000);
    e.setSkills(['pdf']);
    const init = e.turnStarted();
    const usage = e.handle(part({ type: 'step-finish', tokens: { total: 1300, input: 1000, output: 20, reasoning: 0, cache: { read: 180, write: 100 } }, cost: 0 }));
    const ended = e.handle(idle());
    expect([init, usage, ended, e.busy()]).toEqual([
      [{ type: 'init', sessionId: S, model: 'opencode/big-pickle', cliVersion: '1.19.0', permissionMode: null, mcpServers: [], skills: ['pdf'] }],
      [{ type: 'usage', update: { contextTokens: 1280, contextWindow: 200000 } }],
      [{ type: 'result', subtype: 'success', origin: null }],
      false,
    ]);
  });

  it("ends a stopped turn as stopped, and lets neither its tool's late end nor its second idle end the next turn", () => {
    const e = events();
    const busy = { type: 'session.status', properties: { sessionID: S, status: { type: 'busy' } } };
    e.turnStarted();
    e.handle(tool('c1', 'bash', { status: 'running' }, { command: 'sleep 9' }));
    e.interrupted();
    // 1.19's order after /abort: the abort error, idle, the tool's end, idle again.
    const stopped = [...e.handle(error('MessageAbortedError', 'Aborted')), ...e.handle(idle())];
    e.turnStarted();
    const late = [...e.handle(tool('c1', 'bash', { status: 'error', error: 'Tool execution aborted' }, { command: 'sleep 9' })), ...e.handle(idle())];
    const stillBusy = e.busy();
    const next = [...e.handle(busy), ...e.handle(idle())];
    // The fake sends one idle after a stop: the next turn's own start lets its idle through.
    e.turnStarted();
    e.interrupted();
    e.handle(idle());
    e.turnStarted();
    const afterFake = [...e.handle(busy), ...e.handle(idle())];
    expect([stopped, late, stillBusy, next, afterFake]).toEqual([
      [
        { type: 'user', parentToolUseId: null, toolResults: [{ toolUseId: 'c1', isError: true, rejected: false, text: 'unfinished', images: [] }] },
        { type: 'result', subtype: 'error_during_execution', origin: null },
      ],
      [], true, [{ type: 'result', subtype: 'success', origin: null }], [{ type: 'result', subtype: 'success', origin: null }],
    ]);
  });

  it("ignores an idle with no turn open, another session's parts, heartbeats and an error with no session, names an event it does not know, and shows the chat's error once before failing that turn only", () => {
    const e = events();
    const early = e.handle(idle());
    e.turnStarted();
    const out = [
      ...e.handle(part({ type: 'text', text: 'theirs', sessionID: 'ses_other', time: { start: 1, end: 2 } })),
      ...e.handle({ type: 'server.heartbeat', properties: {} }),
      ...e.handle({ type: 'vcs.branch.updated', properties: {} }),
      ...e.handle(error('UnknownError', 'a skill of yours is broken', null)),
      ...e.handle(error('UnknownError', 'the provider answered 500\n    at retry (chunk.js:1:2)')),
      ...e.handle(error('UnknownError', 'the provider answered 500')),
      ...e.handle(idle()),
    ];
    e.turnStarted();
    const clean = e.handle(idle());
    e.turnStarted();
    const again = [...e.handle(error('UnknownError', 'the provider answered 500')), ...e.handle(idle())];
    const failed = [{ type: 'notice', text: 'opencode: the provider answered 500' }, { type: 'result', subtype: 'failed', origin: null }];
    expect([early, out, clean, again]).toEqual([[], [{ type: 'unknown', label: 'vcs.branch.updated' }, ...failed], [{ type: 'result', subtype: 'success', origin: null }], failed]);
  });

  it("adopts each child session's parts under the task call that started it, closes the tools still open at idle, keeps a call's input once it runs and until the next turn, and owns no stranger", () => {
    const e = events();
    e.turnStarted();
    const created = (id: string, parentID?: string) => ({ type: 'session.created', properties: { sessionID: id, info: { id, ...(parentID ? { parentID } : {}), directory: '/p' } } });
    const out = [
      ...e.handle(tool('c_read', 'read', { status: 'running' }, { filePath: '/p/a.ts' })),
      ...e.handle(tool('c_task', 'task', { status: 'running' }, { subagent_type: 'general' })),
      ...e.handle(tool('c_task2', 'task', { status: 'running' }, { subagent_type: 'explore' })),
      ...e.handle(created('ses_child', S)),
      ...e.handle(created('ses_child2', S)),
      // A root session has no parentID key at all.
      ...e.handle(created('ses_stranger')),
      ...e.handle(created('ses_strangers_child', 'ses_other')),
      ...e.handle(tool('c_read', 'read', { status: 'completed', output: 'a' }, { filePath: '/p/a.ts' })),
      ...e.handle(tool('c9', 'bash', { status: 'pending' }, {}, 'ses_child')),
      ...e.handle(tool('c9', 'bash', { status: 'running' }, { command: 'pwd', workdir: '/p/sub' }, 'ses_child')),
      ...e.handle(part({ id: 'prt_ct', type: 'text', text: '', time: { start: 1 }, sessionID: 'ses_child' })),
      ...e.handle(delta('prt_ct', 'looking', 'ses_child')),
      ...e.handle(part({ type: 'step-finish', tokens: { total: 15, input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, sessionID: 'ses_child' })),
      ...e.handle(idle('ses_child')),
    ];
    // The transport adopts the children it sees as well: a second adoption changes nothing.
    e.adopt('ses_child2', S);
    out.push(...e.handle(tool('c10', 'glob', { status: 'running' }, { pattern: '*.ts' }, 'ses_child2')), ...e.handle(tool('c11', 'webfetch', { status: 'pending' })), ...e.handle(idle()));
    const kept = e.input('c9');
    e.turnStarted();
    expect([
      out.map((event) => (event.type === 'assistant' || event.type === 'user' || event.type === 'text_delta' ? [event.type, event.parentToolUseId] : event.type)),
      ['ses_child', 'ses_stranger', 'ses_strangers_child'].map((id) => e.owns(id)), kept, e.input('c11'), e.input('c9'),
    ]).toEqual([
      [['assistant', null], ['assistant', null], ['assistant', null], ['user', null], ['assistant', 'c_task'], ['text_delta', 'c_task'], ['assistant', 'c_task2'], ['user', null], ['user', null], ['user', 'c_task'], ['user', 'c_task2'], 'result'],
      [true, false, false], { command: 'pwd', workdir: '/p/sub' }, undefined, undefined,
    ]);
  });
});
