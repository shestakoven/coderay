import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FileDiff } from '@ide/protocol';
import { EMPTY_DIFF, parseHunks } from './unified-diff';

export const MAX_BLOB_BYTES = 5 * 1024 * 1024;
export { MAX_DIFF_LINES } from './unified-diff';
const BATCH = 500;
const EXEC = 0o111;
const MAX_OUTPUT = 128 * 1024 * 1024;
const HASH = /^[0-9a-f]{40,64}$/;
const INHERITED_GIT_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|SHALLOW_FILE|GRAFT_FILE|REPLACE_REF_BASE|NO_REPLACE_OBJECTS|AUTHOR_\w+|COMMITTER_\w+|INTERNAL_\w+)$/;
const GIT_TIMEOUT_MS = 60_000;
const SYMLINK_MODE = 0o120000;
let tempCounter = 0;

const isHash = (value: string): boolean => HASH.test(value);

function unsafeSnapshotPath(path: string): boolean {
  return path === '' || path.includes('\0') || path.split('/').some((part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git');
}

function cleanEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!INHERITED_GIT_ENV.test(key)) env[key] = value;
  return { ...env, ...extra };
}

export interface StoredBlob { hash: string; stored: boolean; size: number; mode: number }

type ObjectFormat = 'sha1' | 'sha256';

const blobId = (format: ObjectFormat, size: number): ReturnType<typeof createHash> => createHash(format).update(`blob ${size}\0`);

// Git's own name for a file, worked out here: a process per file is what a revert of hundreds of files spends its time on.
async function blobIdOfFile(format: ObjectFormat, abs: string): Promise<string | null> {
  const handle = await open(abs, 'r');
  try {
    const { size } = await handle.stat();
    const id = blobId(format, size);
    let read = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false }) as AsyncIterable<Buffer>) {
      read += chunk.length;
      id.update(chunk);
    }
    // A file that changed size while it was read has no name worth trusting; git is asked instead.
    return read === size ? id.digest('hex') : null;
  } finally {
    await handle.close();
  }
}

interface GitOptions { input?: string | Buffer; env?: Record<string, string>; timeoutMs?: number }

export type RestoreGuard = () => Promise<boolean>;

