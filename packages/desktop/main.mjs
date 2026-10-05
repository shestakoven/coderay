import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect, createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, shell } from 'electron';

// The OS hands out a free port; a fixed one would collide with a running dev:core / dev:ui.
const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
const UI_PORT = await freePort();
const CORE_PORT = await freePort();
const UI_ORIGIN = `http://localhost:${UI_PORT}`;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
// pnpm runs the script from packages/desktop; INIT_CWD is where the user typed the command.
const project = arg ? resolve(process.env.INIT_CWD ?? process.cwd(), arg) : null;
const token = randomBytes(24).toString('base64url');

const children = [];
const run = (command, args, cwd, env = {}) => {
  // Own process group, so that killing -pid takes the whole tree (pnpm/node --watch/vite workers) with it.
  const child = spawn(command, args, { cwd, stdio: 'inherit', detached: true, env: { ...process.env, ...env } });
  children.push(child);
  return child;
};

let stopped = false;
function stopChildren() {
  if (stopped) return;
  stopped = true;
  for (const { pid } of children) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {}
  }
  // A project switch makes core spawn a detached successor outside our groups; it is the one left on the port.
  try {
    const pids = execFileSync('lsof', ['-ti', `tcp:${CORE_PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const pid of pids) process.kill(Number(pid), 'SIGTERM');
  } catch {}
}

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

app.on('before-quit', stopChildren);
process.on('exit', stopChildren);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => app.quit());
app.on('window-all-closed', () => app.quit());

// Awaiting ready at top level deadlocks Electron's ESM entry: the app only becomes ready after the module finishes.
app.whenReady().then(async () => {
  // The hub runs one core per open project; a core edit restarts the hub, which brings the open projects back.
  run('node', ['--watch', '--import', 'tsx', 'packages/core/src/main.ts', '--hub', ...(project ? ['--project', project] : []), '--port', String(CORE_PORT), '--allow-origin', UI_ORIGIN], repo, {
    IDE_CORE_TOKEN: token,
    IDE_AUTO_RESUME: '1',
  });
  run('./node_modules/.bin/vite', ['--port', String(UI_PORT)], resolve(repo, 'packages/ui'), { IDE_CORE_PORT: String(CORE_PORT) });
  await Promise.all([waitForPort(CORE_PORT), waitForPort(UI_PORT)]);

  // The default menu binds Cmd+W to "Close Window"; the IDE needs that key to close a project.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W', role: 'close' }] },
  ]));
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
      html:root { --tabs-inset: 0px; }
      header.topbar { padding-left: 84px; -webkit-app-region: drag; }
      header.topbar :is(button, select, input, label, a, [role='tab']) { -webkit-app-region: no-drag; }
    `);
  });
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
});
