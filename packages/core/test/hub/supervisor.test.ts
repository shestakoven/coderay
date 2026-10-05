import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubProject } from '@ide/protocol';
import { busyMessage } from '../../src/project/switch';
import {
  POLL_MS, projectId, START_TIMEOUT_MS, STOP_TIMEOUT_MS, Supervisor,
  type CoreChild, type CoreExit, type SupervisorDeps, type SupervisorLimits,
} from '../../src/hub/supervisor';

type Signal = 'SIGTERM' | 'SIGKILL';
type SpawnRequest = { root: string; port: number; token: string };

class FakeChild implements CoreChild {
  readonly kills: Signal[] = [];
  exited = false;
  // Signals the process gives in to; a stuck core ignores SIGTERM.
  obeys = new Set<Signal>(['SIGTERM', 'SIGKILL']);
  private readonly stderrListeners: ((text: string) => void)[] = [];
  private readonly exitListeners: ((exit: CoreExit) => void)[] = [];

  constructor(readonly request: SpawnRequest) {}

  onStderr(listener: (text: string) => void): void {
    this.stderrListeners.push(listener);
  }

  onExit(listener: (exit: CoreExit) => void): void {
    this.exitListeners.push(listener);
  }

  kill(signal: Signal): void {
    this.kills.push(signal);
    if (this.obeys.has(signal)) setTimeout(() => this.exit({ code: null, signal }), 10);
  }

  stderr(text: string): void {
    for (const listener of this.stderrListeners) listener(text);
  }

  exit(exit: CoreExit): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(exit);
  }
}

