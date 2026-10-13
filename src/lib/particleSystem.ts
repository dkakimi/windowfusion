import * as THREE from "three";
import type { WindowInfo } from "./windowSync";

const SPHERE_RADIUS = 1.8;
const SPHERE_SEGS_W = 96;
const SPHERE_SEGS_H = 48;
const GHOST_POOL_SIZE = 8;
export const CAMERA_Z = 5;
export const FOV_DEG  = 75;

export function screenScale(innerH: number): number {
  return Math.tan((FOV_DEG * 0.5) * (Math.PI / 180)) * CAMERA_Z / (innerH * 0.5);
}

export function isOverlapping(a: WindowInfo, b: WindowInfo): boolean {
  return !(
    a.screenX + a.width  <= b.screenX || b.screenX + b.width  <= a.screenX ||
    a.screenY + a.height <= b.screenY || b.screenY + b.height <= a.screenY
  );
}

export function centerDistPx(a: WindowInfo, b: WindowInfo): number {
  const dx = (a.screenX + a.width  * 0.5) - (b.screenX + b.width  * 0.5);
  const dy = (a.screenY + a.height * 0.5) - (b.screenY + b.height * 0.5);
  return Math.sqrt(dx * dx + dy * dy);
}

// ─── Shared time uniform ──────────────────────────────────────────────────────

const sharedTime: THREE.IUniform<number> = { value: 0 };

// ─── Soap bubble mesh shaders ─────────────────────────────────────────────────

const SOAP_VERT = /* glsl */`
uniform float uTime;

varying vec3 vNormal;
varying vec3 vViewDir;

void main() {
  vec3 n = normalize(normal);
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
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(vViewDir);

  float cosTheta = dot(N, V);
  float fresnel  = 1.0 - max(cosTheta, 0.0);
  float rim      = pow(fresnel, 1.4);

  float phase = rim * 5.5 + uTime * 0.45;
  vec3 irid = vec3(
    sin(phase)         * 0.5 + 0.5,
    sin(phase + 2.094) * 0.5 + 0.5,
    sin(phase + 4.189) * 0.5 + 0.5
  );

  vec3  L1 = normalize(vec3( 0.6,  0.9, 1.0));
  vec3  L2 = normalize(vec3(-0.5, -0.3, 0.8));
  float s1 = pow(max(dot(reflect(-L1, N), V), 0.0), 40.0);
  float s2 = pow(max(dot(reflect(-L2, N), V), 0.0), 20.0) * 0.30;
  float spec = s1 + s2;

  vec3 col = mix(uBaseColor * 0.10, irid * 0.95 + uBaseColor * 0.45, rim * 0.92);
  col += spec * 1.0;

  float alpha = pow(rim, 0.85) * 0.92 + spec * 0.90 + 0.010;
  alpha = clamp(alpha * uFade, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}`;

// ─── Shared sphere geometries ─────────────────────────────────────────────────

const orbSphereGeo   = new THREE.SphereGeometry(SPHERE_RADIUS,        SPHERE_SEGS_W, SPHERE_SEGS_H);
const ghostSphereGeo = new THREE.SphereGeometry(SPHERE_RADIUS * 0.88, 64,            32);

// ─── Ghost pool ───────────────────────────────────────────────────────────────

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

type PopPhase    = "idle" | "burst" | "pause" | "reform";
type GrowPhase   = "idle" | "grow"  | "shrink";
type AbsorbPhase = "idle" | "shrinking";

export class ParticleSystem {
  readonly orbGroup   = new THREE.Group();
  readonly ghostGroup = new THREE.Group();

  private orbMesh: THREE.Mesh;
  private orbMat:  THREE.ShaderMaterial;
  private ghostPool: GhostPool;

  private time = 0;

  // Pop animation (ambient or annihilate)
  private popPhase: PopPhase = "idle";
  private popTimer = 0;
  private onPopComplete?: () => void;

  // Grow/merge animation (triggered by collision)
  private growPhase: GrowPhase = "idle";
  private growTimer = 0;

  // Absorb animation (victim shrinks into survivor)
  private absorbPhase: AbsorbPhase = "idle";
  private absorbTimer = 0;
  private onAbsorbComplete?: () => void;

  // Accumulated permanent scale (grows with each merge)
  private permanentScale = 1.0;

