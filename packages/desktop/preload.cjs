// The only door between the page and the app shell: the state of the update and the restart button.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coderayDesktop', {
  update: {
    get: () => ipcRenderer.invoke('update:get'),
    onChange: (listener) => {
      const forward = (_event, state) => listener(state);
      ipcRenderer.on('update:state', forward);
      return () => ipcRenderer.removeListener('update:state', forward);
    },
    restart: () => ipcRenderer.invoke('update:restart'),
  },
});
