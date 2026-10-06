import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_TERMINAL_ID, type ClientMessage, type MapSnapshot, type ModelInfo, type ServerMessage } from '@ide/protocol';
import { AccountLogin } from './accounts/account-login';
import { AccountStore } from './accounts/account-store';
import { AgentSession } from './agent/agent-session';
import { createExecutionRuntime } from './execution/runtime';
import { GitService } from './git/git-service';
import { computeFileEdges, unresolvedImports } from './graph/edges';
import { defaultIdeHome, projectDir, runDir } from './home';
import { startHub, type RunningHub } from './hub/hub';
import { followParent } from './hub/parent';
import { Indexer } from './indexer/indexer';
import { createCAdapter, createCppAdapter } from './lang/c-family';
import { createCSharpAdapter } from './lang/csharp';
import { createPythonAdapter } from './lang/python';
import { createSwiftAdapter } from './lang/swift';
import { createTypeScriptAdapter } from './lang/typescript';
import { acquireCoreLock } from './lock';
import { descendants, isAlive, signal as sendSignal } from './os-process';
import { MapService } from './map/map-service';
import { buildSnapshot } from './map/snapshot';
import { IdentifierClassifier } from './c4/classify';
import { watchDeploy } from './c4/deploy';
import { buildC4 } from './c4/model';
import { claudeJsonPath } from './mcp/claude-code';
import { McpRegistry } from './mcp/registry';
import { fetchModels } from './models/catalog';
import { removeStaleModelDirs } from './models/claude-cli';
import { createModelProvider } from './models/provider';
import { PolicyStore } from './policy/policy';
import { listDirectories } from './project/browse';
import { spawnSuccessor } from './project/handover';
import { startLauncher, type RunningLauncher } from './project/launcher';
import { RecentProjects } from './project/recent';
import { takeLaunchToken } from './project/token';
import { projectBusy, successorArgs, validateProjectPath } from './project/switch';
import { ProgressReporter } from './progress';
import { routeClientMessage, type SettingsClientMessage } from './server/router';
import { startServer, type RunningServer } from './server/server';
import { openStore } from './store/store';
import { TerminalService } from './terminal/terminal-service';

const { values } = parseArgs({
  options: {
    project: { type: 'string', multiple: true, default: [] },
    port: { type: 'string', default: '4317' },
    ui: { type: 'string' },
    'allow-origin': { type: 'string', multiple: true, default: [] },
    'ide-home': { type: 'string' },
    'token-stdin': { type: 'boolean', default: false },
    claude: { type: 'string', default: 'claude' },
    'no-map-mcp': { type: 'boolean', default: false },
    'no-agent-search': { type: 'boolean', default: false },
    hub: { type: 'boolean', default: false },
    'exit-with-parent': { type: 'boolean', default: false },
  },
});
const exitWithParent = values['exit-with-parent'];
const HUB_OWNS_PROJECTS = 'This core runs inside the IDE hub: open and close projects through the hub.';
const PARENT_GONE_DEADLINE_MS = 10_000;
const SHUTDOWN_DEADLINE_MS = 30_000;

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`IDE core: invalid --port "${values.port}"`);
  process.exit(1);
}

const home = resolve(values['ide-home'] ?? defaultIdeHome());
if (exitWithParent) {
  // Once the hub is gone its ends of stdout and stderr are closed too; a log line must not crash the shutdown.
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
}
// Set once project mode can shut down in order; before that a vanished hub means a plain exit.
let stopForParent: (() => void) | undefined;
const leaveWithParent = (): void => {
  // With the hub gone nobody sweeps what this core started and its own shutdown leaves behind (an agent's background jobs).
  const tree = descendants(process.pid);
  process.once('exit', () => {
    for (const pid of tree) if (isAlive(pid)) sendSignal(pid, 'SIGKILL');
  });
  // process.exit, unlike a signal, runs the 'exit' handlers: this sweep and the lock release.
  if (!stopForParent) process.exit(1);
  setTimeout(() => process.exit(1), PARENT_GONE_DEADLINE_MS).unref();
  stopForParent();
};
const stdinToken = exitWithParent ? await followParent(process.stdin, leaveWithParent) : values['token-stdin'] ? readFileSync(0, 'utf8').trim() : '';
const token = values['token-stdin'] ? stdinToken || randomBytes(24).toString('base64url') : takeLaunchToken(process.env, () => randomBytes(24).toString('base64url'));

