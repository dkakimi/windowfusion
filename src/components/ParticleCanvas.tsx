"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import * as THREE from "three";
import { WindowSync, predictCenter } from "@/lib/windowSync";
import type { FusionEvent, WindowInfo } from "@/lib/windowSync";
import {
  BubbleRenderer, screenScale, CAMERA_Z, FOV_DEG,
  WINDOW_PAD, FIT_MARGIN, R_SPAWN_MIN, R_SPAWN_MAX, R_SPLIT_MIN,
  windowSideFor, openBubbleWindow,
} from "@/lib/bubbleRenderer";
import type { GhostInput } from "@/lib/bubbleRenderer";
import {
  shell, makePageTransparent, TITLE_BAR_H, getWindowStyle, setWindowStyle, subscribeWindowStyle,
} from "@/lib/host";
import type { WindowStyle } from "@/lib/host";

// Cruise speed of a 70px bubble (px/s); bigger bubbles drift slower.
const SPEED_BASE  = 115;
const SPEED_RELAX = 0.7;     // 1/s — how fast speed returns to cruise
const HOVER_SLOW  = 0.22;    // cruise multiplier while the cursor rests on the window
const WIND_GAIN   = 1.0;
const GUST_GAIN   = 2.6;     // cursor swipe velocity → acceleration
const PUFF_SPEED  = 260;     // click on empty space pushes the bubble away
const ATTRACT     = 35;      // px/s² pull between nearby bubbles

// Bubbles touch when centers are closer than (r1 + r2) × this
const CONTACT_OVERLAP = 0.6;
// 60% chance of fusion (larger one absorbs), 40% chance both pop
const FUSION_PROB = 0.6;
// No merge / pop (and no mutual attraction) for this long after a window is
// born or split, so a fresh batch can spread out before interacting.
const IMMUNE_MS   = 5000;

// Film drains over this lifetime (s), then the bubble bursts on its own
const LIFE_MIN = 80;
const LIFE_MAX = 160;

// Performance: every window is its own WebGL context on the same GPU, so scale
// quality down as the crowd grows.
const MAX_DPR          = 1.5;
const CROWD_LOW_DPR    = 7;    // ≥ this many other windows → render at 1×
const CROWD_HALF_RATE  = 12;   // ≥ this many → render every other frame
const RESIZE_MIN_MS    = 50;   // resizeTo is costly for the window server
const MAX_GHOSTS       = 4;
// Destroying a window is expensive in the browser/GPU processes that all windows
// share, so closes are serialized across windows with a gap between them.
const CLOSE_LOCK       = "windowfusion-close";
const CLOSE_GAP_MS     = 140;

const rand  = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);
const cruise = (r: number) => SPEED_BASE * Math.pow(70 / Math.max(r, 10), 0.35);