function harness(limits: Partial<SupervisorLimits> = {}) {
  const children: FakeChild[] = [];
  // Roots whose core never starts listening on its own; the test calls listen().
  const quiet = new Set<string>();
  const listening = new Set<number>();
  const busy = new Map<string, string>();
  let nextPort = 41_000;
  let nextToken = 0;
  const deps: SupervisorDeps = {
    spawn: (request) => {
      const child = new FakeChild({ ...request });
      children.push(child);
      if (!quiet.has(request.root)) listening.add(request.port);
      return child;
    },
    freePort: async () => nextPort++,
    listens: async (port) => listening.has(port),
    busy: (root) => busy.get(root) ?? null,
    newToken: () => `token-${++nextToken}`,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const sup = new Supervisor(deps, limits);
  const changes: { projects: HubProject[]; activeId: string | null }[] = [];
  sup.onChange(() => changes.push({ projects: structuredClone(sup.list()), activeId: sup.activeId() }));
  const childrenOf = (root: string) => children.filter((child) => child.request.root === root);
  return {
    sup, children, quiet, busy, changes, childrenOf,
    childOf: (root: string): FakeChild => {
      const child = childrenOf(root).at(-1);
      if (!child) throw new Error(`no child for ${root}`);
      return child;
    },
    listen: (child: FakeChild) => listening.add(child.request.port),
    entry: (root: string): HubProject | undefined => sup.list().find((project) => project.root === root),
    ids: () => sup.list().map((project) => project.root),
  };
}

type Harness = ReturnType<typeof harness>;

// Runs fake time forward until the promise settles; fails instead of hanging.
async function settle<T>(promise: Promise<T>, maxMs = 20_000): Promise<T> {
  let outcome: { value: T } | { error: unknown } | null = null;
  promise.then((value) => { outcome = { value }; }, (error: unknown) => { outcome = { error }; });
  for (let spent = 0; outcome === null && spent <= maxMs; spent += POLL_MS) await vi.advanceTimersByTimeAsync(POLL_MS);
  if (outcome === null) throw new Error(`did not settle within ${maxMs} ms of fake time`);
  const done = outcome as { value: T } | { error: unknown };
  if ('error' in done) throw done.error;
  return done.value;
}

const isSettled = async (promise: Promise<unknown>): Promise<boolean> => {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await vi.advanceTimersByTimeAsync(0);
  return settled;
};

async function openAll(h: Harness, roots: string[]): Promise<void> {
  for (const root of roots) expect(await settle(h.sup.open(root))).toEqual({ id: projectId(root), error: null });
}

const failedStates = (h: Harness, root: string) =>
  h.changes.flatMap((change) => change.projects.filter((project) => project.root === root && project.state === 'failed'));

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('projectId', () => {
  const sha = (root: string) => createHash('sha256').update(root).digest('hex');

  it.each(['/w/a', '/Users/me/code/shop', '/', 'C:\\code\\app', '/Users/евгений/проект'])('is p and the first 10 hex chars of sha256 of %j', (root) => {
    expect(projectId(root)).toBe(`p${sha(root).slice(0, 10)}`);
  });

  it('gives the same root the same id every time', () => {
    expect(projectId('/w/shop')).toBe(projectId('/w/shop'));
  });

  it('gives different roots different ids, even near-identical ones', () => {
    const roots = ['/w/a', '/w/a/', '/w/A', '/w/b', '/w/ab', ...Array.from({ length: 200 }, (_, i) => `/w/p${i}`)];
    expect(new Set(roots.map(projectId)).size).toBe(roots.length);
  });
});

describe('Supervisor at start', () => {
  it('has no projects and nothing active', () => {
    const h = harness();
    expect([h.sup.list(), h.sup.activeId()]).toEqual([[], null]);
  });
});

describe('Supervisor.open', () => {
  it('shows the project at once as starting, at the end of the list, named after its folder', async () => {
    const h = harness();
    await openAll(h, ['/w/first']);
    h.quiet.add('/w/shop');
    void h.sup.open('/w/shop');
    expect(h.ids()).toEqual(['/w/first', '/w/shop']);
    expect(h.entry('/w/shop')).toEqual({ id: projectId('/w/shop'), root: '/w/shop', name: 'shop', state: 'starting', port: null, token: null, error: null });
  });

  it('becomes running with the port and token its own child got, and reports no error', async () => {
    const h = harness();
    const result = await settle(h.sup.open('/w/shop'));
    const child = h.childOf('/w/shop');
    expect(result).toEqual({ id: projectId('/w/shop'), error: null });
    expect(h.entry('/w/shop')).toMatchObject({ state: 'running', port: child.request.port, token: child.request.token, error: null });
  });

  it('stays starting until the port listens, then resolves', async () => {
    const h = harness();
    h.quiet.add('/w/slow');
    const opening = h.sup.open('/w/slow');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.entry('/w/slow')?.state).toBe('starting');
    expect(await isSettled(opening)).toBe(false);
    h.listen(h.childOf('/w/slow'));
    expect(await settle(opening)).toEqual({ id: projectId('/w/slow'), error: null });
    expect(h.entry('/w/slow')?.state).toBe('running');
  });

  it('gives every child its own token and its own free port', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b', '/w/c']);
    const tokens = h.children.map((child) => child.request.token);
    const ports = h.children.map((child) => child.request.port);
    expect(new Set(tokens).size).toBe(3);
    expect(new Set(ports).size).toBe(3);
    for (const child of h.children) {
      expect(h.entry(child.request.root)).toMatchObject({ port: child.request.port, token: child.request.token });
    }
  });

  it('activates the project it opens', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b']);
    expect(h.sup.activeId()).toBe(projectId('/w/b'));
  });

  it('only activates a root that is already open: no second entry, no second child', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b']);
    expect(await settle(h.sup.open('/w/a'))).toEqual({ id: projectId('/w/a'), error: null });
    expect(h.ids()).toEqual(['/w/a', '/w/b']);
    expect(h.children).toHaveLength(2);
    expect(h.sup.activeId()).toBe(projectId('/w/a'));
  });

  it('does not take its own running core for a foreign lock when the root is opened again', async () => {
    const h = harness();
    await openAll(h, ['/w/a']);
    h.busy.set('/w/a', busyMessage(h.children.length + 777));
    expect(await settle(h.sup.open('/w/a'))).toEqual({ id: projectId('/w/a'), error: null });
    expect(h.entry('/w/a')?.state).toBe('running');
  });

  it('does not spawn a second child for a root that is still starting', async () => {
    const h = harness();
    h.quiet.add('/w/a');
    void h.sup.open('/w/a');
    void h.sup.open('/w/a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.children).toHaveLength(1);
    expect(h.ids()).toEqual(['/w/a']);
  });

  it('restarts a failed project that is opened again, in its place, with a fresh port and token', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b', '/w/c']);
    const first = h.childOf('/w/a');
    first.exit({ code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.entry('/w/a')?.state).toBe('failed');

    expect(await settle(h.sup.open('/w/a'))).toEqual({ id: projectId('/w/a'), error: null });
    const second = h.childOf('/w/a');
    expect(second).not.toBe(first);
    expect(h.ids()).toEqual(['/w/a', '/w/b', '/w/c']);
    expect(h.entry('/w/a')).toMatchObject({ state: 'running', port: second.request.port, token: second.request.token, error: null });
    expect([second.request.port, second.request.token]).not.toEqual([first.request.port, first.request.token]);
  });

  it('refuses a project another IDE core holds, with the standard wording, and spawns nothing', async () => {
    const h = harness();
    await openAll(h, ['/w/mine']);
    h.busy.set('/w/taken', busyMessage(4242));
    expect(await settle(h.sup.open('/w/taken'))).toEqual({ id: projectId('/w/taken'), error: 'That project is already open in another IDE core (pid 4242).' });
    expect(h.childrenOf('/w/taken')).toHaveLength(0);
    expect(h.ids()).toEqual(['/w/mine']);
    expect(h.sup.activeId()).toBe(projectId('/w/mine'));
  });

  it('opens at most 10 projects and explains why the 11th is refused', async () => {
    const h = harness();
    const ten = Array.from({ length: 10 }, (_, i) => `/w/p${i}`);
    await openAll(h, ten);
    expect(await settle(h.sup.open('/w/eleventh'))).toEqual({ id: projectId('/w/eleventh'), error: 'At most 10 projects can be open at once. Close one first.' });
    expect(h.children).toHaveLength(10);
    expect(h.ids()).toEqual(ten);
    expect(h.sup.activeId()).toBe(projectId('/w/p9'));
  });

  it('still activates one of the ten open projects at the cap', async () => {
    const h = harness();
    await openAll(h, Array.from({ length: 10 }, (_, i) => `/w/p${i}`));
    expect(await settle(h.sup.open('/w/p3'))).toEqual({ id: projectId('/w/p3'), error: null });
    expect(h.sup.activeId()).toBe(projectId('/w/p3'));
  });

  it('opens another project once one of the ten is closed', async () => {
    const h = harness();
    await openAll(h, Array.from({ length: 10 }, (_, i) => `/w/p${i}`));
    expect(await settle(h.sup.close(projectId('/w/p0')))).toBeNull();
    expect(await settle(h.sup.open('/w/eleventh'))).toEqual({ id: projectId('/w/eleventh'), error: null });
    expect(h.sup.list()).toHaveLength(10);
  });

  it('counts a failed project towards the cap, since it stays open', async () => {
    const h = harness();
    await openAll(h, Array.from({ length: 10 }, (_, i) => `/w/p${i}`));
    h.childOf('/w/p0').exit({ code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(0);
    expect((await settle(h.sup.open('/w/eleventh'))).error).toBe('At most 10 projects can be open at once. Close one first.');
  });
});

describe('Supervisor when a core fails', () => {
  async function failDuringStart(stderr: string[], exit: CoreExit) {
    const h = harness();
    h.quiet.add('/w/a');
    const opening = h.sup.open('/w/a');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    const child = h.childOf('/w/a');
    for (const chunk of stderr) child.stderr(chunk);
    child.exit(exit);
    const result = await settle(opening);
    return { h, result, entry: h.entry('/w/a') };
  }

  it('marks a core that exits before listening as failed and reports the last error line of its stderr', async () => {
    const { result, entry } = await failDuringStart(
      ['Loading the map\n', 'Error: first problem\nstill going\n', 'FATAL: database is locked\n', 'bye\n'],
      { code: 1, signal: null },
    );
    expect(entry?.state).toBe('failed');
    expect(entry?.error).toContain('FATAL: database is locked');
    expect(entry?.error).not.toContain('first problem');
    expect(entry?.error).not.toContain('bye');
    expect(result).toEqual({ id: projectId('/w/a'), error: entry?.error });
  });

  it('reads an error line split across stderr chunks', async () => {
    const { entry } = await failDuringStart(['noise\nError: listen EADDRINUSE 127.0.0', '.1:41000\nshutting down\n'], { code: 1, signal: null });
    expect(entry?.error).toContain('Error: listen EADDRINUSE 127.0.0.1:41000');
  });

  it('says how the core exited when its stderr names no error', async () => {
    const { result, entry } = await failDuringStart(['starting\n', 'indexing\n'], { code: 3, signal: null });
    expect(entry).toMatchObject({ state: 'failed', error: 'The IDE core exited (code 3).' });
    expect(result.error).toBe('The IDE core exited (code 3).');
  });

  it('names the signal of a core killed before listening', async () => {
    const { entry } = await failDuringStart([], { code: null, signal: 'SIGSEGV' });
    expect(entry?.state).toBe('failed');
    expect(entry?.error).toContain('SIGSEGV');
  });

  it('reports a core that could not be spawned at all', async () => {
    const { entry } = await failDuringStart([], { error: new Error('spawn node ENOENT') });
    expect(entry?.state).toBe('failed');
    expect(entry?.error).toContain('ENOENT');
  });

  it('marks a running core that dies as failed with a sentence naming the signal, and keeps it in the list', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b']);
    h.childOf('/w/a').exit({ code: null, signal: 'SIGKILL' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.entry('/w/a')).toMatchObject({ state: 'failed', error: 'The IDE core stopped unexpectedly (SIGKILL).', port: null, token: null });
    expect(h.ids()).toEqual(['/w/a', '/w/b']);
  });

  it('marks a running core that exits with a code as failed and names the code', async () => {
    const h = harness();
    await openAll(h, ['/w/a']);
    h.childOf('/w/a').exit({ code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.entry('/w/a')?.state).toBe('failed');
    expect(h.entry('/w/a')?.error).toContain('code 1');
  });

  it('reports the last error line of a running core that exits with a code after writing one', async () => {
    const h = harness();
    await openAll(h, ['/w/a']);
    const child = h.childOf('/w/a');
    child.stderr('serving\nfatal error: out of memory\n');
    child.exit({ code: 134, signal: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.entry('/w/a')?.error).toContain('fatal error: out of memory');
  });

  it('keeps a failed project in the list as time passes', async () => {
    const h = harness();
    await openAll(h, ['/w/a']);
    h.childOf('/w/a').exit({ code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.entry('/w/a')?.state).toBe('failed');
    expect(h.children).toHaveLength(1);
  });

  it('fails a core that never listens once the start timeout passes, and stops it', async () => {
    const h = harness();
    h.quiet.add('/w/a');
    const opening = h.sup.open('/w/a');
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS - 5_000);
    expect(h.entry('/w/a')?.state).toBe('starting');
    await vi.advanceTimersByTimeAsync(10_000);
    const entry = h.entry('/w/a');
    expect(entry?.state).toBe('failed');
    expect(entry?.error).toMatch(/time|did not start|seconds|minutes/i);
    expect(await settle(opening)).toEqual({ id: projectId('/w/a'), error: entry?.error });
    expect(h.childOf('/w/a').kills).toContain('SIGTERM');
  });

  it('keeps the timeout reason when the timed-out core then exits', async () => {
    const h = harness();
    h.quiet.add('/w/a');
    const opening = h.sup.open('/w/a');
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + 5_000);
    const reason = h.entry('/w/a')?.error;
    await settle(opening);
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS + 1_000);
    expect(h.entry('/w/a')).toMatchObject({ state: 'failed', error: reason });
  });

  it('honours a shorter start timeout', async () => {
    const h = harness({ startTimeoutMs: 2_000 });
    h.quiet.add('/w/a');
    void h.sup.open('/w/a');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.entry('/w/a')?.state).toBe('failed');
  });
});

