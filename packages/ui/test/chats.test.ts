import { describe, expect, it } from 'vitest';
import {
  chatTitle, configureMessage, effortLabel, effortOptions, isEffort, modelLabel, modelOptions, relativeTime,
} from '../src/chat/chats';

const values = (current: string | null) => modelOptions(current).map((option) => option.value);

describe('modelOptions', () => {
  it('lists the default first and then the known aliases in order', () => {
    expect(modelOptions(null)).toEqual([
      { value: null, label: 'Default model' },
      { value: 'fable', label: 'Fable' },
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'haiku', label: 'Haiku' },
    ]);
  });

  it('appends an unknown current id exactly once, labelled by the id itself, after the known aliases', () => {
    const options = modelOptions('claude-opus-5-5');
    expect(options.at(-1)).toEqual({ value: 'claude-opus-5-5', label: 'claude-opus-5-5' });
    expect(options.filter((option) => option.value === 'claude-opus-5-5')).toHaveLength(1);
    expect(values('claude-opus-5-5')).toEqual([null, 'fable', 'opus', 'sonnet', 'haiku', 'claude-opus-5-5']);
  });

  it('does not duplicate a known alias that is the current choice', () => {
    expect(values('sonnet')).toEqual([null, 'fable', 'opus', 'sonnet', 'haiku']);
  });

  it('does not append an empty id', () => {
    expect(values('')).toEqual([null, 'fable', 'opus', 'sonnet', 'haiku']);
  });
});

describe('effortOptions', () => {
  it('lists the default first and then every effort level in protocol order', () => {
    expect(effortOptions.map((option) => [option.value, option.label])).toEqual([
      [null, 'Default effort'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max'],
    ]);
  });
});

describe('modelLabel and effortLabel', () => {
  it('labels no choice as the default model and a known alias by its name', () => {
    expect([modelLabel(null), modelLabel('opus'), modelLabel('haiku')]).toEqual(['Default model', 'Opus', 'Haiku']);
  });

  it('labels an unknown id by the id itself', () => {
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
  });

  it('labels no effort as the default effort and a level by its name', () => {
    expect([effortLabel(null), effortLabel('xhigh')]).toEqual(['Default effort', 'xhigh']);
  });
});

describe('chatTitle', () => {
  it('shows New chat for an empty or blank title', () => {
    expect([chatTitle({ title: '' }), chatTitle({ title: '   \t' })]).toEqual(['New chat', 'New chat']);
  });

  it('shows the title as it is when there is text', () => {
    expect(chatTitle({ title: 'Fix the login bug' })).toBe('Fix the login bug');
  });
});

describe('relativeTime', () => {
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  const ago = (seconds: number) => relativeTime(now - seconds * 1000, now);
  const minutes = (n: number) => n * 60;
  const hours = (n: number) => n * 3600;
  const days = (n: number) => n * 86_400;

  it('says just now up to 44 seconds and 1 min ago from 45 seconds', () => {
    expect([ago(0), ago(44), ago(45)]).toEqual(['just now', 'just now', '1 min ago']);
  });

  it('counts minutes up to 59 and rolls over to 1 h ago at 59.5 minutes', () => {
    expect([ago(minutes(5)), ago(minutes(59)), ago(3569), ago(3570)]).toEqual(['5 min ago', '59 min ago', '59 min ago', '1 h ago']);
  });

  it('counts hours up to 23 and rolls over to yesterday at 23.5 hours', () => {
    expect([ago(hours(2)), ago(hours(23)), ago(84_539), ago(84_600)]).toEqual(['2 h ago', '23 h ago', '23 h ago', 'yesterday']);
  });

  it('says yesterday for one day, counts days up to 13 and shows the date from 14 days', () => {
    expect([ago(days(1)), ago(days(2)), ago(days(13)), ago(days(14))]).toEqual([
      'yesterday', '2 d ago', '13 d ago', new Date(now - days(14) * 1000).toISOString().slice(0, 10),
    ]);
  });

  it('shows the calendar date of the timestamp for old chats', () => {
    expect(relativeTime(Date.UTC(2026, 0, 5, 8, 30), now)).toBe('2026-01-05');
  });

  it('treats a timestamp in the future as just now', () => {
    expect([relativeTime(now + 1000, now), relativeTime(now + days(30) * 1000, now)]).toEqual(['just now', 'just now']);
  });
});

describe('configureMessage', () => {
  const session = { modelChoice: 'opus', effort: 'high' as const };

  it('changing only the model keeps the current effort', () => {
    expect(configureMessage(session, { modelChoice: 'haiku' })).toEqual({ type: 'session.configure', modelChoice: 'haiku', effort: 'high' });
  });

  it('changing only the effort keeps the current model', () => {
    expect(configureMessage(session, { effort: 'low' })).toEqual({ type: 'session.configure', modelChoice: 'opus', effort: 'low' });
  });

  it('can reset the model to the default while keeping the effort', () => {
    expect(configureMessage(session, { modelChoice: null })).toEqual({ type: 'session.configure', modelChoice: null, effort: 'high' });
  });

  it('can reset the effort to the default while keeping the model', () => {
    expect(configureMessage(session, { effort: null })).toEqual({ type: 'session.configure', modelChoice: 'opus', effort: null });
  });

  it('sends nulls for the part that is not changed when there is no session', () => {
    expect([configureMessage(null, { modelChoice: 'sonnet' }), configureMessage(null, { effort: 'max' })]).toEqual([
      { type: 'session.configure', modelChoice: 'sonnet', effort: null },
      { type: 'session.configure', modelChoice: null, effort: 'max' },
    ]);
  });
});

describe('isEffort', () => {
  it('accepts every effort level', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max'].map(isEffort)).toEqual([true, true, true, true, true]);
  });

  it('rejects other strings, including wrong case and the empty string', () => {
    expect(['', 'HIGH', 'ultra', 'default', ' high'].map(isEffort)).toEqual([false, false, false, false, false]);
  });
});
