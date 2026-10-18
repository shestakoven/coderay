import { describe, expect, it } from 'vitest';
import { askCalls, judgeAsk, readAsk, type Ask } from '../../src/agent/opencode/permissions';

const DIFF = '--- /p/a.ts\n+++ /p/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
const ask = (permission: string, extra: Partial<Ask> = {}): Ask => ({ id: 'per_1', sessionID: 'ses_1', permission, patterns: [], metadata: {}, callID: 'call_1', ...extra });
const calls = (a: Ask, input?: Record<string, unknown>) => askCalls(a, input, '/p', ['general', 'explore'], new Set(['ses_1', 'ses_child']), ['idecore', 'files']);
const base = { tool_use_id: 'call_1', cwd: '/p' };
// One entry of an apply_patch ask's metadata.files, as 1.19 sends it.
const file = (filePath: string, type: string, extra: Record<string, unknown> = {}) =>
  ({ filePath, relativePath: filePath.slice(3), type, patch: `diff of ${filePath}`, additions: 1, deletions: 0, ...extra });

describe('readAsk', () => {
  it('reads the shape 1.19 sends and refuses one without an id, a session or a permission', () => {
    const full = readAsk({ id: 'per_1', sessionID: 'ses_1', permission: 'edit', patterns: ['a.ts', 7], metadata: { diff: DIFF, filepath: '/p/a.ts' }, always: ['*'], tool: { messageID: 'msg_1', callID: 'call_1' } });
    const bare = readAsk({ id: 'per_2', sessionID: 'ses_1', permission: 'bash', patterns: 'ls', metadata: 'ls' });
    const broken = [{ sessionID: 'ses_1', permission: 'bash' }, { id: 'per_3', permission: 'bash' }, { id: 'per_3', sessionID: 'ses_1' }, null].map(readAsk);
    expect([full, bare, ...broken]).toEqual([
      { id: 'per_1', sessionID: 'ses_1', permission: 'edit', patterns: ['a.ts'], metadata: { diff: DIFF, filepath: '/p/a.ts' }, callID: 'call_1' },
      { id: 'per_2', sessionID: 'ses_1', permission: 'bash', patterns: [], metadata: {}, callID: null },
      null, null, null, null,
    ]);
  });
});

