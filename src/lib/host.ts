// Bridge to the Electron shell (exposed by electron/preload.cjs). Absent in a
// plain browser, where the app falls back to window.open / moveTo / close.

// Electron bubble windows: a glass window with a title bar (traffic lights)
// above the square bubble area. Must match TITLE_BAR_H in electron/main.cjs.
export const TITLE_BAR_H = 28;

export interface SpawnRequest {
  query: string;   // URL search params for the new bubble page
  x: number;       // top-left of the square bubble area, screen px
  y: number;       // (the shell adds the title bar above it)
  side: number;
}

// Cursor-ring state streamed from the main process while blow mode is on
export interface RingState {
  vx: number;          // cursor velocity, px/s
  vy: number;
  stretch: number;     // 0..1 film pulled through the ring
  released: boolean;   // a bubble just broke off
}

// Bubble window look: fully transparent, or an opaque dark standard window
export type WindowStyle = "glass" | "dark";

export type ShellCommand =
  | { type: "pop" }
  | { type: "style"; style: WindowStyle }
  // The window was shown or brought to the front at `at` (epoch ms)
  | { type: "raised"; at: number };

export interface WfBridge {
  spawn(req: SpawnRequest): void;
  // Hide this bubble window and return it to the pool
  release(): void;
  setBounds(x: number, y: number, w: number, h: number): void;
  // Let clicks pass through to the desktop (mouse moves are still forwarded)
  setIgnoreMouse(ignore: boolean): void;
  // First transparent frame is on screen; the shell may show the window now
  ready(): void;
  quit(): void;
  onCommand(cb: (cmd: ShellCommand) => void): () => void;
  onRing(cb: (s: RingState) => void): () => void;
}

declare global {
  interface Window { wf?: WfBridge }
}

export function shell(): WfBridge | undefined {
  return typeof window === "undefined" ? undefined : window.wf;
}

// Current window style: starts from the `style` query param the shell passes,
// then follows "style" commands from the menu bar.
let windowStyle: WindowStyle | null = null;
const styleListeners = new Set<() => void>();

export function getWindowStyle(): WindowStyle {
  windowStyle ??= new URLSearchParams(window.location.search).get("style") === "dark" ? "dark" : "glass";
  return windowStyle;
}

export function setWindowStyle(style: WindowStyle): void {
  if (style === getWindowStyle()) return;
  windowStyle = style;
  for (const l of styleListeners) l();
}

export function subscribeWindowStyle(cb: () => void): () => void {
  styleListeners.add(cb);
  return () => { styleListeners.delete(cb); };
}

// The layout paints html/body/main black for the browser version; Electron
// windows are transparent so bubbles float directly on the desktop.
export function makePageTransparent(): void {
  for (const el of [document.documentElement, document.body, document.querySelector("main")]) {
    if (el instanceof HTMLElement) el.style.background = "transparent";
  }
}
