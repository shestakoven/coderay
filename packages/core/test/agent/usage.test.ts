import { describe, expect, it } from 'vitest';
import { usageOf } from '../../src/agent/usage';

const line = (event: object) => JSON.stringify(event);
const parseUsage = (text: string, model: string | null) => usageOf(JSON.parse(text), model);
const assistant = (usage: object, parent: string | null = null) => line({ type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content: [], usage } });

describe('usageOf', () => {
  it('counts the input, cache read and cache creation tokens of a main-thread reply as the context, not the output', () => {
    expect(parseUsage(assistant({ input_tokens: 10, cache_read_input_tokens: 95_000, cache_creation_input_tokens: 1000, output_tokens: 400 }), null))
      .toEqual({ contextTokens: 96_010 });
  });

  it('treats absent token counts as zero', () => {
    expect(parseUsage(assistant({ input_tokens: 3 }), null)).toEqual({ contextTokens: 3 });
  });

  it('ignores the replies of a subagent', () => {
    expect(parseUsage(assistant({ input_tokens: 9 }, 'toolu_1'), null)).toBeNull();
  });

  it('takes the context window of the model that ran, not of another model in the same result', () => {
    const result = line({ type: 'result', modelUsage: { 'claude-opus-5-5': { contextWindow: 1_000_000 }, 'claude-haiku-4-5': { contextWindow: 200_000 } } });
    expect([parseUsage(result, 'claude-haiku-4-5'), parseUsage(result, null)]).toEqual([{ contextWindow: 200_000 }, { contextWindow: 1_000_000 }]);
  });

  it('says nothing for a result without a usable window', () => {
    expect([parseUsage(line({ type: 'result' }), null), parseUsage(line({ type: 'result', modelUsage: { m: { contextWindow: 'big' } } }), 'm')]).toEqual([null, null]);
  });

  it('reads both account windows from a rate limit event', () => {
    const event = line({
      type: 'rate_limit_event',
      rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 100 }, seven_day: { utilization: 0.07, resetsAt: 200 } } },
    });
    expect(parseUsage(event, null)).toEqual({ fiveHour: { utilization: 0.42, resetsAt: 100 }, sevenDay: { utilization: 0.07, resetsAt: 200 } });
  });

  it('reads a single window announced at the top level of the event', () => {
    const event = line({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', utilization: 0.9, resetsAt: 300 } });
    expect(parseUsage(event, null)).toEqual({ sevenDay: { utilization: 0.9, resetsAt: 300 } });
  });

  it.each([
    ['a rate limit event with no windows', { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }],
    ['a window without a reset time', { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.1 } } } }],
    ['a message that mentions usage but is not an object', 'the "usage" of this tool'],
    ['an unrelated event', { type: 'system', subtype: 'init' }],
  ])('says nothing for %s', (_name, message) => {
    expect(usageOf(message, null)).toBeNull();
  });
});
