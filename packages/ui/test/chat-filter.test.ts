import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE, type ChatItem } from '@ide/protocol';
import { chatReducer, filterItems, initialChatState, type ChatFilter } from '../src/chat/chat-state';

const msg = (id: string, seq: number, role: 'user' | 'assistant' = 'assistant'): ChatItem =>
  ({ kind: 'message', id, seq, turnId: 't1', parentToolUseId: null, role, text: id, ts: seq });
const tool = (id: string, seq: number, targets: string[] = []): ChatItem =>
  ({ kind: 'tool', id, seq, turnId: 't1', parentToolUseId: null, tool: 'Edit', summary: id, status: 'ok', startedAt: seq, endedAt: seq, decision: null, targets });
const filter = (o: Partial<ChatFilter> = {}): ChatFilter => ({ nodeId: 'n', label: 'API', toolUseIds: new Set(), files: new Set(), ...o });
const ids = (items: ChatItem[]): string[] => items.map((i) => i.id);

describe('filterItems', () => {
  const items = [msg('u0', 1, 'user'), msg('a1', 2), tool('x', 3), tool('y', 4, ['src/a.ts']), msg('a2', 5), tool('z', 6, ['src/other.ts'])];

  it('keeps matching tool rows and the assistant message before each', () => {
    const out = filterItems(items, filter({ toolUseIds: new Set(['x']), files: new Set(['src/a.ts']) }));
    expect(ids(out)).toEqual(['a1', 'x', 'y']);
  });

  it('does not pull in a message that is not an assistant one', () => {
    expect(ids(filterItems([msg('u1', 1, 'user'), tool('x', 2)], filter({ toolUseIds: new Set(['x']) })))).toEqual(['x']);
  });

  it('matches by target files when the tool id is unknown', () => {
    expect(ids(filterItems(items, filter({ files: new Set(['src/other.ts']) })))).toEqual(['a2', 'z']);
  });

  it('drops everything when nothing matches', () => {
    expect(filterItems(items, filter())).toEqual([]);
  });

  it('returns every item without a filter', () => {
    expect(filterItems(items, null)).toBe(items);
  });
});

describe('chat filter state', () => {
  it('sets and clears the filter and survives a snapshot', () => {
    const f = filter();
    const set = chatReducer(initialChatState, { type: 'filter', filter: f });
    expect(set.filter).toBe(f);
    const snap = chatReducer(set, { type: 'snapshot', state: { session: null, turns: [], items: [], tasks: [], mcpServers: [], usage: EMPTY_USAGE } });
    expect(snap.filter).toBe(f);
    expect(chatReducer(snap, { type: 'filter', filter: null }).filter).toBeNull();
  });
});
