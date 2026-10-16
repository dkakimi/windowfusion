// Exposes the small `window.wf` bridge used by src/lib/host.ts.
const { contextBridge, ipcRenderer } = require("electron");

// Subscribe to a main → renderer channel; returns an unsubscribe function
const listen = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("wf", {
  spawn: (req) => ipcRenderer.send("wf:spawn", {
    query: String(req.query), x: Number(req.x), y: Number(req.y), side: Number(req.side),
  }),
  release: () => ipcRenderer.send("wf:release"),
  setBounds: (x, y, w, h) => ipcRenderer.send("wf:bounds", Number(x), Number(y), Number(w), Number(h)),
  setIgnoreMouse: (ignore) => ipcRenderer.send("wf:ignore", !!ignore),
  ready: () => ipcRenderer.send("wf:ready"),
  quit: () => ipcRenderer.send("wf:quit"),
  onCommand: (cb) => listen("wf:cmd", cb),
  onRing: (cb) => listen("wf:ring", cb),
});
