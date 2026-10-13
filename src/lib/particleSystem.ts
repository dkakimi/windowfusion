import * as THREE from "three";
import type { WindowInfo } from "./windowSync";

const ORB_PARTICLES   = 3000;
const GHOST_PARTICLES = 1200;
const GHOST_POOL_SIZE = 8;
const SPHERE_RADIUS   = 1.8;
const NUCLEUS_FRACTION = 0.5;
const STREAM_PARTICLES = 4000;
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

export function anyInRange(myWin: WindowInfo, others: Map<string, WindowInfo>, rangePx: number): boolean {
  for (const [, other] of others) {
    if (edgeDistPx(myWin, other) <= rangePx) return true;
  }
  return false;
}

// ─── Shaders ──────────────────────────────────────────────────────────────────

// Soap bubble fragment shader — shared between main orb and ghost (different uniforms)
const BUBBLE_FRAG = /* glsl */`
uniform float uTime;
uniform vec3  uBaseColor;
uniform float uFade;

void main() {
  vec2  uv = gl_PointCoord * 2.0 - 1.0;
  float r  = dot(uv, uv);
  if (r > 1.0) discard;

  float z    = sqrt(max(0.0, 1.0 - r));
  vec3  norm = normalize(vec3(uv, z));
  vec3  view = vec3(0.0, 0.0, 1.0);

  // Fresnel rim (more visible at grazing angles)
  float fresnel = 1.0 - z;
  float rim     = pow(fresnel, 1.4);

  // Thin-film iridescence: rainbow shifts with angle + time
  float phase = rim * 5.2 + uTime * 0.5;
  vec3 irid = vec3(
    sin(phase)         * 0.5 + 0.5,
    sin(phase + 2.094) * 0.5 + 0.5,
    sin(phase + 4.189) * 0.5 + 0.5
  );

  // Specular highlight
  vec3  light = normalize(vec3(0.6, 0.9, 1.0));
  float spec  = pow(max(dot(reflect(-light, norm), view), 0.0), 22.0);

  // Blend: base tint at center → iridescence at rim
  vec3 col = mix(uBaseColor * 0.2, irid * 0.9 + uBaseColor * 0.35, rim * 0.88);
  col += spec * 0.95;

  float alpha = pow(rim, 1.2) * 0.92 + spec * 0.85 + 0.025;
  alpha = clamp(alpha * uFade, 0.0, 1.0);
  if (alpha < 0.01) discard;

  gl_FragColor = vec4(col, alpha);
}`;

// Main orb vertex: blob deformation + pop burst (particles fly outward)
const ORB_VERT = /* glsl */`
uniform float uTime;
uniform float uHeight;
uniform float uPop;

void main() {
  vec3 n = normalize(position);
  float d =
    sin(n.x * 3.1 + uTime * 0.80) * cos(n.y * 2.6 + uTime * 0.60) * 0.16 +
    sin(n.y * 2.9 + n.z * 2.1    + uTime * 1.00) * 0.11 +
    cos(n.z * 3.4 + uTime * 0.50) * sin(n.x * 2.2 + uTime * 0.90) * 0.09 +
    sin(n.x * 1.7 + n.z * 2.8    + uTime * 0.65) * 0.06;

  vec3 blobPos = position * (1.0 + d);
  // Pop burst: particles scatter outward
  blobPos += n * uPop * 5.5;

  vec4 mvPos = modelViewMatrix * vec4(blobPos, 1.0);
  gl_Position  = projectionMatrix * mvPos;
  gl_PointSize = 0.032 * projectionMatrix[1][1] * uHeight * 0.5 / (-mvPos.z);
}`;

