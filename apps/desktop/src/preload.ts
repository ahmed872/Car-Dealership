import { contextBridge, ipcRenderer } from 'electron';

// The only bridge between the start-up pages (activation, setup, status) and the main process.
contextBridge.exposeInMainWorld('autohub', {
  activationInfo: () => ipcRenderer.invoke('activation:info'),
  activate: (key: string) => ipcRenderer.invoke('activation:submit', key),
  setup: (input: unknown) => ipcRenderer.invoke('setup:submit', input),
  copy: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  quit: () => ipcRenderer.invoke('app:quit'),
  onStatus: (cb: (text: string) => void) => ipcRenderer.on('status', (_e, text: string) => cb(text)),
});
