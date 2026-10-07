import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { projectDir } from '../../src/home';
import { LOCK_FILE } from '../../src/lock';
import { tempDir, waitFor } from '../helpers';

const MAIN = fileURLToPath(new URL('../../src/main.ts', import.meta.url));
const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const ORIGIN = 'http://localhost:4400';
const TOKEN = 'parent-test-token-0123456789';

function startHub(base: string, flags: string[], projects: string[] = []) {
  const bin = join(base, 'bin');
  mkdirSync(bin);
  mkdirSync(join(base, 'ui'));
  mkdirSync(join(base, 'user-home'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const child = spawn(process.execPath, ['--import', 'tsx', MAIN, '--hub', ...projects.flatMap((root) => ['--project', root]),
    '--ide-home', join(base, 'home'), '--port', '0', '--ui', join(base, 'ui'), '--allow-origin', ORIGIN, '--claude', join(bin, 'claude'), ...flags], {
    cwd: REPO,
    env: { ...process.env, HOME: join(base, 'user-home'), PATH: `${bin}:${process.env.PATH ?? ''}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  onTestFinished(() => { child.kill('SIGKILL'); });
  const output = { text: '' };
  child.stdout.on('data', (chunk: Buffer) => { output.text += String(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { output.text += String(chunk); });
  const closed = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  return { child, output, closed };
}

describe('main.ts --hub under the app (--token-stdin --exit-with-parent)', () => {
  it('keeps the token out of its output, which without --exit-with-parent still carries it in the open and dev UI lines', async () => {
    const standalone = startHub(tempDir('hub-parent-'), ['--token-stdin']);
    standalone.child.stdin.end(`${TOKEN}\n`);
    await waitFor(() => /dev UI: \S+/.test(standalone.output.text) || undefined, `the standalone hub's address lines in:\n${standalone.output.text}`, 30_000);
    expect(standalone.output.text).toMatch(new RegExp(`open: http://127\\.0\\.0\\.1:\\d+/#token=${TOKEN}`));
    expect(standalone.output.text).toContain(`dev UI: ${ORIGIN}/#token=${TOKEN}`);

    const underApp = startHub(tempDir('hub-parent-'), ['--token-stdin', '--exit-with-parent']);
    underApp.child.stdin.write(`${TOKEN}\n`);
    await waitFor(() => /IDE core: hub/.test(underApp.output.text) || undefined, `the hub's greeting in:\n${underApp.output.text}`, 30_000);
    underApp.child.stdin.end();
    await underApp.closed;
    expect(underApp.output.text).toContain('IDE core: hub');
    expect(underApp.output.text).not.toContain(TOKEN);
  });

  it('stops its project cores in order and exits 0 when its stdin closes, instead of killing them', async () => {
    const base = tempDir('hub-parent-');
    const root = join(base, 'project');
    mkdirSync(root);
    writeFileSync(join(root, 'notes.txt'), 'notes\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    const hub = startHub(base, ['--token-stdin', '--exit-with-parent'], [root]);
    hub.child.stdin.write(`${TOKEN}\n`);
    await waitFor(() => hub.output.text.includes(`[${basename(root)}] IDE core: ${root}`) || undefined, `the project core to be up in:\n${hub.output.text}`, 30_000);
    const lock = join(projectDir(join(base, 'home'), root), LOCK_FILE);
    expect(existsSync(lock)).toBe(true);

    hub.child.stdin.end();
    expect(await hub.closed).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });
});
