import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE, type UsageView } from '@ide/protocol';
import { chatReducer, initialChatState } from '../src/chat/chat-state';
import { contextMeter, formatTokens, levelOf, limitMeter, resetsIn, usageMeters } from '../src/chat/usage';

const NOW = 1_000_000_000_000;
const inSeconds = (seconds: number) => NOW / 1000 + seconds;
const usage = (partial: Partial<UsageView>): UsageView => ({ ...EMPTY_USAGE, ...partial });

describe('formatTokens', () => {
  it.each([[0, '0'], [950, '950'], [1000, '1k'], [96_010, '96k'], [200_000, '200k'], [1_000_000, '1M'], [1_250_000, '1.3M']])('%i is %s', (tokens, text) => {
    expect(formatTokens(tokens)).toBe(text);
  });
});

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

  it('shows used, window and share, and warns as the window fills', () => {
    expect(contextMeter(usage({ contextTokens: 96_010, contextWindow: 200_000 }))).toMatchObject({ text: 'ctx 96k / 200k · 48%', fraction: 96_010 / 200_000, level: 'ok' });
    expect(contextMeter(usage({ contextTokens: 150_000, contextWindow: 200_000 }))?.level).toBe('warn');
    expect(contextMeter(usage({ contextTokens: 190_000, contextWindow: 200_000 }))?.level).toBe('high');
  });

  it('shows only the tokens while the window is not known yet', () => {
    expect(contextMeter(usage({ contextTokens: 96_010 }))).toMatchObject({ text: 'ctx 96k', fraction: null, level: 'ok' });
  });

  it('caps the bar at a full window', () => {
    expect(contextMeter(usage({ contextTokens: 250_000, contextWindow: 200_000 }))?.fraction).toBe(1);
  });
});

describe('limitMeter', () => {
  it('shows the share used and when the window resets', () => {
    expect(limitMeter('5h', { utilization: 0.42, resetsAt: inSeconds(2 * 3600 + 14 * 60) }, NOW)).toEqual({
      text: '5h 42%', title: '42% of the five-hour limit used; resets in 2h 14m', fraction: 0.42, level: 'ok',
    });
    expect(limitMeter('7d', { utilization: 0.95, resetsAt: inSeconds(86_400) }, NOW)).toMatchObject({ text: '7d 95%', level: 'high' });
  });

  it('hides a window that has no data or has already reset', () => {
    expect([limitMeter('5h', null, NOW), limitMeter('5h', { utilization: 0.9, resetsAt: inSeconds(-1) }, NOW)]).toEqual([null, null]);
  });
});

describe('usageMeters', () => {
  it('lists the context first, then the five-hour and the seven-day limit, skipping what is unknown', () => {
    const all = usage({ contextTokens: 1000, contextWindow: 200_000, fiveHour: { utilization: 0.1, resetsAt: inSeconds(60) }, sevenDay: { utilization: 0.2, resetsAt: inSeconds(60) } });
    expect(usageMeters(all, NOW).map((meter) => meter.text)).toEqual(['ctx 1k / 200k · 1%', '5h 10%', '7d 20%']);
    expect(usageMeters(usage({ sevenDay: all.sevenDay }), NOW).map((meter) => meter.text)).toEqual(['7d 20%']);
    expect(usageMeters(EMPTY_USAGE, NOW)).toEqual([]);
  });
});

describe('chatReducer usage', () => {
  const snapshot = (value: UsageView) => chatReducer(initialChatState, { type: 'snapshot', state: { session: null, turns: [], items: [], tasks: [], mcpServers: [], usage: value } });

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
