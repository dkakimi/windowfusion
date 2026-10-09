import * as THREE from "three";
import type { WindowInfo } from "./windowSync";

const PARTICLE_COUNT = 2000;
const INTERACTION_RANGE = 300;
const INTERACTION_K = 8000;
const GRAVITY_K = 0.3;
const MAX_SPEED = 300;
const Z_RANGE = 500; // -500 to +500

const vertexShader = /* glsl */ `
uniform float uWindowX;
uniform float uWindowY;
uniform float uWidth;
uniform float uHeight;
attribute float aSize;
attribute vec3 aColor;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vColor = aColor;

  // Convert screen-world position to NDC
  float nx = ((position.x - uWindowX) / uWidth) * 2.0 - 1.0;
  float ny = -(((position.y - uWindowY) / uHeight) * 2.0 - 1.0);
  float nz = position.z / 1000.0;

  gl_Position = vec4(nx, ny, nz, 1.0);

  // Size based on depth (closer = bigger)
  float depth = (position.z + 500.0) / 1000.0; // 0 to 1
  gl_PointSize = aSize * (0.5 + depth);

  vAlpha = 0.3 + depth * 0.7;
}
`;

const fragmentShader = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = length(coord);
  if (dist > 0.5) discard;

  float alpha = 1.0 - smoothstep(0.1, 0.5, dist);
  alpha *= vAlpha;

  // Glow: bright core, colored halo
  vec3 color = mix(vec3(1.0), vColor, smoothstep(0.0, 0.3, dist));

  gl_FragColor = vec4(color, alpha);
}
`;

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  g: number;
  b: number;
  size: number;
}

export class ParticleSystem {
  private particles: Particle[];
  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;
  points: THREE.Points;

  private positionAttr: THREE.BufferAttribute;
  private colorAttr: THREE.BufferAttribute;
  private sizeAttr: THREE.BufferAttribute;

  constructor() {
    this.particles = [];
    this.geometry = new THREE.BufferGeometry();

    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const colors = new Float32Array(PARTICLE_COUNT * 3);
    const sizes = new Float32Array(PARTICLE_COUNT);

    this.positionAttr = new THREE.BufferAttribute(positions, 3);
    this.colorAttr = new THREE.BufferAttribute(colors, 3);
    this.sizeAttr = new THREE.BufferAttribute(sizes, 1);

    this.geometry.setAttribute("position", this.positionAttr);
    this.geometry.setAttribute("aColor", this.colorAttr);
    this.geometry.setAttribute("aSize", this.sizeAttr);

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      uniforms: {
        uWindowX: { value: 0 },
        uWindowY: { value: 0 },
        uWidth: { value: 1 },
        uHeight: { value: 1 },
      },
    });

    this.points = new THREE.Points(this.geometry, this.material);

    // Particles will be initialized on first update when we have window info
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.particles.push({
        x: 0,
        y: 0,
        z: (Math.random() - 0.5) * Z_RANGE * 2,
        vx: (Math.random() - 0.5) * 100,
        vy: (Math.random() - 0.5) * 100,
        vz: (Math.random() - 0.5) * 50,
        r: Math.random(),
        g: Math.random(),
        b: Math.random() * 0.5 + 0.5,
        size: Math.random() * 8 + 4,
      });
    }
  }

  private spawnParticles(myWindow: WindowInfo): void {
    for (const p of this.particles) {
      p.x = myWindow.screenX + Math.random() * myWindow.width;
      p.y = myWindow.screenY + Math.random() * myWindow.height;

      // Pick a color palette: cyan/blue/purple/white
      const hue = Math.random();
      if (hue < 0.33) {
        // Cyan
        p.r = 0.0;
        p.g = 0.8 + Math.random() * 0.2;
        p.b = 1.0;
      } else if (hue < 0.66) {
        // Purple/violet
        p.r = 0.5 + Math.random() * 0.5;
        p.g = 0.0;
        p.b = 1.0;
      } else {
        // White/blue
        p.r = 0.6 + Math.random() * 0.4;
        p.g = 0.6 + Math.random() * 0.4;
        p.b = 1.0;
      }
    }
  }

  private initialized = false;

  update(dt: number, myWindow: WindowInfo, otherWindows: Map<string, WindowInfo>): void {
    if (!this.initialized) {
      this.spawnParticles(myWindow);
      this.initialized = true;
    }

    const winLeft = myWindow.screenX;
    const winRight = myWindow.screenX + myWindow.width;
    const winTop = myWindow.screenY;
    const winBottom = myWindow.screenY + myWindow.height;
    const winCenterX = myWindow.screenX + myWindow.width / 2;
    const winCenterY = myWindow.screenY + myWindow.height / 2;

    // Gather other window infos as array for interaction
    const others = Array.from(otherWindows.values());

    for (const p of this.particles) {
      // --- Interaction forces with other windows ---
      for (const other of others) {
        const otherLeft = other.screenX;
        const otherRight = other.screenX + other.width;
        const otherTop = other.screenY;
        const otherBottom = other.screenY + other.height;
        const otherCenterX = other.screenX + other.width / 2;
        const otherCenterY = other.screenY + other.height / 2;

        // Determine the closest edge distance between the two windows
        // Horizontal overlap / gap
        const hGap = Math.max(0, Math.max(winLeft, otherLeft) - Math.min(winRight, otherRight));
        // Vertical overlap / gap
        const vGap = Math.max(0, Math.max(winTop, otherTop) - Math.min(winBottom, otherBottom));

        const edgeDist = Math.sqrt(hGap * hGap + vGap * vGap);

        if (edgeDist > INTERACTION_RANGE) continue;

        // Determine particle's distance to the shared edge region
        // Find the closest point on the other window's bounding rect to this particle
        const clampedX = Math.max(otherLeft, Math.min(otherRight, p.x));
        const clampedY = Math.max(otherTop, Math.min(otherBottom, p.y));
        const dxEdge = p.x - clampedX;
        const dyEdge = p.y - clampedY;
        const distToOther = Math.sqrt(dxEdge * dxEdge + dyEdge * dyEdge);

        if (distToOther > INTERACTION_RANGE) continue;

        // Force directed toward the other window's center
        const dxCenter = otherCenterX - p.x;
        const dyCenter = otherCenterY - p.y;
        const distCenter = Math.sqrt(dxCenter * dxCenter + dyCenter * dyCenter) + 1;

        // Falloff: stronger as windows get closer
        const proximityFactor = 1.0 - edgeDist / INTERACTION_RANGE;
        // Particle closeness to edge boosts force
        const particleFactor = 1.0 - Math.min(distToOther, INTERACTION_RANGE) / INTERACTION_RANGE;

        const forceMag = INTERACTION_K * proximityFactor * particleFactor / (distCenter * distCenter + 100);

        p.vx += (dxCenter / distCenter) * forceMag * dt;
        p.vy += (dyCenter / distCenter) * forceMag * dt;

        // Color shift toward other window interaction (slight pull toward white/bright)
        p.r = Math.min(1.0, p.r + 0.01 * proximityFactor);
        p.g = Math.min(1.0, p.g + 0.005 * proximityFactor);
      }

      // --- Gravity toward window center ---
      const dxC = winCenterX - p.x;
      const dyC = winCenterY - p.y;
      const distC = Math.sqrt(dxC * dxC + dyC * dyC) + 1;
      p.vx += (dxC / distC) * GRAVITY_K * dt * distC * 0.01;
      p.vy += (dyC / distC) * GRAVITY_K * dt * distC * 0.01;

      // Small random jitter for liveliness
      p.vx += (Math.random() - 0.5) * 20 * dt;
      p.vy += (Math.random() - 0.5) * 20 * dt;
      p.vz += (Math.random() - 0.5) * 10 * dt;

      // Damping
      p.vx *= 0.98;
      p.vy *= 0.98;
      p.vz *= 0.97;

      // Clamp speed
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (speed > MAX_SPEED) {
        p.vx = (p.vx / speed) * MAX_SPEED;
        p.vy = (p.vy / speed) * MAX_SPEED;
      }

      // --- Move ---
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      // --- Bounce off window edges (screen coords) ---
      const margin = 10;
      if (p.x < winLeft + margin) {
        p.x = winLeft + margin;
        p.vx = Math.abs(p.vx) * 0.6;
      }
      if (p.x > winRight - margin) {
        p.x = winRight - margin;
        p.vx = -Math.abs(p.vx) * 0.6;
      }
      if (p.y < winTop + margin) {
        p.y = winTop + margin;
        p.vy = Math.abs(p.vy) * 0.6;
      }
      if (p.y > winBottom - margin) {
        p.y = winBottom - margin;
        p.vy = -Math.abs(p.vy) * 0.6;
      }

      // Z bounce
      if (p.z < -Z_RANGE) {
        p.z = -Z_RANGE;
        p.vz = Math.abs(p.vz) * 0.6;
      }
      if (p.z > Z_RANGE) {
        p.z = Z_RANGE;
        p.vz = -Math.abs(p.vz) * 0.6;
      }
    }

    // Update uniforms
    this.material.uniforms.uWindowX.value = myWindow.screenX;
    this.material.uniforms.uWindowY.value = myWindow.screenY;
    this.material.uniforms.uWidth.value = myWindow.width;
    this.material.uniforms.uHeight.value = myWindow.height;

    // Write to buffer attributes
    const posArr = this.positionAttr.array as Float32Array;
    const colArr = this.colorAttr.array as Float32Array;
    const sizeArr = this.sizeAttr.array as Float32Array;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = this.particles[i];
      posArr[i * 3] = p.x;
      posArr[i * 3 + 1] = p.y;
      posArr[i * 3 + 2] = p.z;
      colArr[i * 3] = p.r;
      colArr[i * 3 + 1] = p.g;
      colArr[i * 3 + 2] = p.b;
      sizeArr[i] = p.size;
    }

    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
