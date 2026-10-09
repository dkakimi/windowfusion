import * as THREE from "three";
import type { WindowInfo } from "./windowSync";

const PARTICLE_COUNT = 1500;
const INTERACTION_RANGE = 350;  // screen px between window edges to trigger interaction
const ATTRACTION_K = 15000;     // force constant toward other window edge
const GRAVITY_K = 0.015;        // gentle pull toward own window center
const DAMPING = 0.97;
const MAX_SPEED = 400;
const Z_RANGE = 300;

// Sphere with Phong lighting — particles look like solid 3D balls
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

  float nx = ((position.x - uWindowX) / uWidth) * 2.0 - 1.0;
  float ny = -(((position.y - uWindowY) / uHeight) * 2.0 - 1.0);
  float nz = position.z / (float(${Z_RANGE}) * 2.0);

  gl_Position = vec4(nx, ny, nz, 1.0);

  // Depth-based size: closer (z > 0) = bigger
  float depthScale = 0.6 + 0.4 * ((position.z + float(${Z_RANGE})) / float(${Z_RANGE * 2}));
  gl_PointSize = aSize * depthScale;

  vAlpha = 0.7 + 0.3 * depthScale;
}
`;

// Phong-shaded sphere SDF on gl_PointCoord
const fragmentShader = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;

void main() {
  // Map PointCoord to [-1, 1]
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;

  // Surface normal of sphere at this fragment
  vec3 N = normalize(vec3(uv, sqrt(1.0 - r2)));

  // Key light from upper-right-front
  vec3 L = normalize(vec3(0.8, 1.2, 2.0));
  // View direction (orthographic → constant)
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 H = normalize(L + V);

  float diff = max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, H), 0.0), 80.0);

  vec3 ambient  = vColor * 0.18;
  vec3 diffuse  = vColor * diff * 0.82;
  vec3 specular = vec3(1.0) * spec * 0.55;

  vec3 color = ambient + diffuse + specular;
  gl_FragColor = vec4(color, vAlpha);
}
`;

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  // Base color of this window (never changes)
  br: number; bg: number; bb: number;
  // Rendered color (lerps toward other window's color near edges)
  r: number; g: number; b: number;
  size: number;
}

export class ParticleSystem {
  private particles: Particle[] = [];
  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;
  points: THREE.Points;

  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private sizeAttr: THREE.BufferAttribute;
  private initialized = false;

