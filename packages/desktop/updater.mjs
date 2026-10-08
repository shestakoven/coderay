// One update cycle of the installed app: check, download in the background, offer a restart. The app menu shows where it stands.
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60_000;

export function createUpdater({ autoUpdater, dialog, getWindow, version, log, onChange }) {
  let state = { phase: 'idle' };
  // Only a check the user asked for answers back with a dialog; the scheduled ones stay quiet.
  let askedByUser = false;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m) => log(`info ${m}`), warn: (m) => log(`warn ${m}`), error: (m) => log(`error ${m}`), debug: () => {} };

  const set = (next) => {
    state = next;
    onChange();
  };
  const say = (options) => {
    const win = getWindow();
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  };
  const answerUser = (options) => {
    if (askedByUser) say(options);
    askedByUser = false;
  };

  const install = () => autoUpdater.quitAndInstall(false, true);

  async function offerRestart() {
    // Restarting stops the running agents, so the safe answer is the default; the update also installs on the next quit.
    const { response } = await say({
      type: 'info',
      message: `CodeRay ${state.version} is ready to install`,
      detail: 'Restarting stops running agents. If you choose Later, the update installs the next time you quit CodeRay.',
      buttons: ['Restart', 'Later'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) install();
  }

  autoUpdater.on('checking-for-update', () => set({ phase: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    set({ phase: 'downloading', version: info.version, percent: 0 });
    answerUser({ type: 'info', message: `CodeRay ${info.version} is available`, detail: 'It downloads in the background; you will be asked to restart when it is ready.' });
  });
  autoUpdater.on('update-not-available', () => {
    set({ phase: 'idle' });
    answerUser({ type: 'info', message: 'CodeRay is up to date', detail: `Version ${version}` });
  });
  autoUpdater.on('download-progress', (progress) => set({ ...state, percent: Math.round(progress.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    set({ phase: 'ready', version: info.version });
    offerRestart();
  });
  autoUpdater.on('error', (error) => {
    if (state.phase !== 'ready') set({ phase: 'idle' });
    answerUser({ type: 'error', message: 'Could not check for updates', detail: error.message });
  });

  function check({ byUser = false } = {}) {
    if (state.phase === 'ready') {
      if (byUser) offerRestart();
      return;
    }
    if (state.phase !== 'idle') return;
    askedByUser = byUser;
    set({ phase: 'checking' });
    // A failed check also arrives as the 'error' event, which resets the state.
    autoUpdater.checkForUpdates().catch(() => {});
  }

  function start() {
    setTimeout(() => check(), FIRST_CHECK_MS).unref();
    setInterval(() => check(), CHECK_EVERY_MS).unref();
  }

  function menuItem() {
    switch (state.phase) {
      case 'checking': return { label: 'Checking for Updates…', enabled: false };
      case 'downloading': return { label: `Downloading Update… ${state.percent}%`, enabled: false };
      case 'ready': return { label: `Restart to Update to ${state.version}`, click: install };
      default: return { label: 'Check for Updates…', click: () => check({ byUser: true }) };
    }
  }

  return { start, check, menuItem };
}
