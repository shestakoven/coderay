import { isRecord, parseJson } from '../json';
import type { JsonSchema } from './types';

interface Candidate { value: unknown; size: number }

/** The first balanced object or array in the text that parses (the whole text, a fenced block or JSON inside prose); undefined when none does. */
export function extractJson(text: string): unknown | undefined {
  for (const { value } of candidates(text)) return value;
  return undefined;
}

/**
 * The JSON the text holds, in reading order: each balanced object or array that parses and is not inside one already given.
 * Every character is scanned about once, so a run of brackets costs no more than its length.
 */
function* candidates(text: string): Generator<Candidate> {
  const ends = new Map<number, number>();
  // What JSON.parse may read of spans that do not parse: past it, a span that fails is skipped whole, so nested junk is not parsed again at each depth.
  let budget = 4 * text.length;
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const end = ends.get(start) ?? closeOf(text, start, ends);
    if (end === -1) continue;
    const value = parseJson(text.slice(start, end + 1));
    if (value === undefined) {
      budget -= end + 1 - start;
      if (budget < 0) start = end;
      continue;
    }
    yield { value, size: end + 1 - start };
    start = end;
  }
}

/**
 * Where the object or array opened at `start` closes, -1 when it never does. Every opener the scan meets outside a string is recorded in `ends`
 * (its scan from there would be the same), and one already recorded is jumped over.
 */
function closeOf(text: string, start: number, ends: Map<number, number>): number {
  const open = [start];
  let inString = false;
  for (let i = start + 1; i < text.length && open.length > 0; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') {
      const known = ends.get(i);
      if (known === undefined) open.push(i);
      else if (known === -1) break;
      else i = known;
    } else if (ch === '}' || ch === ']') ends.set(open.pop()!, i);
  }
  for (const unclosed of open) ends.set(unclosed, -1);
  return ends.get(start)!;
}

const typeOf = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;

function matches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true; // a pattern JavaScript cannot read is not checked (lenient, like an unknown keyword)
  }
}

/** The first violation of the schema keywords the map's schemas use; null when the value fits. Unknown keywords are not checked. */
export function conforms(value: unknown, schema: JsonSchema, path = '$'): string | null {
  if (Array.isArray(schema.anyOf)) {
    return (schema.anyOf as JsonSchema[]).some((option) => conforms(value, option, path) === null) ? null : `${path} matches no option`;
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) return `${path} is not ${JSON.stringify(schema.const)}`;
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    return `${path} is not one of ${schema.enum.join(', ')}`;
  }
  const types = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? (schema.type as string[]) : [];
  const actual = typeOf(value);
  if (types.length > 0 && !types.some((type) => type === actual || (type === 'number' && actual === 'integer'))) {
    return `${path} is not of type ${types.join(' or ')}`;
  }
  if (typeof value === 'string') {
    // JSON Schema counts code points, not UTF-16 units.
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) return `${path} is shorter than ${schema.minLength} characters`;
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) return `${path} is longer than ${schema.maxLength} characters`;
    if (typeof schema.pattern === 'string' && !matches(schema.pattern, value)) return `${path} does not match ${schema.pattern}`;
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!Object.hasOwn(value, key)) return `${path}.${key} is required`;
    }
    for (const [key, child] of Object.entries(value)) {
      // Own keys only, so "__proto__" or "constructor" in an answer never reads the prototype as a rule.
      const rule = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (isRecord(rule)) {
        const violation = conforms(child, rule, `${path}.${key}`);
        if (violation) return violation;
      } else if (schema.additionalProperties === false) return `${path}.${key} is not allowed`;
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `${path} has fewer than ${schema.minItems} items`;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${path} has more than ${schema.maxItems} items`;
    if (isRecord(schema.items)) {
      for (const [index, item] of value.entries()) {
        const violation = conforms(item, schema.items, `${path}[${index}]`);
        if (violation) return violation;
      }
    }
  }
  return null;
}

/**
 * The first JSON in the model's text answer that fits the schema: a restated schema, an example or a "[1]" before the answer is passed over.
 * Throws with the reason when there is none: no JSON, or the violation of the largest JSON, the likeliest to be the answer.
 */
export function structuredOutput(text: string, schema: JsonSchema): unknown {
  let largest: { size: number; violation: string } | null = null;
  for (const { value, size } of candidates(text)) {
    const violation = conforms(value, schema);
    if (violation === null) return value;
    if (largest === null || size > largest.size) largest = { size, violation };
  }
  if (largest === null) throw new Error('the model answered with no JSON');
  throw new Error(`the answer does not fit the schema: ${largest.violation}`);
}
