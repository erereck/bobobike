// js/vehicles.js — bobobike
// Toy-like blocky vehicles (BMX, electric scooter, kick scooter "patinete") ridden by a
// Roblox R6 avatar wearing a skin (config.js SKINS). Every rigid part is authored in one
// "vehicle space" (origin = ground contact point between the wheels, facing -Z, Y up), merged
// into a single vertex-coloured mesh per material, then re-expressed in the local space of the
// pivot that animates it. Skin colours live on materials (vertex colours only carry shading),
// so rig.setSkin() swaps colours / face / accessory / vehicle tint in place.
// Result: ~20 draw calls per rig, < 8k triangles, zero per-frame allocations.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { VEHICLE_STATS, SKIN_BY_ID } from './config.js';

const TAU = Math.PI * 2;
const PIVOT_H = 0.9;        // trick rotation pivot height (m)
const STEER_MAX = 0.4;      // handlebar yaw at steer = ±1 (rad)
const GRAVITY = 34;         // matches CONFIG.gravity (break-apart pieces)
const SPIN_STEP = 0.42;     // max wheel turn per frame, as a fraction of the rim pattern period (no strobing)
const BREAK_TIME = 3.2;     // seconds the debris is simulated before it is hidden
const DEBRIS_DRAG = 1.8;    // 1/s air drag on debris: inherited ~30 m/s carries ~15 m, not 55 m (stays in the death cam)
const WHEELIE_Z = 0.6;      // turbo-kick wheelie pivot (rear axle, local +Z)

// Palette (sRGB hex; THREE.Color converts to linear for vertex colours).
const C = {
  // (rider colours come from the skin, see config.js SKINS)
  dark: '#202027', rubber: '#26262d', steel: '#9ba4af', chrome: '#dfe4ea', glass: '#a9dcff',
  // BMX
  red: '#e8112d', redDark: '#a50b20', tireWhite: '#f4f3ee', tread: '#22222a', plate: '#ffd23f',
  // scooter
  mint: '#3fdcbc', mintDark: '#23a68c', cream: '#fff0d4', seat: '#5a3324', hub: '#f2efe6',
  // kick
  purple: '#8a3bff', purpleDark: '#5418c4', grip: '#1d1a2b', neon: '#22f2ff', core: '#f4f2ff',
};
const GLOW_COLOR = { bike: '#ff2236', scooter: '#ff2d6f', kick: '#22f2ff' };

// Roblox R6 proportions, 1 stud = 0.34 m: torso 2x2x1, arms/legs 1x2x1 (a hair thinner so the
// seams read), head a ~1.25 stud rounded "cylinder-ish" block. Rider space origin = centre
// between the hip joints.
const R6 = {
  torsoW: 0.68, torsoH: 0.68, torsoD: 0.34,
  limbW: 0.334, limbL: 0.68, limbD: 0.334,
  hipX: 0.17, shoulderX: 0.511, shoulderY: 0.51,
  armReach: 0.51,   // shoulder pivot -> hand end
  legReach: 0.68,   // hip pivot -> foot end
  torsoBevel: 0.045, limbBevel: 0.038,
};
// Head: superellipse cross-section (P=2 circle .. large = box), rounded top/bottom edges.
const HEAD = {
  A: 0.215, B: 0.215, H: 0.42, P: 2.6, RE: 0.085, // half width / half depth / height / exponent / edge radius
  SEG: 28, ARC: 4,     // radial segments, rows per rounded edge
  GAP: 0.034,          // neck gap above the torso
  FACE_K: 4,           // decal spans +-FACE_K radial segments around the front
};
const HEAD_CY = HEAD.GAP + HEAD.H / 2; // head centre above the neck node
const FACE_PX = 256;

// Module-level temporaries (never allocate in update()).
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _m0 = new THREE.Matrix4();
const _m1 = new THREE.Matrix4();
const _e0 = new THREE.Euler();
const _c0 = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

const DEFAULT_S = Object.freeze({
  speed: 0, steer: 0, throttle: 0, grounded: true, lean: 0, landImpact: 0,
  boosting: false, trickSpin: 0, trickFlip: 0,
});

function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
function V(x, y, z) { return new THREE.Vector3(x, y, z); }

// ---------------------------------------------------------------------------------------------
// Skins
// ---------------------------------------------------------------------------------------------

const FALLBACK_SKIN = Object.freeze({
  id: 'noob', name: 'Noob', unlock: 0, head: '#f5cd30', torso: '#0d69ac', arms: '#f5cd30', legs: '#a4bd47',
  face: 'smile', acc: 'none', accColor: '#000000',
});
function baseSkin() { return (SKIN_BY_ID && SKIN_BY_ID.noob) || FALLBACK_SKIN; }
/** Accepts a SKINS entry, a skin id, or nothing; always returns a complete skin object. */
function resolveSkin(s) {
  if (typeof s === 'string') s = SKIN_BY_ID ? SKIN_BY_ID[s] : null;
  const b = baseSkin();
  if (!s || typeof s !== 'object') return b;
  if (s.head && s.torso && s.arms && s.legs && s.face && s.acc) return s;
  return Object.assign({}, b, s);
}