function git(args: string[], options: GitOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env: cleanEnv(options.env), stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs ?? GIT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) child.kill();
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => undefined);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`git ${args[0]} timed out`));
      else if (code === 0 && size <= MAX_OUTPUT) resolve(Buffer.concat(out));
      else reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(err).toString().trim()}`));
    });
    child.stdin.end(options.input);
  });
}

export class ShadowRepo {
  // `fresh`: the repository did not exist before, so no blob a baseline calls stored can be taken to be in it.
  private constructor(
    private readonly dir: string, private readonly emptyBlob: string, private readonly timeoutMs: number | undefined, readonly fresh: boolean,
    private readonly format: ObjectFormat | null,
  ) {}

  static async open(dir: string, options: { timeoutMs?: number } = {}): Promise<ShadowRepo> {
    mkdirSync(dir, { recursive: true });
    const fresh = !existsSync(join(dir, 'HEAD'));
    await git(['init', '--bare', '-q', '--', dir]);
    for (const [key, value] of [['gc.auto', '0'], ['core.autocrlf', 'false'], ['user.name', 'ide'], ['user.email', 'ide@localhost']]) {
      await git(['--git-dir', dir, 'config', key!, value!]);
    }
    const empty = (await git(['--git-dir', dir, 'hash-object', '-t', 'blob', '-w', '--stdin'], { input: '' })).toString().trim();
    // The repository's hash function is the one that names the empty blob the way git just did.
    const format = (['sha1', 'sha256'] as const).find((candidate) => blobId(candidate, 0).digest('hex') === empty) ?? null;
    return new ShadowRepo(dir, empty, options.timeoutMs, fresh, format);
  }

  private run(args: string[], options?: GitOptions): Promise<Buffer> {
    return git(['--git-dir', this.dir, ...args], { timeoutMs: this.timeoutMs, ...options });
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
      const named = !write && this.format ? await blobIdOfFile(this.format, abs).catch(() => null) : null;
      const hash = named ?? (await this.run(['hash-object', ...(write ? ['-w'] : []), '--no-filters', '--', abs])).toString().trim();
      return { hash, stored: write, size: stat.size, mode: stat.mode & EXEC ? 0o755 : 0o644 };
    } catch { return null; }
  }

  private async text(content: string, store: boolean): Promise<StoredBlob> {
    const out = await this.run(['hash-object', ...(store ? ['-w'] : []), '--stdin', '--no-filters'], { input: content });
    return { hash: out.toString().trim(), stored: store, size: Buffer.byteLength(content), mode: SYMLINK_MODE };
  }

  async putContent(content: Buffer, mode: number): Promise<StoredBlob> {
    const write = content.length <= MAX_BLOB_BYTES;
    const out = await this.run(['hash-object', ...(write ? ['-w'] : []), '--stdin', '--no-filters'], { input: content });
    return { hash: out.toString().trim(), stored: write, size: content.length, mode };
  }

  async putMany(paths: string[]): Promise<Map<string, StoredBlob | null>> {
    const result = new Map<string, StoredBlob | null>();
    for (const p of paths) result.set(p, null);
    const batchable: { path: string; size: number; mode: number }[] = [];
    for (const p of paths) {
      let stat;
      try { stat = await lstat(p); } catch { continue; }
      if (stat.isFile() && stat.size <= MAX_BLOB_BYTES && !/[\r\n]/.test(p)) {
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
    if (!isHash(hash)) return null;
    try { return await this.run(['cat-file', 'blob', hash]); } catch { return null; }
  }

  private async existing(hashes: string[]): Promise<Set<string>> {
    if (hashes.length === 0) return new Set();
    hashes = hashes.filter(isHash);
    if (hashes.length === 0) return new Set();
    const out = await this.run(['cat-file', '--batch-check'], { input: hashes.join('\n') + '\n' });
    const found = new Set<string>();
    for (const line of out.toString().split('\n')) {
      const [hash, type] = line.split(' ');
      if (hash && type === 'blob') found.add(hash);
    }
    return found;
  }

  async restore(hash: string | null, abs: string, mode: number, guard?: RestoreGuard): Promise<'restored' | 'deleted' | 'missing-blob' | 'changed'> {
    if (hash === null) {
      if (guard && !(await guard())) return 'changed';
      await rm(abs, { force: true });
      return 'deleted';
    }
    const content = await this.read(hash);
    if (content === null) return 'missing-blob';
    await mkdir(dirname(abs), { recursive: true });
    const temp = `${abs}.ide-${process.pid}-${tempCounter++}-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(temp, content, { flag: 'wx' });
      await chmod(temp, mode & 0o777);
      if (guard && !(await guard())) {
        await rm(temp, { force: true });
        return 'changed';
      }
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
    const [numstat] = (await this.run(['diff', ...flags, '--numstat', a, b, '--'])).toString().split('\n');
    const [addedText, removedText] = (numstat ?? '').split('\t');
    if (addedText === '-' || removedText === '-') return { ...EMPTY_DIFF, binary: true };
    const { hunks, truncated } = parseHunks((await this.run(['diff', ...flags, '--unified=3', a, b, '--'])).toString());
    return { binary: false, truncated, missing: false, added: Number(addedText), removed: Number(removedText), hunks };
  }

  async snapshot(id: string, files: { path: string; hash: string | null; mode?: number }[]): Promise<string> {
    const present = await this.existing([...new Set(files.flatMap((f) => (f.hash === null ? [] : [f.hash])))]);
    const entries = files.filter((f) => f.hash !== null && present.has(f.hash) && !unsafeSnapshotPath(f.path));
    const scratch = await mkdtemp(join(tmpdir(), 'ide-snapshot-'));
    try {
      const env = { GIT_INDEX_FILE: join(scratch, 'index') };
      const records = entries.map((f) => `${f.mode === 0o755 ? '100755' : '100644'} ${f.hash}\t${f.path}\0`).join('');
      await this.run(['update-index', '--add', '-z', '--index-info'], { input: records, env });
      const tree = (await this.run(['write-tree'], { env })).toString().trim();
      const sha = (await this.run(['commit-tree', tree, '-m', id])).toString().trim();
      await this.run(['update-ref', `refs/ide/snapshots/${id}`, sha]);
      return sha;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
