import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, autoUpdater as nativeUpdater, BrowserWindow, dialog, Menu, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { keepRoomForTrafficLights } from './chrome-insets.mjs';
import { createStopper } from './stop-children.mjs';
import { createUpdater } from './updater.mjs';

// The OS hands out a free port; a fixed one would collide with a running dev:core / dev:ui.
const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
// The built app serves its UI from the hub; the dev shell runs a vite dev server for it.
const packaged = app.isPackaged;
const UI_PORT = packaged ? null : await freePort();
const CORE_PORT = await freePort();
const UI_ORIGIN = packaged ? `http://127.0.0.1:${CORE_PORT}` : `http://localhost:${UI_PORT}`;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// The built app gets its arguments right after the executable; `electron main.mjs` puts the script in between.
const arg = process.argv.slice(packaged ? 1 : 2).find((a) => !a.startsWith('-'));
// pnpm runs the script from packages/desktop; INIT_CWD is where the user typed the command.
const project = arg ? resolve(process.env.INIT_CWD ?? process.cwd(), arg) : null;
const token = randomBytes(24).toString('base64url');

const children = [];
const run = (command, args, { env = {}, ...options }) => {
  // Own process group, so that killing -pid takes the whole tree (pnpm/node --watch/vite workers) with it.
  const child = spawn(command, args, { stdio: 'inherit', detached: true, ...options, env: { ...process.env, ...env } });
  children.push(child);
  return child;
};

function startDevStack() {
  // The hub runs one core per open project; a core edit restarts the hub, which brings the open projects back.
  run('node', ['--watch', '--import', 'tsx', 'packages/core/src/main.ts', '--hub', ...(project ? ['--project', project] : []), '--port', String(CORE_PORT), '--allow-origin', UI_ORIGIN], {
    cwd: repo,
    env: { IDE_CORE_TOKEN: token, IDE_AUTO_RESUME: '1' },
  });
  run('./node_modules/.bin/vite', ['--port', String(UI_PORT)], { cwd: resolve(repo, 'packages/ui'), env: { IDE_CORE_PORT: String(CORE_PORT) } });
  return Promise.all([waitForPort(CORE_PORT), waitForPort(UI_PORT)]);
}

const START_DEADLINE_MS = 60_000;
const LOG_PATH = packaged ? join(app.getPath('logs'), 'core.log') : null;

// The app runs the core bundle on its own binary as Node (see node-exec.ts in the core). The token goes over stdin,
// which the hub keeps watching: when the app dies, even by SIGKILL, the hub and its cores stop.
function startAppStack() {
  const resources = process.resourcesPath;
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  const log = openSync(LOG_PATH, 'a');
  const shellPath = loginShellPath();
  if (!shellPath) writeSync(log, `CodeRay: could not read PATH from the login shell ${process.env.SHELL}; claude and git must be on ${process.env.PATH}\n`);
  const hub = run(process.execPath, [
    join(resources, 'core/dist/bin/main.mjs'), '--hub', ...(project ? ['--project', project] : []),
    '--ui', join(resources, 'ui'), '--port', String(CORE_PORT), '--token-stdin', '--exit-with-parent',
  ], {
    stdio: ['pipe', log, log],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      IDE_NODE: join(resources, 'bin/ide-node'),
      PATH: shellPath ?? process.env.PATH,
      // Finder gives no locale; without one terminals and the agent's tools fall back to C and garble non-ASCII text.
      LANG: process.env.LANG || 'en_US.UTF-8',
    },
  });
  // Writing to a hub that already died must not crash the app; its exit is reported below.
  hub.stdin.on('error', () => {});
  hub.stdin.write(`${token}\n`);
  const fail = (reason) => Promise.reject(new Error(reason));
  return Promise.race([
    waitForPort(CORE_PORT),
    new Promise((done) => hub.once('exit', (code, signal) => done(`the core exited (${signal ?? `code ${code}`})`))).then(fail),
    new Promise((done) => setTimeout(done, START_DEADLINE_MS, `the core did not start within ${START_DEADLINE_MS / 1000} s`)).then(fail),
  ]);
}

