// Electron shell for WindowFusion — a menu-bar app.
//
// • Lives in the menu bar (no Dock icon, no control window).
// • Blow mode (⌥⌘B): the cursor becomes a soap-film ring; swinging the mouse
//   stretches the film until it breaks off into a bubble window.
// • Bubble windows are fully transparent, showing only a frame and a title
//   bar with traffic lights, and are pooled: a popped bubble's window is hidden and reused instead of destroyed,
//   because creating and destroying OS windows is what made the browser
//   version stutter.

const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, screen,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// The Next.js app (`npm run dev`) the windows load
const APP_URL = process.env.WF_URL ?? "http://localhost:3000";

const POOL_PREWARM     = 6;    // hidden bubble windows created at startup
const POOL_MAX         = 24;   // hard cap on bubble windows
const SHOW_FALLBACK_MS = 1500;

// Must match WINDOW_PAD in src/lib/bubbleRenderer.ts and TITLE_BAR_H in src/lib/host.ts
const WINDOW_PAD  = 1.3;
const TITLE_BAR_H = 28;
const windowSideFor = (r) => Math.ceil(2 * r * WINDOW_PAD);

const BLOW_SHORTCUT = "Alt+CommandOrControl+B";

// Cursor ring / blowing
const RING_SIZE      = 300;   // ring overlay window, px (room for the stretched film)
const TICK_MS        = 16;
const MIN_SPEED      = 260;   // px/s — slower swings don't stretch the film
const SPAWN_GAP_MS   = 70;
const BUBBLE_INHERIT = 0.35;  // fraction of the swing velocity a bubble keeps
const BUBBLE_MAX_V   = 650;

const preload = path.join(__dirname, "preload.cjs");

// Window coordinates must be plain int32s for Electron. Math.round alone is not
// enough: a bubble touching the left edge rounds -0.0001 to -0, which V8 does
// not treat as an integer ("conversion failure"). `| 0` turns -0 into 0.
const toInt = (v) => Math.round(v) | 0;

/** @type {BrowserWindow[]} */
const free = [];
/** @type {Set<BrowserWindow>} */
const active = new Set();
/** @type {BrowserWindow | null} */
let ring = null;
/** @type {Tray | null} */
let tray = null;
let blowing = false;
let quitting = false;

// Bubble window look: "glass" (fully transparent, click-through around the
// bubble) or "dark" (an opaque dark standard window). Remembered across launches.
const STYLES = ["glass", "dark"];
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
let windowStyle = "glass";

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    if (STYLES.includes(s.windowStyle)) windowStyle = s.windowStyle;
  } catch { /* first launch */ }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify({ windowStyle }));
  } catch (err) {
    console.warn(`Could not save settings: ${err}`);
  }
}

// Native bits of a style; the page draws the rest (see ParticleCanvas)
function applyStyle(win) {
  const dark = windowStyle === "dark";
  win.setHasShadow(dark);
  win.setIgnoreMouseEvents(!dark, { forward: true });
}

function setWindowStyle(style) {
  if (!STYLES.includes(style) || style === windowStyle) return;
  windowStyle = style;
  saveSettings();
  for (const win of active) {
    if (win.isDestroyed()) continue;
    applyStyle(win);
    win.webContents.send("wf:cmd", { type: "style", style });
  }
  refreshTray();
}

// WF_DEBUG=1 forwards renderer warnings/errors to this terminal
function debugConsole(win, label) {
  if (!process.env.WF_DEBUG) return;
  win.webContents.on("console-message", (e) => {
    if (e.level === "warning" || e.level === "error") console.log(`[${label}] ${e.level}: ${e.message}`);
  });
}

const webPreferences = (extra = {}) => ({
  preload,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  ...extra,
});

const overlayOptions = {
  show: false,
  frame: false,
  transparent: true,
  backgroundColor: "#00000000",
  hasShadow: false,
  roundedCorners: false,
  resizable: false,
  movable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  skipTaskbar: true,
  alwaysOnTop: true,
};

// Tell a bubble page its window just came to the front, so pages can agree on
// the stacking order (dark windows draw the bubbles of windows below them).
function sendRaised(win) {
  if (isBubble(win)) win.webContents.send("wf:cmd", { type: "raised", at: Date.now() });
}

function showBubble(win) {
  win.showInactive();   // don't steal focus
  sendRaised(win);
}

// ── Bubble pool ──────────────────────────────────────────────────────────────

