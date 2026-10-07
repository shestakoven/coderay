import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionError } from '../../src/agent/agent-session';
import { isAlive } from '../../src/os-process';
import { FAKE_CLAUDE } from '../fake-claude/fake';
import { transcriptPath } from '../../src/watchdog/recovery';
import { sessionRecord, waitFor } from '../helpers';
import { flag, hooksOf, noticeTexts, stubbornClaude, terminalHarness, type Options, type TerminalHarness as Harness } from './terminal-harness';

const status = (h: Harness) => h.session.state().session?.status;
const notices = (h: Harness) => noticeTexts(h.session.state().items);
const stopped = (h: Harness) => h.spawned().every(({ pid }) => !isAlive(pid));

describe('AgentSession terminal launch', () => {
  describe('when the hooks run', () => {
    it('returns the launch of an interactive claude on the gate settings and the MCP config', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000 });
      const launch = await h.session.terminalLaunch();
      expect(launch).not.toBeNull();
      const settings = flag(launch?.args, '--settings');
      const mcpConfig = flag(launch?.args, '--mcp-config');
      expect([settings, mcpConfig].map((path) => path !== undefined && existsSync(path))).toEqual([true, true]);
      expect(launch?.args).not.toContain('-p');
      expect(launch?.args).not.toContain('--input-format');
      expect(launch?.cwd).toBe(h.root);
      expect(status(h)).not.toBe('refused');
    });

    it('runs the claude command and environment of the session', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000 });
      const launch = await h.session.terminalLaunch();
      expect([launch?.file, launch?.args[0], launch?.env.FAKE_CLAUDE_HOOKS]).toEqual([process.execPath, FAKE_CLAUDE, 'on']);
    });

    it('continues the conversation of the active chat', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000 });
      const launch = await h.session.terminalLaunch();
      expect(launch?.args).toContain(h.session.state().session?.claudeSessionId);
    });

    it('probes with a headless claude on the same gate settings', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000 });
      const launch = await h.session.terminalLaunch();
      const [probe, ...others] = h.spawned();
      expect(others).toEqual([]);
      expect(probe?.argv).toContain('-p');
      expect(flag(probe?.argv, '--input-format')).toBe('stream-json');
      expect(flag(probe?.argv, '--settings')).toBe(flag(launch?.args, '--settings'));
    });

    it('holds the launch back until the hook has reported', async () => {
      const h = await terminalHarness({ hooks: 'off', canaryMs: 10_000 });
      let launched = false;
      const pending = h.session.terminalLaunch().then((launch) => {
        launched = true;
        return launch;
      });
      await waitFor(() => h.spawned().length === 1, 'probe started');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(launched).toBe(false);
      expect((await h.ping()).status).toBe(204);
      expect(await pending).not.toBeNull();
    });

    it('stops the headless probe, even one that ignores the closing of stdin', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000, scenario: stubbornClaude() });
      expect(await h.session.terminalLaunch()).not.toBeNull();
      expect(h.spawned()).toHaveLength(1);
      await waitFor(() => stopped(h), 'probe stopped');
    });

    it('accepts the report of a probe that exits right after it reported', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000, scenario: stubbornClaude(0) });
      expect(await h.session.terminalLaunch()).not.toBeNull();
      expect(status(h)).not.toBe('refused');
    });

    it('keeps the gate files for the terminal until it is closed, then removes them', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000 });
      await h.session.terminalLaunch();
      expect(h.gateFiles().length).toBeGreaterThan(0);
      h.session.terminalClosed();
      expect(h.gateFiles()).toEqual([]);
    });
  });

  describe('the hook settings of the check and of the terminal', () => {
    const GATE_HOOKS = ['PreToolUse', 'SessionStart', 'Stop'];
    const EVENT_HOOKS = ['PostToolUse', 'PostToolUseFailure', 'StopFailure', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'];

    it('checks the hooks with the hooks of the gate and the end of the turn, and no other event hook', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000 });
      await h.session.terminalLaunch();
      expect(h.gateWrites[0]).toEqual({ events: false, hooks: GATE_HOOKS, eventScript: true });
    });

    it('starts the claude of the terminal with the event hooks as well, after the check', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000 });
      const launch = await h.session.terminalLaunch();
      expect(h.gateWrites).toHaveLength(2);
      expect(h.gateWrites[1]).toEqual({ events: true, hooks: [...GATE_HOOKS, ...EVENT_HOOKS].sort(), eventScript: true });
      expect(hooksOf(flag(launch?.args, '--settings') as string)).toEqual([...GATE_HOOKS, ...EVENT_HOOKS].sort());
    });

    it('starts the headless check on settings that hold no event hook but the end of the turn at the moment it reads them', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000 });
      await h.session.terminalLaunch();
      expect(h.spawned()[0]?.hookNames).toEqual(GATE_HOOKS);
    });

    it('does not write the event hooks at all when the hooks never report', async () => {
      const h = await terminalHarness({ hooks: 'off', canaryMs: 800, scenario: stubbornClaude() });
      expect(await h.session.terminalLaunch()).toBeNull();
      expect(h.gateWrites).toEqual([{ events: false, hooks: GATE_HOOKS, eventScript: true }]);
    });

    it('checks again with settings without the event hooks after a refusal, and writes those of the terminal once the hooks run', async () => {
      const h = await terminalHarness({ hooks: 'off', canaryMs: 800 });
      expect(await h.session.terminalLaunch()).toBeNull();
      h.env.FAKE_CLAUDE_HOOKS = 'on';
      expect(await h.session.terminalLaunch()).not.toBeNull();
      expect(h.gateWrites.map((write) => write.events)).toEqual([false, false, true]);
    });
  });

  describe('the conversation the terminal goes on with', () => {
    const transcriptOf = (h: Harness) => transcriptPath(h.transcriptsDir, h.root, h.session.state().session?.claudeSessionId as string);
    const writeTranscript = (h: Harness) => {
      mkdirSync(dirname(transcriptOf(h)), { recursive: true });
      writeFileSync(transcriptOf(h), '{"type":"user"}\n');
    };

    it('starts a conversation that never ran under its id', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000 });
      const launch = await h.session.terminalLaunch();
      const id = h.session.state().session?.claudeSessionId;
      expect([flag(launch?.args, '--session-id'), launch?.args.includes('--resume')]).toEqual([id, false]);
    });

    it('resumes a conversation whose transcript was already there', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000 });
      await h.session.terminalLaunch();
      writeTranscript(h);
      h.session.terminalClosed();
      const launch = await h.session.terminalLaunch();
      expect([flag(launch?.args, '--resume'), launch?.args.includes('--session-id')]).toEqual([h.session.state().session?.claudeSessionId, false]);
    });

    it('resumes a started conversation although its transcript is not where the core looks', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000 });
      await h.session.terminalLaunch();
      writeTranscript(h);
      h.session.terminalClosed();
      expect(h.store.session(h.session.sessionId() as string)?.conversationStarted).toBe(true);
      rmSync(transcriptOf(h));
      const launch = await h.session.terminalLaunch();
      expect([flag(launch?.args, '--resume'), launch?.args.includes('--session-id')]).toEqual([h.session.state().session?.claudeSessionId, false]);
    });

    it('resumes a conversation that has a transcript although it was never marked started, as after a crash of the core', async () => {
      const h = await terminalHarness({
        hooks: 'on', canaryMs: 5000,
        seed: ({ store, root, transcriptsDir }) => {
          store.saveSession({ ...sessionRecord('earlier', root), claudeSessionId: 'earlier-claude', status: 'stopped', conversationStarted: false });
          const file = transcriptPath(transcriptsDir, root, 'earlier-claude');
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, '{"type":"user"}\n');
        },
      });
      const launch = await h.session.terminalLaunch();
      expect([flag(launch?.args, '--resume'), launch?.args.includes('--session-id')]).toEqual(['earlier-claude', false]);
    });

    it('does not take a conversation for started because the terminal opened and closed before claude wrote anything', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000 });
      await h.session.terminalLaunch();
      h.session.terminalClosed();
      const launch = await h.session.terminalLaunch();
      expect([launch?.args.includes('--resume'), flag(launch?.args, '--session-id')]).toEqual([false, h.session.state().session?.claudeSessionId]);
    });
  });

  describe('when the hooks never report', () => {
    const refused = async (options: Partial<Options> = {}) => {
      const h = await terminalHarness({ hooks: 'off', canaryMs: 800, scenario: stubbornClaude(), ...options });
      const pending = h.session.terminalLaunch();
      const filesWhileProbing = await waitFor(() => (h.gateFiles().length > 0 ? h.gateFiles() : false), 'gate files written');
      return { h, launch: await pending, filesWhileProbing };
    };

    it('returns no launch', async () => {
      const { launch } = await refused();
      expect(launch).toBeNull();
    });

    it('tells the chat that the hook did not start and the agent was not started', async () => {
      const { h } = await refused();
      expect(notices(h).filter((text) => text.includes('hook did not start, so the agent was not started'))).toHaveLength(1);
    });

    it('marks the session refused', async () => {
      const { h } = await refused();
      expect(status(h)).toBe('refused');
    });

    it('removes the gate settings and the MCP config it wrote', async () => {
      const { h, filesWhileProbing } = await refused();
      expect(filesWhileProbing.some((name) => name.endsWith('.settings.json'))).toBe(true);
      expect(filesWhileProbing.some((name) => name.endsWith('.mcp.json'))).toBe(true);
      expect(h.gateFiles()).toEqual([]);
    });

    it('leaves no headless claude running', async () => {
      const { h } = await refused();
      expect(h.spawned()).toHaveLength(1);
      await waitFor(() => stopped(h), 'probe stopped');
    });

    it('does not let a later message start an unguarded agent', async () => {
      const { h } = await refused();
      expect(() => h.session.send('hi')).toThrow(new SessionError('hook-off'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(h.spawned()).toHaveLength(1);
      expect(h.userMessages()).toEqual([]);
    });

    it('does not take an earlier report of the chat for proof that the hooks run now', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 800 });
      h.session.send('hi');
      await waitFor(() => h.session.state().turns.some((turn) => turn.closedAt !== null), 'turn closed');
      h.env.FAKE_CLAUDE_HOOKS = 'off';
      expect(await h.session.terminalLaunch()).toBeNull();
      expect(status(h)).toBe('refused');
    });

    it('gives up at once, not after the wait, when the headless claude exits first', async () => {
      const h = await terminalHarness({ hooks: 'off', canaryMs: 10_000, scenario: stubbornClaude(1) });
      const startedAt = Date.now();
      expect(await h.session.terminalLaunch()).toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect([status(h), h.gateFiles()]).toEqual(['refused', []]);
    });
  });

  describe('when the terminal is closed while the hooks are checked', () => {
    // 'before': the check starts slowly and is still silent when the terminal is closed (its hook then finds the files gone).
    // 'after': the check has reported and CodeRay is only waiting for it to stop, which it does not do at once.
    const closedDuringCheck = async (when: 'before' | 'after', options: Partial<Options> = {}) => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 2000, killGraceMs: 1500, ...options });
      if (when === 'after') h.env.FAKE_CLAUDE_PROBE_IGNORES_SIGTERM = '1';
      else h.env.FAKE_CLAUDE_PROBE_STARTUP_MS = '1200';
      const pending = h.session.terminalLaunch();
      await waitFor(() => (when === 'after' ? h.ignoredSigterms() > 0 : h.spawned().length === 1), 'the check running');
      h.session.terminalClosed();
      return { h, launch: await pending };
    };

    describe.each(['before', 'after'] as const)('%s the hooks reported', (when) => {
      it('returns no launch, so no terminal opens', async () => {
        const { launch } = await closedDuringCheck(when);
        expect(launch).toBeNull();
      });

      it('does not refuse the session, nor tell the chat that the hook did not start', async () => {
        const { h } = await closedDuringCheck(when);
        expect(status(h)).not.toBe('refused');
        expect(notices(h).filter((text) => text.includes('hook did not start'))).toEqual([]);
      });

      it('leaves no gate or MCP file of the run behind', async () => {
        const { h } = await closedDuringCheck(when);
        expect(h.gateFiles()).toEqual([]);
      });

      it('starts no claude besides the check', async () => {
        const { h } = await closedDuringCheck(when);
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(h.spawned()).toHaveLength(1);
      });

      it('lets the chat send and start its own claude: the terminal mode is off', async () => {
        const { h } = await closedDuringCheck(when);
        delete h.env.FAKE_CLAUDE_PROBE_IGNORES_SIGTERM;
        h.session.send('hi');
        await waitFor(() => h.userMessages().length === 1, 'message delivered');
        expect(h.spawned()).toHaveLength(2);
      });

      it('opens a terminal normally afterwards', async () => {
        const { h } = await closedDuringCheck(when);
        delete h.env.FAKE_CLAUDE_PROBE_IGNORES_SIGTERM;
        delete h.env.FAKE_CLAUDE_PROBE_STARTUP_MS;
        const launch = await h.session.terminalLaunch();
        expect(launch).not.toBeNull();
        expect(h.gateFiles().length).toBeGreaterThan(0);
        expect(() => h.session.send('hi')).toThrow(new SessionError('in-terminal'));
      });
    });

    it('does not refuse the session when the hooks never report either, since the user closed the terminal before that was known', async () => {
      const { h, launch } = await closedDuringCheck('before', { hooks: 'off', canaryMs: 1500 });
      expect(launch).toBeNull();
      expect(status(h)).not.toBe('refused');
      expect(notices(h).filter((text) => text.includes('hook did not start'))).toEqual([]);
    });
  });

  describe('after a refusal', () => {
    it('checks again on the next call and returns the launch once the hooks run', async () => {
      const h = await terminalHarness({ hooks: 'off', canaryMs: 800 });
      expect(await h.session.terminalLaunch()).toBeNull();
      h.env.FAKE_CLAUDE_HOOKS = 'on';
      const launch = await h.session.terminalLaunch();
      expect(launch).not.toBeNull();
      expect(h.spawned()).toHaveLength(2);
      expect(() => h.session.send('hi')).toThrow(new SessionError('in-terminal'));
    });

    it('keeps refusing while the hooks still do not run', async () => {
      const h = await terminalHarness({ hooks: 'off', canaryMs: 800 });
      expect(await h.session.terminalLaunch()).toBeNull();
      expect(await h.session.terminalLaunch()).toBeNull();
      expect(h.spawned()).toHaveLength(2);
      expect([status(h), h.gateFiles()]).toEqual(['refused', []]);
    });

    it('does not leave a terminal open: the chat can be restarted and used again', async () => {
      const h = await terminalHarness({ hooks: 'off', canaryMs: 800 });
      expect(await h.session.terminalLaunch()).toBeNull();
      h.env.FAKE_CLAUDE_HOOKS = 'on';
      await h.session.restart();
      h.session.send('again');
      await waitFor(() => h.userMessages().length === 1, 'message delivered');
      expect(status(h)).toBe('running');
    });
  });

  describe('while the terminal is open', () => {
    it('does not let the chat send a message', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000 });
      await h.session.terminalLaunch();
      expect(() => h.session.send('hi')).toThrow(new SessionError('in-terminal'));
      expect(h.spawned()).toHaveLength(1);
    });

    it('lets the chat send again after the terminal is closed', async () => {
      const h = await terminalHarness({ hooks: 'on', canaryMs: 5000 });
      await h.session.terminalLaunch();
      h.session.terminalClosed();
      h.session.send('hi');
      await waitFor(() => h.userMessages().length === 1, 'message delivered');
      expect(h.userMessages()[0]).toMatchObject({ message: { content: 'hi' } });
    });
  });

  describe('without a gate', () => {
    it('returns the launch without starting a probe or waiting for a hook', async () => {
      const h = await terminalHarness({ hooks: 'off', canaryMs: 10_000, gated: false });
      const startedAt = Date.now();
      const launch = await h.session.terminalLaunch();
      expect(launch).not.toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(h.spawned()).toEqual([]);
      expect(status(h)).not.toBe('refused');
    });
  });
});
