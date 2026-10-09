import * as THREE from "three";
import type { WindowInfo } from "./windowSync";

const ORB_PARTICLES    = 5000;
const SPHERE_RADIUS    = 1.8;
const NUCLEUS_FRACTION = 0.5;
const STREAM_PARTICLES = 2000;
const STREAM_RANGE_PX  = 500;
const CAMERA_Z         = 5;
const FOV_DEG          = 75;

// pixels → world-units scale at z=0 for our perspective camera
function screenScale(innerW: number, innerH: number) {
  const halfH = Math.tan((FOV_DEG * 0.5) * (Math.PI / 180)) * CAMERA_Z;
  const s = halfH / (innerH * 0.5); // square pixels → same scale both axes
  return s;
}

function edgeDistPx(a: WindowInfo, b: WindowInfo): number {
  const hGap = Math.max(0, Math.max(a.screenX, b.screenX) - Math.min(a.screenX + a.width,  b.screenX + b.width));
  const vGap = Math.max(0, Math.max(a.screenY, b.screenY) - Math.min(a.screenY + a.height, b.screenY + b.height));
  return Math.sqrt(hGap * hGap + vGap * vGap);
}

// Build spherical particle distribution; nucleus blends colours from connected windows
function buildOrbGeo(
  myColor: [number, number, number],
  otherColors: [number, number, number][]
): THREE.BufferGeometry {
  const n = ORB_PARTICLES;
  const pos  = new Float32Array(n * 3);
  const col  = new Float32Array(n * 3);
  const nuc  = Math.floor(n * NUCLEUS_FRACTION);
  const all  = [myColor, ...otherColors];

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

function buildOrbMat(): THREE.PointsMaterial {
  return new THREE.PointsMaterial({
    size: 0.035, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
}

// Tapered particle stream from origin toward worldDir, animated by time
function buildStream(
  worldDir: THREE.Vector3,
  myColor: [number, number, number],
  otherColor: [number, number, number],
  time: number,
  strength: number
): THREE.Points {
  const count = Math.max(80, Math.floor(STREAM_PARTICLES * strength));
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);

  const dir   = worldDir.clone().normalize();
  const reach = worldDir.length();

  const up    = Math.abs(dir.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const perp2 = new THREE.Vector3().crossVectors(dir, up).normalize();
  const perp1 = new THREE.Vector3().crossVectors(perp2, dir).normalize();

  const s = time * 0.8;

  for (let i = 0; i < count; i++) {
    const t      = Math.random();
    const taper  = Math.pow(1 - t, 2.0);
    const width  = SPHERE_RADIUS * 0.4 * taper + 0.04;
    const angle  = Math.random() * Math.PI * 2;
    const r      = Math.pow(Math.random(), 0.8) * width;

    const dist = SPHERE_RADIUS * 0.9 + t * reach;
    const base = dir.clone().multiplyScalar(dist);

    // Undulating flow
    const w1 = Math.sin(s * 3 + t * 6  + i * 0.02) * 0.025;
    const w2 = Math.cos(s * 2 + t * 4  + i * 0.015) * 0.018;
    base.addScaledVector(perp1, Math.cos(angle) * r + w1);
    base.addScaledVector(perp2, Math.sin(angle) * r + w2);
    base.addScaledVector(dir,   Math.sin(s * 4 + t * 8) * 0.012);

    pos[i * 3]     = base.x;
    pos[i * 3 + 1] = base.y;
    pos[i * 3 + 2] = base.z;

    const fade = (1 - t * 0.7) * strength;
    col[i * 3]     = (myColor[0] * (1 - t) + otherColor[0] * t) * fade;
    col[i * 3 + 1] = (myColor[1] * (1 - t) + otherColor[1] * t) * fade;
    col[i * 3 + 2] = (myColor[2] * (1 - t) + otherColor[2] * t) * fade;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color",    new THREE.BufferAttribute(col, 3));

  const mat = new THREE.PointsMaterial({
    size: 0.025, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });

  return new THREE.Points(geo, mat);
}

function disposePoints(p: THREE.Points) {
  p.geometry.dispose();
  (p.material as THREE.Material).dispose();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class ParticleSystem {
  readonly group = new THREE.Group();

  private orb: THREE.Points;
  private orbMat: THREE.PointsMaterial;
  private streams = new Map<string, THREE.Points>();
  private time = 0;
  private myColor: [number, number, number] = [1, 1, 1];
  private prevConnectedKey = "";

  constructor() {
    this.orbMat = buildOrbMat();
    this.orb = new THREE.Points(buildOrbGeo([1, 1, 1], []), this.orbMat);
    this.group.add(this.orb);
  }

  init(color: [number, number, number]): void {
    this.myColor = color;
    this.orb.geometry.dispose();
    this.orb.geometry = buildOrbGeo(color, []);
  }

  update(dt: number, myWindow: WindowInfo, otherWindows: Map<string, WindowInfo>): void {
    this.time += dt;

    // Orb rotation — continuous spin with gentle wobble
    this.orb.rotation.y += dt * 0.5;
    this.orb.rotation.x  = Math.sin(this.time * 0.3) * 0.15;

    const scale = screenScale(myWindow.width, myWindow.height);
    const myCX  = myWindow.screenX + myWindow.width  * 0.5;
    const myCY  = myWindow.screenY + myWindow.height * 0.5;

    // Collect close windows + compute world-space direction vectors
    type Entry = { id: string; info: WindowInfo; dir: THREE.Vector3; strength: number };
    const close: Entry[] = [];

    for (const [id, other] of otherWindows) {
      const gap = edgeDistPx(myWindow, other);
      if (gap > STREAM_RANGE_PX) continue;

      const dx = (other.screenX + other.width  * 0.5 - myCX) * scale;
      const dy = -(other.screenY + other.height * 0.5 - myCY) * scale;
      const dir = new THREE.Vector3(dx, dy, 0);
      const strength = Math.pow(1 - gap / STREAM_RANGE_PX, 0.6);
      close.push({ id, info: other, dir, strength });
    }

    // Rebuild orb geometry when connected windows change (blends nucleus colours)
    const connKey = close.map(c => c.id).sort().join(",");
    if (connKey !== this.prevConnectedKey) {
      this.prevConnectedKey = connKey;
      this.orb.geometry.dispose();
      this.orb.geometry = buildOrbGeo(this.myColor, close.map(c => c.info.color));
    }

    // Remove stale streams
    for (const [id, stream] of this.streams) {
      if (!close.find(c => c.id === id)) {
        this.group.remove(stream);
        disposePoints(stream);
        this.streams.delete(id);
      }
    }

    // Rebuild streams every frame for animation
    for (const { id, info, dir, strength } of close) {
      if (this.streams.has(id)) {
        const old = this.streams.get(id)!;
        this.group.remove(old);
        disposePoints(old);
      }
      const stream = buildStream(dir, this.myColor, info.color, this.time, strength);
      this.streams.set(id, stream);
      this.group.add(stream);
    }
  }

  dispose(): void {
    this.orb.geometry.dispose();
    this.orbMat.dispose();
    for (const [, s] of this.streams) disposePoints(s);
    this.streams.clear();
  }
}
