import { describe, expect, it } from 'vitest';
import { isTestPath, testSubject } from '../../src/map/test-files';

const owner = new Map([
  ['src/api/routes.ts', 'ai:api'],
  ['src/api/handlers.ts', 'ai:api'],
  ['src/db/client.ts', 'ai:db'],
  ['packages/core/src/map/grouping.ts', 'ai:grouping'],
  ['app/db.py', 'ai:storage'],
  ['test/helpers.ts', 'ai:db'],
]);

describe('isTestPath', () => {
  it('recognizes test files by the naming conventions of common languages', () => {
    const tests = ['src/a.test.ts', 'src/a.spec.tsx', 'packages/core/test/helpers.ts', 'app/tests/test_db.py', 'pkg/db_test.go', 'conftest.py'];
    const sources = ['src/testing.ts', 'src/latest.ts', 'app/contest.py', 'src/test_.py'];

    expect([tests.filter(p => !isTestPath(p)), sources.filter(p => isTestPath(p))]).toEqual([[], []]);
  });
});

describe('testSubject', () => {
  it('picks the component that most of the test imports belong to', () => {
    expect(testSubject('test/api.test.ts', ['src/api/routes.ts', 'src/api/handlers.ts', 'src/db/client.ts'], owner)).toBe('ai:api');
  });

  it('does not count imports of other test files', () => {
    expect(testSubject('test/api.test.ts', ['test/helpers.ts', 'src/api/routes.ts'], owner)).toBe('ai:api');
  });

  it('falls back to the mirrored source path when the imports do not decide', () => {
    const tied = ['src/api/routes.ts', 'src/db/client.ts'];
    expect([
      testSubject('packages/core/test/map/grouping.test.ts', [], owner),
      testSubject('src/api/routes.test.ts', tied, owner),
      testSubject('app/tests/test_db.py', [], owner),
    ]).toEqual(['ai:grouping', 'ai:api', 'ai:storage']);
  });

  it('finds no subject when neither the imports nor a mirrored path point to a component', () => {
    expect(testSubject('test/fixtures/worker.mjs', [], owner)).toBeNull();
  });
});
