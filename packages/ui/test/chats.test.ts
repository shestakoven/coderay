import { describe, expect, it } from 'vitest';
import { canOpenTerminal, chatTitle, configureMessage, effortLabel, modelLabel, relativeTime } from '../src/chat/chats';

describe('models from the core', () => {
  const models = [
    { value: 'sonnet', name: 'Sonnet 5.5', engine: 'claude' as const, efforts: [] },
    { value: 'claude-opus-4-6', name: 'Opus 4.6', engine: 'claude' as const, efforts: [] },
  ];

  it('labels by the core name, and an id it does not know by the id itself', () => {
    expect([modelLabel('claude-opus-4-6', models), modelLabel('opus', models)]).toEqual(['Opus 4.6', 'opus']);
  });
});

describe('modelLabel and effortLabel', () => {
  it('labels no choice as a dash and a known alias by its name', () => {
    expect([modelLabel(null), modelLabel('opus'), modelLabel('haiku')]).toEqual(['—', 'Opus 5.5', 'Haiku 4.5']);
  });

  it('labels an unknown id by the id itself', () => {
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
  });

  it('labels no effort as a dash and a level by its name', () => {
    expect([effortLabel(null), effortLabel('xhigh')]).toEqual(['—', 'xhigh']);
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

describe('canOpenTerminal', () => {
  it('offers the terminal view only for an engine that has one', () => {
    expect([canOpenTerminal('claude'), canOpenTerminal('codex'), canOpenTerminal('opencode')]).toEqual([true, false, false]);
  });
});
