// Procedural obby track: generator, colliders (oriented boxes + ramps in a spatial hash)
// and instanced rendering with a world-scale "stud" shader.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { zoneAt } from './themes.js';
import motionPack from './pieces/motion.js';
import terrainPack from './pieces/terrain.js';
import surfacesPack from './pieces/surfaces.js';
import setpiecesPack from './pieces/setpieces.js';

export const KIND = { SOLID: 0, KILL: 1, BOOST: 2, JUMP: 3, CHECK: 4, FALL: 5, DECOR: 6, CONVEYOR: 7, ICE: 8, BOUNCE: 9 };
const VK_LASER = 10; // visual-only kind: glowing laser beam (collides as KILL)
const BOX = 0, RAMP = 1;
const CELL = 24;
const AHEAD = 440;
const BEHIND = 45;
const MAX_YAW = 1.15;

const KILL_COL = new THREE.Color('#ff2a3d');
const BOOST_COL = new THREE.Color('#ffb300');
const JUMP_COL = new THREE.Color('#2bd96b');
const FALL_COL = new THREE.Color('#f4f1de');
const WHITE = new THREE.Color('#ffffff');
const KERB_DARK = new THREE.Color('#23263f');
const CONVEYOR_COL = new THREE.Color('#2b2d42');
const ICE_COL = new THREE.Color('#bde7ff');
const BOUNCE_COL = new THREE.Color('#ff4fa3');
const LASER_COL = new THREE.Color('#ff2a6d');

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q2 = new THREE.Quaternion();
const _axX = new THREE.Vector3(1, 0, 0);
const _axZ = new THREE.Vector3(0, 0, 1);
const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
const EMPTY = [];
const NODIST = -1e9; // collider does not count toward distance

function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- shader
const BLOCK_FRAG = /* glsl */ `
vec3 kEmis = vec3(0.0);
{
  vec3 an = abs(vNrmL);
  vec2 fuv; vec2 fh;
  if (an.y > 0.5) { fuv = vLocal.xz; fh = vHalf.xz; }
  else if (an.x > 0.5) { fuv = vLocal.zy; fh = vHalf.zy; }
  else { fuv = vLocal.xy; fh = vHalf.xy; }
  vec2 ed = fh - abs(fuv);
  float edgeD = min(ed.x, ed.y);
  float rim = 1.0 - smoothstep(0.05, 0.15, edgeD);
  float isTop = step(0.5, vNrmL.y);
  float isBottom = step(0.5, -vNrmL.y);
  float isSide = 1.0 - isTop - isBottom;
  vec3 base = diffuseColor.rgb;
  int kk = int(vKind + 0.5);
  // classic studs, one per 2 m
  vec2 sg = fract(vLocal.xz * 0.5) - 0.5;
  float sr = length(sg);
  float studRing = (smoothstep(0.27, 0.24, sr) - smoothstep(0.22, 0.19, sr)) * isTop;
  float studCap = smoothstep(0.21, 0.17, sr) * isTop;
  diffuseColor.rgb *= 1.0 - studRing * 0.22 + studCap * 0.08;
  float h01 = clamp((vLocal.y + vHalf.y) / max(2.0 * vHalf.y, 0.001), 0.0, 1.0);
  diffuseColor.rgb *= mix(1.0, mix(0.5, 1.0, h01), isSide);
  diffuseColor.rgb *= mix(1.0, 0.4, isBottom);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.45, rim * (1.0 - uGlow) * 0.9);
  kEmis += base * rim * uGlow * 1.9 + base * uGlow * 0.06;
  if (kk == 1) {
    float pulse = 0.8 + 0.35 * sin(uTime * 7.0);
    diffuseColor.rgb = base * 0.8;
    kEmis += base * (1.25 * pulse) + base * rim * 1.6;
  } else if (kk == 2) {
    float chev = fract((-vLocal.z - abs(vLocal.x) * 0.9) * 0.45 - uTime * 2.6);
    float arrow = smoothstep(0.45, 0.52, chev) * (1.0 - smoothstep(0.82, 0.9, chev));
    vec3 ac = mix(vec3(1.0, 0.42, 0.0), vec3(1.0, 0.95, 0.35), arrow);
    diffuseColor.rgb = mix(base * 0.7, ac, isTop);
    kEmis += ac * (0.45 + arrow * 1.6) * isTop + base * 0.25 * isSide;
  } else if (kk == 3) {
    float r = length(vLocal.xz);
    float ring = smoothstep(0.35, 0.5, fract(r * 0.6 - uTime * 1.8));
    vec3 ac = mix(vec3(0.05, 0.85, 0.35), vec3(0.8, 1.0, 0.3), ring);
    diffuseColor.rgb = mix(base, ac, isTop);
    kEmis += ac * (0.35 + ring * 1.3) * isTop + base * 0.2 * isSide;
  } else if (kk == 4) {
    float ch = mod(floor(vLocal.x * 0.5) + floor(vLocal.z * 0.5), 2.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.96), base, ch), isTop);
    kEmis += base * 0.3 * isTop * ch;
  } else if (kk == 5) {
    float st = step(0.5, fract((vLocal.x + vLocal.z + vLocal.y) * 0.9));
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.1), vec3(1.0, 0.78, 0.1), st), isSide);
    kEmis += vec3(1.0, 0.6, 0.1) * rim * 0.35 * isTop;
  } else if (kk == 7) { // conveyor belt: yellow chevrons streaming toward local -z
    float chev = fract((-vLocal.z + abs(vLocal.x) * 0.7) * 0.6 - uTime * 1.6);
    float arrow = smoothstep(0.55, 0.62, chev) * (1.0 - smoothstep(0.82, 0.9, chev));
    float belt = 0.5 + 0.5 * step(0.5, fract(vLocal.z * 2.0 + uTime * 3.2));
    vec3 top = mix(base * (0.8 + 0.2 * belt), vec3(1.0, 0.82, 0.15), arrow);
    float stripe = step(0.5, fract((vLocal.x + vLocal.y + vLocal.z) * 1.2));
    diffuseColor.rgb = mix(mix(base, vec3(1.0, 0.82, 0.15), stripe * 0.8), top, isTop);
    kEmis += vec3(1.0, 0.7, 0.1) * arrow * 0.9 * isTop;
  } else if (kk == 8) { // ice: pale, glossy streaks and sparkles
    float streak = smoothstep(0.86, 1.0, sin((vLocal.x * 0.8 + vLocal.z * 1.7) * 1.3) * 0.5 + 0.5);
    vec2 cell = floor(vLocal.xz * 1.5);
    float h = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
    float sparkle = step(0.965, h) * (0.5 + 0.5 * sin(uTime * 6.0 + h * 40.0));
    diffuseColor.rgb = mix(base, vec3(1.0), (streak * 0.35 + 0.12) * isTop);
    kEmis += vec3(0.75, 0.92, 1.0) * (sparkle * 1.6 * isTop + 0.08 + streak * 0.12 * isTop);
  } else if (kk == 9) { // bounce pad: pink pulses and polka dots
    float r = length(vLocal.xz);
    float ring = smoothstep(0.3, 0.5, fract(r * 0.8 - uTime * 2.4));
    vec2 dg = fract(vLocal.xz * 0.8) - 0.5;
    float dot1 = smoothstep(0.2, 0.16, length(dg));
    vec3 ac = mix(base, vec3(1.0, 0.85, 0.95), ring * 0.6 + dot1 * 0.3);
    diffuseColor.rgb = mix(base * 0.85, ac, isTop);
    kEmis += base * (0.25 + ring * 0.9) * isTop + base * 0.2 * isSide;
  } else if (kk == 10) { // laser: hot core, scanlines
    float scan = 0.75 + 0.25 * sin(vLocal.x * 18.0 - uTime * 30.0);
    diffuseColor.rgb = vec3(1.0);
    kEmis += base * (2.2 * scan) + vec3(1.0) * 0.6;
  }
}
`;

function makeBlockMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.0 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.uniforms.uGlow = uniforms.uGlow;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aKind;
varying vec3 vLocal; varying vec3 vHalf; varying vec3 vNrmL; varying float vKind;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vec3 iScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
vLocal = position * iScale; vHalf = iScale * 0.5; vNrmL = normal; vKind = aKind;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uTime; uniform float uGlow;
varying vec3 vLocal; varying vec3 vHalf; varying vec3 vNrmL; varying float vKind;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
${BLOCK_FRAG}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += kEmis;`);
  };
  mat.customProgramCacheKey = () => 'obby-block-v2';
  return mat;
}

// Unit wedge in [-0.5,0.5]^3 whose top slopes from y=-0.5 at z=+0.5 up to y=+0.5 at z=-0.5.
function makeWedge() {
  const A = [-0.5, -0.5, 0.5], B = [0.5, -0.5, 0.5], C = [0.5, -0.5, -0.5], D = [-0.5, -0.5, -0.5];
  const E = [-0.5, 0.5, -0.5], F = [0.5, 0.5, -0.5];
  const pos = [];
  const tri = (a, b, c, n) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * n[0] + cy * n[1] + cz * n[2] < 0) pos.push(...a, ...c, ...b);
    else pos.push(...a, ...b, ...c);
  };
  tri(A, D, C, [0, -1, 0]); tri(A, C, B, [0, -1, 0]);
  tri(A, B, F, [0, 1, 1]); tri(A, F, E, [0, 1, 1]);
  tri(D, E, F, [0, 0, -1]); tri(D, F, C, [0, 0, -1]);
  tri(A, E, D, [-1, 0, 0]);
  tri(B, C, F, [1, 0, 0]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- instance pools
class Pool {
  constructor(scene, geo, mat, cap, shadows = true) {
    this.cap = cap;
    this.kinds = new Float32Array(cap);
    this.kindAttr = new THREE.InstancedBufferAttribute(this.kinds, 1);
    this.kindAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aKind', this.kindAttr);
    const m = new THREE.InstancedMesh(geo, mat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < cap; i++) m.setMatrixAt(i, ZERO_M);
    m.setColorAt(0, WHITE);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = shadows;
    m.receiveShadow = true;
    scene.add(m);
    this.mesh = m;
    this.free = [];
    this.hw = 0;
    this.dirty = true;
    this.attrDirty = true;
  }
  alloc() {
    if (this.free.length) return this.free.pop();
    if (this.hw < this.cap) { this.hw++; this.mesh.count = this.hw; return this.hw - 1; }
    return -1;
  }
  release(i) {
    if (i < 0) return;
    this.mesh.setMatrixAt(i, ZERO_M);
    this.free.push(i);
    this.dirty = true;
  }
  reset() {
    for (let i = 0; i < this.hw; i++) this.mesh.setMatrixAt(i, ZERO_M);
    this.free.length = 0;
    this.hw = 0;
    this.mesh.count = 0;
    this.dirty = true;
  }
  // Upload only the live range; colours/kinds only when instances were (re)assigned.
  flush() {
    const n = Math.max(1, this.hw);
    if (this.dirty) {
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, n * 16);
      im.needsUpdate = true;
      this.dirty = false;
    }
    if (this.attrDirty) {
      const ic = this.mesh.instanceColor;
      ic.clearUpdateRanges();
      ic.addUpdateRange(0, n * 3);
      ic.needsUpdate = true;
      this.kindAttr.clearUpdateRanges();
      this.kindAttr.addUpdateRange(0, n);
      this.kindAttr.needsUpdate = true;
      this.attrDirty = false;
    }
  }
}

// ---------------------------------------------------------------- canvas signs
function signTexture(lines, bg, fg) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 512, 128);
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 10; g.strokeRect(5, 5, 502, 118);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = fg;
  const font = "'Lilita One', 'Arial Black', Impact, sans-serif";
  if (lines.length === 1) {
    g.font = `64px ${font}`;
    g.fillText(lines[0], 256, 68);
  } else {
    g.font = `54px ${font}`;
    g.fillText(lines[0], 256, 50);
    g.font = `30px ${font}`;
    g.globalAlpha = 0.85;
    g.fillText(lines[1], 256, 100);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---------------------------------------------------------------- track
export function createTrack({ scene }) {
  const uniforms = { uTime: { value: 0 }, uGlow: { value: 0 } };
  const blockMat = makeBlockMaterial(uniforms);
  const statics = new Pool(scene, new THREE.BoxGeometry(1, 1, 1), blockMat, 3200);
  const ramps = new Pool(scene, makeWedge(), blockMat, 220);
  const dyn = new Pool(scene, new THREE.BoxGeometry(1, 1, 1), blockMat, 600);

  // coins
  const coinGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.14, 22);
  coinGeo.rotateX(Math.PI / 2);
  const coinMat = new THREE.MeshStandardMaterial({
    color: '#ffd23f', emissive: '#ff9f1c', emissiveIntensity: 0.55, metalness: 0.65, roughness: 0.28,
  });
  const coinMesh = new THREE.InstancedMesh(coinGeo, coinMat, 480);
  coinMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  coinMesh.count = 0;
  coinMesh.frustumCulled = false;
  coinMesh.castShadow = true;
  scene.add(coinMesh);
  const coinFree = [];
  let coinHw = 0;

  // turbo rings: fly through them for turbo
  const RING_MAX = 120;
  const ringGeo = new THREE.TorusGeometry(1.6, 0.16, 10, 36);
  const ringMat = new THREE.MeshStandardMaterial({
    color: '#7df9ff', emissive: '#22d3ee', emissiveIntensity: 1.1, metalness: 0.3, roughness: 0.3,
  });
  const ringMesh = new THREE.InstancedMesh(ringGeo, ringMat, RING_MAX);
  ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  ringMesh.count = 0;
  ringMesh.frustumCulled = false;
  scene.add(ringMesh);
  const ringFree = [];
  let ringHw = 0;
  const rings = [];

  // shared sign geometry/materials
  const postGeo = new THREE.BoxGeometry(1, 1, 1);
  const postMat = new THREE.MeshStandardMaterial({ color: '#f4f4f8', roughness: 0.5 });
  const signGeo = new THREE.PlaneGeometry(1, 1);
  const flagGeo = new THREE.PlaneGeometry(1.8, 1.1, 6, 1);
  flagGeo.translate(0.9, 0, 0);

  const hash = new Map();
  const pieces = [];
  const movers = [];
  const fallers = [];
  const coins = [];
  const flags = [];
  const colorCache = new Map();

  let rng = Math.random;
  let cur = { x: 0, y: 0, z: 0, yaw: 0, dist: 0 };
  let d01 = 0;
  let lastCpDist = 0;
  let cpCount = 0;
  let recordDist = 0;
  let recordState = 0; // 0 = not placed, 1 = pending (inside a gap), 2 = placed
  let lastType = '';
  let colorIdx = 0;
  let piece = null;
  let startSpawn = null;

  const col3 = (hex) => {
    let c = colorCache.get(hex);
    if (!c) { c = new THREE.Color(hex); colorCache.set(hex, c); }
    return c;
  };
  const zoneIndexAt = (d) => Math.floor(Math.max(0, d) / CONFIG.zoneLength);
  const zoneHere = () => zoneAt(zoneIndexAt(cur.dist));
  function pickColor() {
    const pal = zoneHere().palette;
    colorIdx = (colorIdx + 1 + Math.floor(rng() * (pal.length - 1))) % pal.length;
    return col3(pal[colorIdx]);
  }
  const shadeCache = new Map();
  function shade(c) {
    let s = shadeCache.get(c);
    if (!s) { s = c.clone().offsetHSL(0, -0.05, 0.12); shadeCache.set(c, s); }
    return s;
  }

  // ------------------------------------------------ spatial hash
  const keyOf = (ix, iz) => (ix + 32768) * 65536 + (iz + 32768);
  function hashInsert(col, reach) {
    const r = Math.hypot(col.hx, col.hz) + reach + 1.2;
    const x0 = Math.floor((col.x - r) / CELL), x1 = Math.floor((col.x + r) / CELL);
    const z0 = Math.floor((col.z - r) / CELL), z1 = Math.floor((col.z + r) / CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = keyOf(ix, iz);
        let arr = hash.get(k);
        if (!arr) { arr = []; hash.set(k, arr); }
        arr.push(col);
        col.cells.push(k);
      }
    }
  }
  function hashRemove(col) {
    for (const k of col.cells) {
      const arr = hash.get(k);
      if (!arr) continue;
      const i = arr.indexOf(col);
      if (i >= 0) { arr[i] = arr[arr.length - 1]; arr.pop(); }
      if (!arr.length) hash.delete(k);
    }
    col.cells.length = 0;
  }
  const cellAt = (x, z) => hash.get(keyOf(Math.floor(x / CELL), Math.floor(z / CELL))) || EMPTY;

  // ------------------------------------------------ colliders
  function writeMatrix(col, ox = 0, oy = 0, oz = 0) {
    if (!col.pool || col.idx < 0) return;
    _p.set(col.x + ox, col.y + oy, col.z + oz);
    _q.setFromAxisAngle(_up, col.yaw);
    if (col.tilt) { _q2.setFromAxisAngle(col.tiltAxis === 'x' ? _axX : _axZ, col.tilt); _q.multiply(_q2); }
    _s.set(col.hx * 2, col.hy * 2, col.hz * 2);
    if (col.move && col.move.type === 4 && !col.active) {
      // blinking hazard: hidden while off, thin flicker just before it switches back on
      if (!col.blinkWarn) { col.pool.mesh.setMatrixAt(col.idx, ZERO_M); col.pool.dirty = true; return; }
      _s.y *= 0.25;
      _s.x *= 0.6 + 0.4 * (Math.sin(uniforms.uTime.value * 40) * 0.5 + 0.5);
    }
    _m.compose(_p, _q, _s);
    col.pool.mesh.setMatrixAt(col.idx, _m);
    col.pool.dirty = true;
  }

  function addCol(kind, shape, pool, x, y, z, hx, hy, hz, yaw, color, d0, d1, reach = 0, vkind = kind) {
    const col = {
      kind, shape, x, y, z, hx, hy, hz, yaw, c: Math.cos(yaw), s: Math.sin(yaw),
      d0, d1, pool, idx: -1, cells: [], active: true, move: null, vx: 0, vz: 0,
      bx: x, by: y, bz: z, cp: -1, spawn: null, fall: null, gate: null, dead: false,
      vy: 0, spinW: 0, push: null, tilt: 0, tiltAxis: 'z', blinkWarn: false,
    };
    if (pool) {
      col.idx = pool.alloc();
      if (col.idx >= 0) {
        pool.kinds[col.idx] = vkind;
        pool.mesh.setColorAt(col.idx, color);
        pool.attrDirty = true;
        writeMatrix(col);
      }
    }
    if (kind !== KIND.DECOR) hashInsert(col, reach);
    piece.cols.push(col);
    return col;
  }

  // ------------------------------------------------ cursor helpers
  const wx = (lx, lf) => cur.x + Math.cos(cur.yaw) * lx - Math.sin(cur.yaw) * lf;
  const wz = (lx, lf) => cur.z - Math.sin(cur.yaw) * lx - Math.cos(cur.yaw) * lf;
  function advance(len, dy = 0) {
    cur.x += -Math.sin(cur.yaw) * len;
    cur.z += -Math.cos(cur.yaw) * len;
    cur.y += dy;
    cur.dist += len;
  }
  function turn(dyaw) {
    cur.yaw = Math.max(-MAX_YAW, Math.min(MAX_YAW, cur.yaw + dyaw));
  }
  const ROADLIKE = (k) => k === KIND.SOLID || k === KIND.BOOST || k === KIND.JUMP || k === KIND.CHECK || k === KIND.FALL
    || k === KIND.CONVEYOR || k === KIND.ICE || k === KIND.BOUNCE;
  const defaultColor = (kind) => (kind === KIND.KILL ? KILL_COL : kind === KIND.BOOST ? BOOST_COL
    : kind === KIND.JUMP ? JUMP_COL : kind === KIND.FALL ? FALL_COL : kind === KIND.CONVEYOR ? CONVEYOR_COL
    : kind === KIND.ICE ? ICE_COL : kind === KIND.BOUNCE ? BOUNCE_COL : pickColor());

  // Platform from forward a..b relative to cursor, top at cur.y + dy.
  function slab(kind, a, b, w, o = {}) {
    const th = o.th ?? 1.4;
    const top = cur.y + (o.dy ?? 0);
    const off = o.off ?? 0;
    const mid = (a + b) / 2;
    const color = o.color ?? defaultColor(kind);
    const counts = ROADLIKE(kind) && !o.noDist;
    return addCol(kind, BOX, o.pool ?? statics, wx(off, mid), top - th / 2, wz(off, mid),
      w / 2, th / 2, (b - a) / 2, cur.yaw + (o.yaw ?? 0), color,
      counts ? cur.dist + a : NODIST, counts ? cur.dist + b : NODIST, o.reach ?? 0);
  }
  function ramp(a, b, w, rise, color) {
    const mid = (a + b) / 2;
    return addCol(KIND.SOLID, RAMP, ramps, wx(0, mid), cur.y + rise / 2, wz(0, mid),
      w / 2, rise / 2, (b - a) / 2, cur.yaw, color ?? pickColor(), cur.dist + a, cur.dist + b);
  }
  function addCoin(lx, lf, h) {
    let idx = coinFree.length ? coinFree.pop() : (coinHw < 480 ? coinHw++ : -1);
    if (idx < 0) return;
    coinMesh.count = coinHw;
    const c = { x: wx(lx, lf), y: cur.y + h, z: wz(lx, lf), idx, taken: false, ph: rng() * 6.28 };
    coins.push(c);
    piece.coins.push(c);
  }
  function addRing(lx, lf, h) {
    const idx = ringFree.length ? ringFree.pop() : (ringHw < RING_MAX ? ringHw++ : -1);
    if (idx < 0) return null;
    ringMesh.count = ringHw;
    const r = { x: wx(lx, lf), y: cur.y + h, z: wz(lx, lf), yaw: cur.yaw, idx, taken: false, ph: rng() * 6.28 };
    rings.push(r);
    piece.rings.push(r);
    return r;
  }
  function coinLine(f0, f1, lx, n) {
    for (let i = 0; i < n; i++) addCoin(lx, f0 + (f1 - f0) * (i / Math.max(1, n - 1)), 1.15);
  }
  // floating ambient blocks beside the track (no collision)
  function decor() {
    if (rng() < 0.45) return;
    const n = 1 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      const side = rng() < 0.5 ? -1 : 1;
      const lx = side * (16 + rng() * 34);
      const f = rng() * 30;
      const s = 2 + rng() * 6;
      const h = (rng() - 0.6) * 30;
      const col = addCol(KIND.DECOR, BOX, statics, wx(lx, f), cur.y + h, wz(lx, f), s / 2, s / 2, s / 2,
        rng() * 6.28, pickColor(), NODIST, NODIST);
      col.decorSpin = (rng() - 0.5) * 0.4;
    }
  }

  function makeGate(x, y, z, yaw, width, lines, bg, fg, glow) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = yaw;
    const half = width / 2 + 0.6;
    const postH = 9; // tall enough that the chase camera clears the sign mid-jump
    const matPost = glow ? new THREE.MeshStandardMaterial({ color: bg, emissive: bg, emissiveIntensity: 0.8, roughness: 0.4 }) : postMat;
    for (const sx of [-half, half]) {
      const p = new THREE.Mesh(postGeo, matPost);
      p.scale.set(0.8, postH, 0.8);
      p.position.set(sx, postH / 2, 0);
      p.castShadow = true;
      g.add(p);
    }
    const bar = new THREE.Mesh(postGeo, matPost);
    bar.scale.set(half * 2 + 0.8, 0.8, 0.8);
    bar.position.set(0, postH, 0);
    g.add(bar);
    const tex = signTexture(lines, bg, fg);
    const signMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, side: THREE.DoubleSide });
    const sign = new THREE.Mesh(signGeo, signMat);
    const sw = Math.min(half * 2 - 0.4, 9);
    sign.scale.set(sw, sw / 4, 1);
    sign.position.set(0, postH - 0.4 - sw / 8, 0);
    g.add(sign);
    scene.add(g);
    piece.objs.push(g);
    piece.disposables.push(tex, signMat);
    if (glow) piece.disposables.push(matPost);
    return g;
  }

  // ------------------------------------------------ pieces
  const W = () => Math.max(5.4, 9.6 - d01 * 3.4 + (rng() - 0.5) * 1.4);

  function startPad() {
    slab(KIND.CHECK, 0, 26, 12, { color: col3('#3a86ff'), th: 2 });
    const cp = piece.cols[piece.cols.length - 1];
    cp.cp = 0;
    cp.spawn = { x: wx(0, 5), y: cur.y, z: wz(0, 5), yaw: cur.yaw, dist: cur.dist + 5 };
    startSpawn = cp.spawn;
    makeGate(wx(0, 16), cur.y, wz(0, 16), cur.yaw, 12, ['bobobike', 'SEGURA O W E VAI!'], '#1b1f3b', '#ffd23f', false);
    advance(26);
    slab(KIND.SOLID, 0, 26, 9);
    coinLine(6, 22, 0, 6);
    advance(26);
  }

  const P = {
    straight() {
      const len = 18 + rng() * 22, w = W();
      slab(KIND.SOLID, 0, len, w);
      if (rng() < 0.55) coinLine(len * 0.25, len * 0.85, (rng() - 0.5) * (w - 2), 5);
      if (rng() < 0.3) slab(KIND.BOOST, len * 0.4, len * 0.4 + 4, Math.min(w, 4.5), { dy: 0.06, th: 0.3 });
      advance(len);
    },
    turbo() {
      const len = 58, w = W() + 1;
      slab(KIND.SOLID, 0, len, w);
      for (const f of [6, 24, 42]) slab(KIND.BOOST, f, f + 4, Math.min(w, 5), { dy: 0.06, th: 0.3 });
      coinLine(12, 52, -1.6, 6);
      coinLine(14, 54, 1.6, 6);
      advance(len);
    },
    kicker() {
      const w = W() + 1, gap = 11 + d01 * 5 + rng() * 3, drop = 1 + rng() * 3;
      const c = pickColor();
      slab(KIND.SOLID, 0, 17, w, { color: c });
      slab(KIND.BOOST, 2, 7, Math.min(w, 5), { dy: 0.06, th: 0.3 });
      ramp(10, 17, Math.min(w, 6), 2.4, shade(c));
      const v = 32, ang = Math.atan2(2.4, 7), vh = v * Math.cos(ang), vy = v * Math.sin(ang);
      for (let i = 1; i <= 7; i++) {
        const t = i * 0.12;
        addCoin(0, 17 + vh * t, 2.4 + vy * t - 0.5 * CONFIG.gravity * t * t + 0.9);
      }
      advance(17 + gap, -drop);
      const land = Math.max(32, 62 - gap);
      slab(KIND.SOLID, 0, land, w + 2);
      advance(land);
    },
    killStrips() {
      const w = W();
      const n = 2 + Math.floor(rng() * (1.5 + d01 * 2.5));
      const sp = 13 - d01 * 2.5;
      const len = 10 + n * sp + 6;
      slab(KIND.SOLID, 0, len, w);
      for (let i = 0; i < n; i++) {
        const f = 10 + i * sp;
        if (d01 < 0.45 && rng() < 0.7) {
          const sw = w * 0.58, side = rng() < 0.5 ? -1 : 1;
          slab(KIND.KILL, f, f + 0.9, sw, { off: side * (w - sw) / 2, dy: 0.45, th: 0.45 });
        } else {
          slab(KIND.KILL, f, f + 0.9, w, { dy: 0.45, th: 0.45 });
          addCoin(0, f + 0.5, 2.6);
        }
      }
      advance(len);
    },
    slalom() {
      const w = Math.max(W() + 2, 7.5);
      const n = 3 + Math.floor(rng() * 3);
      const sp = 24 - d01 * 6; // room to land between blocks after hopping one
      const len = 8 + n * sp + 6;
      slab(KIND.SOLID, 0, len, w);
      let side = rng() < 0.5 ? -1 : 1;
      for (let i = 0; i < n; i++) {
        const f = 8 + i * sp;
        const bw = w * (0.48 + d01 * 0.1);
        slab(KIND.KILL, f, f + 1.4, bw, { off: side * (w - bw) / 2, dy: 1.05, th: 1.05 });
        addCoin(-side * bw / 2, f + 0.7, 1.15);
        side = -side;
      }
      advance(len);
    },
    beam() {
      const w0 = W();
      slab(KIND.SOLID, 0, 7, w0); advance(7);
      const segs = 2 + Math.floor(rng() * 2);
      const bw = Math.max(1.9, 4.3 - d01 * 2.2);
      const c = pickColor();
      for (let i = 0; i < segs; i++) {
        const len = 9 + rng() * 6;
        if (i > 0) {
          slab(KIND.SOLID, -bw * 0.7, bw * 0.7, bw * 1.4, { th: 1.0, color: shade(c) });
          turn((rng() - 0.5) * 0.5);
        }
        slab(KIND.SOLID, 0, len, bw, { th: 1.0, color: c });
        if (rng() < 0.6) coinLine(2, len - 2, 0, 3);
        advance(len);
      }
      slab(KIND.SOLID, 0, 9, w0); advance(9);
    },
    movers() {
      const w0 = W();
      slab(KIND.SOLID, 0, 7, w0); advance(7);
      const n = 3 + Math.floor(rng() * 2 + d01 * 1.5);
      const size = Math.max(4.8, 6.6 - d01 * 1.6);
      for (let i = 0; i < n; i++) {
        advance(1.5 + rng() * 1.5 + d01 * 1.5);
        const amp = 2 + rng() * 1.5 + d01 * 2;
        const col = slab(KIND.SOLID, 0, size, size, { pool: dyn, th: 1.0, reach: amp });
        col.move = { type: 1, ax: Math.cos(cur.yaw), az: -Math.sin(cur.yaw), amp, w: 0.7 + rng() * 0.5 + d01 * 0.6, ph: i * 1.4 + rng() };
        movers.push(col);
        advance(size);
      }
      advance(2 + rng() * 2);
      slab(KIND.SOLID, 0, 10, w0); advance(10);
    },
    spinner() {
      const w0 = W();
      slab(KIND.SOLID, 0, 6, w0); advance(6);
      const n = d01 > 0.55 && rng() < 0.5 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const S = 14;
        slab(KIND.SOLID, 0, S, S);
        const hx = wx(0, S / 2), hz = wz(0, S / 2);
        addCol(KIND.KILL, BOX, statics, hx, cur.y + 0.9, hz, 0.55, 0.9, 0.55, cur.yaw, KILL_COL, NODIST, NODIST);
        const bar = addCol(KIND.KILL, BOX, dyn, hx, cur.y + 0.55, hz, S / 2 - 0.4, 0.3, 0.3, cur.yaw, KILL_COL, NODIST, NODIST);
        bar.move = { type: 2, w: (0.95 + d01 * 1.1) * (rng() < 0.5 ? -1 : 1), ph: rng() * 6.28 };
        movers.push(bar);
        advance(S);
        if (i < n - 1) { slab(KIND.SOLID, 0, 4, w0 * 0.8); advance(4); }
      }
      slab(KIND.SOLID, 0, 8, w0); advance(8);
    },
    pillars() {
      const w0 = W();
      slab(KIND.SOLID, 0, 6, w0); advance(6);
      const n = 4 + Math.floor(rng() * 3 + d01 * 2);
      const s = Math.max(3, 5.4 - d01 * 2);
      let off = 0;
      const c = pickColor();
      for (let i = 0; i < n; i++) {
        // early pillars are close and nearly flat (a rhythm section); later ones need real hops
        const gap = 1.0 + rng() * 0.8 + d01 * 3.2;
        let dy = (rng() - 0.5) * (0.6 + d01 * 1.0);
        if (dy > 0.45 + d01 * 0.55) dy = 0.45 + d01 * 0.55;
        advance(gap, dy);
        off = Math.max(-2.5, Math.min(2.5, off + (rng() - 0.5) * 3));
        slab(KIND.SOLID, 0, s, s, { off, th: 10, color: i % 2 ? c : shade(c) });
        if (rng() < 0.5) addCoin(off, s / 2, 1.15);
        advance(s);
      }
      advance(2.5 + rng() * 1.5);
      slab(KIND.SOLID, 0, 10, w0); advance(10);
    },
    stairs() {
      const w0 = W();
      slab(KIND.SOLID, 0, 8, w0); advance(8);
      const n = 3 + Math.floor(rng() * 2);
      const c = pickColor();
      for (let i = 0; i < n; i++) {
        const rise = 0.9 + rng() * 0.35;
        const gap = d01 > 0.25 && rng() < 0.4 ? 1.5 + rng() * 1.5 : 0;
        advance(gap, rise);
        const len = 7 + rng() * 2.5;
        slab(KIND.SOLID, 0, len, w0, { th: 1.4 + rise * (i + 1), color: i % 2 ? c : shade(c) });
        advance(len);
      }
      slab(KIND.SOLID, 0, 8, w0); advance(8);
    },
    curve() {
      const w = W() + 0.6;
      const n = 10 + Math.floor(rng() * 8);
      let dir = rng() < 0.5 ? -1 : 1;
      if (cur.yaw > 0.55) dir = -1; else if (cur.yaw < -0.55) dir = 1;
      const step = (0.06 + rng() * 0.045) * dir;
      const c = pickColor(), c2 = shade(c);
      const rails = d01 < 0.6;
      for (let i = 0; i < n; i++) {
        const L = 3.4;
        slab(KIND.SOLID, -0.15, L + w * Math.abs(step) * 0.6, w, { color: i % 2 ? c : c2 });
        if (rails) {
          // low kerb on the outside of the turn (dir +1 = yaw grows = left turn, so outside = +lx)
          const ox = dir * (w / 2 + 0.35);
          slab(KIND.SOLID, 0, L + 0.3, 0.7, { off: ox, dy: 0.7, th: 2.1, color: i % 2 ? KERB_DARK : WHITE, noDist: true });
        }
        advance(L);
        turn(step);
        if (Math.abs(cur.yaw) >= MAX_YAW) break;
      }
      slab(KIND.SOLID, 0, 6, w); advance(6);
    },
    fallTiles() {
      const w0 = W();
      slab(KIND.SOLID, 0, 6, w0); advance(6);
      const cols = 2 + (rng() < 0.5 ? 1 : 0);
      const rows = 6 + Math.floor(rng() * 4);
      const t = 3.0, g = 0.3;
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k < cols; k++) {
          const off = (k - (cols - 1) / 2) * (t + g);
          const col = slab(KIND.FALL, r * (t + g), r * (t + g) + t, t, { off, th: 0.8, pool: dyn });
          col.fall = { t0: -1 };
          fallers.push(col);
        }
      }
      advance(rows * (t + g));
      slab(KIND.SOLID, 0, 10, w0); advance(10);
    },
    jumpPad() {
      const w0 = W();
      slab(KIND.SOLID, 0, 10, w0);
      slab(KIND.JUMP, 6, 9.5, w0, { dy: 0.06, th: 0.3 });
      advance(10);
      const gap = 7 + rng() * 3, rise = 4.5 + rng() * 1.5;
      advance(gap, rise);
      slab(KIND.SOLID, 0, 32, w0 + 1, { th: 1.4 + rise });
      coinLine(4, 24, 0, 5);
      advance(32);
    },
    gates() {
      const w = W() + 1.5;
      const n = 2 + Math.floor(rng() * 2 + d01);
      const sp = 13 - d01 * 3;
      const len = 8 + n * sp + 6;
      slab(KIND.SOLID, 0, len, w);
      for (let i = 0; i < n; i++) {
        const f = 8 + i * sp;
        const hole = Math.max(3.3, 5 - d01 * 1.5);
        const ho = (rng() - 0.5) * (w - hole);
        const lw = ho - hole / 2 + w / 2;
        if (lw > 0.05) slab(KIND.KILL, f, f + 0.8, lw, { off: -w / 2 + lw / 2, dy: 3.2, th: 3.2 });
        const rw = w / 2 - (ho + hole / 2);
        if (rw > 0.05) slab(KIND.KILL, f, f + 0.8, rw, { off: w / 2 - rw / 2, dy: 3.2, th: 3.2 });
        addCoin(ho, f + 0.4, 1.15);
      }
      advance(len);
    },
    zigzag() {
      const w0 = W();
      slab(KIND.SOLID, 0, 7, w0); advance(7);
      const a = 0.32 + rng() * 0.1, bw = 2.7, c = pickColor();
      const base = cur.yaw;
      let s = rng() < 0.5 ? 1 : -1;
      for (let i = 0; i < 4; i++) {
        slab(KIND.SOLID, -1.8, 1.8, 3.6, { color: shade(c), th: 1.0 });
        cur.yaw = Math.max(-MAX_YAW, Math.min(MAX_YAW, base + a * s));
        slab(KIND.SOLID, 0, 9, bw, { color: c, th: 1.0 });
        advance(9);
        s = -s;
      }
      slab(KIND.SOLID, -1.8, 1.8, 3.6, { color: shade(c), th: 1.0 });
      cur.yaw = base;
      slab(KIND.SOLID, 0, 9, w0); advance(9);
    },
    checkpoint() {
      const w = Math.max(W(), 7) + 2, L = 12;
      const zone = zoneHere();
      const col = slab(KIND.CHECK, 0, L, w, { color: col3(zone.accent) });
      col.cp = ++cpCount;
      col.spawn = { x: wx(0, 3), y: cur.y, z: wz(0, 3), yaw: cur.yaw, dist: cur.dist + 3 };
      const dist = Math.round(cur.dist);
      const g = makeGate(wx(0, L * 0.55), cur.y, wz(0, L * 0.55), cur.yaw, w, [`CHECKPOINT ${cpCount}`, `${dist} m`], '#ffffff', '#1b1f3b', false);
      const flagMat = new THREE.MeshStandardMaterial({ color: '#9aa0b5', side: THREE.DoubleSide, roughness: 0.7 });
      const flag = new THREE.Mesh(flagGeo, flagMat);
      flag.position.set(-(w / 2 + 0.6), 8, 0);
      g.add(flag);
      piece.disposables.push(flagMat);
      col.gate = { group: g, flag, flagMat, active: false };
      flags.push(flag);
      lastCpDist = cur.dist;
      advance(L);
    },
    gap() {
      let len = 3 + d01 * 5.5 + rng() * 2.5;
      let dy = 0;
      const r = rng();
      if (r < 0.25) { dy = 0.6 + rng() * 0.9; len *= 0.75; }
      else if (r < 0.55) dy = -(1 + rng() * 3.5);
      if (cur.y > 35 && dy > 0) dy = -dy * 2;
      if (cur.y < -35 && dy < 0) dy = Math.min(1.2, -dy * 0.4);
      advance(len, dy);
    },
  };

  const WEIGHTS = [
    ['straight', () => 1.6 - d01 * 0.6],
    ['turbo', () => 0.45],
    ['kicker', () => 1.2],
    ['killStrips', () => 1.2],
    ['slalom', () => 1.0],
    ['beam', () => (d01 > 0.08 ? 1.0 : 0.35)],
    ['movers', () => (d01 > 0.12 ? 1.0 : 0)],
    ['spinner', () => (d01 > 0.18 ? 0.9 : 0)],
    ['pillars', () => 0.9],
    ['stairs', () => 0.75],
    ['curve', () => 1.5],
    ['fallTiles', () => (d01 > 0.22 ? 0.8 : 0)],
    ['jumpPad', () => 0.8],
    ['gates', () => (d01 > 0.08 ? 1.0 : 0.3)],
    ['zigzag', () => (d01 > 0.45 ? 0.6 : 0)],
  ];
  const EARLY = new Set(['straight', 'turbo', 'kicker', 'killStrips', 'curve', 'jumpPad', 'gates', 'slalom']);

  // ------------------------------------------------ piece packs (js/pieces/*.js)
  // Each pack default-exports an array of { name, weight(d01) => number, minDist?, early?, gen(ctx) }.
  const PACK = new Map();
  for (const pack of [motionPack, terrainPack, surfacesPack, setpiecesPack]) {
    if (!Array.isArray(pack)) continue;
    for (const def of pack) {
      if (!def || typeof def.gen !== 'function' || typeof def.name !== 'string' || P[def.name] || PACK.has(def.name)) continue;
      PACK.set(def.name, def);
      WEIGHTS.push([def.name, () => (cur.dist < (def.minDist || 0) ? 0 : def.weight(d01))]);
      if (def.early) EARLY.add(def.name);
    }
  }
  let onlyTypes = null; // test hook: restrict generation to these piece names
  // variety: where each piece type last started; named set pieces (x_*) stay rare and spaced out
  const lastAt = new Map();
  let lastSetAt = -1e9;
  const signedBy = new Map(); // piece type -> start distance (d0) of the piece that showed its sign this run
  function recency(name) {
    if (onlyTypes) return 1;
    const at = lastAt.get(name);
    if (name.startsWith('x_')) {
      if (cur.dist - lastSetAt < 380) return 0;
      if (at !== undefined && cur.dist - at < 1600) return 0.12;
    }
    if (at === undefined) return 1;
    const since = cur.dist - at;
    return since < 160 ? 0.2 : since < 420 ? 0.6 : 1;
  }

  function pickType() {
    const early = cur.dist < 260;
    const ok = (name) => name !== lastType && (onlyTypes ? onlyTypes.has(name) : (!early || EARLY.has(name)));
    let total = 0;
    for (const [name, wf] of WEIGHTS) if (ok(name)) total += Math.max(0, wf() || 0) * recency(name);
    if (total <= 0) return onlyTypes && onlyTypes.size ? [...onlyTypes][0] : 'straight';
    let r = rng() * total;
    for (const [name, wf] of WEIGHTS) {
      if (!ok(name)) continue;
      r -= Math.max(0, wf() || 0) * recency(name);
      if (r <= 0) return name;
    }
    return 'straight';
  }

  const POOLS = { static: statics, dyn };
  function clampYaw() { cur.yaw = Math.max(-MAX_YAW, Math.min(MAX_YAW, cur.yaw)); }
  // attach motion to a collider (re-registers it in the hash with its full reach)
  function move(col, sp) {
    const lx = Math.cos(col.yaw), lz = -Math.sin(col.yaw); // collider local +x in world
    const fx = -Math.sin(col.yaw), fz = -Math.cos(col.yaw); // collider local forward (-z) in world
    let m, reach = 0;
    const ph = sp.phase ?? 0;
    if (sp.type === 'slide') {
      const axis = sp.axis || 'x';
      m = { type: 1, ax: axis === 'x' ? lx : axis === 'z' ? fx : 0, ay: axis === 'y' ? 1 : 0, az: axis === 'x' ? lz : axis === 'z' ? fz : 0, amp: sp.amp ?? 3, w: sp.speed ?? 1, ph };
      reach = axis === 'y' ? 0 : m.amp;
    } else if (sp.type === 'spin') {
      m = { type: 2, w: sp.speed ?? 1, ph: col.yaw + ph };
    } else if (sp.type === 'pendulum') {
      const L = sp.length ?? 6, axis = sp.axis || 'x';
      const dx = axis === 'x' ? lx : fx, dz = axis === 'x' ? lz : fz;
      const fr = sp.fraction ?? 1;
      m = { type: 3, L, fr, amp: sp.amp ?? 1, w: sp.speed ?? 1.5, ph, dx, dz, px: col.x, py: col.y + L * fr, pz: col.z, axis };
      col.tiltAxis = axis === 'x' ? 'z' : 'x';
      reach = L * Math.sin(Math.min(1.5, m.amp)) * fr + 0.5;
    } else if (sp.type === 'blink') {
      m = { type: 4, on: sp.on ?? 1.2, off: sp.off ?? 1.2, ph };
    } else if (sp.type === 'orbit') {
      m = { type: 5, R: sp.radius ?? 3, w: sp.speed ?? 1, ph };
      reach = m.R;
    } else return col;
    col.move = m;
    if (col.kind !== KIND.DECOR) { hashRemove(col); hashInsert(col, reach + 0.5); }
    if (!movers.includes(col)) movers.push(col);
    return col;
  }

  // API handed to piece packs. Coordinates are cursor-local: lx = lateral (+right), lf = forward
  // distance from the cursor, dy = height relative to the cursor's road top.
  const ctx = {
    KIND,
    get rng() { return rng; },
    get d01() { return d01; },
    get cur() { return { x: cur.x, y: cur.y, z: cur.z, yaw: cur.yaw, dist: cur.dist }; },
    MAX_YAW,
    colors: { KILL: KILL_COL, BOOST: BOOST_COL, JUMP: JUMP_COL, FALL: FALL_COL, WHITE, KERB_DARK, CONVEYOR: CONVEYOR_COL, ICE: ICE_COL, BOUNCE: BOUNCE_COL, LASER: LASER_COL },
    W, pickColor, shade, col3,
    zone: () => zoneHere(),
    // road-like platform from forward a..b; o: { off, dy, th, color, pool:'static'|'dyn', yaw, reach, noDist }
    slab(kind, a, b, w, o = {}) {
      const po = typeof o.pool === 'string' ? POOLS[o.pool] : o.pool;
      return slab(kind, a, b, w, { ...o, pool: po ?? (o.pool === undefined ? undefined : statics) });
    },
    ramp(a, b, w, rise, color) { return ramp(a, b, w, rise, color); },
    // any box centered at (lx, lf) with its CENTER at height dy; size w x h x d (full sizes)
    // o: { yaw (offset), color, pool:'static'|'dyn', laser:true (visual), dist:true (counts toward distance) }
    box(kind, lx, lf, dy, w, h, d, o = {}) {
      const pool = o.pool === 'dyn' ? dyn : statics;
      const color = o.color ?? (o.laser ? LASER_COL : defaultColor(kind));
      const counts = !!o.dist && ROADLIKE(kind);
      return addCol(kind, BOX, pool, wx(lx, lf), cur.y + dy, wz(lx, lf), w / 2, h / 2, d / 2,
        cur.yaw + (o.yaw ?? 0), color, counts ? cur.dist + lf - d / 2 : NODIST, counts ? cur.dist + lf + d / 2 : NODIST,
        0, o.laser ? VK_LASER : kind);
    },
    // visual-only block (no collision); handy for arms, towers, arches, scenery
    decor(lx, lf, dy, w, h, d, o = {}) {
      return addCol(KIND.DECOR, BOX, o.pool === 'dyn' ? dyn : statics, wx(lx, lf), cur.y + dy, wz(lx, lf), w / 2, h / 2, d / 2,
        cur.yaw + (o.yaw ?? 0), o.color ?? pickColor(), NODIST, NODIST, 0, o.laser ? VK_LASER : (o.vkind ?? KIND.SOLID));
    },
    // motion: { type:'slide', axis:'x'|'y'|'z', amp, speed, phase } | { type:'spin', speed, phase }
    //   | { type:'pendulum', length, amp (rad), speed, phase, axis:'x'|'z', fraction } | { type:'blink', on, off, phase }
    //   | { type:'orbit', radius, speed, phase }   (colliders must use pool:'dyn' to render motion)
    move,
    // conveyor push (m/s) along the collider's local forward (-z); negative pushes backwards
    conveyor(col, speed) {
      const fx = -Math.sin(col.yaw), fz = -Math.cos(col.yaw);
      col.push = { x: fx * speed, z: fz * speed };
      return col;
    },
    advance(len, dy = 0) { advance(len, dy); },
    turn(dyaw) { turn(dyaw); },
    setYaw(yaw) { cur.yaw = yaw; clampYaw(); },
    addCoin(lx, lf, h = 1.15) { addCoin(lx, lf, h); },
    coinLine(f0, f1, lx, n) { coinLine(f0, f1, lx, n); },
    addRing(lx, lf, h) { return addRing(lx, lf, h); },
    // a named arch across the road at forward lf (two lines of text); use sparingly (one canvas each).
    // Only the first piece of each type in a run gets its sign (they hide what comes next); named set
    // pieces (x_*) always keep theirs. Returns null when skipped.
    banner(lf, w, lines, bg = '#1b1f3b', fg = '#ffd23f', glow = false) {
      const ty = piece.type || '';
      if (!ty.startsWith('x_')) {
        const first = signedBy.get(ty);
        if (first !== undefined && first !== piece.d0) return null;
        signedBy.set(ty, piece.d0);
      }
      return makeGate(wx(0, lf), cur.y, wz(0, lf), cur.yaw, w, lines, bg, fg, glow);
    },
  };

  function newPiece() {
    piece = { d0: cur.dist, d1: cur.dist, cols: [], coins: [], rings: [], objs: [], disposables: [] };
    pieces.push(piece);
  }

  function placeRecordGate() {
    if (recordState === 2 || recordDist < 40) return;
    // surface containing the record; if the record falls inside a gap (also a gap within a
    // kicker/pillars/jump-pad piece), the start of the first surface after it
    let col = null, t = 0;
    for (const c of piece.cols) {
      if (c.d0 === NODIST || c.shape !== BOX || c.move || c.fall) continue;
      if (c.d0 <= recordDist && c.d1 >= recordDist) { col = c; t = (recordDist - c.d0) / Math.max(0.001, c.d1 - c.d0); break; }
      if (c.d0 > recordDist && (!col || c.d0 < col.d0)) col = c;
    }
    if (!col) { if (cur.dist >= recordDist) recordState = 1; return; }
    const lz = col.hz - t * 2 * col.hz;
    const x = col.x + col.s * lz, z = col.z + col.c * lz;
    makeGate(x, col.y + col.hy, z, col.yaw, col.hx * 2 + 1,
      ['RECORDE', `${Math.round(recordDist)} m · PASSA DAQUI!`], '#ffb703', '#1b1f3b', true);
    recordState = 2;
  }

  function genNext() {
    d01 = Math.min(1, cur.dist / 5200);
    newPiece();
    let type;
    if (cur.dist - lastCpDist >= CONFIG.checkpointEvery && lastType !== 'gap') type = 'checkpoint';
    else if (lastType !== 'gap' && lastType !== 'checkpoint' && rng() < 0.36 + d01 * 0.2) type = 'gap';
    else type = pickType();
    piece.type = type;
    lastAt.set(type, cur.dist);
    if (type.startsWith('x_')) lastSetAt = cur.dist;
    // a clean landing strip after every gap, so long drops never land straight on a hazard
    if (lastType === 'gap' && type !== 'gap') { slab(KIND.SOLID, 0, 14, W() + 1); advance(14); }
    if (P[type]) P[type]();
    else {
      const sx = cur.x, sz = cur.z, sy = cur.y, syaw = cur.yaw, sd = cur.dist;
      try {
        PACK.get(type).gen(ctx);
      } catch (e) {
        console.warn('[track] piece "' + type + '" failed:', e);
      }
      clampYaw();
      // a pack piece must move forward; if it failed or did nothing, fall back to a straight
      if (!(cur.dist > sd + 1) || !Number.isFinite(cur.x + cur.y + cur.z)) {
        cur.x = sx; cur.z = sz; cur.y = sy; cur.yaw = syaw; cur.dist = sd;
        P.straight();
      }
    }
    if (type !== 'gap') decor();
    lastType = type;
    piece.d1 = cur.dist;
    placeRecordGate();
  }

  function removePiece(p) {
    for (const col of p.cols) {
      col.dead = true;
      if (col.pool) col.pool.release(col.idx);
      if (col.cells.length) hashRemove(col);
      if (col.move) { const i = movers.indexOf(col); if (i >= 0) { movers[i] = movers[movers.length - 1]; movers.pop(); } }
      if (col.fall) { const i = fallers.indexOf(col); if (i >= 0) { fallers[i] = fallers[fallers.length - 1]; fallers.pop(); } }
      if (col.gate) { const i = flags.indexOf(col.gate.flag); if (i >= 0) flags.splice(i, 1); }
    }
    for (const c of p.coins) {
      if (!c.taken) { coinMesh.setMatrixAt(c.idx, ZERO_M); coinFree.push(c.idx); c.taken = true; }
      const i = coins.indexOf(c);
      if (i >= 0) { coins[i] = coins[coins.length - 1]; coins.pop(); }
    }
    for (const r of p.rings) {
      if (!r.taken) { ringMesh.setMatrixAt(r.idx, ZERO_M); ringFree.push(r.idx); r.taken = true; }
      const i = rings.indexOf(r);
      if (i >= 0) { rings[i] = rings[rings.length - 1]; rings.pop(); }
    }
    for (const o of p.objs) scene.remove(o);
    for (const d of p.disposables) d.dispose();
  }

  // ------------------------------------------------ public API
  const api = {
    KIND,
    get startSpawn() { return startSpawn; },
    uniforms,

    // Center-line point of the track at path distance d (first walkable surface at or after d).
    // Used by the headless test bot; not on the per-frame path.
    pathPoint(d, out) {
      let best = null, bestD = Infinity;
      for (const p of pieces) {
        if (p.d1 < d - 1) continue;
        for (const col of p.cols) {
          if (col.d0 === NODIST || col.kind === KIND.DECOR) continue;
          if (col.d1 < d) continue;
          const key = col.d0 <= d ? 0 : col.d0 - d;
          if (key < bestD) { bestD = key; best = col; }
        }
        if (best && bestD === 0) break;
      }
      if (!best) return null;
      const t = Math.max(0, Math.min(1, (d - best.d0) / Math.max(0.001, best.d1 - best.d0)));
      const lz = best.hz - t * 2 * best.hz;
      out.x = best.x + best.s * lz; out.z = best.z + best.c * lz;
      out.y = best.y + best.hy; out.col = best;
      out.type = pieces.find((p) => p.cols.includes(best))?.type || '';
      return out;
    },

    reset(seed, record = 0, opts = null) {
      onlyTypes = opts && Array.isArray(opts.only) && opts.only.length ? new Set(opts.only) : null;
      while (pieces.length) removePiece(pieces.shift());
      statics.reset(); ramps.reset(); dyn.reset();
      for (let i = 0; i < coinHw; i++) coinMesh.setMatrixAt(i, ZERO_M);
      coinFree.length = 0; coinHw = 0; coinMesh.count = 0;
      for (let i = 0; i < ringHw; i++) ringMesh.setMatrixAt(i, ZERO_M);
      ringFree.length = 0; ringHw = 0; ringMesh.count = 0; rings.length = 0;
      hash.clear();
      movers.length = 0; fallers.length = 0; coins.length = 0; flags.length = 0;
      rng = makeRng(seed);
      cur = { x: 0, y: 0, z: 0, yaw: 0, dist: -5 }; // spawn (5 m into the pad) is distance 0
      d01 = 0; lastCpDist = 0; cpCount = 0; lastType = 'checkpoint'; colorIdx = 0;
      lastAt.clear(); lastSetAt = -1e9; signedBy.clear();
      recordDist = record; recordState = 0;
      newPiece();
      startPad();
      piece.d1 = cur.dist;
      placeRecordGate();
      while (cur.dist < AHEAD) genNext();
    },

    // Generate ahead / cull behind. keepDist: distance of the last checkpoint (never cull past it).
    update(playerDist, keepDist) {
      let budget = 2;
      while (cur.dist < playerDist + AHEAD && budget-- > 0) genNext();
      const cullD = Math.min(playerDist, keepDist) - BEHIND;
      while (pieces.length > 1 && pieces[0].d1 < cullD) removePiece(pieces.shift());
    },

    // Advance moving colliders to absolute time t (called every physics step).
    stepMovers(t) {
      for (let i = 0; i < movers.length; i++) {
        const col = movers[i], m = col.move;
        if (m.type === 1) {
          const ph = m.w * t + m.ph;
          const s = Math.sin(ph) * m.amp, v = Math.cos(ph) * m.amp * m.w;
          col.x = col.bx + m.ax * s; col.z = col.bz + m.az * s;
          col.vx = m.ax * v; col.vz = m.az * v;
          if (m.ay) { col.y = col.by + m.ay * s; col.vy = m.ay * v; }
        } else if (m.type === 2) {
          col.yaw = m.ph + m.w * t;
          col.c = Math.cos(col.yaw); col.s = Math.sin(col.yaw);
          col.spinW = m.w;
        } else if (m.type === 3) {
          const a = m.w * t + m.ph;
          const th = m.amp * Math.sin(a), dth = m.amp * m.w * Math.cos(a);
          const r = m.L * m.fr, st = Math.sin(th), ct = Math.cos(th);
          col.x = m.px + m.dx * st * r; col.z = m.pz + m.dz * st * r; col.y = m.py - ct * r;
          col.vx = m.dx * ct * r * dth; col.vz = m.dz * ct * r * dth; col.vy = st * r * dth;
          col.tilt = m.axis === 'x' ? th : -th;
        } else if (m.type === 4) {
          const per = m.on + m.off;
          const lt = (((t + m.ph) % per) + per) % per;
          col.active = lt < m.on;
          col.blinkWarn = !col.active && lt > per - 0.45;
        } else if (m.type === 5) {
          const a = m.w * t + m.ph;
          col.x = col.bx + Math.cos(a) * m.R; col.z = col.bz + Math.sin(a) * m.R;
          col.vx = -Math.sin(a) * m.R * m.w; col.vz = Math.cos(a) * m.R * m.w;
        }
      }
      for (let i = 0; i < fallers.length; i++) {
        const col = fallers[i];
        if (col.fall.t0 < 0) continue;
        const age = t - col.fall.t0;
        if (age > 0.8) {
          col.active = false;
          const fa = age - 0.8;
          col.y = col.by - 0.5 * 30 * fa * fa;
        }
      }
    },

    // Highest walkable surface under (px,pz) with top in [py-down, py+up].
    ground(px, py, pz, up, down, out, pad = 0) {
      const arr = cellAt(px, pz);
      let best = -Infinity, bestCol = null, bestK = 0;
      for (let i = 0; i < arr.length; i++) {
        const col = arr[i];
        if (!col.active) continue;
        const dx = px - col.x, dz = pz - col.z;
        const lx = dx * col.c - dz * col.s;
        const lz = dx * col.s + dz * col.c;
        const ex = col.kind === KIND.KILL ? 0 : pad;
        if (lx > col.hx + ex || lx < -col.hx - ex || lz > col.hz + ex || lz < -col.hz - ex) continue;
        let top, k = 0;
        if (col.shape === RAMP) { k = col.hy / col.hz; top = col.y - col.hy + k * (col.hz - Math.max(-col.hz, Math.min(col.hz, lz))); }
        else top = col.y + col.hy;
        if (top > py + up || top < py - down) continue;
        if (top > best) { best = top; bestCol = col; bestK = k; }
      }
      if (!bestCol) return false;
      out.y = best; out.col = bestCol; out.k = bestK;
      return true;
    },

    // Cylinder (radius R, height H, feet at py) vs colliders. Pushes out of walls.
    // Returns 0 = nothing, 1 = pushed (out.nx/out.nz = accumulated push normal), 2 = touched a kill brick.
    collide(px, py, pz, R, H, stepUp, out) {
      const arr = cellAt(px, pz);
      let res = 0;
      out.px = px; out.pz = pz; out.nx = 0; out.nz = 0;
      for (let i = 0; i < arr.length; i++) {
        const col = arr[i];
        if (!col.active) continue;
        const dx = out.px - col.x, dz = out.pz - col.z;
        const lx = dx * col.c - dz * col.s;
        const lz = dx * col.s + dz * col.c;
        const rr = col.kind === KIND.KILL ? R - 0.22 : R;
        const ox = col.hx + rr - Math.abs(lx), oz = col.hz + rr - Math.abs(lz);
        if (ox <= 0 || oz <= 0) continue;
        const bottom = col.y - col.hy;
        let top;
        if (col.shape === RAMP) {
          const cl = Math.max(-col.hz, Math.min(col.hz, lz));
          top = bottom + (col.hy / col.hz) * (col.hz - cl);
        } else top = col.y + col.hy;
        if (py + H < bottom || py > top - 0.02) continue;
        if (col.kind === KIND.KILL) return 2;
        if (py >= top - stepUp) continue;
        let nx, nz, pen;
        if (ox < oz) { const sg = lx >= 0 ? 1 : -1; nx = col.c * sg; nz = -col.s * sg; pen = ox; }
        else { const sg = lz >= 0 ? 1 : -1; nx = col.s * sg; nz = col.c * sg; pen = oz; }
        out.px += nx * pen; out.pz += nz * pen;
        out.nx += nx; out.nz += nz;
        res = 1;
      }
      return res;
    },

    progressOn(col, px, pz) {
      if (col.d0 === NODIST) return -1;
      const dx = px - col.x, dz = pz - col.z;
      const lz = dx * col.s + dz * col.c;
      const t = Math.max(0, Math.min(1, (col.hz - lz) / (2 * col.hz)));
      return col.d0 + t * (col.d1 - col.d0);
    },

    touchFall(col, t) {
      if (col.fall && col.fall.t0 < 0) { col.fall.t0 = t; return true; }
      return false;
    },

    activateCheckpoint(col) {
      if (!col.gate || col.gate.active) return;
      col.gate.active = true;
      col.gate.flagMat.color.set('#2bd96b');
      col.gate.flagMat.emissive.set('#2bd96b');
      col.gate.flagMat.emissiveIntensity = 0.6;
    },

    // Restore crumbling tiles after a respawn.
    respawnReset() {
      for (const col of fallers) {
        col.fall.t0 = -1; col.active = true; col.y = col.by;
        writeMatrix(col);
      }
    },

    collectCoins(px, py, pz, cb) {
      for (let i = 0; i < coins.length; i++) {
        const c = coins[i];
        if (c.taken) continue;
        const dx = c.x - px, dz = c.z - pz, dy = c.y - (py + 1.0);
        if (dx * dx + dz * dz < 2.6 && dy * dy < 3.2) {
          c.taken = true;
          coinMesh.setMatrixAt(c.idx, ZERO_M);
          coinFree.push(c.idx);
          cb(c);
        }
      }
    },

    // Fly through a ring (center within ~1.4 m) for turbo.
    collectRings(px, py, pz, cb) {
      for (let i = 0; i < rings.length; i++) {
        const r = rings[i];
        if (r.taken) continue;
        const dx = r.x - px, dy = r.y - (py + 0.9), dz = r.z - pz;
        if (dx * dx + dy * dy + dz * dz < 2.4) {
          r.taken = true;
          ringMesh.setMatrixAt(r.idx, ZERO_M);
          ringFree.push(r.idx);
          cb(r);
        }
      }
    },

    pieceNames() { return [...Object.keys(P).filter((n) => n !== 'gap' && n !== 'checkpoint'), ...PACK.keys()]; },

    zoneIndexAt,

    // Per-frame visuals.
    flush(time, glow) {
      uniforms.uTime.value = time;
      uniforms.uGlow.value = glow;
      for (let i = 0; i < movers.length; i++) writeMatrix(movers[i]);
      for (let i = 0; i < fallers.length; i++) {
        const col = fallers[i];
        if (col.fall.t0 < 0) continue;
        const age = time - col.fall.t0;
        if (age < 0.8) {
          const a = 0.05 + age * 0.1;
          writeMatrix(col, Math.sin(time * 61) * a, 0, Math.cos(time * 53) * a);
        } else if (age < 3) writeMatrix(col);
      }
      const spin = time * 3.2;
      for (let i = 0; i < coins.length; i++) {
        const c = coins[i];
        if (c.taken) continue;
        _p.set(c.x, c.y + Math.sin(time * 3 + c.ph) * 0.15, c.z);
        _q.setFromAxisAngle(_up, spin + c.ph);
        _s.set(1, 1, 1);
        _m.compose(_p, _q, _s);
        coinMesh.setMatrixAt(c.idx, _m);
      }
      for (let i = 0; i < rings.length; i++) {
        const r = rings[i];
        if (r.taken) continue;
        const pulse = 1 + Math.sin(time * 5 + r.ph) * 0.06;
        _p.set(r.x, r.y, r.z);
        _q.setFromAxisAngle(_up, r.yaw);
        _s.set(pulse, pulse, pulse);
        _m.compose(_p, _q, _s);
        ringMesh.setMatrixAt(r.idx, _m);
      }
      if (ringHw) {
        const rim = ringMesh.instanceMatrix;
        rim.clearUpdateRanges();
        rim.addUpdateRange(0, ringHw * 16);
        rim.needsUpdate = true;
      }
      const cim = coinMesh.instanceMatrix;
      cim.clearUpdateRanges();
      cim.addUpdateRange(0, Math.max(1, coinHw) * 16);
      cim.needsUpdate = true;
      for (let i = 0; i < flags.length; i++) flags[i].rotation.y = Math.sin(time * 4 + i) * 0.25;
      statics.flush(); ramps.flush(); dyn.flush();
    },

    setShadows(on) {
      statics.mesh.castShadow = on; ramps.mesh.castShadow = on; dyn.mesh.castShadow = on; coinMesh.castShadow = on;
    },
  };
  return api;
}
