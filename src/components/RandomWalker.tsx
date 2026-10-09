"use client";
import { useEffect } from "react";

const SPEED     = 110;
const PAUSE_MIN = 700;
const PAUSE_MAX = 2200;

export function RandomWalker() {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("launched") !== "1") return;

    const s  = screen as Screen & { availLeft?: number; availTop?: number };
    const aL = s.availLeft ?? 0;
    const aT = s.availTop  ?? 0;

    let x = window.screenX;
    let y = window.screenY;
    let tx = x, ty = y;
    let pauseUntil = 0;
    let paused = false; // hover pause

    const pickTarget = () => {
      const W = window.outerWidth;
      const H = window.outerHeight;
      tx = aL + 10 + Math.random() * Math.max(0, screen.availWidth  - W - 20);
      ty = aT + 10 + Math.random() * Math.max(0, screen.availHeight - H - 20);
    };
    pickTarget();

    // Pause on hover so the user can click the × button
    const onEnter = () => { paused = true; };
    const onLeave = () => { paused = false; };
    document.addEventListener("mouseenter", onEnter);
    document.addEventListener("mouseleave", onLeave);

    // Close on BroadcastChannel command
    const ctrl = new BroadcastChannel("windowfusion-ctrl");
    ctrl.addEventListener("message", (e: MessageEvent) => {
      if (e.data?.type === "close_all") window.close();
    });

    let prev = performance.now();
    let animId: number;

    const tick = (now: number) => {
      const dt = Math.min((now - prev) / 1000, 0.05);
      prev = now;

      if (!paused && now >= pauseUntil) {
        const dx = tx - x;
        const dy = ty - y;
        const d  = Math.sqrt(dx * dx + dy * dy);

        if (d < 6) {
          pauseUntil = now + PAUSE_MIN + Math.random() * (PAUSE_MAX - PAUSE_MIN);
          pickTarget();
        } else {
          const step = Math.min(SPEED * dt, d);
          x += (dx / d) * step;
          y += (dy / d) * step;
          window.moveTo(Math.round(x), Math.round(y));
        }
      }

      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animId);
      document.removeEventListener("mouseenter", onEnter);
      document.removeEventListener("mouseleave", onLeave);
      ctrl.close();
    };
  }, []);

  return null;
}
