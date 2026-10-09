"use client";
import { useEffect, useState } from "react";

const WINDOW_COUNT = 5;

export function LaunchButton() {
  const [isLaunched, setIsLaunched] = useState(true); // hide until we know

  useEffect(() => {
    setIsLaunched(new URLSearchParams(window.location.search).get("launched") === "1");
  }, []);

  if (isLaunched) return null;

  const handleLaunch = () => {
    // 1/3 screen width × 1/2 screen height ≈ 1/6 of screen area
    const W = Math.round(screen.availWidth  / 3);
    const H = Math.round(screen.availHeight / 2);

    for (let i = 0; i < WINDOW_COUNT; i++) {
      const aL = (screen as Screen & { availLeft?: number }).availLeft ?? 0;
      const aT = (screen as Screen & { availTop?:  number }).availTop  ?? 0;
      const x = Math.round(aL + Math.random() * Math.max(0, screen.availWidth  - W));
      const y = Math.round(aT + Math.random() * Math.max(0, screen.availHeight - H));
      window.open(
        `${window.location.origin}/?launched=1`,
        `wf-${i}`,
        `width=${W},height=${H},left=${x},top=${y}`
      );
    }
  };

  return (
    <button
      onClick={handleLaunch}
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        background: "rgba(255,255,255,0.06)",
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
      }}
      onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.12)")}
      onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
    >
      Launch {WINDOW_COUNT} Windows
    </button>
  );
}
