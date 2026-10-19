import { describe, expect, it } from 'vitest';
import type { ReviewGraph } from '@ide/protocol';
import { MAX_QUESTION, formatQuestions, loadQuestions, markAsked, outdated, persistQuestions, questionFor, saveQuestion, unsentQuestions } from '../src/history/review-map/review-map-questions';

const part = { t: 'part', id: 'svc' } as const;
const link = { t: 'link', from: 'api', to: 'svc' } as const;

describe('saveQuestion', () => {
  it('keeps one unsent question per target: a second text replaces the first, an empty text removes it, a link the other way is another target', () => {
    let list = saveQuestion([], { target: part, title: 'UserService', where: 'app/s.py', text: 'why?' }, 'q1', 1);
    list = saveQuestion(list, { target: part, title: 'UserService', where: 'app/s.py', text: 'why twice?' }, 'q2', 2);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ text: 'why twice?', sentAt: null });
    expect(saveQuestion(list, { target: part, title: 'UserService', where: 'app/s.py', text: '   ' }, 'q3', 3)).toEqual([]);
    const both = saveQuestion(saveQuestion([], { target: link, title: 'a', where: '', text: 'x' }, 'q4', 4), { target: { t: 'link', from: 'svc', to: 'api' }, title: 'b', where: '', text: 'y' }, 'q5', 5);
    expect(both.map((q) => q.id)).toEqual(['q4', 'q5']);
  });

  it('asks again about a target that was already asked as a new question', () => {
    const asked = markAsked(saveQuestion([], { target: part, title: 't', where: '', text: 'a' }, 'q1', 1), ['q1'], 5);
    const list = saveQuestion(asked, { target: part, title: 't', where: '', text: 'b' }, 'q2', 6);
    expect(list.map((q) => [q.id, q.sentAt])).toEqual([['q1', 5], ['q2', null]]);
    expect(questionFor(list, part)?.id).toBe('q2');
    expect(unsentQuestions(list).map((q) => q.id)).toEqual(['q2']);
  });

  it('cuts a long text to the limit without leaving half of a surrogate pair', () => {
    const cut = saveQuestion([], { target: part, title: 't', where: '', text: 'a'.repeat(MAX_QUESTION + 1) }, 'q1', 1);
    expect(cut[0]?.text).toHaveLength(MAX_QUESTION);
    const pair = saveQuestion([], { target: part, title: 't', where: '', text: `${'a'.repeat(MAX_QUESTION - 1)}😀` }, 'q2', 2);
    expect(pair[0]?.text).toBe('a'.repeat(MAX_QUESTION - 1));
  });
});

describe('formatQuestions', () => {
  it('writes the message the spec shows: the answer-only line, then each question with its place', () => {
    let list = saveQuestion([], { target: part, title: 'UserService', where: 'app/services/user_service.py', text: 'Why is the check before hashing?' }, 'q1', 1);
    list = saveQuestion(list, { target: link, title: 'API → UserService', where: 'app/api/users.py:6', text: 'Why does the route call this?\nIs it needed?' }, 'q2', 2);
    expect(formatQuestions(list)).toBe([
      'I am reviewing your changes and have 2 questions about them. Answer only: do not change any code.',
      '',
      '1. UserService (app/services/user_service.py)',
      '   Why is the check before hashing?',
      '',
      '2. API → UserService (app/api/users.py:6)',
      '   Why does the route call this?',
      '   Is it needed?',
    ].join('\n'));
  });

  it('says "a question" for one and keeps its numbered line whole: a newline in the title or the place is folded, an empty place left out', () => {
    const one = (title: string, where: string) => formatQuestions(saveQuestion([], { target: part, title, where, text: 'Why?' }, 'q1', 1));
    const head = 'I am reviewing your changes and have a question about them. Answer only: do not change any code.\n\n';
    expect(one('User\n  Service', '')).toBe(`${head}1. User Service\n   Why?`);
    expect(one('UserService', 'app/s.py\n:6')).toBe(`${head}1. UserService (app/s.py :6)\n   Why?`);
  });
});

describe('outdated', () => {
  it('lists the questions whose part or link is no longer in the graph', () => {
    const graph: ReviewGraph = {
      parts: [{ id: 'svc', title: 's', status: 'modified', steps: [], outside: false, files: [], broken: [] }],
      links: [{ from: 'api', to: 'svc', state: 'new', count: 1, evidence: [] }],
      partial: null,
    };
    let list = saveQuestion([], { target: part, title: 's', where: '', text: 'a' }, 'q1', 1);
    list = saveQuestion(list, { target: { t: 'part', id: 'gone' }, title: 'g', where: '', text: 'b' }, 'q2', 2);
    list = saveQuestion(list, { target: link, title: 'l', where: '', text: 'c' }, 'q3', 3);
    list = saveQuestion(list, { target: { t: 'link', from: 'svc', to: 'api' }, title: 'r', where: '', text: 'd' }, 'q4', 4);
    expect(outdated(list, graph).map((q) => q.id)).toEqual(['q2', 'q4']);
  });
});

describe('storage', () => {
  it('round-trips per project root, drops malformed entries and survives a storage that throws on read or write', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const list = saveQuestion([], { target: part, title: 't', where: 'w', text: 'x' }, 'q1', 1);
    persistQuestions(storage, '/p', list);
    expect(loadQuestions(storage, '/p')).toEqual(list);
    expect(loadQuestions(storage, '/other')).toEqual([]);
    store.set('ide.review.questions./p', JSON.stringify([{ id: 1 }, ...list]));
    expect(loadQuestions(storage, '/p')).toEqual(list);
    expect(loadQuestions({ getItem: () => { throw new Error('blocked'); } }, '/p')).toEqual([]);
    expect(() => persistQuestions({ setItem: () => { throw new Error('full'); } }, '/p', list)).not.toThrow();
  });
});
