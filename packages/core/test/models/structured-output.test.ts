import { expect, it } from 'vitest';
import { conforms, extractJson, structuredOutput } from '../../src/models/structured-output';
import type { JsonSchema } from '../../src/models/types';

const SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string', maxLength: 8, pattern: '^[a-z]+$' }, kind: { enum: ['a', 'b'] } },
  required: ['name', 'kind'],
  additionalProperties: false,
};
// The keywords of the grouping, overview and classification schemas: items, maxItems, integer, enum, anyOf.
const NESTED = {
  type: 'object',
  properties: {
    either: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    list: { type: 'array', maxItems: 2, items: { type: 'object', properties: { n: { type: 'integer' }, k: { enum: ['x', 'y'] } } } },
  },
};
const PAIR = { type: 'string', minLength: 2, maxLength: 2 };

it('conforms names the first rule a value breaks, for every keyword it checks, and null for a value that keeps them all', () => {
  const rows: [JsonSchema, unknown, string | null][] = [
    [SCHEMA, { name: 'abcdefgh', kind: 'a' }, null],
    // An own "__proto__" key is a property like any other, never the prototype read as its rule.
    [SCHEMA, JSON.parse('{"name":"x","kind":"a","__proto__":1}'), '$.__proto__ is not allowed'],
    [SCHEMA, { name: 'abcdefghi', kind: 'a' }, '$.name is longer than 8 characters'],
    [SCHEMA, { name: 'x y', kind: 'a' }, '$.name does not match ^[a-z]+$'],
    [NESTED, { either: null, list: [{ n: 1, k: 'x' }, { n: 1.5 }] }, '$.list[1].n is not of type integer'],
    [NESTED, { list: [{ k: 'z' }] }, '$.list[0].k is not one of x, y'],
    [NESTED, { list: [{}, {}, {}] }, '$.list has more than 2 items'],
    [NESTED, { either: 1 }, '$.either matches no option'],
    // A key the schema does not name is allowed unless it says otherwise.
    [NESTED, { either: 'x', extra: true }, null],
    [{ const: 'v' }, 'w', '$ is not "v"'],
    // Lengths count code points, as JSON Schema does.
    [PAIR, '😀😀', null],
    [PAIR, 'a', '$ is shorter than 2 characters'],
    [{ type: 'array', minItems: 1 }, [], '$ has fewer than 1 items'],
    [{ type: ['string', 'null'] }, 1, '$ is not of type string or null'],
    [{ type: 'number' }, 1, null],
  ];
  expect(rows.map(([schema, value]) => conforms(value, schema))).toEqual(rows.map(([, , violation]) => violation));
});

it('structuredOutput takes the first JSON that fits, and throws with the violation of the largest', () => {
  expect(() => structuredOutput('{"name":"x"}', SCHEMA)).toThrow('does not fit the schema: $.kind is required');
  expect(structuredOutput('Step [1] or {}: {"name":"x","kind":"b"}', SCHEMA)).toEqual({ name: 'x', kind: 'b' });
  expect(() => structuredOutput('Step [1]: {"name":"x"}', SCHEMA)).toThrow('does not fit the schema: $.kind is required');
  expect(() => structuredOutput('no json here', SCHEMA)).toThrow('the model answered with no JSON');
  // A bracket inside a string closes nothing.
  expect(extractJson('text {"a":{"b":"\\"}"}} tail')).toEqual({ a: { b: '"}' } });
  // Degenerate output costs about its length, not its square: brackets that never close, nested ones around junk, deeply nested JSON that does not fit.
  const started = performance.now();
  const junk = `${'['.repeat(50_000)}${'['.repeat(25_000)}x${']'.repeat(25_000)}${'['.repeat(25_000)}${']'.repeat(25_000)}`;
  expect(structuredOutput(`${junk} {"name":"x","kind":"a"}`, SCHEMA)).toEqual({ name: 'x', kind: 'a' });
  expect(performance.now() - started).toBeLessThan(1_000);
});
