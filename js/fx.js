// js/fx.js — bobobike visual effects.
//
// • Particles: two pooled THREE.Points (normal blend + additive). Motion is solved analytically in
//   the vertex shader (initial pos/vel + linear drag + vertical accel + a decaying "carrier"
//   velocity inherited from the player), so the CPU only writes a
//   particle once, at spawn, and uploads just the written range. Sprites are drawn procedurally in
//   the fragment shader: soft puffy discs, hot glow orbs, twinkling 4-ray sparkles and
//   velocity-stretched streaks (screen-space capsules inside the point sprite).
// • Confetti: one InstancedMesh of tumbling quads with flutter drag, fake shading and glints.
// • Rings: one InstancedMesh of quads drawing soft expanding shock rings.
// • Speed lines: one InstancedMesh whose vertex shader places streaks directly in camera space.
// • Trail: one camera-facing additive ribbon behind the player.
// Every pool is preallocated; per-frame paths never allocate.

import * as THREE from 'three';
import { CONFIG } from './config.js';

const TAU = Math.PI * 2;
const G = CONFIG.gravity;

// ---- capacities -------------------------------------------------------------------------------
const CAP_NORMAL = { high: 1100, low: 440 };  // + additive = 3000 high / 1200 low
const CAP_ADD = { high: 1900, low: 760 };
const CONFETTI_MAX = 400;
const RING_MAX = 16;
const LINES_MAX = 60;
const LINES_LOW = 25;
const LINE_NEAR = 1.0;       // m in front of the camera where lines die
const LINE_RANGE = 48;       // m of depth the lines travel through

// ---- trail ------------------------------------------------------------------------------------
const TRAIL_N = 49;          // points -> 48 segments
const TRAIL_LIFE = 0.34;     // s a trail point survives
const TRAIL_MAX_LEN = 7.5;   // m; keeps the ribbon from running under the chase camera
const TRAIL_SPACING = 0.28;  // m between committed points
const TRAIL_BACK = 0.72;     // m behind the contact point (rear wheel)
const TRAIL_UP = 0.34;       // m above the contact point
const TRAIL_INTENSITY = 1.6; // HDR multiplier (feeds bloom)

// particle sprite shapes
const SHAPE_SOFT = 0;    // normal pool: soft puffy disc
const SHAPE_GLOW = 1;    // additive: glowing orb with white-hot core
const SHAPE_SPARKLE = 2; // additive: twinkling 4-ray star
const SHAPE_STREAK = 3;  // additive: velocity-stretched spark

const EMPTY = Object.freeze({});

// ---- module temps (never allocate per frame) ---------------------------------------------------
const _m4 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _vp = new THREE.Vector4();
const _ca = new THREE.Color();
const _cb = new THREE.Color();
const _cc = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const XAXIS = new THREE.Vector3(1, 0, 0);

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Uniformly distributed random unit vector into `out`. */
function randDir(out) {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * TAU;
  const r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(a), z, r * Math.sin(a));
}

// ---- zero-allocation upload ranges -------------------------------------------------------------
// BufferAttribute.addUpdateRange() pushes a fresh object each call. This reuses a few range objects
// per attribute and merges contiguous spans; three.js clears `updateRanges` after each upload.
function dyn(attr) {
  attr.setUsage(THREE.DynamicDrawUsage);
  attr.fxRanges = [];
  for (let i = 0; i < 6; i++) attr.fxRanges.push({ start: 0, count: 0 });
  return attr;
}

function markRange(attr, start, count) {
  if (count <= 0) return;
  const ranges = attr.updateRanges;
  const pool = attr.fxRanges;
  const n = ranges.length;
  if (n > 0) {
    const last = ranges[n - 1];
    if (last.start + last.count === start) { last.count += count; attr.needsUpdate = true; return; }
  }
  if (n < pool.length && (n === 0 || ranges[n - 1] === pool[n - 1])) {
    const r = pool[n];
    r.start = start; r.count = count;
    ranges.push(r);
  } else {
    // Too many pending spans (object not rendered for a while): collapse into one.
    let lo = start, hi = start + count;
    for (let i = 0; i < n; i++) {
      const r = ranges[i];
      if (r.start < lo) lo = r.start;
      if (r.start + r.count > hi) hi = r.start + r.count;
    }
    const r = pool[0];
    r.start = lo; r.count = hi - lo;
    ranges.length = 0;
    ranges.push(r);
  }
  attr.needsUpdate = true;
}

// ---- GLSL ----------------------------------------------------------------------------------------
const FOG_FACTOR = /* glsl */`
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
#else
  float fogFactor = 0.0;
#endif
`;

const PARTICLE_VS = /* glsl */`
uniform float uTime;
uniform vec2 uViewport;
uniform float uMaxPx;
attribute vec3 aVel;     // velocity relative to the carrier
attribute vec4 aCarry;   // carrier velocity (inherited from the player), carrier decay rate
attribute vec4 aParams;  // spawn time, life, drag, vertical accel
attribute vec4 aSize;    // size0, size1 (world m), alpha / HDR intensity, shape
attribute vec4 aColA;    // start colour, seed
attribute vec3 aColB;    // end colour
varying vec4 vColor;
varying vec4 vSeg;       // xy: half streak vector (px), z: sprite size (px), w: radius (px)
varying vec3 vMisc;      // shape, rotation (cos, sin)
#include <fog_pars_vertex>

void main() {
  float age = uTime - aParams.x;
  if (age < 0.0 || age >= aParams.y) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // outside the clip volume
    gl_PointSize = 0.0;
    vColor = vec4(0.0); vSeg = vec4(0.0, 0.0, 1.0, 1.0); vMisc = vec3(0.0, 1.0, 0.0);
    #ifdef USE_FOG
      vFogDepth = 0.0;
    #endif
    return;
  }
  float t = age / aParams.y;
  // Exact solution of dv/dt = g - k v (relative motion) plus a slowly decaying carrier
  // velocity, so bursts ride along with a fast player instead of vanishing behind the camera.
  float k = max(aParams.z, 0.02);
  float e = exp(-k * age);
  float E = (1.0 - e) / k;
  float k2 = max(aCarry.w, 0.01);
  vec3 g = vec3(0.0, aParams.w, 0.0);
  vec3 p = position + aCarry.xyz * ((1.0 - exp(-k2 * age)) / k2) + aVel * E + g * ((age - E) / k);
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  vec4 clip = projectionMatrix * mvPosition;
  gl_Position = clip;

  float shape = aSize.w;
  float seed = aColA.w;
  float eo = 1.0 - (1.0 - t) * (1.0 - t);            // ease-out for size
  float size = mix(aSize.x, aSize.y, eo);
  float a;
  vec2 rot = vec2(1.0, 0.0);
  if (shape < 0.5) {                                  // soft disc
    a = smoothstep(0.0, 0.12, t) * pow(1.0 - t, 1.6);
  } else if (shape < 1.5) {                           // glow
    a = smoothstep(0.0, 0.04, t) * (1.0 - t * t);
  } else if (shape < 2.5) {                           // sparkle: pop + twinkle + spin
    float tw = 0.62 + 0.38 * sin(uTime * 27.0 + seed * 60.0);
    float pop = 1.0 + 0.8 * sin(min(t * 9.0, 1.0) * 3.14159);
    size *= pop * (0.8 + 0.2 * tw);
    a = smoothstep(0.0, 0.03, t) * (1.0 - t * t * t) * tw;
    float ang = seed * 6.2831 + uTime * (seed - 0.5) * 5.0;
    rot = vec2(cos(ang), sin(ang));
  } else {                                            // streak
    a = 1.0 - t * t;
  }

  float px = size * uViewport.y * 0.5 * projectionMatrix[1][1] / max(-mvPosition.z, 0.05);
  a *= clamp(px / 1.5, 0.0, 1.0);                     // sub-pixel sprites fade instead of shimmering
  // fade sprites the chase cam flies into (no screen-filling blobs)
  a *= smoothstep(0.3 * size, 1.1 * size + 0.3, -mvPosition.z);
  px = clamp(px, 1.5, uMaxPx);

  vec2 seg = vec2(0.0);
#ifdef ADDITIVE
  if (shape > 2.5) {
    // Stretch along the last ~45 ms of motion relative to the carrier (≈ relative to the chase cam).
    vec3 vel = aVel * e + g * ((1.0 - e) / k);
    vec4 tailClip = projectionMatrix * (modelViewMatrix * vec4(p - vel * 0.045, 1.0));
    if (tailClip.w > 0.05 && clip.w > 0.05) {
      vec2 hv = 0.5 * uViewport;
      vec2 d = (clip.xy / clip.w - tailClip.xy / tailClip.w) * hv;
      float L = length(d);
      // cap the streak so the whole sprite stays within uMaxPx (<= the GPU's point-size limit)
      float Lmax = min(110.0, uMaxPx - px);
      if (L > Lmax) d *= Lmax / max(L, 1e-3);
      seg = d * 0.5;
      gl_Position.xy -= (seg / hv) * clip.w;          // centre the sprite on the streak
    }
  }
#endif
  float sprite = px + 2.0 * length(seg);
  gl_PointSize = sprite;
  vSeg = vec4(seg, sprite, px * 0.5);
  vMisc = vec3(shape, rot);

  vec3 col = mix(aColA.rgb, aColB.rgb, t);
#ifdef ADDITIVE
  vColor = vec4(col * aSize.z, a);
#else
  vColor = vec4(col, a * aSize.z);
#endif
  #include <fog_vertex>
}
`;

