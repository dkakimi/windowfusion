import * as THREE from "three";
import type { WindowInfo } from "./windowSync";

const SPHERE_RADIUS   = 1.8;
const SPHERE_SEGS_W   = 96;
const SPHERE_SEGS_H   = 48;
const GHOST_POOL_SIZE = 8;
const STREAM_PARTICLES = 3500;
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

// ─── Shared uniforms ──────────────────────────────────────────────────────────

const sharedTime:   THREE.IUniform<number> = { value: 0 };
const sharedHeight: THREE.IUniform<number> = { value: 900 };

// ─── Soap bubble mesh shaders ─────────────────────────────────────────────────
// These use actual vertex normals + camera position for physically-based
// fresnel and thin-film iridescence — unlike billboard-point shaders.

const SOAP_VERT = /* glsl */`
uniform float uTime;

varying vec3 vNormal;
varying vec3 vViewDir;

void main() {
  vec3 n = normalize(normal);

  // Organic blob deformation
  float d =
    sin(n.x * 3.1 + uTime * 0.80) * cos(n.y * 2.6 + uTime * 0.60) * 0.13 +
    sin(n.y * 2.9 + n.z * 2.1    + uTime * 1.00) * 0.09 +
    cos(n.z * 3.4 + uTime * 0.50) * sin(n.x * 2.2 + uTime * 0.90) * 0.07 +
    sin(n.x * 1.7 + n.z * 2.8    + uTime * 0.65) * 0.05;

  vec3 displaced = position * (1.0 + d);
  vec4 worldPos  = modelMatrix * vec4(displaced, 1.0);

  vNormal  = normalize(normalMatrix * normal);
  vViewDir = normalize(cameraPosition - worldPos.xyz);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}`;

const SOAP_FRAG = /* glsl */`
uniform float uTime;
uniform vec3  uBaseColor;
uniform float uFade;

varying vec3 vNormal;
varying vec3 vViewDir;

void main() {
  // Correct normal for both faces
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(vViewDir);

  // Fresnel: 0 at centre (perpendicular), 1 at rim (grazing)
  float cosTheta = dot(N, V);
  float fresnel  = 1.0 - max(cosTheta, 0.0);
  float rim      = pow(fresnel, 1.4);

  // Thin-film iridescence: rainbow pattern shifts with angle + time
  float phase = rim * 5.5 + uTime * 0.45;
  vec3 irid = vec3(
    sin(phase)         * 0.5 + 0.5,
    sin(phase + 2.094) * 0.5 + 0.5,
    sin(phase + 4.189) * 0.5 + 0.5
  );

  // Two specular highlights for realistic bubble look
  vec3  L1 = normalize(vec3( 0.6,  0.9, 1.0));
  vec3  L2 = normalize(vec3(-0.5, -0.3, 0.8));
  float s1 = pow(max(dot(reflect(-L1, N), V), 0.0), 40.0);
  float s2 = pow(max(dot(reflect(-L2, N), V), 0.0), 20.0) * 0.30;
  float spec = s1 + s2;

  // Centre: nearly invisible with base tint; rim: vivid iridescence
  vec3 col = mix(uBaseColor * 0.10, irid * 0.95 + uBaseColor * 0.45, rim * 0.92);
  col += spec * 1.0;

  // Alpha: almost transparent at centre, bright at rim and highlights
  float alpha = pow(rim, 0.85) * 0.92 + spec * 0.90 + 0.010;
  alpha = clamp(alpha * uFade, 0.0, 1.0);

  gl_FragColor = vec4(col, alpha);
}`;

