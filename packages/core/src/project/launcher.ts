import { homedir } from 'node:os';
import type { ClientMessage, ServerMessage } from '@ide/protocol';
import { startServer } from '../server/server';
import { listDirectories } from './browse';
import { startClone, type CloneHandle } from './clone';
import { createProject } from './create';
import { RecentProjects } from './recent';
import { projectBusy, validateProjectPath } from './switch';
import type { ProjectResult } from './target';

// Lets the reply leave before the sockets are closed.
const FLUSH_MS = 50;
const BUSY = 'Another create or clone is already running.';

export interface LauncherOptions {
  port: number;
  token: string;
  staticDir?: string;
  allowedOrigins: string[];
  home: string;
  git?: string;
  handover: (root: string, port: number) => Promise<void>;
}

export interface RunningLauncher {
  port: number;
  finished: Promise<void>;
  close(): Promise<void>;
}

export async function startLauncher(options: LauncherOptions): Promise<RunningLauncher> {
  const recent = new RecentProjects(options.home);
  let working = false;
  let handingOver = false;
  let clone: { requestId: string; handle: CloneHandle } | undefined;
  let closing: Promise<void> | undefined;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });

  const hand = async (root: string): Promise<void> => {
    handingOver = true;
    recent.add(root);
    await new Promise((resolve) => setTimeout(resolve, FLUSH_MS));
    await running.close();
    await options.handover(root, running.port);
    finish();
  };

  const settle = (result: ProjectResult, replyError: (error: string | null) => void): void => {
    replyError('error' in result ? result.error : null);
    if (!('error' in result)) void hand(result.root);
  };

  const handle = (message: ClientMessage, reply: (message: ServerMessage) => void): void => {
    if (handingOver) {
      reply({ type: 'error', message: 'The IDE core is restarting on the new project.' });
      return;
    }
    switch (message.type) {
      case 'fs.list':
        reply({ type: 'fs.list.result', requestId: message.requestId, ...listDirectories(message.path, homedir()) });
        return;
      case 'project.open': {
        const target = validateProjectPath(message.path);
        const error = working ? BUSY : 'error' in target ? target.error : projectBusy(options.home, target.root);
        reply({ type: 'project.open.result', requestId: message.requestId, error });
        if (error === null && !('error' in target)) void hand(target.root);
        return;
      }
      case 'project.create': {
        const { requestId } = message;
        if (working) {
          reply({ type: 'project.create.result', requestId, error: BUSY });
          return;
        }
        working = true;
        void createProject({ parent: message.parent, name: message.name, git: options.git }).then((result) => {
          working = false;
          settle(result, (error) => reply({ type: 'project.create.result', requestId, error }));
        });
        return;
      }
      case 'project.clone': {
        const { requestId } = message;
        if (working) {
          reply({ type: 'project.clone.result', requestId, error: BUSY });
          return;
        }
        working = true;
        const started = startClone({
          url: message.url,
          parent: message.parent,
          name: message.name,
          git: options.git,
          onProgress: (progress) => reply({ type: 'project.clone.progress', requestId, ...progress }),
        });
        clone = { requestId, handle: started };
        void started.done.then((result) => {
          working = false;
          clone = undefined;
          settle(result, (error) => reply({ type: 'project.clone.result', requestId, error }));
        });
        return;
      }
      case 'project.clone.cancel':
        if (clone?.requestId === message.requestId) clone.handle.cancel();
        return;
      default:
        reply({ type: 'error', message: `"${message.type}" is not available until a project is open.` });
    }
  };

  const running = await startServer({
    port: options.port,
    token: options.token,
    staticDir: options.staticDir,
    allowedOrigins: options.allowedOrigins,
    snapshot: () => null,
    greeting: () => [{ type: 'project.info', info: { root: null, name: '', home: homedir(), recent: recent.list() } }],
    onClientMessage: handle,
  });

  return {
    port: running.port,
    finished,
    close: () => (closing ??= (async () => {
      clone?.handle.cancel();
      await clone?.handle.done;
      await running.close();
      finish();
    })()),
  };
}
