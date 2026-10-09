export interface WindowInfo {
  id: string;
  screenX: number;
  screenY: number;
  width: number;
  height: number;
  lastSeen: number;
}

type MessageType =
  | { type: "heartbeat"; id: string; screenX: number; screenY: number; width: number; height: number }
  | { type: "leave"; id: string };

export class WindowSync {
  myId: string;
  windows: Map<string, WindowInfo>;
  onWindowsChange?: (windows: Map<string, WindowInfo>) => void;

  private channel: BroadcastChannel;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly STALE_TIMEOUT_MS = 2000;
  private readonly HEARTBEAT_INTERVAL_MS = 200;
  private readonly CLEANUP_INTERVAL_MS = 500;

  constructor() {
    this.myId = crypto.randomUUID();
    this.windows = new Map();
    this.channel = new BroadcastChannel("windowfusion");

    this.channel.addEventListener("message", this.handleMessage);

    this.heartbeatInterval = setInterval(
      () => this.broadcastHeartbeat(),
      this.HEARTBEAT_INTERVAL_MS
    );

    this.cleanupInterval = setInterval(
      () => this.cleanupStaleWindows(),
      this.CLEANUP_INTERVAL_MS
    );

    window.addEventListener("beforeunload", this.handleUnload);

    // Send initial heartbeat immediately
    this.broadcastHeartbeat();
  }

  private broadcastHeartbeat(): void {
    const msg: MessageType = {
      type: "heartbeat",
      id: this.myId,
      screenX: window.screenX,
      screenY: window.screenY,
      width: window.outerWidth,
      height: window.outerHeight,
    };
    this.channel.postMessage(msg);
  }

  private handleMessage = (event: MessageEvent<MessageType>): void => {
    const data = event.data;

    if (data.type === "heartbeat") {
      const existing = this.windows.get(data.id);
      const info: WindowInfo = {
        id: data.id,
        screenX: data.screenX,
        screenY: data.screenY,
        width: data.width,
        height: data.height,
        lastSeen: Date.now(),
      };
      this.windows.set(data.id, info);
      if (!existing) {
        this.onWindowsChange?.(this.windows);
      }
    } else if (data.type === "leave") {
      if (this.windows.has(data.id)) {
        this.windows.delete(data.id);
        this.onWindowsChange?.(this.windows);
      }
    }
  };

  private cleanupStaleWindows(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, info] of this.windows) {
      if (now - info.lastSeen > this.STALE_TIMEOUT_MS) {
        this.windows.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.onWindowsChange?.(this.windows);
    }
  }

  private handleUnload = (): void => {
    const msg: MessageType = { type: "leave", id: this.myId };
    this.channel.postMessage(msg);
    this.destroy();
  };

  getMyInfo(): WindowInfo {
    return {
      id: this.myId,
      screenX: window.screenX,
      screenY: window.screenY,
      width: window.outerWidth,
      height: window.outerHeight,
      lastSeen: Date.now(),
    };
  }

  destroy(): void {
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    window.removeEventListener("beforeunload", this.handleUnload);
    this.channel.removeEventListener("message", this.handleMessage);
    this.channel.close();
  }
}