// ─── Stream shaders (billboard bubble beads) ──────────────────────────────────

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

  vec3 col = mix(vColor * 0.4, irid * 0.85 + vColor * 0.5, rim * 0.80);
  col += spec * 0.75;

  float alpha = rim * 0.88 + spec * 0.70 + 0.06;
  alpha = clamp(alpha, 0.0, 1.0);
  if (alpha < 0.01) discard;

  gl_FragColor = vec4(col, alpha);
}`;

// ─── Shared sphere geometries (built once, reused) ────────────────────────────

const orbSphereGeo   = new THREE.SphereGeometry(SPHERE_RADIUS,        SPHERE_SEGS_W, SPHERE_SEGS_H);
const ghostSphereGeo = new THREE.SphereGeometry(SPHERE_RADIUS * 0.88, 64,            32);

// ─── Stream geometry builder ──────────────────────────────────────────────────

function buildStreamGeo(
  worldDir:   THREE.Vector3,
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
    const width    = SPHERE_RADIUS * 0.55 * envelope + 0.05;
    const angle    = Math.random() * Math.PI * 2;
    const r        = Math.pow(Math.random(), 0.5) * width;

    const base  = dir.clone().multiplyScalar(t * reach);
    const swirl = s * 2.2 + t * Math.PI * 3.5;
    base.addScaledVector(perp1, Math.cos(angle)*r + Math.sin(swirl + i*0.03) * 0.03 * strength);
    base.addScaledVector(perp2, Math.sin(angle)*r + Math.cos(swirl*0.75 + i*0.02) * 0.025 * strength);

    pos[i*3]   = base.x; pos[i*3+1] = base.y; pos[i*3+2] = base.z;

    const fade  = (0.38 + 0.62 * envelope) * strength;
    col[i*3]   = (myColor[0]*(1-t) + otherColor[0]*t) * fade;
    col[i*3+1] = (myColor[1]*(1-t) + otherColor[1]*t) * fade;
    col[i*3+2] = (myColor[2]*(1-t) + otherColor[2]*t) * fade;
    siz[i]     = 0.022 + Math.random() * 0.026;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color",    new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aSize",    new THREE.BufferAttribute(siz, 1));
  return geo;
}

// ─── Ghost pool (pre-allocated mesh slots) ────────────────────────────────────

interface GhostSlot { mesh: THREE.Mesh; mat: THREE.ShaderMaterial }

class GhostPool {
  private slots: GhostSlot[];
  private assigned = new Map<string, number>();

  constructor(private group: THREE.Group) {
    this.slots = Array.from({ length: GHOST_POOL_SIZE }, () => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: SOAP_VERT, fragmentShader: SOAP_FRAG,
        transparent: true, blending: THREE.NormalBlending,
        depthWrite: false, side: THREE.DoubleSide,
        uniforms: {
          uTime:      sharedTime,
          uBaseColor: { value: new THREE.Color(1, 1, 1) },
          uFade:      { value: 0.55 },
        },
      });
      const mesh = new THREE.Mesh(ghostSphereGeo, mat);
      mesh.renderOrder = 1;
      mesh.visible     = false;
      group.add(mesh);
      return { mesh, mat };
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
    slot.mat.uniforms.uBaseColor.value.setRGB(...color);
    slot.mesh.position.copy(worldPos);
    slot.mesh.visible = true;
  }

  releaseStale(activeIds: Set<string>): void {
    for (const [id, idx] of this.assigned) {
      if (!activeIds.has(id)) {
        this.slots[idx].mesh.visible = false;
        this.assigned.delete(id);
      }
    }
  }

  tick(dt: number, time: number): void {
    for (const [, idx] of this.assigned) {
      const m = this.slots[idx].mesh;
      m.rotation.y += dt * 0.38;
      m.rotation.x  = Math.sin(time * 0.24 + idx) * 0.10;
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

  private orbMesh:   THREE.Mesh;
  private orbMat:    THREE.ShaderMaterial;
  private streamMat: THREE.ShaderMaterial;
  private ghostPool: GhostPool;
  private streams = new Map<string, THREE.Points>();

  private time    = 0;
  private myColor: [number, number, number] = [1, 1, 1];

  private popPhase: PopPhase  = "idle";
  private popTimer = 0;

  private growPhase: GrowPhase = "idle";
  private growTimer = 0;

  private proxScale       = 1.0;
  private targetProxScale = 1.0;

  constructor() {
    this.orbMat = new THREE.ShaderMaterial({
      vertexShader: SOAP_VERT, fragmentShader: SOAP_FRAG,
      transparent: true, blending: THREE.NormalBlending,
      depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        uTime:      sharedTime,
        uBaseColor: { value: new THREE.Color(1, 1, 1) },
        uFade:      { value: 1.0 },
      },
    });
    this.orbMesh = new THREE.Mesh(orbSphereGeo, this.orbMat);
    this.orbMesh.renderOrder = 2;
    this.orbGroup.add(this.orbMesh);

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
    sharedTime.value   = this.time;
    sharedHeight.value = physH;

    this.updatePop(dt);
    this.proxScale += (this.targetProxScale - this.proxScale) * Math.min(dt * 3.5, 1.0);
    if (this.popPhase === "idle") {
      this.orbGroup.scale.setScalar(this.proxScale * this.getGrowScale(dt));
    }

    this.orbMesh.rotation.y += dt * 0.32;
    this.orbMesh.rotation.x  = Math.sin(this.time * 0.26) * 0.09;
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
      const dx       = (other.screenX + other.width  * 0.5 - myCX) * scale;
      const dy       = -(other.screenY + other.height * 0.5 - myCY) * scale;
      const strength = Math.pow(1 - gap / STREAM_RANGE_PX, 0.55);
      close.push({ id, info: other, dir: new THREE.Vector3(dx, dy, 0), strength });
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
      const s = new THREE.Points(buildStreamGeo(dir, this.myColor, info.color, this.time, strength), this.streamMat);
      s.renderOrder = 3;
      this.streams.set(id, s);
      this.orbGroup.add(s);
    }
  }

  private updatePop(dt: number): void {
    if (this.popPhase === "idle") return;
    this.popTimer += dt;

    if (this.popPhase === "burst") {
      const p = Math.min(this.popTimer / 0.35, 1.0);
      this.orbMat.uniforms.uFade.value = 1.0 - p;
      // Scale up slightly as the bubble pops
      this.orbGroup.scale.setScalar(this.proxScale * this.getGrowScale(0) * (1.0 + p * 0.55));
      if (p >= 1.0) {
        this.popPhase = "pause";
        this.popTimer = 0;
        this.orbGroup.visible = false;
      }
    } else if (this.popPhase === "pause") {
      if (this.popTimer >= 0.12) {
        this.popPhase = "reform";
        this.popTimer = 0;
        this.orbMat.uniforms.uFade.value = 1.0;
        this.orbGroup.visible = true;
        this.orbGroup.scale.setScalar(0);
      }
    } else if (this.popPhase === "reform") {
      const p = Math.min(this.popTimer / 0.65, 1.0);
      // Damped spring: 0 → overshoot → settle at 1
      const e     = Math.exp(-p * 5.0);
      const scale = Math.max(0, 1.0 - e * Math.cos(p * 9.0));
      this.orbGroup.scale.setScalar(scale * this.proxScale * this.getGrowScale(0));
      if (p >= 1.0) this.popPhase = "idle";
    }
  }

  private getGrowScale(dt: number): number {
    if (this.growPhase === "idle") return 1.0;

    this.growTimer += dt;

    if (this.growPhase === "grow") {
      const p    = Math.min(this.growTimer / 0.45, 1.0);
      const ease = p < 0.5 ? 4*p*p*p : 1 - Math.pow(-2*p + 2, 3) / 2;
      if (p >= 1.0) { this.growPhase = "shrink"; this.growTimer = 0; return 1.5; }
      return 1.0 + 0.5 * ease;
    }

    if (this.growPhase === "shrink") {
      const p     = Math.min(this.growTimer / 0.80, 1.0);
      const e     = Math.exp(-p * 6.0);
      const scale = 1.0 + 0.5 * e * Math.cos(p * 10.0);
      if (p >= 1.0) { this.growPhase = "idle"; this.growTimer = 0; return 1.0; }
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
    this.orbMat.dispose();
    this.streamMat.dispose();
    for (const [, s] of this.streams) s.geometry.dispose();
  }
}
