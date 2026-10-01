import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ApprovedBy, ChangeView, ControlMode, FrozenScope, GatePromptView, PlanReview, PlanStatus, PlanStep, PromptAnswer, PromptBody, PromptStatus,
  RevertRecordView, SessionStatus, StepStatus, TaskKind, TaskView, ToolDecision, ToolStatus, TurnKind, TurnView, WatchdogEventView,
} from '@ide/protocol';
import { DatabaseSync } from './sqlite';

export interface SessionRecord {
  id: string;
  claudeSessionId: string;
  cwd: string;
  status: SessionStatus;
  model: string | null;
  cliVersion: string | null;
  pid: number | null;
  launchId: string | null;
  conversationStarted: boolean;
  startedAt: number;
}

export interface MessageRecord {
  id: string;
  seq: number;
  turnId: string | null;
  parentToolUseId: string | null;
  role: 'user' | 'assistant' | 'notice';
  text: string;
  ts: number;
}

export interface ToolEventRecord {
  toolUseId: string;
  seq: number;
  turnId: string | null;
  parentToolUseId: string | null;
  tool: string;
  input: unknown;
  status: ToolStatus;
  toolUseAt: number;
  endedAt: number | null;
}

export interface PromptRecord {
  requestId: string;
  seq: number;
  turnId: string | null;
  parentToolUseId: string | null;
  body: PromptBody;
  status: PromptStatus;
  answer: PromptAnswer | null;
  ts: number;
}

export interface PlanRecord {
  id: string;
  version: number;
  goal: string;
  status: PlanStatus;
  approvedBy: ApprovedBy | null;
  steps: PlanStep[];
  scope: FrozenScope;
  owners: Record<string, string | null>;
  review: PlanReview;
  feedback: string | null;
  proposedAt: number;
  decidedAt: number | null;
}

export interface ToolDecisionRecord {
  toolUseId: string;
  decision: ToolDecision;
  planId: string | null;
  planVersion: number | null;
  stepKey: string | null;
  targets: string[];
  reason: string;
  decidedAt: number;
}

export type GateResolution = 'pending' | 'allowed-once' | 'denied' | 'dropped' | 'plan-expanded' | 'flagged' | 'kept' | 'reverted' | 'relabeled-human' | 'mixed';

export interface GateEventRecord {
  id: string;
  toolUseId: string;
  kind: 'pre-execution' | 'watchdog' | 'fail-open';
  mode: ControlMode;
  targets: string[];
  prompt: GatePromptView | null;
  resolution: GateResolution;
  ts: number;
  resolvedAt: number | null;
}

export interface BaselineRecord { path: string; hash: string; stored: boolean; size: number; mode: number }

export interface CheckpointRecord {
  planId: string;
  stepKey: string;
  cycle: number;
  before: Record<string, string | null>;
  after: Record<string, string | null>;
  startedAt: number;
  sealedAt: number | null;
}

export interface SummaryRecord { key: string; scope: 'step' | 'component'; ref: string; text: string; createdAt: number }

export interface SessionHistory {
  turns: TurnView[];
  messages: MessageRecord[];
  toolEvents: ToolEventRecord[];
  tasks: TaskView[];
  prompts: PromptRecord[];
  decisions: ToolDecisionRecord[];
}

export interface Store {
  latestSession(): SessionRecord | null;
  saveSession(session: SessionRecord): void;
  saveTurn(sessionId: string, turn: TurnView): void;
  saveMessage(sessionId: string, message: MessageRecord): void;
  saveToolEvent(sessionId: string, event: ToolEventRecord): void;
  saveTask(sessionId: string, task: TaskView): void;
  savePrompt(sessionId: string, prompt: PromptRecord): void;
  savePlan(sessionId: string, plan: PlanRecord): void;
  saveStepState(planId: string, key: string, status: StepStatus): void;
  stepCycle(planId: string, key: string): number;
  bumpStepCycle(planId: string, key: string): number;
  plans(sessionId: string): { plans: PlanRecord[]; stepStates: Record<string, Record<string, StepStatus>> };
  saveToolDecision(sessionId: string, decision: ToolDecisionRecord): void;
  saveGateEvent(sessionId: string, event: GateEventRecord): void;
  gateEvents(sessionId: string): GateEventRecord[];
  saveChange(sessionId: string, change: ChangeView): void;
  saveChanges(sessionId: string, changes: ChangeView[], baselines?: { rows: BaselineRecord[]; removed: string[] }): void;
  changes(sessionId: string, limit?: number): ChangeView[];
  saveBaselines(rows: BaselineRecord[], removed?: string[]): void;
  baselines(): BaselineRecord[];
  meta(key: string): string | null;
  setMeta(key: string, value: string): void;
  saveCheckpoint(sessionId: string, checkpoint: CheckpointRecord): void;
  checkpoints(sessionId: string): CheckpointRecord[];
  saveRevert(sessionId: string, revert: RevertRecordView): void;
  reverts(sessionId: string): RevertRecordView[];
  saveSummary(summary: SummaryRecord): void;
  summaries(): SummaryRecord[];
  saveWatchdogEvent(sessionId: string, event: WatchdogEventView): void;
  watchdogEvents(sessionId: string): WatchdogEventView[];
  history(sessionId: string): SessionHistory;
  close(): void;
}