describe('askCalls', () => {
  it.each([
    ['an edit → Edit with its diff, the relative path resolved', ask('edit', { patterns: ['a.ts'], metadata: { diff: DIFF, filepath: 'a.ts' } }), { oldString: 'a' }, [{ ...base, tool_name: 'Edit', tool_input: { file_path: '/p/a.ts', diff: DIFF } }]],
    ['a new file → Write with the diff as its content', ask('edit', { metadata: { diff: DIFF, filepath: '/p/new.ts' } }), { oldString: '' }, [{ ...base, tool_name: 'Write', tool_input: { file_path: '/p/new.ts', content: DIFF } }]],
    ['an edit asked before its input is known → Edit', ask('edit', { metadata: { diff: DIFF, filepath: '/p/a.ts' } }), undefined, [{ ...base, tool_name: 'Edit', tool_input: { file_path: '/p/a.ts', diff: DIFF } }]],
    ['a patch → one call per file, in order, each with its own diff', ask('edit', { patterns: ['a.ts', 'new.ts', 'old.ts', 'mv.ts'], metadata: { diff: DIFF, filepath: 'a.ts, new.ts, old.ts, mv.ts', files: [file('/p/a.ts', 'update'), file('/p/new.ts', 'add'), file('/p/old.ts', 'delete'), file('/p/mv.ts', 'move', { relativePath: 'moved.ts', movePath: '/p/moved.ts' })] } }), {}, [
      { ...base, tool_name: 'Edit', tool_input: { file_path: '/p/a.ts', diff: 'diff of /p/a.ts' } },
      { ...base, tool_name: 'Write', tool_input: { file_path: '/p/new.ts', content: 'diff of /p/new.ts' } },
      { ...base, tool_name: 'Bash', tool_input: { command: "rm -- '/p/old.ts'" } },
      { ...base, tool_name: 'Bash', tool_input: { command: "mv -- '/p/mv.ts' '/p/moved.ts'" } },
      { ...base, tool_name: 'Edit', tool_input: { file_path: '/p/moved.ts', diff: 'diff of /p/mv.ts' } },
    ]],
    ['a bash → Bash with the whole command line, not its first node', ask('bash', { patterns: ['ls', 'rm -rf src'], metadata: { command: 'ls && rm -rf src' } }), { command: 'ls && rm -rf src', description: 'clean' }, [{ ...base, tool_name: 'Bash', tool_input: { command: 'ls && rm -rf src', description: 'clean' } }]],
    ['a bash in another workdir → judged there', ask('bash', { metadata: { command: 'rm -rf src' } }), { command: 'rm -rf src', workdir: '../elsewhere' }, [{ ...base, cwd: '/elsewhere', tool_name: 'Bash', tool_input: { command: 'rm -rf src' } }]],
    ['a webfetch → WebFetch with the url', ask('webfetch', { patterns: ['https://x/'] }), undefined, [{ ...base, tool_name: 'WebFetch', tool_input: { url: 'https://x/' } }]],
    ['a websearch → WebSearch with the query', ask('websearch', { patterns: ['opencode'] }), undefined, [{ ...base, tool_name: 'WebSearch', tool_input: { query: 'opencode' } }]],
    ['a task for a checked subagent, asked before its input is known → Task', ask('task', { patterns: ['general'], metadata: { description: 'look', subagent_type: 'general' } }), undefined, [{ ...base, tool_name: 'Task', tool_input: { subagent_type: 'general' } }]],
    ['a task resuming a session this chat created → Task with it', ask('task', { patterns: ['explore'] }), { subagent_type: 'explore', task_id: 'ses_child' }, [{ ...base, tool_name: 'Task', tool_input: { subagent_type: 'explore', task_id: 'ses_child' } }]],
    ["an IDE server's tool → its mcp name with the tool's input", ask('files_write_note'), { text: 'hi' }, [{ ...base, tool_name: 'mcp__files__write_note', tool_input: { text: 'hi' } }]],
    ["an external directory → a read of each pattern, under an id of its own: the call's own ask may follow", ask('external_directory', { patterns: ['/elsewhere/*'], metadata: { filepath: '/elsewhere/a.ts', parentDir: '/elsewhere' } }), undefined, [{ ...base, tool_use_id: 'call_1:external_directory', tool_name: 'Read', tool_input: { file_path: '/elsewhere/*' } }]],
  ])('%s', (_name, input, state, expected) => {
    expect(calls(input, state)).toEqual(expected);
  });

  it.each([
    ['a task for a subagent that did not pass the self-check', ask('task', { patterns: ['loose'] }), { subagent_type: 'loose' }],
    ['a task resuming a session this chat did not create', ask('task', { patterns: ['general'] }), { subagent_type: 'general', task_id: 'ses_other' }],
    ['an edit with no diff', ask('edit', { metadata: { filepath: '/p/a.ts' } }), {}],
    ['an edit naming its file only in patterns, which are relative to the worktree', ask('edit', { patterns: ['a.ts'], metadata: { diff: DIFF } }), {}],
    ['a patch whose file list has an unknown change type', ask('edit', { metadata: { diff: DIFF, files: [file('/p/a.ts', 'update'), file('/p/b.ts', 'rename')] } }), {}],
    ['a patch with a move that names no destination', ask('edit', { metadata: { diff: DIFF, files: [file('/p/a.ts', 'move')] } }), {}],    ['a patch whose file list is not a list', ask('edit', { metadata: { diff: DIFF, filepath: '/p/a.ts', files: { path: '/p/b.ts' } } }), {}],
    ['a bash with no command', ask('bash', { patterns: ['ls'] }), { command: 'ls' }],
    ['a bash with no input known for its workdir', ask('bash', { metadata: { command: 'ls' } }), undefined],
    ['a bash in a shell the gate cannot read', ask('bash', { metadata: { command: 'fish -c "rm x"' } }), { command: 'fish -c "rm x"' }],
    ['an ask with no tool call to pin the row to', ask('bash', { metadata: { command: 'ls' }, callID: null }), { command: 'ls' }],
    ["an ask for idecore's tools, which its rule allows", ask('idecore_propose_plan'), {}],
    ['a permission CodeRay does not know', ask('doctor', { patterns: ['x'] }), {}],
  ])('has no call for %s', (_name, input, state) => {
    expect(calls(input, state)).toEqual([]);
  });

  it("has no call for a bash naming any of the server's secrets", () => {
    const named = ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PID'].map((name) => `printenv ${name}`);
    expect(named.map((command) => calls(ask('bash', { metadata: { command } }), { command }))).toEqual([[], [], []]);
  });
});

describe('judgeAsk', () => {
  const one = calls(ask('bash', { metadata: { command: 'ls' } }), { command: 'ls' });
  it('answers once on allow, reject with the reason on a guard denial, a plain reject on a final denial, a gate failure or no calls, and nothing once Stop came', async () => {
    const abort = new AbortController();
    const held = judgeAsk(one, (_calls, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(null))), abort.signal);
    abort.abort();
    const live = () => new AbortController().signal;
    expect(await Promise.all([
      judgeAsk(one, async () => ({ permissionDecision: 'allow', permissionDecisionReason: 'in plan' }), live()),
      judgeAsk(one, async () => ({ permissionDecision: 'deny', permissionDecisionReason: 'CodeRay: no approved plan covers a.txt' }), live()),
      judgeAsk(one, async () => ({ permissionDecision: 'deny', permissionDecisionReason: 'CodeRay: the user denied this call', final: true }), live()),
      judgeAsk(one, async () => ({ permissionDecision: 'deny', permissionDecisionReason: '' }), live()),
      judgeAsk(one, async () => { throw new Error('gate down'); }, live()),
      judgeAsk([], async () => ({ permissionDecision: 'allow', permissionDecisionReason: '' }), live()),
      judgeAsk(one, undefined, live()),
      held,
      judgeAsk(one, async () => ({ permissionDecision: 'allow', permissionDecisionReason: 'in plan' }), abort.signal),
      judgeAsk(one, async () => { throw new Error('closed'); }, abort.signal),
    ])).toEqual([
      { reply: 'once' }, { reply: 'reject', message: 'CodeRay: no approved plan covers a.txt' }, { reply: 'reject' }, { reply: 'reject' }, { reply: 'reject' }, { reply: 'reject' }, { reply: 'reject' },
      null, null, null,
    ]);
  });
});
