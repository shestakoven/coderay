import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ToolItem } from '@ide/protocol';
import { AGENT_EVENT_SCRIPT, HOOK_SCRIPT } from '../../src/hook/gate-files';
import { waitFor } from '../helpers';
import { build, WAIT_TURN } from './harness';

interface Settings {
  hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]>;
}

const flag = (argv: readonly string[] | undefined, name: string) => {
  const at = argv?.indexOf(name) ?? -1;
  return at === -1 ? undefined : argv?.[at + 1];
};
const readSettings = (path: string | undefined): Settings => JSON.parse(readFileSync(path ?? '', 'utf8')) as Settings;
const hookNames = (settings: Settings) => Object.keys(settings.hooks).sort();
const WITH_EVENTS = ['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionStart', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'];
const CHAT_HOOKS = ['PreToolUse', 'SessionStart', 'Stop'];

describe('the execution runtime and the agent in the terminal', { timeout: 30_000 }, () => {
  describe('the hook settings it writes', () => {
    it('passes the events flag on to the hook settings of a terminal', async () => {
      const b = await build({ scenario: WAIT_TURN });
      expect(hookNames(readSettings(b.rt.sessionGate.write('s-terminal', true).settingsPath))).toEqual(WITH_EVENTS);
    });

    it.each([[undefined], [false]])('writes only the end of the turn as an event hook for the chat of a session when events is %s', async (events) => {
      const b = await build({ scenario: WAIT_TURN });
      expect(hookNames(readSettings(b.rt.sessionGate.write('s-chat', events).settingsPath))).toEqual(CHAT_HOOKS);
    });

    it('writes the event hooks into the settings a terminal starts with', async () => {
      const b = await build({ scenario: WAIT_TURN, claudeEnv: { FAKE_CLAUDE_HOOKS: 'on' } });
      const launch = await b.session.terminalLaunch();
      expect(launch).not.toBeNull();
      expect(hookNames(readSettings(flag(launch?.args, '--settings')))).toEqual(WITH_EVENTS);
    });

    it('writes only the end of the turn into the settings a chat starts with', async () => {
      const b = await build({ scenario: WAIT_TURN, claudeEnv: { FAKE_CLAUDE_HOOKS: 'on' } });
      await b.send();
      const argv = await waitFor(() => b.records().find((record) => record.argv)?.argv, 'claude started');
      expect(hookNames(readSettings(flag(argv, '--settings')))).toEqual(CHAT_HOOKS);
    });
  });

  // The hook commands are the ones claude would run: the events travel through the real scripts, the real routes and the real session.
  describe('the hooks of an open terminal, run as claude runs them', () => {
    async function terminal() {
      const b = await build({ scenario: WAIT_TURN, claudeEnv: { FAKE_CLAUDE_HOOKS: 'on' } });
      const launch = await b.session.terminalLaunch();
      if (launch === null) throw new Error('the terminal did not open');
      const settings = readSettings(flag(launch.args, '--settings'));
      const claudeId = b.session.state().session?.claudeSessionId as string;
      const payload = (name: string, fields: object = {}) => ({
        hook_event_name: name, session_id: claudeId, transcript_path: '/nonexistent/claude.jsonl', cwd: b.root, permission_mode: 'default', ...fields,
      });
      const run = (script: string, name: string, fields: object = {}) =>
        new Promise<{ code: number | null; stdout: string }>((resolve) => {
          const command = settings.hooks[name]?.flatMap((entry) => entry.hooks).find((hook) => hook.args[0] === script);
          if (!command) throw new Error(`no ${name} hook runs ${script}`);
          const child = spawn(command.command, command.args, { stdio: ['pipe', 'pipe', 'ignore'] });
          let stdout = '';
          child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
          child.on('close', (code) => resolve({ code, stdout }));
          child.stdin.end(JSON.stringify(payload(name, fields)));
        });
      return {
        b,
        event: (name: string, fields?: object) => run(AGENT_EVENT_SCRIPT, name, fields),
        gate: (fields: object) => run(HOOK_SCRIPT, 'PreToolUse', fields),
        tool: (id: string) => b.session.state().items.find((item): item is ToolItem => item.kind === 'tool' && item.id === id),
      };
    }

    it('opens a turn from a UserPromptSubmit and closes it from a Stop', async () => {
      const t = await terminal();
      expect(await t.event('UserPromptSubmit', { prompt: 'fix the login' })).toEqual({ code: 0, stdout: '' });
      expect([t.b.session.hasOpenTurn(), t.b.session.state().items.map((item) => item.kind === 'message' && item.text)]).toEqual([true, ['fix the login']]);
      expect(await t.event('Stop', { last_assistant_message: 'Fixed it.', stop_hook_active: false, background_tasks: [] })).toEqual({ code: 0, stdout: '' });
      expect([t.b.session.hasOpenTurn(), t.b.session.isIdle()]).toEqual([false, true]);
    });

    it('follows a call from the gate hook to its result', async () => {
      const t = await terminal();
      await t.event('UserPromptSubmit', { prompt: 'read the notes' });
      const call = { tool_name: 'Read', tool_input: { file_path: `${t.b.root}/notes.txt` }, tool_use_id: 'toolu_read' };
      expect((await t.gate(call)).code).toBe(0);
      await waitFor(() => t.tool('toolu_read'), 'the call shown');
      expect(t.tool('toolu_read')).toMatchObject({ tool: 'Read', status: 'running' });
      await t.event('PostToolUse', { ...call, tool_response: { file: { content: 'notes' } } });
      expect(t.tool('toolu_read')).toMatchObject({ status: 'ok' });
    });

    it('hands a note queued for the user to claude in the output of the next UserPromptSubmit hook', async () => {
      const t = await terminal();
      t.b.session.queueNote('the build is red');
      const { code, stdout } = await t.event('UserPromptSubmit', { prompt: 'continue' });
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining('the build is red') } });
    });

    it('hands an absorbed note to claude in the output of the next PostToolUse hook', async () => {
      const t = await terminal();
      await t.event('UserPromptSubmit', { prompt: 'fix the login' });
      t.b.session.sendAbsorbed('stay inside src/auth');
      const { stdout } = await t.event('PostToolUse', { tool_name: 'Read', tool_input: {}, tool_use_id: 'toolu_1', tool_response: {} });
      expect(JSON.parse(stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: expect.stringContaining('stay inside src/auth') } });
    });

    it('makes claude go on, by the output of the Stop hook, when a note came too late for a tool step', async () => {
      const t = await terminal();
      await t.event('UserPromptSubmit', { prompt: 'fix the login' });
      t.b.session.sendAbsorbed('stay inside src/auth');
      const stop = (active: boolean) => t.event('Stop', { last_assistant_message: 'Done.', stop_hook_active: active, background_tasks: [] });
      const first = await stop(false);
      expect(JSON.parse(first.stdout)).toEqual({ decision: 'block', reason: expect.stringContaining('stay inside src/auth') });
      expect(t.b.session.hasOpenTurn()).toBe(true);
      expect(await stop(true)).toEqual({ code: 0, stdout: '' });
      expect(t.b.session.hasOpenTurn()).toBe(false);
    });
  });
});
