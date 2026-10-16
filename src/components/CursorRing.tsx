"use client";

// Electron blow-mode overlay: a soap-film ring that follows the cursor. The main
// process moves this window and streams the cursor velocity; the film stretches
// into a trailing bag as you swing, and snaps back when a bubble breaks off.

import { useEffect, useRef, useSyncExternalStore } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { screenScale, CAMERA_Z, FOV_DEG, createSoapUniforms, createSoapMaterials } from "@/lib/bubbleRenderer";
import { shell, makePageTransparent } from "@/lib/host";
import type { RingState } from "@/lib/host";

const RING_R_PX   = 30;    // ring radius on screen
const STRETCH_MAX = 1.6;   // film length (× radius) at full stretch
const TILT_MAX    = 0.5;   // rad the ring leans into the swing

const noopSubscribe = () => () => {};
const readRing = () => new URLSearchParams(window.location.search).get("ring") === "1";

export function CursorRing() {
  const isRing = useSyncExternalStore(noopSubscribe, readRing, () => false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!isRing) return;
    const canvas = canvasRef.current;
    const wf = shell();
    if (!canvas || !wf) return;
    makePageTransparent();

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV_DEG, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = CAMERA_Z;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;

    const R = RING_R_PX * screenScale(window.innerHeight);

    // Tilting group: the ring and its film lean into the swing
    const tilt = new THREE.Group();
    scene.add(tilt);

    const ringGeo = new THREE.TorusGeometry(R, R * 0.05, 20, 96);
    const ringMat = new THREE.MeshPhysicalMaterial({
      color: 0xf4f7ff, roughness: 0.18, metalness: 0.1,
      clearcoat: 1, iridescence: 1, iridescenceIOR: 1.35,
    });
    tilt.add(new THREE.Mesh(ringGeo, ringMat));

    // Film: a flattened soap sphere filling the ring; `trail` points it along
    // the trailing direction so it can stretch out behind the ring.
    const trail = new THREE.Group();
    tilt.add(trail);
    const filmU = createSoapUniforms();
    filmU.uAge.value = 0.15;
    filmU.uGlow.value = 0.1;   // a ring's film catches light across its whole face
    const filmGeo  = new THREE.SphereGeometry(1, 64, 32);
    const filmMats = createSoapMaterials(filmU);
    const film = new THREE.Group();
    for (const [i, m] of filmMats.entries()) {
      const mesh = new THREE.Mesh(filmGeo, m);
      mesh.renderOrder = 1 + i;
      film.add(mesh);
    }
    trail.add(film);

    // ── State from the main process ──
    let state: RingState = { vx: 0, vy: 0, stretch: 0, released: false };
    let shownS = 0, shownV = 0;      // displayed stretch (spring → wobble on release)
    let trailAngle = 0;
    const offRing = wf.onRing(s => {
      state = s;
      if (s.released) { filmU.uWobble.value = 0.05; shownV -= 4; }
    });

    let last = performance.now();
    let time = 0;
    let animId: number;
    const loop = () => {
      animId = requestAnimationFrame(loop);
      const now = performance.now();
      const dt  = Math.min((now - last) / 1000, 0.05);
      last = now;
      time += dt;

      const speed = Math.hypot(state.vx, state.vy);

      // Film follows the stretch with a springy lag; snapping back overshoots
      shownV += (220 * (state.stretch - shownS) - 14 * shownV) * dt;
      shownS += shownV * dt;
      const s = Math.max(shownS, -0.15);

      // Trailing direction (world, y up) — only re-aim while actually moving
      if (speed > 60) {
        const want = Math.atan2(state.vy, -state.vx);   // opposite to motion, y flipped
        const d = Math.atan2(Math.sin(want - trailAngle), Math.cos(want - trailAngle));
        trailAngle += d * Math.min(dt * 12, 1);
      }
      trail.rotation.z = trailAngle;

      // Elongate behind the ring; the leading edge stays in the ring
      const len = 1 + s * STRETCH_MAX;
      film.scale.set(R * len, R * (1 - s * 0.18), R * (0.06 + Math.max(s, 0) * 0.6));
      film.position.x = R * (len - 1);

      // Lean into the swing
      const lean = Math.min(speed / 1500, 1) * TILT_MAX;
      tilt.rotation.x += ((state.vy / (speed || 1)) * lean - tilt.rotation.x) * Math.min(dt * 8, 1);
      tilt.rotation.y += ((state.vx / (speed || 1)) * lean - tilt.rotation.y) * Math.min(dt * 8, 1);

      filmU.uTime.value = time;
      filmU.uWobble.value *= Math.exp(-3 * dt);
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(animId);
      offRing();
      ringGeo.dispose();
      ringMat.dispose();
      filmGeo.dispose();
      filmMats.forEach(m => m.dispose());
      envRT.dispose();
      pmrem.dispose();
      renderer.dispose();
    };
  }, [isRing]);

  if (!isRing) return null;
  return <canvas ref={canvasRef} style={{ position: "fixed", inset: 0, display: "block", pointerEvents: "none" }} />;
}
