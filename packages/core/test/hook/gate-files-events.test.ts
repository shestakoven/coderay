import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_EVENT_SCRIPT, HOOK_SCRIPT, SESSION_START_SCRIPT, writeGateFiles } from '../../src/hook/gate-files';
import { tempDir } from '../helpers';

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; args: string[]; timeout: number }[];
}

function settingsOf(options: { events?: boolean }) {
  const dir = join(tempDir('ide-home-'), 'run');
  const files = writeGateFiles(dir, 'key-s1', { url: 'http://127.0.0.1:1/hook', secret: 's3cret', sessionId: 's1', ...options });
  const settings = JSON.parse(readFileSync(files.settingsPath, 'utf8')) as { disableAllHooks: boolean; hooks: Record<string, HookEntry[]> };
  const scripts = (name: string) => (settings.hooks[name] ?? []).flatMap((entry) => entry.hooks.map((hook) => hook.args[0]));
  return { files, settings, scripts };
}

const AGENT_EVENTS = ['PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'SessionStart'];

describe('the hook settings of a terminal (writeGateFiles with events)', () => {
  it('reports the turns, tools and subagents of the agent through its hooks', () => {
    const { settings, scripts } = settingsOf({ events: true });
    for (const name of AGENT_EVENTS) expect(scripts(name), name).toContain(AGENT_EVENT_SCRIPT);
    expect(Object.keys(settings.hooks).sort()).toEqual(['PreToolUse', ...AGENT_EVENTS].sort());
  });

  it("runs the event hooks with the core's Node and the private hook config", () => {
    const { files, settings } = settingsOf({ events: true });
    for (const name of AGENT_EVENTS) {
      const event = settings.hooks[name]?.flatMap((entry) => entry.hooks).find((hook) => hook.args[0] === AGENT_EVENT_SCRIPT);
      expect(event, name).toMatchObject({ type: 'command', command: process.execPath, args: [AGENT_EVENT_SCRIPT, files.hookConfigPath] });
      expect(event?.timeout, name).toBeGreaterThan(0);
    }
  });

  it('lets claude wait for the Stop hook as long as for the gate, since the end of a turn waits for the user', () => {
    const { settings } = settingsOf({ events: true });
    const timeoutOf = (name: string, script: string) => settings.hooks[name]?.flatMap((entry) => entry.hooks).find((hook) => hook.args[0] === script)?.timeout;
    expect(timeoutOf('Stop', AGENT_EVENT_SCRIPT)).toBe(timeoutOf('PreToolUse', HOOK_SCRIPT));
  });

  it('runs the event hook for every tool', () => {
    const { settings } = settingsOf({ events: true });
    for (const name of ['PostToolUse', 'PostToolUseFailure']) {
      const entry = settings.hooks[name]?.find((candidate) => candidate.hooks.some((hook) => hook.args[0] === AGENT_EVENT_SCRIPT));
      expect([undefined, '*'], name).toContain(entry?.matcher);
    }
  });

  it('keeps the canary on SessionStart next to the event hook', () => {
    const { scripts } = settingsOf({ events: true });
    expect(scripts('SessionStart').sort()).toEqual([AGENT_EVENT_SCRIPT, SESSION_START_SCRIPT].sort());
  });

  it('leaves PreToolUse to the gate alone, which reports its calls itself', () => {
    const { scripts } = settingsOf({ events: true });
    expect(scripts('PreToolUse')).toEqual([HOOK_SCRIPT]);
  });

  it('keeps the hooks switched on', () => {
    expect(settingsOf({ events: true }).settings.disableAllHooks).toBe(false);
  });
});

describe('the hook settings of a chat (writeGateFiles without events)', () => {
  it.each([[{}], [{ events: false }]])('installs the gate, the canary and the end of the turn for %j', (options) => {
    const { settings, scripts } = settingsOf(options);
    expect(Object.keys(settings.hooks).sort()).toEqual(['PreToolUse', 'SessionStart', 'Stop']);
    expect(scripts('PreToolUse')).toEqual([HOOK_SCRIPT]);
    expect(scripts('SessionStart')).toEqual([SESSION_START_SCRIPT]);
    expect(scripts('Stop')).toEqual([AGENT_EVENT_SCRIPT]);
  });
});