describe('Supervisor.restart', () => {
  it('re-spawns a failed project in its place with a new port and token', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b']);
    const first = h.childOf('/w/a');
    first.exit({ code: null, signal: 'SIGKILL' });
    await vi.advanceTimersByTimeAsync(0);

    expect(await settle(h.sup.restart(projectId('/w/a')))).toBeNull();
    const second = h.childOf('/w/a');
    expect(h.childrenOf('/w/a')).toHaveLength(2);
    expect(h.ids()).toEqual(['/w/a', '/w/b']);
    expect(second.request.port).not.toBe(first.request.port);
    expect(second.request.token).not.toBe(first.request.token);
    expect(h.entry('/w/a')).toMatchObject({ state: 'running', port: second.request.port, token: second.request.token, error: null });
  });

  it('refuses to restart a running project and spawns nothing', async () => {
    const h = harness();
    await openAll(h, ['/w/a']);
    expect(await settle(h.sup.restart(projectId('/w/a')))).toEqual(expect.any(String));
    expect(h.children).toHaveLength(1);
    expect(h.entry('/w/a')?.state).toBe('running');
  });

  it('refuses to restart a project that is still starting', async () => {
    const h = harness();
    h.quiet.add('/w/a');
    void h.sup.open('/w/a');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(await settle(h.sup.restart(projectId('/w/a')))).toEqual(expect.any(String));
    expect(h.children).toHaveLength(1);
  });

  it('refuses to restart an unknown project', async () => {
    const h = harness();
    expect(await settle(h.sup.restart('p0000000000'))).toEqual(expect.any(String));
    expect(h.children).toHaveLength(0);
  });
});

