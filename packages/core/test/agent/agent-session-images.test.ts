import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { ChatImage, ChatItem, SessionServerMessage } from '@ide/protocol';
import { AgentSession } from '../../src/agent/agent-session';
import { projectDir } from '../../src/home';
import { openStore, type Store } from '../../src/store/store';
import { fakeClaude } from '../fake-claude/fake';
import { fixture, tempDir, waitFor } from '../helpers';
import { png } from '../images/bytes';

interface Harness {
  session: AgentSession;
  store: Store;
  blobs: string;
  broadcasts: SessionServerMessage[];
}

async function harness(scenario: string, before?: (blobs: string) => void): Promise<Harness> {
  const home = tempDir('ide-home-');
  const root = tempDir('ide-root-');
  const blobs = join(projectDir(home, root), 'blobs');
  before?.(blobs);
  const store = openStore(projectDir(home, root));
  onTestFinished(() => store.close());
  const session = new AgentSession({ root, home, store, claude: fakeClaude(scenario, join(home, `record-${randomUUID()}.jsonl`)) });
  const broadcasts: SessionServerMessage[] = [];
  session.onMessage((message) => broadcasts.push(message));
  onTestFinished(() => session.close());
  await session.start();
  return { session, store, blobs, broadcasts };
}

const closedTurns = (h: Harness) => h.session.state().turns.filter((turn) => turn.closedAt !== null).length;

async function ask(h: Harness, text: string, images: ChatImage[] = []): Promise<void> {
  const closed = closedTurns(h);
  h.session.send(text, { images });
  await waitFor(() => closedTurns(h) > closed, `turn for "${text}" closed`);
}

const item = (h: Harness, find: (item: ChatItem) => boolean) => h.session.state().items.find(find);
const toolImages = (h: Harness, id: string) => {
  const found = item(h, (candidate) => candidate.kind === 'tool' && candidate.id === id);
  return found?.kind === 'tool' ? found.images : undefined;
};
const userImages = (h: Harness) => {
  const found = item(h, (candidate) => candidate.kind === 'message' && candidate.role === 'user');
  return found?.kind === 'message' ? found.images : undefined;
};
const attachment = (bytes: Buffer): ChatImage => ({ mediaType: 'image/png', data: bytes.toString('base64') });
const blobFiles = (h: Harness) => (existsSync(h.blobs) ? readdirSync(h.blobs).sort() : []);

function resultScenario(content: object[]): string {
  const S = '$SESSION';
  const line = (o: object) => JSON.stringify(o);
  const file = join(tempDir('ide-scenario-'), 'images.jsonl');
  writeFileSync(file, [
    line({ fake: 'await-user' }),
    line({ type: 'system', subtype: 'init', cwd: '/fake/project', session_id: S, mcp_servers: [], model: 'm', permissionMode: 'bypassPermissions', claude_code_version: '2.1.281' }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_shots', name: 'mcp__browser__shots', input: {} }] }, parent_tool_use_id: null, session_id: S }),
    line({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_shots', type: 'tool_result', content }] }, parent_tool_use_id: null, session_id: S }),
    line({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: S }),
    line({ fake: 'await-user' }),
  ].join('\n'));
  return file;
}

describe('AgentSession images', () => {
  it('puts the images a tool returned on its item and in the history as refs, with the bytes only in the blob store', async () => {
    const h = await harness('read-image');
    await ask(h, 'compare the screenshots');
    const read = toolImages(h, 'toolu_fx_read_shot');
    const page = toolImages(h, 'toolu_fx_page_shot');
    expect([read, page]).toEqual([
      [{ id: expect.stringMatching(/^[0-9a-f]{64}$/), mediaType: 'image/png', bytes: expect.any(Number), width: 64, height: 40 }],
      [{ id: expect.stringMatching(/^[0-9a-f]{64}$/), mediaType: 'image/png', bytes: expect.any(Number), width: 48, height: 30 }],
    ]);
    const sessionId = h.session.state().session!.id;
    expect(h.store.history(sessionId).toolEvents.flatMap((event) => event.images ?? [])).toEqual([...read!, ...page!]);
    expect(blobFiles(h)).toEqual([read![0]!.id, page![0]!.id].sort());
    const base64 = /"data":"(iVBOR[^"]{40})/.exec(readFileSync(fixture('stream/read-image.jsonl'), 'utf8'))![1]!;
    expect(JSON.stringify([h.session.state(), h.broadcasts])).not.toContain(base64);
  });

  it('keeps at most eight images of one result and leaves out parts that are not images', async () => {
    const part = (bytes: Buffer) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } });
    const h = await harness(resultScenario([
      { type: 'text', text: 'ten shots' },
      part(Buffer.from('plain text claiming to be a png')),
      ...Array.from({ length: 10 }, (_, index) => part(png(index + 1, 1))),
    ]));
    await ask(h, 'take ten shots');
    expect(toolImages(h, 'toolu_shots')?.map((image) => image.width)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('removes a deleted chat\'s images only once no remaining chat refers to them', async () => {
    const h = await harness('multi-turn');
    const shared = attachment(png(7, 7));
    await ask(h, 'first chat', [shared, attachment(png(8, 8))]);
    const first = h.session.state().session!.id;
    const [sharedId, firstOwn] = userImages(h)!.map((image) => image.id);
    await h.session.newSession();
    await ask(h, 'second chat', [shared, attachment(png(9, 9))]);
    const [, secondOwn] = userImages(h)!.map((image) => image.id);
    expect(blobFiles(h)).toEqual([sharedId, firstOwn, secondOwn].sort());

    await h.session.deleteSession(h.session.state().session!.id);
    await waitFor(() => !blobFiles(h).includes(secondOwn!), 'the open chat\'s own image removed');
    expect(blobFiles(h)).toEqual([sharedId, firstOwn].sort());

    await h.session.deleteSession(first);
    await waitFor(() => blobFiles(h).length === 0, 'the shared image removed with the last chat');
  });

  it('removes images no chat refers to when it starts, as a delete cut short leaves them', async () => {
    const orphan = 'a'.repeat(64);
    const h = await harness('multi-turn', (blobs) => {
      mkdirSync(blobs, { recursive: true });
      writeFileSync(join(blobs, orphan), png(1, 1));
    });
    await waitFor(() => blobFiles(h).length === 0, 'the orphaned image removed');
  });
});
