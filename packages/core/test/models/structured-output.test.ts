import { describe, expect, it } from 'vitest';
import { conforms, extractJson, structuredOutput } from '../../src/models/structured-output';

const SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string', maxLength: 8, pattern: '^[a-z]+$' }, kind: { enum: ['a', 'b'] } },
  required: ['name', 'kind'],
  additionalProperties: false,
};

describe('extractJson', () => {
  it.each([
    ['Sure:\n```json\n{"a":1}\n```\nDone.', { a: 1 }],
    ['text {"a":{"b":"}"}} tail', { a: { b: '}' } }],
    ['no json here', undefined],
  ])('reads %j', (text, expected) => expect(extractJson(text)).toEqual(expected));
});

describe('conforms', () => {
  it.each([
    [{ name: 'x', kind: 'a' }, null],
    [{ name: 'x' }, '$.kind is required'],
    [{ name: 'x', kind: 'a', extra: 1 }, '$.extra is not allowed'],
    [{ name: 'abcdefghi', kind: 'a' }, '$.name is longer than 8 characters'],
    [{ name: 'x y', kind: 'a' }, '$.name does not match ^[a-z]+$'],
  ])('%j → %s', (value, violation) => expect(conforms(value, SCHEMA)).toBe(violation));
});

it('structuredOutput reads the whole text, or JSON inside prose, and throws with the violation', () => {
  expect(() => structuredOutput('{"name":"x"}', SCHEMA)).toThrow('does not fit the schema: $.kind is required');
  expect(structuredOutput('ok {"name":"x","kind":"b"}', SCHEMA)).toEqual({ name: 'x', kind: 'b' });
});
