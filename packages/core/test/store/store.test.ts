import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it, onTestFinished } from 'vitest';
import { openStore, type PromptRecord, type SessionRecord, type ToolEventRecord } from '../../src/store/store';
import type { GateEventRecord, PlanRecord, ToolDecisionRecord } from '../../src/store/store';
import { DatabaseSync } from '../../src/store/sqlite';
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

const plan: PlanRecord = {
  id: 'plan-1', version: 1, goal: 'Fix the bug', status: 'approved', approvedBy: 'auto',
  steps: [{ key: 'edit', order: 1, title: 'Edit app', rationale: 'the bug is there', targets: [{ path: 'src/app.ts', op: 'modify' }] }],
  scope: { paths: ['src/app.ts'], globs: [] }, owners: { 'src/app.ts': 'app' }, review: { auto: true, notes: ['1 file in App'] },
  feedback: null, proposedAt: 10, decidedAt: 10,
};

const decision: ToolDecisionRecord = {
  toolUseId: 'toolu_1', decision: 'allow', planId: 'plan-1', planVersion: 1, stepKey: 'edit', targets: ['src/app.ts'], reason: 'IDE: allowed', decidedAt: 11,
};

const gateEvent: GateEventRecord = {
  id: 'ev-1', toolUseId: 'toolu_2', kind: 'pre-execution', mode: 'A', targets: ['src/other.ts'], prompt: null, resolution: 'denied', ts: 12, resolvedAt: 12,
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
      decisions: [],
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

  it('creates the project dir 0700 and the history db 0600, since both hold full tool inputs', () => {
    const dir = join(tempDir('ide-home-'), 'projects', 'abc123');
    freshStore(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'history.sqlite')).mode & 0o777).toBe(0o600);
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

  it('saves plan versions and step states and loads them back per session', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveSession(session('s2', 2));
    store.savePlan('s1', plan);
    store.savePlan('s1', { ...plan, version: 2, status: 'proposed', approvedBy: null, proposedAt: 20, decidedAt: null });
    store.savePlan('s2', { ...plan, id: 'plan-9' });
    store.saveStepState('plan-1', 'edit', 'active');
    store.saveStepState('plan-1', 'edit', 'done');
    expect(store.plans('s1')).toEqual({
      plans: [plan, { ...plan, version: 2, status: 'proposed', approvedBy: null, proposedAt: 20, decidedAt: null }],
      stepStates: { 'plan-1': { edit: 'done' } },
    });
  });

  it('updates a plan version in place', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.savePlan('s1', { ...plan, status: 'proposed' });
    store.savePlan('s1', { ...plan, status: 'rejected', feedback: 'no' });
    expect(store.plans('s1').plans).toEqual([{ ...plan, status: 'rejected', feedback: 'no' }]);
  });

  it('keeps one decision per tool call, the latest', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveToolDecision('s1', { ...decision, decision: 'deny' });
    store.saveToolDecision('s1', decision);
    expect(store.history('s1').decisions).toEqual([decision]);
  });

  it('saves gate events and their resolution', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveGateEvent('s1', { ...gateEvent, resolution: 'pending', resolvedAt: null });
    store.saveGateEvent('s1', gateEvent);
    expect(store.gateEvents('s1')).toEqual([gateEvent]);
  });

  it('adds the plan tables to a Plan 3 history and keeps its sessions', () => {
    const dir = tempDir('ide-store-');
    const first = openStore(dir);
    first.saveSession(session('s1', 1));
    first.close();
    const db = new DatabaseSync(join(dir, 'history.sqlite'));
    db.exec('DROP TABLE plans; DROP TABLE step_states; DROP TABLE tool_decisions; DROP TABLE gate_events; PRAGMA user_version = 1;');
    db.close();
    const store = freshStore(dir);
    store.savePlan('s1', plan);
    expect([store.latestSession()?.id, store.plans('s1').plans]).toEqual(['s1', [plan]]);
  });

  it('refuses a history written by a newer IDE', () => {
    const dir = tempDir('ide-store-');
    openStore(dir).close();
    const db = new DatabaseSync(join(dir, 'history.sqlite'));
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(() => openStore(dir)).toThrow('history.sqlite has schema version 99, newer than this IDE understands (2)');
  });

  it('refuses a migration that fails partway, leaving the schema and version unchanged', () => {
    const dir = tempDir('ide-store-');
    const first = openStore(dir);
    first.saveSession(session('s1', 1));
    first.close();
    const db = new DatabaseSync(join(dir, 'history.sqlite'));
    db.exec('DROP TABLE plans; DROP TABLE step_states; DROP TABLE tool_decisions; DROP TABLE gate_events; PRAGMA user_version = 1;');
    db.exec('CREATE INDEX step_states ON sessions (id)');
    db.close();

    expect(() => openStore(dir)).toThrow();

    const check = new DatabaseSync(join(dir, 'history.sqlite'));
    const userVersion = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const plansTable = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plans'").all();
    check.close();

    expect(userVersion).toBe(1);
    expect(plansTable).toEqual([]);
  });
});
