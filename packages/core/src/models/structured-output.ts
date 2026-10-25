import { isRecord, parseJson } from '../json';
import type { JsonSchema } from './types';

const FENCE = /```(?:json)?\s*([\s\S]*?)```/;
const OPENER = /[[{]/;

/** The whole text as JSON, else the fenced block, else the first balanced object or array that parses; undefined when none does. */
export function extractJson(text: string): unknown | undefined {
  const whole = parseJson(text.trim());
  if (whole !== undefined) return whole;
  const fenced = FENCE.exec(text)?.[1];
  if (fenced !== undefined) {
    const value = parseJson(fenced.trim());
    if (value !== undefined) return value;
  }
  for (let start = text.search(OPENER); start !== -1; ) {
    const end = balancedEnd(text, start);
    if (end !== -1) {
      const value = parseJson(text.slice(start, end + 1));
      if (value !== undefined) return value;
    }
    const next = text.slice(start + 1).search(OPENER);
    start = next === -1 ? -1 : start + 1 + next;
  }
  return undefined;
}

function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
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

/** The model's text answer as JSON that fits the schema; throws with the reason when it has none or does not fit. */
export function structuredOutput(text: string, schema: JsonSchema): unknown {
  const value = extractJson(text);
  if (value === undefined) throw new Error('the model answered with no JSON');
  const violation = conforms(value, schema);
  if (violation) throw new Error(`the answer does not fit the schema: ${violation}`);
  return value;
}
