import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DiffHunk, DiffLine, FileDiff } from '@ide/protocol';

export const MAX_BLOB_BYTES = 5 * 1024 * 1024;
export const MAX_DIFF_LINES = 2000;
const BATCH = 500;
const EXEC = 0o111;
const MAX_OUTPUT = 128 * 1024 * 1024;

export interface StoredBlob { hash: string; stored: boolean; size: number; mode: number }

interface GitOptions { input?: string | Buffer; env?: Record<string, string> }

function git(args: string[], options: GitOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) child.kill();
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.stdin.on('error', () => undefined);
    child.on('close', (code) => {
      if (code === 0 && size <= MAX_OUTPUT) resolve(Buffer.concat(out));
      else reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(err).toString().trim()}`));
    });
    child.stdin.end(options.input);
  });
}

const EMPTY_DIFF: FileDiff = { binary: false, truncated: false, missing: false, added: 0, removed: 0, hunks: [] };

function parseHunks(text: string): { hunks: DiffHunk[]; truncated: boolean } {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let lines = 0;
  for (const raw of text.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (header) {
      current = {
        oldStart: Number(header[1]), oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]), newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    const marker = raw[0];
    const op: DiffLine['op'] | null = marker === ' ' ? 'context' : marker === '+' ? 'add' : marker === '-' ? 'del' : null;
    if (op === null) continue;
    if (lines === MAX_DIFF_LINES) return { hunks, truncated: true };
    current.lines.push({ op, text: raw.slice(1) });
    lines++;
  }
  return { hunks, truncated: false };
}

export class ShadowRepo {
  private counter = 0;

  private constructor(private readonly dir: string, private readonly emptyBlob: string) {}

  static async open(dir: string): Promise<ShadowRepo> {
    mkdirSync(dir, { recursive: true });
    await git(['init', '--bare', '-q', dir]);
    for (const [key, value] of [['gc.auto', '0'], ['core.autocrlf', 'false'], ['user.name', 'ide'], ['user.email', 'ide@localhost']]) {
      await git(['--git-dir', dir, 'config', key!, value!]);
    }
    const empty = (await git(['--git-dir', dir, 'hash-object', '-t', 'blob', '-w', '--stdin'], { input: '' })).toString().trim();
    return new ShadowRepo(dir, empty);
  }

  private run(args: string[], options?: GitOptions): Promise<Buffer> {
    return git(['--git-dir', this.dir, ...args], options);
  }

  async put(abs: string): Promise<StoredBlob | null> { return this.blob(abs, true); }

  async hash(abs: string): Promise<StoredBlob | null> { return this.blob(abs, false); }

  private async blob(abs: string, store: boolean): Promise<StoredBlob | null> {
    let stat;
    try { stat = await lstat(abs); } catch { return null; }
    try {
      if (stat.isSymbolicLink()) return await this.text(await readlink(abs), store);
      if (!stat.isFile()) return null;
      const write = store && stat.size <= MAX_BLOB_BYTES;
      const out = await this.run(['hash-object', ...(write ? ['-w'] : []), '--no-filters', abs]);
      return { hash: out.toString().trim(), stored: write, size: stat.size, mode: stat.mode & EXEC ? 0o755 : 0o644 };
    } catch { return null; }
  }

  private async text(content: string, store: boolean): Promise<StoredBlob> {
    const out = await this.run(['hash-object', ...(store ? ['-w'] : []), '--stdin', '--no-filters'], { input: content });
    return { hash: out.toString().trim(), stored: store, size: Buffer.byteLength(content), mode: 0o644 };
  }

  async putMany(paths: string[]): Promise<Map<string, StoredBlob | null>> {
    const result = new Map<string, StoredBlob | null>();
    for (const p of paths) result.set(p, null);
    const batchable: { path: string; size: number; mode: number }[] = [];
    for (const p of paths) {
      let stat;
      try { stat = await lstat(p); } catch { continue; }
      if (stat.isFile() && stat.size <= MAX_BLOB_BYTES && !p.includes('\n')) {
        batchable.push({ path: p, size: stat.size, mode: stat.mode & EXEC ? 0o755 : 0o644 });
      } else {
        result.set(p, await this.put(p));
      }
    }
    for (let i = 0; i < batchable.length; i += BATCH) {
      const batch = batchable.slice(i, i + BATCH);
      let hashes: string[] | null = null;
      try {
        const out = await this.run(['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: batch.map((b) => b.path).join('\n') + '\n' });
        const lines = out.toString().split('\n').filter(Boolean);
        if (lines.length === batch.length) hashes = lines;
      } catch { hashes = null; }
      batch.forEach((entry, index) => {
        if (hashes) result.set(entry.path, { hash: hashes[index]!, stored: true, size: entry.size, mode: entry.mode });
      });
      if (!hashes) for (const entry of batch) result.set(entry.path, await this.put(entry.path));
    }
    return result;
  }

  async read(hash: string): Promise<Buffer | null> {
    try { return await this.run(['cat-file', 'blob', hash]); } catch { return null; }
  }

  private async existing(hashes: string[]): Promise<Set<string>> {
    if (hashes.length === 0) return new Set();
    const out = await this.run(['cat-file', '--batch-check'], { input: hashes.join('\n') + '\n' });
    const found = new Set<string>();
    for (const line of out.toString().split('\n')) {
      const [hash, type] = line.split(' ');
      if (hash && type === 'blob') found.add(hash);
    }
    return found;
  }

  async restore(hash: string | null, abs: string, mode: number): Promise<'restored' | 'deleted' | 'missing-blob'> {
    if (hash === null) {
      await rm(abs, { force: true });
      return 'deleted';
    }
    const content = await this.read(hash);
    if (content === null) return 'missing-blob';
    await mkdir(dirname(abs), { recursive: true });
    const temp = `${abs}.ide-${process.pid}-${this.counter++}`;
    try {
      await writeFile(temp, content);
      await chmod(temp, mode);
      await rename(temp, abs);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return 'restored';
  }

  async diff(before: string | null, after: string | null): Promise<FileDiff> {
    const a = before ?? this.emptyBlob;
    const b = after ?? this.emptyBlob;
    if (a === b) return { ...EMPTY_DIFF };
    const present = await this.existing([a, b]);
    if (!present.has(a) || !present.has(b)) return { ...EMPTY_DIFF, missing: true };
    const flags = ['--no-color', '--no-ext-diff', '--no-textconv'];
    const [numstat] = (await this.run(['diff', ...flags, '--numstat', a, b])).toString().split('\n');
    const [addedText, removedText] = (numstat ?? '').split('\t');
    if (addedText === '-' || removedText === '-') return { ...EMPTY_DIFF, binary: true };
    const { hunks, truncated } = parseHunks((await this.run(['diff', ...flags, '--unified=3', a, b])).toString());
    return { binary: false, truncated, missing: false, added: Number(addedText), removed: Number(removedText), hunks };
  }

  async snapshot(id: string, files: { path: string; hash: string | null; mode?: number }[]): Promise<string> {
    const present = await this.existing([...new Set(files.flatMap((f) => (f.hash === null ? [] : [f.hash])))]);
    const entries = files.filter((f) => f.hash !== null && present.has(f.hash));
    const scratch = await mkdtemp(join(tmpdir(), 'ide-snapshot-'));
    try {
      const env = { GIT_INDEX_FILE: join(scratch, 'index') };
      const lines = entries.map((f) => `${f.mode === 0o755 ? '100755' : '100644'} ${f.hash}\t${f.path}\n`).join('');
      await this.run(['update-index', '--add', '--index-info'], { input: lines, env });
      const tree = (await this.run(['write-tree'], { env })).toString().trim();
      const sha = (await this.run(['commit-tree', tree, '-m', id])).toString().trim();
      await this.run(['update-ref', `refs/ide/snapshots/${id}`, sha]);
      return sha;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
