"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { WindowSync } from "@/lib/windowSync";
import type { FusionEvent } from "@/lib/windowSync";
import { ParticleSystem, screenScale, isOverlapping, centerDistPx, CAMERA_Z, FOV_DEG } from "@/lib/particleSystem";
import type { GhostInput } from "@/lib/particleSystem";

const SPRING_K = 6;
const DAMPING  = 2.5;
const INERTIA  = 0.85;

// Centers must be within this many px for fusion/annihilate to trigger
const MERGE_DIST_PX = 180;

// 60% chance of fusion (survivor grows), 40% chance of annihilate (both pop)
const FUSION_PROB = 0.6;

export default function ParticleCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [shortId,        setShortId]        = useState("------");
  const [connectedCount, setConnectedCount] = useState(0);
  const [myColor,        setMyColor]        = useState<[number, number, number]>([1, 1, 1]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 1);

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV_DEG, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = CAMERA_Z;

    const sync = new WindowSync();
    const ps   = new ParticleSystem();
    ps.init(sync.myColor);

    scene.add(ps.ghostGroup);
    scene.add(ps.orbGroup);

    setShortId(sync.myId.slice(-6));
    setMyColor(sync.myColor);
    sync.onWindowsChange = (wins) => setConnectedCount(wins.size);

    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", handleResize);

    // Inertia state
    let orbX = 0, orbY = 0;
    let orbVX = 0, orbVY = 0;
    let prevSX = window.screenX;
    let prevSY = window.screenY + (window.outerHeight - window.innerHeight);

    // Ambient pop timer
    let popTimer = Math.random() * 8 + 6;

    // Prevent double-triggering the same pair
    const triggered    = new Set<string>();
    let eventInProgress = false;

    // Handle fusion events from other windows
    sync.onFusionEvent = (event: FusionEvent) => {
      if (eventInProgress) return;

      if (event.type === "fusion") {
        if (event.survivorId === sync.myId) {
          // I survive: grow and expand window
          eventInProgress = true;
          ps.triggerMergeGrow();
          setTimeout(() => {
            try {
              window.resizeTo(
                Math.round(window.outerWidth  * 1.25),
                Math.round(window.outerHeight * 1.25),
              );
            } catch { /* browser may deny resize */ }
          }, 300);
        } else if (event.victimId === sync.myId) {
          // I'm absorbed: shrink then close
          eventInProgress = true;
          ps.triggerAbsorb(() => {
            setTimeout(() => window.close(), 100);
          });
        }
      } else {
        // annihilate
        if (event.id1 === sync.myId || event.id2 === sync.myId) {
          eventInProgress = true;
          ps.triggerPop(() => {
            setTimeout(() => window.close(), 150);
          });
        }
      }
    };

    let last = performance.now();
    let animId: number;

    const loop = () => {
      animId = requestAnimationFrame(loop);

      const now = performance.now();
      const dt  = Math.min((now - last) / 1000, 0.05);
      last = now;

      const myInfo = sync.getMyInfo();
      const scale  = screenScale(myInfo.height);

      // Inertia
      const dsx = myInfo.screenX - prevSX;
      const dsy = myInfo.screenY - prevSY;
      prevSX = myInfo.screenX;
      prevSY = myInfo.screenY;

      orbX -= dsx * scale * INERTIA;
      orbY += dsy * scale * INERTIA;
      orbVX += -SPRING_K * orbX * dt;
      orbVY += -SPRING_K * orbY * dt;
      orbX  += orbVX * dt;
      orbY  += orbVY * dt;
      const damp = Math.exp(-DAMPING * dt);
      orbVX *= damp;
      orbVY *= damp;
      ps.orbGroup.position.set(orbX, orbY, 0);

      // Ambient pop
      if (!eventInProgress) {
        popTimer -= dt;
        if (popTimer <= 0) {
          ps.triggerPop();
          popTimer = Math.random() * 9 + 6;
        }
      }

      // Proximity scale (subtle hint before merge)
      let anyNear = false;
      for (const [, other] of sync.windows) {
        if (centerDistPx(myInfo, other) < MERGE_DIST_PX * 2) { anyNear = true; break; }
      }
      ps.setNearby(anyNear);

      // ── Center-overlap detection → fusion or annihilate ───────────────────
      if (!eventInProgress) {
        for (const [otherId, other] of sync.windows) {
          if (triggered.has(otherId)) continue;
          if (centerDistPx(myInfo, other) >= MERGE_DIST_PX) continue;
          // Only the window with the lower ID initiates to prevent duplicates
          if (sync.myId >= otherId) continue;

          triggered.add(otherId);
          eventInProgress = true;

          if (Math.random() < FUSION_PROB) {
            // I survive, other is absorbed
            sync.sendFusion(sync.myId, otherId);
            ps.triggerMergeGrow();
            setTimeout(() => {
              try {
                window.resizeTo(
                  Math.round(window.outerWidth  * 1.25),
                  Math.round(window.outerHeight * 1.25),
                );
              } catch { /* browser may deny resize */ }
            }, 300);
          } else {
            // Both annihilate
            sync.sendAnnihilate(sync.myId, otherId);
            ps.triggerPop(() => {
              setTimeout(() => window.close(), 150);
            });
          }
          break; // handle one collision per frame
        }
      }

      // ── Ghost orbs (overlapping windows) ─────────────────────────────────
      const ghosts: GhostInput[] = [];
      for (const [id, other] of sync.windows) {
        if (!isOverlapping(myInfo, other)) continue;
        if (myInfo.focusedAt <= other.focusedAt) continue;
        const dx =  (other.screenX + other.width  * 0.5 - (myInfo.screenX + myInfo.width  * 0.5)) * scale;
        const dy = -(other.screenY + other.height * 0.5 - (myInfo.screenY + myInfo.height * 0.5)) * scale;
        ghosts.push({ id, color: other.color, worldPos: new THREE.Vector3(dx, dy, 0) });
      }
      ps.updateGhosts(ghosts);

      ps.update(dt);
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
