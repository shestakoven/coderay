import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchModels, parseModels } from '../../src/models/catalog';
import { tempDir } from '../helpers';

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const response = (models: unknown[], requestId = 'models') => JSON.stringify({
  type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { models } },
});

describe('parseModels', () => {
  it('keeps the value and display name of every model and drops the CLI-chosen default', () => {
    const line = response([
      { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-sonnet-5-5' },
      { value: 'sonnet', displayName: 'Sonnet 5.5' },
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6' },
    ]);
    expect(parseModels(line)).toEqual([
      { value: 'sonnet', name: 'Sonnet 5.5', engine: 'claude', efforts: CLAUDE_EFFORTS },
      { value: 'claude-opus-4-6', name: 'Opus 4.6', engine: 'claude', efforts: CLAUDE_EFFORTS },
    ]);
  });

  it('skips entries without a string value or display name', () => {
    expect(parseModels(response([{ value: 'opus' }, { displayName: 'X' }, null, { value: 'haiku', displayName: 'Haiku 4.5' }])))
      .toEqual([{ value: 'haiku', name: 'Haiku 4.5', engine: 'claude', efforts: CLAUDE_EFFORTS }]);
  });

  it("offers the effort levels claude names for a model, none when it names none or only levels CodeRay does not know, and all five when it says nothing", () => {
    const line = response([
      { value: 'opus', displayName: 'Opus 5.5', supportedEffortLevels: ['low', 'high', 'ultra'] },
      { value: 'haiku', displayName: 'Haiku 4.5', supportedEffortLevels: [] },
      { value: 'fable', displayName: 'Fable 5.1', supportedEffortLevels: ['ultra'] },
      { value: 'sonnet', displayName: 'Sonnet 5.5' },
    ]);
    expect(parseModels(line)?.map((model) => [model.value, model.efforts])).toEqual([['opus', ['low', 'high']], ['haiku', []], ['fable', []], ['sonnet', CLAUDE_EFFORTS]]);
  });

  it.each([
    ['another request id', response([{ value: 'a', displayName: 'A' }], 'other')],
    ['a different message type', JSON.stringify({ type: 'system', subtype: 'init' })],
    ['not JSON', 'hook started'],
  ])('ignores %s', (_name, line) => {
    expect(parseModels(line)).toBeNull();
  });
});

const script = (body: string): { command: string; args: string[] } => {
  const file = join(tempDir('ide-models-'), 'claude.mjs');
  writeFileSync(file, body);
  return { command: process.execPath, args: [file] };
};

describe('fetchModels', () => {
  it('asks claude to initialize and returns the models from the answer', async () => {
    const claude = script(`
      import { createInterface } from 'node:readline';
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        console.log('not json noise');
        console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { models: [{ value: request.request.subtype, displayName: 'Asked ' + request.request.subtype }] } } }));
      }
    `);
    expect(await fetchModels(claude, tempDir('ide-cwd-'))).toEqual([{ value: 'initialize', name: 'Asked initialize', engine: 'claude', efforts: CLAUDE_EFFORTS }]);
  });

  it('returns an empty list when claude exits without answering', async () => {
    expect(await fetchModels(script('process.exit(1);'), tempDir('ide-cwd-'))).toEqual([]);
  });

  it('returns an empty list when claude cannot be started', async () => {
    expect(await fetchModels({ command: '/nonexistent/claude', args: [] }, tempDir('ide-cwd-'))).toEqual([]);
  });

  it('gives up on a claude that never answers', async () => {
    expect(await fetchModels(script('setInterval(() => {}, 1000);'), tempDir('ide-cwd-'), 300)).toEqual([]);
  });
});
