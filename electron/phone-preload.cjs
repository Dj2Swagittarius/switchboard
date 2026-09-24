// Minimal bridge for the phone window. The window is sandboxed without Node,
// so this is the only way it can ask the app to show itself or flash on an
// incoming call, plus one inbound signal for notification sounds.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('phoneHost', {
  show: () => ipcRenderer.send('phone:show'),
  ring: (who) => ipcRenderer.send('phone:ring', String(who ?? '')),
  idle: () => ipcRenderer.send('phone:idle'),
  openMain: (path) => ipcRenderer.send('phone:openMain', String(path ?? '/')),
  // The phone is an overlay in the main window; the page picks its size and
  // drags it by its title bar.
  layout: (mode) => ipcRenderer.send('phone:layout', String(mode)),
  drag: (dx, dy) => ipcRenderer.send('phone:drag', { dx: Number(dx) || 0, dy: Number(dy) || 0 }),
  onOpen: (cb) => ipcRenderer.on('phone:open', () => cb()),
  // Notification sounds, sent by the app (toasts themselves are silent).
  onSound: (cb) => ipcRenderer.on('sound:play', (_e, d) => cb({
    name: String(d?.name ?? ''), file: String(d?.file ?? ''), volume: Number(d?.volume ?? 60),
  })),
});