const BUSY_TIMEOUT_MS = 5000;
const PROJECT_DIR_MODE = 0o700;
const DB_FILE_MODE = 0o600;

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  claude_session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  cli_version TEXT,
  pid INTEGER,
  launch_id TEXT,
  conversation_started INTEGER NOT NULL,
  started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  started_at INTEGER,
  closed_at INTEGER,
  result_subtype TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  turn_id TEXT,
  parent_tool_use_id TEXT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_events (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  tool_use_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  turn_id TEXT,
  parent_tool_use_id TEXT,
  tool TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL,
  tool_use_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY (session_id, tool_use_id)
);
CREATE TABLE IF NOT EXISTS background_tasks (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  id TEXT NOT NULL,
  tool_use_id TEXT,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY (session_id, id)
);
CREATE TABLE IF NOT EXISTS prompts (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  request_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  turn_id TEXT,
  parent_tool_use_id TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  answer TEXT,
  ts INTEGER NOT NULL,
  PRIMARY KEY (session_id, request_id)
);
`;

export const SCHEMA_V2 = `
CREATE TABLE plans (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  approved_by TEXT,
  steps TEXT NOT NULL,
  scope TEXT NOT NULL,
  owners TEXT NOT NULL,
  review TEXT NOT NULL,
  feedback TEXT,
  proposed_at INTEGER NOT NULL,
  decided_at INTEGER,
  PRIMARY KEY (id, version)
);
CREATE TABLE step_states (
  plan_id TEXT NOT NULL,
  key TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (plan_id, key)
);
CREATE TABLE tool_decisions (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  tool_use_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  plan_id TEXT,
  plan_version INTEGER,
  step_key TEXT,
  targets TEXT NOT NULL,
  reason TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, tool_use_id)
);
CREATE TABLE gate_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  targets TEXT NOT NULL,
  prompt TEXT,
  resolution TEXT NOT NULL,
  ts INTEGER NOT NULL,
  resolved_at INTEGER
);
`;

const SCHEMA_V3 = `
CREATE TABLE changes (session_id TEXT NOT NULL, id TEXT PRIMARY KEY, path TEXT NOT NULL, before_hash TEXT, after_hash TEXT,
  at INTEGER NOT NULL, origin TEXT NOT NULL, enforcement TEXT NOT NULL, out_of_plan INTEGER NOT NULL, tool_use_ids TEXT NOT NULL,
  plan_id TEXT, plan_version INTEGER, step_key TEXT, event_id TEXT, resolution TEXT, added INTEGER, removed INTEGER,
  stored INTEGER NOT NULL, unreadable INTEGER NOT NULL, before_mode INTEGER);
