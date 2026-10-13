import { describe, expect, it } from 'vitest';
import type { ClientMessage, GitClientMessage } from '@ide/protocol';
import { routeClientMessage, routeOf } from '../../src/server/router';

// A Record over the union makes the type check fail when a git message type is added without being listed here.
const GIT_TYPES: Record<GitClientMessage['type'], true> = {
  'git.refresh': true, 'git.init': true, 'git.diff': true, 'git.stage': true, 'git.unstage': true, 'git.discard': true, 'git.commit': true,
  'git.branches': true, 'git.branch-create': true, 'git.branch-switch': true, 'git.branch-delete': true,
};

describe('routeOf', () => {
  it.each(['watchdog.answer', 'watchdog.stop-agent', 'history.diff', 'revert.undo', 'change.revert', 'step.rollback-preview', 'step.rollback'])('routes %s to history', (type) => {
    expect(routeOf(type)).toBe('history');
  });

  it('routes review.graph to the history handler', () => {
    expect(routeOf('review.graph')).toBe('history');
  });

  it.each(['mcp.save', 'mcp.remove', 'mcp.approve', 'mcp.confirm-external-edits', 'policy.save', 'policy.confirm-external-edits'])('routes %s to settings', (type) => {
    expect(routeOf(type)).toBe('settings');
  });

  it.each(Object.keys(GIT_TYPES))('routes %s to git', (type) => {
    expect(routeOf(type)).toBe('git');
  });

  it.each(['history.snapshot', 'history.nonsense', 'mcp.unknown', 'policy.', 'settings.get', '', 'constructor', '__proto__'])('treats %j as unknown, never as settings', (type) => {
    expect(routeOf(type)).toBe('unknown');
  });

  it('covers every client message type exactly once', () => {
    const types: ClientMessage['type'][] = [
      'chat.send', 'chat.stop', 'session.restart', 'session.new', 'prompt.answer', 'plan.answer', 'gate.answer', 'settings.get',
      'mcp.save', 'mcp.remove', 'mcp.approve', 'mcp.confirm-external-edits', 'policy.save', 'policy.confirm-external-edits',
      'watchdog.answer', 'watchdog.stop-agent', 'history.diff', 'revert.undo', 'change.revert', 'step.rollback-preview', 'step.rollback',
    ];
    const routed = types.filter((t) => routeOf(t) !== 'unknown');
    expect(routed).toHaveLength(13);
  });
});

describe('routeClientMessage', () => {
  const run = async (type: string) => {
    const calls: string[] = [];
    await routeClientMessage({ type }, {
      history: async (m) => void calls.push(`history:${m.type}`),
      git: async (m) => void calls.push(`git:${m.type}`),
      settings: (m) => void calls.push(`settings:${m.type}`),
      unknown: (t) => void calls.push(`unknown:${t}`),
    });
    return calls;
  };

  it('sends each history message to the history handler only', async () => {
    expect(await run('step.rollback')).toEqual(['history:step.rollback']);
  });

  it('sends git messages to the git handler only', async () => {
    expect(await run('git.commit')).toEqual(['git:git.commit']);
  });

  it('sends change.revert to the history handler only', async () => {
    expect(await run('change.revert')).toEqual(['history:change.revert']);
  });

  it('sends settings messages to the settings handler only', async () => {
    expect(await run('policy.save')).toEqual(['settings:policy.save']);
  });

  it('reports an unknown type as unknown and never as settings', async () => {
    expect(await run('history.nonsense')).toEqual(['unknown:history.nonsense']);
  });
});
