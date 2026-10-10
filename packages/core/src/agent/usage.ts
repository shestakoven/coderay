import type { LimitWindow, UsageView } from '@ide/protocol';
import { isRecord } from '../json';

export type UsageUpdate = Partial<Pick<UsageView, 'contextTokens' | 'contextWindow' | 'fiveHour' | 'sevenDay'>>;

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function limitWindow(value: unknown): LimitWindow | null {
  if (!isRecord(value) || typeof value.utilization !== 'number' || typeof value.resetsAt !== 'number') return null;
  return { utilization: value.utilization, resetsAt: value.resetsAt };
}

function limits(info: Record<string, unknown>): UsageUpdate {
  const windows = isRecord(info.unifiedWindows) ? info.unifiedWindows : {};
  const update: UsageUpdate = {};
  const fiveHour = limitWindow(windows.five_hour) ?? (info.rateLimitType === 'five_hour' ? limitWindow(info) : null);
  const sevenDay = limitWindow(windows.seven_day) ?? (info.rateLimitType === 'seven_day' ? limitWindow(info) : null);
  if (fiveHour) update.fiveHour = fiveHour;
  if (sevenDay) update.sevenDay = sevenDay;
  return update;
}

// The window comes with the model that ran the turn; a subagent on another model must not change it.
function windowOf(modelUsage: unknown, model: string | null): number | null {
  if (!isRecord(modelUsage)) return null;
  const entry = (model !== null ? modelUsage[model] : undefined) ?? Object.values(modelUsage)[0];
  return isRecord(entry) && typeof entry.contextWindow === 'number' ? entry.contextWindow : null;
}

/** Reads what one stream message says about the context and the account limits; null when it says nothing. */
export function usageOf(event: unknown, model: string | null): UsageUpdate | null {
  if (!isRecord(event)) return null;
  if (event.type === 'rate_limit_event') {
    const update = isRecord(event.rate_limit_info) ? limits(event.rate_limit_info) : {};
    return Object.keys(update).length === 0 ? null : update;
  }
  if (event.type === 'assistant' && event.parent_tool_use_id == null && isRecord(event.message) && isRecord(event.message.usage)) {
    const usage = event.message.usage;
    return { contextTokens: num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens) };
  }
  if (event.type === 'result') {
    const contextWindow = windowOf(event.modelUsage, model);
    return contextWindow === null ? null : { contextWindow };
  }
  return null;
}
