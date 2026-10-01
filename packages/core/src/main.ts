import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ClientMessage, MapSnapshot, ModelInfo, ServerMessage } from '@ide/protocol';
import { AgentSession } from './agent/agent-session';
import { createExecutionRuntime } from './execution/runtime';
import { computeFileEdges, unresolvedImports } from './graph/edges';
import { defaultIdeHome, projectDir, runDir } from './home';
import { Indexer } from './indexer/indexer';
import { createPythonAdapter } from './lang/python';
import { createTypeScriptAdapter } from './lang/typescript';
import { acquireCoreLock } from './lock';
import { MapService } from './map/map-service';
import { buildSnapshot } from './map/snapshot';
import { IdentifierClassifier } from './c4/classify';
import { watchDeploy } from './c4/deploy';
import { buildC4 } from './c4/model';
import { McpRegistry } from './mcp/registry';
import { fetchModels } from './models/catalog';
import { removeStaleModelDirs } from './models/claude-cli';
import { createModelProvider } from './models/provider';
import { PolicyStore } from './policy/policy';
import { listDirectories } from './project/browse';
import { RecentProjects } from './project/recent';
import { takeLaunchToken } from './project/token';
import { successorArgs, validateProjectPath } from './project/switch';
import { ProgressReporter } from './progress';
import { routeClientMessage, type SettingsClientMessage } from './server/router';
import { startServer, type RunningServer } from './server/server';
import { openStore } from './store/store';
import { TerminalService } from './terminal/terminal-service';

