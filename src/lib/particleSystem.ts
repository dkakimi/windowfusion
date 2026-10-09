import * as THREE from "three";
import type { WindowInfo } from "./windowSync";

const ORB_PARTICLES    = 10000;
const GHOST_PARTICLES  = 3000;
const GHOST_POOL_SIZE  = 8;
const SPHERE_RADIUS    = 1.8;
const NUCLEUS_FRACTION = 0.5;
const STREAM_PARTICLES = 3000;
const STREAM_RANGE_PX  = 500;
export const CAMERA_Z  = 5;
export const FOV_DEG   = 75;

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
    a.screenX + a.width  <= b.screenX || b.screenX + b.width  <= a.screenX ||
    a.screenY + a.height <= b.screenY || b.screenY + b.height <= a.screenY
  );
}

// ─── Shaders ─────────────────────────────────────────────────────────────────

// Main orb: GPU blob deformation via multi-frequency sine displacement
const ORB_VERT = /* glsl */`
uniform float uTime;
uniform float uHeight;
attribute vec3 color;
varying vec3 vColor;

void main() {
  vColor = color;

  // Organic multi-frequency surface displacement
  vec3 n = normalize(position);
  float d =
    sin(n.x * 3.1 + uTime * 0.80) * cos(n.y * 2.6 + uTime * 0.60) * 0.16 +
    sin(n.y * 2.9 + n.z * 2.1   + uTime * 1.00) * 0.11 +
    cos(n.z * 3.4 + uTime * 0.50) * sin(n.x * 2.2 + uTime * 0.90) * 0.09 +
    sin(n.x * 1.7 + n.z * 2.8   + uTime * 0.65) * 0.06;

  vec3 blobPos = position * (1.0 + d);
  vec4 mvPos   = modelViewMatrix * vec4(blobPos, 1.0);

  gl_Position  = projectionMatrix * mvPos;
  gl_PointSize = 0.020 * projectionMatrix[1][1] * uHeight * 0.5 / (-mvPos.z);
}`;

const ORB_FRAG = /* glsl */`
varying vec3 vColor;
void main() {
  vec2  uv = gl_PointCoord - 0.5;
  float r2 = dot(uv, uv);
  if (r2 > 0.25) discard;
  gl_FragColor = vec4(vColor, (1.0 - r2 * 4.0) * 0.85);
}`;

// Ghost orb: lighter blob, colour driven by uniform (pre-allocated pool)
const GHOST_VERT = /* glsl */`
uniform float uTime;
uniform float uHeight;
attribute float aDensity;
varying float vDensity;

void main() {
  vDensity = aDensity;
  vec3 n = normalize(position);
  float d =
    sin(n.x * 2.5 + uTime * 0.65) * cos(n.y * 2.1 + uTime * 0.50) * 0.11 +
    cos(n.z * 2.8 + uTime * 0.70) * sin(n.y * 1.9 + uTime * 0.55) * 0.08;
  vec3 blobPos = position * (1.0 + d);
  vec4 mvPos   = modelViewMatrix * vec4(blobPos, 1.0);
  gl_Position  = projectionMatrix * mvPos;
  gl_PointSize = 0.018 * projectionMatrix[1][1] * uHeight * 0.5 / (-mvPos.z);
}`;

const GHOST_FRAG = /* glsl */`
uniform vec3  uColor;
varying float vDensity;
void main() {
  vec2  uv = gl_PointCoord - 0.5;
  float r2 = dot(uv, uv);
  if (r2 > 0.25) discard;
  gl_FragColor = vec4(uColor, (1.0 - r2 * 4.0) * 0.72 * vDensity);
}`;

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
      radius  = SPHERE_RADIUS * 0.6 + SPHERE_RADIUS * 0.5 * Math.pow(Math.random(), 0.5);
      density = 0.65;
    }
    const phi = Math.random() * Math.PI * 2;
    const th  = Math.acos(2 * Math.random() - 1);
    pos[i*3]   = radius * Math.sin(th) * Math.cos(phi);
    pos[i*3+1] = radius * Math.sin(th) * Math.sin(phi);
    pos[i*3+2] = radius * Math.cos(th);

    const c = (i < nuc && all.length > 1) ? all[i % all.length] : myColor;
    col[i*3]   = c[0] * density;
    col[i*3+1] = c[1] * density;
    col[i*3+2] = c[2] * density;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color",    new THREE.BufferAttribute(col, 3));
  return geo;
}

