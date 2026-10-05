import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SessionError } from '../../src/agent/agent-session';
import { isAlive } from '../../src/os-process';
import { FAKE_CLAUDE } from '../fake-claude/fake';
import { waitFor } from '../helpers';
import { flag, noticeTexts, stubbornClaude, terminalHarness, type Options, type TerminalHarness as Harness } from './terminal-harness';

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
