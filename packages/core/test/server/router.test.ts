import { describe, expect, it } from 'vitest';
import type { ClientMessage } from '@ide/protocol';
import { routeClientMessage, routeOf } from '../../src/server/router';

describe('routeOf', () => {
  it.each(['watchdog.answer', 'watchdog.stop-agent', 'history.diff', 'revert.undo', 'change.revert', 'step.rollback-preview', 'step.rollback'])('routes %s to history', (type) => {
    expect(routeOf(type)).toBe('history');
  });

  it.each(['mcp.save', 'mcp.remove', 'mcp.approve', 'mcp.confirm-external-edits', 'policy.save', 'policy.confirm-external-edits'])('routes %s to settings', (type) => {
    expect(routeOf(type)).toBe('settings');
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
      settings: (m) => void calls.push(`settings:${m.type}`),
      unknown: (t) => void calls.push(`unknown:${t}`),
    });
    return calls;
  };

  it('sends each history message to the history handler only', async () => {
    expect(await run('step.rollback')).toEqual(['history:step.rollback']);
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