// Started from Finder the app gets launchd's short PATH; claude, git and the user's tools are on the login shell's.
function loginShellPath() {
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "%s%s%s" __IDE_PATH__ "$PATH" __IDE_PATH__'], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /__IDE_PATH__(.*)__IDE_PATH__/s.exec(out)?.[1] || null;
  } catch {
    return null;
  }
}

const stopper = createStopper({
  pids: () => children.map(({ pid }) => pid),
  // A project switch makes core spawn a detached successor outside our groups; it is the one left on the port.
  portOwners: () => {
    try {
      return execFileSync('lsof', ['-ti', `tcp:${CORE_PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
    } catch {
      return [];
    }
  },
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
});

// vite binds ::1 only, core 127.0.0.1: 'localhost' is the one name that reaches both.
const listening = (port) =>
  new Promise((done) => {
    const socket = connect(port, 'localhost');
    socket.once('connect', () => (socket.destroy(), done(true)));
    socket.once('error', () => done(false));
  });
async function waitForPort(port) {
  while (!(await listening(port))) await new Promise((r) => setTimeout(r, 200));
}

// A second launch of the built app would start a second hub on the same projects; it focuses the first window instead.
if (packaged && !app.requestSingleInstanceLock()) app.exit(0);

// Quitting waits for the children to stop. An installing update quits through its own path and only signals them.
let quitting = false;
let installingUpdate = false;
nativeUpdater.on('before-quit-for-update', () => {
  installingUpdate = true;
  stopper.signal();
});
app.on('before-quit', (event) => {
  if (quitting || installingUpdate) return;
  quitting = true;
  event.preventDefault();
  stopper.stop().then(() => app.exit(0));
});
process.on('exit', () => stopper.signal());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => app.quit());
// As in any Mac app, closing the last window leaves CodeRay and its agents running; Cmd+Q quits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Awaiting ready at top level deadlocks Electron's ESM entry: the app only becomes ready after the module finishes.
app.whenReady().then(async () => {
  // The built app takes its icon from the bundle; the dev shell is plain Electron.
  if (!packaged) app.dock?.setIcon(join(dirname(fileURLToPath(import.meta.url)), 'build/icon.png'));
  try {
    await (packaged ? startAppStack() : startDevStack());
  } catch (error) {
    dialog.showErrorBox('CodeRay could not start', `${error.message}.${LOG_PATH ? ` The log is ${LOG_PATH}.` : ''}`);
    app.quit();
    return;
  }

  const updater = packaged ? createUpdater({
    autoUpdater: electronUpdater.autoUpdater,
    dialog,
    getWindow: () => BrowserWindow.getAllWindows()[0],
    version: app.getVersion(),
    log: (line) => {
      try {
        appendFileSync(join(app.getPath('logs'), 'update.log'), `${new Date().toISOString()} ${line}\n`);
      } catch {}
    },
    onChange: () => setMenu(),
  }) : null;
  // The default menu binds Cmd+W to "Close Window"; CodeRay needs that key to close a project.
  const setMenu = () => Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        ...(updater ? [{ type: 'separator' }, updater.menuItem()] : []),
        { type: 'separator' }, { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W', role: 'close' }] },
  ]));
  setMenu();
  const createWindow = () => {
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      // Like PyCharm: the traffic lights sit inside the app's own top bar instead of a separate title bar.
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 14, y: 13 },
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    win.webContents.on('dom-ready', () => {
      win.webContents.insertCSS(`
        header.topbar { -webkit-app-region: drag; }
        header.topbar :is(button, select, input, label, a, [role='tab']) { -webkit-app-region: no-drag; }
      `);
    });
    keepRoomForTrafficLights(win);
    const external = (url) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
    };
    win.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin === UI_ORIGIN) return;
      event.preventDefault();
      external(url);
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      external(url);
      return { action: 'deny' };
    });
    win.loadURL(`${UI_ORIGIN}/#token=${token}`);
  };
  createWindow();
  updater?.start();
  // Clicking the Dock icon after the window was closed brings it back.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
});
