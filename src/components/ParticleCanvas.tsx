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

    // Renderer
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 1);

    // Scene + perspective camera (matches entangled's approach)
    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = 5;

    // Sync + particles
    const sync = new WindowSync();
    const ps   = new ParticleSystem();
    ps.init(sync.myColor);
    scene.add(ps.group);

    setShortId(sync.myId.slice(-6));
    setMyColor(sync.myColor);
    sync.onWindowsChange = (wins) => setConnectedCount(wins.size);

    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", handleResize);

    let last = performance.now();
    let animId: number;

    const loop = () => {
      animId = requestAnimationFrame(loop);
      const now = performance.now();
      const dt  = Math.min((now - last) / 1000, 0.05);
      last = now;

      ps.update(dt, sync.getMyInfo(), sync.windows);
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
