// The traffic lights sit inside the top bar and are hidden in full screen, so only the windowed state keeps room for them.
export function keepRoomForTrafficLights(win, width = 84) {
  let key = null;
  let queue = Promise.resolve();
  const set = (on) => {
    queue = queue.then(async () => {
      if (key !== null) await win.webContents.removeInsertedCSS(key);
      key = on ? await win.webContents.insertCSS(`html:root { --tabs-inset: 0px; } header.topbar { padding-left: ${width}px; }`) : null;
    });
  };
  // A page load drops every inserted stylesheet.
  win.webContents.on('dom-ready', () => {
    key = null;
    set(!win.isFullScreen());
  });
  win.on('enter-full-screen', () => set(false));
  win.on('leave-full-screen', () => set(true));
}