// Vehicle "body" colours that a skin's `vehicle` tint replaces. The darker variants keep their
// relative luminance so the whole paint job re-tints coherently.
const BODY_TINT = { bike: ['#e8112d', '#a50b20'], scooter: ['#3fdcbc', '#23a68c'], kick: ['#8a3bff', '#5418c4'] };
let _tones = null; // Map(hex -> grey THREE.Color), only set while a vehicle builder runs
function lum(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
function makeTones(kind) {
  const list = BODY_TINT[kind];
  const main = new THREE.Color(list[0]);
  const m = new Map();
  for (const hex of list) {
    const r = clamp(lum(new THREE.Color(hex)) / Math.max(lum(main), 1e-4), 0, 1);
    m.set(hex, new THREE.Color(r, r, r));
  }
  return m;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers (build time only)
// ---------------------------------------------------------------------------------------------

/** Applies translate/rotate(XYZ Euler)/scale to a geometry, in place. Scale is applied first. */
function xform(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e0.set(rx, ry, rz);
  _q0.setFromEuler(_e0);
  _m0.compose(_v0.set(x, y, z), _q0, _v1.set(sx, sy, sz));
  return geo.applyMatrix4(_m0);
}
/** Cylinder of radius r spanning point a -> b. */
function tube(a, b, r, seg = 8) {
  _v2.subVectors(b, a);
  const len = _v2.length();
  _v2.divideScalar(len);
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
  _q1.setFromUnitVectors(UP, _v2);
  _m1.compose(_v3.addVectors(a, b).multiplyScalar(0.5), _q1, _v0.set(1, 1, 1));
  return g.applyMatrix4(_m1);
}
/** Cylinder whose axis is X (axles, hubs, discs). */
function axleCyl(r, w, x, y, z, seg = 12) {
  return xform(new THREE.CylinderGeometry(r, r, w, seg), x, y, z, 0, 0, Math.PI / 2);
}
/** Torus whose axis is X (tyres, rims). */
function ring(R, tube_, x, y, z, radial, tubular) {
  return xform(new THREE.TorusGeometry(R, tube_, radial, tubular), x, y, z, 0, Math.PI / 2, 0);
}
/** Torus whose axis is tilted back by `alpha` (rings around a steering column). */
function axisRing(p, R, tube_, alpha) {
  return xform(new THREE.TorusGeometry(R, tube_, 4, 18), p.x, p.y, p.z, alpha - Math.PI / 2);
}
function rbox(w, h, d, r, seg = 1) { return new RoundedBoxGeometry(w, h, d, seg, r); }
function box(w, h, d) { return new THREE.BoxGeometry(w, h, d); }
function ball(r, p, sx = 1, sy = 1, sz = 1, ws = 10, hs = 7) {
  return xform(new THREE.SphereGeometry(r, ws, hs), p.x, p.y, p.z, 0, 0, 0, sx, sy, sz);
}

/** Accumulates coloured geometries for one rigid part; baked into one mesh per material. */
class Part {
  /** tint: route the vehicle's body colours to the tintable 'body' material (off for wheels). */
  constructor(tint = true) { this.items = []; this.tint = tint; }
  /** shade > 0 darkens the lower part of this piece (cheap baked AO gradient). */
  add(geo, color, mat = 'paint', shade = 0) {
    if (mat === 'paint' && this.tint && _tones && typeof color === 'string') {
      const tone = _tones.get(color);
      if (tone) { color = tone; mat = 'body'; }
    }
    let g = geo;
    if (g.index) { g = geo.toNonIndexed(); geo.dispose(); }
    if (g.attributes.uv) g.deleteAttribute('uv');
    const pos = g.attributes.position;
    const n = pos.count;
    let minY = Infinity, maxY = -Infinity;
    if (shade > 0) {
      for (let i = 0; i < n; i++) { const y = pos.getY(i); if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    const span = maxY - minY;
    _c0.set(color);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const f = shade > 0 && span > 1e-5 ? 1 - shade * (1 - (pos.getY(i) - minY) / span) : 1;
      col[i * 3] = _c0.r * f; col[i * 3 + 1] = _c0.g * f; col[i * 3 + 2] = _c0.b * f;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.items.push({ g, mat });
    return this;
  }
}

/** Merges a Part into meshes parented to `pivot`; geometry was authored in `frame` space. */
function bake(part, pivot, frame, ctx) {
  frame.updateWorldMatrix(true, true);
  _m0.copy(frame.matrixWorld).invert().multiply(pivot.matrixWorld); // pivot -> frame
  _m1.copy(_m0).invert();                                           // frame -> pivot
  const byMat = new Map();
  for (const it of part.items) {
    let list = byMat.get(it.mat);
    if (!list) byMat.set(it.mat, (list = []));
    list.push(it.g);
  }
  for (const [key, list] of byMat) {
    const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (list.length > 1) for (const g of list) g.dispose();
    geo.applyMatrix4(_m1);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, ctx.mats[key]);
    mesh.castShadow = key !== 'glow' && key !== 'light'; // tiny emissive bits: skip the shadow-pass draw
    mesh.receiveShadow = key !== 'glow' && key !== 'light' && key !== 'neon';
    pivot.add(mesh);
    ctx.meshes.push(mesh);
  }
  part.items.length = 0;
}

/** Converts a point authored in `frame` space into `node` local space (build time). */
function toNodeSpace(p, node, frame) {
  frame.updateWorldMatrix(true, true);
  _m0.copy(frame.matrixWorld).invert().multiply(node.matrixWorld).invert();
  return p.clone().applyMatrix4(_m0);
}

function makeNode(parent, pos) {
  const n = new THREE.Group();
  if (pos) n.position.copy(pos);
  parent.add(n);
  return n;
}

// ---------------------------------------------------------------------------------------------
// Materials & the classic smile
// ---------------------------------------------------------------------------------------------

function makeCanvas(w, h) {
  let canvas = null;
  if (typeof document !== 'undefined' && document.createElement) canvas = document.createElement('canvas');
  else if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(w, h);
  if (!canvas) return null;
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d');
  return g ? { canvas, g } : null;
}

/** Superellipse ring point (head cross-section); t = 0 faces the front (-Z), +t turns toward +X. */
function sePoint(t, a, b, out) {
  const s = Math.sin(t), c = Math.cos(t), e = 2 / HEAD.P;
  out.x = a * Math.sign(s) * Math.pow(Math.abs(s), e);
  out.z = -b * Math.sign(c) * Math.pow(Math.abs(c), e);
  return out;
}
/** Signed arc length along the head's outer ring from the front to radial vertex k. */
function headArc(k) {
  const dt = TAU / HEAD.SEG, p = { x: 0, z: 0 }, q = { x: 0, z: 0 };
  let L = 0;
  const n = Math.abs(k), sg = Math.sign(k);
  for (let i = 0; i < n; i++) {
    sePoint(sg * i * dt, HEAD.A, HEAD.B, p); sePoint(sg * (i + 1) * dt, HEAD.A, HEAD.B, q);
    L += Math.hypot(q.x - p.x, q.z - p.z);
  }
  return sg * L;
}
// The face canvas spans the decal's arc (width) x the head height; FACE_SX keeps features round.
const FACE_ARC = 2 * headArc(HEAD.FACE_K);
const FACE_SX = HEAD.H / FACE_ARC;

const INK = '#16161b';
function ell(g, x, y, rx, ry) { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, TAU); g.fill(); }
function rrect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}
/** Picks a glow colour for the robot visor: the skin's accent if it is bright enough, else cyan. */
function glowHex(hex) {
  _c0.set(hex || '#000000');
  return lum(_c0) > 0.08 ? hex : '#00e5ff';
}

/**
 * Draws a face decal on a transparent 256 px canvas (the head colour shows through).
 * Coordinates: x 0..256 across the front arc (viewer's left -> right), y 0 = top of the head.
 */
function drawFace(g, face, accColor) {
  g.clearRect(0, 0, FACE_PX, FACE_PX);
  g.save();
  g.translate(FACE_PX / 2, 0); g.scale(FACE_SX, 1); g.translate(-FACE_PX / 2, 0);
  g.lineCap = 'round'; g.lineJoin = 'round';
  if (face === 'happy') {
    g.fillStyle = 'rgba(255, 96, 128, 0.33)';                       // blush
    ell(g, 70, 142, 17, 11); ell(g, 186, 142, 17, 11);
    g.fillStyle = INK; ell(g, 98, 100, 11, 19); ell(g, 158, 100, 11, 19);
    g.fillStyle = '#ffffff'; ell(g, 94, 91, 4.5, 5.5); ell(g, 154, 91, 4.5, 5.5);
    const grin = () => {                                               // open grin
      g.beginPath();
      g.moveTo(82, 136); g.quadraticCurveTo(128, 145, 174, 136);
      g.bezierCurveTo(168, 196, 88, 196, 82, 136); g.closePath();
    };
    grin(); g.fillStyle = '#3b1219'; g.fill();
    g.save(); g.clip();
    g.fillStyle = '#ff6f8c'; ell(g, 128, 186, 30, 17);                 // tongue
    g.fillStyle = '#ffffff'; g.fillRect(70, 128, 116, 14);              // teeth
    g.restore();
    grin(); g.strokeStyle = INK; g.lineWidth = 5; g.stroke();
  } else if (face === 'cool') {
    g.fillStyle = '#0f0f15';
    for (let i = 0; i < 2; i++) {                                      // aviator-ish shades
      const m = i ? -1 : 1, o = i ? FACE_PX : 0;
      g.beginPath();
      g.moveTo(o + m * 64, 86); g.lineTo(o + m * 124, 86); g.lineTo(o + m * 121, 106);
      g.quadraticCurveTo(o + m * 116, 129, o + m * 94, 129);
      g.quadraticCurveTo(o + m * 70, 129, o + m * 66, 106); g.closePath(); g.fill();
    }
    g.fillRect(58, 82, 140, 10);                                       // brow bar
    g.fillRect(118, 88, 20, 7);                                        // bridge
    g.fillStyle = 'rgba(255, 255, 255, 0.55)';                         // glints
    for (let i = 0; i < 2; i++) {
      const x = i ? 134 : 74;
      g.beginPath(); g.moveTo(x + 4, 93); g.lineTo(x + 16, 93); g.lineTo(x + 6, 118); g.lineTo(x, 114); g.closePath(); g.fill();
    }
    g.strokeStyle = INK; g.lineWidth = 9;                              // smirk
    g.beginPath(); g.moveTo(96, 160); g.quadraticCurveTo(138, 176, 166, 146); g.stroke();
  } else if (face === 'ninja') {
    g.beginPath();                                                     // eye slit, angry V on top
    g.moveTo(58, 96); g.lineTo(122, 110); g.lineTo(134, 110); g.lineTo(198, 96);
    g.quadraticCurveTo(210, 117, 198, 138); g.lineTo(58, 138);
    g.quadraticCurveTo(46, 117, 58, 96); g.closePath();
    g.fillStyle = '#e9b48a'; g.fill();
    const sh = g.createLinearGradient(0, 96, 0, 124);                  // mask shadow
    sh.addColorStop(0, 'rgba(0,0,0,0.35)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sh; g.fill();
    g.fillStyle = INK; ell(g, 101, 123, 9, 10); ell(g, 155, 123, 9, 10);
    g.fillStyle = '#ffffff'; ell(g, 98, 119, 3, 3.5); ell(g, 152, 119, 3, 3.5);
  } else if (face === 'robot') {
    const glow = glowHex(accColor);
    rrect(g, 42, 84, 172, 58, 26);                                     // visor
    g.fillStyle = '#0b141f'; g.fill();
    g.strokeStyle = '#353f4b'; g.lineWidth = 7; g.stroke();
    g.globalAlpha = 0.35; g.fillStyle = glow; g.fillRect(54, 111, 148, 3); g.globalAlpha = 1; // scan line
    g.fillStyle = glow;
    rrect(g, 82, 101, 34, 22, 9); g.fill(); rrect(g, 140, 101, 34, 22, 9); g.fill();
    g.fillStyle = 'rgba(255, 255, 255, 0.8)';
    rrect(g, 89, 107, 20, 8, 4); g.fill(); rrect(g, 147, 107, 20, 8, 4); g.fill();
    g.fillStyle = '#353f4b';                                           // mouth grille
    for (let i = 0; i < 5; i++) { rrect(g, 99 + i * 12, 158, 7, 22, 3.5); g.fill(); }
  } else { // 'smile': the classic
    g.fillStyle = INK; ell(g, 99, 104, 10, 19); ell(g, 157, 104, 10, 19);
    g.strokeStyle = INK; g.lineWidth = 9;
    g.beginPath(); g.arc(128, 114, 56, Math.PI * 0.2, Math.PI * 0.8); g.stroke();
  }
  g.restore();
}

/** Neutral studio gradient used as the reflection environment for metallic skins (shared). */
let _envTex = null;
function envTexture() {
  if (_envTex !== null) return _envTex || null;
  const cv = makeCanvas(128, 64);
  if (!cv) { _envTex = false; return null; }
  const g = cv.g;
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.4, '#dfe7f0'); grad.addColorStop(0.5, '#a3abb5');
  grad.addColorStop(0.56, '#5d6169'); grad.addColorStop(1, '#25272c');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 64);
  for (const [x, y, r] of [[34, 16, 14], [98, 22, 9]]) {               // soft key / fill lights
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const t = new THREE.CanvasTexture(cv.canvas);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  _envTex = t;
  return t;
}

/** Soft radial falloff used by the additive underglow decal. */
function makeGlowTexture() {
  let canvas = null;
  if (typeof document !== 'undefined') canvas = document.createElement('canvas');
  else if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(64, 64);
  if (!canvas) return null;
  canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d');
  if (!g) return null;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Skin-driven rider materials: colour lives on the material, vertex colours carry shading only.
const RIDER_MATS = ['rHead', 'rTorso', 'rArms', 'rLegs'];

function makeMaterials(kind) {
  const std = (p) => new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, roughness: 0.55, metalness: 0.05 }, p));
  const env = envTexture();
  const skinMat = () => std({ roughness: 0.5, metalness: 0.05, envMap: env, envMapIntensity: 0 });
  return {
    paint: std({ roughness: 0.5, metalness: 0.06 }),
    body: std({ roughness: 0.5, metalness: 0.06, color: new THREE.Color(BODY_TINT[kind][0]), envMap: env, envMapIntensity: 0 }),
    metal: std({ roughness: 0.24, metalness: 0.3 }),
    glow: std({ roughness: 0.4, emissive: new THREE.Color(GLOW_COLOR[kind]), emissiveIntensity: 1 }),
    neon: std({ roughness: 0.35, emissive: new THREE.Color(C.neon), emissiveIntensity: 1 }),
    light: std({ roughness: 0.25, emissive: new THREE.Color('#fff2c8'), emissiveIntensity: 2.4 }),
    rHead: skinMat(), rTorso: skinMat(), rArms: skinMat(), rLegs: skinMat(),
  };
}

function headRows() {
  const rows = [], h = HEAD.H / 2, re = HEAD.RE, n = HEAD.ARC;
  for (let j = 0; j <= n; j++) { const f = j / n * Math.PI / 2; rows.push({ y: -h + re - re * Math.cos(f), inset: re - re * Math.sin(f) }); }
  for (let j = 0; j <= n; j++) { const f = Math.PI / 2 + j / n * Math.PI / 2; rows.push({ y: h - re - re * Math.cos(f), inset: re - re * Math.sin(f) }); }
  return rows;
}

/**
 * Rounded "cylinder-ish" R6 head (superellipse lathe, centred on the origin) plus the face decal:
 * a copy of the head's front sector pushed out along the normals, UV-mapped by arc length.
 */
function makeHeadGeometries() {
  const rows = headRows(), N = HEAD.SEG, R = rows.length, dt = TAU / N, h = HEAD.H / 2;
  const pos = new Float32Array((R * N + 2) * 3);
  const col = new Float32Array((R * N + 2) * 3);
  const p = { x: 0, z: 0 };
  const shadeAt = (y) => 0.84 + 0.16 * (y + h) / HEAD.H; // a touch darker toward the chin
  for (let r = 0; r < R; r++) {
    for (let k = 0; k < N; k++) {
      sePoint(k * dt, HEAD.A - rows[r].inset, HEAD.B - rows[r].inset, p);
      const i = (r * N + k) * 3;
      pos[i] = p.x; pos[i + 1] = rows[r].y; pos[i + 2] = p.z;
      col[i] = col[i + 1] = col[i + 2] = shadeAt(rows[r].y);
    }
  }
  const bot = R * N, top = bot + 1;
  pos[bot * 3 + 1] = -h; pos[top * 3 + 1] = h;
  col.fill(shadeAt(-h), bot * 3, bot * 3 + 3); col.fill(1, top * 3, top * 3 + 3);
  const idx = [];
  for (let r = 0; r < R - 1; r++) {
    for (let k = 0; k < N; k++) {
      const k1 = (k + 1) % N;
      const a = r * N + k, b = r * N + k1, c = a + N, d = b + N;
      idx.push(a, c, d, a, d, b);
    }
  }
  for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N;
    idx.push(bot, k, k1);
    idx.push(top, (R - 1) * N + k1, (R - 1) * N + k);
  }
  const head = new THREE.BufferGeometry();
  head.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  head.setAttribute('color', new THREE.BufferAttribute(col, 3));
  head.setIndex(idx);
  head.computeVertexNormals();

  // Face decal (front sector only, all rows of the rounded side).
  const K = HEAD.FACE_K, W = 2 * K + 1, nrm = head.attributes.normal.array, OFF = 0.0022;
  const dp = new Float32Array(R * W * 3), dn = new Float32Array(R * W * 3), duv = new Float32Array(R * W * 2);
  for (let r = 0; r < R; r++) {
    for (let j = 0; j < W; j++) {
      const k = j - K, src = (r * N + ((k + N) % N)) * 3, o = (r * W + j) * 3;
      for (let e = 0; e < 3; e++) { dn[o + e] = nrm[src + e]; dp[o + e] = pos[src + e] + nrm[src + e] * OFF; }
      duv[(r * W + j) * 2] = 0.5 - headArc(k) / FACE_ARC;
      duv[(r * W + j) * 2 + 1] = 0.5 + rows[r].y / HEAD.H;
    }
  }
  const didx = [];
  for (let r = 0; r < R - 1; r++) {
    for (let j = 0; j < W - 1; j++) {
      const a = r * W + j, b = a + 1, c = a + W, d = b + W;
      didx.push(a, c, d, a, d, b);
    }
  }
  const decal = new THREE.BufferGeometry();
  decal.setAttribute('position', new THREE.BufferAttribute(dp, 3));
  decal.setAttribute('normal', new THREE.BufferAttribute(dn, 3));
  decal.setAttribute('uv', new THREE.BufferAttribute(duv, 2));
  decal.setIndex(didx);
  return { head, decal };
}

