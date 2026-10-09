import * as THREE from "three";
import type { WindowInfo } from "./windowSync";

const ORB_PARTICLES    = 10000;
const SPHERE_RADIUS    = 1.8;
const NUCLEUS_FRACTION = 0.5;
const STREAM_PARTICLES = 3000;
const STREAM_RANGE_PX  = 500;
export const CAMERA_Z  = 5;
export const FOV_DEG   = 75;

// pixels → world-units scale at z=0
export function screenScale(innerH: number): number {
  return Math.tan((FOV_DEG * 0.5) * (Math.PI / 180)) * CAMERA_Z / (innerH * 0.5);
}

function edgeDistPx(a: WindowInfo, b: WindowInfo): number {
  const hGap = Math.max(0, Math.max(a.screenX, b.screenX) - Math.min(a.screenX + a.width,  b.screenX + b.width));
  const vGap = Math.max(0, Math.max(a.screenY, b.screenY) - Math.min(a.screenY + a.height, b.screenY + b.height));
  return Math.sqrt(hGap * hGap + vGap * vGap);
}

export function isOverlapping(a: WindowInfo, b: WindowInfo): boolean {
  return !(
    a.screenX + a.width  <= b.screenX ||
    b.screenX + b.width  <= a.screenX ||
    a.screenY + a.height <= b.screenY ||
    b.screenY + b.height <= a.screenY
  );
}

// ─── Geometry builders ────────────────────────────────────────────────────────

