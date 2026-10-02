import { describe, expect, it } from 'vitest';
import { matchSkills, skillCommand, slashQuery } from '../src/chat/skills';

describe('slashQuery', () => {
  it('is the empty query for a lone slash', () => {
    expect(slashQuery('/')).toBe('');
  });

  it('is the text after the slash while the draft is one slash word', () => {
    expect([slashQuery('/rev'), slashQuery('/superpowers:brainstorming')]).toEqual(['rev', 'superpowers:brainstorming']);
  });

  it('is null once the slash word is followed by a space', () => {
    expect([slashQuery('/rev '), slashQuery('/rev args'), slashQuery('/ ')]).toEqual([null, null, null]);
  });

  it('is null for a draft that does not start with a slash', () => {
    expect(['hi', '', ' /rev', 'a/b', 'run /rev'].map(slashQuery)).toEqual([null, null, null, null, null]);
  });

  it('is null when the draft has more than one line', () => {
    expect(['/a\nb', '/rev\n', '/\n'].map(slashQuery)).toEqual([null, null, null]);
  });
});

describe('matchSkills', () => {
  it('matches any part of the name, ignoring case', () => {
    expect(matchSkills(['Wiki', 'review', 'deploy'], 'IK')).toEqual(['Wiki']);
    expect(matchSkills(['Wiki', 'review', 'deploy'], 'iew')).toEqual(['review']);
  });

  it('lists every skill of a plugin when the query is the plugin name', () => {
    const skills = ['wiki', 'superpowers:brainstorming', 'review', 'superpowers:debugging'];
    expect(matchSkills(skills, 'superpowers')).toEqual(['superpowers:brainstorming', 'superpowers:debugging']);
  });

  it('matches across the colon between plugin and name', () => {
    expect(matchSkills(['superpowers:brainstorming', 'wiki'], 's:b')).toEqual(['superpowers:brainstorming']);
  });

  it('is empty when nothing matches', () => {
    expect(matchSkills(['wiki', 'review', 'p:deploy'], 'zzz')).toEqual([]);
  });

  it('is empty when there are no skills', () => {
    expect(matchSkills([], '')).toEqual([]);
  });

  it('puts names that start with the query before names that only contain it', () => {
    expect(matchSkills(['preview', 'review'], 'review')).toEqual(['review', 'preview']);
  });

  it('counts only the part after the colon as the start of a plugin skill name', () => {
    expect(matchSkills(['superpowers:brainstorming', 'super-x'], 'super')).toEqual(['super-x', 'superpowers:brainstorming']);
    expect(matchSkills(['other:review', 'my-review'], 'review')).toEqual(['other:review', 'my-review']);
  });

  it('puts own skills before plugin skills among names that start with the query', () => {
    expect(matchSkills(['p:review', 'review-all'], 'rev')).toEqual(['review-all', 'p:review']);
  });

  it('puts own skills before plugin skills among names that only contain the query', () => {
    expect(matchSkills(['p:my-review', 'my-review'], 'review')).toEqual(['my-review', 'p:my-review']);
  });

  it('puts a plugin skill that starts with the query before an own skill that only contains it', () => {
    expect(matchSkills(['my-review', 'p:review'], 'review')).toEqual(['p:review', 'my-review']);
  });

  it('ranks by start, then own before plugin, then init order', () => {
    const skills = ['q:my-review', 'z-review', 'p:review', 'preview', 'review', 'q:review', 'a-review'];
    expect(matchSkills(skills, 'review')).toEqual(['review', 'p:review', 'q:review', 'z-review', 'preview', 'a-review', 'q:my-review']);
  });

  it('keeps the init order among skills of the same rank', () => {
    expect(matchSkills(['z-review', 'a-review', 'm-review'], 'review')).toEqual(['z-review', 'a-review', 'm-review']);
    expect(matchSkills(['z:review', 'a:review', 'm:review'], 'review')).toEqual(['z:review', 'a:review', 'm:review']);
  });

  it('ranks by the start of the name whatever the case of the query', () => {
    expect(matchSkills(['preview', 'Review'], 'REV')).toEqual(['Review', 'preview']);
  });

  it('lists every skill for an empty query, own skills before plugin ones', () => {
    expect(matchSkills(['b:x', 'a', 'c:y', 'd'], '')).toEqual(['a', 'd', 'b:x', 'c:y']);
  });

  it('does not reorder the list it is given', () => {
    const skills = ['b:x', 'a', 'c:y'];
    matchSkills(skills, '');
    expect(skills).toEqual(['b:x', 'a', 'c:y']);
  });
});

describe('skillCommand', () => {
  it('is the slash command with a trailing space ready for arguments', () => {
    expect(skillCommand('x')).toBe('/x ');
    expect(skillCommand('superpowers:brainstorming')).toBe('/superpowers:brainstorming ');
  });

  it('round-trips through slashQuery once the trailing space is gone', () => {
    expect(slashQuery(skillCommand('wiki').trimEnd())).toBe('wiki');
  });
});