function numParam(p: URLSearchParams, key: string): number | undefined {
  const v = p.get(key);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Shared air current — driven by wall-clock time so all windows feel the same wind.
function wind(x: number, y: number, t: number): [number, number] {
  return [
    60 * Math.sin(y * 0.0021 + t * 0.13) + 35 * Math.sin((x + y) * 0.0013 - t * 0.21),
    45 * Math.cos(x * 0.0018 - t * 0.17) + 30 * Math.sin((x - y) * 0.0011 + t * 0.09),
  ];
}

// Screen-space offset (px, y down) on a bubble of radius r → world-space unit direction.
function surfaceDir(lx: number, ly: number, r: number, out = new THREE.Vector3()): THREE.Vector3 {
  const x = lx / Math.max(r, 1), y = -ly / Math.max(r, 1);
  return out.set(x, y, Math.sqrt(Math.max(0, 1 - x * x - y * y))).normalize();
}

const noopSubscribe = () => () => {};
const readLaunched  = () => new URLSearchParams(window.location.search).get("launched") === "1";
const readElectron  = () => !!shell();

interface WindowActions { close(): void; shrink(): void; grow(): void }

export default function ParticleCanvas() {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const actionsRef = useRef<WindowActions | null>(null);
  const isLaunched = useSyncExternalStore(noopSubscribe, readLaunched, () => false);
  const isElectron = useSyncExternalStore(noopSubscribe, readElectron, () => false);
  const winStyle   = useSyncExternalStore(subscribeWindowStyle, getWindowStyle, () => "glass" as const);

  useEffect(() => {
    if (!isLaunched) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const params = new URLSearchParams(window.location.search);

    // Electron: transparent frameless window — the OS composites overlapping
    // bubbles, so no background and no ghost redraws are needed.
    const wf = shell();
    if (wf) makePageTransparent();
    // Electron: the bubble sits in the square below the title bar
    const topInset = wf ? TITLE_BAR_H : 0;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: !!wf });
    let dpr = Math.min(window.devicePixelRatio, MAX_DPR);
    renderer.setPixelRatio(dpr);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, wf ? 0 : 1);

    const camera = new THREE.PerspectiveCamera(FOV_DEG, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = CAMERA_Z;

    const sync = new WindowSync();
    const br   = new BubbleRenderer({ background: !wf });
    br.init(sync.myId, sync.myColor);

    const s  = screen as Screen & { availLeft?: number; availTop?: number };
    const aL = s.availLeft ?? 0;
    const aT = s.availTop  ?? 0;
    const aW = screen.availWidth;
    const aH = screen.availHeight;
    const rMax = Math.min(aW, aH) / (2 * WINDOW_PAD) * 0.85;

    // ── Bubble state (screen px) ──
    let radius = clamp(numParam(params, "r") ?? rand(R_SPAWN_MIN, R_SPAWN_MAX), 20, rMax);
    // Inflates from a small seed on birth ("blown"), or from a half-size on split
    let dispR = radius * (params.get("birth") === "split" ? 0.7 : 0.12);
    let dispV = 0;

    const chromeH0 = window.outerHeight - window.innerHeight;
    // Electron passes the window center (wx/wy): a hidden window's screenX/Y read 0
    let cx = numParam(params, "wx") ?? window.screenX + window.innerWidth * 0.5;
    let cy = numParam(params, "wy") ?? window.screenY + chromeH0 + window.innerHeight * 0.5;
    const a0 = Math.random() * Math.PI * 2;
    let vx = numParam(params, "vx") ?? Math.cos(a0) * cruise(radius);
    let vy = numParam(params, "vy") ?? Math.sin(a0) * cruise(radius);

    // Bubble lag inside its window (px) — kicks on wall bounces
    let ox = 0, oy = 0, ovx = 0, ovy = 0;

    let alive = true;
    let immuneUntil = Date.now() + IMMUNE_MS;
    let absorbInto: string | null = null;
    let absorbT = 0;
    let lifeT = 0;
    const lifeSpan = rand(LIFE_MIN, LIFE_MAX);

    let lastReq = -1;
    let lastResizeAt = 0;
    let lastBX = NaN, lastBY = NaN;
    let frame = 0;
    let renderR = 0;
    let shown = false;
    let ignoringMouse = true;   // the shell starts bubble windows click-through
    // Title-bar drag: the bubble is held at this offset from the cursor
    let grab: { dx: number; dy: number } | null = null;

    // ── Cursor ──
    let cursor: [number, number] | null = null;   // screen px
    let lastMoveAt = 0;
    let gustX = 0, gustY = 0;
    let pressed = false;

    const contentOrigin = (): [number, number] =>
      [window.screenX, window.screenY + (window.outerHeight - window.innerHeight)];

    const onPointerMove = (e: PointerEvent) => {
      const now = performance.now();
      const p: [number, number] = [e.screenX, e.screenY];
      if (cursor && now - lastMoveAt < 100) {
        const dtm = Math.max((now - lastMoveAt) / 1000, 1 / 240);
        gustX += ((p[0] - cursor[0]) / dtm - gustX) * 0.5;
        gustY += ((p[1] - cursor[1]) / dtm - gustY) * 0.5;
      }
      cursor = p;
      lastMoveAt = now;
    };
    const onPointerLeave = () => { if (!grab) { cursor = null; pressed = false; } };
    const onPointerUp    = () => {
      pressed = false;
      if (!grab) return;
      // Throw with the cursor's release velocity
      grab = null;
      const sp = Math.hypot(gustX, gustY), cap = 1400;
      const k = sp > cap ? cap / sp : 1;
      vx = gustX * 0.9 * k;
      vy = gustY * 0.9 * k;
    };

    // Pending contacts we already resolved (the other side may still look alive briefly)
    const handled = new Set<string>();

    // Go dormant immediately (no rendering, no movement, others forget us), then
    // wait for our turn to actually close. The last frame shows only the
    // screen-anchored background, so a waiting window blends into the backdrop.
    let closing = false;
    const closeSelf = (gapMs = CLOSE_GAP_MS) => {
      if (closing) return;
      closing = true;
      cancelAnimationFrame(animId);
      sync.leave();
      br.updateGhosts([]);
      br.setFade(0);
      renderer.render(br.scene, camera);

      // Electron: the window is hidden and pooled for reuse, never destroyed
      if (wf) {
        renderer.dispose();
        wf.release();
        return;
      }

      const teardown = () => {
        renderer.dispose();
        renderer.forceContextLoss();
        window.close();
      };
      if (!navigator.locks) { teardown(); return; }
      // The lock is released when this page is destroyed, so the next window
      // starts only after our teardown finished, plus a small gap.
      void navigator.locks.request(CLOSE_LOCK, async () => {
        if (gapMs > 0) await new Promise(r => setTimeout(r, gapMs));
        teardown();
        // Hold until the page goes away; time out in case close() was refused
        await new Promise(r => setTimeout(r, 1500));
      });
    };

    const popSelf = (dir: THREE.Vector3) => {
      if (!alive) return;
      alive = false;
      br.pop(dir, () => closeSelf());
    };

    const popToward = (otherId: string) => {
      const o = sync.windows.get(otherId);
      const dir = new THREE.Vector3(0, 1, 0);
      if (o) {
        const [tx, ty] = predictCenter(o);
        dir.set(tx - cx, -(ty - cy), 0);
        if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
      }
      popSelf(dir.normalize());
    };

    const grow = (otherR: number, fromId: string) => {
      radius = Math.min(Math.cbrt(radius ** 3 + otherR ** 3), rMax);
      lifeT *= 0.5;   // fresh film from the merge
      immuneUntil = Date.now() + 500;
      br.jiggle(0.03);
      const o = sync.windows.get(fromId);
      if (o) {
        const [tx, ty] = predictCenter(o);
        br.impact(tx - cx, -(ty - cy), 2.2);
      }
    };

    const beginAbsorb = (survivorId: string) => {
      if (!alive) return;
      alive = false;
      absorbInto = survivorId;
      absorbT = 0;
    };

    const resolveContact = (id: string, o: WindowInfo) => {
      handled.add(id);
      if (Math.random() < FUSION_PROB) {
        if (renderR >= o.radius) {
          sync.sendFusion(sync.myId, id, o.radius);
          grow(o.radius, id);
        } else {
          sync.sendFusion(id, sync.myId, renderR);
          beginAbsorb(id);
        }
      } else {
        sync.sendAnnihilate(sync.myId, id);
        popToward(id);
      }
    };

    sync.onFusionEvent = (event: FusionEvent) => {
      if (!alive) return;
      if (event.type === "fusion") {
        if (event.survivorId === sync.myId) {
          handled.add(event.victimId);
          grow(event.victimRadius, event.victimId);
        } else if (event.victimId === sync.myId) {
          beginAbsorb(event.survivorId);
        }
      } else if (event.id1 === sync.myId || event.id2 === sync.myId) {
        popToward(event.id1 === sync.myId ? event.id2 : event.id1);
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      onPointerMove(e);
      pressed = true;
      if (!alive) return;

      // Title bar: traffic lights handle themselves; anywhere else grabs the bubble
      if (e.clientY < topInset) {
        if ((e.target as HTMLElement).closest("[data-traffic]")) return;
        grab = { dx: cx - e.screenX, dy: cy - e.screenY };
        (e.target as Element).setPointerCapture?.(e.pointerId);
        return;
      }

      const lx = e.clientX - (window.innerWidth  * 0.5 + ox);
      const ly = e.clientY - (window.innerHeight * 0.5 + topInset * 0.5 + oy);
      const d  = Math.hypot(lx, ly);

      if (d > renderR * 1.05) {
        // Puff of air: push the bubble away from the click
        vx -= (lx / (d || 1)) * PUFF_SPEED;
        vy -= (ly / (d || 1)) * PUFF_SPEED;
        br.impact(lx, -ly, 1.2);
        return;
      }

      if (radius < R_SPLIT_MIN) {
        popSelf(surfaceDir(lx, ly, renderR));
        return;
      }

      // Split into two bubbles of equal volume, separating perpendicular to the click
      const rc  = radius / Math.cbrt(2);
      const dxn = d > 1 ? lx / d : 1, dyn = d > 1 ? ly / d : 0;
      const nX  = -dyn, nY = dxn;
      const sep  = rc * 1.15;
      const kick = cruise(rc) * 1.6;
      openBubbleWindow({
        r: rc, cx: cx - nX * sep, cy: cy - nY * sep,
        vx: vx - nX * kick, vy: vy - nY * kick, birth: "split",
      });
      radius = rc;
      cx += nX * sep; cy += nY * sep;
      vx += nX * kick; vy += nY * kick;
      immuneUntil = Date.now() + IMMUNE_MS;
      br.jiggle(0.04);
      br.impact(nX, -nY, 3);
    };

    window.addEventListener("pointermove",  onPointerMove);
    window.addEventListener("pointerdown",  onPointerDown);
    window.addEventListener("pointerup",    onPointerUp);
    document.addEventListener("pointerleave", onPointerLeave);

    const ctrl = new BroadcastChannel("windowfusion-ctrl");
    ctrl.addEventListener("message", (e: MessageEvent) => {
      if (e.data?.type === "close_all") closeSelf(0);
    });
    // Electron menu-bar "Pop All": burst from a random point on the film
    const offCommand = wf?.onCommand(cmd => {
      if (cmd.type === "pop") {
        setTimeout(() => popSelf(new THREE.Vector3().randomDirection()), Math.random() * 400);
      } else if (cmd.type === "style") {
        setWindowStyle(cmd.style);
      } else if (cmd.type === "raised") {
        sync.markRaised(cmd.at);
      }
    });

    // Traffic lights: close = pop, minimize = deflate, zoom = inflate
    actionsRef.current = {
      close:  () => popSelf(new THREE.Vector3(-0.6, 0.6, 0.5).normalize()),
      shrink: () => {
        if (!alive) return;
        radius = Math.max(radius * 0.75, 24);
        br.jiggle(0.035);
        br.impact(0, 1, 2);
      },
      grow: () => {
        if (!alive) return;
        radius = Math.min(radius * 1.3, rMax);
        br.jiggle(0.035);
        br.impact(0, 1, -2);
      },
    };

    const tmpDir = new THREE.Vector3();
    const tmpPos = new THREE.Vector3();
    let last = performance.now();
    let animId: number;

    const loop = () => {
      animId = requestAnimationFrame(loop);

      const now = performance.now();
      const dt  = Math.min((now - last) / 1000, 0.05);
      last = now;
      const wallMs = Date.now();

      const innerW  = window.innerWidth;
      const innerH  = window.innerHeight;
      const chromeW = window.outerWidth  - innerW;
      const chromeH = window.outerHeight - innerH;
      const [orgX, orgY] = contentOrigin();
      const wcX = orgX + innerW * 0.5;
      const wcY = orgY + innerH * 0.5;

      // ── Forces ──
      let ax = 0, ay = 0;
      if (alive) {
        const [wx, wy] = wind(cx, cy, wallMs / 1000);
        ax += wx * WIND_GAIN;
        ay += wy * WIND_GAIN;

        for (const [id, o] of sync.windows) {
          if (!o.alive || !(o.radius > 0)) continue;
          const [tx, ty] = predictCenter(o, wallMs);
          if (!Number.isFinite(tx + ty)) continue;   // malformed / stale heartbeat
          const dx = tx - cx, dy = ty - cy;
          const d  = Math.hypot(dx, dy) || 1;
          const sumR = renderR + o.radius;
          const immune = wallMs < immuneUntil || wallMs < o.immuneUntil;
          if (!immune && d < sumR * 2.5) {
            const f = ATTRACT * (1 - d / (sumR * 2.5));
            ax += (dx / d) * f;
            ay += (dy / d) * f;
          }
          if (
            d < sumR * CONTACT_OVERLAP && !handled.has(id) &&
            sync.myId < id &&   // lower id decides, to avoid duplicates
            !immune
          ) {
            resolveContact(id, o);
            break;
          }
        }
      }

      // ── Cursor: swipe = gust, rest = slow down, near surface = dent ──
      gustX *= Math.exp(-8 * dt);
      gustY *= Math.exp(-8 * dt);
      let calmHover = false;
      let interactive = false;   // cursor over the bubble or the title bar
      tmpDir.set(0, 0, 1);
      let poke = 0;
      if (cursor) {
        const inside = cursor[0] >= orgX && cursor[0] <= orgX + innerW &&
                       cursor[1] >= orgY && cursor[1] <= orgY + innerH;
        if (inside) {
          const lx = cursor[0] - (wcX + ox);
          const ly = cursor[1] - (wcY + topInset * 0.5 + oy);
          const d  = Math.hypot(lx, ly);
          if (alive) {
            const fall = Math.exp(-((d / (renderR * 1.6 + 1)) ** 2));
            ax += gustX * GUST_GAIN * fall;
            ay += gustY * GUST_GAIN * fall;
          }
          calmHover = Math.hypot(gustX, gustY) < 150;
          interactive = d < renderR * 1.05 || cursor[1] - orgY < topInset;
          if (d < renderR * 1.02) {
            surfaceDir(lx, ly, renderR, tmpDir);
            poke = pressed ? 1.0 : 0.55;
          }
        }
      }
      br.setPoke(poke > 0 ? tmpDir : null, poke);

      // Electron glass: the window is see-through, so only the bubble and the
      // title bar catch the mouse; everywhere else clicks reach the desktop.
      // A dark window is solid and catches the mouse everywhere.
      if (wf) {
        const glass = getWindowStyle() === "glass";
        const ignore = (glass && !(interactive || pressed || grab)) || !alive;
        if (ignore !== ignoringMouse) { ignoringMouse = ignore; wf.setIgnoreMouse(ignore); }
      }

      // ── Integrate ──
      if (grab && cursor && alive) {
        // Held by the title bar: follow the cursor
        cx = cursor[0] + grab.dx;
        cy = cursor[1] + grab.dy;
        vx = gustX; vy = gustY;
      } else if (alive) {
        vx += ax * dt;
        vy += ay * dt;
        const sp = Math.hypot(vx, vy);
        const target = cruise(radius) * (calmHover ? HOVER_SLOW : 1);
        if (sp < 1) {
          const a = Math.random() * Math.PI * 2;
          vx = Math.cos(a) * target; vy = Math.sin(a) * target;
        } else {
          const k = 1 + (target / sp - 1) * Math.min(dt * SPEED_RELAX * (calmHover ? 4 : 1), 1);
          vx *= k; vy *= k;
        }
        cx += vx * dt;
        cy += vy * dt;
      } else if (absorbInto) {
        // Drawn into the survivor while shrinking
        absorbT += dt;
        const o = sync.windows.get(absorbInto);
        if (o) {
          const [tx, ty] = predictCenter(o, wallMs);
          const k = 1 - Math.exp(-7 * dt);
          cx += (tx - cx) * k;
          cy += (ty - cy) * k;
        }
        vx = vy = 0;
      }

      // Safety net: a non-finite state would send NaN bounds to the shell
      if (!Number.isFinite(cx + cy + vx + vy)) {
        console.warn("bubble state became non-finite", { cx, cy, vx, vy, gustX, gustY, grab });
        cx = wcX; cy = wcY; vx = vy = 0;
        gustX = gustY = 0;
        grab = null;
      }
      if (!Number.isFinite(ox + oy + ovx + ovy)) { ox = oy = ovx = ovy = 0; }

      // ── Radius: jelly spring toward target; absorbed bubbles collapse ──
      if (absorbInto) {
        dispR *= Math.exp(-5 * dt);
        br.setFade(clamp(1 - absorbT / 0.7, 0, 1));
        if (absorbT > 0.7) { absorbInto = null; closeSelf(); return; }
      } else {
        dispV += (140 * (radius - dispR) - 14 * dispV) * dt;
        dispR += dispV * dt;
      }

      // ── Window size: jump once to the final size for the target radius ──
      // Resizing is expensive (window server + WebGL buffer reallocation), so the
      // window never animates; the bubble's jelly growth plays inside it instead.
      // Absorbed bubbles keep their window as is until it closes.
      const wantSide = Math.round(Math.min(windowSideFor(radius), aW - chromeW, aH - chromeH));
      if (!absorbInto && wantSide !== lastReq && now - lastResizeAt > RESIZE_MIN_MS) {
        if (!wf) {
          try { window.resizeTo(wantSide + chromeW, wantSide + chromeH); } catch { /* browser may deny resize */ }
        }
        lastReq = wantSide;
        lastResizeAt = now;
      }
      const side = lastReq > 0 ? lastReq : wantSide;

      // ── Walls: bounce the window off the screen edges ──
      const half  = side * 0.5;                // horizontal half-extent
      const halfH = (side + topInset) * 0.5;   // vertical half-extent incl. title bar
      // Squash along the wall normal; the bubble keeps sliding toward the wall briefly
      const bounce = (axisX: number, axisY: number, v: number) => {
        br.impact(axisX, axisY, Math.abs(v) * 0.012);
        ovx += axisX * v * 0.6;
        ovy += axisY * v * 0.6;
      };
      if (cx - half < aL) {
        cx = aL + half;
        if (vx < 0) { bounce(1, 0, vx); vx = -vx; }
      }
      if (cx + half + chromeW > aL + aW) {
        cx = aL + aW - half - chromeW;
        if (vx > 0) { bounce(1, 0, vx); vx = -vx; }
      }
      if (cy - halfH - chromeH < aT) {
        cy = aT + halfH + chromeH;
        if (vy < 0) { bounce(0, 1, vy); vy = -vy; }
      }
      if (cy + halfH > aT + aH) {
        cy = aT + aH - halfH;
        if (vy > 0) { bounce(0, 1, vy); vy = -vy; }
      }
      const bx = Math.round(cx - half), by = Math.round(cy - halfH - chromeH);
      if (wf) {
        // Size and position in one call; skipped when nothing changed
        const h = side + topInset;
        if (bx !== lastBX || by !== lastBY || side !== innerW || h !== innerH) wf.setBounds(bx, by, side, h);
      } else {
        window.moveTo(bx, by);
      }
      lastBX = bx; lastBY = by;

      // ── Fit the bubble inside whatever size the window actually has ──
      const fitR = Math.min(innerW, innerH - topInset) / (2 * FIT_MARGIN);
      renderR = Math.max(0, Math.min(dispR, fitR));

      ovx += (-60 * ox - 8 * ovx) * dt;
      ovy += (-60 * oy - 8 * ovy) * dt;
      ox += ovx * dt;
      oy += ovy * dt;
      const maxOff = Math.max(0, Math.min(innerW, innerH - topInset) * 0.5 - renderR * 1.12);
      const offLen = Math.hypot(ox, oy);
      if (offLen > maxOff) { ox *= maxOff / offLen; oy *= maxOff / offLen; }

      // ── Aging: film drains, then bursts at the thin top cap ──
      if (alive) {
        lifeT += dt;
        if (lifeT >= lifeSpan) popSelf(new THREE.Vector3(0.2, 1, 0.4).normalize());
      }
      br.setAge(clamp(lifeT / lifeSpan, 0, 1));

      sync.setState({
        radius: alive || absorbInto ? renderR : 0,
        vx, vy, alive, immuneUntil,
      });

      // ── Render (quality adapts to how many windows share the GPU) ──
      const crowd = sync.windows.size;
      frame++;
      if (crowd >= CROWD_HALF_RATE && frame % 2 === 1) { br.update(dt); return; }
      const wantDpr = crowd >= CROWD_LOW_DPR ? 1 : Math.min(window.devicePixelRatio, MAX_DPR);
      if (wantDpr !== dpr) { dpr = wantDpr; renderer.setPixelRatio(dpr); }
      if (canvas.width !== Math.round(innerW * renderer.getPixelRatio()) ||
          canvas.height !== Math.round(innerH * renderer.getPixelRatio())) {
        renderer.setSize(innerW, innerH);
        camera.aspect = innerW / innerH;
        camera.updateProjectionMatrix();
      }
      const scale = screenScale(innerH);
      br.setView([orgX, orgY], [innerW, innerH], renderer.getPixelRatio());
      br.setBubble(tmpPos.set(ox * scale, -(oy + topInset * 0.5) * scale, 0), renderR * scale);

      // Other bubbles reaching into this window are drawn here when we are on top,
      // since an opaque window (browser, Electron dark) hides whatever is
      // underneath. Electron glass windows let the OS show them instead.
      const myFocus = sync.getMyInfo().focusedAt;
      const ghosts: (GhostInput & { dist: number })[] = [];
      if (!wf || getWindowStyle() === "dark") for (const [id, o] of sync.windows) {
        if (o.radius <= 0 || myFocus <= o.focusedAt) continue;
        const [gx, gy] = predictCenter(o, wallMs);
        if (Math.abs(gx - wcX) > innerW * 0.5 + o.radius) continue;
        if (Math.abs(gy - wcY) > innerH * 0.5 + o.radius) continue;
        ghosts.push({
          id, color: o.color,
          worldPos: new THREE.Vector3((gx - wcX) * scale, -(gy - wcY) * scale, 0),
          worldRadius: o.radius * scale,
          dist: Math.hypot(gx - wcX, gy - wcY),
        });
      }
      ghosts.sort((a, b) => a.dist - b.dist);
      br.updateGhosts(ghosts.slice(0, MAX_GHOSTS));

      br.update(dt);
      renderer.render(br.scene, camera);
      if (wf && !shown) { shown = true; wf.ready(); }
    };

    loop();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup",   onPointerUp);
      document.removeEventListener("pointerleave", onPointerLeave);
      ctrl.close();
      offCommand?.();
      actionsRef.current = null;
      br.dispose();
      sync.destroy();
      renderer.dispose();
    };
  }, [isLaunched]);

  if (!isLaunched) return null;

  return (
    <>
      <canvas ref={canvasRef} style={{ position: "fixed", inset: 0, display: "block", cursor: "pointer" }} />
      {isElectron && <TitleBar actions={actionsRef} winStyle={winStyle} />}
    </>
  );
}

