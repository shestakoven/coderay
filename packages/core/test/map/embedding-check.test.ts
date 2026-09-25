import { describe, expect, it } from 'vitest';
import { checkRule, residualSamples, wilsonLowerBound } from '../../src/map/embedding-check';
import { unit } from '../helpers';

const files = (dir: string, count: number) => Array.from({ length: count }, (_, i) => `${dir}/f${i}.ts`);
const basis = (index: number) => unit(...[0, 1, 2].map((i) => (i === index ? 1 : 0.05)));

describe('wilsonLowerBound', () => {
  it('needs 35 of 35 right placements, not 30 of 30, to reach a 90 % lower bound', () => {
    expect([wilsonLowerBound(30, 30) < 0.9, wilsonLowerBound(35, 35) >= 0.9]).toEqual([true, true]);
  });
});

describe('checkRule', () => {
  it('counts only the placements the rule accepts', () => {
    const right = { own: 'ai:a', best: 'ai:a', bestSimilarity: 0.95, margin: 0.2 };
    const wrong = { own: 'ai:a', best: 'ai:b', bestSimilarity: 0.7, margin: 0.01 };
    const check = checkRule({ kind: 'margin', min: 0.1 }, [...Array.from({ length: 40 }, () => right), wrong]);
    expect([check.assigned, check.correct, check.passes]).toEqual([40, 40, true]);
  });
});

describe('residualSamples', () => {
  it('counts only the files that no stored glob or test rule would place', () => {
    const a = [...files('a1', 3), ...files('a2', 3), 'test/a1.test.ts'];
    const b = [...files('b1', 3), ...files('lib/x', 2), ...files('lib/y', 2)];
    const vectors = new Map([...a.map((path) => [path, basis(0)] as const), ...b.map((path) => [path, basis(1)] as const)]);
    const samples = residualSamples(
      [
        { id: 'ai:a', files: a },
        { id: 'ai:b', files: b },
      ],
      [...a, ...b],
      (path) => vectors.get(path),
      new Map([['test/a1.test.ts', ['a1/f0.ts']]]),
    );
    expect([samples.length, samples.every((sample) => sample.best === sample.own)]).toEqual([9, true]);
  });

  it('judges the files of a directory that holds a whole component as wrong placements', () => {
    const paths = [...files('a1', 3), ...files('b1', 3), ...files('c1', 3)];
    const vectors = new Map(paths.map((path) => [path, basis(Number(path[0] === 'b') + 2 * Number(path[0] === 'c'))] as const));
    const samples = residualSamples(
      ['a1', 'b1', 'c1'].map((dir) => ({ id: `ai:${dir[0]}`, files: files(dir, 3) })),
      paths,
      (path) => vectors.get(path),
      new Map(),
    );
    expect([samples.length, samples.filter((sample) => sample.best === sample.own).length]).toEqual([9, 0]);
  });
});
