export interface WindowInfo {
  id: string;
  screenX: number;
  screenY: number;
  width: number;
  height: number;
  color: [number, number, number];
  focusedAt: number;
  lastSeen: number;
  // Bubble state (px, px/s)
  radius: number;
  vx: number;
  vy: number;
  alive: boolean;
  immuneUntil: number;   // wall-clock ms; no merges before this
  sentAt: number;
}

export interface BubbleState {
  radius: number;
  vx: number;
  vy: number;
  alive: boolean;
  immuneUntil: number;
}

type HeartbeatMessage =
  | ({ type: "heartbeat" } & Omit<WindowInfo, "lastSeen">)
  | { type: "leave"; id: string };

export type FusionEvent =
  | { type: "fusion";     survivorId: string; victimId: string; victimRadius: number }
  | { type: "annihilate"; id1: string;        id2: string };

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

// Center of a window's content area, extrapolated by its last known velocity so
// remote bubbles move smoothly between heartbeats.
export function predictCenter(info: WindowInfo, now = Date.now()): [number, number] {
  const dt = Math.min(Math.max(now - info.sentAt, 0), 300) / 1000;
  return [
    info.screenX + info.width  * 0.5 + info.vx * dt,
    info.screenY + info.height * 0.5 + info.vy * dt,
  ];
}

export class WindowSync {
  readonly myId: string;
  readonly myColor: [number, number, number];
  windows: Map<string, WindowInfo>;
  onWindowsChange?: (windows: Map<string, WindowInfo>) => void;
  onFusionEvent?:   (event: FusionEvent) => void;

  private channel:       BroadcastChannel;
  private eventsChannel: BroadcastChannel;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer:   ReturnType<typeof setInterval> | null = null;
  private focusedAt: number;
  private state: BubbleState = { radius: 0, vx: 0, vy: 0, alive: true, immuneUntil: 0 };

  constructor() {
    this.myId      = crypto.randomUUID();
    this.myColor   = idToColor(this.myId);
    this.focusedAt = Date.now();
    this.windows   = new Map();

    this.channel = new BroadcastChannel("windowfusion");
    this.channel.addEventListener("message", this.handleMessage);

    this.eventsChannel = new BroadcastChannel("windowfusion-events");
    this.eventsChannel.addEventListener("message", (e: MessageEvent<FusionEvent>) => {
      this.onFusionEvent?.(e.data);
    });

    window.addEventListener("focus",       this.handleFocus);
    window.addEventListener("beforeunload", this.leave);

    // Remote motion is extrapolated from velocity, so a slower heartbeat is fine
    // and keeps the N² message traffic down when many windows are open.
    this.heartbeatTimer = setInterval(() => this.broadcast(), 100);
    this.cleanupTimer   = setInterval(() => this.prune(),     400);
    this.broadcast();
  }

  setState(state: BubbleState): void {
    const wasAlive = this.state.alive;
    this.state = state;
    // Death must propagate immediately so others stop colliding with us.
    if (wasAlive && !state.alive) this.broadcast();
  }

  sendFusion(survivorId: string, victimId: string, victimRadius: number): void {
    this.eventsChannel.postMessage({ type: "fusion", survivorId, victimId, victimRadius } satisfies FusionEvent);
  }

  sendAnnihilate(id1: string, id2: string): void {
    this.eventsChannel.postMessage({ type: "annihilate", id1, id2 } satisfies FusionEvent);
  }

  // The shell raised our window (shown, or brought to front) at `at` (epoch ms).
  // focusedAt doubles as the stacking order: later = higher.
  markRaised(at: number): void {
    this.focusedAt = Math.max(this.focusedAt, at);
    this.broadcast();
  }

  private handleFocus = () => {
    this.focusedAt = Date.now();
    this.broadcast();
  };

  private broadcast(): void {
    const { lastSeen: _, ...info } = this.getMyInfo();
    void _;
    this.channel.postMessage({ type: "heartbeat", ...info } satisfies HeartbeatMessage);
  }

  private handleMessage = (e: MessageEvent<HeartbeatMessage>): void => {
    const d = e.data;
    if (d.type === "heartbeat") {
      const isNew = !this.windows.has(d.id);
      const { type: _, ...info } = d;
      void _;
      this.windows.set(d.id, { ...info, lastSeen: Date.now() });
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

  // Tell the others we are gone, then shut down. Also runs on unload.
  leave = () => {
    this.channel.postMessage({ type: "leave", id: this.myId } satisfies HeartbeatMessage);
    this.destroy();
  };

  getMyInfo(): WindowInfo {
    const chromeH = window.outerHeight - window.innerHeight;
    const now = Date.now();
    return {
      id: this.myId,
      screenX: window.screenX,
      screenY: window.screenY + chromeH,
      width:   window.innerWidth,
      height:  window.innerHeight,
      color:   this.myColor,
      focusedAt: this.focusedAt,
      lastSeen: now,
      sentAt:   now,
      ...this.state,
    };
  }

  destroy(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.cleanupTimer)   clearInterval(this.cleanupTimer);
    window.removeEventListener("focus",       this.handleFocus);
    window.removeEventListener("beforeunload", this.leave);
    this.channel.removeEventListener("message", this.handleMessage);
    this.channel.close();
    this.eventsChannel.close();
  }
}
