"use client";
import { useEffect, useState } from "react";

const WINDOW_COUNT = 5;
function getChannel() {
  return new BroadcastChannel("windowfusion-ctrl");
}

const btnStyle = (color = "rgba(255,255,255,0.06)"): React.CSSProperties => ({
  background: color,
  color: "rgba(255,255,255,0.65)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  padding: "9px 18px",
  fontFamily: "ui-monospace, monospace",
  fontSize: 12,
  cursor: "pointer",
  letterSpacing: "0.04em",
  zIndex: 100,
  transition: "background 0.15s",
});

export function LaunchButton() {
  const [isLaunched, setIsLaunched] = useState(true);

  useEffect(() => {
    setIsLaunched(new URLSearchParams(window.location.search).get("launched") === "1");
  }, []);

  if (isLaunched) return null;

  const handleLaunch = () => {
    const W  = Math.round(screen.availWidth  / 3);
    const H  = Math.round(screen.availHeight / 2);
    const aL = (screen as Screen & { availLeft?: number }).availLeft ?? 0;
    const aT = (screen as Screen & { availTop?:  number }).availTop  ?? 0;

    for (let i = 0; i < WINDOW_COUNT; i++) {
      const x = Math.round(aL + Math.random() * Math.max(0, screen.availWidth  - W));
      const y = Math.round(aT + Math.random() * Math.max(0, screen.availHeight - H));
      window.open(
        `${window.location.origin}/?launched=1`,
        `wf-${i}`,
        `width=${W},height=${H},left=${x},top=${y}`
      );
    }
  };

  const handleCloseAll = () => {
    getChannel().postMessage({ type: "close_all" });
  };

  return (
    <div style={{ position: "fixed", bottom: 24, right: 24, display: "flex", gap: 8 }}>
      <button
        onClick={handleCloseAll}
        style={btnStyle()}
        onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,80,80,0.18)")}
        onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
      >
        Close All
      </button>
      <button
        onClick={handleLaunch}
        style={btnStyle()}
        onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.12)")}
        onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
      >
        Launch {WINDOW_COUNT} Windows
      </button>
    </div>
  );
}