// ---------------------------------------------------------------------------------------------
// Rider (R6 noob)
// ---------------------------------------------------------------------------------------------

function buildRider(ctx, hip) {
  const root = makeNode(ctx.body, hip);
  const torso = makeNode(root);
  const neck = makeNode(torso, V(0, R6.torsoH, 0));
  const armL = makeNode(torso, V(-R6.shoulderX, R6.shoulderY, 0));
  const armR = makeNode(torso, V(R6.shoulderX, R6.shoulderY, 0));
  const legL = makeNode(root, V(-R6.hipX, 0, 0));
  const legR = makeNode(root, V(R6.hipX, 0, 0));

  // White vertex colours = shading only; the skin colour comes from the material.
  const W = '#ffffff';
  const limb = () => rbox(R6.limbW, R6.limbL, R6.limbD, R6.limbBevel, 1);
  bake(new Part(false).add(xform(rbox(R6.torsoW, R6.torsoH, R6.torsoD, R6.torsoBevel, 2), 0, R6.torsoH / 2, 0), W, 'rTorso', 0.2), torso, root, ctx);
  const armY = R6.torsoH - R6.limbL / 2; // arm top flush with the shoulders
  bake(new Part(false).add(xform(limb(), -R6.shoulderX, armY, 0), W, 'rArms', 0.12), armL, root, ctx);
  bake(new Part(false).add(xform(limb(), R6.shoulderX, armY, 0), W, 'rArms', 0.12), armR, root, ctx);
  bake(new Part(false).add(xform(limb(), -R6.hipX, -R6.limbL / 2, 0), W, 'rLegs', 0.16), legL, root, ctx);
  bake(new Part(false).add(xform(limb(), R6.hipX, -R6.limbL / 2, 0), W, 'rLegs', 0.16), legR, root, ctx);

  // Head (neck gap above the torso); the face decal and accessory are children of this mesh,
  // so they tumble with it when the rig breaks apart.
  const hg = makeHeadGeometries();
  hg.head.translate(0, HEAD_CY, 0);
  hg.decal.translate(0, HEAD_CY, 0);
  hg.head.computeBoundingBox();
  hg.head.computeBoundingSphere();
  hg.decal.computeBoundingSphere();
  const head = new THREE.Mesh(hg.head, ctx.mats.rHead);
  head.castShadow = true;
  head.receiveShadow = true;
  neck.add(head);
  ctx.meshes.push(head);

  return { root, torso, neck, armL, armR, legL, legR, head, decalGeo: hg.decal };
}

// ---------------------------------------------------------------------------------------------
// Accessories (authored around the head centre, then lifted by HEAD_CY into head-mesh space)
// ---------------------------------------------------------------------------------------------

const ACC_LOOK = {
  none: { metal: 0, rough: 0.6, env: 0, glow: 1 },
  bacon: { metal: 0, rough: 0.72, env: 0, glow: 1 },
  long: { metal: 0, rough: 0.66, env: 0, glow: 1.35 },
  cap: { metal: 0.02, rough: 0.58, env: 0, glow: 1 },
  bandana: { metal: 0, rough: 0.7, env: 0, glow: 1 },
  antenna: { metal: 0.55, rough: 0.3, env: 0.9, glow: 1.8 },
  crown: { metal: 0.88, rough: 0.24, env: 1.2, glow: 1.6 },
};

/** Head-surface inset at height y (0 on the straight side, growing over the rounded edges). */
function headInset(y) {
  const d = Math.abs(y) - (HEAD.H / 2 - HEAD.RE);
  return d > 0 ? HEAD.RE - Math.sqrt(Math.max(HEAD.RE * HEAD.RE - d * d, 0)) : 0;
}

