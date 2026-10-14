import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished, type TestContext } from 'vitest';
import { stringify } from 'yaml';
import type { ChatPick, Lang, MapStatus } from '@ide/protocol';
import type { IndexedFile } from '../src/model';
import type { SessionRecord } from '../src/store/store';

export const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// Turns a current history back into one written before chat engines (schema 9).
export const BEFORE_ENGINES = 'ALTER TABLE sessions RENAME COLUMN engine_session_id TO claude_session_id; ALTER TABLE sessions DROP COLUMN engine;';

export function sessionRecord(id: string, cwd: string): SessionRecord {
  return {
    id, engine: 'claude', engineSessionId: `claude-${id}`, cwd, status: 'running', model: null, modelChoice: null, effort: null, cliVersion: null,
    pid: null, launchId: null, conversationStarted: true, startedAt: 1, accountId: null,
  };
}

// What a test chat starts with when nothing else names a model, as IDE_DEFAULT_MODEL does for the app.
export const SONNET: ChatPick = { engine: 'claude', modelChoice: 'sonnet', effort: 'medium' };

export function indexed(path: string, lang: Lang, imports: string[], overrides: Partial<IndexedFile> = {}): IndexedFile {
  return { path, lang, contentHash: path, imports, symbols: [], parseError: false, ...overrides };
}

// A Kubernetes workload manifest whose pod runs the given containers.
export function k8sWorkload(kind: 'Deployment' | 'StatefulSet' | 'CronJob', containers: Record<string, unknown>[]): string {
  const pod = { spec: { containers } };
  const spec = kind === 'CronJob' ? { schedule: '0 3 * * *', jobTemplate: { spec: { template: pod } } } : { replicas: 1, template: pod };
  return stringify({ apiVersion: kind === 'CronJob' ? 'batch/v1' : 'apps/v1', kind, metadata: { name: 'app' }, spec });
}

// A concurrent test passes its context: the global onTestFinished may bind the removal to another test running alongside.
export function tempDir(prefix: string, context?: Pick<TestContext, 'onTestFinished'>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  (context?.onTestFinished ?? onTestFinished)(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, relPath)), { recursive: true });
    await writeFile(join(root, relPath), content);
  }
}

export async function waitFor<T>(
  probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor: ${label} not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function unit(...values: number[]): Float32Array {
  const norm = Math.hypot(...values);
  return Float32Array.from(values, (value) => value / norm);
}

export function mapStatus(overrides: Partial<MapStatus> = {}): MapStatus {
  return {
    layer: 'folder',
    grouping: 'idle',
    groupingError: null,
    groupedAt: null,
    stale: false,
    staleReasons: [],
    unassigned: 0,
    pending: 0,
    sending: null,
    embeddings: 'ready',
    embeddingsError: null,
    embeddingPlacement: null,
    modelDownloadBytes: null,
    warnings: [],
    ...overrides,
  };
}

// An executable standing in for the Node launcher: when run, it records the IDE_NODE and HOME it got, its own path and its arguments, then exits.
export function recordingLauncher(): { path: string; ran: () => { ideNode: string; home: string; argv: string[] } | undefined } {
  const dir = tempDir('ide-launcher-');
  const path = join(dir, 'launcher');
  const record = join(dir, 'ran');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "\${IDE_NODE-unset}" "\${HOME-unset}" "$0" "$@" > '${record}.tmp' && mv '${record}.tmp' '${record}'\n`, { mode: 0o755 });
  return {
    path,
    ran: () => {
      if (!existsSync(record)) return undefined;
      const [ideNode = '', home = '', ...argv] = readFileSync(record, 'utf8').trimEnd().split('\n');
      return { ideNode, home, argv };
    },
  };
}