  constructor() {
    this.geometry = new THREE.BufferGeometry();

    const pos  = new Float32Array(PARTICLE_COUNT * 3);
    const col  = new Float32Array(PARTICLE_COUNT * 3);
    const size = new Float32Array(PARTICLE_COUNT);

    this.posAttr  = new THREE.BufferAttribute(pos, 3);
    this.colAttr  = new THREE.BufferAttribute(col, 3);
    this.sizeAttr = new THREE.BufferAttribute(size, 1);

    this.geometry.setAttribute("position", this.posAttr);
    this.geometry.setAttribute("aColor",   this.colAttr);
    this.geometry.setAttribute("aSize",    this.sizeAttr);

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      blending: THREE.NormalBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uWindowX: { value: 0 },
        uWindowY: { value: 0 },
        uWidth:   { value: 1 },
        uHeight:  { value: 1 },
      },
    });

    this.points = new THREE.Points(this.geometry, this.material);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.particles.push({
        x: 0, y: 0, z: (Math.random() - 0.5) * Z_RANGE * 2,
        vx: (Math.random() - 0.5) * 80,
        vy: (Math.random() - 0.5) * 80,
        vz: (Math.random() - 0.5) * 30,
        br: 1, bg: 1, bb: 1,
        r: 1, g: 1, b: 1,
        size: Math.random() * 10 + 14, // 14–24px
      });
    }
  }

  private spawn(myWindow: WindowInfo): void {
    const [br, bg, bb] = myWindow.color;
    for (const p of this.particles) {
      p.x = myWindow.screenX + myWindow.width  * (0.15 + Math.random() * 0.7);
      p.y = myWindow.screenY + myWindow.height * (0.15 + Math.random() * 0.7);
      p.br = br; p.bg = bg; p.bb = bb;
      p.r  = br; p.g  = bg; p.b  = bb;
    }
  }

  update(dt: number, myWindow: WindowInfo, otherWindows: Map<string, WindowInfo>): void {
    if (!this.initialized) {
      this.spawn(myWindow);
      this.initialized = true;
    }

    const wL = myWindow.screenX;
    const wR = myWindow.screenX + myWindow.width;
    const wT = myWindow.screenY;
    const wB = myWindow.screenY + myWindow.height;
    const cX = myWindow.screenX + myWindow.width  / 2;
    const cY = myWindow.screenY + myWindow.height / 2;

    const others = Array.from(otherWindows.values());

    for (const p of this.particles) {
      // Reset color to base each frame, then accumulate mixing
      let mixR = 0, mixG = 0, mixB = 0, totalMix = 0;

      for (const other of others) {
        const oL = other.screenX;
        const oR = other.screenX + other.width;
        const oT = other.screenY;
        const oB = other.screenY + other.height;

        // Gap between the two window rectangles
        const hGap = Math.max(0, Math.max(wL, oL) - Math.min(wR, oR));
        const vGap = Math.max(0, Math.max(wT, oT) - Math.min(wB, oB));
        const edgeDist = Math.sqrt(hGap * hGap + vGap * vGap);

        if (edgeDist > INTERACTION_RANGE) continue;

        // Closest point on other window to this particle
        const cx = Math.max(oL, Math.min(oR, p.x));
        const cy = Math.max(oT, Math.min(oB, p.y));
        const dx = p.x - cx;
        const dy = p.y - cy;
        const distToEdge = Math.sqrt(dx * dx + dy * dy);

        if (distToEdge > INTERACTION_RANGE) continue;

        // windowProximity: 1 = windows touching, 0 = at max range
        const windowProximity = 1 - edgeDist / INTERACTION_RANGE;
        // particleProximity: 1 = at edge, 0 = at max range
        const particleProximity = 1 - distToEdge / INTERACTION_RANGE;

        // Attraction toward the nearest point on the other window
        const forceMag = ATTRACTION_K * windowProximity * particleProximity;
        const len = distToEdge + 1;
        p.vx -= (dx / len) * forceMag * dt;
        p.vy -= (dy / len) * forceMag * dt;

        // Accumulate color mix contribution
        const mixWeight = windowProximity * particleProximity;
        mixR += other.color[0] * mixWeight;
        mixG += other.color[1] * mixWeight;
        mixB += other.color[2] * mixWeight;
        totalMix += mixWeight;
      }

      // Apply color mixing
      if (totalMix > 0) {
        const t = Math.min(totalMix, 1.0);
        const avgR = mixR / totalMix;
        const avgG = mixG / totalMix;
        const avgB = mixB / totalMix;
        p.r = p.br * (1 - t) + avgR * t;
        p.g = p.bg * (1 - t) + avgG * t;
        p.b = p.bb * (1 - t) + avgB * t;
      } else {
        p.r = p.br; p.g = p.bg; p.b = p.bb;
      }

      // Gentle gravity toward window center
      const gdx = cX - p.x;
      const gdy = cY - p.y;
      const gdist = Math.sqrt(gdx * gdx + gdy * gdy) + 1;
      p.vx += gdx * GRAVITY_K * dt;
      p.vy += gdy * GRAVITY_K * dt;

      // Tiny random jitter for organic motion
      p.vx += (Math.random() - 0.5) * 12 * dt;
      p.vy += (Math.random() - 0.5) * 12 * dt;
      p.vz += (Math.random() - 0.5) *  6 * dt;

      // Damping + speed clamp
      p.vx *= DAMPING; p.vy *= DAMPING; p.vz *= 0.96;
      const spd = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (spd > MAX_SPEED) { p.vx = p.vx / spd * MAX_SPEED; p.vy = p.vy / spd * MAX_SPEED; }

      // Integrate
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      // Soft bounce off own window edges — particles press against the wall
      const m = 8;
      if (p.x < wL + m) { p.x = wL + m; p.vx = Math.abs(p.vx) * 0.5; }
      if (p.x > wR - m) { p.x = wR - m; p.vx = -Math.abs(p.vx) * 0.5; }
      if (p.y < wT + m) { p.y = wT + m; p.vy = Math.abs(p.vy) * 0.5; }
      if (p.y > wB - m) { p.y = wB - m; p.vy = -Math.abs(p.vy) * 0.5; }
      if (p.z < -Z_RANGE) { p.z = -Z_RANGE; p.vz =  Math.abs(p.vz) * 0.5; }
      if (p.z >  Z_RANGE) { p.z =  Z_RANGE; p.vz = -Math.abs(p.vz) * 0.5; }
    }

    // Update uniforms
    this.material.uniforms.uWindowX.value = myWindow.screenX;
    this.material.uniforms.uWindowY.value = myWindow.screenY;
    this.material.uniforms.uWidth.value   = myWindow.width;
    this.material.uniforms.uHeight.value  = myWindow.height;

    // Write buffers
    const posArr  = this.posAttr.array  as Float32Array;
    const colArr  = this.colAttr.array  as Float32Array;
    const sizeArr = this.sizeAttr.array as Float32Array;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = this.particles[i];
      posArr[i * 3]     = p.x;
      posArr[i * 3 + 1] = p.y;
      posArr[i * 3 + 2] = p.z;
      colArr[i * 3]     = p.r;
      colArr[i * 3 + 1] = p.g;
      colArr[i * 3 + 2] = p.b;
      sizeArr[i] = p.size;
    }

    this.posAttr.needsUpdate  = true;
    this.colAttr.needsUpdate  = true;
    this.sizeAttr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