/** Smooth 0..1 ramp of |t| (t wrapped to -PI..PI) between angles a and b (radians). */
function angRamp(t, a, b) {
  let u = Math.abs(Math.atan2(Math.sin(t), Math.cos(t)));
  u = clamp((u - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
}

/**
 * A sheet that hugs the head: sector t0..t1 (radians from the front, toward +X), heights y0..y1
 * (head space, unscaled), scaled by (s, sy, s) about the head centre. cap closes the top.
 * y0 may be a function of t (a hairline); `straight` keeps the sheet vertical below the head
 * centre (hair curtains) instead of following the rounded chin.
 */
function headShell(t0, t1, y0, y1, s, sy, cap, straight = false) {
  const full = t1 - t0 >= TAU - 1e-6;
  const nseg = Math.max(2, Math.round((t1 - t0) / TAU * HEAD.SEG));
  const cols = full ? nseg : nseg + 1;
  const bottom = typeof y0 === 'function' ? y0 : () => y0;
  let ymin = Infinity;
  for (let j = 0; j < cols; j++) ymin = Math.min(ymin, bottom(t0 + (t1 - t0) * j / nseg));
  const ys = [ymin];
  const rows = headRows();
  for (const r of rows) if (r.y > ymin + 0.004 && r.y < y1 - 0.004) ys.push(r.y);
  ys.push(y1);
  const pos = [], idx = [], p = { x: 0, z: 0 };
  for (const yr of ys) {
    for (let j = 0; j < cols; j++) {
      const t = t0 + (t1 - t0) * j / nseg;
      const y = Math.max(yr, bottom(t)); // rows under the hairline collapse onto it
      const ins = straight && y < 0 ? 0 : headInset(y);
      sePoint(t, HEAD.A - ins, HEAD.B - ins, p);
      pos.push(p.x * s, y * sy, p.z * s);
    }
  }
  for (let r = 0; r < ys.length - 1; r++) {
    for (let j = 0; j < nseg; j++) {
      const j1 = full ? (j + 1) % cols : j + 1;
      const a = r * cols + j, b = r * cols + j1, c = a + cols, d = b + cols;
      idx.push(a, c, d, a, d, b);
    }
  }
  if (cap) {
    const ctr = pos.length / 3, last = (ys.length - 1) * cols;
    pos.push(0, ys[ys.length - 1] * sy, 0);
    for (let j = 0; j < nseg; j++) idx.push(ctr, last + (full ? (j + 1) % cols : j + 1), last + j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Height of the (scaled) top of the head at (x, z), for laying strands over it. */
function headTopY(x, z, s) {
  const p = HEAD.P;
  const rho = Math.pow(Math.pow(Math.abs(x / (HEAD.A * s)), p) + Math.pow(Math.abs(z / (HEAD.B * s)), p), 1 / p) * HEAD.A;
  const h = HEAD.H / 2, d = rho - (HEAD.A - HEAD.RE);
  if (d <= 0) return h * s;
  return (h - HEAD.RE + Math.sqrt(Math.max(HEAD.RE * HEAD.RE - d * d, 0))) * s;
}

/**
 * Soft flat ribbon (w wide, th thick) swept along a polyline whose width stays near-horizontal
 * (X). Corners share vertices, so smooth normals round it off like a hair strand. taper: end width.
 */
function strip(pts, w, th, taper = 1) {
  const n = pts.length, pos = [], idx = [];
  const tan = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3();
  const CS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < n; i++) {
    tan.subVectors(pts[Math.min(i + 1, n - 1)], pts[Math.max(i - 1, 0)]).normalize();
    up.crossVectors(tan, side.set(1, 0, 0)).normalize();
    side.crossVectors(up, tan).normalize();
    const hw = w * 0.5 * (1 + (taper - 1) * i / (n - 1)), ht = th * 0.5, p = pts[i];
    for (const [a, b] of CS) pos.push(p.x + side.x * a * hw + up.x * b * ht, p.y + side.y * a * hw + up.y * b * ht, p.z + side.z * a * hw + up.z * b * ht);
  }
  for (let i = 0; i < n - 1; i++) {
    for (let c = 0; c < 4; c++) {
      const c1 = (c + 1) % 4, A = i * 4 + c, B = i * 4 + c1, C = B + 4, D = A + 4;
      idx.push(A, B, C, A, C, D);
    }
  }
  const e = (n - 1) * 4;
  idx.push(0, 2, 1, 0, 3, 2, e, e + 1, e + 2, e, e + 2, e + 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function starGeometry(r0, r1, depth) {
  const sh = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? r1 : r0;
    if (i) sh.lineTo(Math.cos(a) * r, Math.sin(a) * r); else sh.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -depth / 2);
  return g;
}

/**
 * Accessory geometry for skin.acc, in head-mesh space. `main` uses the accessory material
 * (vertex colours, per-type metal look), `glow` the unlit HDR material (bulbs, gems, pearls).
 */
function buildAccessory(id, hex) {
  const m = new Part(false), gl = new Part(false);
  const h = HEAD.H / 2, A = HEAD.A, B = HEAD.B, deg = Math.PI / 180;
  const base = new THREE.Color(hex);
  const light = base.clone().offsetHSL(0, 0.04, 0.11);
  const dark = base.clone().multiplyScalar(0.6);
  let post = null;
  if (id === 'bacon') {
    // Short hair with a hairline that drops to the nape + wavy two-tone "bacon" strips running
    // front -> back whose front ends flip up (the classic look).
    const hairline = (t) => 0.105 - 0.18 * angRamp(t, 45 * deg, 150 * deg);
    m.add(headShell(0, TAU, hairline, h, 1.07, 1.07, true), base.clone().multiplyScalar(0.78), 'x', 0.15);
    const xs = [-0.13, -0.065, 0, 0.065, 0.13], n = 8;
    for (let i = 0; i < xs.length; i++) {
      const pts = [];
      const flip = Math.abs(xs[i]) < 0.1;
      const x0 = xs[i], yf = headTopY(x0, -0.18, 1.07);
      if (flip) pts.push(V(x0 + 0.01, yf + 0.07, -0.205), V(x0 + 0.005, yf + 0.045, -0.236));
      for (let j = 0; j <= n; j++) {
        const z = -0.19 + 0.385 * j / n;
        const x = x0 * (1 - 0.1 * Math.abs(z) / 0.2) + Math.sin(j * 1.3 + i) * 0.005;
        pts.push(V(x, headTopY(x, z, 1.07) + 0.008 + Math.sin(j * 2.3 + i * 1.9) * 0.01, z));
      }
      m.add(strip(pts, 0.064, 0.024, 0.8), i % 2 ? light : base);
    }
  } else if (id === 'long') {
    // One curtain of hair: framing the face, dropping straight to the shoulders with a soft
    // scalloped edge; puffy bangs and a star clip.
    const hairline = (t) => {
      const f = angRamp(t, 46 * deg, 84 * deg);
      return 0.115 + (-0.29 + 0.028 * Math.cos(t * 7) - 0.115) * f;
    };
    m.add(headShell(0, TAU, hairline, h, 1.07, 1.07, true, true), base, 'x', 0.22);
    for (let i = -1; i <= 1; i++) {
      // side-swept bangs: tapered strands from the crown over the brow
      const front = (x, y) => {
        const ins = headInset(y / 1.07), a = A - ins, b = B - ins;
        return -b * Math.pow(Math.max(1 - Math.pow(Math.min(Math.abs(x) / a, 1), HEAD.P), 0), 1 / HEAD.P) * 1.07 - 0.007;
      };
      for (let k = 0; k < 2; k++) {
        const x0 = i * 0.075 + (k ? 0.037 : 0) - 0.02;
        if (k && i === 1) continue;
        const pts = [V(x0, headTopY(x0, -0.05, 1.07) + 0.006, -0.05), V(x0 + 0.01, headTopY(x0, -0.15, 1.07) + 0.009, -0.15)];
        for (const [y, dx] of [[0.17, 0.022], [0.112, 0.036]]) pts.push(V(x0 + dx, y, front(x0 + dx, y)));
        m.add(strip(pts, 0.072, 0.024, 0.4), (i + k) % 2 ? light : base);
      }
    }
    gl.add(xform(starGeometry(0.048, 0.021, 0.016), A * 1.07 + 0.008, 0.15, -0.045, 0.2, Math.PI / 2, 0.25), new THREE.Color('#ffe45c'));
  } else if (id === 'cap') {
    // Baseball cap: domed crown, curved brim pulled low, top button, little front badge.
    m.add(headShell(0, TAU, 0.088, h, 1.078, 1.13, true), base, 'x', 0.12);
    m.add(xform(new THREE.CylinderGeometry(0.17, 0.17, 0.022, 18, 1, false, Math.PI / 2, Math.PI), 0, 0.1, -B * 0.93, -0.17, 0, 0, 1.24, 1, 1), base, 'x', 0.45);
    m.add(ball(0.024, V(0, h * 1.13 + 0.003, 0), 1, 0.5, 1, 10, 5), base);
    const yb = 0.17, zb = -(B - headInset(yb / 1.13)) * 1.078 - 0.003;
    m.add(xform(new THREE.CylinderGeometry(0.027, 0.027, 0.006, 14), 0, yb, zb, Math.PI / 2 + 0.3), new THREE.Color('#f2f2f2'));
  } else if (id === 'bandana') {
    // Forehead band + knot at the back with two ribbon tails.
    m.add(headShell(0, TAU, 0.08, 0.165, 1.055, 1, false), base, 'x', 0.15);
    const kz = B * 1.055 + 0.018;
    m.add(ball(0.04, V(0, 0.122, kz), 1.35, 1, 0.8, 10, 7), dark);
    for (let s = -1; s <= 1; s += 2) {
      const pts = [V(s * 0.014, 0.118, kz + 0.005), V(s * 0.04, 0.07, kz + 0.06), V(s * 0.07, 0.0, kz + 0.09), V(s * 0.1, -0.05, kz + 0.1)];
      m.add(strip(pts, 0.058, 0.016, 0.75), s > 0 ? base : dark);
    }
  } else if (id === 'antenna') {
    // Robot antenna with a glowing bulb + little ear bolts that blink with the same colour.
    const gray = new THREE.Color('#8e99a5'), steel = new THREE.Color('#ccd4dd');
    m.add(xform(new THREE.CylinderGeometry(0.05, 0.064, 0.036, 14), 0, h + 0.008, 0), gray, 'x', 0.25);
    m.add(xform(new THREE.CylinderGeometry(0.011, 0.014, 0.2, 7), 0, h + 0.12, 0), steel);
    m.add(xform(new THREE.TorusGeometry(0.022, 0.008, 5, 12), 0, h + 0.09, 0, Math.PI / 2), gray);
    gl.add(ball(0.044, V(0, h + 0.24, 0), 1, 1, 1, 14, 10), base);
    for (let s = -1; s <= 1; s += 2) {
      m.add(axleCyl(0.052, 0.034, s * (A + 0.012), 0.0, 0.01, 14), gray, 'x', 0.2);
      gl.add(axleCyl(0.024, 0.012, s * (A + 0.033), 0.0, 0.01, 10), base);
    }
  } else if (id === 'crown') {
    // Gold crown: faceted band, five points with pearls (accColor), coloured gems; jaunty tilt.
    const gold = new THREE.Color('#ffc23a'), y0 = h - 0.022;
    const prof = [[0.147, 0], [0.171, 0], [0.174, 0.082], [0.152, 0.082], [0.147, 0]].map(([x, y]) => new THREE.Vector2(x, y));
    m.add(xform(new THREE.LatheGeometry(prof, 10), 0, y0, 0, 0, Math.PI / 10), gold, 'x', 0.3);
    const gems = ['#ff2f5b', '#2f7bff', '#2fe07f', '#2f7bff', '#2fe07f'];
    for (let i = 0; i < 5; i++) {
      const t = i * TAU / 5, sx = Math.sin(t), cz = -Math.cos(t);
      m.add(xform(new THREE.ConeGeometry(0.042, 0.1, 4), sx * 0.161, y0 + 0.13, cz * 0.161, 0, -t + Math.PI / 4), gold, 'x', 0.15);
      gl.add(ball(0.021, V(sx * 0.161, y0 + 0.19, cz * 0.161), 1, 1, 1, 8, 6), base);
      gl.add(xform(new THREE.OctahedronGeometry(0.025), sx * 0.177, y0 + 0.041, cz * 0.177, 0, -t, 0, 1, 1.25, 0.5), new THREE.Color(gems[i]));
    }
    post = new THREE.Matrix4().makeRotationZ(-0.09);
  }
  return { main: mergePart(m, post), glow: mergePart(gl, post) };
}

/** Merges a Part's items into one geometry (or null), lifted into head-mesh space. */
function mergePart(part, post) {
  if (!part.items.length) return null;
  const list = part.items.map((it) => it.g);
  const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
  if (list.length > 1) for (const g of list) g.dispose();
  part.items.length = 0;
  if (post) geo.applyMatrix4(post);
  geo.translate(0, HEAD_CY, 0);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** Points a limb pivot (rest direction -Y) along unit dir (nx,ny,nz) in its parent space; sy stretches it. */
function aimDir(node, nx, ny, nz, sy) {
  node.rotation.set(Math.atan2(-nz, -ny), 0, Math.asin(clamp(nx, -1, 1)));
  const bulge = sy < 1 ? 1 + (1 - sy) * 0.35 : 1 - (sy - 1) * 0.2; // cartoon volume preservation
  node.scale.set(bulge, sy, bulge);
}
function aimAt(node, dx, dy, dz, reach, smin, smax) {
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
  aimDir(node, dx / len, dy / len, dz / len, clamp(len / reach, smin, smax));
}
/** Aims a leg so its foot reaches target (tx,ty,tz) given in vehicle space. Rider root is never rotated. */
function aimLeg(rider, leg, side, tx, ty, tz, smin, smax) {
  const r = rider.root.position;
  aimAt(leg, tx - r.x - side * R6.hipX, ty - r.y, tz - r.z, R6.legReach, smin, smax);
}

// ---------------------------------------------------------------------------------------------
// Vehicles. Each builder returns:
// { radius, spinPeriod (rim pattern symmetry, rad), hip (rider hip centre), lean0 (torso lean),
//   steerBase, steer, wheelF, wheelB, grips:[L,R] (steer-local), underglow? {color,w,l},
//   prepare(st) (per-vehicle anim + glow), legs(st, rider) (leg IK), reset() }
// ---------------------------------------------------------------------------------------------

function bikeWheel(part, c) {
  part.add(ring(0.27, 0.09, c.x, c.y, c.z, 8, 22), C.tireWhite);        // fat white tyre
  part.add(ring(0.316, 0.05, c.x, c.y, c.z, 5, 22), C.tread);           // dark tread ring
  part.add(ring(0.232, 0.02, c.x, c.y, c.z, 4, 18), C.chrome);          // rim
  for (let k = 0; k < 4; k++) {
    part.add(xform(box(0.018, 0.46, 0.018), (k % 2 ? 0.02 : -0.02), c.y, c.z, k * Math.PI / 4), C.steel);
  }
  part.add(axleCyl(0.046, 0.15, c.x, c.y, c.z, 10), C.red);             // candy hub
}

function buildBike(ctx) {
  const { body, mats } = ctx;
  const R = 0.36, HALF = 0.6, ALPHA = 0.32, CRANK = 0.15;
  const FA = V(0, R, -HALF), RA = V(0, R, HALF), BB = V(0, 0.36, 0.08);
  const up = V(0, Math.cos(ALPHA), Math.sin(ALPHA));
  const at = (t) => FA.clone().addScaledVector(up, t); // point on the steering axis

  const steerBase = makeNode(body, FA); steerBase.rotation.x = ALPHA;
  const steer = makeNode(steerBase);
  const wheelF = makeNode(steer);
  const wheelB = makeNode(body, RA);
  const crank = makeNode(body, BB);

  // Frame (candy red, chrome bits, glowing tail reflector)
  const fp = new Part();
  const red = C.red;
  const ST = V(0, 0.82, 0.235);
  fp.add(tube(at(0.4), at(0.65), 0.06, 12), red, 'paint', 0.15);                         // head tube
  fp.add(tube(V(0, 0.93, -0.41), ST, 0.05, 10), red);                                    // top tube
  fp.add(tube(V(0, 0.78, -0.46), BB, 0.058, 10), red);                                   // down tube
  fp.add(tube(BB, V(0, 0.86, 0.255), 0.05, 10), red);                                    // seat tube
  fp.add(ball(0.058, ST), red);
  fp.add(axleCyl(0.064, 0.14, 0, BB.y, BB.z, 14), red);                                  // BB shell
  for (let i = 0; i < 2; i++) {
    const sx = i ? 1 : -1;
    fp.add(tube(V(sx * 0.04, BB.y, BB.z + 0.02), V(sx * 0.1, R, HALF), 0.03, 8), red);              // chainstay
    fp.add(tube(V(sx * 0.035, 0.8, 0.24), V(sx * 0.1, R + 0.025, HALF - 0.02), 0.026, 8), red);     // seatstay
    fp.add(xform(box(0.026, 0.09, 0.11), sx * 0.1, R, HALF), C.redDark);                            // dropout
    fp.add(axleCyl(0.04, 0.12, sx * 0.2, R, HALF, 10), C.chrome, 'metal');                          // pegs
  }
  fp.add(axleCyl(0.016, 0.3, 0, R, HALF, 6), C.steel, 'metal');
  fp.add(tube(V(0, 0.84, 0.25), V(0, 0.88, 0.265), 0.025, 8), C.chrome, 'metal');                // seat post
  fp.add(xform(rbox(0.2, 0.085, 0.36, 0.04, 2), 0, 0.905, 0.29, 0.06), C.dark, 'paint', 0.3);      // seat
  fp.add(xform(rbox(0.1, 0.05, 0.03, 0.012, 1), 0, 0.87, 0.475), C.red, 'glow');                   // tail reflector
  fp.add(tube(V(0.125, BB.y + 0.095, BB.z), V(0.125, R + 0.05, HALF), 0.009, 4), C.dark);         // chain
  fp.add(tube(V(0.125, BB.y - 0.095, BB.z), V(0.125, R - 0.05, HALF), 0.009, 4), C.dark);
  fp.add(axleCyl(0.052, 0.016, 0.125, R, HALF, 12), C.steel, 'metal');                             // rear cog
  bake(fp, body, body, ctx);

  // Steering assembly: fork, stem, BMX bars, grips, race plate
  const sp = new Part();
  const crown = at(0.4);
  const S0 = at(0.72);
  for (let i = 0; i < 2; i++) {
    const sx = i ? 1 : -1;
    sp.add(tube(V(sx * 0.105, crown.y, crown.z), V(sx * 0.105, R, -HALF), 0.028, 8), red);          // fork legs
    sp.add(axleCyl(0.04, 0.12, sx * 0.2, R, -HALF, 10), C.chrome, 'metal');                         // front pegs
    sp.add(tube(V(sx * 0.075, S0.y, S0.z + 0.01), V(sx * 0.22, 1.21, -0.33), 0.022, 8), C.chrome, 'metal'); // risers
    sp.add(tube(V(sx * 0.22, 1.21, -0.33), V(sx * 0.32, 1.21, -0.32), 0.022, 8), C.chrome, 'metal');
    sp.add(tube(V(sx * 0.3, 1.21, -0.32), V(sx * 0.48, 1.21, -0.31), 0.038, 10), C.dark);             // grips
    sp.add(ball(0.042, V(sx * 0.483, 1.21, -0.31)), C.red);                                           // bar-end caps
  }
  sp.add(xform(rbox(0.27, 0.06, 0.08, 0.02, 1), crown.x, crown.y, crown.z, ALPHA), red);           // fork crown
  sp.add(axleCyl(0.016, 0.3, 0, R, -HALF, 6), C.steel, 'metal');
  sp.add(tube(at(0.65), at(0.71), 0.034, 10), C.chrome, 'metal');                                 // steerer
  sp.add(xform(rbox(0.11, 0.075, 0.14, 0.02, 1), S0.x, S0.y, S0.z, ALPHA), C.steel, 'metal');      // stem
  sp.add(tube(V(-0.16, 1.13, -0.35), V(0.16, 1.13, -0.35), 0.018, 8), C.chrome, 'metal');          // crossbar
  // Race number plate with a blocky "1" on its front
  const P = V(0, 1.1, -0.45);
  const n = V(0, Math.sin(ALPHA), -Math.cos(ALPHA)).multiplyScalar(0.017); // plate front offset
  sp.add(xform(rbox(0.32, 0.24, 0.024, 0.035, 1), P.x, P.y, P.z, ALPHA), C.plate);
  const glyph = (w, h, dx, dy, rz) => xform(box(w, h, 0.012), P.x + dx, P.y + n.y + up.y * dy, P.z + n.z + up.z * dy, ALPHA, 0, rz);
  sp.add(glyph(0.045, 0.15, 0, 0, 0), C.dark);
  sp.add(glyph(0.055, 0.034, 0.03, 0.055, -0.65), C.dark);
  sp.add(glyph(0.11, 0.032, 0, -0.065, 0), C.dark);
  bake(sp, steer, body, ctx);

  const wf = new Part(false); bikeWheel(wf, FA); bake(wf, wheelF, body, ctx);
  const wb = new Part(false); bikeWheel(wb, RA); bake(wb, wheelB, body, ctx);

  // Crank set (rotates about the BB): chainring + spider, crank arms, pedals
  const cp = new Part();
  cp.add(ring(0.095, 0.016, 0.125, BB.y, BB.z, 4, 20), C.chrome);
  for (let k = 0; k < 4; k++) cp.add(xform(box(0.012, 0.19, 0.026), 0.125, BB.y, BB.z, k * Math.PI / 4), C.steel);
  cp.add(axleCyl(0.022, 0.3, 0, BB.y, BB.z, 8), C.steel);
  cp.add(xform(box(0.03, 0.045, CRANK + 0.035), 0.155, BB.y, BB.z - CRANK / 2), C.chrome);  // right arm (forward at rest)
  cp.add(xform(box(0.03, 0.045, CRANK + 0.035), -0.155, BB.y, BB.z + CRANK / 2), C.chrome); // left arm (back)
  cp.add(xform(rbox(0.12, 0.035, 0.095, 0.012, 1), 0.23, BB.y, BB.z - CRANK), C.dark);
  cp.add(xform(rbox(0.12, 0.035, 0.095, 0.012, 1), -0.23, BB.y, BB.z + CRANK), C.dark);
  bake(cp, crank, body, ctx);

  const grips = [toNodeSpace(V(-0.39, 1.21, -0.315), steer, body), toNodeSpace(V(0.39, 1.21, -0.315), steer, body)];

  let crankAng = 0, crankVel = 0;
  return {
    radius: R, spinPeriod: Math.PI / 4, hip: V(0, 0.95, 0.3), lean0: 0.42,
    steerBase, steer, wheelF, wheelB, grips,
    prepare(st) {
      // Pedal while throttling on the ground; freewheel / tuck holds the pedals level.
      const pedaling = st.grounded && st.throttle > 0.05 && st.tuck < 0.5 && st.speed > 0.2;
      const target = pedaling ? clamp(st.speed / R / 2.6, 3, 12) * Math.min(1, 0.4 + st.throttle) : 0;
      crankVel += (target - crankVel) * (1 - Math.exp(-st.dt * 5));
      crankAng += crankVel * st.dt;
      if (crankVel < 1) {
        const level = Math.round(crankAng / Math.PI) * Math.PI;
        crankAng += (level - crankAng) * (1 - Math.exp(-st.dt * 4));
      }
      if (crankAng > TAU) crankAng -= TAU;
      crank.rotation.x = -crankAng;
      st.sway = Math.sin(crankAng) * 0.06 * clamp(crankVel / 12, 0, 1);
      mats.glow.emissiveIntensity = 0.8 + st.tuck * (2.6 + 0.9 * Math.sin(st.t * 37) + 0.5 * Math.sin(st.t * 83));
    },
    legs(st, rider) {
      for (let i = 0; i < 2; i++) {
        const side = i ? 1 : -1;
        const c = crankAng + (i ? 0 : Math.PI);
        let tx = side * 0.21, ty = BB.y - CRANK * Math.sin(c) + 0.035, tz = BB.z - CRANK * Math.cos(c);
        if (i && st.trick > 0.001) { // trick pose: one-footer
          const w = st.trick * 0.85;
          tx += (0.62 - tx) * w; ty += (0.62 - ty) * w; tz += (0.4 - tz) * w;
        }
        aimLeg(rider, i ? rider.legR : rider.legL, side, tx, ty, tz, 0.74, 1.14);
      }
    },
    reset() { crankAng = 0; crankVel = 0; },
  };
}

function scooterWheel(part, c) {
  part.add(ring(0.15, 0.07, c.x, c.y, c.z, 8, 16), C.rubber);
  for (let i = 0; i < 2; i++) part.add(ring(0.15, 0.011, c.x + (i ? 0.064 : -0.064), c.y, c.z, 4, 14), C.cream); // whitewalls
  part.add(axleCyl(0.105, 0.12, c.x, c.y, c.z, 12), C.hub);
  part.add(axleCyl(0.045, 0.135, c.x, c.y, c.z, 10), C.mint);
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + Math.PI / 4;
    for (let i = 0; i < 2; i++) {
      part.add(xform(box(0.012, 0.03, 0.03), c.x + (i ? 0.062 : -0.062), c.y + Math.sin(a) * 0.075, c.z + Math.cos(a) * 0.075), C.dark);
    }
  }
}

function buildScooter(ctx) {
  const { body, mats } = ctx;
  const R = 0.22, HALF = 0.6;
  const FA = V(0, R, -HALF), RA = V(0, R, HALF);
  const H = V(0, 1.06, -0.36);                        // handlebar cover centre
  const ALPHA = Math.atan2(H.z - FA.z, H.y - FA.y);   // steering axis through front axle & headset
  const up = V(0, Math.cos(ALPHA), Math.sin(ALPHA));
  const at = (t) => FA.clone().addScaledVector(up, t);

  const steerBase = makeNode(body, FA); steerBase.rotation.x = ALPHA;
  const steer = makeNode(steerBase);
  const wheelF = makeNode(steer);
  const wheelB = makeNode(body, RA);

  // Body: Vespa-ish cowl, seat, floorboard, leg shield, chrome rack, glow strips
  const bp = new Part();
  bp.add(xform(new THREE.SphereGeometry(1, 16, 12), 0, 0.5, 0.4, 0, 0, 0, 0.31, 0.25, 0.47), C.mint, 'paint', 0.32);
  bp.add(xform(rbox(0.27, 0.17, 0.3, 0.04, 1), 0, 0.7, 0.17), C.mint, 'paint', 0.2);        // seat pedestal
  bp.add(xform(rbox(0.34, 0.12, 0.52, 0.05, 1), 0, 0.845, 0.3), C.seat, 'paint', 0.25);     // seat
  bp.add(xform(box(0.344, 0.02, 0.5), 0, 0.792, 0.3), C.cream);                            // seat piping
  bp.add(xform(rbox(0.36, 0.08, 0.6, 0.03, 1), 0, 0.3, -0.08), C.mintDark, 'paint', 0.25);  // floorboard
  for (let i = 0; i < 4; i++) bp.add(xform(box(0.03, 0.012, 0.44), -0.12 + i * 0.08, 0.343, -0.1), C.rubber);
  bp.add(xform(rbox(0.52, 0.64, 0.07, 0.035, 1), 0, 0.64, -0.3, 0.2), C.mint, 'paint', 0.15); // leg shield
  bp.add(xform(rbox(0.42, 0.52, 0.02, 0.01, 1), 0, 0.631, -0.256, 0.2), C.cream);            // inner panel
  for (let i = 0; i < 2; i++) {
    const sx = i ? 1 : -1;
    bp.add(axleCyl(0.075, 0.03, sx * 0.295, 0.52, 0.42, 12), C.cream);                      // side roundels
    bp.add(axleCyl(0.034, 0.04, sx * 0.296, 0.52, 0.42, 8), C.mintDark);
    bp.add(tube(V(sx * 0.11, 0.91, 0.56), V(sx * 0.11, 0.91, 0.78), 0.013, 6), C.chrome, 'metal'); // rack rails
    bp.add(tube(V(sx * 0.11, 0.91, 0.78), V(sx * 0.1, 0.63, 0.77), 0.013, 6), C.chrome, 'metal');
    bp.add(xform(box(0.016, 0.022, 0.5), sx * 0.182, 0.272, -0.08), C.cream, 'glow');        // underglow
  }
  bp.add(tube(V(-0.11, 0.91, 0.78), V(0.11, 0.91, 0.78), 0.013, 6), C.chrome, 'metal');
  bp.add(tube(V(-0.11, 0.91, 0.6), V(0.11, 0.91, 0.6), 0.013, 6), C.chrome, 'metal');
  bp.add(xform(rbox(0.22, 0.05, 0.05, 0.018, 1), 0, 0.62, 0.81), C.cream, 'glow');           // tail light
  bp.add(xform(rbox(0.2, 0.035, 0.05, 0.012, 1), 0, 0.38, 0.8), C.cream, 'glow');            // exhaust strip
  bp.add(axleCyl(0.05, 0.24, 0, R, HALF, 10), C.dark);                                       // rear hub housing
  bake(bp, body, body, ctx);

  // Steering: fender, column, handlebar cover with headlight, bars, mirrors
  const sp = new Part();
  const fA0 = 0.22, fArc = 1.8, fR = 0.255; // fender arc, angles measured from the front
  sp.add(xform(new THREE.TorusGeometry(fR, 0.06, 6, 14, fArc), FA.x, FA.y, FA.z, fA0, Math.PI / 2, 0, 1, 1, 1.5), C.mint, 'paint', 0.1);
  for (let i = 0; i < 2; i++) {
    const a = fA0 + (i ? fArc : 0);
    sp.add(ball(0.06, V(0, FA.y + fR * Math.sin(a), FA.z - fR * Math.cos(a)), 1.5, 1, 1, 10, 6), C.mint);
  }
  sp.add(tube(V(-0.1, R, -HALF), V(-0.08, 0.48, -0.53), 0.03, 8), C.mintDark);               // single-sided fork
  sp.add(axleCyl(0.04, 0.22, -0.01, R, -HALF, 10), C.dark);
  const cc = at(0.57);
  sp.add(xform(rbox(0.13, 0.56, 0.1, 0.04, 1), cc.x, cc.y, cc.z, ALPHA), C.mint, 'paint', 0.15); // column cover
  sp.add(xform(rbox(0.27, 0.13, 0.22, 0.05, 1), H.x, H.y, H.z), C.mint, 'paint', 0.2);      // handlebar cover
  sp.add(ball(0.045, V(0, H.y + 0.062, H.z + 0.05), 1, 0.5, 1), C.cream);                    // speedo dome
  sp.add(xform(new THREE.TorusGeometry(0.07, 0.016, 4, 16), 0, H.y + 0.01, H.z - 0.112), C.chrome, 'metal'); // bezel
  sp.add(xform(new THREE.CylinderGeometry(0.066, 0.066, 0.03, 16), 0, H.y + 0.01, H.z - 0.11, Math.PI / 2), C.cream, 'light');
  for (let i = 0; i < 2; i++) {
    const sx = i ? 1 : -1;
    sp.add(tube(V(sx * 0.12, H.y - 0.01, H.z + 0.02), V(sx * 0.3, H.y - 0.01, H.z + 0.03), 0.018, 8), C.chrome, 'metal');
    sp.add(tube(V(sx * 0.25, H.y - 0.01, H.z + 0.03), V(sx * 0.38, H.y - 0.01, H.z + 0.03), 0.031, 10), C.dark); // grips
    sp.add(ball(0.032, V(sx * 0.385, H.y - 0.01, H.z + 0.03)), C.chrome, 'metal');
    sp.add(xform(box(0.12, 0.012, 0.014), sx * 0.29, H.y, H.z - 0.04, 0, sx * 0.15, 0), C.chrome, 'metal'); // levers
    const mb = V(sx * 0.18, H.y + 0.04, H.z + 0.01), mt = V(sx * 0.27, H.y + 0.24, H.z + 0.02);
    sp.add(tube(mb, mt, 0.011, 6), C.chrome, 'metal');                                       // mirror stalk
    sp.add(xform(new THREE.CylinderGeometry(0.058, 0.058, 0.025, 14), mt.x + sx * 0.01, mt.y + 0.04, mt.z, Math.PI / 2), C.chrome, 'metal');
    sp.add(xform(new THREE.CylinderGeometry(0.047, 0.047, 0.006, 14), mt.x + sx * 0.01, mt.y + 0.04, mt.z + 0.014, Math.PI / 2), C.glass);
  }
  bake(sp, steer, body, ctx);

  const wf = new Part(false); scooterWheel(wf, FA); bake(wf, wheelF, body, ctx);
  const wb = new Part(false); scooterWheel(wb, RA); bake(wb, wheelB, body, ctx);

  const gy = H.y - 0.01, gz = H.z + 0.03;
  const grips = [toNodeSpace(V(-0.315, gy, gz), steer, body), toNodeSpace(V(0.315, gy, gz), steer, body)];
  const tailA = new THREE.Color(GLOW_COLOR.scooter), tailB = new THREE.Color('#3ff4ff');
  const underglow = { color: tailA.clone(), w: 0.85, l: 1.6 };

  return {
    radius: R, spinPeriod: Math.PI / 2, hip: V(0, 0.9, 0.18), lean0: 0.24,
    steerBase, steer, wheelF, wheelB, grips, underglow,
    prepare(st) {
      const b = st.tuck;
      mats.glow.emissive.lerpColors(tailA, tailB, b);
      underglow.color.copy(mats.glow.emissive);
      mats.glow.emissiveIntensity = 1.1 + st.throttle * 0.35
        + b * (2.8 + 1.4 * Math.sin(st.t * 31) + 0.7 * Math.sin(st.t * 77.3));
      mats.light.emissiveIntensity = 2.4 + b * 0.6 * Math.sin(st.t * 45);
    },
    legs(st, rider) {
      for (let i = 0; i < 2; i++) {
        const side = i ? 1 : -1;
        let tx = side * 0.15, ty = 0.37 + st.air * 0.06, tz = -0.17;
        if (st.trick > 0.001) { // trick pose: legs spread like a starfish
          const w = st.trick * 0.85;
          tx += (side * 0.56 - tx) * w; ty += (0.62 - ty) * w; tz += (0.06 - tz) * w;
        }
        aimLeg(rider, i ? rider.legR : rider.legL, side, tx, ty, tz, 0.8, 1.08);
      }
    },
    reset() {},
  };
}

function kickWheel(part, c) {
  part.add(ring(0.07, 0.05, c.x, c.y, c.z, 8, 20), C.neon, 'neon');
  part.add(axleCyl(0.046, 0.08, c.x, c.y, c.z, 14), C.core);
  for (let k = 0; k < 3; k++) { // radial slots so the spin reads
    const a = k * TAU / 3;
    part.add(xform(box(0.086, 0.044, 0.016), c.x, c.y + Math.cos(a) * 0.022, c.z + Math.sin(a) * 0.022, a), C.purpleDark);
  }
}

function buildKick(ctx, maxSpeed) {
  const { body, mats } = ctx;
  const R = 0.12, HALF = 0.55, ALPHA = 0.2;
  const FA = V(0, R, -HALF), RA = V(0, R, HALF);
  const up = V(0, Math.cos(ALPHA), Math.sin(ALPHA));
  const at = (t) => FA.clone().addScaledVector(up, t);

  const steerBase = makeNode(body, FA); steerBase.rotation.x = ALPHA;
  const steer = makeNode(steerBase);
  const wheelF = makeNode(steer);
  const wheelB = makeNode(body, RA);

  // Deck: electric purple, grip tape, neon strips, rear fender, neck
  const dp = new Part();
  dp.add(xform(rbox(0.24, 0.065, 0.86, 0.028, 2), 0, 0.14, 0), C.purple, 'paint', 0.35);
  dp.add(xform(box(0.2, 0.008, 0.76), 0, 0.1755, 0), C.grip);
  dp.add(xform(box(0.03, 0.009, 0.6), 0, 0.176, 0), C.neon, 'neon');
  for (let i = 0; i < 2; i++) {
    const sx = i ? 1 : -1;
    dp.add(xform(box(0.012, 0.02, 0.76), sx * 0.121, 0.138, 0), C.neon, 'neon');
    dp.add(xform(rbox(0.024, 0.08, 0.2, 0.008, 1), sx * 0.07, 0.135, 0.48), C.purpleDark);
  }
  dp.add(axleCyl(0.012, 0.17, 0, R, HALF, 6), C.steel, 'metal');
  dp.add(xform(new THREE.TorusGeometry(0.15, 0.016, 3, 10, 1.4), RA.x, RA.y, RA.z, 1.2, Math.PI / 2, 0, 1, 1, 4.2), C.purple, 'paint', 0.2); // rear fender
  dp.add(tube(V(0, 0.16, 0.41), V(0, 0.26, 0.5), 0.024, 6), C.purpleDark);
  dp.add(xform(rbox(0.12, 0.028, 0.034, 0.01, 1), 0, 0.205, 0.678, 1.0), C.neon, 'neon');    // neon tail light
  dp.add(tube(V(0, 0.14, -0.36), at(0.2), 0.042, 10), C.purple, 'paint', 0.2);                // neck
  dp.add(ball(0.05, at(0.2)), C.purple);
  dp.add(tube(at(0.16), at(0.34), 0.048, 12), C.purple);                                   // head tube
  dp.add(axisRing(at(0.25), 0.053, 0.012, ALPHA), C.neon, 'neon');
  bake(dp, body, body, ctx);

  // Steering: fork, stem, clamp, T-bar with glowing bar ends
  const sp = new Part();
  const crown = at(0.15);
  sp.add(xform(rbox(0.17, 0.045, 0.065, 0.014, 1), crown.x, crown.y, crown.z, ALPHA), C.purpleDark);
  for (let i = 0; i < 2; i++) {
    const sx = i ? 1 : -1;
    sp.add(tube(V(sx * 0.068, crown.y, crown.z), V(sx * 0.068, R, -HALF), 0.016, 6), C.chrome, 'metal');
  }
  sp.add(axleCyl(0.012, 0.16, 0, R, -HALF, 6), C.steel, 'metal');
  sp.add(tube(at(0.34), at(0.96), 0.034, 10), C.chrome, 'metal');                         // stem
  sp.add(tube(at(0.36), at(0.47), 0.045, 12), C.purple);                                  // clamp collar
  sp.add(axisRing(at(0.48), 0.046, 0.011, ALPHA), C.neon, 'neon');
  const T = at(0.96);
  sp.add(xform(rbox(0.1, 0.07, 0.08, 0.018, 1), T.x, T.y, T.z), C.purpleDark);
  sp.add(tube(V(-0.37, T.y, T.z), V(0.37, T.y, T.z), 0.026, 10), C.chrome, 'metal');
  for (let i = 0; i < 2; i++) {
    const sx = i ? 1 : -1;
    sp.add(tube(V(sx * 0.22, T.y, T.z), V(sx * 0.39, T.y, T.z), 0.04, 10), C.grip);
    sp.add(ball(0.045, V(sx * 0.395, T.y, T.z)), C.neon, 'neon');
  }
  bake(sp, steer, body, ctx);

  const wf = new Part(false); kickWheel(wf, FA); bake(wf, wheelF, body, ctx);
  const wb = new Part(false); kickWheel(wb, RA); bake(wb, wheelB, body, ctx);

  const grips = [toNodeSpace(V(-0.3, T.y, T.z), steer, body), toNodeSpace(V(0.3, T.y, T.z), steer, body)];

  let kickBlend = 0, kickPhase = 0;
  return {
    radius: R, spinPeriod: TAU / 3, hip: V(0, 0.9, 0.1), lean0: 0.28,
    steerBase, steer, wheelF, wheelB, grips,
    underglow: { color: new THREE.Color(C.neon), w: 0.75, l: 1.55 },
    prepare(st) {
      const want = st.grounded && st.throttle > 0.05 && st.speed < 0.75 * maxSpeed && st.tuck < 0.5;
      kickBlend += ((want ? 1 : 0) - kickBlend) * (1 - Math.exp(-st.dt * 7));
      if (kickBlend > 0.01) kickPhase = (kickPhase + st.dt * (1.5 + 1.3 * Math.min(st.speed01, 1))) % 1;
      else kickPhase = 0;
      const contact = kickPhase < 0.55 ? Math.sin(Math.PI * kickPhase / 0.55) : 0;
      st.hipDrop = 0.05 * contact * kickBlend + 0.035 * (1 - kickBlend); // crouched stance when cruising
      st.extraLean = 0.14 * kickBlend + 0.06 * (1 - kickBlend);
      mats.neon.emissiveIntensity = 0.9 + 0.5 * Math.min(st.speed01, 1)
        + st.tuck * (2.5 + 1.0 * Math.sin(st.t * 35) + 0.5 * Math.sin(st.t * 71));
    },
    legs(st, rider) {
      aimLeg(rider, rider.legL, -1, -0.07, 0.185, -0.12, 0.8, 1.12); // front foot planted
      let tx = 0.07, ty = 0.185, tz = 0.24;                          // back foot on the deck...
      if (kickBlend > 0.001) {                                       // ...or pushing the ground
        let px, py, pz;
        if (kickPhase < 0.55) { const u = kickPhase / 0.55; px = 0.22; py = 0.02; pz = -0.02 + 0.58 * u; }
        else {
          const u = (kickPhase - 0.55) / 0.45, e = u * u * (3 - 2 * u);
          px = 0.21; py = 0.02 + 0.22 * Math.sin(Math.PI * u); pz = 0.56 - 0.58 * e;
        }
        tx += (px - tx) * kickBlend; ty += (py - ty) * kickBlend; tz += (pz - tz) * kickBlend;
      }
      if (st.trick > 0.001) { // trick pose: back leg kicks out
        const w = st.trick * 0.8;
        tx += (0.3 - tx) * w; ty += (0.55 - ty) * w; tz += (0.66 - tz) * w;
      }
      aimLeg(rider, rider.legR, 1, tx, ty, tz, 0.8, 1.2);
    },
    reset() { kickBlend = 0; kickPhase = 0; },
  };
}

const BUILDERS = { bike: buildBike, scooter: buildScooter, kick: buildKick };

// ---------------------------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------------------------

export function createVehicle(type, opts) {
  const kind = BUILDERS[type] ? type : 'bike';
  const maxSpeed = (VEHICLE_STATS[kind] && VEHICLE_STATS[kind].maxSpeed) || 30;
  // { skin } (SKINS entry or id); legacy { shirtColor } = the noob wearing that shirt.
  let initSkin = resolveSkin(opts && opts.skin);
  if (opts && !opts.skin && typeof opts.shirtColor === 'string') initSkin = Object.assign({}, initSkin, { torso: opts.shirtColor });

  // group (main: position + yaw/slope) > trickPivot (0.9 m) > unPivot > leanPivot (contact line)
  //   > wheelie (rear axle, turbo kick) > body (squash; authoring frame of every part)
  const group = new THREE.Group();
  group.name = 'vehicle:' + kind;
  const trickPivot = makeNode(group, V(0, PIVOT_H, 0));
  trickPivot.rotation.order = 'YXZ';
  const unPivot = makeNode(trickPivot, V(0, -PIVOT_H, 0));
  const leanPivot = makeNode(unPivot);
  const wheelie = makeNode(leanPivot, V(0, 0, WHEELIE_Z));
  const body = makeNode(wheelie, V(0, 0, -WHEELIE_Z));

  const mats = makeMaterials(kind);
  const ctx = { body, mats, meshes: [] };
  let veh;
  _tones = makeTones(kind); // body colours -> tintable 'body' material while the builder runs
  try { veh = BUILDERS[kind](ctx, maxSpeed); } finally { _tones = null; }
  const rider = buildRider(ctx, veh.hip);
  const meshes = ctx.meshes;
  const hip = veh.hip;

  // Only keep materials that ended up on a mesh (setOpacity/dispose iterate this list).
  const matList = [];
  for (const m of meshes) if (!matList.includes(m.material)) matList.push(m.material);
  for (const k in mats) if (!matList.includes(mats[k])) mats[k].dispose();

  // Face decal + accessory meshes ride on the head mesh (so they travel with it when broken).
  const env = envTexture();
  const faceCv = makeCanvas(FACE_PX, FACE_PX);
  let faceTex = null, decalMat = null;
  if (faceCv) {
    faceTex = new THREE.CanvasTexture(faceCv.canvas);
    faceTex.colorSpace = THREE.SRGBColorSpace;
    faceTex.anisotropy = 4;
    decalMat = new THREE.MeshStandardMaterial({
      map: faceTex, emissiveMap: faceTex, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0,
      roughness: 0.5, metalness: 0, envMap: env, envMapIntensity: 0,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    });
    decalMat.userData.keepTransparent = true;
    const decal = new THREE.Mesh(rider.decalGeo, decalMat);
    decal.receiveShadow = true;
    // renderOrder stays 0: depth sorting already draws the decal after the (blinking) head whenever
    // the face is visible, and a forced order would paint it over particles / speed lines in front.
    rider.head.add(decal);
    matList.push(decalMat);
  } else {
    rider.decalGeo.dispose();
    rider.decalGeo = null;
  }
  const EMPTY = new THREE.BufferGeometry();
  const accMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, envMap: env, envMapIntensity: 0, side: THREE.DoubleSide });
  const accGlowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const accMain = new THREE.Mesh(EMPTY, accMat);
  const accGlow = new THREE.Mesh(EMPTY, accGlowMat);
  accMain.castShadow = true; accMain.receiveShadow = true;
  accMain.visible = accGlow.visible = false;
  rider.head.add(accMain, accGlow);
  matList.push(accMat, accGlowMat);

  // Optional neon underglow: additive soft ellipse on the ground plane (unaffected by lean/tricks).
  let under = null;
  if (veh.underglow) {
    const tex = makeGlowTexture();
    const ug = veh.underglow;
    const geo = new THREE.PlaneGeometry(ug.w, ug.l);
    geo.rotateX(-Math.PI / 2);
    under = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: tex, color: ug.color, transparent: true, opacity: 0.5, depthWrite: false,
      blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    under.position.y = 0.02;
    under.renderOrder = 2;
    under.frustumCulled = false;
    group.add(under);
  }

  // Break-apart bookkeeping (allocated once).
  const pieces = meshes.map((mesh) => ({
    mesh, parent: mesh.parent,
    p0: mesh.position.clone(), q0: mesh.quaternion.clone(), s0: mesh.scale.clone(),
    center: mesh.geometry.boundingBox.getCenter(new THREE.Vector3()),
    c: new THREE.Vector3(), v: new THREE.Vector3(), axis: new THREE.Vector3(1, 0, 0), w: 0,
  }));
  const localGrav = new THREE.Vector3();

  // Smoothed animation state shared with the vehicle-specific hooks.
  const st = {
    dt: 0, t: 0, speed: 0, speed01: 0, throttle: 0, grounded: true, lean: 0,
    steer: 0, air: 0, tuck: 0, trick: 0, idle: 1,
    sq: 0, sqV: 0, pitch: 0, pitchV: 0, hipDrop: 0, extraLean: 0, sway: 0,
  };
  let clock = 0, wheelAng = 0, airTime = 0, landCd = 0;
  let prevGrounded = true, prevLand = 0, prevSpin = 0, prevFlip = 0, prevBoost = false;
  let broken = false, brokenT = 0, debrisHidden = false;
  let opacity = 1, shown = true;

  function applyVisibility() {
    const vis = shown && !debrisHidden;
    for (let i = 0; i < meshes.length; i++) meshes[i].visible = vis;
    if (under) under.visible = shown && !broken;
  }

  function poseRider(crouch) {
    const r = rider;
    const idle = st.idle;
    const breath = Math.sin(st.t * 2.3);
    const sp01 = Math.min(st.speed01, 1);
    const bob = idle * breath * 0.008 + (1 - st.air) * Math.sin(st.t * 29) * 0.0045 * sp01;
    r.root.position.set(hip.x, hip.y - st.hipDrop - crouch * 0.1 - st.tuck * 0.06 + bob, hip.z + st.tuck * 0.05);

    const beta = veh.lean0 + st.extraLean + st.tuck * 0.42 + crouch * 0.35 + sp01 * 0.06 - st.air * 0.1 + idle * breath * 0.015;
    const turn = st.steer * (1 - st.air);
    r.torso.rotation.set(-beta, -turn * 0.12, -turn * 0.1 + st.sway);

    const look = idle * (Math.sin(st.t * 0.53) * 0.5 + Math.sin(st.t * 1.37) * 0.12);
    r.neck.rotation.set(beta * 0.5 + st.tuck * 0.14 - st.air * 0.12, -st.steer * 0.35 + look, st.lean * 0.5);

    // Arms: reach for the grips (solved in torso space); lift / spread when airborne or tricking.
    const w = clamp(st.air * 0.22 + st.trick * 0.8, 0, 0.9);
    _q0.copy(r.torso.quaternion).invert();
    for (let i = 0; i < 2; i++) {
      const side = i ? 1 : -1;
      _v0.copy(veh.grips[i]).applyQuaternion(veh.steer.quaternion)
        .applyQuaternion(veh.steerBase.quaternion).add(veh.steerBase.position)
        .sub(r.root.position).applyQuaternion(_q0);
      _v0.x -= side * R6.shoulderX;
      _v0.y -= R6.shoulderY;
      const len = _v0.length() || 1e-6;
      let nx = _v0.x / len, ny = _v0.y / len, nz = _v0.z / len;
      let sy = clamp(len / R6.armReach, 0.85, 1.14);
      if (w > 0.001) {
        nx += (side * 0.8 - nx) * w; ny += (0.46 - ny) * w; nz += (-0.38 - nz) * w;
        const n = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= n; ny /= n; nz /= n;
        sy += (1 - sy) * w;
      }
      aimDir(i ? r.armR : r.armL, nx, ny, nz, sy);
    }
  }

  function squash(x) {
    st.sqV += 11 * clamp(x, 0, 1);
    landCd = 0.15;
  }

  function stepDebris(dt) {
    if (debrisHidden) return;
    brokenT += dt;
    if (brokenT > BREAK_TIME) { debrisHidden = true; applyVisibility(); return; }
    const damp = Math.exp(-DEBRIS_DRAG * dt);
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i], m = p.mesh;
      p.v.addScaledVector(localGrav, dt).multiplyScalar(damp);
      p.c.addScaledVector(p.v, dt);
      _q1.setFromAxisAngle(p.axis, p.w * dt);
      m.quaternion.premultiply(_q1);
      // keep the piece tumbling about its own centre: position = c - R * (S * centre)
      _v0.copy(p.center).multiply(m.scale).applyQuaternion(m.quaternion);
      m.position.copy(p.c).sub(_v0);
    }
  }

  function update(dt, s) {
    dt = dt > 0 ? (dt > 0.05 ? 0.05 : dt) : 0;
    if (!s) s = DEFAULT_S;
    clock += dt;
    if (broken) { stepDebris(dt); return; }

    const speed = +s.speed || 0;
    const grounded = s.grounded !== false;
    const spin = +s.trickSpin || 0, flip = +s.trickFlip || 0;
    const li = +s.landImpact || 0;
    st.dt = dt;
    st.t = typeof s.time === 'number' ? s.time : clock;
    st.speed = speed;
    st.speed01 = clamp(Math.abs(speed) / maxSpeed, 0, 1.5);
    st.throttle = clamp(+s.throttle || 0, 0, 1);
    st.grounded = grounded;
    st.lean = +s.lean || 0;

    // Smoothed drivers
    st.steer += (clamp(+s.steer || 0, -1, 1) - st.steer) * (1 - Math.exp(-dt * 14));
    st.air += ((grounded ? 0 : 1) - st.air) * (1 - Math.exp(-dt * 8));
    st.tuck += ((s.boosting ? 1 : 0) - st.tuck) * (1 - Math.exp(-dt * 7));
    const trickTarget = !grounded && Math.abs(spin - prevSpin) + Math.abs(flip - prevFlip) > 1e-4 ? 1 : 0;
    st.trick += (trickTarget - st.trick) * (1 - Math.exp(-dt * (trickTarget ? 12 : 5)));
    prevSpin = spin; prevFlip = flip;
    st.idle += ((grounded && Math.abs(speed) < 0.6 ? 1 : 0) - st.idle) * (1 - Math.exp(-dt * 4));

    // Landing squash: on touchdown (scaled by air time) or whenever landImpact rises.
    landCd -= dt;
    if (grounded) {
      if (!prevGrounded) squash(Math.max(li, Math.min(airTime * 0.55, 0.45)));
      else if (li > prevLand + 0.02 && landCd <= 0) squash(li);
      airTime = 0;
    } else airTime += dt;
    prevGrounded = grounded; prevLand = li;
    st.sqV += (-260 * st.sq - 15 * st.sqV) * dt; // under-damped spring => jelly wobble
    st.sq += st.sqV * dt;
    const q = clamp(st.sq, -0.45, 0.75);
    // Turbo kick: a springy little wheelie when the boost starts (on the ground).
    const boosting = !!s.boosting;
    if (boosting && !prevBoost && grounded) st.pitchV += 2.6;
    prevBoost = boosting;
    st.pitchV += (-110 * st.pitch - 9 * st.pitchV) * dt;
    st.pitch += st.pitchV * dt;

    // Vehicle transforms
    const maxStep = SPIN_STEP * veh.spinPeriod; // fast wheels spin at a readable rate instead of strobing
    wheelAng = (wheelAng + clamp(speed / veh.radius * dt, -maxStep, maxStep)) % TAU;
    veh.wheelF.rotation.x = -wheelAng;
    veh.wheelB.rotation.x = -wheelAng;
    veh.steer.rotation.y = -st.steer * STEER_MAX;
    leanPivot.rotation.z = -st.lean;
    trickPivot.rotation.set(flip, spin, 0);
    body.scale.set(1 + q * 0.1, 1 - q * 0.2, 1 + q * 0.1);
    wheelie.rotation.x = st.pitch > 0 ? st.pitch : 0;

    st.hipDrop = 0; st.extraLean = 0; st.sway = 0;
    veh.prepare(st);
    poseRider(q > 0 ? q : 0);
    veh.legs(st, rider);

    if (under) {
      under.material.color.copy(veh.underglow.color);
      const uo = opacity * (1 - st.air) *
        (0.42 + 0.12 * Math.min(st.speed01, 1) + st.tuck * (0.35 + 0.12 * Math.sin(st.t * 33)));
      under.material.opacity = uo;
      under.visible = shown && uo > 0.004; // no draw call while airborne / hidden
    }
  }

  function breakApart(vel) {
    if (broken) return;
    broken = true; brokenT = 0; debrisHidden = false;
    if (under) under.visible = false;
    body.scale.set(1, 1, 1); // avoid shear when decomposing child transforms
    group.updateWorldMatrix(true, true);
    _m0.copy(group.matrixWorld).invert();
    group.matrixWorld.decompose(_v1, _q1, _v2);
    _q1.invert();
    const sc = Math.abs(_v2.x) > 1e-6 ? _v2.x : 1;
    localGrav.set(0, -GRAVITY, 0).applyQuaternion(_q1).divideScalar(sc);
    if (vel) _v3.copy(vel).applyQuaternion(_q1).divideScalar(sc); else _v3.set(0, 0, 0);

    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i], m = p.mesh;
      _m1.multiplyMatrices(_m0, m.matrixWorld);
      _m1.decompose(m.position, m.quaternion, m.scale);
      group.add(m);
      p.c.copy(p.center).multiply(m.scale).applyQuaternion(m.quaternion).add(m.position);
      // Mostly upward/outward from the rig centre, 4-9 m/s, plus inherited velocity.
      let dx = p.c.x + (Math.random() - 0.5) * 0.7;
      let dy = Math.max(p.c.y - 0.8, 0) * 0.4 + 0.9 + Math.random() * 0.6;
      let dz = p.c.z + (Math.random() - 0.5) * 0.7;
      const n = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const spd = 4 + Math.random() * 5;
      p.v.set(dx / n * spd, dy / n * spd, dz / n * spd).add(_v3);
      p.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      if (p.axis.lengthSq() < 1e-6) p.axis.set(1, 0, 0);
      p.axis.normalize();
      p.w = 4 + Math.random() * 10;
    }
  }

  function reset() {
    if (broken) {
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i], m = p.mesh;
        p.parent.add(m);
        m.position.copy(p.p0); m.quaternion.copy(p.q0); m.scale.copy(p.s0);
      }
    }
    broken = false; brokenT = 0; debrisHidden = false;
    applyVisibility();
    st.steer = 0; st.air = 0; st.tuck = 0; st.trick = 0; st.idle = 1;
    st.sq = 0; st.sqV = 0; st.pitch = 0; st.pitchV = 0; st.hipDrop = 0; st.extraLean = 0; st.sway = 0;
    airTime = 0; landCd = 0; prevGrounded = true; prevLand = 0; prevSpin = 0; prevFlip = 0; prevBoost = false;
    body.scale.set(1, 1, 1);
    leanPivot.rotation.set(0, 0, 0);
    wheelie.rotation.set(0, 0, 0);
    trickPivot.rotation.set(0, 0, 0);
    veh.steer.rotation.set(0, 0, 0);
    veh.reset();
  }

  function setOpacity(a) {
    a = clamp(+a, 0, 1);
    if (!(a === a)) a = 1; // NaN guard
    if (a === opacity) return;
    opacity = a;
    const transparent = a < 0.999;
    for (let i = 0; i < matList.length; i++) {
      const m = matList[i];
      m.opacity = a;
      if (m.transparent !== transparent && !m.userData.keepTransparent) { m.transparent = transparent; m.needsUpdate = true; }
    }
    const vis = a > 0.001;
    if (vis !== shown) { shown = vis; applyVisibility(); }
  }

  // --- skins -------------------------------------------------------------------------------
  let skin = null, curFace = '', curGlow = '', curAcc = '', curAccColor = '';
  const FACES = { smile: 1, happy: 1, cool: 1, ninja: 1, robot: 1 };
  // Per-face decal finish: glossy shades / visor, glowing robot eyes.
  const FACE_LOOK = {
    smile: { rough: 0.5, env: 0, emis: 0 }, happy: { rough: 0.5, env: 0, emis: 0 },
    cool: { rough: 0.22, env: 0.7, emis: 0 }, ninja: { rough: 0.6, env: 0, emis: 0 },
    robot: { rough: 0.18, env: 0.8, emis: 1.5 },
  };

  function swapGeo(mesh, geo) {
    if (mesh.geometry !== EMPTY) mesh.geometry.dispose();
    mesh.geometry = geo || EMPTY;
    mesh.visible = !!geo;
  }

  function setAccessory(id, hex) {
    if (!ACC_LOOK[id]) id = 'none';
    if (id === curAcc && hex === curAccColor) return;
    curAcc = id; curAccColor = hex;
    const built = id === 'none' ? { main: null, glow: null } : buildAccessory(id, hex);
    swapGeo(accMain, built.main);
    swapGeo(accGlow, built.glow);
    const look = ACC_LOOK[id];
    accMat.metalness = look.metal; accMat.roughness = look.rough; accMat.envMapIntensity = look.env;
    accGlowMat.color.setScalar(look.glow);
  }

  /** Re-skins the rider (and the vehicle tint) in place: no rebuild, safe mid break-apart. */
  function setSkin(s) {
    const sk = resolveSkin(s);
    skin = sk;
    mats.rHead.color.set(sk.head); mats.rTorso.color.set(sk.torso);
    mats.rArms.color.set(sk.arms); mats.rLegs.color.set(sk.legs);
    const metal = clamp(+sk.metal || 0, 0, 1);
    for (let i = 0; i < RIDER_MATS.length; i++) {
      const m = mats[RIDER_MATS[i]];
      m.metalness = 0.05 + 0.8 * metal;
      m.roughness = 0.5 - 0.27 * metal;
      m.envMapIntensity = env ? metal * 1.15 : 0;
    }
    const accHex = typeof sk.accColor === 'string' ? sk.accColor : '#000000';
    const face = FACES[sk.face] ? sk.face : 'smile';
    const glow = face === 'robot' ? glowHex(accHex) : '';
    if (faceCv && (face !== curFace || glow !== curGlow)) {
      drawFace(faceCv.g, face, glow);
      faceTex.needsUpdate = true;
    }
    curFace = face; curGlow = glow;
    if (decalMat) {
      const fl = FACE_LOOK[face];
      decalMat.roughness = fl.rough; decalMat.envMapIntensity = env ? fl.env : 0; decalMat.emissiveIntensity = fl.emis;
    }
    setAccessory(sk.acc, accHex);
    // Vehicle paint: the skin's tint (with its metal finish) or the stock colour.
    const vm = sk.vehicle ? metal : 0;
    mats.body.color.set(sk.vehicle || BODY_TINT[kind][0]);
    mats.body.metalness = 0.06 + 0.62 * vm;
    mats.body.roughness = 0.5 - 0.24 * vm;
    mats.body.envMapIntensity = env ? vm * 1.1 : 0;
  }
  setSkin(initSkin);

  function dispose() {
    if (group.parent) group.parent.remove(group);
    for (let i = 0; i < meshes.length; i++) meshes[i].geometry.dispose();
    for (let i = 0; i < matList.length; i++) matList[i].dispose();
    if (faceTex) faceTex.dispose();
    if (rider.decalGeo) rider.decalGeo.dispose();
    swapGeo(accMain, null); swapGeo(accGlow, null);
    EMPTY.dispose();
    if (under) {
      under.geometry.dispose();
      if (under.material.map) under.material.map.dispose();
      under.material.dispose();
    }
  }

  // Settle into the rest pose so the rig looks right before the first update().
  update(0, DEFAULT_S);

  return {
    type: kind,
    group,
    update,
    breakApart,
    reset,
    setOpacity,
    setSkin,
    dispose,
    get skin() { return skin; },
    get broken() { return broken; },
    get wheelRadius() { return veh.radius; },
  };
}
