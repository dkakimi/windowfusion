"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  R_SPAWN_MIN, R_SPAWN_MAX, openBubbleWindow,
  createSoapUniforms, createSoapMaterials, createBackground, updateBackground,
} from "@/lib/bubbleRenderer";
import { shell, makePageTransparent } from "@/lib/host";

const MAX_BATCH    = 5;     // windows per shot at full charge
const CHARGE_SEC   = 1.2;   // hold this long for a full charge
const STAGGER_MS   = 170;   // delay between windows in a batch, so they stream out
const IDLE_AIM     = 0.35;  // rad the wand turns toward the cursor while idle

const CAM_FOV = 35;
const CAM_Z   = 14;

// ─── Wand model (built along +X, rear at x=0, mouth at x=WAND_LEN) ────────────

const WAND_LEN = 9.62;
const MOUTH_R  = 0.5;

function buildWand(): { group: THREE.Group; film: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];

  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x19d43a, roughness: 0.32, metalness: 0,
    clearcoat: 1, clearcoatRoughness: 0.12,
  });
  const dark = new THREE.MeshPhysicalMaterial({ color: 0x0a6a1c, roughness: 0.6 });
  disposables.push(mat, dark);

  const lathe = (pts: [number, number][], m: THREE.Material) => {
    // LatheGeometry revolves (r, y) around Y; rotate so the axis becomes +X.
    const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 72);
    g.rotateZ(-Math.PI / 2);
    disposables.push(g);
    const mesh = new THREE.Mesh(g, m);
    group.add(mesh);
    return mesh;
  };

  // Outer shell: rod → collar → slotted core → tapered body → head with bored mouth
  lathe([
    [0.001, 0.00], [0.15, 0.00], [0.18, 0.04], [0.18, 2.20],
    [0.40, 2.20], [0.42, 2.26], [0.42, 2.40],
    [0.29, 2.40], [0.29, 3.70], [0.42, 3.70],
    [0.62, 8.45],
    [0.84, 8.52], [0.95, 8.66], [0.95, 9.40], [0.91, 9.46],
    [0.74, 9.46], [0.74, 8.95], [0.001, 8.95],
  ], mat);

  // Slots: bars around the grip, leaving dark gaps to the core
  const barGeo = new THREE.BoxGeometry(1.3, 0.1, 0.3);
  disposables.push(barGeo);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const bar = new THREE.Mesh(barGeo, mat);
    bar.position.set(3.05, Math.cos(a) * 0.37, Math.sin(a) * 0.37);
    bar.rotation.x = -a;
    group.add(bar);
  }
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.3, 32), dark);
  disposables.push(core.geometry);
  core.rotation.z = Math.PI / 2;
  core.position.x = 3.05;
  group.add(core);

  // Inner crown ring with teeth, sitting in the bore
  lathe([[0.52, 8.95], [0.62, 8.95], [0.62, 9.48], [0.52, 9.48]], mat);
  const toothGeo = new THREE.BoxGeometry(0.16, 0.13, 0.15);
  disposables.push(toothGeo);
  const TEETH = 14;
  for (let i = 0; i < TEETH; i++) {
    const a = (i / TEETH) * Math.PI * 2;
    const t = new THREE.Mesh(toothGeo, mat);
    t.position.set(9.56, Math.cos(a) * 0.57, Math.sin(a) * 0.57);
    t.rotation.x = -a;
    group.add(t);
  }

  // Soap film across the mouth — bulges outward while blowing
  const film = new THREE.Group();
  const filmU = createSoapUniforms();
  filmU.uAge.value = 0.1;
  const filmGeo = new THREE.SphereGeometry(1, 48, 32);
  disposables.push(filmGeo);
  for (const m of createSoapMaterials(filmU)) {
    disposables.push(m);
    film.add(new THREE.Mesh(filmGeo, m));
  }
  film.position.x = 9.5;
  film.scale.set(0.05, MOUTH_R, MOUTH_R);
  film.userData.uniforms = filmU;
  group.add(film);

  return { group, film, dispose: () => disposables.forEach(d => d.dispose()) };
}