// ─── macOS-style title bar (Electron glass windows) ──────────────────────────
// Drawn in HTML rather than native so each button can drive the bubble
// (native minimize / zoom can't be intercepted).

const TRAFFIC_CSS = `
.wf-lights { display: flex; gap: 8px; }
.wf-light {
  width: 12px; height: 12px; border-radius: 50%; padding: 0; border: none;
  display: grid; place-items: center; cursor: default;
  font: 600 9px/1 -apple-system, system-ui, sans-serif; color: transparent;
  box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.25);
}
.wf-lights:hover .wf-light { color: rgba(0,0,0,0.55); }
.wf-light:active { filter: brightness(0.8); }
`;

const LIGHTS = [
  { key: "close",  color: "#ff5f57", glyph: "×", label: "Pop" },
  { key: "shrink", color: "#febc2e", glyph: "−", label: "Deflate" },
  { key: "grow",   color: "#28c840", glyph: "+", label: "Inflate" },
] as const;

// Glass: the window itself is fully transparent, just a hairline frame (white
// over black, so it reads on light and dark wallpapers) and the traffic lights.
// Dark: a standard macOS dark-mode window behind the (transparent) canvas.
function TitleBar({ actions, winStyle }: {
  actions: React.RefObject<WindowActions | null>;
  winStyle: WindowStyle;
}) {
  const dark = winStyle === "dark";
  return (
    <>
    {dark && <div style={{
      position: "fixed", inset: 0, borderRadius: 10, zIndex: -1, pointerEvents: "none",
      background: `linear-gradient(#3a3a3c, #2c2c2e) 0 0 / 100% ${TITLE_BAR_H}px no-repeat, #1c1c1e`,
    }} />}
    <div style={{
      position: "fixed", inset: 0, borderRadius: 10, pointerEvents: "none",
      boxShadow: dark
        ? "inset 0 0 0 0.5px rgba(0,0,0,0.8), inset 0 0 0 1px rgba(255,255,255,0.12)"
        : "inset 0 0 0 0.5px rgba(0,0,0,0.45), inset 0 0 0 1.5px rgba(255,255,255,0.3)",
    }} />
    {/* Separator between the title bar and the bubble area, same two-tone hairline */}
    <div style={{
      position: "fixed", top: TITLE_BAR_H - 1, left: 1, right: 1, height: 1, pointerEvents: "none",
      background: dark ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.3)",
      boxShadow: dark ? "none" : "0 0.5px 0 rgba(0,0,0,0.45)",
    }} />
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, height: TITLE_BAR_H,
      display: "flex", alignItems: "center", paddingLeft: 9,
      cursor: "grab", userSelect: "none",
    }}>
      <style>{TRAFFIC_CSS}</style>
      <div className="wf-lights" data-traffic>
        {LIGHTS.map(l => (
          <button
            key={l.key}
            className="wf-light"
            aria-label={l.label}
            style={{ background: l.color }}
            onClick={() => actions.current?.[l.key]()}
          >
            {l.glyph}
          </button>
        ))}
      </div>
    </div>
    </>
  );
}
