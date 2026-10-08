import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpdater } from '../updater.mjs';

const VERSION = '1.0.0';
const NEXT = '2.0.0';
const WINDOW = { id: 'main-window' };
const FIRST_CHECK_MS = 15_000;
const FOUR_HOURS_MS = 4 * 60 * 60_000;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup() {
  const autoUpdater = Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: undefined as unknown,
    checkForUpdates: vi.fn<() => Promise<unknown>>(async () => null),
    quitAndInstall: vi.fn(),
  });
  const dialog = { showMessageBox: vi.fn<(...args: unknown[]) => Promise<{ response: number }>>(async () => ({ response: 1 })) };
  const menuLabels: string[] = [];
  const updater = createUpdater({
    autoUpdater,
    dialog,
    getWindow: () => WINDOW,
    version: VERSION,
    log: vi.fn(),
    onChange: () => menuLabels.push(updater.menuItem().label),
  });
  const shown = () => dialog.showMessageBox.mock.calls.map((call) => call.at(-1) as Record<string, unknown>);
  return { autoUpdater, dialog, updater, menuLabels, shown };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('updater', () => {
  it('downloads in the background and installs on quit', () => {
    const { autoUpdater } = setup();
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it('checks 15 s after start and then every 4 h', () => {
    vi.useFakeTimers();
    const { autoUpdater, updater } = setup();
    updater.start();

    vi.advanceTimersByTime(FIRST_CHECK_MS - 1);
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    autoUpdater.emit('update-not-available');

    vi.advanceTimersByTime(FOUR_HOURS_MS - FIRST_CHECK_MS - 1);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    autoUpdater.emit('update-not-available');

    vi.advanceTimersByTime(FOUR_HOURS_MS);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it('never opens a dialog for a scheduled check, whatever it finds', () => {
    vi.useFakeTimers();
    const { autoUpdater, dialog, updater } = setup();
    updater.start();

    vi.advanceTimersByTime(FIRST_CHECK_MS);
    autoUpdater.emit('update-not-available');
    vi.advanceTimersByTime(FOUR_HOURS_MS);
    autoUpdater.emit('error', new Error('offline'));
    vi.advanceTimersByTime(FOUR_HOURS_MS);
    autoUpdater.emit('update-available', { version: NEXT });

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('tells the user from the menu that the app is up to date, and only that once', () => {
    const { autoUpdater, dialog, shown, updater } = setup();

    updater.menuItem().click();
    autoUpdater.emit('update-not-available');
    expect(shown()).toEqual([expect.objectContaining({ type: 'info', message: expect.stringContaining('up to date'), detail: expect.stringContaining(VERSION) })]);

    updater.check();
    autoUpdater.emit('update-not-available');
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('tells the user an update is available, and stays quiet if its download fails later', () => {
    const { autoUpdater, dialog, shown, updater } = setup();

    updater.check({ byUser: true });
    autoUpdater.emit('update-available', { version: NEXT });
    expect(shown()).toEqual([expect.objectContaining({ type: 'info', message: expect.stringContaining(NEXT) })]);

    autoUpdater.emit('error', new Error('connection lost'));
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('reports a failed user check, leaves no unhandled rejection and lets the next check run', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      const { autoUpdater, shown, updater } = setup();
      const failure = new Error('network down');
      let checks = 0;
      // A plain function: vi.fn would attach handlers to the returned promise and hide the rejection.
      autoUpdater.checkForUpdates = (() => {
        checks += 1;
        if (checks > 1) return Promise.resolve(null);
        autoUpdater.emit('error', failure);
        return Promise.reject(failure);
      }) as typeof autoUpdater.checkForUpdates;

      updater.check({ byUser: true });
      await flush();

      expect(shown()).toEqual([expect.objectContaining({ type: 'error', detail: 'network down' })]);
      expect(unhandled).toEqual([]);
      expect(updater.menuItem().label).toBe('Check for Updates…');
      updater.check();
      expect(checks).toBe(2);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  it('rebuilds the menu item at every step of an update', () => {
    const { autoUpdater, menuLabels, updater } = setup();
    const idle = updater.menuItem();
    expect(idle.label).toBe('Check for Updates…');
    expect(idle.enabled).not.toBe(false);

    idle.click();
    expect(updater.menuItem()).toEqual({ label: 'Checking for Updates…', enabled: false });
    autoUpdater.emit('update-available', { version: NEXT });
    autoUpdater.emit('download-progress', { percent: 41.6 });
    autoUpdater.emit('download-progress', { percent: 87.2 });
    expect(updater.menuItem()).toEqual({ label: 'Downloading Update… 87%', enabled: false });
    autoUpdater.emit('update-downloaded', { version: NEXT });

    const ready = updater.menuItem();
    expect(ready.label).toBe(`Restart to Update to ${NEXT}`);
    expect(ready.enabled).not.toBe(false);
    ready.click();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(menuLabels).toEqual([
      'Checking for Updates…',
      'Downloading Update… 0%',
      'Downloading Update… 42%',
      'Downloading Update… 87%',
      `Restart to Update to ${NEXT}`,
    ]);
  });

  it('offers a restart that defaults to Later, installs only on Restart, and offers it again on a user check', async () => {
    const { autoUpdater, dialog, updater } = setup();

    autoUpdater.emit('update-downloaded', { version: NEXT });
    await flush();
    expect(dialog.showMessageBox).toHaveBeenCalledWith(WINDOW, expect.objectContaining({
      message: expect.stringContaining(NEXT),
      buttons: ['Restart', 'Later'],
      defaultId: 1,
      cancelId: 1,
    }));
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    updater.check({ byUser: true });
    await flush();
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('does not start another check while one is running, downloading or waiting for a restart', () => {
    const { autoUpdater, updater } = setup();

    updater.check();
    updater.check({ byUser: true });
    autoUpdater.emit('update-available', { version: NEXT });
    updater.check();
    updater.check({ byUser: true });
    autoUpdater.emit('update-downloaded', { version: NEXT });
    updater.check();

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('keeps the downloaded update ready when an error arrives afterwards', () => {
    const { autoUpdater, updater } = setup();
    autoUpdater.emit('update-downloaded', { version: NEXT });

    autoUpdater.emit('error', new Error('late failure'));

    expect(updater.menuItem().label).toBe(`Restart to Update to ${NEXT}`);
    updater.check();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });
});
