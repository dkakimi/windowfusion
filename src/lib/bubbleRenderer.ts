import * as THREE from "three";
import { shell } from "./host";

const GHOST_POOL_SIZE = 4;
const DROPLET_COUNT   = 180;
// Narrow FOV keeps the sphere's silhouette close to its nominal radius.
export const CAMERA_Z = 10;
export const FOV_DEG  = 30;

// World units per CSS pixel at the z=0 plane.
export function screenScale(innerH: number): number {
  return Math.tan((FOV_DEG * 0.5) * (Math.PI / 180)) * CAMERA_Z / (innerH * 0.5);
}

// ─── Window sizing ────────────────────────────────────────────────────────────

// Window content side = bubble diameter × WINDOW_PAD. The window hugs its bubble.
export const WINDOW_PAD = 1.3;
// The rendered bubble never exceeds min(innerW, innerH) / (2 × FIT_MARGIN), so it
// always fits even if the browser refuses or clamps a resize.
export const FIT_MARGIN = 1.14;
export const R_SPAWN_MIN = 45;
export const R_SPAWN_MAX = 95;
// Bubbles smaller than this pop instead of splitting when clicked.
export const R_SPLIT_MIN = 52;

export function windowSideFor(r: number): number {
  return Math.ceil(2 * r * WINDOW_PAD);
}

export interface SpawnOptions {
  r: number;
  cx: number;   // desired bubble center, screen px
  cy: number;
  vx?: number;
  vy?: number;
  birth?: "blow" | "split";
}

// Opened with `noopener` so each bubble window lands in its own browsing-context
// group (and usually its own renderer process). Otherwise every window shares one
// main thread, and closing any of them stalls all the others.
// Note: with noopener window.open always returns null, so callers cannot detect
// pop-up blocking from the return value.
export function openBubbleWindow(o: SpawnOptions): void {
  const s  = screen as Screen & { availLeft?: number; availTop?: number };
  const aL = s.availLeft ?? 0;
  const aT = s.availTop  ?? 0;
  const side = windowSideFor(o.r);
  const left = Math.round(Math.min(Math.max(o.cx - side / 2, aL), aL + screen.availWidth  - side));
  const top  = Math.round(Math.min(Math.max(o.cy - side / 2, aT), aT + screen.availHeight - side));
  const q = new URLSearchParams({ launched: "1", r: o.r.toFixed(1), birth: o.birth ?? "blow" });
  if (o.vx !== undefined) q.set("vx", o.vx.toFixed(1));
  if (o.vy !== undefined) q.set("vy", o.vy.toFixed(1));

  // Electron: reuse a pooled transparent window — no pop-up limits, no window creation
  const wf = shell();
  if (wf) { wf.spawn({ query: q.toString(), x: left, y: top, side }); return; }

  window.open(
    `${window.location.origin}/?${q}`,
    "_blank",
    `noopener,width=${side},height=${side},left=${left},top=${top}`,
  );
}

// ─── Spectral tables (computed once on the CPU) ───────────────────────────────
// Thin-film reflectance is evaluated at 16 wavelengths; each wavelength's
// contribution is pre-converted CIE 1931 → linear sRGB and white-balanced so a
// spectrally flat reflectance maps to neutral grey.

const SPECTRAL_SAMPLES = 40;
const FILM_LUT_SIZE    = 512;
const FILM_LUT_MAX_NM  = 2000;   // max of thickness × cosθt the LUT covers
const NOISE_SIZE       = 32;

function cie(l: number): [number, number, number] {
  const g = (x: number, mu: number, s1: number, s2: number) => {
    const t = (x - mu) * (x < mu ? s1 : s2);
    return Math.exp(-0.5 * t * t);
  };
  // Wyman, Sloan & Shirley 2013 multi-lobe fit
  return [
    1.056 * g(l, 599.8, 0.0264, 0.0323) + 0.362 * g(l, 442.0, 0.0624, 0.0374) - 0.065 * g(l, 501.1, 0.0490, 0.0382),
    0.821 * g(l, 568.8, 0.0213, 0.0247) + 0.286 * g(l, 530.9, 0.0613, 0.0322),
    1.217 * g(l, 437.0, 0.0845, 0.0278) + 0.681 * g(l, 459.0, 0.0385, 0.0725),
  ];
}