// Ghost geometry: sphere positions + density attribute (colour comes from uniform)
function buildGhostGeo(): THREE.BufferGeometry {
  const n   = GHOST_PARTICLES;
  const pos = new Float32Array(n * 3);
  const den = new Float32Array(n);
  const nuc = Math.floor(n * NUCLEUS_FRACTION);

  for (let i = 0; i < n; i++) {
    let radius: number;
    den[i] = i < nuc ? 1.0 : 0.65;
    if (i < nuc) {
      radius = SPHERE_RADIUS * 0.4 * Math.pow(Math.random(), 0.3);
    } else {
      radius = SPHERE_RADIUS * 0.6 + SPHERE_RADIUS * 0.5 * Math.pow(Math.random(), 0.5);
    }
    const phi = Math.random() * Math.PI * 2;
    const th  = Math.acos(2 * Math.random() - 1);
    pos[i*3]   = radius * Math.sin(th) * Math.cos(phi);
    pos[i*3+1] = radius * Math.sin(th) * Math.sin(phi);
    pos[i*3+2] = radius * Math.cos(th);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aDensity", new THREE.BufferAttribute(den, 1));
  return geo;
}

// Shared time/height uniforms — update once, all ghost materials see the change
const sharedTime:   THREE.IUniform = { value: 0 };
const sharedHeight: THREE.IUniform = { value: 900 };

function buildOrbMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: ORB_VERT, fragmentShader: ORB_FRAG,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    uniforms: {
      uTime:   { value: 0 },    // per-orb (updated in update())
      uHeight: { value: 900 },  // per-orb
    },
  });
}

function buildGhostMat(color: [number, number, number]): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: GHOST_VERT, fragmentShader: GHOST_FRAG,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    uniforms: {
      uTime:   sharedTime,    // shared — updated once per frame
      uHeight: sharedHeight,  // shared
      uColor:  { value: new THREE.Color(...color) },
    },
  });
}

// ─── Stream ───────────────────────────────────────────────────────────────────

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
  const reach = worldDir.length();

  const up    = Math.abs(dir.x) < 0.9 ? new THREE.Vector3(1,0,0) : new THREE.Vector3(0,1,0);
  const perp2 = new THREE.Vector3().crossVectors(dir, up).normalize();
  const perp1 = new THREE.Vector3().crossVectors(perp2, dir).normalize();
  const s = time * 0.8;

  for (let i = 0; i < count; i++) {
    const t        = Math.random();
    const envelope = Math.sin(t * Math.PI);
    const width    = SPHERE_RADIUS * 0.22 * envelope + 0.02;
    const angle    = Math.random() * Math.PI * 2;
    const r        = Math.pow(Math.random(), 0.6) * width;

    const base = dir.clone().multiplyScalar(t * reach);
    const w1   = Math.sin(s*3 + t*Math.PI*4 + i*0.02) * 0.018 * strength;
    const w2   = Math.cos(s*2 + t*Math.PI*3 + i*0.015) * 0.014 * strength;
    base.addScaledVector(perp1, Math.cos(angle)*r + w1);
    base.addScaledVector(perp2, Math.sin(angle)*r + w2);

    pos[i*3]   = base.x; pos[i*3+1] = base.y; pos[i*3+2] = base.z;

    const fade = (0.35 + 0.65*envelope) * strength;
    col[i*3]   = (myColor[0]*(1-t) + otherColor[0]*t) * fade;
    col[i*3+1] = (myColor[1]*(1-t) + otherColor[1]*t) * fade;
    col[i*3+2] = (myColor[2]*(1-t) + otherColor[2]*t) * fade;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color",    new THREE.BufferAttribute(col, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.016, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
}

function disposePoints(p: THREE.Points) {
  p.geometry.dispose();
  (p.material as THREE.Material).dispose();
}

// ─── Ghost pool ───────────────────────────────────────────────────────────────

interface PoolSlot { points: THREE.Points; mat: THREE.ShaderMaterial }

class GhostPool {
  private slots: PoolSlot[];
  private assigned = new Map<string, number>(); // window id → slot index

  constructor(private group: THREE.Group) {
    // Pre-build all ghost orb geometries and materials at startup — zero GC later
    this.slots = Array.from({ length: GHOST_POOL_SIZE }, () => {
      const mat    = buildGhostMat([1, 1, 1]);
      const points = new THREE.Points(buildGhostGeo(), mat);
      points.visible = false;
      group.add(points);
      return { points, mat };
    });
  }

