import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it, onTestFinished } from 'vitest';
import { openStore, SCHEMA_V1, SCHEMA_V2, type PromptRecord, type SessionRecord, type ToolEventRecord } from '../../src/store/store';
import type { GateEventRecord, PlanRecord, ToolDecisionRecord } from '../../src/store/store';
import type { ChangeView, PlanFlow, WatchdogEventView } from '@ide/protocol';
import { DatabaseSync } from '../../src/store/sqlite';
import { tempDir } from '../helpers';

const session = (id: string, startedAt: number): SessionRecord => ({
  id, claudeSessionId: `claude-${id}`, cwd: '/project', status: 'running', model: null, modelChoice: null, effort: null, cliVersion: null,
  pid: 42, launchId: `claude-${id}`, conversationStarted: false, startedAt, accountId: null,
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
  feedback: null, flow: null, proposedAt: 10, decidedAt: 10,
};

const decision: ToolDecisionRecord = {
  toolUseId: 'toolu_1', decision: 'allow', planId: 'plan-1', planVersion: 1, stepKey: 'edit', targets: ['src/app.ts'], reason: 'CodeRay: allowed', decidedAt: 11,
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
    db.exec('DROP TABLE changes; DROP TABLE baselines; DROP TABLE checkpoints; DROP TABLE reverts; DROP TABLE summaries; DROP TABLE meta');
    db.exec('ALTER TABLE sessions DROP COLUMN model_choice; ALTER TABLE sessions DROP COLUMN effort; ALTER TABLE sessions DROP COLUMN title; ALTER TABLE sessions DROP COLUMN title_manual; ALTER TABLE sessions DROP COLUMN account_id');
    db.close();
    const store = freshStore(dir);
    store.savePlan('s1', plan);
    expect([store.latestSession()?.id, store.plans('s1').plans]).toEqual(['s1', [plan]]);
  });

  it('refuses a history written by a newer CodeRay', () => {
    const dir = tempDir('ide-store-');
    openStore(dir).close();
    const db = new DatabaseSync(join(dir, 'history.sqlite'));
    db.exec('PRAGMA user_version = 9');
    db.close();
    expect(() => openStore(dir)).toThrow('history.sqlite has schema version 9, newer than this CodeRay understands (8)');
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

const flow: PlanFlow = {
  nodes: [
    {
      id: 'route', title: 'POST /users', sub: 'Endpoint · create()', kind: 'endpoint', state: 'existing', steps: [],
      files: [{ op: '~', path: 'app/routes/users.py', note: 'create_user' }],
    },
    {
      id: 'service', title: 'UserService', sub: 'Service · create_user()', kind: 'service', state: 'create', steps: ['edit'],
      files: [{ op: '+', path: 'app/services/user_service.py', note: 'create_user' }, { op: '-', path: 'app/old_service.py' }],
    },
  ],
  edges: [{ from: 'route', to: 'service', label: 'create_user(data)', state: 'new', step: 'edit' }],
};

const otherFlow: PlanFlow = {
  nodes: [{ id: 'db', title: 'UserTable', sub: 'Store', kind: 'store', state: 'modify', steps: ['edit'], files: [] }],
  edges: [],
};

describe('plan flow storage', () => {
  it('returns a plan saved with a flow deeply equal, with empty step lists and optional fields kept as saved', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.savePlan('s1', { ...plan, flow });
    const [saved] = store.plans('s1').plans;
    expect(saved?.flow).toStrictEqual(flow);
    expect(saved?.flow?.nodes[0]?.steps).toStrictEqual([]);
    expect(saved?.flow?.nodes[1]?.files[1]).toStrictEqual({ op: '-', path: 'app/old_service.py' });
  });

  it('returns the rest of the plan unchanged next to its flow', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.savePlan('s1', { ...plan, flow });
    expect(store.plans('s1').plans).toEqual([{ ...plan, flow }]);
  });

  it('returns flow null, not undefined, for a plan saved without a flow', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.savePlan('s1', { ...plan, flow: null });
    const [saved] = store.plans('s1').plans;
    expect(saved?.flow).toBeNull();
    expect(Object.keys(saved ?? {})).toContain('flow');
  });

  it('keeps an empty flow distinct from no flow', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.savePlan('s1', { ...plan, flow: { nodes: [], edges: [] } });
    expect(store.plans('s1').plans[0]?.flow).toStrictEqual({ nodes: [], edges: [] });
  });

  it('replaces the flow when the same plan version is saved again with a different flow', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.savePlan('s1', { ...plan, flow });
    store.savePlan('s1', { ...plan, flow: otherFlow });
    expect(store.plans('s1').plans).toEqual([{ ...plan, flow: otherFlow }]);
  });

  it('clears the flow when the same plan version is saved again with null', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.savePlan('s1', { ...plan, flow });
    store.savePlan('s1', { ...plan, flow: null });
    expect(store.plans('s1').plans[0]?.flow).toBeNull();
  });

  it('adds a flow to a plan version saved without one', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.savePlan('s1', { ...plan, flow: null });
    store.savePlan('s1', { ...plan, flow });
    expect(store.plans('s1').plans[0]?.flow).toStrictEqual(flow);
  });

  it('keeps its own flow for each version of a plan', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.savePlan('s1', { ...plan, version: 1, flow });
    store.savePlan('s1', { ...plan, version: 2, flow: otherFlow });
    store.savePlan('s1', { ...plan, version: 3, flow: null });
    expect(store.plans('s1').plans.map((saved) => [saved.version, saved.flow])).toStrictEqual([[1, flow], [2, otherFlow], [3, null]]);
  });

  it('leaves the other version of a plan alone when one version changes its flow', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.savePlan('s1', { ...plan, version: 1, flow });
    store.savePlan('s1', { ...plan, version: 2, flow });
    store.savePlan('s1', { ...plan, version: 2, flow: otherFlow });
    expect(store.plans('s1').plans.map((saved) => [saved.version, saved.flow])).toStrictEqual([[1, flow], [2, otherFlow]]);
  });

  it('round-trips quotes, backslashes, newlines and unicode in flow text unchanged', () => {
    const text = 'He said "hi" and \'bye\'\nline two\ttabbed \\ back\\slash; DROP TABLE plans; -- Сервис 日本語 🚀  ';
    const tricky: PlanFlow = {
      nodes: [{
        id: 'n"1', title: text, sub: `${text}\r\n`, kind: 'module', state: 'modify', steps: ['edit'],
        files: [{ op: '~', path: 'src/a "b" ü/файл 🚀.ts', note: text }],
      }],
      edges: [],
    };
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.savePlan('s1', { ...plan, flow: tricky });
    expect(store.plans('s1').plans[0]?.flow).toStrictEqual(tricky);
    expect(store.plans('s1').plans).toHaveLength(1);
  });

  describe('a history written at schema version 5', () => {
    const schemaFiveHistory = (): string => {
      const dir = tempDir('ide-store-');
      const first = openStore(dir);
      first.saveSession(session('s1', 1));
      first.savePlan('s1', plan);
      first.close();
      const db = new DatabaseSync(join(dir, 'history.sqlite'));
      db.exec('ALTER TABLE plans DROP COLUMN flow');
      db.exec('ALTER TABLE sessions DROP COLUMN account_id');
      db.exec('ALTER TABLE baselines DROP COLUMN sig');
      db.exec('PRAGMA user_version = 5');
      db.close();
      return dir;
    };

    it('opens and keeps its plan row with flow null', () => {
      const store = freshStore(schemaFiveHistory());
      expect(store.plans('s1').plans).toStrictEqual([{ ...plan, flow: null }]);
    });

    it('accepts a flow on the next save of that plan', () => {
      const store = freshStore(schemaFiveHistory());
      store.savePlan('s1', { ...plan, flow });
      expect(store.plans('s1').plans).toStrictEqual([{ ...plan, flow }]);
    });

    it('accepts a flow on a plan saved after opening it', () => {
      const store = freshStore(schemaFiveHistory());
      store.savePlan('s1', { ...plan, id: 'plan-2', flow });
      expect(store.plans('s1').plans.map((saved) => [saved.id, saved.flow])).toStrictEqual([['plan-1', null], ['plan-2', flow]]);
    });

    it('moves to the current schema version', () => {
      const dir = schemaFiveHistory();
      freshStore(dir).close();
      const check = new DatabaseSync(join(dir, 'history.sqlite'));
      const version = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      check.close();
      expect(version).toBe(8);
    });
  });
});

