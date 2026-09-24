import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it, onTestFinished } from 'vitest';
import { openStore, type PromptRecord, type SessionRecord, type ToolEventRecord } from '../../src/store/store';
import { tempDir } from '../helpers';

const session = (id: string, startedAt: number): SessionRecord => ({
  id, claudeSessionId: `claude-${id}`, cwd: '/project', status: 'running', model: null, cliVersion: null,
  pid: 42, launchId: `claude-${id}`, conversationStarted: false, startedAt,
});

const toolEvent: ToolEventRecord = {
  toolUseId: 'toolu_1', seq: 3, turnId: 't1', parentToolUseId: null, tool: 'Write',
  input: { file_path: 'a.ts', content: 'x' }, status: 'running', toolUseAt: 3, endedAt: null,
};

const prompt: PromptRecord = {
  requestId: 'req_1', seq: 4, turnId: 't1', parentToolUseId: null, body: { tool: 'ExitPlanMode', plan: 'Create a.ts' },
  status: 'answered', answer: { kind: 'allow' }, ts: 4,
};

function freshStore(dir = tempDir('ide-store-')) {
  const store = openStore(dir);
  onTestFinished(() => store.close());
  return store;
}

describe('openStore', () => {
  it('saves a session with its turns, messages, tool events, tasks and prompts and loads them back in order', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveTurn('s1', { id: 't1', kind: 'user', openedAt: 1, startedAt: 2, closedAt: 5, resultSubtype: 'success' });
    store.saveMessage('s1', { id: 'm2', seq: 2, turnId: 't1', parentToolUseId: null, role: 'assistant', text: 'hi', ts: 2 });
    store.saveMessage('s1', { id: 'm1', seq: 1, turnId: 't1', parentToolUseId: null, role: 'user', text: 'hello', ts: 1 });
    store.saveToolEvent('s1', toolEvent);
    store.saveTask('s1', { id: 'task1', toolUseId: 'toolu_1', kind: 'subagent', description: 'sub', status: 'running', startedAt: 5, endedAt: null });
    store.savePrompt('s1', prompt);

    expect(store.history('s1')).toEqual({
      turns: [{ id: 't1', kind: 'user', openedAt: 1, startedAt: 2, closedAt: 5, resultSubtype: 'success' }],
      messages: [
        { id: 'm1', seq: 1, turnId: 't1', parentToolUseId: null, role: 'user', text: 'hello', ts: 1 },
        { id: 'm2', seq: 2, turnId: 't1', parentToolUseId: null, role: 'assistant', text: 'hi', ts: 2 },
      ],
      toolEvents: [toolEvent],
      tasks: [{ id: 'task1', toolUseId: 'toolu_1', kind: 'subagent', description: 'sub', status: 'running', startedAt: 5, endedAt: null }],
      prompts: [prompt],
    });
  });

  it('returns the most recently started session as the latest', () => {
    const store = freshStore();
    expect(store.latestSession()).toBeNull();
    store.saveSession(session('old', 1));
    store.saveSession(session('new', 2));
    expect(store.latestSession()).toEqual(session('new', 2));
  });

  it('updates a saved tool event in place when it ends', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveToolEvent('s1', toolEvent);
    store.saveToolEvent('s1', { ...toolEvent, status: 'ok', endedAt: 9 });
    expect(store.history('s1').toolEvents).toEqual([{ ...toolEvent, status: 'ok', endedAt: 9 }]);
  });

  it("keeps a turn's corrected kind when it is saved again", () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveTurn('s1', { id: 't1', kind: 'agent-initiated', openedAt: 1, startedAt: null, closedAt: null, resultSubtype: null });
    store.saveTurn('s1', { id: 't1', kind: 'user', openedAt: 1, startedAt: 2, closedAt: 5, resultSubtype: 'success' });
    expect(store.history('s1').turns).toEqual([{ id: 't1', kind: 'user', openedAt: 1, startedAt: 2, closedAt: 5, resultSubtype: 'success' }]);
  });

  it('can be closed twice', () => {
    const store = freshStore();
    store.close();
    expect(() => store.close()).not.toThrow();
  });

  it("waits for another process's write lock instead of failing at once", async () => {
    const dir = tempDir('ide-store-');
    const store = freshStore(dir);
    const holder = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(join(dir, 'history.sqlite'))});
      db.exec('BEGIN IMMEDIATE');
      console.log('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);
    `]);
    onTestFinished(() => {
      holder.kill();
    });
    await new Promise<void>((resolve) => createInterface({ input: holder.stdout }).once('line', () => resolve()));

    store.saveSession(session('s1', 1));

    expect(store.latestSession()?.id).toBe('s1');
  });
});