if (values.hub) {
  let hub: RunningHub;
  try {
    hub = await startHub({
      port,
      token,
      staticDir: values.ui ? resolve(values.ui) : undefined,
      allowedOrigins: values['allow-origin'],
      home,
      projects: values.project.map((path) => resolve(path)),
      child: { claude: values.claude, noMapMcp: values['no-map-mcp'], noAgentSearch: values['no-agent-search'] },
    });
  } catch (error) {
    console.error(`IDE core failed to start: ${(error as Error).message}`);
    process.exit(1);
  }
  console.log(`IDE core: hub · IDE home: ${home}`);
  if (values.ui) console.log(`  open: http://127.0.0.1:${hub.port}/#token=${token}`);
  for (const origin of values['allow-origin']) console.log(`  dev UI: ${origin}/#token=${token}`);
  await new Promise<void>((resolveStop) => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void hub.close().then(resolveStop));
  });
  process.exit(0);
}

if (values.project.length === 0) {
  let launcher: RunningLauncher;
  try {
    launcher = await startLauncher({
      port,
      token,
      staticDir: values.ui ? resolve(values.ui) : undefined,
      allowedOrigins: values['allow-origin'],
      home,
      handover: (root, boundPort) => spawnSuccessor(successorArgs(process.argv.slice(2), root, boundPort), token),
    });
  } catch (error) {
    console.error(`IDE core failed to start: ${(error as Error).message}`);
    process.exit(1);
  }
  console.log('IDE core: no project open');
  if (values.ui) console.log(`  open: http://127.0.0.1:${launcher.port}/#token=${token}`);
  for (const origin of values['allow-origin']) console.log(`  dev UI: ${origin}/#token=${token}`);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void launcher.close());
  try {
    await launcher.finished;
  } catch (error) {
    console.error(`IDE core could not open the project: ${(error as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
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

const lock = acquireCoreLock(projectDir(home, root));
if (!lock.acquired) {
  console.error(`IDE core: another IDE core (pid ${lock.holder}) is already running for ${root}.`);
  console.error(`  Stop it first, or delete ${lock.path} if that process is not an IDE core.`);
  process.exit(1);
}
// An exit that skips the shutdown (the hub vanishing during startup, a second Ctrl+C) must not leave the lock behind.
process.once('exit', () => lock.release());
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
  const accounts = new AccountStore({ home, claude: values.claude });
  const login = new AccountLogin({
    accounts, claude: values.claude,
    onChange: () => {
      try {
        server?.broadcast(settingsSnapshot());
      } catch (error) {
        console.error('IDE core: could not send the settings', error);
      }
    },
  });
  const models = createModelProvider(home, () => accounts.claudeEnv());
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
  const git = new GitService({ root, ideWrites: rt.ideWrites, agentBusy: () => rt.agentBusy() });
  const registry = new McpRegistry({
    home, root, builtins: () => ({ idecore: rt.gate.mcpEntry() }),
    expectWrite: (rel, hash) => rt.ideWrites.expect(rel, hash),
    claudeJsonPath: () => claudeJsonPath(accounts.configDir(accounts.activeId())),
  });
  const agent = new AgentSession({
    root, home, store,
    claude: { command: values.claude, args: [] },
    accounts,
    mcpServers: () => registry.sessionServers(),
    gate: rt.sessionGate,
    canLeave: () => rt.canLeave(),
    terminalInput: (data) => terminals.input(AGENT_TERMINAL_ID, data),
  });
  session = agent;
  rt.attach(agent);
  // A closed agent terminal ends its terminal mode once claude is gone, so the chat never runs a second claude beside it.
  terminals.onMessage((message) => {
    if (message.type === 'terminal.exit' && message.id === AGENT_TERMINAL_ID) agent.terminalClosed();
  });
  await agent.start();
  // Checking a large project's files takes a while: the core listens meanwhile. What starts the agent or changes the current chat
  // waits for it, because the check records what it finds into the chat that is current when it ends.
  let watched = false;
  const watching = (async (): Promise<void> => {
    try {
      await rt.start();
      // The dev shell reloads the core on every code edit, which kills the agent that made the edit.
      if (process.env.IDE_AUTO_RESUME === '1' && agent.startedFromCrash()) {
        try {
          agent.send('[IDE] The IDE core restarted to load new code and your process ended with it. Continue where you stopped.', { fromUser: false });
        } catch (error) {
          agent.notice(`The agent could not be resumed after the reload (${(error as Error).message}).`);
        }
      }
    } catch (error) {
      agent.notice(`The IDE could not start watching the project files (${(error as Error).message}), so the agent will not start.`);
    } finally {
      watched = true;
    }
  })();

  const settingsSnapshot = (): ServerMessage => ({
    type: 'settings.snapshot',
    settings: { ...registry.view(), policy: policy.view(), accounts: { ...accounts.list(), login: login.view() } },
  });
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

  const changeSettings = async (message: SettingsClientMessage): Promise<void> => {
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
      case 'account.login.start':
        login.start();
        return;
      case 'account.login.code':
        login.submitCode(message.code);
        return;
      case 'account.login.cancel':
        login.cancel();
        return;
      case 'account.select':
        await agent.changeAccount(() => accounts.setActive(message.id));
        modelList = undefined;
        return;
      case 'account.remove':
        await agent.changeAccount(() => accounts.remove(message.id));
        modelList = undefined;
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
    modelList ??= fetchModels({ command: values.claude, args: [], env: accounts.claudeEnv() }, root).then((list) => {
      if (list.length === 0) modelList = undefined;
      return list;
    });
    return modelList;
  };

  const handle = async (message: ClientMessage, reply: (message: ServerMessage) => void): Promise<void> => {
    switch (message.type) {
      case 'chat.send':
        if (!watched) agent.notice('Checking the project files first; the agent starts when that is done.');
        await watching;
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
        await watching;
        await agent.newSession();
        return;
      case 'session.list':
        reply(sessionsSnapshot());
        return;
      case 'models.list':
        reply({ type: 'models.snapshot', models: await modelCatalog() });
        return;
      case 'session.switch':
        await watching;
        await agent.switchSession(message.id);
        return;
      case 'session.rename':
        agent.renameSession(message.id, message.title);
        return;
      case 'session.delete':
        await watching;
        await agent.deleteSession(message.id);
        broadcastSessions();
        return;
      case 'session.delete-all':
        await watching;
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
        if (message.kind === 'agent') {
          await watching;
          const launch = await agent.terminalLaunch();
          if (!launch) return;
          try {
            terminals.open(AGENT_TERMINAL_ID, message.cols, message.rows, launch);
          } catch (error) {
            agent.terminalClosed();
            throw error;
          }
          return;
        }
        terminals.open(message.id, message.cols, message.rows);
        return;
      case 'terminal.input':
        if (message.id === AGENT_TERMINAL_ID) agent.terminalTyped(message.data);
        terminals.input(message.id, message.data);
        return;
      case 'terminal.resize':
        terminals.resize(message.id, message.cols, message.rows);
        return;
      case 'terminal.close':
        if (message.id !== AGENT_TERMINAL_ID) {
          void terminals.close(message.id);
          return;
        }
        await terminals.close(message.id);
        agent.terminalClosed();
        return;
      case 'fs.list':
        reply({ type: 'fs.list.result', requestId: message.requestId, ...listDirectories(message.path, homedir()) });
        return;
      case 'project.open': {
        if (exitWithParent) {
          reply({ type: 'project.open.result', requestId: message.requestId, error: HUB_OWNS_PROJECTS });
          return;
        }
        const target = validateProjectPath(message.path);
        let error = 'error' in target ? target.error : target.root === root ? 'That project is already open.' : null;
        if (error === null && !('error' in target)) error = projectBusy(home, target.root);
        reply({ type: 'project.open.result', requestId: message.requestId, error });
        if (error !== null || 'error' in target) return;
        recent.add(target.root);
        const args = successorArgs(process.argv.slice(2), target.root, running.port);
        afterClose = () => spawnSuccessor(args, token);
        closing ??= shutdown();
        return;
      }
      case 'project.close': {
        if (exitWithParent) {
          reply({ type: 'project.close.result', requestId: message.requestId, error: HUB_OWNS_PROJECTS });
          return;
        }
        reply({ type: 'project.close.result', requestId: message.requestId, error: null });
        const args = successorArgs(process.argv.slice(2), null, running.port);
        afterClose = () => spawnSuccessor(args, token);
        closing ??= shutdown();
        return;
      }
      default:
        await routeClientMessage(message, {
          history: (history) => rt.history.handle(history, reply),
          git: (message) => git.handle(message, reply),
          settings: async (settings) => {
            let error: string | null = null;
            try {
              await changeSettings(settings);
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

  const gitGreeting = (): ServerMessage[] => {
    const status = git.snapshot();
    return status ? [{ type: 'git.snapshot', status }] : [];
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
      ...gitGreeting(),
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
    git.checkBusy();
    if (message.type !== 'session.snapshot') return;
    git.poke();
    running.broadcast(plansSnapshot());
    broadcastSessions();
  });
  agent.onTurnClosed(() => {
    broadcastSessions();
    git.checkBusy();
  });
  agent.onTitleChanged(broadcastSessions);
  agent.onProcessExit(broadcastSessions);
  rt.gate.plans.onChange((plans) => {
    running.broadcast({ type: 'plans.snapshot', plans });
    git.poke();
  });
  rt.gate.gate.onChange((prompts) => running.broadcast({ type: 'gate.snapshot', prompts }));
  rt.history.onPatch((patch) => running.broadcast({ type: 'history.patch', patch }));
  rt.history.onReset(() => running.broadcast({ type: 'history.snapshot', history: rt.history.snapshot() }));
  terminals.onMessage((message) => running.broadcast(message));
  git.onStatus((status) => running.broadcast({ type: 'git.snapshot', status }));
  git.start();

  const shutdown = async (): Promise<void> => {
    // Every step has its own limit, yet one that never settles must not keep a stopped core alive.
    let step = 'the agent terminal';
    setTimeout(() => {
      console.error(`IDE core: the shutdown is stuck at ${step}; exiting anyway.`);
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS).unref();
    login.cancel();
    // The agent, in the chat or in its terminal, stops before the watcher, so its last writes are still judged.
    await terminals.close(AGENT_TERMINAL_ID);
    agent.terminalClosed();
    const closingTerminals = terminals.closeAll();
    step = 'the agent and the watcher';
    await rt.close();
    await git.close();
    progress.stop();
    classifier?.stop();
    step = 'the deploy watch';
    await deployWatch?.close();
    const stopping = mapService?.stop();
    step = 'the models';
    await models.close();
    step = 'the map';
    await stopping;
    step = 'the indexer';
    await indexer?.stop();
    step = 'the terminals';
    await closingTerminals;
    step = 'the server';
    await running.close();
    step = 'the successor';
    store.close();
    lock.release();
    await afterClose?.();
    process.exit(0);
  };
  const stop = (): void => {
    // A stop request during a project switch or close means the user wants out: no successor must outlive it.
    afterClose = undefined;
    closing ??= shutdown();
  };
  let firstInterrupt = 0;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      if (signal === 'SIGINT') {
        if (firstInterrupt && Date.now() - firstInterrupt > 1000) process.exit(130);
        firstInterrupt ||= Date.now();
      }
      stop();
    });
  }
  stopForParent = stop;

  console.log(`IDE core: ${root}`);
  console.log(`  agent: ${values.claude} · control mode ${policy.effective().mode} · IDE home: ${home}`);
  // Under the hub these addresses would carry this core's token next to the hub's origin; the hub hands them to the UI instead.
  if (!exitWithParent) {
    if (values.ui) console.log(`  open: http://127.0.0.1:${running.port}/#token=${token}`);
    for (const origin of values['allow-origin']) console.log(`  dev UI: ${origin}/#token=${token}`);
  }

  progress.set({ indexing: { indexed: 0 } });
  const adapters = await Promise.all([
    createTypeScriptAdapter(root),
    createPythonAdapter(),
    createCAdapter(),
    createCppAdapter(),
    createCSharpAdapter(),
    createSwiftAdapter(),
  ]);
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