const change = (id: string, at: number): ChangeView => ({
  id, path: `src/${id}.ts`, beforeHash: 'b'.repeat(40), afterHash: null, at, origin: 'agent-tool', enforcement: 'recorded', outOfPlan: true,
  toolUseIds: ['toolu_1', 'toolu_2'], planId: 'plan-1', planVersion: 2, stepKey: 'edit', eventId: 'ev-9', resolution: 'kept',
  added: 3, removed: null, stored: true, unreadable: true, beforeMode: 0o755,
});

const baseline = (path: string) => ({ path, hash: `h-${path}`, stored: true, size: 10, mode: 0o644 });

const watchdogView = (id: string, kind: WatchdogEventView['kind']): WatchdogEventView => ({
  id, kind, mode: 'B', phase: 'resolved', resolution: 'reverted', changes: [change('c1', 1)],
  toolCalls: [{ toolUseId: 'toolu_1', tool: 'Bash', summary: 'rm x', stepKey: null }], interrupted: true, paused: false,
  runningSubagents: 1, backgroundShell: true, unknownOrigin: false, snapshotSha: 'abc', canExpand: true, defaultAction: 'revert',
  reason: 'r', ts: 20, resolvedAt: 21,
});

describe('history tables (schema 3)', () => {
  it('migrates a version 2 database to 3 in one step and keeps its rows', () => {
    const dir = tempDir('ide-store-');
    const old = new DatabaseSync(join(dir, 'history.sqlite'));
    for (const sql of [SCHEMA_V1, SCHEMA_V2]) old.exec(sql);
    old.exec('PRAGMA user_version = 2');
    old.prepare("INSERT INTO sessions (id, claude_session_id, cwd, status, conversation_started, started_at) VALUES ('s','c','/p','running',0,1)").run();
    old.prepare("INSERT INTO step_states (plan_id, key, status) VALUES ('p','a','done')").run();
    old.prepare("INSERT INTO gate_events (id, session_id, kind, tool_use_id, mode, targets, resolution, ts) VALUES ('g','s','pre-execution','t','A','[]','denied',5)").run();
    old.close();

    const store = freshStore(dir);
    expect(store.latestSession()?.id).toBe('s');
    expect(store.gateEvents('s').map((event) => event.id)).toEqual(['g']);
    store.saveBaselines([baseline('a.ts')], []);
    expect(store.baselines()).toHaveLength(1);
    store.close();

    const check = new DatabaseSync(join(dir, 'history.sqlite'));
    const version = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const step = check.prepare("SELECT status, cycle FROM step_states WHERE plan_id = 'p'").get();
    check.close();
    expect(version).toBe(8);
    expect(step).toEqual({ status: 'done', cycle: 0 });
  });

  it('round-trips every change field and returns the newest N in arrival order', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    for (let i = 0; i < 5; i += 1) store.saveChange('s1', change(`c${i}`, i));
    store.saveChange('s1', { ...change('null-fields', 9), planId: null, planVersion: null, stepKey: null, eventId: null, resolution: null, added: null, stored: false, unreadable: false, beforeMode: null });
    expect(store.changes('s1', 3).map((c) => c.id)).toEqual(['c3', 'c4', 'null-fields']);
    expect(store.changes('s1').find((c) => c.id === 'c1')).toEqual(change('c1', 1));
    expect(store.changes('s1').find((c) => c.id === 'null-fields')).toEqual({
      ...change('null-fields', 9), planId: null, planVersion: null, stepKey: null, eventId: null, resolution: null, added: null, stored: false, unreadable: false, beforeMode: null,
    });
  });

  it('round-trips the opposite value of every boolean and nullable change field', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    const created = { ...change('created', 1), beforeHash: null, afterHash: 'a'.repeat(40), outOfPlan: false, resolution: null, stored: false };
    const both = { ...change('both', 2), beforeHash: null, afterHash: null, outOfPlan: false, resolution: 'flagged' as const, unreadable: false, beforeMode: 0o120000 };
    store.saveChange('s1', created);
    store.saveChange('s1', both);
    expect(store.changes('s1')).toEqual([created, both]);
  });

  it('orders changes by arrival, not by the watcher time, and a limit keeps the last saved', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveChange('s1', change('first', 50));
    store.saveChange('s1', change('second', 10));
    store.saveChange('s1', change('third', 30));
    store.saveChange('s1', { ...change('first', 50), resolution: 'reverted' });
    expect(store.changes('s1').map((c) => c.id)).toEqual(['first', 'second', 'third']);
    expect(store.changes('s1', 2).map((c) => c.id)).toEqual(['second', 'third']);
  });

  it('rolls the version 3 step back when it fails, leaving version 2 and no v3 table', () => {
    const dir = tempDir('ide-store-');
    const old = new DatabaseSync(join(dir, 'history.sqlite'));
    for (const sql of [SCHEMA_V1, SCHEMA_V2]) old.exec(sql);
    old.exec('CREATE TABLE changes (x INTEGER); PRAGMA user_version = 2');
    old.close();
    expect(() => openStore(dir)).toThrow();
    const check = new DatabaseSync(join(dir, 'history.sqlite'));
    const version = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE name IN ('baselines','checkpoints','reverts','summaries')").all();
    const cycle = check.prepare("SELECT name FROM pragma_table_info('step_states') WHERE name = 'cycle'").all();
    check.close();
    expect([version, tables, cycle]).toEqual([2, [], []]);
  });

  it('returns the newest changes of the requested session only', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveSession(session('s2', 2));
    store.saveChange('s1', change('a', 1));
    store.saveChange('s2', change('b', 2));
    expect(store.changes('s1').map((c) => c.id)).toEqual(['a']);
  });

  it('upserts a change saved twice', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveChange('s1', change('a', 1));
    store.saveChange('s1', { ...change('a', 1), resolution: 'reverted' });
    expect(store.changes('s1').map((c) => c.resolution)).toEqual(['reverted']);
  });

  it('saves many changes in one transaction and none when one fails', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveChanges('s1', [change('a', 1), change('b', 2)]);
    expect(() => store.saveChanges('s1', [change('c', 3), { ...change('d', 4), path: null as never }])).toThrow();
    expect(store.changes('s1').map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('writes baselines and removals in one transaction', () => {
    const store = freshStore();
    store.saveBaselines([baseline('a.ts')], []);
    expect(() => store.saveBaselines([baseline('b.ts'), { ...baseline('c.ts'), hash: null as never }], ['a.ts'])).toThrow();
    expect(store.baselines().map((b) => b.path)).toEqual(['a.ts']);
  });

  it('stores and overwrites a meta value and reads an absent one as null', () => {
    const dir = tempDir('ide-store-');
    const store = freshStore(dir);
    expect(store.meta('baselines.seeded')).toBeNull();
    store.setMeta('baselines.seeded', '1');
    store.setMeta('baselines.seeded', '2');
    store.close();
    expect(openStore(dir).meta('baselines.seeded')).toBe('2');
  });

  it('upserts baselines and deletes removed paths', () => {
    const store = freshStore();
    store.saveBaselines([baseline('a.ts'), baseline('b.ts')], []);
    store.saveBaselines([{ ...baseline('a.ts'), hash: 'new', size: 99, mode: 0o755, stored: false }], ['b.ts']);
    expect(store.baselines()).toEqual([{ path: 'a.ts', hash: 'new', stored: false, size: 99, mode: 0o755 }]);
  });

  it('adds the signature column to a version 7 history and keeps its baselines', () => {
    const dir = tempDir('ide-store-');
    const first = openStore(dir);
    first.saveBaselines([baseline('a.ts')], []);
    first.close();
    const db = new DatabaseSync(join(dir, 'history.sqlite'));
    db.exec('ALTER TABLE baselines DROP COLUMN sig; PRAGMA user_version = 7');
    db.close();

    const store = freshStore(dir);
    expect(store.baselines()).toEqual([baseline('a.ts')]);
    store.saveBaselines([{ ...baseline('b.ts'), sig: '1:2:3:4' }], []);
    expect(store.baselines().find((b) => b.path === 'b.ts')?.sig).toBe('1:2:3:4');
  });

  it('drops the signature of a baseline that is written again without one', () => {
    const store = freshStore();
    store.saveBaselines([{ ...baseline('a.ts'), sig: '1:2:3:4' }], []);
    store.saveBaselines([baseline('a.ts')], []);
    expect(store.baselines()).toEqual([baseline('a.ts')]);
  });

  it('signs a baseline that is still at the hash it was taken for and leaves one at another hash unsigned', () => {
    const store = freshStore();
    store.saveBaselines([baseline('a.ts'), baseline('b.ts')], []);
    store.saveBaselineSigs([
      { path: 'a.ts', hash: 'h-a.ts', sig: 'sig-a' },
      { path: 'b.ts', hash: 'older-hash', sig: 'sig-b' },
    ]);
    expect(store.baselines().map((b) => [b.path, b.sig])).toEqual([['a.ts', 'sig-a'], ['b.ts', undefined]]);
  });

  it('upserts a checkpoint by plan, step and cycle and reads the manifests back', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    const open = { planId: 'p', stepKey: 'a', cycle: 0, before: { 'x.ts': 'h1', 'y.ts': null }, after: {}, startedAt: 5, sealedAt: null };
    store.saveCheckpoint('s1', open);
    store.saveCheckpoint('s1', { ...open, cycle: 1 });
    const sealed = { ...open, after: { 'x.ts': 'h2', 'y.ts': null }, sealedAt: 9 };
    store.saveCheckpoint('s1', sealed);
    expect(store.checkpoints('s1')).toEqual([sealed, { ...open, cycle: 1 }]);
  });

  it('round-trips a revert and a summary', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    const revert = {
      id: 'r1', kind: 'step' as const, eventId: null, planId: 'p', stepKey: 'a', changeIds: ['c1', 'c2'],
      files: [{ path: 'a.ts', outcome: 'conflict' as const, reason: 'edited since' }], ts: 7, undoneAt: null,
    };
    store.saveRevert('s1', revert);
    store.saveRevert('s1', { ...revert, undoneAt: 8 });
    expect(store.reverts('s1')).toEqual([{ ...revert, undoneAt: 8 }]);
    const summary = { key: 'step:p:a', scope: 'step' as const, ref: 'p/a', text: 'Edited the app', createdAt: 3 };
    store.saveSummary(summary);
    expect(store.summaries()).toEqual([summary]);
  });

  it('keeps pre-execution and watchdog events apart', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveGateEvent('s1', gateEvent);
    store.saveWatchdogEvent('s1', watchdogView('w1', 'watchdog'));
    store.saveWatchdogEvent('s1', watchdogView('f1', 'fail-open'));
    expect(store.gateEvents('s1')).toEqual([gateEvent]);
    expect(store.watchdogEvents('s1')).toEqual([watchdogView('w1', 'watchdog'), watchdogView('f1', 'fail-open')]);
  });

  it('updates a watchdog event when it is saved again', () => {
    const store = freshStore();
    store.saveSession(session('s1', 1));
    store.saveWatchdogEvent('s1', { ...watchdogView('w1', 'watchdog'), phase: 'pending', resolution: 'pending', resolvedAt: null });
    store.saveWatchdogEvent('s1', watchdogView('w1', 'watchdog'));
    expect(store.watchdogEvents('s1')).toEqual([watchdogView('w1', 'watchdog')]);
  });
});
