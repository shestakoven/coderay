import { homedir } from 'node:os';
import type { ClientMessage, HubProjectState, HubSnapshot, ServerMessage } from '@ide/protocol';
import { listDirectories } from '../project/browse';
import { startClone, type CloneHandle } from '../project/clone';
import { createProject } from '../project/create';
import { RecentProjects } from '../project/recent';
import { validateProjectPath } from '../project/switch';
import type { ProjectResult } from '../project/target';
import { startServer } from '../server/server';
import { coreProcessDeps, type ChildCoreFlags } from './core-process';
import { readOpenProjects, serializeOpenProjects, writeOpenProjects, type OpenProjects } from './open-projects';
import { projectId, Supervisor } from './supervisor';

const BUSY = 'Another create or clone is already running.';

export interface HubOptions {
  port: number;
  token: string;
  staticDir?: string;
  allowedOrigins: string[];
  home: string;
  // Absolute paths from --project; when empty the hub reopens what was open last time.
  projects: string[];
  child: Omit<ChildCoreFlags, 'allowedOrigins'>;
  git?: string;
}

export interface RunningHub {
  port: number;
  close(): Promise<void>;
}

export async function startHub(options: HubOptions): Promise<RunningHub> {
  const recent = new RecentProjects(options.home);
  let hubPort = 0;
  const supervisor = new Supervisor(coreProcessDeps(options.home, () => hubPort, { ...options.child, allowedOrigins: options.allowedOrigins }));
  let closing: Promise<void> | undefined;
  let working = false;
  let clone: { requestId: string; handle: CloneHandle } | undefined;

  const snapshot = (): HubSnapshot => ({ projects: supervisor.list(), activeId: supervisor.activeId(), home: homedir(), recent: recent.list() });

  const openProject = async (path: string): Promise<string | null> => {
    const target = validateProjectPath(path);
    if ('error' in target) return target.error;
    const { error } = await supervisor.open(target.root);
    if (error === null) {
      try {
        recent.add(target.root);
      } catch {
        // The recent list is cosmetic: a failed write must not fail the open.
      }
    }
    return error;
  };

  const openCreated = async (result: ProjectResult): Promise<string | null> => {
    if ('error' in result) return result.error;
    const error = await openProject(result.root);
    return error === null ? null : `${result.root} is ready but could not be opened: ${error}`;
  };

  const handle = async (message: ClientMessage, reply: (message: ServerMessage) => void): Promise<void> => {
    switch (message.type) {
      case 'fs.list':
        reply({ type: 'fs.list.result', requestId: message.requestId, ...listDirectories(message.path, homedir()) });
        return;
      case 'project.open':
        reply({ type: 'project.open.result', requestId: message.requestId, error: await openProject(message.path) });
        return;
      case 'project.create': {
        const { requestId } = message;
        if (working) {
          reply({ type: 'project.create.result', requestId, error: BUSY });
          return;
        }
        working = true;
        let result: ProjectResult;
        try {
          result = await createProject({ parent: message.parent, name: message.name, git: options.git });
        } finally {
          working = false;
        }
        reply({ type: 'project.create.result', requestId, error: await openCreated(result) });
        return;
      }
      case 'project.clone': {
        const { requestId } = message;
        if (working) {
          reply({ type: 'project.clone.result', requestId, error: BUSY });
          return;
        }
        working = true;
        let result: ProjectResult;
        try {
          const started = startClone({
            url: message.url,
            parent: message.parent,
            name: message.name,
            git: options.git,
            onProgress: (progress) => reply({ type: 'project.clone.progress', requestId, ...progress }),
          });
          clone = { requestId, handle: started };
          result = await started.done;
        } finally {
          working = false;
          clone = undefined;
        }
        reply({ type: 'project.clone.result', requestId, error: await openCreated(result) });
        return;
      }
      case 'project.clone.cancel':
        if (clone?.requestId === message.requestId) clone.handle.cancel();
        return;
      case 'project.close':
        reply({ type: 'project.close.result', requestId: message.requestId, error: 'CodeRay hub closes a project with hub.close.' });
        return;
      case 'hub.activate':
        if (!supervisor.activate(message.id)) reply({ type: 'error', message: `There is no open project with id "${message.id}".` });
        return;
      case 'hub.order':
        supervisor.setOrder(message.ids);
        return;
      case 'hub.close':
        reply({ type: 'hub.close.result', requestId: message.requestId, error: await supervisor.close(message.id) });
        return;
      case 'hub.restart':
        reply({ type: 'hub.restart.result', requestId: message.requestId, error: await supervisor.restart(message.id) });
        return;
      default:
        reply({ type: 'error', message: `"${message.type}" goes to a project core, not to CodeRay hub.` });
    }
  };

  const running = await startServer({
    port: options.port,
    token: options.token,
    staticDir: options.staticDir,
    allowedOrigins: options.allowedOrigins,
    snapshot: () => null,
    greeting: () => [{ type: 'hub.snapshot', hub: snapshot() }],
    onClientMessage: (message, reply) => {
      if (closing) {
        reply({ type: 'error', message: 'CodeRay hub is shutting down.' });
        return;
      }
      handle(message, reply).catch((error: unknown) => reply({ type: 'error', message: (error as Error).message }));
    },
  });
  hubPort = running.port;

  let saved: string | undefined;
  const states = new Map<string, HubProjectState>();
  supervisor.onChange(() => {
    running.broadcast({ type: 'hub.snapshot', hub: snapshot() });
    const projects = supervisor.list();
    const activeRoot = projects.find((project) => project.id === supervisor.activeId())?.root ?? null;
    const text = serializeOpenProjects({ roots: projects.map((project) => project.root), activeRoot });
    if (text !== saved) {
      try {
        writeOpenProjects(options.home, text);
        saved = text;
      } catch (error) {
        console.error(`CodeRay hub: could not save the open projects: ${(error as Error).message}`);
      }
    }
    for (const project of projects) {
      if (states.get(project.id) === project.state) continue;
      states.set(project.id, project.state);
      if (project.state === 'running') console.log(`  project ready: ${project.root} (port ${project.port})`);
      if (project.state === 'failed') console.error(`  project failed: ${project.root}: ${project.error}`);
    }
    for (const id of states.keys()) if (!projects.some((project) => project.id === id)) states.delete(id);
  });

  // After the caller has printed the hub's address, so the project lines follow it.
  setImmediate(() => reopen(supervisor, options.projects.length > 0 ? { roots: options.projects, activeRoot: null } : readOpenProjects(options.home)));

  return {
    port: running.port,
    close: () => (closing ??= (async () => {
      const cloning = clone?.handle;
      cloning?.cancel();
      await cloning?.done;
      await supervisor.stopAll();
      await running.close();
    })()),
  };
}

// Opens in parallel: each open adds its tab before its first await, so the tabs keep the given order.
// A project another core holds stays as a failed tab, so it is neither lost from the saved list nor silently missing.
function reopen(supervisor: Supervisor, { roots, activeRoot }: OpenProjects): void {
  const seen = new Set<string>();
  for (const path of roots) {
    const target = validateProjectPath(path);
    if ('error' in target) {
      console.error(`  skipped ${path}: ${target.error}`);
      continue;
    }
    if (seen.has(target.root)) continue;
    seen.add(target.root);
    void supervisor.open(target.root, { keepIfBusy: true }).then(({ error }) => {
      if (error !== null && !supervisor.list().some((project) => project.root === target.root)) console.error(`  could not open ${target.root}: ${error}`);
    });
  }
  const active = activeRoot === null ? null : validateProjectPath(activeRoot);
  if (active && !('error' in active)) supervisor.activate(projectId(active.root));
}
