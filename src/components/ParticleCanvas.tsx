"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { WindowSync } from "@/lib/windowSync";
import { ParticleSystem } from "@/lib/particleSystem";

export default function ParticleCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [shortId, setShortId] = useState("------");
  const [connectedCount, setConnectedCount] = useState(0);
  const [myColor, setMyColor] = useState<[number, number, number]>([1, 1, 1]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);

    const scene  = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);

    const sync = new WindowSync();
    const particles = new ParticleSystem();
    scene.add(particles.points);

    setShortId(sync.myId.slice(-6));
    setMyColor(sync.myColor);

    sync.onWindowsChange = (wins) => setConnectedCount(wins.size);

    const handleResize = () => renderer.setSize(window.innerWidth, window.innerHeight);
    window.addEventListener("resize", handleResize);

    let lastTime = performance.now();
    let animId: number;

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      particles.update(dt, sync.getMyInfo(), sync.windows);
      renderer.render(scene, camera);
    };

    animate();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", handleResize);
      particles.dispose();
      sync.destroy();
      renderer.dispose();
    };
  }, []);

  const cssColor = `rgb(${Math.round(myColor[0]*255)},${Math.round(myColor[1]*255)},${Math.round(myColor[2]*255)})`;

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", display: "block" }}
      />
      <div style={{
        position: "fixed", top: 14, left: 14,
        fontFamily: "ui-monospace, monospace", fontSize: 11,
        lineHeight: 1.7, pointerEvents: "none", userSelect: "none",
        color: "rgba(255,255,255,0.55)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <span style={{
            display: "inline-block", width: 10, height: 10, borderRadius: "50%",
            background: cssColor, boxShadow: `0 0 6px ${cssColor}`,
          }} />
          <span style={{ color: cssColor, fontWeight: 600 }}>WindowFusion</span>
        </div>
        <div>ID: {shortId}</div>
        <div>Windows: {connectedCount + 1}</div>
      </div>
    </>
  );
}