describe('Supervisor.close', () => {
  it('stops the core with SIGTERM and removes the project once it exits', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b']);
    const closing = h.sup.close(projectId('/w/a'));
    expect(h.childOf('/w/a').kills).toEqual(['SIGTERM']);
    expect(await settle(closing)).toBeNull();
    expect(h.ids()).toEqual(['/w/b']);
  });

  it('kills a core that ignores SIGTERM after 5 seconds', async () => {
    const h = harness();
    await openAll(h, ['/w/a']);
    const child = h.childOf('/w/a');
    child.obeys.delete('SIGTERM');
    const closing = h.sup.close(projectId('/w/a'));
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS - 100);
    expect(child.kills).toEqual(['SIGTERM']);
    expect(h.ids()).toEqual(['/w/a']);
    await vi.advanceTimersByTimeAsync(200);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(await settle(closing)).toBeNull();
    expect(h.ids()).toEqual([]);
  });

  it('does not report the exit it caused as a failure', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b']);
    h.childOf('/w/a').obeys.delete('SIGTERM');
    await settle(h.sup.close(projectId('/w/a')));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(failedStates(h, '/w/a')).toEqual([]);
    expect(h.entry('/w/a')).toBeUndefined();
  });

  it('activates the next tab when the active project closes', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b', '/w/c']);
    h.sup.activate(projectId('/w/b'));
    await settle(h.sup.close(projectId('/w/b')));
    expect(h.sup.activeId()).toBe(projectId('/w/c'));
  });

  it('activates the previous tab when the active project is the last tab', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b', '/w/c']);
    await settle(h.sup.close(projectId('/w/c')));
    expect(h.sup.activeId()).toBe(projectId('/w/b'));
  });

  it('follows tab order, not opening order, for the neighbour', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b', '/w/c']);
    h.sup.setOrder([projectId('/w/c'), projectId('/w/a'), projectId('/w/b')]);
    h.sup.activate(projectId('/w/a'));
    await settle(h.sup.close(projectId('/w/a')));
    expect(h.sup.activeId()).toBe(projectId('/w/b'));
  });

  it('leaves nothing active when the only project closes', async () => {
    const h = harness();
    await openAll(h, ['/w/a']);
    await settle(h.sup.close(projectId('/w/a')));
    expect([h.sup.list(), h.sup.activeId()]).toEqual([[], null]);
  });

  it('keeps the active project when another one closes', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b', '/w/c']);
    h.sup.activate(projectId('/w/b'));
    await settle(h.sup.close(projectId('/w/a')));
    await settle(h.sup.close(projectId('/w/c')));
    expect(h.sup.activeId()).toBe(projectId('/w/b'));
  });

  it('is fine with a second close while the first is still stopping', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b']);
    h.childOf('/w/a').obeys.delete('SIGTERM');
    const first = h.sup.close(projectId('/w/a'));
    const second = h.sup.close(projectId('/w/a'));
    expect(await settle(Promise.all([first, second]))).toEqual([null, null]);
    expect(h.ids()).toEqual(['/w/b']);
    expect(failedStates(h, '/w/a')).toEqual([]);
  });

  it('reports an error for an unknown project and changes nothing', async () => {
    const h = harness();
    await openAll(h, ['/w/a']);
    const before = h.changes.length;
    expect(await settle(h.sup.close('p0000000000'))).toEqual(expect.any(String));
    expect(h.ids()).toEqual(['/w/a']);
    expect(h.changes).toHaveLength(before);
    expect(h.childOf('/w/a').kills).toEqual([]);
  });

  it('removes a failed project without signalling its dead core', async () => {
    const h = harness();
    await openAll(h, ['/w/a']);
    const child = h.childOf('/w/a');
    child.exit({ code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(await settle(h.sup.close(projectId('/w/a')))).toBeNull();
    expect(h.ids()).toEqual([]);
    expect(child.kills).toEqual([]);
  });

  it('stops a project that is still starting without marking it failed or bringing it back', async () => {
    const h = harness();
    h.quiet.add('/w/a');
    const opening = h.sup.open('/w/a');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    const child = h.childOf('/w/a');
    expect(await settle(h.sup.close(projectId('/w/a')))).toBeNull();
    h.listen(child);
    await settle(opening);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kills).toContain('SIGTERM');
    expect(h.ids()).toEqual([]);
    expect(failedStates(h, '/w/a')).toEqual([]);
  });

  it('lets a closed project be opened again with a new core', async () => {
    const h = harness();
    await openAll(h, ['/w/a']);
    await settle(h.sup.close(projectId('/w/a')));
    await openAll(h, ['/w/a']);
    expect(h.childrenOf('/w/a')).toHaveLength(2);
    expect(h.entry('/w/a')?.state).toBe('running');
  });
});

