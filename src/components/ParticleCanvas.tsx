"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { WindowSync } from "@/lib/windowSync";
import { ParticleSystem } from "@/lib/particleSystem";

export default function ParticleCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [windowId, setWindowId] = useState<string>("");
  const [connectedCount, setConnectedCount] = useState<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // --- Three.js setup ---
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();

    // Use OrthographicCamera matching screen size; we do our own NDC projection in the shader
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);

    // --- Systems ---
    const windowSync = new WindowSync();
    const particleSystem = new ParticleSystem();
    scene.add(particleSystem.points);

    setWindowId(windowSync.myId);

    windowSync.onWindowsChange = (windows) => {
      setConnectedCount(windows.size);
    };

    // --- Resize handler ---
    const handleResize = () => {
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", handleResize);

    // --- Animation loop ---
    let lastTime = performance.now();
    let animId: number;

    const animate = () => {
      animId = requestAnimationFrame(animate);

      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.05); // cap at 50ms
      lastTime = now;

      const myInfo = windowSync.getMyInfo();
      const others = windowSync.windows;

      particleSystem.update(dt, myInfo, others);
      renderer.render(scene, camera);
    };

    animate();

    // --- Cleanup ---
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", handleResize);
      particleSystem.dispose();
      windowSync.destroy();
      renderer.dispose();
    };
  }, []);

  const shortId = windowId ? windowId.slice(-6) : "------";

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100vw",
          height: "100vh",
          display: "block",
        }}
      />
      <div
        style={{
          position: "fixed",
          top: 16,
          left: 16,
          color: "rgba(180, 220, 255, 0.7)",
          fontFamily: "monospace",
          fontSize: "12px",
          lineHeight: "1.6",
          pointerEvents: "none",
          userSelect: "none",
          textShadow: "0 0 8px rgba(100, 180, 255, 0.8)",
        }}
      >
        <div>WindowFusion</div>
        <div>ID: {shortId}</div>
        <div>Windows: {connectedCount + 1}</div>
      </div>
    </>
  );
}
