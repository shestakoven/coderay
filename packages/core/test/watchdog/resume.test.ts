import { describe, expect, it } from 'vitest';
import { resumeMessage, type ResumeInput } from '../../src/watchdog/resume';

const input = (o: Partial<ResumeInput> = {}): ResumeInput => ({
  kept: [], reverted: [], added: [], mine: [], conflicts: [], interrupted: false, killedSubagents: [], backgroundShell: false, unknownOrigin: false, failOpen: false, ...o,
});

describe('resumeMessage', () => {
  it('names kept and reverted files, the check-the-state sentence and the killed subagents', () => {
    const text = resumeMessage(input({ kept: ['a.ts'], reverted: ['b.ts'], interrupted: true, killedSubagents: ['Explore agent'] }));
    expect(text).toMatch(/^\[IDE\]/);
    expect(text).toContain('a.ts');
    expect(text).toContain('b.ts');
    expect(text).toMatch(/check the current state of the kept files/i);
    expect(text).toContain('Explore agent');
    expect(text).toContain('their unfinished work is lost');
    expect(text).toContain('may be partial');
  });

  it('puts the sentences in the order kept, reverted, added, mine, conflicts, interrupted, subagents, shell, unknown, fail-open, check', () => {
    const text = resumeMessage(input({
      kept: ['k.ts'], reverted: ['r.ts'], added: ['p.ts'], mine: ['m.ts'], conflicts: [{ path: 'c.ts', reason: 'edited since' }],
      interrupted: true, killedSubagents: ['S'], backgroundShell: true, unknownOrigin: true, failOpen: true,
    }));
    const at = ['k.ts', 'r.ts', 'p.ts', 'm.ts', 'c.ts (edited since)', 'partial', 'unfinished work', 'background shell', 'IDE was not running', 'safety hook', 'Check the current state'].map((s) => text.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('leaves out the sentences that do not apply', () => {
    const text = resumeMessage(input({ kept: ['a.ts'] }));
    for (const absent of ['partial', 'unfinished', 'background shell', 'not running', 'safety hook', 'Restored', 'Added', 'Not restored', 'Edited by the user']) {
      expect(text).not.toContain(absent);
    }
  });

  it('shortens a long list to eight names and "and N more"', () => {
    const kept = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
    const text = resumeMessage(input({ kept }));
    expect(text).toContain('f7.ts');
    expect(text).not.toContain('f8.ts');
    expect(text).toContain('and 4 more');
  });

  it('caps the message at 1,500 characters at a sentence boundary and keeps the closing sentence', () => {
    const long = (p: string) => Array.from({ length: 8 }, (_, i) => `${p}/${'d'.repeat(80)}${i}.ts`);
    const text = resumeMessage(input({
      kept: long('k'), reverted: long('r'), added: long('a'), mine: long('m'), conflicts: long('c').map((path) => ({ path, reason: 'edited since' })), interrupted: true,
    }));
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(text).toMatch(/^\[IDE\]/);
    expect(text.endsWith('continue from it rather than redoing them.')).toBe(true);
    expect(text).toContain('Kept as you wrote them');
  });

  it('truncates one absurdly long name so a single sentence cannot break the cap', () => {
    const text = resumeMessage(input({ kept: ['x'.repeat(5000)] }));
    expect(text.length).toBeLessThanOrEqual(1500);
  });
});