describe('Supervisor.activate', () => {
  it('activates a known project, says so and announces the change', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b']);
    const before = h.changes.length;
    expect(h.sup.activate(projectId('/w/a'))).toBe(true);
    expect(h.sup.activeId()).toBe(projectId('/w/a'));
    expect(h.changes.length).toBeGreaterThan(before);
    expect(h.changes.at(-1)?.activeId).toBe(projectId('/w/a'));
  });

  it('refuses an unknown project without a change', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b']);
    const before = h.changes.length;
    expect(h.sup.activate('p0000000000')).toBe(false);
    expect(h.sup.activeId()).toBe(projectId('/w/b'));
    expect(h.changes).toHaveLength(before);
  });

  it('keeps the tab order', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b', '/w/c']);
    h.sup.activate(projectId('/w/a'));
    expect(h.ids()).toEqual(['/w/a', '/w/b', '/w/c']);
  });
});

describe('Supervisor.setOrder', () => {
  const four = ['/w/a', '/w/b', '/w/c', '/w/d'];
  const id = (name: string) => projectId(`/w/${name}`);

  it('puts the projects in the given order', async () => {
    const h = harness();
    await openAll(h, four);
    h.sup.setOrder(['d', 'b', 'c', 'a'].map(id));
    expect(h.ids()).toEqual(['/w/d', '/w/b', '/w/c', '/w/a']);
  });

  it('ignores unknown ids and keeps unlisted projects after the listed ones, in their relative order', async () => {
    const h = harness();
    await openAll(h, four);
    h.sup.setOrder([id('c'), 'p0000000000', id('a')]);
    expect(h.ids()).toEqual(['/w/c', '/w/a', '/w/b', '/w/d']);
  });

  it('announces a change only when the order changes', async () => {
    const h = harness();
    await openAll(h, four);
    const before = h.changes.length;
    h.sup.setOrder(['a', 'b', 'c', 'd'].map(id));
    h.sup.setOrder([id('a')]);
    h.sup.setOrder([]);
    h.sup.setOrder(['p0000000000']);
    expect(h.changes).toHaveLength(before);
    h.sup.setOrder([id('b')]);
    expect(h.changes).toHaveLength(before + 1);
    expect(h.changes.at(-1)?.projects.map((project) => project.root)).toEqual(['/w/b', '/w/a', '/w/c', '/w/d']);
  });

  it('keeps the active project', async () => {
    const h = harness();
    await openAll(h, four);
    h.sup.setOrder(['d', 'c', 'b', 'a'].map(id));
    expect(h.sup.activeId()).toBe(id('d'));
  });

  it('places a project opened afterwards at the end of the new order', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b']);
    h.sup.setOrder([id('b'), id('a')]);
    await openAll(h, ['/w/c']);
    expect(h.ids()).toEqual(['/w/b', '/w/a', '/w/c']);
  });
});

