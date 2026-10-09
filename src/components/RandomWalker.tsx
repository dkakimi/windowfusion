"use client";
import { useEffect } from "react";

const SPEED = 160; // px/s

export function RandomWalker() {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("launched") !== "1") return;

    const s  = screen as Screen & { availLeft?: number; availTop?: number };
    const aL = s.availLeft ?? 0;
    const aT = s.availTop  ?? 0;
    const aW = screen.availWidth;
    const aH = screen.availHeight;

    // Random initial direction, constant speed (DVD-logo style)
    const angle = Math.random() * Math.PI * 2;
    let vx = Math.cos(angle) * SPEED;
    let vy = Math.sin(angle) * SPEED;

    // Start from current window position
    let x = window.screenX;
    let y = window.screenY;

    let paused = false;

    const onEnter = () => { paused = true; };
    const onLeave = () => { paused = false; };
    document.addEventListener("mouseenter", onEnter);
    document.addEventListener("mouseleave", onLeave);

    const ctrl = new BroadcastChannel("windowfusion-ctrl");
    ctrl.addEventListener("message", (e: MessageEvent) => {
      if (e.data?.type === "close_all") window.close();
    });

    let prev = performance.now();
    let animId: number;

    const tick = (now: number) => {
      const dt = Math.min((now - prev) / 1000, 0.05);
      prev = now;

      if (!paused) {
        const W = window.outerWidth;
        const H = window.outerHeight;

        x += vx * dt;
        y += vy * dt;

        // Bounce off screen edges
        if (x <= aL)           { x = aL;           vx =  Math.abs(vx); }
        if (x + W >= aL + aW)  { x = aL + aW - W;  vx = -Math.abs(vx); }
        if (y <= aT)            { y = aT;            vy =  Math.abs(vy); }
        if (y + H >= aT + aH)  { y = aT + aH - H;  vy = -Math.abs(vy); }

        window.moveTo(Math.round(x), Math.round(y));
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