const noopSubscribe = () => () => {};
// The launcher (wand) is the browser-version control page only: hidden in
// bubble windows and in the Electron cursor-ring overlay.
const readLaunched  = () => {
  const p = new URLSearchParams(window.location.search);
  return p.get("launched") === "1" || p.get("ring") === "1";
};
const readElectron  = () => !!shell();

const btnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  color: "rgba(255,255,255,0.7)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  padding: "9px 18px",
  fontFamily: "ui-monospace, monospace",
  fontSize: 12,
  cursor: "pointer",
  letterSpacing: "0.04em",
  transition: "background 0.15s",
};

export function Launcher() {
  // Hidden on the server and inside bubble windows
  const isLaunched = useSyncExternalStore(noopSubscribe, readLaunched, () => true);
  const isElectron = useSyncExternalStore(noopSubscribe, readElectron, () => false);
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (isLaunched) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Electron: transparent window — the wand floats directly on the desktop
    const wf = shell();
    if (wf) makePageTransparent();

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: !!wf });
    renderer.setClearColor(0x000000, wf ? 0 : 1);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(CAM_FOV, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = CAM_Z;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-4, 6, 8);
    scene.add(key);

    const bg = wf ? null : createBackground();
    if (bg) scene.add(bg);

    const wand = buildWand();
    scene.add(wand.group);
    const filmU = wand.film.userData.uniforms as ReturnType<typeof createSoapUniforms>;

    // Aim guide: dashed line from the mouth toward the cursor while dragging
    const guideGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const guideMat = new THREE.LineDashedMaterial({
      color: 0xffffff, dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0,
    });
    const guide = new THREE.Line(guideGeo, guideMat);
    guide.frustumCulled = false;
    scene.add(guide);

    // ── Layout ──
    const dirBase = new THREE.Vector3(1, 0.42, 0.5).normalize();
    const baseAngle = Math.atan2(dirBase.y, dirBase.x);
    const center = new THREE.Vector3();
    let halfW = 1, halfH = 1, wandScale = 1;
    const layout = () => {
      halfH = Math.tan(THREE.MathUtils.degToRad(CAM_FOV / 2)) * CAM_Z;
      halfW = halfH * camera.aspect;
      wandScale = Math.min(0.78 * halfW / (WAND_LEN * dirBase.x), 1.2 * halfH / (WAND_LEN * dirBase.y));
      center.set(-0.32 * halfW, -0.32 * halfH, 0);
    };
    layout();

    // ── Input: press → drag to aim → release to blow ──
    const cursor = new THREE.Vector2(0.6, 0.5);   // NDC
    let holding = false;
    let charge  = 0;       // 0..1 while holding
    let blow    = 0;       // film bulge, decays after release
    let aimAngle = baseAngle;
    const onMove = (e: PointerEvent) => {
      cursor.set(e.clientX / window.innerWidth * 2 - 1, 1 - e.clientY / window.innerHeight * 2);
    };
    const onDown = (e: PointerEvent) => {
      if (e.target !== canvas || e.button !== 0) return;
      onMove(e);
      holding = true;
      charge  = 0;
      canvas.setPointerCapture(e.pointerId);
    };
    const onUp = (e: PointerEvent) => {
      if (!holding) return;
      onMove(e);
      holding = false;
      // Point exactly at the release position before opening
      aimAngle = targetAngle(Infinity);
      updateWand();
      launch(1 + Math.round(charge * (MAX_BATCH - 1)), charge);
      blow = 1;
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup",   onUp);
    window.addEventListener("pointermove", onMove);

    const dir   = new THREE.Vector3();
    const mouth = new THREE.Vector3();
    const bob   = new THREE.Vector3();
    const xAxis = new THREE.Vector3(1, 0, 0);

    // Angle (in the screen plane) from the wand center to the cursor, limited to ±range
    const targetAngle = (range: number) => {
      const a = Math.atan2(cursor.y * halfH - center.y, cursor.x * halfW - center.x);
      const delta = Math.atan2(Math.sin(a - baseAngle), Math.cos(a - baseAngle));
      return baseAngle + THREE.MathUtils.clamp(delta, -range, range);
    };

    const updateWand = () => {
      const hxy = Math.sqrt(1 - dirBase.z * dirBase.z);
      dir.set(Math.cos(aimAngle) * hxy, Math.sin(aimAngle) * hxy, dirBase.z).normalize();
      const len = WAND_LEN * wandScale;
      wand.group.position.copy(center).add(bob).addScaledVector(dir, -len / 2);
      wand.group.quaternion.setFromUnitVectors(xAxis, dir);
      wand.group.scale.setScalar(wandScale);
      mouth.copy(center).add(bob).addScaledVector(dir, len / 2);
    };

    // Mouth position and blow direction in screen px — used to place new windows
    const mouthOnScreen = () => {
      const chromeH = window.outerHeight - window.innerHeight;
      const toScreen = (v: THREE.Vector3): [number, number] => {
        const p = v.clone().project(camera);
        return [
          window.screenX + (p.x + 1) * 0.5 * window.innerWidth,
          window.screenY + chromeH + (1 - p.y) * 0.5 * window.innerHeight,
        ];
      };
      const [mx, my] = toScreen(mouth);
      const [fx, fy] = toScreen(mouth.clone().addScaledVector(dir, 1));
      const len = Math.hypot(fx - mx, fy - my) || 1;
      return { mx, my, dx: (fx - mx) / len, dy: (fy - my) / len };
    };

    // Window bubbles fly out of the mouth along the aimed direction.
    // A stronger charge shoots faster, with bigger bubbles.
    const launch = (count: number, power: number) => {
      const { mx, my, dx, dy } = mouthOnScreen();
      const spawn = () => {
        const r = R_SPAWN_MIN + (0.3 + 0.7 * Math.random() * (0.4 + 0.6 * power)) * (R_SPAWN_MAX - R_SPAWN_MIN);
        const spread = count > 1 ? (Math.random() - 0.5) * 0.5 : 0;
        const vdx = dx * Math.cos(spread) - dy * Math.sin(spread);
        const vdy = dx * Math.sin(spread) + dy * Math.cos(spread);
        const speed = 240 + power * 260 + Math.random() * 80;
        openBubbleWindow({
          r, cx: mx + vdx * r * 1.4, cy: my + vdy * r * 1.4,
          vx: vdx * speed, vy: vdy * speed, birth: "blow",
        });
      };
      // The first window uses the click's user activation; the rest only open
      // when the browser allows pop-ups for this site.
      const launchedAt = Date.now();
      spawn();
      for (let i = 1; i < count; i++) setTimeout(spawn, i * STAGGER_MS);

      // window.open returns null with noopener, so check that each new window
      // actually came alive by counting fresh heartbeats.
      // (Electron has no pop-up blocking)
      if (!wf) setTimeout(() => {
        let arrived = 0;
        for (const t of firstSeen.values()) if (t >= launchedAt) arrived++;
        setBlocked(arrived < count);
      }, count * STAGGER_MS + 2500);
    };

    // Track bubble windows by their heartbeats (id → first seen, wall-clock ms)
    const firstSeen = new Map<string, number>();
    const hb = new BroadcastChannel("windowfusion");
    hb.addEventListener("message", (e: MessageEvent<{ type: string; id: string }>) => {
      if (e.data?.type === "heartbeat" && !firstSeen.has(e.data.id)) firstSeen.set(e.data.id, Date.now());
    });

    let last = performance.now();
    let animId: number;
    let time = 0;
    let shown = false;

    const loop = () => {
      animId = requestAnimationFrame(loop);
      const now = performance.now();
      const dt  = Math.min((now - last) / 1000, 0.05);
      last = now;
      time += dt;

      const w = window.innerWidth, h = window.innerHeight;
      if (canvas.width !== Math.round(w * renderer.getPixelRatio()) ||
          canvas.height !== Math.round(h * renderer.getPixelRatio())) {
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        layout();
      }

      // ── Charge while held; release snaps the film back ──
      if (holding) charge = Math.min(charge + dt / CHARGE_SEC, 1);
      else blow *= Math.exp(-6 * dt);

      // ── Aim: follows the cursor fully while dragging, only a little when idle ──
      const want = targetAngle(holding ? Infinity : IDLE_AIM);
      const delta = Math.atan2(Math.sin(want - aimAngle), Math.cos(want - aimAngle));
      aimAngle += delta * Math.min(dt * (holding ? 14 : 3), 1);

      // Float gently; pull back like a slingshot while charging
      bob.set(Math.sin(time * 0.7) * 0.05, Math.sin(time * 0.9 + 1) * 0.08, 0);
      updateWand();
      if (holding) {
        bob.addScaledVector(dir, -charge * 0.35 * wandScale);
        bob.x += (Math.random() - 0.5) * 0.03 * charge;   // trembles at full charge
        bob.y += (Math.random() - 0.5) * 0.03 * charge;
        updateWand();
      }

      // Mouth film swells with the charge, then pops back after the shot
      const swell = holding ? charge : blow;
      const bulge = 0.05 + swell * 0.6 + Math.sin(time * 9) * 0.03 * swell;
      wand.film.scale.set(bulge * MOUTH_R, MOUTH_R, MOUTH_R);
      filmU.uTime.value = time;
      filmU.uWobble.value = 0.02 * swell;

      // Aim guide
      guideMat.opacity += ((holding ? 0.45 : 0) - guideMat.opacity) * Math.min(dt * 10, 1);
      const reach = (4 + charge * 6) * wandScale;
      const pts = guideGeo.getAttribute("position") as THREE.BufferAttribute;
      pts.setXYZ(0, mouth.x + dir.x * 0.5 * wandScale, mouth.y + dir.y * 0.5 * wandScale, mouth.z);
      pts.setXYZ(1, mouth.x + dir.x * reach, mouth.y + dir.y * reach, mouth.z);
      pts.needsUpdate = true;
      guide.computeLineDistances();

      const chromeH = window.outerHeight - window.innerHeight;
      if (bg) updateBackground(bg.material, [window.screenX, window.screenY + chromeH], [w, h], renderer.getPixelRatio());

      renderer.render(scene, camera);
      if (wf && !shown) { shown = true; wf.ready(); }
    };
    loop();

    return () => {
      cancelAnimationFrame(animId);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup",   onUp);
      window.removeEventListener("pointermove", onMove);
      hb.close();
      wand.dispose();
      guideGeo.dispose();
      guideMat.dispose();
      bg?.geometry.dispose();
      bg?.material.dispose();
      envRT.dispose();
      pmrem.dispose();
      renderer.dispose();
    };
  }, [isLaunched]);

  if (isLaunched) return null;

  const handleCloseAll = () => {
    const ch = new BroadcastChannel("windowfusion-ctrl");
    ch.postMessage({ type: "close_all" });
    ch.close();
  };

  return (
    <>
      <canvas ref={canvasRef} style={{ position: "fixed", inset: 0, display: "block", cursor: "crosshair", touchAction: "none" }} />
      {isElectron && (
        // Frameless window: this strip moves it
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, height: 34,
          display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px",
          fontFamily: "ui-monospace, monospace", fontSize: 11, letterSpacing: "0.08em",
          color: "rgba(255,255,255,0.4)", userSelect: "none",
          WebkitAppRegion: "drag",
        } as React.CSSProperties}>
          <span>⠿ WINDOWFUSION</span>
          <button
            onClick={() => shell()?.quit()}
            style={{ ...btnStyle, padding: "3px 10px", fontSize: 11, WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            Quit
          </button>
        </div>
      )}
      {blocked && (
        <div style={{
          position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)",
          maxWidth: "min(560px, calc(100vw - 32px))",
          background: "rgba(255,180,60,0.12)", border: "1px solid rgba(255,180,60,0.35)",
          color: "rgba(255,225,180,0.95)", borderRadius: 8, padding: "10px 14px",
          fontFamily: "ui-monospace, monospace", fontSize: 12, lineHeight: 1.6,
        }}>
          ブラウザがポップアップをブロックしました。1クリックで開けるウィンドウは通常1つまでです。
          アドレスバー右端のアイコンから、このサイトのポップアップを「常に許可」すると、まとめて吹き出せます。
        </div>
      )}
      <div style={{ position: "fixed", bottom: 24, right: 24, display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{
          fontFamily: "ui-monospace, monospace", fontSize: 11, marginRight: 8,
          color: "rgba(255,255,255,0.35)", letterSpacing: "0.04em",
        }}>
          drag to aim · release to blow · hold longer = more
        </span>
        <button
          onClick={handleCloseAll}
          style={btnStyle}
          onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,80,80,0.18)")}
          onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
        >
          Close All
        </button>
      </div>
    </>
  );
}
