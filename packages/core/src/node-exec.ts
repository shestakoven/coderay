// The packaged app runs the core on its Electron binary, which acts as Node only under ELECTRON_RUN_AS_NODE; IDE_NODE names
// the app's launcher that sets the variable for one process. The core takes both out of the environment the agent, terminals
// and MCP servers inherit, where an Electron app would start as Node and a dev core would run its hooks on this app, and
// hands the launcher only to Node processes of its own: its hooks and the cores it starts.
export const NODE_LAUNCHER_ENV = 'IDE_NODE';
const ELECTRON_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';

let launcher = '';

export function takeNodeLauncher(env: NodeJS.ProcessEnv = process.env): void {
  launcher = env[NODE_LAUNCHER_ENV] || '';
  delete env[NODE_LAUNCHER_ENV];
  delete env[ELECTRON_AS_NODE_ENV];
}

export function nodeExecutable(): string {
  return launcher || process.execPath;
}

// A core the core starts needs the launcher for its own hooks and cores.
export function coreEnv(): NodeJS.ProcessEnv {
  return launcher ? { ...process.env, [NODE_LAUNCHER_ENV]: launcher } : process.env;
}
