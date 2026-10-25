import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classificationPrompt,
  classifyWarnings,
  IdentifierClassifier,
  identifierKey,
  parseClassification,
  type Classification,
  type Identifier,
} from '../../src/c4/classify';
import type { StructuredModel, StructuredRequest } from '../../src/models/types';
import { GatedModel, ScriptedModel } from '../models/fake-models';
import { tempDir } from '../helpers';

const pkg = (name: string, ecosystem = 'python'): Identifier => ({ type: 'package', ecosystem, name });
const image = (name: string, hint?: string): Identifier => ({ type: 'image', ecosystem: 'docker', name, ...(hint ? { hint } : {}) });
const host = (name: string): Identifier => ({ type: 'host', ecosystem: 'url', name });

const numberedLines = (prompt: string) =>
  prompt
    .split('\n')
    .map((line) => /^(\d+)\.\s(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null);

type Answer = Omit<Classification, 'generic' | 'protocol'> & Partial<Classification>;
const TABLE: Record<string, Answer | null> = {
  sqlalchemy: { system: 'SQL database', kind: 'database', generic: true },
  postgres: { system: 'PostgreSQL', kind: 'database', protocol: 'SQL' },
  'graph.microsoft.com': { system: 'Microsoft 365', kind: 'source' },
  redis: { system: 'Redis', kind: 'cache' },
  fastapi: null,
};

// Answers every numbered line whose text holds a known name, the longest name winning.
function answer(request: StructuredRequest, table: Record<string, Answer | null> = TABLE): unknown {
  const known = Object.keys(table).sort((a, b) => b.length - a.length);
  return {
    items: numberedLines(request.prompt).flatMap(([, n, text]) => {
      const name = known.find((k) => text!.includes(k));
      if (name === undefined) return [];
      const found = table[name];
      return [
        found
          ? { n: Number(n), external: true, system: found.system, kind: found.kind, generic: found.generic ?? false, protocol: found.protocol ?? '' }
          : { n: Number(n), external: false, system: '', kind: 'other', generic: false, protocol: '' },
      ];
    }),
  };
}

const askedNames = (request: StructuredRequest | undefined) => {
  const known = Object.keys(TABLE).sort((a, b) => b.length - a.length);
  return numberedLines(request?.prompt ?? '').map(([, , text]) => known.find((k) => text!.includes(k)) ?? text);
};

class FailingModel implements StructuredModel {
  readonly requests: StructuredRequest[] = [];
  failing = true;

  async generate(request: StructuredRequest): Promise<unknown> {
    this.requests.push(request);
    if (this.failing) throw new Error('rate limited\nretry later');
    return answer(request);
  }
}

describe('classificationPrompt', () => {
  it('numbers the identifiers in order, starting at 1', () => {
    const lines = numberedLines(classificationPrompt([pkg('sqlalchemy'), image('postgres'), host('graph.microsoft.com')]));
    expect(lines.map(([, n, text]) => [n, ['sqlalchemy', 'postgres', 'graph.microsoft.com'].find((name) => text!.includes(name))])).toEqual([
      ['1', 'sqlalchemy'],
      ['2', 'postgres'],
      ['3', 'graph.microsoft.com'],
    ]);
  });

  it('lists nothing but the given identifiers', () => {
    const ids = [pkg('sqlalchemy'), host('graph.microsoft.com')];
    expect(numberedLines(classificationPrompt(ids))).toHaveLength(ids.length);
  });

  it('shows the hint of an identifier', () => {
    expect(classificationPrompt([image('tensorchord/vchord-suite', 'compose service "postgres"')])).toContain('compose service "postgres"');
  });
});

describe('parseClassification', () => {
  const ids = [pkg('sqlalchemy'), image('postgres')];
  const item = (n: number, overrides: Record<string, unknown> = {}) => ({
    n,
    external: true,
    system: 'PostgreSQL',
    kind: 'database',
    generic: false,
    protocol: 'SQL',
    ...overrides,
  });

  it('maps each numbered answer to the identifier on that line', () => {
    const result = parseClassification({ items: [item(2)] }, ids);
    expect(result.get(identifierKey(image('postgres')))).toEqual({ system: 'PostgreSQL', kind: 'database', generic: false, protocol: 'SQL' });
  });

  it('returns null for an identifier the model says is not an external system', () => {
    const result = parseClassification({ items: [item(1, { external: false, system: '', kind: 'other' })] }, ids);
    expect(result.get(identifierKey(pkg('sqlalchemy')))).toBeNull();
  });

  it('files an unknown kind under other', () => {
    const result = parseClassification({ items: [item(2, { kind: 'mainframe' })] }, ids);
    expect(result.get(identifierKey(image('postgres')))?.kind).toBe('other');
  });

  it('shortens an overlong system name', () => {
    const long = `PostgreSQL ${'x'.repeat(500)}`;
    const system = parseClassification({ items: [item(2, { system: long })] }, ids).get(identifierKey(image('postgres')))?.system ?? '';
    expect([long.startsWith(system), system.length > 0 && system.length <= 64]).toEqual([true, true]);
  });

  it('shortens an overlong protocol label', () => {
    const protocol = parseClassification({ items: [item(2, { protocol: 'S'.repeat(200) })] }, ids).get(identifierKey(image('postgres')))?.protocol ?? '';
    expect(protocol.length).toBeLessThanOrEqual(32);
  });

  it('treats a missing or non-boolean generic flag as false', () => {
    const result = parseClassification({ items: [item(1, { generic: 'yes' }), item(2, { generic: undefined })] }, ids);
    expect([result.get(identifierKey(pkg('sqlalchemy')))?.generic, result.get(identifierKey(image('postgres')))?.generic]).toEqual([false, false]);
  });

  it('ignores answers whose number names no identifier', () => {
    const result = parseClassification({ items: [item(0), item(3), item(-1), item(1.5), item(1)] }, ids);
    expect([...result.keys()]).toEqual([identifierKey(pkg('sqlalchemy'))]);
  });

  it.each([null, 'PostgreSQL', { items: 'x' }, { items: [{ external: true, system: 'X' }] }, { answers: [] }])('returns nothing for the malformed answer %j', (raw) => {
    expect(parseClassification(raw, ids).size).toBe(0);
  });

  it('leaves identifiers the model did not answer out of the result', () => {
    expect(parseClassification({ items: [item(1)] }, ids).has(identifierKey(image('postgres')))).toBe(false);
  });
});

describe('IdentifierClassifier', () => {
  let clock = 0;
  let changes = 0;
  let cachePath = '';
  const classifiers: IdentifierClassifier[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    clock = 1_000_000;
    changes = 0;
    cachePath = join(tempDir('ide-c4-classify-'), 'cache', 'c4-classification.json');
  });

  afterEach(() => {
    for (const classifier of classifiers.splice(0)) classifier.stop();
    vi.useRealTimers();
  });

  function start(model: StructuredModel, onChange: () => void = () => (changes += 1)): IdentifierClassifier {
    const classifier = new IdentifierClassifier({ model, cachePath, onChange, now: () => clock });
    classifiers.push(classifier);
    return classifier;
  }

  // Moves the fake clock and timers together, then lets the model's answer settle.
  async function elapse(ms: number): Promise<void> {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
    await new Promise((resolve) => setImmediate(resolve));
  }

  const SETTLE = 1000;
  const MINUTE = 60_000;

  it('classifies identifiers requested close together in one model call', async () => {
    const model = new ScriptedModel(answer);
    const classifier = start(model);
    classifier.request([pkg('sqlalchemy')]);
    classifier.request([image('postgres'), host('graph.microsoft.com')]);
    await elapse(SETTLE);
    expect([model.requests.length, askedNames(model.requests[0])]).toEqual([1, ['sqlalchemy', 'postgres', 'graph.microsoft.com']]);
  });

  it('answers lookups with the classifications it received', async () => {
    const classifier = start(new ScriptedModel(answer));
    classifier.request([image('postgres')]);
    await elapse(SETTLE);
    expect(classifier.lookup(image('postgres'))).toEqual({ system: 'PostgreSQL', kind: 'database', generic: false, protocol: 'SQL' });
  });

  it('answers null for an identifier the model says is not an external system', async () => {
    const classifier = start(new ScriptedModel(answer));
    classifier.request([pkg('fastapi')]);
    await elapse(SETTLE);
    expect(classifier.lookup(pkg('fastapi'))).toBeNull();
  });

  it('answers undefined for an identifier not classified yet', () => {
    expect(start(new ScriptedModel(answer)).lookup(pkg('sqlalchemy'))).toBeUndefined();
  });

  it('does not ask again about identifiers it has classified', async () => {
    const model = new ScriptedModel(answer);
    const classifier = start(model);
    classifier.request([pkg('sqlalchemy'), pkg('fastapi')]);
    await elapse(SETTLE);
    classifier.request([pkg('sqlalchemy'), pkg('fastapi')]);
    await elapse(SETTLE);
    expect(model.requests).toHaveLength(1);
  });

  it('does not ask again about identifiers the model is classifying now', async () => {
    const model = new GatedModel();
    const classifier = start(model);
    classifier.request([pkg('sqlalchemy')]);
    await elapse(SETTLE);
    classifier.request([pkg('sqlalchemy'), pkg('redis')]);
    model.answer(answer);
    await elapse(SETTLE);
    expect([model.requests.length, askedNames(model.requests[1])]).toEqual([2, ['redis']]);
  });

  it('treats the same name in another ecosystem as a different identifier', async () => {
    const model = new ScriptedModel(answer);
    const classifier = start(model);
    classifier.request([pkg('redis', 'npm')]);
    await elapse(SETTLE);
    classifier.request([pkg('redis', 'python')]);
    await elapse(SETTLE);
    expect(model.requests).toHaveLength(2);
  });

  it('counts the identifiers waiting to be classified', () => {
    const classifier = start(new ScriptedModel(answer));
    classifier.request([pkg('sqlalchemy'), image('postgres')]);
    expect(classifier.status().waiting).toBe(2);
  });

  it('calls onChange after classifying a batch', async () => {
    const classifier = start(new ScriptedModel(answer));
    classifier.request([pkg('sqlalchemy')]);
    await elapse(SETTLE);
    expect(changes).toBe(1);
  });

  it('saves its classifications so that a new classifier reads them back', async () => {
    start(new ScriptedModel(answer)).request([image('postgres'), pkg('fastapi')]);
    await elapse(SETTLE);
    const reloaded = start(new ScriptedModel(answer));
    expect([reloaded.lookup(image('postgres'))?.system, reloaded.lookup(pkg('fastapi'))]).toEqual(['PostgreSQL', null]);
  });

  it('does not ask the model about names it read from its cache file', async () => {
    start(new ScriptedModel(answer)).request([image('postgres')]);
    await elapse(SETTLE);
    const model = new ScriptedModel(answer);
    start(model).request([image('postgres')]);
    await elapse(SETTLE);
    expect(model.requests).toHaveLength(0);
  });

  it('starts empty when its cache file is not valid JSON', () => {
    const dir = tempDir('ide-c4-classify-');
    cachePath = join(dir, 'c4-classification.json');
    writeFileSync(cachePath, '{ not json');
    expect(start(new ScriptedModel(answer)).lookup(image('postgres'))).toBeUndefined();
  });

  it('does not keep asking about an identifier the model leaves unanswered', async () => {
    const model = new ScriptedModel((request: StructuredRequest) => answer(request, { postgres: TABLE.postgres! }));
    const ids = [image('postgres'), pkg('mystery_sdk')];
    // Like CodeRay core: every change republishes the map, which requests what is still unclassified.
    const classifier = start(model, () => classifier.request(ids));
    classifier.request(ids);
    await elapse(MINUTE);
    expect(model.requests.length).toBeLessThanOrEqual(2);
  });

  describe('after a model failure', () => {
    it('reports the failure in its status, and in the C4 warnings unless the background AI is off by choice', async () => {
      const classifier = start(new FailingModel());
      classifier.request([pkg('sqlalchemy')]);
      await elapse(SETTLE);
      const status = classifier.status();
      const off = (reason: 'choice' | 'none') => classifyWarnings(status, { state: 'off', reason, engine: null, hint: 'h' });
      expect([status.failure, classifyWarnings(status, { state: 'checking' }), off('choice'), off('none')]).toEqual([
        expect.stringContaining('rate limited'),
        ['Classifying 1 package, image and host names', `Could not classify names: ${status.failure}`],
        [],
        [`Could not classify names: ${status.failure}`],
      ]);
    });

    it('does not ask again within five minutes, unless the background AI is back', async () => {
      const model = new FailingModel();
      const classifier = start(model);
      classifier.request([pkg('sqlalchemy')]);
      await elapse(SETTLE);
      model.failing = false;
      classifier.request([pkg('sqlalchemy'), pkg('redis')]);
      await elapse(4 * MINUTE);
      expect(model.requests).toHaveLength(1);
      classifier.resume();
      await elapse(SETTLE);
      expect([model.requests.length, classifier.lookup(pkg('redis'))?.system]).toEqual([2, 'Redis']);
    });

    it('asks again once five minutes have passed', async () => {
      const model = new FailingModel();
      const classifier = start(model);
      classifier.request([pkg('sqlalchemy')]);
      await elapse(SETTLE);
      model.failing = false;
      await elapse(5 * MINUTE);
      expect([model.requests.length, classifier.lookup(pkg('sqlalchemy'))?.system]).toEqual([2, 'SQL database']);
    });

    it('clears the failure once a retry succeeds', async () => {
      const model = new FailingModel();
      const classifier = start(model);
      classifier.request([pkg('sqlalchemy')]);
      await elapse(SETTLE);
      model.failing = false;
      await elapse(5 * MINUTE);
      expect(classifier.status().failure).toBeNull();
    });
  });

  describe('when stopped', () => {
    it('aborts the model call in flight', async () => {
      const model = new GatedModel();
      const classifier = start(model);
      classifier.request([pkg('sqlalchemy')]);
      await elapse(SETTLE);
      classifier.stop();
      expect(model.cancelled).toBe(true);
    });

    it('does not report the aborted call as a change', async () => {
      const model = new GatedModel();
      const classifier = start(model);
      classifier.request([pkg('sqlalchemy')]);
      await elapse(SETTLE);
      classifier.stop();
      await elapse(SETTLE);
      expect(changes).toBe(0);
    });

    it('ignores later requests', async () => {
      const model = new ScriptedModel(answer);
      const classifier = start(model);
      classifier.stop();
      classifier.request([pkg('sqlalchemy')]);
      await elapse(SETTLE);
      expect(model.requests).toHaveLength(0);
    });

    it('does not ask about requests still waiting for their batch', async () => {
      const model = new ScriptedModel(answer);
      const classifier = start(model);
      classifier.request([pkg('sqlalchemy')]);
      classifier.stop();
      await elapse(SETTLE);
      expect(model.requests).toHaveLength(0);
    });
  });
});