const { values } = parseArgs({
  options: {
    project: { type: 'string', multiple: true, default: ['.'] },
    port: { type: 'string', default: '4317' },
    ui: { type: 'string' },
    'allow-origin': { type: 'string', multiple: true, default: [] },
    'ide-home': { type: 'string' },
    'token-stdin': { type: 'boolean', default: false },
    claude: { type: 'string', default: 'claude' },
    'no-map-mcp': { type: 'boolean', default: false },
    'no-agent-search': { type: 'boolean', default: false },
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
  root = realpathSync.native(projectArg);
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
const token = values['token-stdin'] ? readFileSync(0, 'utf8').trim() || randomBytes(24).toString('base64url') : takeLaunchToken(process.env, () => randomBytes(24).toString('base64url'));
const recent = new RecentProjects(home);
recent.add(root);

try {
  const store = openStore(projectDir(home, root));
  const policy = new PolicyStore({ home, root });
  const terminals = new TerminalService({ root });
  let server: RunningServer | undefined;
  let snapshot: MapSnapshot | undefined;
  let session: AgentSession | undefined;
  let indexer: Indexer | undefined;
  const models = createModelProvider(home);
  const rt = createExecutionRuntime({
    root, home, store,
    policy: () => policy.effective(),
    components: () => (snapshot?.components ?? []).map(({ id, name, files, globs }) => ({ id, name, files, globs })),
    map: values['no-map-mcp'] ? undefined : () => snapshot ?? null,
    search: values['no-agent-search']
      ? undefined
      : async (query, limit) => (mapService ? mapService.search(query, limit) : { ok: false, error: 'The project map is not ready yet.' }),
    port: () => {
      if (!server) throw new Error('the IDE core is not listening yet');
      return server.port;
    },
    shadowDir: join(projectDir(home, root), 'shadow.git'),
    provider: models,
    files: () => indexer?.files() ?? [],
    notice: (text) => (session ? session.notice(text) : console.warn(text)),
  });
  const registry = new McpRegistry({
    home, root, builtins: () => ({ idecore: rt.gate.mcpEntry() }),
    expectWrite: (rel, hash) => rt.ideWrites.expect(rel, hash),
  });
  const agent = new AgentSession({
    root, home, store,
    claude: { command: values.claude, args: [] },
    mcpServers: () => registry.sessionServers(),
    gate: rt.sessionGate,
    canLeave: () => rt.canLeave(),
  });
  session = agent;
  rt.attach(agent);
  await agent.start();
  try {
    await rt.start();
  } catch (error) {
    agent.notice(`The IDE could not start watching the project files (${(error as Error).message}), so the agent will not start.`);
  }

  const settingsSnapshot = (): ServerMessage => ({ type: 'settings.snapshot', settings: { ...registry.view(), policy: policy.view() } });
  const plansSnapshot = (): ServerMessage => ({ type: 'plans.snapshot', plans: rt.gate.plans.plans() });
  const gateSnapshot = (): ServerMessage => ({ type: 'gate.snapshot', prompts: rt.gate.gate.pending() });
  const sessionsSnapshot = (): ServerMessage => ({ type: 'sessions.snapshot', ...agent.listChats() });
  const broadcastSessions = (): void => {
    try {
      server?.broadcast(sessionsSnapshot());
    } catch (error) {
      console.error('IDE core: could not list the chats', error);
    }
  };

  const changeSettings = (message: SettingsClientMessage): void => {
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
      case 'policy.save':
        policy.save(message.level, message.policy);
        return;
      case 'policy.confirm-external-edits':
        policy.confirmExternalEdits(message.hashes);
        return;
    }
  };

  let closing: Promise<void> | undefined;
  let afterClose: (() => Promise<void>) | undefined;
  let mapService: MapService | undefined;
  let classifier: IdentifierClassifier | undefined;
  let deployWatch: { close(): Promise<void> } | undefined;
  const progress = new ProgressReporter((current) => server?.broadcast({ type: 'map.progress', progress: current }));

  let modelList: Promise<ModelInfo[]> | undefined;
  const modelCatalog = (): Promise<ModelInfo[]> => {
    modelList ??= fetchModels({ command: values.claude, args: [] }, root).then((list) => {
      if (list.length === 0) modelList = undefined;
      return list;
    });
    return modelList;
  };

  const handle = async (message: ClientMessage, reply: (message: ServerMessage) => void): Promise<void> => {
    switch (message.type) {
      case 'chat.send':
        agent.send(message.text, { images: message.images });
        broadcastSessions();
        return;
      case 'chat.stop':
        agent.stop();
        return;
      case 'task.stop':
        agent.stopTask(message.id);
        return;
      case 'session.restart':
        await agent.restart();
        return;
      case 'map.regroup':
        void mapService?.regroup();
        return;
      case 'session.new':
        await agent.newSession();
        return;
      case 'session.list':
        reply(sessionsSnapshot());
        return;
      case 'models.list':
        reply({ type: 'models.snapshot', models: await modelCatalog() });
        return;
      case 'session.switch':
        await agent.switchSession(message.id);
        return;
      case 'session.rename':
        agent.renameSession(message.id, message.title);
        return;
      case 'session.delete':
        await agent.deleteSession(message.id);
        broadcastSessions();
        return;
      case 'session.delete-all':
        await agent.deleteAllSessions();
        broadcastSessions();
        return;
      case 'session.configure':
        await agent.configure(message.modelChoice, message.effort);
        broadcastSessions();
        return;
      case 'prompt.answer':
        agent.answerPrompt(message.requestId, message.answer);
        return;
      case 'plan.answer':
        rt.gate.plans.answer(message.planId, message.version, message.answer);
        return;
      case 'gate.answer':
        rt.gate.gate.answer(message.promptId, message.answer);
        return;
      case 'settings.get':
        reply(settingsSnapshot());
        return;
      case 'terminal.open':
        terminals.open(message.id, message.cols, message.rows);
        return;
      case 'terminal.input':
        terminals.input(message.id, message.data);
        return;
      case 'terminal.resize':
        terminals.resize(message.id, message.cols, message.rows);
        return;
      case 'terminal.close':
        terminals.close(message.id);
        return;
      case 'fs.list':
        reply({ type: 'fs.list.result', requestId: message.requestId, ...listDirectories(message.path, homedir()) });
        return;
      case 'project.open': {
        const target = validateProjectPath(message.path);
        let error = 'error' in target ? target.error : target.root === root ? 'That project is already open.' : null;
        if (error === null && !('error' in target)) {
          const probe = acquireCoreLock(projectDir(home, target.root));
          if (probe.acquired) probe.release();
          else error = `That project is already open in another IDE core (pid ${probe.holder}).`;
        }
        reply({ type: 'project.open.result', requestId: message.requestId, error });
        if (error !== null || 'error' in target) return;
        recent.add(target.root);
        const args = successorArgs(process.argv.slice(2), target.root, running.port);
        afterClose = async () => {
          const child = spawn(process.execPath, [...process.execArgv, process.argv[1] ?? '', ...args, '--token-stdin'], {
            detached: true,
            stdio: ['pipe', 'inherit', 'inherit'],
          });
          await new Promise<void>((resolve) => child.stdin.end(token, () => resolve()));
          child.unref();
        };
        closing ??= shutdown();
        return;
      }
      default:
        await routeClientMessage(message, {
          history: (history) => rt.history.handle(history, reply),
          settings: (settings) => {
            let error: string | null = null;
            try {
              changeSettings(settings);
            } catch (failure) {
              error = (failure as Error).message;
            }
            reply({ type: 'settings.result', requestId: settings.requestId, error });
            server?.broadcast(settingsSnapshot());
          },
          unknown: (type) => reply({ type: 'error', message: `Unknown message type "${type}".` }),
        });
    }
  };

  const running = await startServer({
    port,
    token,
    staticDir: values.ui ? resolve(values.ui) : undefined,
    allowedOrigins: values['allow-origin'],
    snapshot: () => snapshot ?? null,
    routes: rt.gate.routes,
    greeting: () => [
      { type: 'project.info', info: { root, name: projectName, home: homedir(), recent: recent.list() } },
      { type: 'map.progress', progress: progress.get() },
      { type: 'session.snapshot', state: agent.state() },
      sessionsSnapshot(),
      plansSnapshot(),
      gateSnapshot(),
      settingsSnapshot(),
      { type: 'history.snapshot', history: rt.history.snapshot() },
      { type: 'terminal.snapshot', terminals: terminals.snapshot() },
    ],
    onClientMessage: (message, reply) => {
      if (closing) {
        reply({ type: 'error', message: 'The IDE core is shutting down.' });
        return;
      }
      handle(message, reply).catch((error: unknown) => reply({ type: 'error', message: (error as Error).message }));
    },
  });
  server = running;
  agent.onMessage((message) => {
    running.broadcast(message);
    if (message.type !== 'session.snapshot') return;
    running.broadcast(plansSnapshot());
    broadcastSessions();
  });
  agent.onTurnClosed(broadcastSessions);
  agent.onTitleChanged(broadcastSessions);
  agent.onProcessExit(broadcastSessions);
  rt.gate.plans.onChange((plans) => running.broadcast({ type: 'plans.snapshot', plans }));
  rt.gate.gate.onChange((prompts) => running.broadcast({ type: 'gate.snapshot', prompts }));
  rt.history.onPatch((patch) => running.broadcast({ type: 'history.patch', patch }));
  rt.history.onReset(() => running.broadcast({ type: 'history.snapshot', history: rt.history.snapshot() }));
  terminals.onMessage((message) => running.broadcast(message));

  const shutdown = async (): Promise<void> => {
    const closingTerminals = terminals.closeAll();
    // rt.close() stops the attached agent before the watcher, so the agent's last writes are still judged.
    await rt.close();
    progress.stop();
    classifier?.stop();
    await deployWatch?.close();
    const stopping = mapService?.stop();
    await models.close();
    await stopping;
    await indexer?.stop();
    await closingTerminals;
    await running.close();
    store.close();
    lock.release();
    await afterClose?.();
    process.exit(0);
  };
  let firstInterrupt = 0;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      if (signal === 'SIGINT') {
        if (firstInterrupt && Date.now() - firstInterrupt > 1000) process.exit(130);
        firstInterrupt ||= Date.now();
      }
      closing ??= shutdown();
    });
  }

  console.log(`IDE core: ${root}`);
  console.log(`  agent: ${values.claude} · control mode ${policy.effective().mode} · IDE home: ${home}`);
  if (values.ui) console.log(`  open: http://127.0.0.1:${running.port}/#token=${token}`);
  for (const origin of values['allow-origin']) console.log(`  dev UI: ${origin}/#token=${token}`);

  progress.set({ indexing: { indexed: 0 } });
  const adapters = await Promise.all([createTypeScriptAdapter(root), createPythonAdapter()]);
  const index = new Indexer({ root, adapters, onProgress: (indexed) => progress.set({ indexing: { indexed } }) });
  indexer = index;
  await index.start();
  progress.set({ indexing: null });
  await removeStaleModelDirs(runDir(home));

  // A shutdown that began while indexing must not start the map service, whose model calls it could no longer stop.
  if (!closing) {
    let files = index.files();
    let edges = computeFileEdges(files, adapters);
    let unresolved = unresolvedImports(files, adapters);
    let version = 0;
    const names = new IdentifierClassifier({
      model: models.fast,
      cachePath: join(home, 'c4-classification.json'),
      onChange: () => {
        if (snapshot) publish();
      },
    });
    classifier = names;
    const service = new MapService({
      root,
      projectName,
      stateDir: projectDir(home, root),
      reasoning: models.reasoning,
      embed: models.embed,
      isAgentIdle: () => agent.isIdle(),
      expectWrite: (rel, hash) => rt.ideWrites.expect(rel, hash),
      onChange: () => publish(),
      onEmbeddingProgress: (embedding) => progress.set({ embedding }),
    });
    mapService = service;
    agent.onIdle(() => service.onAgentIdle());
    function publish(): MapSnapshot {
      version += 1;
      const view = service.view();
      const c4 = buildC4(root, files, edges, view.components, unresolved, names.lookup);
      names.request(c4.pending);
      const status = names.status();
      if (status.waiting > 0) c4.model.warnings.push(`Classifying ${status.waiting} package, image and host names with Haiku (names only)`);
      if (status.failure) c4.model.warnings.push(`Could not classify names: ${status.failure}`);
      snapshot = { ...buildSnapshot(version, projectName, files, edges, view), c4: c4.model };
      running.broadcast({ type: 'map.snapshot', snapshot });
      return snapshot;
    }
    index.onChange(() => {
      files = index.files();
      edges = computeFileEdges(files, adapters);
      unresolved = unresolvedImports(files, adapters);
      service.update(files, edges);
      if (snapshot) publish();
    });
    deployWatch = watchDeploy(root, () => {
      if (snapshot) publish();
    });
    await service.start(files, edges);
    if (!closing) {
      const initial = publish();
      console.log(`  ${initial.files.length} files, ${initial.components.length} components (${initial.status.layer} map)`);
    }
  }
} catch (error) {
  lock.release();
  console.error(`IDE core failed to start: ${(error as Error).message}`);
  process.exit(1);
}