  assign(id: string, color: [number, number, number], worldPos: THREE.Vector3): void {
    if (!this.assigned.has(id)) {
      const used = new Set(this.assigned.values());
      const free = this.slots.findIndex((_, i) => !used.has(i));
      if (free === -1) return;
      this.assigned.set(id, free);
    }
    const slot = this.slots[this.assigned.get(id)!];
    slot.mat.uniforms.uColor.value.setRGB(...color);
    slot.points.position.copy(worldPos);
    slot.points.visible = true;
  }

  releaseStale(activeIds: Set<string>): void {
    for (const [id, idx] of this.assigned) {
      if (!activeIds.has(id)) {
        this.slots[idx].points.visible = false;
        this.assigned.delete(id);
      }
    }
  }

  tickRotation(dt: number, time: number): void {
    for (const [, idx] of this.assigned) {
      const p = this.slots[idx].points;
      p.rotation.y += dt * 0.4;
      p.rotation.x  = Math.sin(time * 0.25 + idx) * 0.12;
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface GhostInput {
  id: string;
  color: [number, number, number];
  worldPos: THREE.Vector3;
}

export class ParticleSystem {
  readonly orbGroup   = new THREE.Group();
  readonly ghostGroup = new THREE.Group();

  private orb: THREE.Points;
  private orbMat: THREE.ShaderMaterial;
  private ghostPool: GhostPool;
  private streams  = new Map<string, THREE.Points>();

  private time             = 0;
  private myColor: [number, number, number] = [1, 1, 1];
  private prevConnectedKey = "";

  constructor() {
    this.orbMat  = buildOrbMat();
    this.orb     = new THREE.Points(buildOrbGeo([1,1,1],[]), this.orbMat);
    this.orbGroup.add(this.orb);
    this.ghostPool = new GhostPool(this.ghostGroup);
  }

  init(color: [number, number, number]): void {
    this.myColor = color;
    this.orb.geometry.dispose();
    this.orb.geometry = buildOrbGeo(color, []);
  }

  update(dt: number, myWindow: WindowInfo, otherWindows: Map<string, WindowInfo>): void {
    this.time += dt;

    // Blob shader time + height
    const physH = myWindow.height * (typeof window !== "undefined" ? window.devicePixelRatio : 1);
    this.orbMat.uniforms.uTime.value   = this.time;
    this.orbMat.uniforms.uHeight.value = physH;
    sharedTime.value   = this.time;   // updates all ghost materials
    sharedHeight.value = physH;

    // Orb spin
    this.orb.rotation.y += dt * 0.5;
    this.orb.rotation.x  = Math.sin(this.time * 0.3) * 0.15;

    this.ghostPool.tickRotation(dt, this.time);

    const scale = screenScale(myWindow.height);
    const myCX  = myWindow.screenX + myWindow.width  * 0.5;
    const myCY  = myWindow.screenY + myWindow.height * 0.5;

    type Entry = { id: string; info: WindowInfo; dir: THREE.Vector3; strength: number };
    const close: Entry[] = [];

    for (const [id, other] of otherWindows) {
      const gap = edgeDistPx(myWindow, other);
      if (gap > STREAM_RANGE_PX) continue;
      const dx       = (other.screenX + other.width  * 0.5 - myCX) * scale;
      const dy       = -(other.screenY + other.height * 0.5 - myCY) * scale;
      const dir      = new THREE.Vector3(dx, dy, 0);
      const strength = Math.pow(1 - gap / STREAM_RANGE_PX, 0.6);
      close.push({ id, info: other, dir, strength });
    }

    // Rebuild nucleus colours when connected set changes
    const connKey = close.map(c => c.id).sort().join(",");
    if (connKey !== this.prevConnectedKey) {
      this.prevConnectedKey = connKey;
      this.orb.geometry.dispose();
      this.orb.geometry = buildOrbGeo(this.myColor, close.map(c => c.info.color));
    }

    // Streams
    for (const [id, stream] of this.streams) {
      if (!close.find(c => c.id === id)) {
        this.orbGroup.remove(stream); disposePoints(stream); this.streams.delete(id);
      }
    }
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

  /** Render overlapping lower-z windows as ghosts (no GC — uses pre-allocated pool) */
  updateGhosts(inputs: GhostInput[]): void {
    const activeIds = new Set(inputs.map(i => i.id));
    this.ghostPool.releaseStale(activeIds);
    for (const { id, color, worldPos } of inputs) {
      this.ghostPool.assign(id, color, worldPos);
    }
  }

  dispose(): void {
    this.orb.geometry.dispose();
    this.orbMat.dispose();
    for (const [, s] of this.streams) disposePoints(s);
  }
}