const PARTICLE_FS = /* glsl */`
varying vec4 vColor;
varying vec4 vSeg;
varying vec3 vMisc;
#include <fog_pars_fragment>

void main() {
  vec2 q = (gl_PointCoord - 0.5) * vSeg.z;
  q.y = -q.y;                                          // gl_PointCoord is y-down
  vec2 s = vSeg.xy;
  float h = clamp(dot(q, s) / max(dot(s, s), 1e-4), -1.0, 1.0);
  vec2 dq = (q - s * h) / vSeg.w;                      // distance to the streak segment, in radii
  float r2 = dot(dq, dq);
  if (r2 > 1.0) discard;
  vec3 col = vColor.rgb;
  float a;
#ifdef ADDITIVE
  float shape = vMisc.x;
  float core;
  if (shape < 1.5) {
    core = exp(-r2 * 16.0);
    a = exp(-r2 * 3.5) * (1.0 - r2) + core * 0.6;
  } else if (shape < 2.5) {
    vec2 pr = abs(vec2(dq.x * vMisc.y - dq.y * vMisc.z, dq.x * vMisc.z + dq.y * vMisc.y));
    float rays = exp(-pr.y * 16.0) * (1.0 - pr.x) + exp(-pr.x * 16.0) * (1.0 - pr.y);
    core = exp(-r2 * 30.0);
    a = rays * 0.85 + exp(-r2 * 9.0) * 0.7;
  } else {
    core = exp(-r2 * 10.0) * 0.45;                       // thin: keep the hue, only a hint of white
    a = exp(-r2 * 4.0) * (1.0 - r2) + core * 0.5;
  }
  float peak = max(col.r, max(col.g, col.b));
  col = mix(col, vec3(peak), clamp(core, 0.0, 1.0) * 0.6);    // white-hot centre
#else
  a = 1.0 - r2;
  a *= a;
  col *= 0.9 + 0.16 * dq.y;                            // lit from above: reads as a puffy volume
#endif
  float alpha = clamp(a * vColor.a, 0.0, 1.0);
  ${FOG_FACTOR}
#ifdef ADDITIVE
  alpha *= 1.0 - fogFactor;
#else
  #ifdef USE_FOG
    col = mix(col, fogColor, fogFactor);
  #endif
#endif
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const RING_VS = /* glsl */`
attribute vec4 aRingCol;   // HDR rgb, alpha
attribute float aRingW;    // band width relative to radius
varying vec2 vUv;
varying vec4 vCol;
varying float vW;
#include <fog_pars_vertex>
void main() {
  vUv = uv * 2.0 - 1.0;
  vCol = aRingCol;
  vW = aRingW;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const RING_FS = /* glsl */`
varying vec2 vUv;
varying vec4 vCol;
varying float vW;
#include <fog_pars_fragment>
void main() {
  float d = length(vUv);
  if (d > 1.0) discard;
  float x = (d - (1.0 - vW)) / vW;
  float band = exp(-x * x * 2.5);
  float a = (band + d * d * d * d * 0.22) * (1.0 - smoothstep(0.94, 1.0, d)) * vCol.a;
  vec3 col = mix(vCol.rgb, vec3(max(vCol.r, max(vCol.g, vCol.b))), band * band * 0.5);
  float alpha = clamp(a, 0.0, 1.0);
  ${FOG_FACTOR}
  alpha *= 1.0 - fogFactor;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const LINES_VS = /* glsl */`
uniform float uOffset;
uniform float uDensity;
uniform float uStretch;
uniform float uOpacity;
attribute vec4 aLine;      // seed (0..1), phase (0..1), length, width
varying vec2 vUv;
varying float vA;
float hash(float n) { return fract(sin(n) * 43758.5453123); }
void main() {
  // Lines live directly in camera space: no model matrix, no per-frame CPU work.
  float travel = aLine.y * ${LINE_RANGE.toFixed(1)} + uOffset;
  float cyc = floor(travel / ${LINE_RANGE.toFixed(1)});
  float dist = ${LINE_NEAR.toFixed(1)} + ${LINE_RANGE.toFixed(1)} - (travel - cyc * ${LINE_RANGE.toFixed(1)});
  // New random placement every time a line wraps.
  float th = hash(aLine.x * 91.7 + cyc * 13.37) * 6.28318;
  vec2 R = vec2(cos(th), sin(th));
  float r = mix(1.7, 5.2, hash(aLine.x * 47.3 + cyc * 7.91 + 3.1)) * (1.0 + 0.7 * max(0.0, -R.y));
  vec2 T = vec2(-R.y, R.x);
  float len = aLine.z * uStretch;
  float w = max(aLine.w, dist * 0.0022);              // >= ~1 px: no shimmer when far
  vec3 p = vec3(R * r + T * (position.x * w), -(dist + (position.y + 0.5) * len));
  gl_Position = projectionMatrix * vec4(p, 1.0);
  float fade = smoothstep(${LINE_NEAR.toFixed(1)}, ${(LINE_NEAR + 5).toFixed(1)}, dist)
             * (1.0 - smoothstep(${(LINE_NEAR + LINE_RANGE * 0.6).toFixed(1)}, ${(LINE_NEAR + LINE_RANGE).toFixed(1)}, dist));
  vA = fade * step(aLine.x, uDensity) * uOpacity * (aLine.w / w);
  vUv = uv;
}
`;

const LINES_FS = /* glsl */`
uniform vec3 uColor;
varying vec2 vUv;
varying float vA;
void main() {
  float head = smoothstep(0.0, 0.06, vUv.y);          // uv.y = 0 is the end nearest the camera
  float tail = pow(1.0 - vUv.y, 1.6);
  float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float a = clamp(head * tail * across * vA, 0.0, 1.0);
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const TRAIL_VS = /* glsl */`
attribute vec4 aCol;       // HDR rgb, alpha
attribute vec2 aSide;      // -1/+1 across, metres along from the head
varying vec4 vCol;
varying vec2 vSide;
#include <fog_pars_vertex>
void main() {
  vCol = aCol;
  vSide = aSide;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const TRAIL_FS = /* glsl */`
uniform float uTime;
varying vec4 vCol;
varying vec2 vSide;
#include <fog_pars_fragment>
void main() {
  float x = abs(vSide.x);
  float core = exp(-x * x * 14.0);
  float body = (1.0 - x) * (1.0 - x);
  float pulse = 0.8 + 0.2 * sin(vSide.y * 2.4 - uTime * 16.0);   // energy flowing out the back
  float a = (body * 0.5 + core * 0.8) * pulse * vCol.a;
  vec3 col = mix(vCol.rgb, vec3(max(vCol.r, max(vCol.g, vCol.b))), core * 0.35);
  float alpha = clamp(a, 0.0, 1.0);
  ${FOG_FACTOR}
  alpha *= 1.0 - fogFactor;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function fogUniforms(extra) {
  return Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), extra);
}

// ---- particle pool -------------------------------------------------------------------------------
// Ring buffer: particles are written once at `head`; dead ones are skipped in the vertex shader.
// The draw range covers only slots written since the pool last went fully idle.
class ParticlePool {
  constructor(scene, capacity, additive, shared, renderOrder) {
    this.capacity = capacity;
    this.limit = capacity;
    this.head = 0;
    this.used = 0;
    this.deathT = -Infinity;
    this.spanStart = 0;
    this.spanCount = 0;
    // carrier applied to subsequent spawn() calls (see carry())
    this.cx = 0; this.cy = 0; this.cz = 0; this.ck = 1;

    const g = new THREE.BufferGeometry();
    this.aPos = dyn(new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    this.aVel = dyn(new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    this.aCarry = dyn(new THREE.BufferAttribute(new Float32Array(capacity * 4), 4));
    this.aParams = dyn(new THREE.BufferAttribute(new Float32Array(capacity * 4), 4));
    this.aSize = dyn(new THREE.BufferAttribute(new Float32Array(capacity * 4), 4));
    this.aColA = dyn(new THREE.BufferAttribute(new Float32Array(capacity * 4), 4));
    this.aColB = dyn(new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    g.setAttribute('position', this.aPos);
    g.setAttribute('aVel', this.aVel);
    g.setAttribute('aCarry', this.aCarry);
    g.setAttribute('aParams', this.aParams);
    g.setAttribute('aSize', this.aSize);
    g.setAttribute('aColA', this.aColA);
    g.setAttribute('aColB', this.aColB);
    g.setDrawRange(0, 0);
    this.geometry = g;
    this.attrs = [this.aPos, this.aVel, this.aCarry, this.aParams, this.aSize, this.aColA, this.aColB];

    this.material = new THREE.ShaderMaterial({
      uniforms: fogUniforms({ uTime: shared.uTime, uViewport: shared.uViewport, uMaxPx: shared.uMaxPx }),
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      defines: additive ? { ADDITIVE: '' } : {},
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
    const pts = new THREE.Points(g, this.material);
    pts.frustumCulled = false;
    pts.visible = false;
    pts.renderOrder = renderOrder;
    pts.onBeforeRender = shared.onBeforeRender;
    this.points = pts;
    scene.add(pts);
  }

  /** Carrier velocity (+ its decay rate, 1/s) for the following spawn() calls. */
  carry(vel, follow, decay) {
    if (vel && follow > 0) {
      // vertical part damped: a landing's downward speed must not drive dust into the floor
      this.cx = vel.x * follow; this.cy = vel.y * follow * 0.4; this.cz = vel.z * follow;
    } else {
      this.cx = 0; this.cy = 0; this.cz = 0;
    }
    this.ck = decay;
  }

  /** vx..vz are relative to the current carrier. */
  spawn(t, x, y, z, vx, vy, vz, life, drag, grav, s0, s1, alpha, shape, ca, cb) {
    const i = this.head;
    if (this.spanCount > 0 && i !== this.spanStart + this.spanCount) this.flushSpan();
    if (this.spanCount === 0) this.spanStart = i;
    this.spanCount++;

    const i3 = i * 3, i4 = i * 4;
    const P = this.aPos.array, V = this.aVel.array, C = this.aCarry.array, R = this.aParams.array;
    const S = this.aSize.array, A = this.aColA.array, B = this.aColB.array;
    P[i3] = x; P[i3 + 1] = y; P[i3 + 2] = z;
    V[i3] = vx; V[i3 + 1] = vy; V[i3 + 2] = vz;
    C[i4] = this.cx; C[i4 + 1] = this.cy; C[i4 + 2] = this.cz; C[i4 + 3] = this.ck;
    R[i4] = t; R[i4 + 1] = life; R[i4 + 2] = drag; R[i4 + 3] = grav;
    S[i4] = s0; S[i4 + 1] = s1; S[i4 + 2] = alpha; S[i4 + 3] = shape;
    A[i4] = ca.r; A[i4 + 1] = ca.g; A[i4 + 2] = ca.b; A[i4 + 3] = Math.random();
    B[i3] = cb.r; B[i3 + 1] = cb.g; B[i3 + 2] = cb.b;

    this.head = i + 1 >= this.limit ? 0 : i + 1;
    if (i + 1 > this.used) this.used = i + 1;
    if (t + life > this.deathT) this.deathT = t + life;
  }

  flushSpan() {
    const c = this.spanCount;
    if (c === 0) return;
    const s = this.spanStart;
    const at = this.attrs;
    for (let k = 0; k < at.length; k++) {
      const sz = at[k].itemSize;
      markRange(at[k], s * sz, c * sz);
    }
    this.spanCount = 0;
  }

  /** Call after a batch of spawn() calls. */
  commit() {
    this.flushSpan();
    this.geometry.setDrawRange(0, this.used);
    this.points.visible = this.used > 0;
  }

  update(t) {
    if (this.used > 0 && t >= this.deathT) this.reset();
  }

  reset() {
    this.head = 0;
    this.used = 0;
    this.deathT = -Infinity;
    this.spanCount = 0;
    this.geometry.setDrawRange(0, 0);
    this.points.visible = false;
  }

  setLimit(n) {
    this.limit = Math.min(n, this.capacity);
    if (this.head >= this.limit) this.head = 0;
    if (this.used > this.limit) {
      this.used = this.limit;
      this.geometry.setDrawRange(0, this.used);
    }
  }

  dispose() {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---- factory -------------------------------------------------------------------------------------
export function createFX({ scene, camera, quality = 'high' } = {}) {
  let q = quality === 'low' ? 'low' : 'high';
  let qScale = 1;
  let time = 0;
  const lastVel = new THREE.Vector3();   // player velocity from the last update (bursts inherit some)

  // Palette (linear working space; ColorManagement converts the sRGB hex values).
  const PAL = {
    white: new THREE.Color('#ffffff'),
    dust: new THREE.Color('#ece5d8'),
    spark: new THREE.Color('#ffc44a'),
    gold: new THREE.Color('#ffd84a'),
    goldDeep: new THREE.Color('#ff8f1a'),
    boostA: new THREE.Color('#ffb04a'),
    boostB: new THREE.Color('#ff2e88'),
    cyanA: new THREE.Color('#5ff4ff'),
    cyanB: new THREE.Color('#1a7dff'),
    lineN: new THREE.Color('#d6f4ff'),
    lineB: new THREE.Color('#ffbf86'),
  };
  const CONFETTI_COLORS = ['#ff4d6d', '#ffd23f', '#3a86ff', '#06d6a0', '#8338ec', '#ff8fab', '#00f5d4', '#fb5607']
    .map((h) => new THREE.Color(h));
  const STAR_COLORS = ['#ffe066', '#7afcff', '#ff7ad9', '#ffffff', '#b8ff6a', '#ffb347']
    .map((h) => new THREE.Color(h));

  // Colours passed in opts are parsed once and cached.
  const colorCache = new Map();
  function getColor(input, fallback) {
    if (input === undefined || input === null) return fallback;
    if (input.isColor) return input;
    let c = colorCache.get(input);
    if (!c) { c = new THREE.Color(input); colorCache.set(input, c); }
    return c;
  }

  // ---- shared uniforms ----
  const shared = {
    uTime: { value: 0 },
    uViewport: { value: new THREE.Vector2(1280, 720) },
    uMaxPx: { value: 420 },
    onBeforeRender: null,
  };
  // GPUs clamp gl_PointSize silently (Safari/Metal ~511, some mobiles 256 or less); a clamped
  // sprite would crop the shape drawn in the fragment shader, so uMaxPx never exceeds the limit.
  let gpuMaxPx = 0;
  function applyMaxPx() {
    const want = q === 'low' ? 240 : 420;
    shared.uMaxPx.value = gpuMaxPx > 0 ? Math.min(want, gpuMaxPx) : want;
  }
  // Point sizes are in world metres; the shader needs the current target's pixel height.
  shared.onBeforeRender = (renderer) => {
    if (gpuMaxPx === 0) {
      gpuMaxPx = 256;
      try {
        const gl = renderer.getContext();
        const r = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
        if (r && r[1] > 1) gpuMaxPx = r[1];
      } catch (e) { /* keep the conservative default */ }
      applyMaxPx();
    }
    renderer.getCurrentViewport(_vp);
    if (_vp.w > 0) shared.uViewport.value.set(_vp.z, _vp.w);
  };

  const normal = new ParticlePool(scene, CAP_NORMAL.high, false, shared, 10);
  const add = new ParticlePool(scene, CAP_ADD.high, true, shared, 14);

  // ==== confetti ==================================================================================
  const cfGeo = new THREE.PlaneGeometry(0.14, 0.22);
  const cfMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const cfMesh = new THREE.InstancedMesh(cfGeo, cfMat, CONFETTI_MAX);
  dyn(cfMesh.instanceMatrix);
  cfMesh.instanceColor = dyn(new THREE.InstancedBufferAttribute(new Float32Array(CONFETTI_MAX * 3), 3));
  cfMesh.count = 0;
  cfMesh.visible = false;
  cfMesh.frustumCulled = false;
  cfMesh.renderOrder = 11;
  scene.add(cfMesh);
  const cf = {
    n: 0,
    p: new Float32Array(CONFETTI_MAX * 3),
    v: new Float32Array(CONFETTI_MAX * 3),    // velocity relative to the carrier (air drag acts on it)
    w: new Float32Array(CONFETTI_MAX * 3),    // carrier velocity inherited from the player, decays slowly
    ax: new Float32Array(CONFETTI_MAX * 3),   // tumble axis
    ang: new Float32Array(CONFETTI_MAX),
    angV: new Float32Array(CONFETTI_MAX),
    age: new Float32Array(CONFETTI_MAX),
    life: new Float32Array(CONFETTI_MAX),
    sc: new Float32Array(CONFETTI_MAX * 2),
    col: new Float32Array(CONFETTI_MAX * 3),
    fl: new Float32Array(CONFETTI_MAX * 2),   // flutter phase, frequency
  };
  const LIGHT = new THREE.Vector3(0.35, 0.85, 0.4).normalize();
  const HALF = new THREE.Vector3();

  function copyN(arr, n, i, j) {
    const a = i * n, b = j * n;
    for (let k = 0; k < n; k++) arr[a + k] = arr[b + k];
  }

  function spawnConfetti(x, y, z, vx, vy, vz, wx, wy, wz, c) {
    // Pool full (e.g. record + checkpoint bursts overlapping): recycle a random live piece so the
    // newest burst still reads in full.
    const i = cf.n < CONFETTI_MAX ? cf.n++ : (Math.random() * CONFETTI_MAX) | 0;
    const i2 = i * 2, i3 = i * 3;
    cf.p[i3] = x; cf.p[i3 + 1] = y; cf.p[i3 + 2] = z;
    cf.v[i3] = vx; cf.v[i3 + 1] = vy; cf.v[i3 + 2] = vz;
    cf.w[i3] = wx; cf.w[i3 + 1] = wy; cf.w[i3 + 2] = wz;
    randDir(_d);
    cf.ax[i3] = _d.x; cf.ax[i3 + 1] = _d.y; cf.ax[i3 + 2] = _d.z;
    cf.ang[i] = Math.random() * TAU;
    cf.angV[i] = rand(6, 16) * (Math.random() < 0.5 ? -1 : 1);
    cf.age[i] = 0;
    cf.life[i] = rand(2.6, 4.0);
    cf.sc[i2] = rand(0.8, 1.3); cf.sc[i2 + 1] = rand(0.75, 1.25);
    cf.col[i3] = c.r; cf.col[i3 + 1] = c.g; cf.col[i3 + 2] = c.b;
    cf.fl[i2] = Math.random() * TAU; cf.fl[i2 + 1] = rand(4, 9);
  }

  function removeConfetti(i) {
    const j = --cf.n;
    if (i === j) return;
    copyN(cf.p, 3, i, j); copyN(cf.v, 3, i, j); copyN(cf.w, 3, i, j); copyN(cf.ax, 3, i, j);
    cf.ang[i] = cf.ang[j]; cf.angV[i] = cf.angV[j]; cf.age[i] = cf.age[j]; cf.life[i] = cf.life[j];
    copyN(cf.sc, 2, i, j); copyN(cf.col, 3, i, j); copyN(cf.fl, 2, i, j);
  }

  function updateConfetti(dt, cam) {
    if (cf.n === 0) {
      if (cfMesh.visible) { cfMesh.visible = false; cfMesh.count = 0; }
      return;
    }
    // Half vector for glints (light + direction to the camera).
    if (cam) {
      cam.getWorldDirection(_camDir);                  // also refreshes cam.matrixWorld
      _camPos.setFromMatrixPosition(cam.matrixWorld);
    } else {
      _camDir.set(0, 0, -1);
      _camPos.set(0, 1e6, 0);
    }
    const ccx = _camPos.x, ccy = _camPos.y, ccz = _camPos.z;
    HALF.copy(LIGHT).sub(_camDir).normalize();
    const mArr = cfMesh.instanceMatrix.array;
    const cArr = cfMesh.instanceColor.array;
    const g = G * 0.36;
    const wDecay = Math.exp(-0.35 * dt);
    let i = 0;
    while (i < cf.n) {
      const age = (cf.age[i] += dt);
      const life = cf.life[i];
      if (age >= life) { removeConfetti(i); continue; }
      const i2 = i * 2, i3 = i * 3;
      // tumble
      const ang = (cf.ang[i] += cf.angV[i] * dt);
      const sh = Math.sin(ang * 0.5);
      _q.set(cf.ax[i3] * sh, cf.ax[i3 + 1] * sh, cf.ax[i3 + 2] * sh, Math.cos(ang * 0.5));
      // face normal = q * (0,0,1)
      const nx = 2 * (_q.x * _q.z + _q.w * _q.y);
      const ny = 2 * (_q.y * _q.z - _q.w * _q.x);
      const nz = 1 - 2 * (_q.x * _q.x + _q.y * _q.y);
      // flat-facing pieces catch more air -> flutter
      let vx = cf.v[i3], vy = cf.v[i3 + 1], vz = cf.v[i3 + 2];
      const ph = cf.fl[i2] + age * cf.fl[i2 + 1];
      vx += Math.sin(ph) * 5.0 * dt;
      vz += Math.cos(ph * 0.83) * 5.0 * dt;
      vy -= g * dt;
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const damp = 1 / (1 + (0.9 + 3.0 * ny * ny + 0.06 * sp) * dt);
      vx *= damp; vy *= damp; vz *= damp;
      cf.v[i3] = vx; cf.v[i3 + 1] = vy; cf.v[i3 + 2] = vz;
      const wx = (cf.w[i3] *= wDecay), wy = (cf.w[i3 + 1] *= wDecay), wz = (cf.w[i3 + 2] *= wDecay);
      const px = (cf.p[i3] += (vx + wx) * dt);
      const py = (cf.p[i3 + 1] += (vy + wy) * dt);
      const pz = (cf.p[i3 + 2] += (vz + wz) * dt);
      // pop in, shrink out
      const sIn = age < 0.08 ? age / 0.08 : 1;
      const sOut = life - age < 0.5 ? (life - age) / 0.5 : 1;
      let s = sIn * sOut;
      // shrink pieces the chase cam flies through, so none fills the screen
      const ex = px - ccx, ey = py - ccy, ez = pz - ccz;
      const ed2 = ex * ex + ey * ey + ez * ez;
      if (ed2 < 6.25) s *= smoothstep(0.5, 2.5, Math.sqrt(ed2));
      _m4.compose(_p.set(px, py, pz), _q, _s.set(cf.sc[i2] * s, cf.sc[i2 + 1] * s, 1));
      _m4.toArray(mArr, i * 16);
      // fake shading + specular glint (HDR -> blooms)
      const lam = Math.abs(nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z);
      const spec = Math.abs(nx * HALF.x + ny * HALF.y + nz * HALF.z);
      const shade = 0.5 + 0.5 * lam;
      const glint = Math.pow(spec, 28) * 2.2;
      cArr[i3] = cf.col[i3] * shade + glint;
      cArr[i3 + 1] = cf.col[i3 + 1] * shade + glint;
      cArr[i3 + 2] = cf.col[i3 + 2] * shade + glint;
      i++;
    }
    cfMesh.count = cf.n;
    cfMesh.visible = cf.n > 0;
    if (cf.n > 0) {
      markRange(cfMesh.instanceMatrix, 0, cf.n * 16);
      markRange(cfMesh.instanceColor, 0, cf.n * 3);
    }
  }

  // ==== rings =====================================================================================
  const ringGeo = new THREE.PlaneGeometry(2, 2);
  ringGeo.rotateX(-Math.PI / 2);   // lies flat in XZ, normal +Y
  const ringColAttr = dyn(new THREE.InstancedBufferAttribute(new Float32Array(RING_MAX * 4), 4));
  const ringWAttr = dyn(new THREE.InstancedBufferAttribute(new Float32Array(RING_MAX), 1));
  ringGeo.setAttribute('aRingCol', ringColAttr);
  ringGeo.setAttribute('aRingW', ringWAttr);
  const ringMat = new THREE.ShaderMaterial({
    uniforms: fogUniforms({}),
    vertexShader: RING_VS,
    fragmentShader: RING_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    forceSinglePass: true,   // transparent+DoubleSide would otherwise render twice and flag needsUpdate every frame
    fog: true,
  });
  const ringMesh = new THREE.InstancedMesh(ringGeo, ringMat, RING_MAX);
  dyn(ringMesh.instanceMatrix);
  ringMesh.count = 0;
  ringMesh.visible = false;
  ringMesh.frustumCulled = false;
  ringMesh.renderOrder = 13;
  scene.add(ringMesh);
  const rg = {
    n: 0,
    p: new Float32Array(RING_MAX * 3),
    w: new Float32Array(RING_MAX * 3),       // carrier velocity (follows the player a little)
    q: new Float32Array(RING_MAX * 4),
    age: new Float32Array(RING_MAX),
    life: new Float32Array(RING_MAX),
    rad: new Float32Array(RING_MAX),
    col: new Float32Array(RING_MAX * 4),     // HDR rgb, start alpha
  };

  function spawnRing(x, y, z, c, radius, life, intensity, normalVec, follow) {
    let i;
    if (rg.n < RING_MAX) i = rg.n++;
    else { // recycle the oldest
      i = 0;
      for (let k = 1; k < RING_MAX; k++) if (rg.age[k] / rg.life[k] > rg.age[i] / rg.life[i]) i = k;
    }
    if (normalVec) {
      _n.copy(normalVec);
      if (_n.lengthSq() < 1e-6) _n.copy(UP); else _n.normalize();
      _q.setFromUnitVectors(UP, _n);
    } else {
      _n.copy(UP);
      _q.identity();
    }
    const i3 = i * 3, i4 = i * 4;
    rg.p[i3] = x + _n.x * 0.06; rg.p[i3 + 1] = y + _n.y * 0.06; rg.p[i3 + 2] = z + _n.z * 0.06;
    const f = follow || 0;
    rg.w[i3] = lastVel.x * f; rg.w[i3 + 1] = lastVel.y * f * 0.4; rg.w[i3 + 2] = lastVel.z * f;
    rg.q[i4] = _q.x; rg.q[i4 + 1] = _q.y; rg.q[i4 + 2] = _q.z; rg.q[i4 + 3] = _q.w;
    rg.age[i] = 0;
    rg.life[i] = life;
    rg.rad[i] = radius;
    rg.col[i4] = c.r * intensity; rg.col[i4 + 1] = c.g * intensity; rg.col[i4 + 2] = c.b * intensity;
    rg.col[i4 + 3] = 1;
    ringMesh.visible = true;
  }

  function updateRings(dt) {
    if (rg.n === 0) {
      if (ringMesh.visible) { ringMesh.visible = false; ringMesh.count = 0; }
      return;
    }
    const mArr = ringMesh.instanceMatrix.array;
    const cArr = ringColAttr.array;
    const wArr = ringWAttr.array;
    const wDecay = Math.exp(-0.3 * dt);
    let i = 0;
    while (i < rg.n) {
      const age = (rg.age[i] += dt);
      if (age >= rg.life[i]) {
        const j = --rg.n;
        if (i !== j) {
          copyN(rg.p, 3, i, j); copyN(rg.w, 3, i, j); copyN(rg.q, 4, i, j); copyN(rg.col, 4, i, j);
          rg.age[i] = rg.age[j]; rg.life[i] = rg.life[j]; rg.rad[i] = rg.rad[j];
        }
        continue;
      }
      const t = age / rg.life[i];
      const e = 1 - (1 - t) * (1 - t) * (1 - t);           // ease-out cubic
      const r = rg.rad[i] * (0.12 + 0.88 * e);
      const i3 = i * 3, i4 = i * 4;
      rg.p[i3] += (rg.w[i3] *= wDecay) * dt;
      rg.p[i3 + 1] += (rg.w[i3 + 1] *= wDecay) * dt;
      rg.p[i3 + 2] += (rg.w[i3 + 2] *= wDecay) * dt;
      _q.set(rg.q[i4], rg.q[i4 + 1], rg.q[i4 + 2], rg.q[i4 + 3]);
      _m4.compose(_p.set(rg.p[i3], rg.p[i3 + 1], rg.p[i3 + 2]), _q, _s.set(r, 1, r));
      _m4.toArray(mArr, i * 16);
      const fade = Math.pow(1 - t, 1.6) * (t < 0.06 ? t / 0.06 : 1);
      cArr[i4] = rg.col[i4]; cArr[i4 + 1] = rg.col[i4 + 1]; cArr[i4 + 2] = rg.col[i4 + 2];
      cArr[i4 + 3] = rg.col[i4 + 3] * fade;
      wArr[i] = 0.3 + (0.07 - 0.3) * e;
      i++;
    }
    ringMesh.count = rg.n;
    ringMesh.visible = rg.n > 0;
    if (rg.n > 0) {
      markRange(ringMesh.instanceMatrix, 0, rg.n * 16);
      markRange(ringColAttr, 0, rg.n * 4);
      markRange(ringWAttr, 0, rg.n);
    }
  }

  // ==== speed lines ===============================================================================
  const lineGeo = new THREE.PlaneGeometry(1, 1);   // x: across, y: along the line
  const lineData = new Float32Array(LINES_MAX * 4);
  for (let i = 0; i < LINES_MAX; i++) {
    // Golden-ratio seeds: any prefix (low quality count) and any density threshold stay well spread.
    lineData[i * 4] = (i * 0.6180339887 + 0.13) % 1;
    lineData[i * 4 + 1] = Math.random();
    lineData[i * 4 + 2] = rand(2.4, 7.0);
    lineData[i * 4 + 3] = rand(0.016, 0.032);
  }
  lineGeo.setAttribute('aLine', new THREE.InstancedBufferAttribute(lineData, 4));
  const lineU = {
    uOffset: { value: 0 },
    uDensity: { value: 0.5 },
    uStretch: { value: 1 },
    uOpacity: { value: 0 },
    uColor: { value: new THREE.Color(1, 1, 1) },
  };
  const lineMat = new THREE.ShaderMaterial({
    uniforms: lineU,
    vertexShader: LINES_VS,
    fragmentShader: LINES_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  const lineMesh = new THREE.InstancedMesh(lineGeo, lineMat, LINES_MAX);
  lineMesh.frustumCulled = false;
  lineMesh.visible = false;
  lineMesh.renderOrder = 15;
  scene.add(lineMesh);
  let lineOpacity = 0;
  let lineBoost = 0;

  function updateSpeedLines(dt, ctx) {
    const v = ctx.playerVel;
    const speed = v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : 0;
    const s01 = ctx.speed01 || 0;
    const k = Math.min(1, dt * 6);
    lineBoost += ((ctx.boosting ? 1 : 0) - lineBoost) * Math.min(1, dt * 5);
    const target = Math.min(1, Math.max(0, s01 - 0.45) * 2) * (0.7 + 0.65 * lineBoost);
    lineOpacity += (target - lineOpacity) * k;
    lineMesh.visible = lineOpacity > 0.004;
    if (!lineMesh.visible) return;
    lineU.uOpacity.value = lineOpacity;
    // Wrap on a multiple of the range so mod() is continuous and float precision stays good.
    lineU.uOffset.value = (lineU.uOffset.value + dt * (speed * 1.25 + 6)) % (LINE_RANGE * 4096);
    lineU.uStretch.value = 0.65 + 0.9 * Math.min(s01, 1.3) + 0.7 * lineBoost;
    lineU.uDensity.value = Math.min(1, 0.35 + 0.4 * s01 + 0.35 * lineBoost);
    lineU.uColor.value.copy(PAL.lineN).lerp(PAL.lineB, lineBoost).multiplyScalar(1.1 + 0.7 * lineBoost);
  }

  // ==== trail =====================================================================================
  const trailGeo = new THREE.BufferGeometry();
  const trPosAttr = dyn(new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2 * 3), 3));
  const trColAttr = dyn(new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2 * 4), 4));
  const trSideAttr = dyn(new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2 * 2), 2));
  for (let i = 0; i < TRAIL_N; i++) { trSideAttr.array[i * 4] = -1; trSideAttr.array[i * 4 + 2] = 1; }
  const trIdx = new Uint16Array((TRAIL_N - 1) * 6);
  for (let j = 0; j < TRAIL_N - 1; j++) {
    const a = j * 2, o = j * 6;
    trIdx[o] = a; trIdx[o + 1] = a + 1; trIdx[o + 2] = a + 2;
    trIdx[o + 3] = a + 1; trIdx[o + 4] = a + 3; trIdx[o + 5] = a + 2;
  }
  trailGeo.setIndex(new THREE.BufferAttribute(trIdx, 1));
  trailGeo.setAttribute('position', trPosAttr);
  trailGeo.setAttribute('aCol', trColAttr);
  trailGeo.setAttribute('aSide', trSideAttr);
  trailGeo.setDrawRange(0, 0);
  const trailMat = new THREE.ShaderMaterial({
    uniforms: fogUniforms({ uTime: shared.uTime }),
    vertexShader: TRAIL_VS,
    fragmentShader: TRAIL_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    fog: true,
  });
  const trailMesh = new THREE.Mesh(trailGeo, trailMat);
  trailMesh.frustumCulled = false;
  trailMesh.visible = false;
  trailMesh.renderOrder = 12;
  scene.add(trailMesh);
  const tr = {
    n: 0,                                   // valid points; index 0 is the live head
    p: new Float32Array(TRAIL_N * 3),
    t: new Float32Array(TRAIL_N),
    vis: new Float32Array(TRAIL_N),
    b: new Float32Array(TRAIL_N),           // boost amount when the point was laid
    fwd: new THREE.Vector3(0, 0, -1),
    boost01: 0,
  };

  function trailCommit(x, y, z, vis, b) {
    const m = Math.min(tr.n, TRAIL_N - 1);   // committed points 1..m-1 shift to 2..m
    if (m > 1) {
      tr.p.copyWithin(6, 3, m * 3);
      tr.t.copyWithin(2, 1, m);
      tr.vis.copyWithin(2, 1, m);
      tr.b.copyWithin(2, 1, m);
    }
    tr.p[3] = x; tr.p[4] = y; tr.p[5] = z;
    tr.t[1] = time; tr.vis[1] = vis; tr.b[1] = b;
    tr.n = m + 1;
  }

  function updateTrail(dt, ctx, cam) {
    const pp = ctx.playerPos;
    if (!pp) return;
    const v = ctx.playerVel;
    if (v) {
      const hl = Math.sqrt(v.x * v.x + v.z * v.z);
      if (hl > 0.5) tr.fwd.set(v.x / hl, 0, v.z / hl);
    }
    const ax = pp.x - tr.fwd.x * TRAIL_BACK;
    const ay = pp.y + TRAIL_UP;
    const az = pp.z - tr.fwd.z * TRAIL_BACK;
    const visNow = smoothstep(0.58, 0.72, ctx.speed01 || 0);
    tr.boost01 += ((ctx.boosting ? 1 : 0) - tr.boost01) * Math.min(1, dt * 8);
    const P = tr.p, T = tr.t, VIS = tr.vis, B = tr.b;

    // live head
    if (tr.n === 0) tr.n = 1;
    P[0] = ax; P[1] = ay; P[2] = az;
    T[0] = time; VIS[0] = visNow; B[0] = tr.boost01;
    if (tr.n === 1) {
      trailCommit(ax, ay, az, visNow, tr.boost01);
    } else {
      const dx = ax - P[3], dy = ay - P[4], dz = az - P[5];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 144) { tr.n = 1; trailCommit(ax, ay, az, visNow, tr.boost01); }  // teleport / respawn
      else if (d2 >= TRAIL_SPACING * TRAIL_SPACING) trailCommit(ax, ay, az, visNow, tr.boost01);
    }
    while (tr.n > 1 && time - T[tr.n - 1] > TRAIL_LIFE) tr.n--;
    // length cap
    let len = 0;
    for (let i = 1; i < tr.n; i++) {
      const i3 = i * 3;
      const dx = P[i3] - P[i3 - 3], dy = P[i3 + 1] - P[i3 - 2], dz = P[i3 + 2] - P[i3 - 1];
      len += Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len > TRAIL_MAX_LEN) { tr.n = i + 1; break; }
    }

    const n = tr.n;
    if (n < 2) { trailMesh.visible = false; return; }
    let anyVis = false;
    for (let i = 0; i < n; i++) if (VIS[i] > 0.001) { anyVis = true; break; }
    if (!anyVis) { trailMesh.visible = false; return; }

    if (cam.parent) _camPos.setFromMatrixPosition(cam.matrixWorld); else _camPos.copy(cam.position);
    const pos = trPosAttr.array, col = trColAttr.array, side = trSideAttr.array;
    const inv = 1 / (n - 1);
    let along = 0;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const px = P[i3], py = P[i3 + 1], pz = P[i3 + 2];
      const a3 = (i > 0 ? i - 1 : 0) * 3, b3 = (i < n - 1 ? i + 1 : n - 1) * 3;
      let tx = P[a3] - P[b3], ty = P[a3 + 1] - P[b3 + 1], tz = P[a3 + 2] - P[b3 + 2];
      if (tx * tx + ty * ty + tz * tz < 1e-8) { tx = tr.fwd.x; ty = 0; tz = tr.fwd.z; }
      const cx = _camPos.x - px, cy = _camPos.y - py, cz = _camPos.z - pz;
      // camera-facing side vector = tangent x toCamera
      let sx = ty * cz - tz * cy, sy = tz * cx - tx * cz, sz = tx * cy - ty * cx;
      let sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (sl < 1e-6) { sx = 1; sy = 0; sz = 0; sl = 1; }
      const u = i * inv;
      const b = B[i];
      const halfW = (0.2 + 0.12 * b) * Math.pow(1 - u, 0.85);
      const ks = halfW / sl;
      sx *= ks; sy *= ks; sz *= ks;
      const o = i * 6;
      pos[o] = px - sx; pos[o + 1] = py - sy; pos[o + 2] = pz - sz;
      pos[o + 3] = px + sx; pos[o + 4] = py + sy; pos[o + 5] = pz + sz;
      // colour: cyan -> deep blue normally, orange -> pink while boosting
      const life = clamp(1 - (time - T[i]) / TRAIL_LIFE, 0, 1);
      const alpha = VIS[i] * Math.pow(life, 1.3) * (1 - u * u);
      _ca.copy(PAL.cyanA).lerp(PAL.cyanB, u);
      _cb.copy(PAL.boostA).lerp(PAL.boostB, u);
      _ca.lerp(_cb, b).multiplyScalar(TRAIL_INTENSITY);
      const c = i * 8;
      col[c] = col[c + 4] = _ca.r;
      col[c + 1] = col[c + 5] = _ca.g;
      col[c + 2] = col[c + 6] = _ca.b;
      col[c + 3] = col[c + 7] = alpha;
      if (i > 0) {
        const dx = px - P[i3 - 3], dy = py - P[i3 - 2], dz = pz - P[i3 - 1];
        along += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      side[i * 4 + 1] = side[i * 4 + 3] = along;
    }
    markRange(trPosAttr, 0, n * 6);
    markRange(trColAttr, 0, n * 8);
    markRange(trSideAttr, 0, n * 4);
    trailGeo.setDrawRange(0, (n - 1) * 6);
    trailMesh.visible = true;
  }

  // ==== boost embers (automatic while boosting) ====================================================
  let emberAcc = 0;
  function updateEmbers(dt, ctx) {
    if (!ctx.boosting || !ctx.playerPos) { emberAcc = 0; return; }
    emberAcc += dt * (q === 'low' ? 30 : 64);
    if (emberAcc < 1) return;
    const pp = ctx.playerPos;
    const bx = pp.x - tr.fwd.x * TRAIL_BACK, by = pp.y + TRAIL_UP, bz = pp.z - tr.fwd.z * TRAIL_BACK;
    add.carry(lastVel, 0.7, 1.4);
    while (emberAcc >= 1) {
      emberAcc -= 1;
      _ca.copy(PAL.boostA).lerp(PAL.white, rand(0.1, 0.5));
      _cb.copy(PAL.boostB);
      add.spawn(time, bx + rand(-0.2, 0.2), by + rand(-0.15, 0.25), bz + rand(-0.2, 0.2),
        rand(-1.5, 1.5) - tr.fwd.x * 2, rand(0.3, 1.8), rand(-1.5, 1.5) - tr.fwd.z * 2,
        rand(0.3, 0.55), 2.5, 2.0, rand(0.1, 0.2), 0.0, 2.6, SHAPE_GLOW, _ca, _cb);
    }
    add.commit();
  }

  // ==== bursts ====================================================================================
  // Each burst rides a carrier = playerVel * follow (opts.follow overrides), decaying at the given
  // rate, so effects spawned on a 30 m/s rider stay on screen instead of vanishing behind the camera.
  const followOf = (o, def) => (typeof o.follow === 'number' ? o.follow : def);

  // Normal-blend sprites are unlit: when no colour is given, pull the default toward the current
  // fog colour so dust/cloud puffs sit in the zone's mood (no glowing beige dust at night).
  const _tint = new THREE.Color();
  function ambientTint(base, k) {
    _tint.copy(base);
    const f = scene && scene.fog;
    if (f && f.color) _tint.lerp(f.color, k);
    return _tint;
  }

  function burstDust(p, o) {
    const I = clamp(o.intensity ?? 0.5, 0, 1.5);
    const base = o.color != null ? getColor(o.color, PAL.dust) : ambientTint(PAL.dust, 0.35);
    const n = Math.max(2, Math.round((8 + 26 * I) * qScale));
    normal.carry(lastVel, followOf(o, 0.3), 1.5);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, ca = Math.cos(a), sa = Math.sin(a);
      const r0 = Math.random() * 0.4;
      const hs = (1.4 + 5 * I) * rand(0.35, 1);
      _ca.copy(base).multiplyScalar(rand(0.8, 1.05));
      _cb.copy(_ca).lerp(PAL.white, 0.3);
      const s0 = rand(0.22, 0.42) * (0.8 + 0.6 * I);
      normal.spawn(time, p.x + ca * r0, p.y + 0.06, p.z + sa * r0,
        ca * hs, rand(0.3, 1.2 + 2.6 * I), sa * hs,
        rand(0.5, 0.95) + 0.45 * I, 3.4, 0.7, s0, s0 * rand(2.6, 3.8), 0.4 + 0.25 * I, SHAPE_SOFT, _ca, _cb);
    }
    normal.commit();
  }

  function burstSparks(p, o) {
    const base = getColor(o.color, PAL.spark);
    const n = Math.max(1, Math.round((o.count ?? 26) * qScale));
    _cc.copy(base).lerp(PAL.white, 0.12);                       // hot start
    _cb.setRGB(base.r * 0.9, base.g * 0.35, base.b * 0.25);     // cools to ember red
    add.carry(lastVel, followOf(o, 0.6), 0.8);
    for (let i = 0; i < n; i++) {
      randDir(_d);
      _d.y = Math.abs(_d.y) * 0.9 + 0.15;
      const sp = rand(5, 15);
      const s0 = rand(0.08, 0.15);
      add.spawn(time, p.x, p.y, p.z, _d.x * sp, _d.y * sp, _d.z * sp,
        rand(0.3, 0.75), 1.6, -G * 0.75, s0, s0 * 0.3, 2.0, SHAPE_STREAK, _cc, _cb);
    }
    _ca.copy(base).lerp(PAL.white, 0.6);
    add.spawn(time, p.x, p.y, p.z, 0, 0, 0, 0.14, 6, 0, 0.9, 0.25, 2.6, SHAPE_GLOW, _ca, base);
    add.commit();
  }

  function burstConfetti(p, o) {
    const n = Math.max(1, Math.round((o.count ?? 90) * qScale));
    const custom = Array.isArray(o.colors) && o.colors.length > 0 ? o.colors : null;
    const f = followOf(o, 0.9);
    const wx = lastVel.x * f, wy = lastVel.y * f * 0.4, wz = lastVel.z * f;
    for (let i = 0; i < n; i++) {
      const c = custom ? getColor(custom[i % custom.length], PAL.white) : CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      const a = Math.random() * TAU;
      const hs = rand(1.5, 6.5);
      randDir(_d).multiplyScalar(0.4);
      spawnConfetti(p.x + _d.x, p.y + _d.y + 0.3, p.z + _d.z,
        Math.cos(a) * hs, rand(7, 14), Math.sin(a) * hs, wx, wy, wz, c);
    }
    // a pop of sparkles + flash so the burst reads instantly
    add.carry(lastVel, f, 0.35);
    const ns = Math.round(12 * qScale);
    for (let i = 0; i < ns; i++) {
      const c = STAR_COLORS[i % STAR_COLORS.length];
      randDir(_d);
      const sp = rand(3, 8);
      _ca.copy(c).lerp(PAL.white, 0.3);
      add.spawn(time, p.x, p.y + 0.3, p.z, _d.x * sp, Math.abs(_d.y) * sp + 1, _d.z * sp,
        rand(0.5, 0.9), 3.2, 2, rand(0.3, 0.55), 0.04, 2.4, SHAPE_SPARKLE, _ca, c);
    }
    add.spawn(time, p.x, p.y + 0.3, p.z, 0, 0, 0, 0.2, 5, 0, 2.2, 0.6, 2.0, SHAPE_GLOW, PAL.white, PAL.gold);
    add.commit();
    cfMesh.visible = true;
  }

  function burstCoin(p, o) {
    const gold = getColor(o.color, PAL.gold);
    const deep = PAL.goldDeep;
    const f = followOf(o, 0.9);
    add.carry(lastVel, f, 0.35);
    _ca.copy(gold).lerp(PAL.white, 0.6);
    add.spawn(time, p.x, p.y, p.z, 0, 0, 0, 0.22, 6, 0, 1.5, 0.4, 2.6, SHAPE_GLOW, _ca, gold);
    const ns = Math.max(4, Math.round(16 * qScale));
    for (let i = 0; i < ns; i++) {
      randDir(_d);
      _d.y = _d.y * 0.6 + 0.25;
      const sp = rand(2.5, 6.5);
      _ca.copy(gold).lerp(PAL.white, rand(0, 0.3));
      add.spawn(time, p.x, p.y, p.z, _d.x * sp, _d.y * sp, _d.z * sp,
        rand(0.5, 0.95), 4.2, 3, rand(0.32, 0.6), 0.04, 2.4, SHAPE_SPARKLE, _ca, deep);
    }
    const nm = Math.max(3, Math.round(10 * qScale));
    for (let i = 0; i < nm; i++) {
      const a = Math.random() * TAU, r = rand(0.5, 1.6);
      add.spawn(time, p.x, p.y, p.z, Math.cos(a) * r, rand(1.5, 4), Math.sin(a) * r,
        rand(0.6, 1.0), 2, 2.5, rand(0.1, 0.16), 0.02, 2.4, SHAPE_GLOW, gold, deep);
    }
    add.commit();
    spawnRing(p.x, p.y, p.z, gold, 1.5, 0.38, 2.4, null, f);
  }

  function burstBoost(p, o) {
    // direction of travel (horizontal); the burst sprays behind it, relative to the rider
    let fx = o.dir ? o.dir.x : lastVel.x;
    let fz = o.dir ? o.dir.z : lastVel.z;
    const l = Math.sqrt(fx * fx + fz * fz);
    if (l > 1e-3) { fx /= l; fz /= l; } else { fx = tr.fwd.x; fz = tr.fwd.z; }
    const sx = -fz, sz = fx;
    const A = getColor(o.color, PAL.boostA);
    const f = followOf(o, 0.85);
    add.carry(lastVel, f, 0.6);
    const n = Math.max(6, Math.round(32 * qScale));
    for (let i = 0; i < n; i++) {
      const back = rand(7, 19), lat = rand(-4.5, 4.5), up = rand(0.2, 4.5), off = rand(-0.4, 0.4);
      _ca.copy(A).lerp(PAL.white, 0.2);
      _cb.copy(A).lerp(PAL.boostB, rand(0.5, 1));
      const s0 = rand(0.1, 0.17);
      add.spawn(time, p.x + sx * off, p.y + rand(0.1, 0.8), p.z + sz * off,
        -fx * back + sx * lat, up, -fz * back + sz * lat,
        rand(0.3, 0.65), 2.2, -8, s0, s0 * 0.3, 2.6, SHAPE_STREAK, _ca, _cb);
    }
    const ng = Math.max(2, Math.round(6 * qScale));
    for (let i = 0; i < ng; i++) {
      const back = rand(2, 6);
      const s0 = rand(0.6, 1.0);
      add.spawn(time, p.x, p.y + rand(0.3, 0.9), p.z, -fx * back, rand(0, 1), -fz * back,
        rand(0.22, 0.34), 3, 0, s0, s0 * rand(2.0, 2.8), 0.6, SHAPE_GLOW, A, PAL.boostB);
    }
    add.commit();
    spawnRing(p.x, p.y, p.z, A, 3.4, 0.5, 2.6, null, f * 0.7);
  }

  function burstRing(p, o) {
    const c = getColor(o.color, PAL.white);
    const R = o.radius ?? 4.2;
    const life = o.life ?? 0.62;
    const f = followOf(o, 0);
    spawnRing(p.x, p.y, p.z, c, R, life, 2.4, o.normal || null, f);
    // motes riding the ring outward (drag k: final travel = v0 / k ≈ R)
    if (o.normal) {
      _n.copy(o.normal);
      if (_n.lengthSq() < 1e-6) _n.copy(UP); else _n.normalize();
    } else _n.copy(UP);
    _t1.crossVectors(_n, Math.abs(_n.y) < 0.9 ? UP : XAXIS).normalize();
    _t2.crossVectors(_n, _t1);
    const n = Math.max(6, Math.round(18 * qScale));
    const k = 4.5, v0 = R * k;
    _ca.copy(c).lerp(PAL.white, 0.4);
    add.carry(lastVel, f, 0.3);
    const ox = p.x + _n.x * 0.1, oy = p.y + _n.y * 0.1, oz = p.z + _n.z * 0.1;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rand(-0.12, 0.12);
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = _t1.x * ca + _t2.x * sa, dy = _t1.y * ca + _t2.y * sa, dz = _t1.z * ca + _t2.z * sa;
      const vv = v0 * rand(0.9, 1.05);
      add.spawn(time, ox, oy, oz, dx * vv, dy * vv, dz * vv,
        life * rand(0.85, 1.0), k, 0, rand(0.2, 0.28), 0.05, 2.4, SHAPE_GLOW, _ca, c);
    }
    add.commit();
  }

  function burstPuff(p, o) {
    const c = o.color != null ? getColor(o.color, PAL.white) : ambientTint(PAL.white, 0.45);
    const n = Math.max(10, Math.round(42 * qScale));
    normal.carry(lastVel, followOf(o, 0), 1.5);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, ca = Math.cos(a), sa = Math.sin(a);
      const r0 = Math.random() * 1.6;
      const hs = rand(2.5, 11);
      _ca.copy(c).multiplyScalar(rand(0.84, 1.0));
      _cb.copy(c).lerp(PAL.white, 0.35);
      const s0 = rand(1.6, 3.2);
      normal.spawn(time, p.x + ca * r0, p.y + rand(-0.3, 0.6), p.z + sa * r0,
        ca * hs, rand(2.5, 12) * (1 - 0.35 * r0 / 1.6), sa * hs,
        rand(1.1, 2.0), 2.3, -4.5, s0, s0 * rand(2.0, 3.0), 0.85, SHAPE_SOFT, _ca, _cb);
    }
    // splash droplets
    const nd = Math.max(6, Math.round(26 * qScale));
    _ca.copy(c).lerp(PAL.white, 0.5);
    for (let i = 0; i < nd; i++) {
      const a = Math.random() * TAU, hs = rand(1, 4.5);
      normal.spawn(time, p.x, p.y + 0.2, p.z, Math.cos(a) * hs, rand(9, 17), Math.sin(a) * hs,
        rand(0.7, 1.1), 0.9, -G * 0.7, rand(0.22, 0.4), 0.08, 0.9, SHAPE_SOFT, _ca, c);
    }
    normal.commit();
    spawnRing(p.x, p.y, p.z, c, 9.5, 0.9, 1.4, null, 0);
  }

  function burstStars(p, o) {
    const n = Math.max(6, Math.round((o.count ?? 26) * qScale));
    const tint = o.color !== undefined ? getColor(o.color, PAL.gold) : null;
    add.carry(lastVel, followOf(o, 0.92), 0.3);
    for (let i = 0; i < n; i++) {
      const c = tint || STAR_COLORS[i % STAR_COLORS.length];
      randDir(_d);
      const sp = rand(3, 9);
      _ca.copy(c).lerp(PAL.white, 0.15);
      add.spawn(time, p.x, p.y, p.z, _d.x * sp, _d.y * sp, _d.z * sp,
        rand(0.6, 1.15), 3.4, 2.5, rand(0.38, 0.7), 0.05, 2.4, SHAPE_SPARKLE, _ca, c);
    }
    // golden fountain
    const nf = Math.max(4, Math.round(12 * qScale));
    _ca.copy(PAL.gold).lerp(PAL.white, 0.5);
    for (let i = 0; i < nf; i++) {
      add.spawn(time, p.x, p.y, p.z, rand(-3, 3), rand(8, 14), rand(-3, 3),
        rand(0.5, 0.8), 1.4, -G * 0.6, rand(0.07, 0.11), 0.02, 2.4, SHAPE_STREAK, _ca, PAL.goldDeep);
    }
    add.spawn(time, p.x, p.y, p.z, 0, 0, 0, 0.2, 5, 0, 2.2, 0.6, 2.2, SHAPE_GLOW, PAL.white, PAL.gold);
    add.commit();
  }

  function burst(type, pos, opts) {
    if (!pos) return;
    const o = opts || EMPTY;
    switch (type) {
      case 'dust': burstDust(pos, o); break;
      case 'sparks': burstSparks(pos, o); break;
      case 'confetti': burstConfetti(pos, o); break;
      case 'coin': burstCoin(pos, o); break;
      case 'boost': burstBoost(pos, o); break;
      case 'ring': burstRing(pos, o); break;
      case 'puff': burstPuff(pos, o); break;
      case 'stars': burstStars(pos, o); break;
      default: break;
    }
  }

  // ==== public API ================================================================================
  function update(dt, ctx) {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    ctx = ctx || EMPTY;
    time += dt;
    shared.uTime.value = time;
    if (ctx.playerVel) lastVel.copy(ctx.playerVel);
    const cam = ctx.camera || camera;

    normal.update(time);
    add.update(time);
    updateConfetti(dt, cam);
    updateRings(dt);
    updateSpeedLines(dt, ctx);
    if (cam) updateTrail(dt, ctx, cam);
    updateEmbers(dt, ctx);
  }

  function setQuality(qq) {
    q = qq === 'low' ? 'low' : 'high';
    qScale = q === 'low' ? 0.5 : 1;
    normal.setLimit(CAP_NORMAL[q]);
    add.setLimit(CAP_ADD[q]);
    lineMesh.count = q === 'low' ? LINES_LOW : LINES_MAX;
    applyMaxPx();
  }

  function clear() {
    normal.reset();
    add.reset();
    cf.n = 0; cfMesh.count = 0; cfMesh.visible = false;
    rg.n = 0; ringMesh.count = 0; ringMesh.visible = false;
    tr.n = 0; tr.boost01 = 0; trailMesh.visible = false; trailGeo.setDrawRange(0, 0);
    lineOpacity = 0; lineBoost = 0; lineMesh.visible = false;
    emberAcc = 0;
    // Everything time-stamped is gone, so rebase the clock: keeps shader time small (float precision
    // of the twinkle/pulse terms on long sessions).
    time = 0;
    shared.uTime.value = 0;
  }

  function dispose() {
    normal.dispose();
    add.dispose();
    for (const m of [cfMesh, ringMesh, lineMesh, trailMesh]) {
      m.removeFromParent();
      m.geometry.dispose();
      m.material.dispose();
      if (m.isInstancedMesh) m.dispose();   // frees instanceMatrix/instanceColor GPU buffers
    }
  }

  setQuality(q);

  return { update, burst, setQuality, clear, dispose };
}