describe('Supervisor.onChange', () => {
  it('announces the starting entry, then the running one', async () => {
    const h = harness();
    await openAll(h, ['/w/a']);
    const states = h.changes.map((change) => change.projects.find((project) => project.root === '/w/a')?.state);
    expect(states).toContain('starting');
    expect(states.at(-1)).toBe('running');
    expect(states.indexOf('starting')).toBeLessThan(states.lastIndexOf('running'));
  });

  it('announces a failure', async () => {
    const h = harness();
    await openAll(h, ['/w/a']);
    const before = h.changes.length;
    h.childOf('/w/a').exit({ code: null, signal: 'SIGKILL' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.changes.length).toBeGreaterThan(before);
    expect(h.changes.at(-1)?.projects[0]?.state).toBe('failed');
  });

  it('announces the removal of a closed project', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b']);
    await settle(h.sup.close(projectId('/w/a')));
    expect(h.changes.at(-1)?.projects.map((project) => project.root)).toEqual(['/w/b']);
  });

  it('calls every listener', async () => {
    const h = harness();
    const second = vi.fn();
    h.sup.onChange(second);
    await openAll(h, ['/w/a']);
    expect(second).toHaveBeenCalled();
    expect(second.mock.calls.length).toBe(h.changes.length);
  });
});