CREATE INDEX changes_session ON changes (session_id);
CREATE TABLE baselines (path TEXT PRIMARY KEY, hash TEXT NOT NULL, stored INTEGER NOT NULL, size INTEGER NOT NULL, mode INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE checkpoints (session_id TEXT NOT NULL, plan_id TEXT NOT NULL, step_key TEXT NOT NULL, cycle INTEGER NOT NULL,
  before TEXT NOT NULL, after TEXT NOT NULL, started_at INTEGER NOT NULL, sealed_at INTEGER, PRIMARY KEY (plan_id, step_key, cycle));
CREATE TABLE reverts (session_id TEXT NOT NULL, id TEXT PRIMARY KEY, kind TEXT NOT NULL, event_id TEXT, plan_id TEXT, step_key TEXT,
  change_ids TEXT NOT NULL, files TEXT NOT NULL, ts INTEGER NOT NULL, undone_at INTEGER);
CREATE TABLE summaries (key TEXT PRIMARY KEY, scope TEXT NOT NULL, ref TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
ALTER TABLE gate_events ADD COLUMN change_ids TEXT;
ALTER TABLE gate_events ADD COLUMN tool_use_ids TEXT;
ALTER TABLE gate_events ADD COLUMN snapshot_sha TEXT;
ALTER TABLE gate_events ADD COLUMN phase TEXT;
ALTER TABLE gate_events ADD COLUMN payload TEXT;
ALTER TABLE step_states ADD COLUMN cycle INTEGER NOT NULL DEFAULT 0;
`;

// MIGRATIONS[n] takes user_version n to n + 1.
const MIGRATIONS = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3];

function migrate(db: InstanceType<typeof DatabaseSync>): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const current = Number(row?.user_version ?? 0);
  if (current > MIGRATIONS.length) {
    throw new Error(`history.sqlite has schema version ${current}, newer than this IDE understands (${MIGRATIONS.length})`);
  }
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

type Row = Record<string, unknown>;

const optText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const optNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

const toSession = (row: Row): SessionRecord => ({
  id: String(row.id),
  claudeSessionId: String(row.claude_session_id),
  cwd: String(row.cwd),
  status: String(row.status) as SessionStatus,
  model: optText(row.model),
  cliVersion: optText(row.cli_version),
  pid: optNumber(row.pid),
  launchId: optText(row.launch_id),
  conversationStarted: row.conversation_started === 1,
  startedAt: Number(row.started_at),
});

const toTurn = (row: Row): TurnView => ({
  id: String(row.id),
  kind: String(row.kind) as TurnKind,
  openedAt: Number(row.opened_at),
  startedAt: optNumber(row.started_at),
  closedAt: optNumber(row.closed_at),
  resultSubtype: optText(row.result_subtype),
});

const toMessage = (row: Row): MessageRecord => ({
  id: String(row.id),
  seq: Number(row.seq),
  turnId: optText(row.turn_id),
  parentToolUseId: optText(row.parent_tool_use_id),
  role: String(row.role) as MessageRecord['role'],
  text: String(row.text),
  ts: Number(row.ts),
});

const toToolEvent = (row: Row): ToolEventRecord => ({
  toolUseId: String(row.tool_use_id),
  seq: Number(row.seq),
  turnId: optText(row.turn_id),
  parentToolUseId: optText(row.parent_tool_use_id),
  tool: String(row.tool),
  input: JSON.parse(String(row.input)) as unknown,
  status: String(row.status) as ToolStatus,
  toolUseAt: Number(row.tool_use_at),
  endedAt: optNumber(row.ended_at),
});

const toTask = (row: Row): TaskView => ({
  id: String(row.id),
  toolUseId: optText(row.tool_use_id),
  kind: String(row.kind) as TaskKind,
  description: String(row.description),
  status: String(row.status),
  startedAt: Number(row.started_at),
  endedAt: optNumber(row.ended_at),
});

const toPrompt = (row: Row): PromptRecord => ({
  requestId: String(row.request_id),
  seq: Number(row.seq),
  turnId: optText(row.turn_id),
  parentToolUseId: optText(row.parent_tool_use_id),
  body: JSON.parse(String(row.body)) as PromptBody,
  status: String(row.status) as PromptStatus,
  answer: row.answer === null || row.answer === undefined ? null : (JSON.parse(String(row.answer)) as PromptAnswer),
  ts: Number(row.ts),
});

const toPlan = (row: Row): PlanRecord => ({
  id: String(row.id),
  version: Number(row.version),
  goal: String(row.goal),
  status: String(row.status) as PlanStatus,
  approvedBy: optText(row.approved_by) as ApprovedBy | null,
  steps: JSON.parse(String(row.steps)) as PlanStep[],
  scope: JSON.parse(String(row.scope)) as FrozenScope,
  owners: JSON.parse(String(row.owners)) as Record<string, string | null>,
  review: JSON.parse(String(row.review)) as PlanReview,
  feedback: optText(row.feedback),
  proposedAt: Number(row.proposed_at),
  decidedAt: optNumber(row.decided_at),
});

const toDecision = (row: Row): ToolDecisionRecord => ({
  toolUseId: String(row.tool_use_id),
  decision: String(row.decision) as ToolDecision,
  planId: optText(row.plan_id),
  planVersion: optNumber(row.plan_version),
  stepKey: optText(row.step_key),
  targets: JSON.parse(String(row.targets)) as string[],
  reason: String(row.reason),
  decidedAt: Number(row.decided_at),
});

const toGateEvent = (row: Row): GateEventRecord => ({
  id: String(row.id),
  toolUseId: String(row.tool_use_id),
  kind: String(row.kind) as GateEventRecord['kind'],
  mode: String(row.mode) as ControlMode,
  targets: JSON.parse(String(row.targets)) as string[],
  prompt: row.prompt === null || row.prompt === undefined ? null : (JSON.parse(String(row.prompt)) as GatePromptView),
  resolution: String(row.resolution) as GateResolution,
  ts: Number(row.ts),
  resolvedAt: optNumber(row.resolved_at),
});

const toChange = (row: Row): ChangeView => ({
  id: String(row.id),
  path: String(row.path),
  beforeHash: optText(row.before_hash),
  afterHash: optText(row.after_hash),
  at: Number(row.at),
  origin: String(row.origin) as ChangeView['origin'],
  enforcement: String(row.enforcement) as ChangeView['enforcement'],
  outOfPlan: row.out_of_plan === 1,
  toolUseIds: JSON.parse(String(row.tool_use_ids)) as string[],
  planId: optText(row.plan_id),
  planVersion: optNumber(row.plan_version),
  stepKey: optText(row.step_key),
  eventId: optText(row.event_id),
  resolution: optText(row.resolution) as ChangeView['resolution'],
  added: optNumber(row.added),
  removed: optNumber(row.removed),
  stored: row.stored === 1,
  unreadable: row.unreadable === 1,
  beforeMode: optNumber(row.before_mode),
});

const toBaseline = (row: Row): BaselineRecord => ({
  path: String(row.path), hash: String(row.hash), stored: row.stored === 1, size: Number(row.size), mode: Number(row.mode),
});

const toCheckpoint = (row: Row): CheckpointRecord => ({
  planId: String(row.plan_id),
  stepKey: String(row.step_key),
  cycle: Number(row.cycle),
  before: JSON.parse(String(row.before)) as Record<string, string | null>,
  after: JSON.parse(String(row.after)) as Record<string, string | null>,
  startedAt: Number(row.started_at),
  sealedAt: optNumber(row.sealed_at),
});

const toRevert = (row: Row): RevertRecordView => ({
  id: String(row.id),
  kind: String(row.kind) as RevertRecordView['kind'],
  eventId: optText(row.event_id),
  planId: optText(row.plan_id),
  stepKey: optText(row.step_key),
  changeIds: JSON.parse(String(row.change_ids)) as string[],
  files: JSON.parse(String(row.files)) as RevertRecordView['files'],
  ts: Number(row.ts),
  undoneAt: optNumber(row.undone_at),
});

const toSummary = (row: Row): SummaryRecord => ({
  key: String(row.key), scope: String(row.scope) as SummaryRecord['scope'], ref: String(row.ref), text: String(row.text), createdAt: Number(row.created_at),
});

export function openStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, PROJECT_DIR_MODE);
  const dbPath = join(dir, 'history.sqlite');
  const db = new DatabaseSync(dbPath, { timeout: BUSY_TIMEOUT_MS });
  db.exec('PRAGMA journal_mode = WAL');
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  chmodSync(dbPath, DB_FILE_MODE);
  for (const suffix of ['-wal', '-shm']) if (existsSync(dbPath + suffix)) chmodSync(dbPath + suffix, DB_FILE_MODE);
  let open = true;

  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, claude_session_id, cwd, status, model, cli_version, pid, launch_id, conversation_started, started_at)
    VALUES (:id, :claudeSessionId, :cwd, :status, :model, :cliVersion, :pid, :launchId, :conversationStarted, :startedAt)
    ON CONFLICT (id) DO UPDATE SET claude_session_id = excluded.claude_session_id, status = excluded.status,
      model = excluded.model, cli_version = excluded.cli_version, pid = excluded.pid,
      launch_id = excluded.launch_id, conversation_started = excluded.conversation_started`);
  const upsertTurn = db.prepare(`
    INSERT INTO turns (id, session_id, kind, opened_at, started_at, closed_at, result_subtype)
    VALUES (:id, :sessionId, :kind, :openedAt, :startedAt, :closedAt, :resultSubtype)
    ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, started_at = excluded.started_at, closed_at = excluded.closed_at, result_subtype = excluded.result_subtype`);
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, session_id, seq, turn_id, parent_tool_use_id, role, text, ts)
    VALUES (:id, :sessionId, :seq, :turnId, :parentToolUseId, :role, :text, :ts)
    ON CONFLICT (id) DO NOTHING`);
  const upsertToolEvent = db.prepare(`
    INSERT INTO tool_events (session_id, tool_use_id, seq, turn_id, parent_tool_use_id, tool, input, status, tool_use_at, ended_at)
    VALUES (:sessionId, :toolUseId, :seq, :turnId, :parentToolUseId, :tool, :input, :status, :toolUseAt, :endedAt)
    ON CONFLICT (session_id, tool_use_id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at`);
  const upsertTask = db.prepare(`
    INSERT INTO background_tasks (session_id, id, tool_use_id, kind, description, status, started_at, ended_at)
    VALUES (:sessionId, :id, :toolUseId, :kind, :description, :status, :startedAt, :endedAt)
    ON CONFLICT (session_id, id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at`);
  const upsertPrompt = db.prepare(`
    INSERT INTO prompts (session_id, request_id, seq, turn_id, parent_tool_use_id, body, status, answer, ts)
    VALUES (:sessionId, :requestId, :seq, :turnId, :parentToolUseId, :body, :status, :answer, :ts)
    ON CONFLICT (session_id, request_id) DO UPDATE SET status = excluded.status, answer = excluded.answer`);
  const upsertPlan = db.prepare(`
    INSERT INTO plans (session_id, id, version, goal, status, approved_by, steps, scope, owners, review, feedback, proposed_at, decided_at)
    VALUES (:sessionId, :id, :version, :goal, :status, :approvedBy, :steps, :scope, :owners, :review, :feedback, :proposedAt, :decidedAt)
    ON CONFLICT (id, version) DO UPDATE SET status = excluded.status, approved_by = excluded.approved_by, steps = excluded.steps,
      scope = excluded.scope, owners = excluded.owners, review = excluded.review, feedback = excluded.feedback, decided_at = excluded.decided_at`);
  const upsertStepState = db.prepare(`
    INSERT INTO step_states (plan_id, key, status) VALUES (:planId, :key, :status)
    ON CONFLICT (plan_id, key) DO UPDATE SET status = excluded.status`);
  const bumpCycle = db.prepare(`
    INSERT INTO step_states (plan_id, key, status, cycle) VALUES (:planId, :key, 'pending', 1)
    ON CONFLICT (plan_id, key) DO UPDATE SET cycle = cycle + 1`);
  const upsertDecision = db.prepare(`
    INSERT INTO tool_decisions (session_id, tool_use_id, decision, plan_id, plan_version, step_key, targets, reason, decided_at)
    VALUES (:sessionId, :toolUseId, :decision, :planId, :planVersion, :stepKey, :targets, :reason, :decidedAt)
    ON CONFLICT (session_id, tool_use_id) DO UPDATE SET decision = excluded.decision, plan_id = excluded.plan_id,
      plan_version = excluded.plan_version, step_key = excluded.step_key, targets = excluded.targets, reason = excluded.reason,
      decided_at = excluded.decided_at`);
  const upsertGateEvent = db.prepare(`
    INSERT INTO gate_events (id, session_id, kind, tool_use_id, mode, targets, prompt, resolution, ts, resolved_at)
    VALUES (:id, :sessionId, :kind, :toolUseId, :mode, :targets, :prompt, :resolution, :ts, :resolvedAt)
    ON CONFLICT (id) DO UPDATE SET prompt = excluded.prompt, resolution = excluded.resolution, resolved_at = excluded.resolved_at`);

  const upsertChange = db.prepare(`
    INSERT INTO changes (session_id, id, path, before_hash, after_hash, at, origin, enforcement, out_of_plan, tool_use_ids, plan_id, plan_version,
      step_key, event_id, resolution, added, removed, stored, unreadable, before_mode)
    VALUES (:sessionId, :id, :path, :beforeHash, :afterHash, :at, :origin, :enforcement, :outOfPlan, :toolUseIds, :planId, :planVersion,
      :stepKey, :eventId, :resolution, :added, :removed, :stored, :unreadable, :beforeMode)
    ON CONFLICT (id) DO UPDATE SET before_hash = excluded.before_hash, after_hash = excluded.after_hash, origin = excluded.origin,
      enforcement = excluded.enforcement, out_of_plan = excluded.out_of_plan, tool_use_ids = excluded.tool_use_ids, plan_id = excluded.plan_id,
      plan_version = excluded.plan_version, step_key = excluded.step_key, event_id = excluded.event_id, resolution = excluded.resolution,
      added = excluded.added, removed = excluded.removed, stored = excluded.stored, unreadable = excluded.unreadable, before_mode = excluded.before_mode`);
  const writeChange = (sessionId: string, change: ChangeView): void => {
    upsertChange.run({
      sessionId, id: change.id, path: change.path, beforeHash: change.beforeHash, afterHash: change.afterHash, at: change.at,
      origin: change.origin, enforcement: change.enforcement, outOfPlan: change.outOfPlan ? 1 : 0, toolUseIds: JSON.stringify(change.toolUseIds),
      planId: change.planId, planVersion: change.planVersion, stepKey: change.stepKey, eventId: change.eventId, resolution: change.resolution,
      added: change.added, removed: change.removed, stored: change.stored ? 1 : 0, unreadable: change.unreadable ? 1 : 0, beforeMode: change.beforeMode,
    });
  };
  const upsertBaseline = db.prepare(`
    INSERT INTO baselines (path, hash, stored, size, mode, updated_at) VALUES (:path, :hash, :stored, :size, :mode, :updatedAt)
    ON CONFLICT (path) DO UPDATE SET hash = excluded.hash, stored = excluded.stored, size = excluded.size, mode = excluded.mode, updated_at = excluded.updated_at`);
  const deleteBaseline = db.prepare('DELETE FROM baselines WHERE path = ?');
  const upsertCheckpoint = db.prepare(`
    INSERT INTO checkpoints (session_id, plan_id, step_key, cycle, before, after, started_at, sealed_at)
    VALUES (:sessionId, :planId, :stepKey, :cycle, :before, :after, :startedAt, :sealedAt)
    ON CONFLICT (plan_id, step_key, cycle) DO UPDATE SET before = excluded.before, after = excluded.after, sealed_at = excluded.sealed_at`);
  const upsertRevert = db.prepare(`
    INSERT INTO reverts (session_id, id, kind, event_id, plan_id, step_key, change_ids, files, ts, undone_at)
    VALUES (:sessionId, :id, :kind, :eventId, :planId, :stepKey, :changeIds, :files, :ts, :undoneAt)
    ON CONFLICT (id) DO UPDATE SET files = excluded.files, undone_at = excluded.undone_at`);
  const upsertSummary = db.prepare(`
    INSERT INTO summaries (key, scope, ref, text, created_at) VALUES (:key, :scope, :ref, :text, :createdAt)
    ON CONFLICT (key) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`);
  const upsertWatchdogEvent = db.prepare(`
    INSERT INTO gate_events (id, session_id, kind, tool_use_id, mode, targets, resolution, ts, resolved_at, phase, snapshot_sha, payload)
    VALUES (:id, :sessionId, :kind, '', :mode, '[]', :resolution, :ts, :resolvedAt, :phase, :snapshotSha, :payload)
    ON CONFLICT (id) DO UPDATE SET resolution = excluded.resolution, resolved_at = excluded.resolved_at, phase = excluded.phase,
      snapshot_sha = excluded.snapshot_sha, payload = excluded.payload`);

  return {
    latestSession() {
      const row = db.prepare('SELECT * FROM sessions ORDER BY started_at DESC, rowid DESC LIMIT 1').get();
      return row ? toSession(row) : null;
    },
    saveSession(session) {
      upsertSession.run({
        id: session.id, claudeSessionId: session.claudeSessionId, cwd: session.cwd, status: session.status,
        model: session.model, cliVersion: session.cliVersion, pid: session.pid,
        launchId: session.launchId, conversationStarted: session.conversationStarted ? 1 : 0, startedAt: session.startedAt,
      });
    },
    saveTurn(sessionId, turn) {
      upsertTurn.run({
        id: turn.id, sessionId, kind: turn.kind, openedAt: turn.openedAt, startedAt: turn.startedAt,
        closedAt: turn.closedAt, resultSubtype: turn.resultSubtype,
      });
    },
    saveMessage(sessionId, message) {
      insertMessage.run({
        id: message.id, sessionId, seq: message.seq, turnId: message.turnId, parentToolUseId: message.parentToolUseId,
        role: message.role, text: message.text, ts: message.ts,
      });
    },
    saveToolEvent(sessionId, event) {
      upsertToolEvent.run({
        sessionId, toolUseId: event.toolUseId, seq: event.seq, turnId: event.turnId, parentToolUseId: event.parentToolUseId,
        tool: event.tool, input: JSON.stringify(event.input ?? null), status: event.status, toolUseAt: event.toolUseAt, endedAt: event.endedAt,
      });
    },
    saveTask(sessionId, task) {
      upsertTask.run({
        sessionId, id: task.id, toolUseId: task.toolUseId, kind: task.kind, description: task.description,
        status: task.status, startedAt: task.startedAt, endedAt: task.endedAt,
      });
    },
    savePrompt(sessionId, prompt) {
      upsertPrompt.run({
        sessionId, requestId: prompt.requestId, seq: prompt.seq, turnId: prompt.turnId, parentToolUseId: prompt.parentToolUseId,
        body: JSON.stringify(prompt.body), status: prompt.status, answer: prompt.answer === null ? null : JSON.stringify(prompt.answer), ts: prompt.ts,
      });
    },
    savePlan(sessionId, plan) {
      upsertPlan.run({
        sessionId, id: plan.id, version: plan.version, goal: plan.goal, status: plan.status, approvedBy: plan.approvedBy,
        steps: JSON.stringify(plan.steps), scope: JSON.stringify(plan.scope), owners: JSON.stringify(plan.owners),
        review: JSON.stringify(plan.review), feedback: plan.feedback, proposedAt: plan.proposedAt, decidedAt: plan.decidedAt,
      });
    },
    saveStepState(planId, key, status) {
      upsertStepState.run({ planId, key, status });
    },
    stepCycle(planId, key) {
      const row = db.prepare('SELECT cycle FROM step_states WHERE plan_id = ? AND key = ?').get(planId, key);
      return Number(row?.cycle ?? 0);
    },
    bumpStepCycle(planId, key) {
      bumpCycle.run({ planId, key });
      return Number(db.prepare('SELECT cycle FROM step_states WHERE plan_id = ? AND key = ?').get(planId, key)?.cycle ?? 0);
    },
    plans(sessionId) {
      const plans = db.prepare('SELECT * FROM plans WHERE session_id = ? ORDER BY proposed_at, version').all(sessionId).map(toPlan);
      const stepStates: Record<string, Record<string, StepStatus>> = {};
      for (const id of new Set(plans.map((plan) => plan.id))) {
        for (const row of db.prepare('SELECT key, status FROM step_states WHERE plan_id = ?').all(id)) {
          (stepStates[id] ??= {})[String(row.key)] = String(row.status) as StepStatus;
        }
      }
      return { plans, stepStates };
    },
    saveToolDecision(sessionId, decision) {
      upsertDecision.run({
        sessionId, toolUseId: decision.toolUseId, decision: decision.decision, planId: decision.planId, planVersion: decision.planVersion,
        stepKey: decision.stepKey, targets: JSON.stringify(decision.targets), reason: decision.reason, decidedAt: decision.decidedAt,
      });
    },
    saveGateEvent(sessionId, event) {
      upsertGateEvent.run({
        id: event.id, sessionId, kind: event.kind, toolUseId: event.toolUseId, mode: event.mode, targets: JSON.stringify(event.targets),
        prompt: event.prompt === null ? null : JSON.stringify(event.prompt), resolution: event.resolution, ts: event.ts, resolvedAt: event.resolvedAt,
      });
    },
    gateEvents(sessionId) {
      return db.prepare("SELECT * FROM gate_events WHERE session_id = ? AND kind = 'pre-execution' ORDER BY ts, rowid").all(sessionId).map(toGateEvent);
    },
    saveChange(sessionId, change) {
      writeChange(sessionId, change);
    },
    saveChanges(sessionId, changes, baselines) {
      db.exec('BEGIN');
      try {
        for (const change of changes) writeChange(sessionId, change);
        if (baselines) {
          const updatedAt = Date.now();
          for (const path of baselines.removed) deleteBaseline.run(path);
          for (const row of baselines.rows) {
            upsertBaseline.run({ path: row.path, hash: row.hash, stored: row.stored ? 1 : 0, size: row.size, mode: row.mode, updatedAt });
          }
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    changes(sessionId, limit) {
      const rows = limit === undefined
        ? db.prepare('SELECT * FROM changes WHERE session_id = ? ORDER BY rowid').all(sessionId)
        : db.prepare('SELECT * FROM (SELECT *, rowid AS rid FROM changes WHERE session_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY rid').all(sessionId, limit);
      return rows.map(toChange);
    },
    saveBaselines(rows, removed = []) {
      const updatedAt = Date.now();
      db.exec('BEGIN');
      try {
        for (const row of removed) deleteBaseline.run(row);
        for (const row of rows) {
          upsertBaseline.run({ path: row.path, hash: row.hash, stored: row.stored ? 1 : 0, size: row.size, mode: row.mode, updatedAt });
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    meta(key) {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
      return row?.value ?? null;
    },
    setMeta(key, value) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
    },
    baselines() {
      return db.prepare('SELECT * FROM baselines ORDER BY path').all().map(toBaseline);
    },
    saveCheckpoint(sessionId, checkpoint) {
      upsertCheckpoint.run({
        sessionId, planId: checkpoint.planId, stepKey: checkpoint.stepKey, cycle: checkpoint.cycle, before: JSON.stringify(checkpoint.before),
        after: JSON.stringify(checkpoint.after), startedAt: checkpoint.startedAt, sealedAt: checkpoint.sealedAt,
      });
    },
    checkpoints(sessionId) {
      return db.prepare('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY started_at, cycle, rowid').all(sessionId).map(toCheckpoint);
    },
    saveRevert(sessionId, revert) {
      upsertRevert.run({
        sessionId, id: revert.id, kind: revert.kind, eventId: revert.eventId, planId: revert.planId, stepKey: revert.stepKey,
        changeIds: JSON.stringify(revert.changeIds), files: JSON.stringify(revert.files), ts: revert.ts, undoneAt: revert.undoneAt,
      });
    },
    reverts(sessionId) {
      return db.prepare('SELECT * FROM reverts WHERE session_id = ? ORDER BY ts, rowid').all(sessionId).map(toRevert);
    },
    saveSummary(summary) {
      upsertSummary.run({ key: summary.key, scope: summary.scope, ref: summary.ref, text: summary.text, createdAt: summary.createdAt });
    },
    summaries() {
      return db.prepare('SELECT * FROM summaries ORDER BY created_at, rowid').all().map(toSummary);
    },
    saveWatchdogEvent(sessionId, event) {
      upsertWatchdogEvent.run({
        id: event.id, sessionId, kind: event.kind, mode: event.mode, resolution: event.resolution, ts: event.ts, resolvedAt: event.resolvedAt,
        phase: event.phase, snapshotSha: event.snapshotSha, payload: JSON.stringify(event),
      });
    },
    watchdogEvents(sessionId) {
      return db.prepare("SELECT payload FROM gate_events WHERE session_id = ? AND kind IN ('watchdog', 'fail-open') ORDER BY ts, rowid").all(sessionId)
        .map((row) => JSON.parse(String(row.payload)) as WatchdogEventView);
    },
    history(sessionId) {
      return {
        turns: db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY opened_at, rowid').all(sessionId).map(toTurn),
        messages: db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq').all(sessionId).map(toMessage),
        toolEvents: db.prepare('SELECT * FROM tool_events WHERE session_id = ? ORDER BY seq').all(sessionId).map(toToolEvent),
        tasks: db.prepare('SELECT * FROM background_tasks WHERE session_id = ? ORDER BY started_at, rowid').all(sessionId).map(toTask),
        prompts: db.prepare('SELECT * FROM prompts WHERE session_id = ? ORDER BY seq').all(sessionId).map(toPrompt),
        decisions: db.prepare('SELECT * FROM tool_decisions WHERE session_id = ? ORDER BY decided_at, rowid').all(sessionId).map(toDecision),
      };
    },
    close() {
      if (!open) return;
      open = false;
      db.close();
    },
  };
}