// Ghost orb vertex: lighter blob frequencies
const GHOST_VERT = /* glsl */`
uniform float uTime;
uniform float uHeight;

void main() {
  vec3 n = normalize(position);
  float d =
    sin(n.x * 2.5 + uTime * 0.65) * cos(n.y * 2.1 + uTime * 0.50) * 0.12 +
    cos(n.z * 2.8 + uTime * 0.70) * sin(n.y * 1.9 + uTime * 0.55) * 0.09;
  vec3 blobPos = position * (1.0 + d);
  vec4 mvPos   = modelViewMatrix * vec4(blobPos, 1.0);
  gl_Position  = projectionMatrix * mvPos;
  gl_PointSize = 0.026 * projectionMatrix[1][1] * uHeight * 0.5 / (-mvPos.z);
}`;

// Ghost fragment: same soap bubble look but driven by uColor uniform
const GHOST_FRAG = /* glsl */`
uniform float uTime;
uniform vec3  uColor;
uniform float uFade;

void main() {
  vec2  uv = gl_PointCoord * 2.0 - 1.0;
  float r  = dot(uv, uv);
  if (r > 1.0) discard;

  float z    = sqrt(max(0.0, 1.0 - r));
  vec3  norm = normalize(vec3(uv, z));
  vec3  view = vec3(0.0, 0.0, 1.0);

  float fresnel = 1.0 - z;
  float rim     = pow(fresnel, 1.4);

  float phase = rim * 5.2 + uTime * 0.5;
  vec3 irid = vec3(
    sin(phase)         * 0.5 + 0.5,
    sin(phase + 2.094) * 0.5 + 0.5,
    sin(phase + 4.189) * 0.5 + 0.5
  );

  vec3  light = normalize(vec3(0.6, 0.9, 1.0));
  float spec  = pow(max(dot(reflect(-light, norm), view), 0.0), 22.0);

  vec3 col = mix(uColor * 0.18, irid * 0.85 + uColor * 0.35, rim * 0.88);
  col += spec * 0.85;

  float alpha = pow(rim, 1.2) * 0.78 + spec * 0.7 + 0.02;
  alpha = clamp(alpha * uFade, 0.0, 1.0);
  if (alpha < 0.01) discard;

  gl_FragColor = vec4(col, alpha);
}`;

// Stream vertex: per-particle size attribute
const STREAM_VERT = /* glsl */`
attribute vec3  color;
attribute float aSize;
uniform   float uHeight;
varying   vec3  vColor;

void main() {
  vColor       = color;
  vec4 mvPos   = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * projectionMatrix[1][1] * uHeight * 0.5 / (-mvPos.z);
  gl_Position  = projectionMatrix * mvPos;
}`;

// Stream fragment: iridescent soap-bubble beads flowing between orbs
const STREAM_FRAG = /* glsl */`
uniform float uTime;
varying vec3  vColor;

void main() {
  vec2  uv = gl_PointCoord * 2.0 - 1.0;
  float r  = dot(uv, uv);
  if (r > 1.0) discard;

  float z    = sqrt(max(0.0, 1.0 - r));
  vec3  norm = normalize(vec3(uv, z));
  vec3  view = vec3(0.0, 0.0, 1.0);

  float fresnel = 1.0 - z;
  float rim     = pow(fresnel, 1.4);

  float phase = rim * 4.8 + uTime * 0.75;
  vec3 irid = vec3(
    sin(phase)         * 0.5 + 0.5,
    sin(phase + 2.094) * 0.5 + 0.5,
    sin(phase + 4.189) * 0.5 + 0.5
  );

  vec3  light = normalize(vec3(0.6, 0.9, 1.0));
  float spec  = pow(max(dot(reflect(-light, norm), view), 0.0), 18.0);

  vec3 col = mix(vColor * 0.45, irid * 0.85 + vColor * 0.5, rim * 0.80);
  col += spec * 0.75;

  float alpha = rim * 0.88 + spec * 0.70 + 0.06;
  alpha = clamp(alpha, 0.0, 1.0);
  if (alpha < 0.01) discard;

  gl_FragColor = vec4(col, alpha);
}`;

// ─── Shared uniforms ──────────────────────────────────────────────────────────