describe('Supervisor.stopAll', () => {
  it('signals every core before any of them has exited', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b', '/w/c']);
    for (const child of h.children) child.obeys.delete('SIGTERM');
    const stopping = h.sup.stopAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.children.map((child) => child.kills)).toEqual([['SIGTERM'], ['SIGTERM'], ['SIGTERM']]);
    for (const child of h.children) child.exit({ code: 0, signal: null });
    await settle(stopping);
  });

  it('waits for every core to exit', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b']);
    h.childOf('/w/a').obeys.delete('SIGTERM');
    h.childOf('/w/b').obeys.delete('SIGTERM');
    const stopping = h.sup.stopAll();
    h.childOf('/w/a').exit({ code: 0, signal: null });
    expect(await isSettled(stopping)).toBe(false);
    h.childOf('/w/b').exit({ code: 0, signal: null });
    expect(await isSettled(stopping)).toBe(true);
  });

  it('kills a core that ignores SIGTERM after 5 seconds', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b']);
    const stuck = h.childOf('/w/a');
    stuck.obeys.delete('SIGTERM');
    const stopping = h.sup.stopAll();
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS + 100);
    expect(stuck.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(h.childOf('/w/b').kills).toEqual(['SIGTERM']);
    await settle(stopping);
  });

  it('keeps the list and does not report the exits it caused as failures', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b']);
    h.sup.activate(projectId('/w/a'));
    await settle(h.sup.stopAll());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.ids()).toEqual(['/w/a', '/w/b']);
    expect(h.sup.activeId()).toBe(projectId('/w/a'));
    expect([...failedStates(h, '/w/a'), ...failedStates(h, '/w/b')]).toEqual([]);
  });

  it('starts no new core afterwards, so none outlives the hub', async () => {
    const h = harness();
    await openAll(h, ['/w/a']);
    const only = h.childOf('/w/a');
    await settle(h.sup.stopAll());
    expect((await settle(h.sup.open('/w/b'))).error).toEqual(expect.any(String));
    expect(h.children).toEqual([only]);
  });

  it('copes with a project that had already failed', async () => {
    const h = harness();
    await openAll(h, ['/w/a', '/w/b']);
    h.childOf('/w/a').exit({ code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(0);
    await settle(h.sup.stopAll());
    expect(h.childOf('/w/a').kills).toEqual([]);
    expect(h.childOf('/w/b').kills).toEqual(['SIGTERM']);
  });
});
