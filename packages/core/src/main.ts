import { randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ClientMessage, ServerMessage } from '@ide/protocol';
import { AgentSession } from './agent/agent-session';
import { defaultIdeHome, projectDir } from './home';
import { Indexer } from './indexer/indexer';
import { createPythonAdapter } from './lang/python';
import { createTypeScriptAdapter } from './lang/typescript';
import { acquireCoreLock } from './lock';
import { buildSnapshot } from './map/snapshot';
import { McpRegistry } from './mcp/registry';
import { startServer } from './server/server';
import { openStore } from './store/store';

const { values } = parseArgs({
  options: {
    project: { type: 'string', multiple: true, default: ['.'] },
    port: { type: 'string', default: '4317' },
    ui: { type: 'string' },
    'allow-origin': { type: 'string', multiple: true, default: [] },
    'ide-home': { type: 'string' },
    claude: { type: 'string', default: 'claude' },
  },
});

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`IDE core: invalid --port "${values.port}"`);
  process.exit(1);
}

const projectArg = resolve(values.project.at(-1) ?? '.');
let root: string;
try {
  root = realpathSync(projectArg);
  if (!statSync(root).isDirectory()) throw new Error('not a directory');
} catch {
  console.error(`IDE core: project directory not found: ${projectArg}`);
  process.exit(1);
}
const projectName = basename(root);
const home = resolve(values['ide-home'] ?? defaultIdeHome());

const lock = acquireCoreLock(projectDir(home, root));
if (!lock.acquired) {
  console.error(`IDE core: another IDE core (pid ${lock.holder}) is already running for ${root}.`);
  console.error(`  Stop it first, or delete ${lock.path} if that process is not an IDE core.`);
  process.exit(1);
}
const token = randomBytes(24).toString('base64url');

try {
  const adapters = await Promise.all([createTypeScriptAdapter(root), createPythonAdapter()]);
  const indexer = new Indexer({ root, adapters });
  await indexer.start();

  const store = openStore(projectDir(home, root));
  const registry = new McpRegistry({ home, root });
  const session = new AgentSession({
    root, home, store,
    claude: { command: values.claude, args: [] },
    mcpServers: () => registry.sessionServers(),
  });
  await session.start();

  const settingsSnapshot = (): ServerMessage => ({ type: 'settings.snapshot', settings: registry.view() });

  const changeSettings = (message: Extract<ClientMessage, { requestId: string; type: `mcp.${string}` }>): void => {
    switch (message.type) {
      case 'mcp.save':
        registry.save(message.level, message.name, message.entry, message.previousName);
        return;
      case 'mcp.remove':
        registry.remove(message.level, message.name);
        return;
      case 'mcp.approve':
        registry.approve(message.name, message.entryHash);
        return;
      case 'mcp.confirm-external-edits':
        registry.confirmExternalEdits(message.fileHashes);
        return;
    }
  };

  const handle = async (message: ClientMessage, reply: (message: ServerMessage) => void): Promise<void> => {
    switch (message.type) {
      case 'chat.send':
        session.send(message.text);
        return;
      case 'chat.stop':
        session.stop();
        return;
      case 'session.restart':
        await session.restart();
        return;
      case 'session.new':
        await session.newSession();
        return;
      case 'prompt.answer':
        session.answerPrompt(message.requestId, message.answer);
        return;
      case 'settings.get':
        reply(settingsSnapshot());
        return;
      default: {
        let error: string | null = null;
        try {
          changeSettings(message);
        } catch (failure) {
          error = (failure as Error).message;
        }
        reply({ type: 'settings.result', requestId: message.requestId, error });
        server.broadcast(settingsSnapshot());
      }
    }
  };

  let version = 1;
  let snapshot = buildSnapshot(version, projectName, indexer.files(), adapters);
  const server = await startServer({
    port,
    token,
    staticDir: values.ui ? resolve(values.ui) : undefined,
    allowedOrigins: values['allow-origin'],
    snapshot: () => snapshot,
    greeting: () => [{ type: 'session.snapshot', state: session.state() }, settingsSnapshot()],
    onClientMessage: (message, reply) => {
      handle(message, reply).catch((error: unknown) => reply({ type: 'error', message: (error as Error).message }));
    },
  });
  session.onMessage((message) => server.broadcast(message));

  indexer.onChange(() => {
    version += 1;
    snapshot = buildSnapshot(version, projectName, indexer.files(), adapters);
    server.broadcast({ type: 'map.snapshot', snapshot });
  });

  console.log(`IDE core: ${root}`);
  console.log(`  ${snapshot.files.length} files, ${snapshot.components.length} components`);
  console.log(`  agent: ${values.claude} (unguarded until Plan 4) · IDE home: ${home}`);
  if (values.ui) console.log(`  open: http://127.0.0.1:${server.port}/#token=${token}`);
  for (const origin of values['allow-origin']) console.log(`  dev UI: ${origin}/#token=${token}`);

  const shutdown = async (): Promise<void> => {
    await session.close();
    await indexer.stop();
    await server.close();
    store.close();
    lock.release();
    process.exit(0);
  };
  let closing: Promise<void> | undefined;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => { closing ??= shutdown(); });
} catch (error) {
  lock.release();
  console.error(`IDE core failed to start: ${(error as Error).message}`);
  process.exit(1);
}
