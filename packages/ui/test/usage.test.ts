import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE, type LimitWindow, type UsageView } from '@ide/protocol';
import { chatReducer, initialChatState } from '../src/chat/chat-state';
import { contextMeter, levelOf, limitMeter, resetsIn, usageMeters } from '../src/chat/usage';

const NOW = 1_000_000_000_000;
const inSeconds = (seconds: number) => NOW / 1000 + seconds;
const usage = (partial: Partial<UsageView>): UsageView => ({ ...EMPTY_USAGE, ...partial });

describe('levelOf', () => {
  it('turns to a warning at 70% and to high at 90%', () => {
    expect([0.69, 0.7, 0.89, 0.9, 1.2].map(levelOf)).toEqual(['ok', 'warn', 'warn', 'high', 'high']);
  });
});

describe('resetsIn', () => {
  it.each([[30, '1m'], [45 * 60, '45m'], [2 * 3600 + 14 * 60, '2h 14m'], [3 * 86_400 + 4 * 3600, '3d 4h'], [-5, '0m']])('%i seconds ahead is %s', (seconds, text) => {
    expect(resetsIn(inSeconds(seconds), NOW)).toBe(text);
  });
});

describe('contextMeter', () => {
  it('shows nothing before the agent has answered', () => {
    expect(contextMeter(EMPTY_USAGE)).toBeNull();
  });

  it('shows only the share of the window in use, never tokens, and warns as it fills', () => {
    expect(contextMeter(usage({ contextTokens: 96_010, contextWindow: 200_000 }))).toEqual({
      text: 'ctx 48%', title: '48% of the context window is in use', fraction: 96_010 / 200_000, level: 'ok',
    });
    expect(contextMeter(usage({ contextTokens: 150_000, contextWindow: 200_000 }))?.level).toBe('warn');
    expect(contextMeter(usage({ contextTokens: 190_000, contextWindow: 200_000 }))?.level).toBe('high');
  });

  it('shows nothing while the window is not known, since no share can be given', () => {
    expect([contextMeter(usage({ contextTokens: 96_010 })), contextMeter(usage({ contextTokens: 5, contextWindow: 0 }))]).toEqual([null, null]);
  });

  it('caps the bar at a full window', () => {
    expect(contextMeter(usage({ contextTokens: 250_000, contextWindow: 200_000 }))?.fraction).toBe(1);
  });
});

const FIVE = { label: '5h', name: 'five-hour', minutes: 300 };
const SEVEN = { label: '7d', name: 'seven-day', minutes: 10_080 };
const limit = (kind: typeof FIVE, utilization: number, resetsAt: number): LimitWindow => ({ ...kind, utilization, resetsAt });

describe('limitMeter', () => {
  it('shows the share used and when the window resets', () => {
    expect(limitMeter(limit(FIVE, 0.42, inSeconds(2 * 3600 + 14 * 60)), NOW)).toEqual({
      text: '5h 42%', title: '42% of the five-hour limit used; resets in 2h 14m', fraction: 0.42, level: 'ok',
    });
    expect(limitMeter(limit(SEVEN, 0.95, inSeconds(86_400)), NOW)).toMatchObject({ text: '7d 95%', level: 'high' });
  });

  it('hides a window that has already reset', () => {
    expect(limitMeter(limit(FIVE, 0.9, inSeconds(-1)), NOW)).toBeNull();
  });
});

describe('usageMeters', () => {
  it('lists the context first, then the limit windows in the order the core gives them, skipping what is unknown', () => {
    const all = usage({ contextTokens: 1000, contextWindow: 200_000, limits: [limit(FIVE, 0.1, inSeconds(60)), limit(SEVEN, 0.2, inSeconds(60))] });
    expect(usageMeters(all, NOW).map((meter) => meter.text)).toEqual(['ctx 1%', '5h 10%', '7d 20%']);
    expect(usageMeters(usage({ limits: all.limits.slice(1) }), NOW).map((meter) => meter.text)).toEqual(['7d 20%']);
    expect(usageMeters(EMPTY_USAGE, NOW)).toEqual([]);
  });

  it('shows the context of a core older than the list of windows, which sends none', () => {
    const old = { contextTokens: 1000, contextWindow: 200_000, fiveHour: null, sevenDay: null } as unknown as UsageView;
    expect(usageMeters(old, NOW).map((meter) => meter.text)).toEqual(['ctx 1%']);
  });
});

describe('chatReducer usage', () => {
  const snapshot = (value: UsageView) => chatReducer(initialChatState, { type: 'snapshot', state: { session: null, turns: [], items: [], tasks: [], mcpServers: [], skills: [], usage: value } });

  it('takes the usage from a snapshot and replaces it from a patch', () => {
    const before = snapshot(usage({ contextTokens: 1 }));
    expect(before.usage.contextTokens).toBe(1);
    expect(chatReducer(before, { type: 'patch', patch: { usage: usage({ contextTokens: 2 }) } }).usage.contextTokens).toBe(2);
  });

  it('keeps the usage through a patch that carries none', () => {
    const before = snapshot(usage({ contextTokens: 1 }));
    expect(chatReducer(before, { type: 'patch', patch: { turns: [] } }).usage).toBe(before.usage);
  });
});
