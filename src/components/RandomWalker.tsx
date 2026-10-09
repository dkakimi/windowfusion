"use client";
import { useEffect } from "react";

const SPEED     = 110;  // px/s
const PAUSE_MIN = 700;  // ms — wait at target (min)
const PAUSE_MAX = 2200; // ms — wait at target (max)

export function RandomWalker() {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("launched") !== "1") return;

    // Usable screen region (excludes menubar / Dock on macOS)
    const s  = screen as Screen & { availLeft?: number; availTop?: number };
    const aL = s.availLeft ?? 0;
    const aT = s.availTop  ?? 0;
    const aW = screen.availWidth;
    const aH = screen.availHeight;

    let x = window.screenX;
    let y = window.screenY;
    let tx = x, ty = y;
    let pauseUntil = 0;

    const pickTarget = () => {
      const W = window.outerWidth;
      const H = window.outerHeight;
      tx = aL + 10 + Math.random() * Math.max(0, aW - W - 20);
      ty = aT + 10 + Math.random() * Math.max(0, aH - H - 20);
    };
    pickTarget();

    let prev = performance.now();
    let animId: number;

    const tick = (now: number) => {
      const dt = Math.min((now - prev) / 1000, 0.05);
      prev = now;

      if (now < pauseUntil) {
        animId = requestAnimationFrame(tick);
        return;
      }

      const dx = tx - x;
      const dy = ty - y;
      const d  = Math.sqrt(dx * dx + dy * dy);

      if (d < 6) {
        // Reached target — pause then pick new one
        pauseUntil = now + PAUSE_MIN + Math.random() * (PAUSE_MAX - PAUSE_MIN);
        pickTarget();
      } else {
        const step = Math.min(SPEED * dt, d);
        x += (dx / d) * step;
        y += (dy / d) * step;
        window.moveTo(Math.round(x), Math.round(y));
      }

      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, []);

  return null;
}