  // Proximity-based subtle scale
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
    this.ghostPool = new GhostPool(this.ghostGroup);
  }

  init(color: [number, number, number]): void {
    this.orbMat.uniforms.uBaseColor.value.setRGB(...color);
  }

  // Ambient random pop → reforms after
  triggerPop(onDone?: () => void): void {
    if (this.popPhase !== "idle" || this.absorbPhase !== "idle") return;
    this.onPopComplete = onDone;
    this.popPhase = "burst";
    this.popTimer = 0;
  }

  // Survivor animation: bubble swells, permanently larger afterwards
  triggerMergeGrow(): void {
    if (this.absorbPhase !== "idle") return;
    // Increase permanent size, then do a dramatic overshoot animation
    this.permanentScale = Math.min(this.permanentScale * 1.30, 2.8);
    if (this.growPhase === "idle" && this.popPhase === "idle") {
      this.growPhase = "grow";
      this.growTimer = 0;
    }
  }

  // Victim animation: bubble shrinks to nothing, then calls onDone
  triggerAbsorb(onDone: () => void): void {
    if (this.absorbPhase !== "idle") return;
    this.absorbPhase    = "shrinking";
    this.absorbTimer    = 0;
    this.onAbsorbComplete = onDone;
  }

  setNearby(hasNearby: boolean): void {
    this.targetProxScale = hasNearby ? 1.15 : 1.0;
  }

  update(dt: number): void {
    this.time += dt;
    sharedTime.value = this.time;

    this.updatePop(dt);
    this.updateAbsorb(dt);

    this.proxScale += (this.targetProxScale - this.proxScale) * Math.min(dt * 3.5, 1.0);

    const growMul = this.computeGrow(dt);
    if (this.popPhase === "idle" && this.absorbPhase === "idle") {
      this.orbGroup.scale.setScalar(this.proxScale * this.permanentScale * growMul);
    }

    this.orbMesh.rotation.y += dt * 0.32;
    this.orbMesh.rotation.x  = Math.sin(this.time * 0.26) * 0.09;
    this.ghostPool.tick(dt, this.time);
  }

  private updatePop(dt: number): void {
    if (this.popPhase === "idle") return;
    this.popTimer += dt;

    if (this.popPhase === "burst") {
      const p = Math.min(this.popTimer / 0.35, 1.0);
      this.orbMat.uniforms.uFade.value = 1.0 - p;
      // Scale expands slightly as the bubble pops
      this.orbGroup.scale.setScalar(this.proxScale * this.permanentScale * (1.0 + p * 0.55));
      if (p >= 1.0) {
        this.popPhase = "pause";
        this.popTimer = 0;
        this.orbGroup.visible = false;
      }

    } else if (this.popPhase === "pause") {
      if (this.popTimer >= 0.12) {
        if (this.onPopComplete) {
          // Annihilate mode: don't reform, call callback
          const cb = this.onPopComplete;
          this.onPopComplete = undefined;
          this.popPhase = "idle";
          cb();
          return;
        }
        // Ambient pop: reform
        this.popPhase = "reform";
        this.popTimer = 0;
        this.orbMat.uniforms.uFade.value = 1.0;
        this.orbGroup.visible = true;
        this.orbGroup.scale.setScalar(0);
      }

    } else if (this.popPhase === "reform") {
      const p = Math.min(this.popTimer / 0.65, 1.0);
      // Damped spring: 0 → overshoot → settle
      const e     = Math.exp(-p * 5.0);
      const scale = Math.max(0, 1.0 - e * Math.cos(p * 9.0));
      this.orbGroup.scale.setScalar(scale * this.proxScale * this.permanentScale);
      if (p >= 1.0) this.popPhase = "idle";
    }
  }

  private updateAbsorb(dt: number): void {
    if (this.absorbPhase === "idle") return;
    this.absorbTimer += dt;
    const p     = Math.min(this.absorbTimer / 0.50, 1.0);
    const eased = p * p; // ease-in: slow start, accelerates
    this.orbMat.uniforms.uFade.value = Math.max(0, 1.0 - eased * 1.5);
    this.orbGroup.scale.setScalar(Math.max(0, 1.0 - eased) * this.proxScale * this.permanentScale);
    if (p >= 1.0) {
      this.absorbPhase = "idle";
      this.orbGroup.visible = false;
      const cb = this.onAbsorbComplete;
      this.onAbsorbComplete = undefined;
      cb?.();
    }
  }

  private computeGrow(dt: number): number {
    if (this.growPhase === "idle") return 1.0;

    this.growTimer += dt;

    if (this.growPhase === "grow") {
      const p    = Math.min(this.growTimer / 0.50, 1.0);
      const ease = p < 0.5 ? 4*p*p*p : 1 - Math.pow(-2*p + 2, 3) / 2;
      if (p >= 1.0) { this.growPhase = "shrink"; this.growTimer = 0; return 1.6; }
      return 1.0 + 0.6 * ease;
    }

    if (this.growPhase === "shrink") {
      const p     = Math.min(this.growTimer / 0.85, 1.0);
      const e     = Math.exp(-p * 6.0);
      const scale = 1.0 + 0.6 * e * Math.cos(p * 9.5);
      if (p >= 1.0) { this.growPhase = "idle"; this.growTimer = 0; return 1.0; }
      return Math.max(0.85, scale);
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
  }
}
