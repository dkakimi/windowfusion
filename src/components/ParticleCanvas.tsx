"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { WindowSync } from "@/lib/windowSync";
import { ParticleSystem, screenScale, isOverlapping, CAMERA_Z, FOV_DEG } from "@/lib/particleSystem";
import type { GhostInput } from "@/lib/particleSystem";

// Spring-mass constants for inertia
const SPRING_K  = 6;    // spring stiffness
const DAMPING   = 2.5;  // exponential decay rate (per second)
const INERTIA   = 0.85; // fraction of window displacement applied to orb

export default function ParticleCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [shortId,        setShortId]        = useState("------");
  const [connectedCount, setConnectedCount] = useState(0);
  const [myColor,        setMyColor]        = useState<[number, number, number]>([1, 1, 1]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // ── Renderer ──────────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 1);

    // ── Scene + camera ────────────────────────────────────────────────────────
    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV_DEG, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = CAMERA_Z;

    // ── Sync + particle system ────────────────────────────────────────────────
    const sync = new WindowSync();
    const ps   = new ParticleSystem();
    ps.init(sync.myColor);

    // ghost orbs sit in world space (not moved by inertia)
    scene.add(ps.ghostGroup);
    // main orb group position will be updated each frame for inertia
    scene.add(ps.orbGroup);

    setShortId(sync.myId.slice(-6));
    setMyColor(sync.myColor);
    sync.onWindowsChange = (wins) => setConnectedCount(wins.size);

    // ── Resize ────────────────────────────────────────────────────────────────
    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", handleResize);

    // ── Inertia state ─────────────────────────────────────────────────────────
    let orbX = 0, orbY = 0;   // world-space displacement from centre
    let orbVX = 0, orbVY = 0; // velocity (world units / s)

    let prevSX = window.screenX;
    let prevSY = window.screenY + (window.outerHeight - window.innerHeight);

    // ── Animation loop ────────────────────────────────────────────────────────
    let last = performance.now();
    let animId: number;

    const loop = () => {
      animId = requestAnimationFrame(loop);

      const now = performance.now();
      const dt  = Math.min((now - last) / 1000, 0.05);
      last = now;

      const myInfo = sync.getMyInfo();
      const scale  = screenScale(myInfo.height);

      // ── Inertia: window moved → orb lags opposite direction ───────────────
      const dsx = myInfo.screenX - prevSX;
      const dsy = myInfo.screenY - prevSY;
      prevSX = myInfo.screenX;
      prevSY = myInfo.screenY;

      // Apply displacement (screen px → world units, Y inverted)
      orbX -= dsx * scale * INERTIA;
      orbY += dsy * scale * INERTIA;

      // Spring toward centre
      orbVX += -SPRING_K * orbX * dt;
      orbVY += -SPRING_K * orbY * dt;

      // Integrate
      orbX += orbVX * dt;
      orbY += orbVY * dt;

      // Exponential damping
      const damp = Math.exp(-DAMPING * dt);
      orbVX *= damp;
      orbVY *= damp;

      ps.orbGroup.position.set(orbX, orbY, 0);

      // ── Ghost orbs: overlapping lower-z windows appear on our canvas ───────
      const ghosts: GhostInput[] = [];
      for (const [id, other] of sync.windows) {
        if (!isOverlapping(myInfo, other)) continue;
        // I'm on top when my focusedAt is more recent
        if (myInfo.focusedAt <= other.focusedAt) continue;

        const dx =  (other.screenX + other.width  * 0.5 - (myInfo.screenX + myInfo.width  * 0.5)) * scale;
        const dy = -(other.screenY + other.height * 0.5 - (myInfo.screenY + myInfo.height * 0.5)) * scale;
        ghosts.push({ id, color: other.color, worldPos: new THREE.Vector3(dx, dy, 0) });
      }
      ps.updateGhosts(ghosts);

      // ── Particle simulation ───────────────────────────────────────────────
      ps.update(dt, myInfo, sync.windows);
      renderer.render(scene, camera);
    };

    loop();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", handleResize);
      ps.dispose();
      sync.destroy();
      renderer.dispose();
    };
  }, []);

  const cssColor = `rgb(${myColor.map(c => Math.round(c * 255)).join(",")})`;

  return (
    <>
      <canvas ref={canvasRef} style={{ position: "fixed", inset: 0, display: "block" }} />
      <div style={{
        position: "fixed", top: 14, left: 14,
        fontFamily: "ui-monospace, monospace", fontSize: 11,
        lineHeight: 1.7, pointerEvents: "none", userSelect: "none",
        color: "rgba(255,255,255,0.45)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <span style={{
            display: "inline-block", width: 9, height: 9, borderRadius: "50%",
            background: cssColor, boxShadow: `0 0 8px ${cssColor}`,
          }} />
          <span style={{ color: cssColor, fontWeight: 600 }}>WindowFusion</span>
        </div>
        <div>ID: {shortId}</div>
        <div>Windows: {connectedCount + 1}</div>
      </div>
    </>
  );
}