function xyzToRgb([x, y, z]: [number, number, number]): [number, number, number] {
  return [
     3.2406 * x - 1.5372 * y - 0.4986 * z,
    -0.9689 * x + 1.8758 * y + 0.0415 * z,
     0.0557 * x - 0.2040 * y + 1.0570 * z,
  ];
}

// Thin-film interference: two reflections, one with a π phase flip.
// R(λ) ∝ sin²(2π·n·d·cosθt / λ) → black for very thin films (≈ 0 nm).
// The color depends only on d·cosθt, so it is baked once into a 1D lookup
// texture instead of integrating the spectrum per pixel.
const filmLUT: THREE.DataTexture = (() => {
  const lambdas = Array.from({ length: SPECTRAL_SAMPLES }, (_, i) => 400 + i * (300 / (SPECTRAL_SAMPLES - 1)));
  const rgb = lambdas.map(l => xyzToRgb(cie(l)));
  const white = rgb.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]);
  const data = new Uint8Array(FILM_LUT_SIZE * 4);
  for (let t = 0; t < FILM_LUT_SIZE; t++) {
    const x = (t + 0.5) / FILM_LUT_SIZE * FILM_LUT_MAX_NM;
    const acc = [0, 0, 0];
    lambdas.forEach((l, i) => {
      const s = Math.sin(2 * Math.PI * 1.33 * x / l);
      for (let c = 0; c < 3; c++) acc[c] += rgb[i][c] * s * s;
    });
    // ×2 because the mean of sin² is 0.5 — a thick film averages to white.
    // Stored halved so the 0..2 range fits in a byte.
    for (let c = 0; c < 3; c++) {
      data[t * 4 + c] = Math.round(THREE.MathUtils.clamp(acc[c] / white[c], 0, 1) * 255);
    }
    data[t * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, FILM_LUT_SIZE, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
})();