// Fully transparent window. The page draws only a hairline frame and the
// title bar with traffic lights (see ParticleCanvas), so they can drive the bubble.
function createBubbleWindow() {
  const win = new BrowserWindow({
    show: false,
    width: 200,
    height: 200 + TITLE_BAR_H,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Hidden windows must keep animating so the first frame (which triggers
    // `ready` → show) gets rendered.
    webPreferences: webPreferences({ backgroundThrottling: false }),
  });
  win.setAlwaysOnTop(true, "floating");
  debugConsole(win, "bubble");
  win.loadURL("about:blank");
  // ⌘W / close: pop the bubble instead (the window goes back to the pool)
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    if (active.has(win)) win.webContents.send("wf:cmd", { type: "pop" });
  });
  win.on("focus", () => sendRaised(win));
  win.on("closed", () => {
    active.delete(win);
    const i = free.indexOf(win);
    if (i >= 0) free.splice(i, 1);
  });
  return win;
}

function spawnBubble(req) {
  if (process.env.WF_DEBUG) console.log(`spawn ${req.query}`);
  const win = free.pop() ?? (active.size + free.length < POOL_MAX ? createBubbleWindow() : null);
  if (!win) return;   // pool exhausted: skip this bubble
  active.add(win);
  // req.x/y is the top-left of the square bubble area; the title bar sits above it
  const side = Math.max(1, toInt(req.side));
  const wa = screen.getDisplayNearestPoint({ x: toInt(req.x), y: toInt(req.y) }).workArea;
  const y = Math.max(toInt(req.y) - TITLE_BAR_H, wa.y);
  win.setBounds({ x: toInt(req.x), y, width: side, height: side + TITLE_BAR_H });
  applyStyle(win);   // glass: click-through; the page re-enables over bubble / title bar
  // Hand the page its window center: a hidden window reports screenX/Y as 0,
  // which would snap the new bubble to the top-left corner.
  const q = new URLSearchParams(req.query);
  q.set("wx", String(toInt(req.x) + side / 2));
  q.set("wy", String(y + (side + TITLE_BAR_H) / 2));
  q.set("style", windowStyle);
  win.loadURL(`${APP_URL}/?${q}`);
  setTimeout(() => {
    if (active.has(win) && !win.isDestroyed() && !win.isVisible()) showBubble(win);
  }, SHOW_FALLBACK_MS);
}

// Bubble centered at (cx, cy) in screen px, kept inside the display's work area
function spawnAt(cx, cy, r, vx, vy, birth = "blow") {
  const side = windowSideFor(r);
  const wa = screen.getDisplayNearestPoint({ x: toInt(cx), y: toInt(cy) }).workArea;
  const x = Math.min(Math.max(cx - side / 2, wa.x), wa.x + wa.width  - side);
  const y = Math.min(Math.max(cy - side / 2, wa.y + TITLE_BAR_H), wa.y + wa.height - side);
  const q = new URLSearchParams({
    launched: "1", r: r.toFixed(1), birth, vx: vx.toFixed(1), vy: vy.toFixed(1),
  });
  spawnBubble({ query: q.toString(), x, y, side });
}

function popAll() {
  for (const win of active) {
    if (!win.isDestroyed()) win.webContents.send("wf:cmd", { type: "pop" });
  }
}

// A few bubbles tumble out of the menu-bar icon
function spill(count = 3) {
  const b = tray?.getBounds();
  const cx = b ? b.x + b.width / 2 : screen.getPrimaryDisplay().workArea.width / 2;
  const cy = b ? b.y + b.height : 0;
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      const r = 40 + Math.random() * 30;
      spawnAt(cx + (Math.random() - 0.5) * 40, cy + r * 1.4, r,
        (Math.random() - 0.5) * 260, 140 + Math.random() * 120, "split");
    }, i * 140);
  }
}

// ── Cursor ring (blow mode) ──────────────────────────────────────────────────

function createRing() {
  ring = new BrowserWindow({
    ...overlayOptions,
    width: RING_SIZE,
    height: RING_SIZE,
    focusable: false,
    webPreferences: webPreferences({ backgroundThrottling: false }),
  });
  ring.setAlwaysOnTop(true, "screen-saver");   // above the bubbles
  ring.setIgnoreMouseEvents(true);              // never blocks the cursor
  debugConsole(ring, "ring");
  ring.loadURL(`${APP_URL}/?ring=1`);
}

// Film stretch accumulates while the cursor swings; when it has stretched far
// enough a bubble breaks off behind the ring. Slow, wide swings blow big
// bubbles; fast flicks blow many small ones.
let blowTimer = null;
let last = null;
let vx = 0, vy = 0;
let stretch = 0;          // px of film pulled through the ring
let lastSpawnAt = 0;