const sharedTime:   THREE.IUniform = { value: 0 };
const sharedHeight: THREE.IUniform = { value: 900 };

// ─── Geometry builders ────────────────────────────────────────────────────────

function buildSphereGeo(count: number): THREE.BufferGeometry {
  const pos = new Float32Array(count * 3);
  const nuc = Math.floor(count * NUCLEUS_FRACTION);
  for (let i = 0; i < count; i++) {
    const r = i < nuc
      ? SPHERE_RADIUS * 0.4 * Math.pow(Math.random(), 0.3)
      : SPHERE_RADIUS * 0.6 + SPHERE_RADIUS * 0.5 * Math.pow(Math.random(), 0.5);
    const phi = Math.random() * Math.PI * 2;
    const th  = Math.acos(2 * Math.random() - 1);
    pos[i*3]   = r * Math.sin(th) * Math.cos(phi);
    pos[i*3+1] = r * Math.sin(th) * Math.sin(phi);
    pos[i*3+2] = r * Math.cos(th);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return geo;
}

function buildStreamGeo(
  worldDir: THREE.Vector3,
  myColor:    [number, number, number],
  otherColor: [number, number, number],
  time:       number,
  strength:   number,
): THREE.BufferGeometry {
  const count = Math.max(80, Math.floor(STREAM_PARTICLES * strength));
  const pos   = new Float32Array(count * 3);
  const col   = new Float32Array(count * 3);
  const siz   = new Float32Array(count);

  const dir   = worldDir.clone().normalize();
  const reach = worldDir.length();
  const up    = Math.abs(dir.x) < 0.9 ? new THREE.Vector3(1,0,0) : new THREE.Vector3(0,1,0);
  const perp2 = new THREE.Vector3().crossVectors(dir, up).normalize();
  const perp1 = new THREE.Vector3().crossVectors(perp2, dir).normalize();
  const s     = time * 1.4;

  for (let i = 0; i < count; i++) {
    const t        = Math.random();
    const envelope = Math.sin(t * Math.PI);
    const width    = SPHERE_RADIUS * 0.60 * envelope + 0.05;
    const angle    = Math.random() * Math.PI * 2;
    const r        = Math.pow(Math.random(), 0.5) * width;

    const base = dir.clone().multiplyScalar(t * reach);
    // Corkscrew swirl
    const swirl = s * 2.2 + t * Math.PI * 3.5;
    const w1 = Math.sin(swirl + i * 0.03)      * 0.03 * strength;
    const w2 = Math.cos(swirl * 0.75 + i * 0.02) * 0.025 * strength;
    base.addScaledVector(perp1, Math.cos(angle)*r + w1);
    base.addScaledVector(perp2, Math.sin(angle)*r + w2);

    pos[i*3]   = base.x; pos[i*3+1] = base.y; pos[i*3+2] = base.z;

    const fade = (0.38 + 0.62 * envelope) * strength;
    col[i*3]   = (myColor[0]*(1-t) + otherColor[0]*t) * fade;
    col[i*3+1] = (myColor[1]*(1-t) + otherColor[1]*t) * fade;
    col[i*3+2] = (myColor[2]*(1-t) + otherColor[2]*t) * fade;

    siz[i] = 0.020 + Math.random() * 0.024;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color",    new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aSize",    new THREE.BufferAttribute(siz, 1));
  return geo;
}

// ─── Ghost pool ───────────────────────────────────────────────────────────────

interface PoolSlot { points: THREE.Points; mat: THREE.ShaderMaterial }

class GhostPool {
  private slots: PoolSlot[];
  private assigned = new Map<string, number>();

  constructor(private group: THREE.Group) {
    this.slots = Array.from({ length: GHOST_POOL_SIZE }, () => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: GHOST_VERT, fragmentShader: GHOST_FRAG,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        uniforms: {
          uTime:   sharedTime,
          uHeight: sharedHeight,
          uColor:  { value: new THREE.Color(1, 1, 1) },
          uFade:   { value: 1.0 },
        },
      });
      const points = new THREE.Points(buildSphereGeo(GHOST_PARTICLES), mat);
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

  tick(dt: number, time: number): void {
    for (const [, idx] of this.assigned) {
      const p = this.slots[idx].points;
      p.rotation.y += dt * 0.38;
      p.rotation.x  = Math.sin(time * 0.24 + idx) * 0.11;
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface GhostInput {
  id: string;
  color: [number, number, number];
  worldPos: THREE.Vector3;
}

type PopPhase  = "idle" | "burst" | "pause" | "reform";
type GrowPhase = "idle" | "grow"  | "shrink";

export class ParticleSystem {
  readonly orbGroup   = new THREE.Group();
  readonly ghostGroup = new THREE.Group();

  private orb: THREE.Points;
  private orbMat: THREE.ShaderMaterial;
  private streamMat: THREE.ShaderMaterial;
  private ghostPool: GhostPool;
  private streams = new Map<string, THREE.Points>();

  private time    = 0;
  private myColor: [number, number, number] = [1, 1, 1];

  // Pop animation
  private popPhase: PopPhase = "idle";
  private popTimer = 0;

  // Grow/merge animation
  private growPhase: GrowPhase = "idle";
  private growTimer = 0;

  // Proximity-based subtle scale
  private proxScale       = 1.0;
  private targetProxScale = 1.0;

  constructor() {
    this.orbMat = new THREE.ShaderMaterial({
      vertexShader: ORB_VERT, fragmentShader: BUBBLE_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      uniforms: {
        uTime:      { value: 0 },
        uHeight:    { value: 900 },
        uBaseColor: { value: new THREE.Color(1, 1, 1) },
        uPop:       { value: 0 },
        uFade:      { value: 1 },
      },
    });
    this.orb = new THREE.Points(buildSphereGeo(ORB_PARTICLES), this.orbMat);
    this.orbGroup.add(this.orb);

    this.streamMat = new THREE.ShaderMaterial({
      vertexShader: STREAM_VERT, fragmentShader: STREAM_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      uniforms: { uTime: sharedTime, uHeight: sharedHeight },
    });

    this.ghostPool = new GhostPool(this.ghostGroup);
  }

  init(color: [number, number, number]): void {
    this.myColor = color;
    this.orbMat.uniforms.uBaseColor.value.setRGB(...color);
  }

  triggerPop(): void {
    if (this.popPhase !== "idle") return;
    this.popPhase = "burst";
    this.popTimer = 0;
  }

  triggerMerge(): void {
    if (this.growPhase !== "idle" || this.popPhase !== "idle") return;
    this.growPhase = "grow";
    this.growTimer = 0;
  }

  setNearby(hasNearby: boolean): void {
    this.targetProxScale = hasNearby ? 1.18 : 1.0;
  }

  update(dt: number, myWindow: WindowInfo, otherWindows: Map<string, WindowInfo>): void {
    this.time += dt;

    const physH = myWindow.height * (typeof window !== "undefined" ? window.devicePixelRatio : 1);
    this.orbMat.uniforms.uTime.value   = this.time;
    this.orbMat.uniforms.uHeight.value = physH;
    sharedTime.value   = this.time;
    sharedHeight.value = physH;

    // Update all animations and compute final scale
    this.updatePop(dt);
    this.proxScale += (this.targetProxScale - this.proxScale) * Math.min(dt * 3.5, 1.0);
    const finalScale = this.proxScale * this.getGrowScale(dt);
    if (this.popPhase === "idle") {
      this.orbGroup.scale.setScalar(finalScale);
    }

    // Orb spin
    this.orb.rotation.y += dt * 0.38;
    this.orb.rotation.x  = Math.sin(this.time * 0.27) * 0.11;
    this.ghostPool.tick(dt, this.time);

    // Streams
    const scale = screenScale(myWindow.height);
    const myCX  = myWindow.screenX + myWindow.width  * 0.5;
    const myCY  = myWindow.screenY + myWindow.height * 0.5;

    type Entry = { id: string; info: WindowInfo; dir: THREE.Vector3; strength: number };
    const close: Entry[] = [];

    for (const [id, other] of otherWindows) {
      const gap = edgeDistPx(myWindow, other);
      if (gap > STREAM_RANGE_PX) continue;
      const dx      = (other.screenX + other.width  * 0.5 - myCX) * scale;
      const dy      = -(other.screenY + other.height * 0.5 - myCY) * scale;
      const dir     = new THREE.Vector3(dx, dy, 0);
      const strength = Math.pow(1 - gap / STREAM_RANGE_PX, 0.55);
      close.push({ id, info: other, dir, strength });
    }

    for (const [id, stream] of this.streams) {
      if (!close.find(c => c.id === id)) {
        this.orbGroup.remove(stream);
        stream.geometry.dispose();
        this.streams.delete(id);
      }
    }
    for (const { id, info, dir, strength } of close) {
      if (this.streams.has(id)) {
        const old = this.streams.get(id)!;
        this.orbGroup.remove(old);
        old.geometry.dispose();
      }
      const geo = buildStreamGeo(dir, this.myColor, info.color, this.time, strength);
      const s   = new THREE.Points(geo, this.streamMat);
      this.streams.set(id, s);
      this.orbGroup.add(s);
    }
  }

  private updatePop(dt: number): void {
    if (this.popPhase === "idle") return;
    this.popTimer += dt;

    if (this.popPhase === "burst") {
      const p = Math.min(this.popTimer / 0.40, 1.0);
      this.orbMat.uniforms.uPop.value  = p;
      this.orbMat.uniforms.uFade.value = 1.0 - p;
      if (p >= 1.0) {
        this.popPhase = "pause";
        this.popTimer = 0;
        this.orbGroup.visible = false;
      }
    } else if (this.popPhase === "pause") {
      if (this.popTimer >= 0.14) {
        this.popPhase = "reform";
        this.popTimer = 0;
        this.orbMat.uniforms.uPop.value  = 0;
        this.orbMat.uniforms.uFade.value = 1;
        this.orbGroup.visible = true;
        this.orbGroup.scale.setScalar(0);
      }
    } else if (this.popPhase === "reform") {
      const p = Math.min(this.popTimer / 0.65, 1.0);
      // Damped spring: grows from 0 → overshoots → settles at 1
      const e     = Math.exp(-p * 5.0);
      const scale = Math.max(0, 1.0 - e * Math.cos(p * 9.0));
      this.orbGroup.scale.setScalar(scale * this.proxScale * this.getGrowScale(0));
      if (p >= 1.0) {
        this.popPhase = "idle";
      }
    }
  }

  private getGrowScale(dt: number): number {
    if (this.growPhase === "idle") return 1.0;

    this.growTimer += dt;

    if (this.growPhase === "grow") {
      const p = Math.min(this.growTimer / 0.45, 1.0);
      // Ease in-out cubic
      const ease = p < 0.5 ? 4*p*p*p : 1 - Math.pow(-2*p + 2, 3) / 2;
      if (p >= 1.0) {
        this.growPhase = "shrink";
        this.growTimer = 0;
        return 1.5;
      }
      return 1.0 + 0.5 * ease;
    }

    if (this.growPhase === "shrink") {
      const p = Math.min(this.growTimer / 0.80, 1.0);
      // Elastic spring back: 1.5 → 1.0 with bounce
      const e     = Math.exp(-p * 6.0);
      const scale = 1.0 + 0.5 * e * Math.cos(p * 10.0);
      if (p >= 1.0) {
        this.growPhase = "idle";
        this.growTimer = 0;
        return 1.0;
      }
      return Math.max(0.8, scale);
    }

    return 1.0;
  }

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
    this.streamMat.dispose();
    for (const [, s] of this.streams) s.geometry.dispose();
  }
}