// Tileable 3D value noise: one trilinear texture fetch replaces eight hashes.
const noiseTex: THREE.Data3DTexture = (() => {
  const data = new Uint8Array(NOISE_SIZE ** 3);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(Math.random() * 256);
  const tex = new THREE.Data3DTexture(data, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
  tex.format = THREE.RedFormat;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
})();

// ─── Shared GLSL ──────────────────────────────────────────────────────────────

const NOISE_GLSL = /* glsl */`
#ifndef FBM_OCTAVES
#define FBM_OCTAVES 3
#endif
uniform sampler3D uNoise;
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 p) {
  return texture(uNoise, p * ${(1 / NOISE_SIZE).toFixed(6)}).r;
}
float fbm(vec3 p) {
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < FBM_OCTAVES; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}`;

// ─── Soap bubble shaders ──────────────────────────────────────────────────────

const SOAP_VERT = /* glsl */`
uniform float uTime;
uniform vec3  uSquashAxis;   // world-space unit vector
uniform float uSquash;       // >0 compresses along the axis, <0 stretches
uniform float uWobble;       // amplitude of silhouette ripple modes
uniform vec3  uPokeDir;      // world-space direction of the cursor dent
uniform float uPoke;

varying vec3  vNormalW;
varying vec3  vViewDir;
varying vec3  vLocalDir;
varying vec3  vWorldDir;
varying float vDent;
varying float vSeedOff;

#ifdef USE_INSTANCING
attribute float aSeed;   // per-instance film pattern offset
#endif

void main() {
#ifdef USE_INSTANCING
  mat4 model = modelMatrix * instanceMatrix;
  vSeedOff   = aSeed;
#else
  mat4 model = modelMatrix;
  vSeedOff   = 0.0;
#endif
  vec3 n  = normalize(position);
  vec3 wn = normalize(mat3(model) * n);

  // Breathing — a real bubble is almost a perfect sphere at rest.
  float d =
    sin(n.x * 1.9 + uTime * 0.55) * cos(n.y * 1.6 + uTime * 0.40) * 0.010 +
    sin(n.y * 2.3 + n.z * 1.7    + uTime * 0.70) * 0.007;

  // Capillary ripples travelling around the silhouette after impacts / merges.
  float ang = atan(wn.y, wn.x);
  float rim = 1.0 - wn.z * wn.z;
  d += uWobble * rim * (sin(ang * 3.0 + uTime * 9.0) * 0.6 + sin(ang * 5.0 - uTime * 13.0) * 0.4);

  // Cursor dent
  float dent = exp((dot(wn, uPokeDir) - 1.0) * 14.0) * uPoke;
  d -= dent * 0.16;
  vDent = dent;

  // Volume-preserving squash in world space (jelly response to wall hits).
  vec3  center = model[3].xyz;
  vec3  rel    = (model * vec4(position * (1.0 + d), 1.0)).xyz - center;
  float ka     = 1.0 - uSquash;
  float kp     = 1.0 + uSquash * 0.5;
  float along  = dot(rel, uSquashAxis);
  rel = uSquashAxis * along * ka + (rel - uSquashAxis * along) * kp;
  vec3 worldPos = center + rel;

  // Surface normal needs the inverse-transpose so non-uniformly scaled films
  // (the flattened cursor-ring film) shade correctly; wn is only a direction.
  vec3 nn   = normalize(transpose(inverse(mat3(model))) * n);
  vec3 wnA  = dot(nn, uSquashAxis) * uSquashAxis;
  vNormalW  = normalize(wnA / ka + (nn - wnA) / kp);
  vViewDir  = cameraPosition - worldPos;
  vLocalDir = n;
  vWorldDir = wn;
  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}`;

const SOAP_FRAG = /* glsl */`
// LITE (ghost bubbles): one less level of domain warp
uniform float uTime;
uniform vec3  uBaseColor;
uniform float uFade;
uniform float uAge;          // 0 fresh → 1 drained, about to burst
uniform float uSeed;
uniform float uPop;          // <0 intact, 0..1 hole sweeping across the film
uniform vec3  uPopDir;
uniform float uGlow;         // extra film visibility away from the rim (ring film)
uniform sampler2D uFilmLUT;

varying vec3  vNormalW;
varying vec3  vViewDir;
varying vec3  vLocalDir;
varying vec3  vWorldDir;
varying float vDent;
varying float vSeedOff;

${NOISE_GLSL}

vec3 filmColor(float d, float cosR) {
  return texture(uFilmLUT, vec2(d * cosR / ${FILM_LUT_MAX_NM.toFixed(1)}, 0.5)).rgb * 2.0;
}

// Rotate v about the unit axis a (Rodrigues)
vec3 rotAxis(vec3 v, vec3 a, float t) {
  float c = cos(t), s = sin(t);
  return v * c + cross(a, v) * s + a * dot(a, v) * (1.0 - c);
}

// Idle film flow: whirlpools that never stop. Each slot hosts one vortex at a
// time; it is born at a random spot, winds the film into a spiral while it
// drifts, then contracts into its own eye and vanishes before the slot respawns
// elsewhere — so the warp stays continuous and never over-winds.
#define VORTEX_SLOTS 3
vec3 vortexFlow(vec3 d, float seed) {
  for (int i = 0; i < VORTEX_SLOTS; i++) {
    float fi    = float(i);
    float life  = 7.0 + fi * 1.7;
    float t     = uTime / life + fi * 0.37 + fract(seed * 0.173);
    float cycle = floor(t);
    float ph    = t - cycle;
    vec3  k     = vec3(cycle, fi * 7.1, seed);
    vec3  c0    = normalize(vec3(hash31(k), hash31(k + 3.1), hash31(k + 7.7)) * 2.0 - 1.0 + 1e-3);
    vec3  c1    = normalize(vec3(hash31(k + 1.3), hash31(k + 5.9), hash31(k + 2.4)) * 2.0 - 1.0 + 1e-3);
    vec3  c     = normalize(mix(c0, c1, ph * 0.5));             // the eye wanders
    float spin  = (hash31(k + 9.4) < 0.5 ? -1.0 : 1.0) * mix(4.0, 8.0, hash31(k + 4.2));
    float size  = 0.55 * sin(3.14159 * ph);                     // grow, then contract into the eye
    float fall  = exp(-(1.0 - dot(d, c)) / max(size * size, 1e-4));
    d = rotAxis(d, c, spin * ph * fall);
  }
  return d;
}

void main() {
  vec3 V = normalize(vViewDir);
  // Face the normal toward the viewer. (gl_FrontFacing can't be used: three.js
  // flips the winding for BackSide materials, so inner faces report "front".)
  vec3 N = normalize(vNormalW);
  if (dot(N, V) < 0.0) N = -N;
  vec3 W = normalize(vWorldDir);

  // ── Burst: a hole opens at uPopDir and the film retracts across the sphere ──
  float popRim = 0.0;
  if (uPop >= 0.0) {
    float a    = acos(clamp(dot(W, uPopDir), -1.0, 1.0));
    float hole = uPop * 3.4;
    if (a < hole) discard;
    popRim = 1.0 - smoothstep(0.0, 0.18, a - hole);
  }

  float cosT = clamp(dot(N, V), 0.0, 1.0);
  float fres = pow(1.0 - cosT, 3.0);

  // ── Film thickness (nm) ──
  // Marangoni swirls: domain-warped noise on the rotating surface.
  float seed = uSeed + vSeedOff;
  vec3 L = vortexFlow(normalize(vLocalDir), seed);
  vec3 p = L * 1.7 + vec3(seed, seed * 0.37, -seed * 0.61);
#ifdef LITE
  vec3 warp = vec3(fbm(p + vec3(0.0, uTime * 0.12, 0.0)));
#else
  vec3 warp = vec3(
    fbm(p + vec3(0.0, uTime * 0.12, 0.0)),
    fbm(p + vec3(5.2, 1.3 - uTime * 0.10, 2.8)),
    fbm(p + vec3(1.7, 9.2, 4.1 + uTime * 0.08)));
#endif
  float swirl = fbm(p * 1.3 + warp * 2.2 + vec3(uTime * 0.05, -uTime * 0.16, 0.0));

  // Marginal regeneration: thin plumes peel off the thick bottom and rise
  float plume = smoothstep(0.55, 0.8, vnoise(vec3(L.x * 4.0, L.y * 3.0 - uTime * 0.45, L.z * 4.0) + seed))
              * smoothstep(0.6, -0.2, W.y) * smoothstep(-1.0, -0.6, W.y);

  // Gravity drainage: thin cap at the top, thick pool at the bottom.
  // As the bubble ages the cap thins toward the black film that precedes bursting.
  float h        = W.y;
  float topT     = mix(420.0, 15.0, uAge);
  float bottomT  = mix(1150.0, 650.0, uAge);
  float strat    = mix(bottomT, topT, smoothstep(-1.0, 0.95, h));
  float thick    = strat * (0.55 + 0.9 * swirl);
  thick += sin(h * 14.0 + swirl * 6.0 - uTime * 0.4) * 35.0;    // horizontal drainage bands
  thick *= 1.0 - 0.5 * plume;
  float black = smoothstep(0.5, 1.0, uAge) * smoothstep(0.25, 0.85, h + (swirl - 0.5) * 0.6);
  thick *= 1.0 - 0.97 * black;
  thick *= 1.0 - 0.45 * vDent;                                    // poking thins the film locally
  thick = max(thick, 0.0);

  float cosR = sqrt(max(1.0 - (1.0 - cosT * cosT) / (1.33 * 1.33), 0.0));
  vec3  film = filmColor(thick, cosR);

  // No specular highlights: center nearly invisible, color lives on the rim.
  vec3 col = film * (0.012 + uGlow + 0.45 * fres)
           + uBaseColor * 0.03 * fres;
  col += vec3(1.0, 0.96, 0.9) * popRim * 1.6;

  // Mostly transmissive: alpha is only what the film reflects.
  float alpha = clamp(dot(col, vec3(0.299, 0.587, 0.114)) * 0.35 + fres * 0.05, 0.0, 1.0);
  // Keep the output valid premultiplied color (rgb ≤ alpha). Transparent windows
  // hand the canvas to the OS compositor, which blows up rgb > alpha.
  col   = min(col, vec3(1.0));
  alpha = max(alpha, max(col.r, max(col.g, col.b)));
  gl_FragColor = vec4(col * uFade, alpha * uFade);
}`;

// ─── Screen-anchored background ──────────────────────────────────────────────
// Sampled in absolute screen pixels, so every window is a portal into the same
// space and overlapping windows line up seamlessly.

const BG_VERT = /* glsl */`
void main() { gl_Position = vec4(position.xy, 0.9999, 1.0); }`;

const BG_FRAG = /* glsl */`
uniform vec2  uOrigin;   // content-area top-left in screen px
uniform vec2  uRes;      // content-area size in CSS px
uniform vec2  uScreen;
uniform float uDpr;
uniform float uClock;    // wall-clock seconds, identical across windows

${NOISE_GLSL}

float hash21(vec2 p) { return hash31(vec3(p, 3.7)); }

void main() {
  vec2 local = vec2(gl_FragCoord.x, uRes.y * uDpr - gl_FragCoord.y) / uDpr;
  vec2 s  = uOrigin + local;
  vec2 uv = s / uScreen.y;

  vec3 col = mix(vec3(0.006, 0.008, 0.020), vec3(0.022, 0.010, 0.030), uv.y);

  float n  = fbm(vec3(uv * 2.2, uClock * 0.015));
  float n2 = fbm(vec3(uv * 4.5 + n * 1.8, uClock * 0.025 + 3.0));
  col += vec3(0.09, 0.04, 0.17) * pow(n2, 3.0) * 0.55;
  col += vec3(0.01, 0.07, 0.10) * pow(n,  4.0) * 0.70;

  // Drifting dust motes
  vec2 g  = (s + vec2(uClock * 4.0, -uClock * 2.5)) / 42.0;
  vec2 id = floor(g);
  float hh = hash21(id);
  if (hh > 0.92) {
    vec2 o = vec2(hash21(id + 1.3), hash21(id + 7.1)) - 0.5;
    float d = length(fract(g) - 0.5 - o * 0.6);
    float tw = 0.5 + 0.5 * sin(uClock * 1.3 + hh * 80.0);
    col += vec3(0.55, 0.65, 1.0) * smoothstep(0.06, 0.0, d) * tw * 0.22;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export function createBackground(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    vertexShader: BG_VERT, fragmentShader: BG_FRAG,
    depthTest: false, depthWrite: false,
    uniforms: {
      uOrigin: { value: new THREE.Vector2() },
      uRes:    { value: new THREE.Vector2(1, 1) },
      uScreen: { value: new THREE.Vector2(1, 1) },
      uDpr:    { value: 1 },
      uClock:  { value: 0 },
      uNoise:  { value: noiseTex },
    },
  }));
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

export function updateBackground(
  mat: THREE.ShaderMaterial, origin: [number, number], res: [number, number], dpr: number,
): void {
  const u = mat.uniforms;
  u.uOrigin.value.set(...origin);
  u.uRes.value.set(...res);
  u.uScreen.value.set(screen.width, screen.height);
  u.uDpr.value = dpr;
  u.uClock.value = (Date.now() / 1000) % 3600;
}

// ─── Pop droplets ─────────────────────────────────────────────────────────────

const DROP_VERT = /* glsl */`
attribute float aSize;
attribute float aAlpha;
attribute vec3  aColor;
uniform float uDpr;
varying float vA;
varying vec3  vC;
void main() {
  gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uDpr;
  vA = aAlpha; vC = aColor;
}`;

const DROP_FRAG = /* glsl */`
varying float vA;
varying vec3  vC;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d) * vA;
  gl_FragColor = vec4(vC * a, a);
}`;

// ─── Bubble mesh: back faces then front faces, sharing one uniform set ────────

const sphereGeo = new THREE.SphereGeometry(1, 96, 64);

function seedFrom(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h * 31) + id.charCodeAt(i)) >>> 0;
  return (h % 1000) / 10;
}

export function createSoapUniforms() {
  return {
    uTime:       { value: 0 },
    uBaseColor:  { value: new THREE.Color(1, 1, 1) },
    uFade:       { value: 1 },
    uAge:        { value: 0 },
    uSeed:       { value: 0 },
    uPop:        { value: -1 },
    uPopDir:     { value: new THREE.Vector3(0, 1, 0) },
    uFilmLUT:    { value: filmLUT },
    uNoise:      { value: noiseTex },
    uSquashAxis: { value: new THREE.Vector3(1, 0, 0) },
    uSquash:     { value: 0 },
    uWobble:     { value: 0 },
    uPokeDir:    { value: new THREE.Vector3(0, 0, 1) },
    uPoke:       { value: 0 },
    uGlow:       { value: 0 },
  };
}

// Back faces first, then front faces, sharing one uniform set.
export function createSoapMaterials(
  uniforms: ReturnType<typeof createSoapUniforms>, lite = false,
): THREE.ShaderMaterial[] {
  return [THREE.BackSide, THREE.FrontSide].map(side => new THREE.ShaderMaterial({
    vertexShader: SOAP_VERT, fragmentShader: SOAP_FRAG,
    uniforms,
    defines: lite ? { LITE: 1 } : {},
    transparent: true, premultipliedAlpha: true,
    blending: THREE.NormalBlending,
    depthWrite: false, side,
  }));
}

export { sphereGeo as soapSphereGeometry };

class BubbleMesh {
  readonly group = new THREE.Group();
  readonly spin  = new THREE.Group();   // rotates the film pattern only
  readonly uniforms = createSoapUniforms();
  private materials: THREE.ShaderMaterial[];

  constructor(renderOrder: number, lite = false) {
    this.materials = createSoapMaterials(this.uniforms, lite);
    this.materials.forEach((mat, i) => {
      const mesh = new THREE.Mesh(sphereGeo, mat);
      mesh.renderOrder = renderOrder + i;
      this.spin.add(mesh);
    });
    this.group.add(this.spin);
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface GhostInput {
  id: string;
  color: [number, number, number];
  worldPos: THREE.Vector3;
  worldRadius: number;
}

interface Droplet {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  delay: number;
  life: number;
  age: number;
}

const POP_DURATION = 0.16;

export class BubbleRenderer {
  readonly scene = new THREE.Scene();

  private orb = new BubbleMesh(GHOST_POOL_SIZE * 2 + 2);
  private ghosts: BubbleMesh[] = [];
  private ghostIds = new Map<string, number>();

  private bgMat: THREE.ShaderMaterial | null = null;

  private dropGeo: THREE.BufferGeometry;
  private dropMat: THREE.ShaderMaterial;
  private drops: Droplet[] = [];

  private time = 0;

  // Jelly squash: damped spring
  private squash = 0;
  private squashVel = 0;
  private wobble = 0;
  private poke = 0;
  private pokeTarget = 0;

  private popT = -1;
  private onPopped?: () => void;
  private popDoneAt = 0;

  private worldRadius = 1;

  // background: false for transparent windows (Electron) where the desktop shows through
  constructor({ background = true }: { background?: boolean } = {}) {
    if (background) {
      const bg = createBackground();
      this.bgMat = bg.material;
      this.scene.add(bg);
    }

    for (let i = 0; i < GHOST_POOL_SIZE; i++) {
      const g = new BubbleMesh(2 + i * 2, true);
      g.group.visible = false;
      this.ghosts.push(g);
      this.scene.add(g.group);
    }
    this.scene.add(this.orb.group);

    this.dropGeo = new THREE.BufferGeometry();
    this.dropGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(DROPLET_COUNT * 3), 3));
    this.dropGeo.setAttribute("aSize",    new THREE.BufferAttribute(new Float32Array(DROPLET_COUNT), 1));
    this.dropGeo.setAttribute("aAlpha",   new THREE.BufferAttribute(new Float32Array(DROPLET_COUNT), 1));
    this.dropGeo.setAttribute("aColor",   new THREE.BufferAttribute(new Float32Array(DROPLET_COUNT * 3), 3));
    this.dropMat = new THREE.ShaderMaterial({
      vertexShader: DROP_VERT, fragmentShader: DROP_FRAG,
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uDpr: { value: 1 } },
    });
    const points = new THREE.Points(this.dropGeo, this.dropMat);
    points.frustumCulled = false;
    points.renderOrder = 50;
    this.scene.add(points);
  }

  init(id: string, color: [number, number, number]): void {
    this.orb.uniforms.uBaseColor.value.setRGB(...color);
    this.orb.uniforms.uSeed.value = seedFrom(id);
  }

  setView(origin: [number, number], res: [number, number], dpr: number): void {
    if (this.bgMat) updateBackground(this.bgMat, origin, res, dpr);
    this.dropMat.uniforms.uDpr.value = dpr;
  }

  // Position (world) and radius (world) of this window's bubble.
  setBubble(pos: THREE.Vector3, worldRadius: number): void {
    this.worldRadius = worldRadius;
    this.orb.group.position.copy(pos);
    this.orb.group.scale.setScalar(Math.max(worldRadius, 1e-4));
  }

  setAge(age: number): void { this.orb.uniforms.uAge.value = age; }
  setFade(f: number): void { this.orb.uniforms.uFade.value = f; }

  // Wall hit / merge: compress along a world-space xy axis.
  impact(ax: number, ay: number, strength: number): void {
    const len = Math.hypot(ax, ay) || 1;
    this.orb.uniforms.uSquashAxis.value.set(ax / len, ay / len, 0);
    this.squashVel += strength;
    this.wobble = Math.min(this.wobble + Math.abs(strength) * 0.004, 0.035);
  }

  jiggle(amount: number): void {
    this.wobble = Math.min(this.wobble + amount, 0.045);
  }

  // Cursor dent; dir is a world-space unit vector from the bubble center.
  setPoke(dir: THREE.Vector3 | null, strength: number): void {
    if (dir) this.orb.uniforms.uPokeDir.value.copy(dir);
    this.pokeTarget = dir ? strength : 0;
  }

  get popping(): boolean { return this.popT >= 0; }

  // Burst starting at a world-space direction; onDone fires after the spray settles.
  pop(dir: THREE.Vector3, onDone?: () => void): void {
    if (this.popT >= 0) return;
    this.popT = 0;
    this.onPopped = onDone;
    this.popDoneAt = POP_DURATION + 0.9;
    this.orb.uniforms.uPopDir.value.copy(dir).normalize();
    this.spawnDroplets(dir.clone().normalize());
  }

  private spawnDroplets(popDir: THREE.Vector3): void {
    const center = this.orb.group.position;
    const R = this.worldRadius;
    this.drops = [];
    const col = this.dropGeo.getAttribute("aColor") as THREE.BufferAttribute;
    const size = this.dropGeo.getAttribute("aSize") as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let i = 0; i < DROPLET_COUNT; i++) {
      // Points on the rim of the retracting hole: uniform on the sphere,
      // released as the hole front passes them.
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const dir = new THREE.Vector3(s * Math.cos(th), s * Math.sin(th), u);
      const ang = Math.acos(THREE.MathUtils.clamp(dir.dot(popDir), -1, 1));
      // Film flies away from the hole: tangential + outward
      const tangent = dir.clone().multiplyScalar(dir.dot(popDir)).sub(popDir);
      if (tangent.lengthSq() < 1e-6) tangent.set(-dir.y, dir.x, 0);
      tangent.normalize();
      const vel = dir.clone().multiplyScalar(R * (0.6 + Math.random() * 1.6))
        .addScaledVector(tangent, R * (0.8 + Math.random() * 1.8));
      this.drops.push({
        pos: center.clone().addScaledVector(dir, R),
        vel,
        delay: (ang / 3.4) * POP_DURATION,
        life: 0.35 + Math.random() * 0.55,
        age: 0,
      });
      c.setHSL(Math.random(), 0.7, 0.75);
      col.setXYZ(i, c.r, c.g, c.b);
      size.setX(i, 1.2 + Math.random() * 2.8);
    }
    col.needsUpdate = true;
    size.needsUpdate = true;
  }

  updateGhosts(inputs: GhostInput[]): void {
    const active = new Set(inputs.map(i => i.id));
    for (const [id, idx] of this.ghostIds) {
      if (!active.has(id)) { this.ghosts[idx].group.visible = false; this.ghostIds.delete(id); }
    }
    for (const g of inputs) {
      if (!this.ghostIds.has(g.id)) {
        const used = new Set(this.ghostIds.values());
        const free = this.ghosts.findIndex((_, i) => !used.has(i));
        if (free === -1) continue;
        this.ghostIds.set(g.id, free);
        this.ghosts[free].uniforms.uSeed.value = seedFrom(g.id);
      }
      const m = this.ghosts[this.ghostIds.get(g.id)!];
      m.uniforms.uBaseColor.value.setRGB(...g.color);
      m.group.position.copy(g.worldPos);
      m.group.scale.setScalar(Math.max(g.worldRadius, 1e-4));
      m.group.visible = g.worldRadius > 1e-3;
    }
  }

  update(dt: number): void {
    this.time += dt;
    const u = this.orb.uniforms;

    // Squash spring (~3 Hz, lightly damped)
    const K = 360, C = 9;
    this.squashVel += (-K * this.squash - C * this.squashVel) * dt;
    this.squash    += this.squashVel * dt;
    this.squash     = THREE.MathUtils.clamp(this.squash, -0.2, 0.2);
    this.wobble    *= Math.exp(-2.2 * dt);
    this.poke      += (this.pokeTarget - this.poke) * Math.min(dt * 10, 1);

    u.uTime.value   = this.time;
    u.uSquash.value = this.squash;
    u.uWobble.value = this.wobble;
    u.uPoke.value   = this.poke;

    // Film pattern drifts very slowly
    this.orb.spin.rotation.y += dt * 0.14;
    this.orb.spin.rotation.x  = Math.sin(this.time * 0.17) * 0.08;

    for (const [, idx] of this.ghostIds) {
      const g = this.ghosts[idx];
      g.uniforms.uTime.value = this.time;
      g.uniforms.uAge.value  = 0.25;
      g.spin.rotation.y += dt * 0.14;
    }

    this.updatePop(dt);
  }

  private updatePop(dt: number): void {
    if (this.popT < 0) return;
    this.popT += dt;
    this.orb.uniforms.uPop.value = Math.min(this.popT / POP_DURATION, 1);
    if (this.popT > POP_DURATION) this.orb.group.visible = false;

    const pos   = this.dropGeo.getAttribute("position") as THREE.BufferAttribute;
    const alpha = this.dropGeo.getAttribute("aAlpha")   as THREE.BufferAttribute;
    const g = this.worldRadius * 2.5;
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      if (this.popT < d.delay) { alpha.setX(i, 0); continue; }
      d.age += dt;
      d.vel.y -= g * dt;
      d.vel.multiplyScalar(Math.exp(-2.5 * dt));
      d.pos.addScaledVector(d.vel, dt);
      pos.setXYZ(i, d.pos.x, d.pos.y, d.pos.z);
      const k = 1 - d.age / d.life;
      alpha.setX(i, k > 0 ? k * k : 0);
    }
    pos.needsUpdate = true;
    alpha.needsUpdate = true;

    if (this.popT >= this.popDoneAt && this.onPopped) {
      const cb = this.onPopped;
      this.onPopped = undefined;
      cb();
    }
  }

  dispose(): void {
    this.orb.dispose();
    for (const g of this.ghosts) g.dispose();
    this.bgMat?.dispose();
    this.dropMat.dispose();
    this.dropGeo.dispose();
  }
}