function bubbleRadiusFor(speed) {
  if (speed < 900) return 95 - (Math.max(speed - MIN_SPEED, 0) / (900 - MIN_SPEED)) * 35;
  return 60 - Math.min((speed - 900) / 1500, 1) * 22;
}

// WF_FAKE_SWING=1 (testing): a virtual cursor circling the screen center
function cursorPoint(now) {
  if (!process.env.WF_FAKE_SWING) return screen.getCursorScreenPoint();
  const wa = screen.getPrimaryDisplay().workArea;
  const a = now / 1000 * 2.2;
  return {
    x: toInt(wa.x + wa.width / 2 + Math.cos(a) * 320),
    y: toInt(wa.y + wa.height / 2 + Math.sin(a) * 200),
  };
}

function blowTick() {
  const now = Date.now();
  const p = cursorPoint(now);
  if (!last) last = { x: p.x, y: p.y, t: now };
  const dt = Math.max((now - last.t) / 1000, 0.001);
  vx += ((p.x - last.x) / dt - vx) * 0.35;
  vy += ((p.y - last.y) / dt - vy) * 0.35;
  last = { x: p.x, y: p.y, t: now };

  const speed = Math.hypot(vx, vy);
  const r = bubbleRadiusFor(speed);
  const need = r * 2.4;   // film needed to wrap a bubble of radius r
  if (speed > MIN_SPEED) stretch += speed * dt;
  else stretch *= Math.exp(-6 * dt);   // film relaxes back into the ring

  let released = false;
  if (stretch >= need && now - lastSpawnAt > SPAWN_GAP_MS) {
    const dx = vx / (speed || 1), dy = vy / (speed || 1);
    const k = Math.min(BUBBLE_INHERIT, BUBBLE_MAX_V / (speed || 1));
    // Born just behind the ring, drifting along the swing
    spawnAt(p.x - dx * r * 1.1, p.y - dy * r * 1.1, r, vx * k, vy * k);
    stretch = 0;
    lastSpawnAt = now;
    released = true;
  }

  if (ring && !ring.isDestroyed() && !ring.webContents.isLoading()) {
    ring.setPosition(toInt(p.x - RING_SIZE / 2), toInt(p.y - RING_SIZE / 2));
    try {
      ring.webContents.send("wf:ring", { vx, vy, stretch: Math.min(stretch / need, 1), released });
    } catch { /* frame reloading (dev HMR) or shutting down */ }
  }
}

function setBlowing(on) {
  blowing = on;
  if (on) {
    last = null; vx = vy = 0; stretch = 0;
    blowTick();
    ring?.showInactive();
    blowTimer = setInterval(blowTick, TICK_MS);
  } else {
    clearInterval(blowTimer);
    blowTimer = null;
    ring?.hide();
  }
  refreshTray();
}

// ── Menu bar ─────────────────────────────────────────────────────────────────

// Template icon drawn in code: a ring, filled with "film" while blowing
function trayIcon(filled) {
  const S = 36;   // @2x pixels for an 18pt icon
  const buf = Buffer.alloc(S * S * 4);
  const c = (S - 1) / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - c, y - c);
      const ringA = Math.max(0, Math.min(1, 1.6 - Math.abs(d - 12.5) / 1.6));   // bold ring
      const filmA = d < 11 ? (filled ? 0.6 : 0.18) : 0;
      const shine = Math.max(0, Math.min(1, 1.8 - Math.hypot(x - c + 5, y - c + 5) / 1.6));
      const a = Math.min(1, Math.max(ringA, filmA, shine));
      buf[(y * S + x) * 4 + 3] = Math.round(a * 255);   // BGRA, black + alpha
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: S, height: S, scaleFactor: 2 });
  img.setTemplateImage(true);
  return img;
}

function refreshTray() {
  if (!tray) return;
  tray.setImage(trayIcon(blowing));
  tray.setToolTip(blowing ? "WindowFusion — blowing" : "WindowFusion");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "Blow Mode", type: "checkbox", checked: blowing,
      accelerator: BLOW_SHORTCUT, click: () => setBlowing(!blowing),
    },
    { label: "Spill Bubbles", click: () => spill(4) },
    { label: "Pop All", click: popAll },
    { type: "separator" },
    {
      label: "Window Style", submenu: [
        { label: "Transparent", type: "radio", checked: windowStyle === "glass", click: () => setWindowStyle("glass") },
        { label: "Dark Window", type: "radio", checked: windowStyle === "dark",  click: () => setWindowStyle("dark") },
      ],
    },
    { type: "separator" },
    { label: "Quit WindowFusion", role: "quit" },
  ]));
}

// ── IPC from bubble pages ────────────────────────────────────────────────────