function buildOrbGeo(
  myColor: [number, number, number],
  otherColors: [number, number, number][]
): THREE.BufferGeometry {
  const n   = ORB_PARTICLES;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const nuc = Math.floor(n * NUCLEUS_FRACTION);
  const all = [myColor, ...otherColors];

  for (let i = 0; i < n; i++) {
    let radius: number, density: number;
    if (i < nuc) {
      radius  = SPHERE_RADIUS * 0.4 * Math.pow(Math.random(), 0.3);
      density = 1.0;
    } else {
      const inner = SPHERE_RADIUS * 0.6;
      const outer = SPHERE_RADIUS * 1.1;
      radius  = inner + (outer - inner) * Math.pow(Math.random(), 0.5);
      density = 0.65;
    }

    const phi   = Math.random() * Math.PI * 2;
    const theta = Math.acos(2 * Math.random() - 1);
    pos[i * 3]     = radius * Math.sin(theta) * Math.cos(phi);
    pos[i * 3 + 1] = radius * Math.sin(theta) * Math.sin(phi);
    pos[i * 3 + 2] = radius * Math.cos(theta);

    const c = (i < nuc && all.length > 1) ? all[i % all.length] : myColor;
    col[i * 3]     = c[0] * density;
    col[i * 3 + 1] = c[1] * density;
    col[i * 3 + 2] = c[2] * density;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color",    new THREE.BufferAttribute(col, 3));
  return geo;
}

function buildOrbMat(size = 0.020, opacity = 0.85): THREE.PointsMaterial {
  return new THREE.PointsMaterial({
    size, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
}

// Stream that runs center-to-center: t=0 is our orb origin, t=1 is the other orb's center
function buildStream(
  worldDir: THREE.Vector3,
  myColor: [number, number, number],
  otherColor: [number, number, number],
  time: number,
  strength: number
): THREE.Points {
  const count = Math.max(60, Math.floor(STREAM_PARTICLES * strength));
  const pos   = new Float32Array(count * 3);
  const col   = new Float32Array(count * 3);

  const dir   = worldDir.clone().normalize();
  const reach = worldDir.length(); // exact center-to-center distance in world units

  const up    = Math.abs(dir.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const perp2 = new THREE.Vector3().crossVectors(dir, up).normalize();
  const perp1 = new THREE.Vector3().crossVectors(perp2, dir).normalize();

  const s = time * 0.8;

  for (let i = 0; i < count; i++) {
    const t = Math.random(); // 0 = our center, 1 = other center

    // sin(t*π): 0 at both ends, 1 at midpoint → lenticular tube shape
    // Wide where it merges with each orb, narrow in the space between
    const envelope = Math.sin(t * Math.PI);
    const width    = SPHERE_RADIUS * 0.22 * envelope + 0.02;

    const angle = Math.random() * Math.PI * 2;
    const r     = Math.pow(Math.random(), 0.6) * width;

    // Base position: straight line from center (0,0,0) to worldDir
    const base = dir.clone().multiplyScalar(t * reach);

    // Gentle undulation perpendicular to the stream axis
    const w1 = Math.sin(s * 3 + t * Math.PI * 4 + i * 0.02) * 0.018 * strength;
    const w2 = Math.cos(s * 2 + t * Math.PI * 3 + i * 0.015) * 0.014 * strength;
    base.addScaledVector(perp1, Math.cos(angle) * r + w1);
    base.addScaledVector(perp2, Math.sin(angle) * r + w2);

    pos[i * 3]     = base.x;
    pos[i * 3 + 1] = base.y;
    pos[i * 3 + 2] = base.z;

    // Colour blends from myColor → otherColor along the path
    // Fade near the ends so it dissolves into each orb naturally
    const fade = (0.35 + 0.65 * envelope) * strength;
    col[i * 3]     = (myColor[0] * (1 - t) + otherColor[0] * t) * fade;
    col[i * 3 + 1] = (myColor[1] * (1 - t) + otherColor[1] * t) * fade;
    col[i * 3 + 2] = (myColor[2] * (1 - t) + otherColor[2] * t) * fade;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color",    new THREE.BufferAttribute(col, 3));
  return new THREE.Points(geo, buildOrbMat(0.016, 0.9));
}

function disposePoints(p: THREE.Points) {
  p.geometry.dispose();
  (p.material as THREE.Material).dispose();
}

// ─── Ghost orb ───────────────────────────────────────────────────────────────

interface GhostState {
  points: THREE.Points;
  rotY: number;
}

export interface GhostInput {
  id: string;
  color: [number, number, number];
  worldPos: THREE.Vector3; // center of other orb in my world space
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class ParticleSystem {
  /** Main orb + streams — apply inertia displacement to this group's position */
  readonly orbGroup   = new THREE.Group();
  /** Ghost orbs from overlapping windows — always at scene origin, positioned individually */
  readonly ghostGroup = new THREE.Group();

  private orb: THREE.Points;
  private orbMat: THREE.PointsMaterial;
  private streams  = new Map<string, THREE.Points>();
  private ghosts   = new Map<string, GhostState>();

  private time             = 0;
  private myColor: [number, number, number] = [1, 1, 1];
  private prevConnectedKey = "";

  constructor() {
    this.orbMat = buildOrbMat();
    this.orb    = new THREE.Points(buildOrbGeo([1, 1, 1], []), this.orbMat);
    this.orbGroup.add(this.orb);
  }

  init(color: [number, number, number]): void {
    this.myColor = color;
    this.orb.geometry.dispose();
    this.orb.geometry = buildOrbGeo(color, []);
  }

  update(dt: number, myWindow: WindowInfo, otherWindows: Map<string, WindowInfo>): void {
    this.time += dt;

    // Spin own orb
    this.orb.rotation.y += dt * 0.5;
    this.orb.rotation.x  = Math.sin(this.time * 0.3) * 0.15;

    // Spin ghost orbs (slightly different cadence per ghost)
    for (const [, g] of this.ghosts) {
      g.rotY          += dt * 0.4;
      g.points.rotation.y = g.rotY;
      g.points.rotation.x = Math.sin(this.time * 0.25) * 0.12;
    }

    const scale = screenScale(myWindow.height);
    const myCX  = myWindow.screenX + myWindow.width  * 0.5;
    const myCY  = myWindow.screenY + myWindow.height * 0.5;

    // Close windows → streams
    type Entry = { id: string; info: WindowInfo; dir: THREE.Vector3; strength: number };
    const close: Entry[] = [];

    for (const [id, other] of otherWindows) {
      const gap = edgeDistPx(myWindow, other);
      if (gap > STREAM_RANGE_PX) continue;
      const dx = (other.screenX + other.width  * 0.5 - myCX) * scale;
      const dy = -(other.screenY + other.height * 0.5 - myCY) * scale;
      const dir      = new THREE.Vector3(dx, dy, 0);
      const strength = Math.pow(1 - gap / STREAM_RANGE_PX, 0.6);
      close.push({ id, info: other, dir, strength });
    }

    // Rebuild orb nucleus colours when connections change
    const connKey = close.map(c => c.id).sort().join(",");
    if (connKey !== this.prevConnectedKey) {
      this.prevConnectedKey = connKey;
      this.orb.geometry.dispose();
      this.orb.geometry = buildOrbGeo(this.myColor, close.map(c => c.info.color));
    }

    // Remove stale streams
    for (const [id, stream] of this.streams) {
      if (!close.find(c => c.id === id)) {
        this.orbGroup.remove(stream); disposePoints(stream); this.streams.delete(id);
      }
    }
    // Rebuild streams (animation)
    for (const { id, info, dir, strength } of close) {
      if (this.streams.has(id)) {
        const old = this.streams.get(id)!;
        this.orbGroup.remove(old); disposePoints(old);
      }
      const s = buildStream(dir, this.myColor, info.color, this.time, strength);
      this.streams.set(id, s);
      this.orbGroup.add(s);
    }
  }

  /** Called every frame with the list of overlapping lower-z windows to render as ghosts */
  updateGhosts(inputs: GhostInput[]): void {
    // Remove stale ghosts
    for (const [id, g] of this.ghosts) {
      if (!inputs.find(i => i.id === id)) {
        this.ghostGroup.remove(g.points); disposePoints(g.points); this.ghosts.delete(id);
      }
    }
    // Add / reposition ghosts
    for (const { id, color, worldPos } of inputs) {
      if (!this.ghosts.has(id)) {
        const pts = new THREE.Points(buildOrbGeo(color, [this.myColor]), buildOrbMat(0.018, 0.75));
        this.ghosts.set(id, { points: pts, rotY: 0 });
        this.ghostGroup.add(pts);
      }
      this.ghosts.get(id)!.points.position.copy(worldPos);
    }
  }

  dispose(): void {
    this.orb.geometry.dispose();
    this.orbMat.dispose();
    for (const [, s] of this.streams) disposePoints(s);
    for (const [, g] of this.ghosts)  disposePoints(g.points);
  }
}
