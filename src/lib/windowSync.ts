export interface WindowInfo {
  id: string;
  screenX: number;
  screenY: number;
  width: number;
  height: number;
  color: [number, number, number];
  focusedAt: number;
  lastSeen: number;
}

type Message =
  | { type: "heartbeat"; id: string; screenX: number; screenY: number; width: number; height: number; color: [number, number, number]; focusedAt: number }
  | { type: "leave"; id: string };

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function idToColor(id: string): [number, number, number] {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash * 31) + id.charCodeAt(i)) >>> 0;
  return hslToRgb((hash % 360) / 360, 1.0, 0.65);
}

export class WindowSync {
  readonly myId: string;
  readonly myColor: [number, number, number];
  windows: Map<string, WindowInfo>;
  onWindowsChange?: (windows: Map<string, WindowInfo>) => void;

  private channel: BroadcastChannel;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private focusedAt: number;

  constructor() {
    this.myId = crypto.randomUUID();
    this.myColor = idToColor(this.myId);
    this.focusedAt = Date.now();
    this.windows = new Map();
    this.channel = new BroadcastChannel("windowfusion");
    this.channel.addEventListener("message", this.handleMessage);

    window.addEventListener("focus",       this.handleFocus);
    window.addEventListener("beforeunload", this.handleUnload);

    this.heartbeatTimer = setInterval(() => this.broadcast(), 150);
    this.cleanupTimer   = setInterval(() => this.prune(),     400);
    this.broadcast();
  }

  private handleFocus = () => {
    this.focusedAt = Date.now();
    this.broadcast();
  };

  private broadcast(): void {
    const chromeH = window.outerHeight - window.innerHeight;
    const msg: Message = {
      type: "heartbeat",
      id: this.myId,
      screenX: window.screenX,
      screenY: window.screenY + chromeH,
      width:   window.innerWidth,
      height:  window.innerHeight,
      color:   this.myColor,
      focusedAt: this.focusedAt,
    };
    this.channel.postMessage(msg);
  }

  private handleMessage = (e: MessageEvent<Message>): void => {
    const d = e.data;
    if (d.type === "heartbeat") {
      const isNew = !this.windows.has(d.id);
      this.windows.set(d.id, {
        id: d.id, screenX: d.screenX, screenY: d.screenY,
        width: d.width, height: d.height,
        color: d.color, focusedAt: d.focusedAt,
        lastSeen: Date.now(),
      });
      if (isNew) this.onWindowsChange?.(this.windows);
    } else if (d.type === "leave") {
      if (this.windows.delete(d.id)) this.onWindowsChange?.(this.windows);
    }
  };

  private prune(): void {
    const cutoff = Date.now() - 1500;
    let changed = false;
    for (const [id, info] of this.windows) {
      if (info.lastSeen < cutoff) { this.windows.delete(id); changed = true; }
    }
    if (changed) this.onWindowsChange?.(this.windows);
  }

  private handleUnload = () => {
    this.channel.postMessage({ type: "leave", id: this.myId } satisfies Message);
    this.destroy();
  };

  getMyInfo(): WindowInfo {
    const chromeH = window.outerHeight - window.innerHeight;
    return {
      id: this.myId,
      screenX: window.screenX,
      screenY: window.screenY + chromeH,
      width:   window.innerWidth,
      height:  window.innerHeight,
      color:   this.myColor,
      focusedAt: this.focusedAt,
      lastSeen: Date.now(),
    };
  }

  destroy(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.cleanupTimer)   clearInterval(this.cleanupTimer);
    window.removeEventListener("focus",       this.handleFocus);
    window.removeEventListener("beforeunload", this.handleUnload);
    this.channel.removeEventListener("message", this.handleMessage);
    this.channel.close();
  }
}