const senderWindow = (e) => BrowserWindow.fromWebContents(e.sender);
const isBubble = (win) => !!win && !win.isDestroyed() && active.has(win);

ipcMain.on("wf:spawn", (_e, req) => {
  if (!req || typeof req.query !== "string") return;
  spawnBubble(req);
});

ipcMain.on("wf:ready", (e) => {
  const win = senderWindow(e);
  if (isBubble(win)) showBubble(win);
});

ipcMain.on("wf:release", (e) => {
  const win = senderWindow(e);
  if (!isBubble(win)) return;
  active.delete(win);
  win.hide();
  // Unload the page so a parked window costs nothing until reused
  win.loadURL("about:blank");
  free.push(win);
});

ipcMain.on("wf:bounds", (e, x, y, w, h) => {
  const win = senderWindow(e);
  if (!isBubble(win)) return;
  // Never let a bad value from a page crash the main process
  if (![x, y, w, h].every(Number.isFinite) || w < 1 || h < 1) {
    if (process.env.WF_DEBUG) console.log(`wf:bounds ignored: ${x}, ${y}, ${w}, ${h}`);
    return;
  }
  const [cw, ch] = win.getSize();
  if (cw === w && ch === h) win.setPosition(toInt(x), toInt(y));
  else win.setBounds({ x: toInt(x), y: toInt(y), width: toInt(w), height: toInt(h) });
});

ipcMain.on("wf:ignore", (e, ignore) => {
  const win = senderWindow(e);
  if (!isBubble(win)) return;
  win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

ipcMain.on("wf:quit", () => app.quit());

// ── Startup ──────────────────────────────────────────────────────────────────

async function waitForServer(url) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (i === 0) console.log(`Waiting for ${url} … (run \`npm run dev\`)`);
    await new Promise(r => setTimeout(r, 500));
  }
}

app.whenReady().then(async () => {
  app.dock?.hide();   // menu-bar only
  loadSettings();
  tray = new Tray(trayIcon(false));
  refreshTray();

  await waitForServer(APP_URL);
  for (let i = 0; i < POOL_PREWARM; i++) free.push(createBubbleWindow());
  createRing();

  if (!globalShortcut.register(BLOW_SHORTCUT, () => setBlowing(!blowing))) {
    console.warn(`Could not register ${BLOW_SHORTCUT}; use the menu-bar icon instead.`);
  }

  // Say hello: a few bubbles fall out of the menu-bar icon
  setTimeout(() => spill(3), 800);

  // WF_SMOKE=1: spawn a few bubbles and turn blow mode on (for testing)
  if (process.env.WF_SMOKE) {
    setTimeout(() => {
      for (let i = 0; i < 4; i++) spawnAt(400 + i * 220, 400, 70, (i - 1.5) * 160, -120);
      setBlowing(true);
    }, 2000);

    // WF_SHOT_DIR: save what each window renders, a few seconds in
    const dir = process.env.WF_SHOT_DIR;
    if (dir) {
      const fs = require("node:fs");
      setTimeout(async () => {
        const wins = [ring, ...active].filter(w => w && !w.isDestroyed());
        // Composite the WebGL canvas over black inside the page, in the same frame
        // it was drawn (capturePage un-premultiplies alpha, which misleads).
        const grab = `new Promise(r => requestAnimationFrame(() => {
          const c = document.querySelector("canvas");
          const o = document.createElement("canvas");
          o.width = c.width; o.height = c.height;
          const g = o.getContext("2d");
          g.fillStyle = "#000"; g.fillRect(0, 0, o.width, o.height);
          g.drawImage(c, 0, 0);
          r(o.toDataURL("image/png"));
        }))`;
        for (const [i, w] of wins.entries()) {
          try {
            const url = await w.webContents.executeJavaScript(grab);
            fs.writeFileSync(path.join(dir, `win${i}.png`), Buffer.from(url.split(",")[1], "base64"));
          } catch (err) {
            console.log(`capture ${i} failed: ${err}`);
          }
        }
        // Full page (title bar etc.; native glass is not part of the capture)
        const bubble = [...active].find(w => !w.isDestroyed());
        if (bubble) fs.writeFileSync(path.join(dir, "page.png"), (await bubble.webContents.capturePage()).toPNG());
        console.log(`captured ${wins.length} windows`);
      }, 5000);
    }
  }
});

app.on("before-quit", () => {
  quitting = true;
  clearInterval(blowTimer);
});
app.on("will-quit", () => globalShortcut.unregisterAll());
// Menu-bar app: keep running with no windows open
app.on("window-all-closed", () => {});
