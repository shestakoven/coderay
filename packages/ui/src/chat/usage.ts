import type { LimitWindow, UsageView } from '@ide/protocol';

export type Level = 'ok' | 'warn' | 'high';

export interface Meter {
  text: string;
  title: string;
  fraction: number | null;
  level: Level;
}

const WARN_AT = 0.7;
const HIGH_AT = 0.9;

export const levelOf = (fraction: number): Level => (fraction >= HIGH_AT ? 'high' : fraction >= WARN_AT ? 'warn' : 'ok');

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

export function resetsIn(resetsAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((resetsAt * 1000 - now) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function contextMeter(usage: UsageView): Meter | null {
  const { contextTokens: used, contextWindow: window } = usage;
  if (used === null || window === null || window <= 0) return null;
  const fraction = used / window;
  return {
    text: `ctx ${percent(fraction)}`,
    title: `${percent(fraction)} of the context window is in use`,
    fraction: Math.min(1, fraction),
    level: levelOf(fraction),
  };
}

// A window whose reset time has passed no longer says how much is used, so it is not shown.
export function limitMeter(label: string, window: LimitWindow | null, now: number): Meter | null {
  if (window === null || window.resetsAt * 1000 <= now) return null;
  return {
    text: `${label} ${percent(window.utilization)}`,
    title: `${percent(window.utilization)} of the ${label === '5h' ? 'five-hour' : 'seven-day'} limit used; resets in ${resetsIn(window.resetsAt, now)}`,
    fraction: Math.min(1, window.utilization),
    level: levelOf(window.utilization),
  };
}

export const usageMeters = (usage: UsageView, now: number): Meter[] =>
  [contextMeter(usage), limitMeter('5h', usage.fiveHour, now), limitMeter('7d', usage.sevenDay, now)].filter((meter): meter is Meter => meter !== null);
