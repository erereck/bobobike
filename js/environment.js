// Environment: sky dome (gradient, sun/moon, stars, aurora, nebula, cirrus, meteors),
// fog + exposure, hemisphere + sun lights with texel-snapped shadows, animated cloud sea,
// instanced floating clouds and a ring of distant floating islands.
//
// Per-frame work is allocation-free: only uniforms, a handful of object positions and the
// instance matrices of recycled clouds/islands are touched.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ZONES } from './themes.js';

// ---------------------------------------------------------------- constants
const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);

const SKY_RADIUS = 900;

const SHADOW_MAP = 2048;
const SHADOW_EXTENT = 38;                  // ortho half-size (m)
const SHADOW_DIST = 100;                   // light distance from its target along the sun dir
const SHADOW_TEXEL = (SHADOW_EXTENT * 2) / SHADOW_MAP;
const SHADOW_LEAD = 10;                    // shift the shadow box ahead of the player (m)

const SEA_SIZE = 1600;
const SEA_SEGMENTS = 64;                   // 25 m cells; SEA_SNAP is a multiple -> no vertex swimming
const SEA_SNAP = 50;
const SEA_DEPTH = 90;                      // below the (smoothed) focus height

const CLOUD_MAX = 60;
const CLOUD_LOW = 25;
const CLOUD_RMIN = 60;
const CLOUD_RMAX = 420;
const CLOUD_FOLLOW_CLAMP = 6;              // cloud layer never lags more than this behind focus.y
const CLOUD_GAP_BELOW = 14 + CLOUD_FOLLOW_CLAMP + 1;
const CLOUD_GAP_ABOVE = 22 + CLOUD_FOLLOW_CLAMP + 1;
const WIND_X = 1.6, WIND_Z = 0.7;          // cloud drift (m/s)
const CLOUD_FADE = 1.6;                    // s to puff in / shrink out when recycled in view

const ISLAND_MAX = 12;
const ISLAND_FADE = 4;                     // s to emerge from / sink into the haze
const ALIVE = 1e9;                         // aSpawn.y of an instance that is not fading out
const ISLAND_LOW = 8;
const ISLAND_PARALLAX = 0.8;               // islands travel with the player at 80% -> read as very far
const ISLAND_RMIN = 350, ISLAND_RMAX = 700;

// Fixed palette for night phenomena (linear after Color conversion).
const AURORA_A = new THREE.Color('#2dffa8');
const AURORA_B = new THREE.Color('#9d5cff');
const NEB_A = new THREE.Color('#ff4d9d');
const NEB_B = new THREE.Color('#6a2cff');
const NEB_C = new THREE.Color('#5ad8ff');
const NEB_AXIS = new THREE.Vector3(1.0, 0.35, 0.15).normalize(); // band crosses the forward (-Z) sky
const ROCK_BASE = new THREE.Color('#8e7a66');
const GRASS_BASE = new THREE.Color('#62c24c');

// Temps (never allocate per frame).
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _lx = new THREE.Vector3();
const _ly = new THREE.Vector3();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _c = new THREE.Color();

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth01 = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };

// ---------------------------------------------------------------- zone parsing / blending
const COLOR_KEYS = [
  'skyTop', 'skyHorizon', 'skyBottom', 'fog', 'sunColor', 'hemiSky', 'hemiGround',
  'cloud', 'cloudSea', 'accent', 'cloudEmissive', 'seaShadow', 'rock', 'islandTop', 'islandEmissive',
];
const NUM_KEYS = [
  'fogNear', 'fogFar', 'sunInt', 'sunEl', 'sunAz', 'hemiInt', 'exposure', 'stars', 'aurora', 'nebula', 'glow',
];

const _parsed = new WeakMap();
function parseZone(z) {
  let p = _parsed.get(z);
  if (p) return p;
  const c = (hex, fb) => new THREE.Color(hex || fb);
  const sky = z.sky || {}, sun = z.sun || {}, hemi = z.hemi || {};
  const stars = z.stars || 0, aurora = z.aurora || 0, nebula = z.nebula || 0, glow = z.glow || 0;
  const night = clamp01(Math.max(stars, aurora, nebula));
  p = {
    skyTop: c(sky.top, '#2f7fe0'), skyHorizon: c(sky.horizon, '#a8dcff'), skyBottom: c(sky.bottom, '#eaf7ff'),
    fog: c(z.fog, '#bfe3ff'), fogNear: z.fogNear ?? 70, fogFar: z.fogFar ?? 360,
    sunColor: c(sun.color, '#ffffff'), sunInt: sun.intensity ?? 2.5, sunEl: sun.elevation ?? 0.9, sunAz: sun.azimuth ?? 0.5,
    hemiSky: c(hemi.sky, '#ffffff'), hemiGround: c(hemi.ground, '#777777'), hemiInt: hemi.intensity ?? 1,
    exposure: z.exposure ?? 1,
    stars, aurora, nebula, glow,
    cloud: c(z.cloud, '#ffffff'), cloudSea: c(z.cloudSea, '#f2f8ff'), accent: c(z.accent, '#3a86ff'),
  };
  // Derived per-zone colors (blended like everything else).
  // sky-tinted lift so undersides never turn muddy (the hemi ground color can be brown)
  p.cloudEmissive = p.cloud.clone().lerp(p.hemiSky, 0.4).multiplyScalar(0.12 + 0.28 * night);
  p.seaShadow = p.cloudSea.clone().lerp(p.hemiGround, 0.62).multiplyScalar(0.72);
  p.rock = ROCK_BASE.clone().lerp(p.hemiGround, 0.5);
  p.islandTop = GRASS_BASE.clone().lerp(p.accent, clamp01(glow) * 0.85);
  p.islandEmissive = p.accent.clone().multiplyScalar(0.45 * glow);
  _parsed.set(z, p);
  return p;
}

// ---------------------------------------------------------------- GLSL
// Noise comes from one baked tileable fbm texture (see buildNoiseTexture): a couple of
// filtered fetches replace dozens of per-pixel hashes, and mipmaps kill distant shimmer.
// Each channel is an independent 4-octave Perlin fbm normalized to mean 0.5, std 0.16.
const HASH_GLSL = /* glsl */ `
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // pin to the far plane: never clipped whatever camera.far is, and (drawn last among
  // opaques with depthTest) only shaded where nothing else covers the pixel
  clip.z = clip.w * 0.999999;
  gl_Position = clip;
}
`;

const SKY_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform vec3 uFog;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunGlow;
uniform float uHorizonGlow;
uniform float uNight;
uniform float uTime;
uniform float uStars;
uniform float uAurora;
uniform float uNebula;
uniform float uCirrus;
uniform float uStarRot;
uniform vec4 uMeteorA;   // xyz start dir, w progress (<=0: none)
uniform vec4 uMeteorB;   // xyz tangent,   w arc length (rad)
uniform vec3 uAuroraA;
uniform vec3 uAuroraB;
uniform vec3 uNebA;
uniform vec3 uNebB;
uniform vec3 uNebC;
uniform vec3 uNebAxis;
varying vec3 vDir;

${HASH_GLSL}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;

  // 3-stop vertical gradient
  vec3 col = mix(uHorizon, uTop, sqrt(clamp(h, 0.0, 1.0)));
  col = mix(col, uBottom, 1.0 - smoothstep(-0.2, 0.0, h));
  // Horizon haze toward the fog color so fogged geometry melts into the sky. It is mixed in
  // AFTER tone mapping / color-space conversion (end of main), exactly like three's built-in
  // fog_fragment, so it matches in both render paths (composer -> linear target, or direct
  // to the canvas with in-shader ACES). Additive light ('add') is divided by the haze
  // transmittance so it still lands on top of the haze, as before.
  float haze = 1.0 - (1.0 - exp(-abs(h) * 13.0) * 0.5)
                   * (1.0 - (1.0 - smoothstep(-0.13, -0.03, h)) * 0.85);

  float sd = dot(dir, uSunDir);
  float sdp = max(sd, 0.0);
  float sd2 = sdp * sdp;
  // warm scattering along the horizon around the sun (strong when the sun is low)
  vec3 add = uSunColor * (sd2 * sd2 * exp(-abs(h) * 4.5) * uHorizonGlow);

  // high wispy cirrus (day zones), planar-projected and stretched
  if (uCirrus > 0.01 && h > 0.0) {
    vec2 cp = dir.xz / (h + 0.2) * 0.35 + vec2(uTime * 0.0012, uTime * 0.0005);
    float c = texture2D(uNoise, cp * vec2(0.55, 2.1)).b;
#ifndef LOW
    c = c * 0.62 + texture2D(uNoise, cp * vec2(1.6, 4.9) + 0.37).g * 0.38;
#endif
    c = smoothstep(0.52, 0.8, c) * smoothstep(0.03, 0.32, h) * uCirrus;
    vec3 cc = mix(mix(vec3(1.0), uHorizon, 0.3), uSunColor, 0.2 + 0.6 * sd2);
    c *= 0.55;
    col = mix(col, cc, c);
    add *= 1.0 - c; // the cirrus veils the horizon glow behind it
  }

  // nebula: triplanar noise (weights = dir^2 sum to 1) concentrated along a galactic band
  if (uNebula > 0.001) {
    vec3 q = dir * 0.6 + vec3(0.0, uTime * 0.0005, 0.0);
    vec3 w = dir * dir;
    float n = texture2D(uNoise, q.yz).r * w.x + texture2D(uNoise, q.zx + 0.31).r * w.y
            + texture2D(uNoise, q.xy + 0.63).r * w.z;
    n = 0.5 + (n - 0.5) * 1.5;
    float bd = dot(dir, uNebAxis) * 2.4;
    float band = exp(-bd * bd);
    float m = smoothstep(0.42, 0.8, n) * (0.22 + 0.78 * band);
    float hue = 0.5 + 0.5 * sin(n * 7.0 + dir.x * 2.6 - dir.y * 1.9);
    vec3 nc = mix(uNebA, uNebB, hue);
    nc = mix(nc, uNebC, smoothstep(0.62, 0.9, n) * band);
    add += nc * (m * uNebula * 0.8 * smoothstep(-0.1, 0.15, h));
  }

  // aurora: two wandering curtains with vertical rays (integer azimuth freqs -> seamless)
  if (uAurora > 0.001 && h > -0.04 && h < 0.8) {
    float az = atan(dir.x, dir.z + 1e-5);
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 2; i++) {
      float fi = float(i);
      float base = 0.1 + fi * 0.085
        + 0.05 * sin(az * 2.0 + uTime * 0.05 + fi * 2.1)
        + 0.022 * sin(az * 5.0 - uTime * 0.11 + fi * 1.3);
      float y = h - base;
      float curtain = smoothstep(-0.016, 0.008, y) * exp(-max(y, 0.0) * (10.0 - fi * 3.0));
      float rays = 0.5 + 0.5 * sin(az * (46.0 + fi * 17.0)
        + 2.6 * sin(az * 7.0 + uTime * 0.33 + fi * 1.7) + uTime * (0.45 - fi * 0.2));
      rays *= 0.55 + 0.45 * sin(az * (13.0 + fi * 6.0) - uTime * 0.21 + fi * 4.0);
      // patchy along the azimuth so the curtains come and go instead of forming a wall
      float mask = 0.06 + 0.94 * smoothstep(0.35, 0.95, 0.5 + 0.5 * sin(az * (2.0 + fi) + uTime * 0.03 + fi * 2.7));
      vec3 ac = mix(uAuroraA, uAuroraB, clamp(y * 6.5 + fi * 0.3, 0.0, 1.0));
      acc += ac * (curtain * (0.25 + 0.75 * rays) * mask);
    }
    add += acc * (uAurora * 1.25);
  }

  // stars: one jittered star in ~6% of the cells of a 3D grid over the (slowly rotating) sphere
  if (uStars > 0.001 && h > -0.05) {
    float cs = cos(uStarRot);
    float sn = sin(uStarRot);
    vec3 sdir = vec3(cs * dir.x - sn * dir.z, dir.y, sn * dir.x + cs * dir.z);
    vec3 p = sdir * 150.0;
    vec3 cell = floor(p);
    vec3 r = hash33(cell);
    if (r.x > 0.94) {
      vec3 r2 = hash33(cell + 19.19);
      vec3 o = (r2 - 0.5) * 0.4;
      float size = 0.13 + 0.15 * r.y * r.y;
      float d = length(fract(p) - 0.5 - o);
      float s = 1.0 - smoothstep(0.0, size, d);
      float tw = 0.55 + 0.45 * sin(uTime * (1.2 + 3.6 * r.z) + r.y * 61.0);
      vec3 sc = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.86, 0.7), r2.z);
      float bright = 0.7 + 2.8 * pow(r.y, 7.0);
      add += sc * (s * s * tw * bright * uStars * smoothstep(-0.03, 0.16, h));
    }
  }

  // shooting star (great-circle arc with a tapering tail)
  if (uMeteorA.w > 0.0) {
    vec3 mA = uMeteorA.xyz;
    vec3 mT = uMeteorB.xyz;
    float off = dot(dir, cross(mA, mT));
    float along = atan(dot(dir, mT), dot(dir, mA));
    float head = uMeteorA.w * uMeteorB.w;
    float k = clamp((along - head + 0.16) / 0.16, 0.0, 1.0) * step(along, head) * step(0.0, along);
    float w = 0.0004 + 0.0014 * k;
    float line = exp(-(off * off) / (w * w));
    float fade = sin(uMeteorA.w * 3.14159);
    add += vec3(1.0, 0.93, 0.82) * (line * k * k * fade * 4.0 * uStars);
  }

  // sun (HDR disc for bloom) / moon (bigger, dimmer, with maria) + glow
  float x = 1.0 - sd;
  float discR = mix(0.00045, 0.00075, uNight);
  float disc = (1.0 - smoothstep(discR - 0.00006, discR + 0.00006, x)) * smoothstep(-0.02, 0.012, h);
  if (disc > 0.0 && uNight > 0.0) {
    float mm = texture2D(uNoise, dir.xz * 12.0 + 0.5).r;
    disc *= mix(1.0, 0.66 + 0.34 * smoothstep(0.36, 0.64, mm), uNight);
  }
  add += uSunColor * (disc * mix(16.0, 1.7, uNight));
  add += uSunColor * (uSunGlow * (0.45 * exp(-x * 650.0) + 0.16 * exp(-x * 28.0)));

  gl_FragColor = vec4(col + add / (1.0 - haze), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFog, haze); // uFog is in output space (see syncFogOut)
}
`;

const SEA_VERT = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
varying float vSwell;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  // slow world-space swells (grid is snapped, so vertices never swim)
  float s = sin(wp.x * 0.019 + uTime * 0.13) * cos(wp.z * 0.016 - uTime * 0.1)
          + 0.5 * sin((wp.x - wp.z) * 0.031 + uTime * 0.21);
  wp.y += s * 3.0;
  vSwell = s * 0.667;
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SEA_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform vec3 uColor;
uniform vec3 uShadow;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uFogColor;
uniform vec3 uGlowColor;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform float uHorizonGlow;
uniform float uSunGlow;
uniform float uTime;
uniform float uFogNear;
uniform float uFogFar;
uniform float uSunAmt;
uniform float uGlow;
varying vec3 vWorld;
varying float vSwell;

const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);

void main() {
  vec3 toFrag = vWorld - cameraPosition;
  float dist = length(toFrag);
  vec3 V = toFrag / dist;

  // cloud-top height field: two scales of the baked fbm (mipmapped -> no distant shimmer)
  vec2 uv = (vWorld.xz + vec2(uTime * 1.1, uTime * 0.4)) * (1.0 / 250.0);
  vec2 uv2 = ROT * uv * 1.73 + 0.37;
  float n = texture2D(uNoise, uv).r * 0.72 + texture2D(uNoise, uv2).g * 0.28;
#ifdef LOW
  float lit = smoothstep(0.32, 0.66, n);
#else
  // directional relief: brighter where the field drops toward the sun
  vec2 o = uSunDir.xz * 0.0225;
  float n2 = texture2D(uNoise, uv + o).r * 0.72 + texture2D(uNoise, uv2 + ROT * o * 1.73).g * 0.28;
  float lit = clamp(0.5 + (n - n2) * 5.5, 0.0, 1.0);
#endif
  float puff = smoothstep(0.3, 0.68, n + vSwell * 0.05);
  float shade = mix(0.16, 1.0, puff) * mix(0.5, 1.0, lit);
  vec3 col = mix(uShadow, uColor, shade);
  col += uSunColor * (lit * puff * 0.24 * uSunAmt);
  // forward scattering: thin edges glow when looking toward a low sun
  float fwd = max(dot(V, uSunDir), 0.0);
  float fwd2 = fwd * fwd;
  float fwd6 = fwd2 * fwd2 * fwd2;
  col += uSunColor * (fwd6 * (1.0 - 0.6 * puff) * 0.4 * uSunAmt);
  // night zones: neon glow pooling in the valleys
  col += uGlowColor * (uGlow * (1.0 - puff) * 0.28);

  // distance haze toward the exact sky color behind it (same formula as the dome below
  // the horizon), so the plane's far edge is invisible and the sea can stay opaque
  // The fog-colored part of that haze is mixed after tone mapping, like the dome, so at
  // full distance the result equals the dome pixel exactly in both render paths.
  float h = V.y;
  vec3 sky = mix(uHorizon, uBottom, 1.0 - smoothstep(-0.2, 0.0, h));
  float haze = 1.0 - (1.0 - exp(-abs(h) * 13.0) * 0.5)
                   * (1.0 - (1.0 - smoothstep(-0.13, -0.03, h)) * 0.85);
  float f4 = fwd2 * fwd2;
  vec3 glow = uSunColor * (f4 * exp(-abs(h) * 4.5) * uHorizonGlow + uSunGlow * 0.16 * exp(-(1.0 - fwd) * 28.0));
  float d = smoothstep(uFogNear, uFogFar, dist);
  float fa = haze * d;
  col = ((1.0 - d) * col + d * ((1.0 - haze) * sky + glow)) / (1.0 - fa);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, fa); // output-space fog color
}
`;

// Spawn-in / fade-out for recycled instances (no popping). Per instance aSpawn = (env clock
// when (re)placed, env clock when fully gone); (-1e4, 1e9) = simply there. Only the clock
// uniform changes per frame; the attribute is re-uploaded only when an item changes state.
const SPAWN_PARS_VERT = /* glsl */ `
attribute vec2 aSpawn;
uniform float uEnvClock;
float spawnK(float rate) {
  float k = clamp(min(uEnvClock - aSpawn.x, aSpawn.y - uEnvClock) * rate, 0.0, 1.0);
  return k * k * (3.0 - 2.0 * k);
}
`;
const CLOUD_GROW_VERT = `#include <begin_vertex>
  transformed *= spawnK(${(1 / CLOUD_FADE).toFixed(4)});`;
const ISLAND_GROW_VERT = `#include <begin_vertex>
  vSpawn = spawnK(${(1 / ISLAND_FADE).toFixed(4)});
  transformed *= 0.6 + 0.4 * vSpawn;`;

// Longer, capped fog for distant scenery so islands stay readable as hazy silhouettes.
// Recycled islands emerge from / sink back into full fog (and grow/shrink a little).
// Same function source for every material -> one shared program; values are per material.
function patchFarFog(material, farMul, maxFog, clockU) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFarFog = { value: new THREE.Vector2(farMul, maxFog) };
    shader.uniforms.uEnvClock = clockU;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + SPAWN_PARS_VERT + 'varying float vSpawn;')
      .replace('#include <begin_vertex>', ISLAND_GROW_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', '#include <fog_pars_fragment>\nuniform vec2 uFarFog;\nvarying float vSpawn;')
      .replace('#include <fog_fragment>', `#ifdef USE_FOG
  #ifdef FOG_EXP2
    float farFogF = (1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth * 0.2)) * uFarFog.y;
  #else
    float farFogF = smoothstep(fogNear, fogFar * uFarFog.x, vFogDepth) * uFarFog.y;
  #endif
  farFogF = mix(1.0, farFogF, vSpawn);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, farFogF);
#endif`);
  };
}

// Cheap forward scattering for the floating clouds: when looking toward the sun the
// cloud glows (stronger at silhouette edges) instead of reading as a dark lump.
// Recycled clouds also puff up from / shrink to nothing instead of popping.
function patchCloudScatter(material, sunDir, scatterColor, clockU) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDirW = { value: sunDir };
    shader.uniforms.uScatter = { value: scatterColor };
    shader.uniforms.uEnvClock = clockU;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + SPAWN_PARS_VERT)
      .replace('#include <begin_vertex>', CLOUD_GROW_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSunDirW;\nuniform vec3 uScatter;')
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
  {
    vec3 sunV = normalize((viewMatrix * vec4(uSunDirW, 0.0)).xyz);
    vec3 toFrag = -normalize(vViewPosition);
    float fs = max(dot(toFrag, sunV), 0.0);
    fs *= fs; fs *= fs;
    float rim = 1.0 - abs(dot(normal, toFrag));
    gl_FragColor.rgb += uScatter * (fs * (0.3 + 0.7 * rim));
  }`);
  };
}

// ---------------------------------------------------------------- geometry builders
function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic hash of a position (so duplicated seam vertices get identical jitter).
function hashPos(x, y, z, salt) {
  const a = Math.round(x * 1e4), b = Math.round(y * 1e4), c = Math.round(z * 1e4);
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177) ^ Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Tileable 4-channel noise texture: each channel is an independent 4-octave periodic Perlin
// fbm (periods 4..32 per tile), normalized to mean 0.5 / std 0.16. Built once (~20 ms).
function buildNoiseTexture(renderer, size = 256) {
  const N = size * size;
  const data = new Uint8Array(N * 4);
  const acc = new Float32Array(N);
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  for (let ch = 0; ch < 4; ch++) {
    acc.fill(0);
    const R = rng(1013 + ch * 7919);
    let amp = 0.5;
    for (let period = 4; period <= 32; period *= 2) {
      const gx = new Float32Array(period * period), gy = new Float32Array(period * period);
      for (let i = 0; i < gx.length; i++) { const a = R() * TAU; gx[i] = Math.cos(a); gy[i] = Math.sin(a); }
      const cell = size / period;
      // random per-octave shift so lattice zeros of different octaves don't line up
      const offX = R() * cell, offY = R() * cell;
      for (let y = 0; y < size; y++) {
        const fy = (y + offY) / cell, iy = Math.floor(fy), ty = fy - iy, sy = fade(ty);
        const y0 = (iy % period) * period, y1 = ((iy + 1) % period) * period;
        for (let x = 0; x < size; x++) {
          const fx = (x + offX) / cell, ix = Math.floor(fx), tx = fx - ix, sx = fade(tx);
          const x0 = ix % period, x1 = (ix + 1) % period;
          const a00 = y0 + x0, a10 = y0 + x1, a01 = y1 + x0, a11 = y1 + x1;
          const n00 = gx[a00] * tx + gy[a00] * ty;
          const n10 = gx[a10] * (tx - 1) + gy[a10] * ty;
          const n01 = gx[a01] * tx + gy[a01] * (ty - 1);
          const n11 = gx[a11] * (tx - 1) + gy[a11] * (ty - 1);
          const nx0 = n00 + (n10 - n00) * sx, nx1 = n01 + (n11 - n01) * sx;
          acc[y * size + x] += (nx0 + (nx1 - nx0) * sy) * amp;
        }
      }
      amp *= 0.5;
    }
    let mean = 0, v2 = 0;
    for (let i = 0; i < N; i++) mean += acc[i];
    mean /= N;
    for (let i = 0; i < N; i++) { const d = acc[i] - mean; v2 += d * d; }
    const k = 0.16 / (Math.sqrt(v2 / N) || 1);
    for (let i = 0; i < N; i++) {
      const v = Math.round((0.5 + (acc[i] - mean) * k) * 255);
      data[i * 4 + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = renderer && renderer.capabilities ? Math.min(2, renderer.capabilities.getMaxAnisotropy()) : 1;
  tex.needsUpdate = true;
  return tex;
}

// Non-indexed, no uv/normal (normals are recomputed flat after merging).
function prep(g) {
  const geo = g.index ? g.toNonIndexed() : g;
  if (geo !== g) g.dispose();
  geo.deleteAttribute('uv');
  geo.deleteAttribute('normal');
  return geo;
}

function buildCloudGeometry() {
  // x, y, z, radius of each puff
  const blobs = [
    [0.0, 0.2, 0.0, 1.0], [-1.05, 0.0, 0.12, 0.8], [1.08, 0.02, -0.08, 0.84],
    [-0.42, 0.62, -0.12, 0.7], [0.5, 0.55, 0.18, 0.66], [-1.85, -0.12, -0.05, 0.55],
    [1.92, -0.1, 0.1, 0.56], [0.15, -0.05, 0.62, 0.62], [-0.1, 0.0, -0.62, 0.64],
  ];
  const BASE = -0.3; // flatten undersides like cumulus
  const parts = [];
  for (const [x, y, z, r] of blobs) {
    const g = prep(new THREE.IcosahedronGeometry(r, 1));
    g.translate(x, y, z);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const vy = pos.getY(i);
      if (vy < BASE) pos.setY(i, BASE + (vy - BASE) * 0.2);
    }
    parts.push(g);
  }
  const geo = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  const minY = geo.boundingBox.min.y, maxY = geo.boundingBox.max.y;
  // baked vertical gradient: cool shaded base -> bright top (multiplied by the zone color)
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.pow(clamp01((pos.getY(i) - minY) / (maxY - minY)), 0.8);
    col[i * 3] = 0.76 + 0.24 * t;
    col[i * 3 + 1] = 0.8 + 0.2 * t;
    col[i * 3 + 2] = 0.92 + 0.08 * t;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return { geo, minY, maxY };
}

function buildRockGeometry() {
  const H = 1.7;
  const cone = new THREE.ConeGeometry(1, H, 8, 4);
  cone.rotateX(Math.PI);          // tip down
  cone.translate(0, -H / 2, 0);   // flat top at y = 0
  const pos = cone.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const h1 = hashPos(x, y, z, 1), h2 = hashPos(x, y, z, 2);
    if (y > -0.001) {
      const k = 0.92 + 0.1 * h1; // stay under the grass cap
      pos.setXYZ(i, x * k, 0, z * k);
    } else if (y > -H + 0.01) {
      const k = 0.78 + 0.42 * h1;
      pos.setXYZ(i, x * k, y + (h2 - 0.5) * 0.14, z * k);
    }
  }
  const parts = [prep(cone)];
  const debris = [[0.35, -1.95, 0.2, 0.13], [-0.42, -2.2, -0.12, 0.09], [0.12, -2.45, 0.36, 0.06]];
  for (const [x, y, z, r] of debris) {
    const g = prep(new THREE.IcosahedronGeometry(r, 0));
    g.translate(x, y, z);
    parts.push(g);
  }
  const geo = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  geo.computeVertexNormals();
  const p = geo.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const t = Math.pow(clamp01((y + H) / H), 0.7);
    const band = y > -0.14 ? 1 : 0; // warmer soil band under the grass
    col[i * 3] = 0.42 + 0.58 * t + band * 0.06;
    col[i * 3 + 1] = 0.38 + 0.56 * t - band * 0.04;
    col[i * 3 + 2] = 0.4 + 0.5 * t - band * 0.1;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

function buildTopGeometry() {
  const R = rng(99);
  const cap = prep(new THREE.CylinderGeometry(1.07, 1.0, 0.13, 9));
  cap.translate(0, 0.065, 0);
  const capCount = cap.attributes.position.count;
  const parts = [cap];
  for (let i = 0; i < 6; i++) {
    const a = R() * TAU, r = 0.15 + R() * 0.62;
    const hgt = 0.22 + R() * 0.2;
    const tree = prep(new THREE.ConeGeometry(0.08 + R() * 0.05, hgt, 5));
    tree.translate(Math.sin(a) * r, 0.13 + hgt / 2, Math.cos(a) * r);
    parts.push(tree);
  }
  const geo = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  geo.computeVertexNormals();
  const n = geo.attributes.normal;
  const col = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    let v;
    if (i < capCount) v = n.getY(i) > 0.5 ? 1.0 : 0.72;
    else v = 0.58 + 0.08 * ((((i - capCount) / 18) | 0) % 3) / 2;
    col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------- factory
export function createEnvironment({ scene, renderer, quality = 'high' }) {
  // ---- lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0x777777, 1);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  const sc = sun.shadow.camera;
  sc.left = -SHADOW_EXTENT; sc.right = SHADOW_EXTENT;
  sc.top = SHADOW_EXTENT; sc.bottom = -SHADOW_EXTENT;
  sc.near = 1; sc.far = 200;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);
  const sunDir = new THREE.Vector3(0, 1, 0); // unit vector toward the sun

  // ---- fog
  const fog = new THREE.Fog(0xbfe3ff, 70, 360);
  scene.fog = fog;

  // ---- blended state (Colors are shared by reference with uniforms)
  const B = {};
  for (const k of COLOR_KEYS) B[k] = new THREE.Color();
  for (const k of NUM_KEYS) B[k] = 0;
  B.fog = fog.color;

  // Fog color in the space three's built-in fog uses (output space when drawing straight to
  // the canvas, working space when drawing into the composer's target). The sky and sea mix
  // it in after tone mapping so their haze matches fogged geometry in both render paths.
  const fogOut = fog.color.clone();
  function syncFogOut(r) {
    fog.color.getRGB(fogOut, r.getRenderTarget() === null ? r.outputColorSpace : THREE.ColorManagement.workingColorSpace);
  }

  // env clock driving the spawn-in of recycled clouds/islands (shared uniform object)
  let envClock = 0;
  const clockU = { value: 0 };

  const noiseTex = buildNoiseTexture(renderer);

  // ---- sky dome
  const skyU = {
    uNoise: { value: noiseTex },
    uTop: { value: B.skyTop }, uHorizon: { value: B.skyHorizon }, uBottom: { value: B.skyBottom },
    uFog: { value: fogOut }, uSunDir: { value: sunDir }, uSunColor: { value: B.sunColor },
    uSunGlow: { value: 1 }, uHorizonGlow: { value: 0.2 }, uNight: { value: 0 }, uTime: { value: 0 },
    uStars: { value: 0 }, uAurora: { value: 0 }, uNebula: { value: 0 }, uCirrus: { value: 1 },
    uStarRot: { value: 0 },
    uMeteorA: { value: new THREE.Vector4(0, 1, 0, -1) }, uMeteorB: { value: new THREE.Vector4(1, 0, 0, 0.5) },
    uAuroraA: { value: AURORA_A }, uAuroraB: { value: AURORA_B },
    uNebA: { value: NEB_A }, uNebB: { value: NEB_B }, uNebC: { value: NEB_C }, uNebAxis: { value: NEB_AXIS },
  };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyU, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
  });
  const skyGeo = new THREE.SphereGeometry(SKY_RADIUS, 48, 24);
  skyGeo.deleteAttribute('normal');
  skyGeo.deleteAttribute('uv');
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  // Drawn LAST among opaques at the far plane: early-z skips every pixel already covered
  // (track, cloud sea, clouds...), so the sky shader only runs where sky is visible.
  sky.renderOrder = 1e6;
  sky.name = 'sky';
  sky.onBeforeRender = syncFogOut;
  scene.add(sky);

  // ---- cloud sea
  const seaU = {
    uNoise: { value: noiseTex },
    uColor: { value: B.cloudSea }, uShadow: { value: B.seaShadow }, uSunColor: { value: B.sunColor },
    uSunDir: { value: sunDir }, uFogColor: { value: fogOut }, uGlowColor: { value: B.accent },
    uHorizon: { value: B.skyHorizon }, uBottom: { value: B.skyBottom },
    uHorizonGlow: skyU.uHorizonGlow, uSunGlow: skyU.uSunGlow, // shared uniform objects
    uTime: { value: 0 },
    uFogNear: { value: 100 }, uFogFar: { value: 700 }, uSunAmt: { value: 1 }, uGlow: { value: 0 },
  };
  // Opaque (no blending, no discard -> early-z works); its far haze converges on the sky color.
  const seaMat = new THREE.ShaderMaterial({
    uniforms: seaU, vertexShader: SEA_VERT, fragmentShader: SEA_FRAG, fog: false,
  });
  const seaGeo = new THREE.PlaneGeometry(SEA_SIZE, SEA_SIZE, SEA_SEGMENTS, SEA_SEGMENTS);
  seaGeo.rotateX(-Math.PI / 2);
  seaGeo.deleteAttribute('normal');
  seaGeo.deleteAttribute('uv');
  const sea = new THREE.Mesh(seaGeo, seaMat);
  sea.frustumCulled = false;
  sea.name = 'cloudSea';
  sea.onBeforeRender = syncFogOut;
  scene.add(sea);

  // ---- floating clouds (one InstancedMesh)
  const cloudBuilt = buildCloudGeometry();
  const CLOUD_MINY = cloudBuilt.minY, CLOUD_MAXY = cloudBuilt.maxY;
  const cloudSpawn = new THREE.InstancedBufferAttribute(new Float32Array(CLOUD_MAX * 2), 2);
  cloudSpawn.setUsage(THREE.DynamicDrawUsage);
  const cloudSp = cloudSpawn.array;
  cloudBuilt.geo.setAttribute('aSpawn', cloudSpawn);
  const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
  const cloudScatter = new THREE.Color(0, 0, 0);
  patchCloudScatter(cloudMat, sunDir, cloudScatter, clockU);
  const clouds = new THREE.InstancedMesh(cloudBuilt.geo, cloudMat, CLOUD_MAX);
  clouds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  clouds.frustumCulled = false;
  clouds.name = 'clouds';
  const cloudX = new Float32Array(CLOUD_MAX); // local (mesh-space) XZ of each cloud
  const cloudZ = new Float32Array(CLOUD_MAX);
  for (let i = 0; i < CLOUD_MAX; i++) clouds.setColorAt(i, _c.setScalar(1)); // creates instanceColor up front
  scene.add(clouds);

  // ---- distant islands (rock + top, two InstancedMeshes sharing matrices)
  const rockMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
  const topMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
  patchFarFog(rockMat, 2.4, 0.9, clockU);
  patchFarFog(topMat, 2.4, 0.8, clockU);
  // one spawn-time buffer shared by both island meshes (they share instance slots)
  const islandSpawn = new THREE.InstancedBufferAttribute(new Float32Array(ISLAND_MAX * 2), 2);
  islandSpawn.setUsage(THREE.DynamicDrawUsage);
  const islandSp = islandSpawn.array;
  const rockGeo = buildRockGeometry(), topGeo = buildTopGeometry();
  rockGeo.setAttribute('aSpawn', islandSpawn);
  topGeo.setAttribute('aSpawn', islandSpawn);
  const rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, ISLAND_MAX);
  const topMesh = new THREE.InstancedMesh(topGeo, topMat, ISLAND_MAX);
  rockMesh.frustumCulled = topMesh.frustumCulled = false;
  const islands = new THREE.Group();
  islands.name = 'islands';
  islands.add(rockMesh, topMesh);
  const islandX = new Float32Array(ISLAND_MAX);
  const islandZ = new Float32Array(ISLAND_MAX);
  scene.add(islands);

  // ---- tracking state
  let started = false;
  let prevX = 0, prevY = 0, prevZ = 0;
  let velX = 0, velZ = 0, speedXZ = 0;
  let hx = 0, hz = -1, headingAng = Math.PI, headingValid = false; // angle convention: (sin a, cos a)
  let cloudY = 0, seaBase = 0, windX = 0, windZ = 0;
  let meteorTimer = 4, meteorP = -1, meteorDur = 1;

  // ---------------------------------------------------------------- zone blend
  let lastA = null, lastB = null, lastQ = -1;

  function applyBlend() {
    fog.near = B.fogNear;
    fog.far = B.fogFar;
    if (renderer) renderer.toneMappingExposure = B.exposure;

    sun.color.copy(B.sunColor);
    sun.intensity = B.sunInt;
    const ce = Math.cos(B.sunEl);
    sunDir.set(-Math.sin(B.sunAz) * ce, Math.sin(B.sunEl), -Math.cos(B.sunAz) * ce).normalize();

    hemi.color.copy(B.hemiSky);
    hemi.groundColor.copy(B.hemiGround);
    hemi.intensity = B.hemiInt;

    const night = smooth01((B.stars - 0.25) / 0.5);
    skyU.uNight.value = night;
    skyU.uSunGlow.value = 1 - 0.65 * night;
    skyU.uHorizonGlow.value = (0.06 + 0.6 * clamp01(1 - B.sunEl / 0.9)) * (1 - 0.7 * night);
    skyU.uStars.value = B.stars;
    skyU.uAurora.value = B.aurora;
    skyU.uNebula.value = B.nebula;
    skyU.uCirrus.value = clamp01(1 - Math.max(B.stars, B.aurora, B.nebula) * 1.6);

    seaU.uFogNear.value = B.fogNear * 1.6;
    seaU.uFogFar.value = Math.min(B.fogFar * 2.1, 700);
    seaU.uSunAmt.value = Math.min(B.sunInt / 2.6, 1.2);
    seaU.uGlow.value = B.glow;

    cloudMat.color.copy(B.cloud);
    cloudMat.emissive.copy(B.cloudEmissive);
    cloudScatter.copy(B.sunColor).multiplyScalar(0.5 * seaU.uSunAmt.value);
    rockMat.color.copy(B.rock);
    topMat.color.copy(B.islandTop);
    topMat.emissive.copy(B.islandEmissive);
  }

  function setZoneBlend(zoneA, zoneB, t) {
    if (!zoneA) return;
    if (!zoneB) zoneB = zoneA;
    let q = Math.round(clamp01(+t || 0) * 1024);
    if (zoneA === zoneB) q = 0;
    if (zoneA === lastA && zoneB === lastB && q === lastQ) return;
    lastA = zoneA; lastB = zoneB; lastQ = q;
    const a = parseZone(zoneA), b = parseZone(zoneB), k = q / 1024;
    for (let i = 0; i < COLOR_KEYS.length; i++) {
      const key = COLOR_KEYS[i];
      B[key].lerpColors(a[key], b[key], k);
    }
    for (let i = 0; i < NUM_KEYS.length; i++) {
      const key = NUM_KEYS[i];
      B[key] = a[key] + (b[key] - a[key]) * k;
    }
    applyBlend();
  }

  // ---------------------------------------------------------------- clouds
  // mode 0: anywhere in the ring (initial scatter); 1: recycle ahead, beyond the fog wall.
  function placeCloud(i, fx, fz, mode) {
    let ang, r;
    if (mode === 1) {
      const rMin = Math.min(Math.max(B.fogFar * 0.92, 200), CLOUD_RMAX - 30);
      r = rMin + Math.random() * (CLOUD_RMAX - 8 - rMin);
      ang = headingValid ? headingAng + (Math.random() * 2 - 1) * 1.2 : Math.random() * TAU;
    } else {
      r = Math.sqrt(CLOUD_RMIN * CLOUD_RMIN + Math.random() * (CLOUD_RMAX * CLOUD_RMAX - CLOUD_RMIN * CLOUD_RMIN));
      ang = Math.random() * TAU;
    }
    const lx = fx + Math.sin(ang) * r - clouds.position.x;
    const lz = fz + Math.cos(ang) * r - clouds.position.z;
    cloudX[i] = lx; cloudZ[i] = lz;

    const sBase = 6 + Math.pow(Math.random(), 1.6) * 11;
    const sx = sBase * (1 + Math.random() * 0.5);
    const sy = sBase * (0.5 + Math.random() * 0.3);
    const sz = sBase * (0.75 + Math.random() * 0.35);
    let y;
    if (Math.random() < 0.55) {
      // below the track: top stays >= 14 m under focus, bottom stays above the cloud sea
      const yMax = -CLOUD_GAP_BELOW - CLOUD_MAXY * sy;
      const yMin = -(SEA_DEPTH - 14) - CLOUD_MINY * sy;
      y = yMin < yMax ? yMin + Math.random() * (yMax - yMin) : yMax;
    } else {
      // above: bottom stays >= 22 m over focus
      y = CLOUD_GAP_ABOVE - CLOUD_MINY * sy + Math.random() * 60;
    }
    _q.setFromAxisAngle(UP, Math.random() * TAU);
    _p.set(lx, y, lz);
    _s.set(sx, sy, sz);
    _m.compose(_p, _q, _s);
    clouds.setMatrixAt(i, _m);
    clouds.setColorAt(i, _c.setScalar(0.88 + Math.random() * 0.12));
    cloudSp[i * 2] = mode === 1 ? envClock : -1e4;
    cloudSp[i * 2 + 1] = ALIVE;
  }

  function scatterClouds(fx, fz) {
    for (let i = 0; i < CLOUD_MAX; i++) placeCloud(i, fx, fz, 0);
    clouds.instanceMatrix.needsUpdate = true;
    clouds.instanceColor.needsUpdate = true;
    cloudSpawn.needsUpdate = true;
  }

  function updateClouds(fx, fz) {
    let dirty = false, spDirty = false;
    const ox = clouds.position.x, oz = clouds.position.z;
    const rMax2 = CLOUD_RMAX * CLOUD_RMAX;
    for (let i = 0; i < CLOUD_MAX; i++) {
      const gone = cloudSp[i * 2 + 1];
      if (gone < ALIVE) { // shrinking out: respawn once fully gone
        if (envClock >= gone) { placeCloud(i, fx, fz, 1); dirty = true; }
        continue;
      }
      const dx = cloudX[i] + ox - fx, dz = cloudZ[i] + oz - fz;
      const d2 = dx * dx + dz * dz;
      if (d2 > rMax2) {
        // may still be on screen (turns, wind): shrink out instead of vanishing
        cloudSp[i * 2 + 1] = envClock + CLOUD_FADE; spDirty = true;
      } else if (headingValid && d2 > 110 * 110 && dx * hx + dz * hz < -0.35 * Math.sqrt(d2)) {
        // behind the chase camera and out of view -> respawn ahead right away
        placeCloud(i, fx, fz, 1); dirty = true;
      }
    }
    if (dirty) {
      clouds.instanceMatrix.needsUpdate = true;
      clouds.instanceColor.needsUpdate = true;
    }
    if (dirty || spDirty) cloudSpawn.needsUpdate = true;
  }

  // ---------------------------------------------------------------- islands
  function placeIsland(i, fx, fz, mode) {
    const gx = islands.position.x, gz = islands.position.z;
    let rx = 0, rz = 0;
    for (let tries = 0; tries < 8; tries++) {
      let ang, r;
      if (mode === 1 && headingValid) {
        // ahead but off-axis, so the slow parallax approach passes by at > ~330 m
        const side = Math.random() < 0.5 ? -1 : 1;
        ang = headingAng + side * (0.6 + Math.random() * 0.9);
        r = 600 + Math.random() * 110;
      } else {
        ang = Math.random() * TAU;
        // keep the forward cone clear / far (heading defaults to -Z, where the track starts)
        const sd = ((ang - headingAng) % TAU + TAU + Math.PI) % TAU - Math.PI; // wrapped to [-PI, PI)
        let da = Math.abs(sd);
        if (da < 0.6) { ang = headingAng + (sd >= 0 ? 0.6 : -0.6); da = 0.6; }
        const rMin = da < 1.2 ? 520 : ISLAND_RMIN;
        r = rMin + Math.random() * (ISLAND_RMAX - rMin);
      }
      rx = Math.sin(ang) * r; rz = Math.cos(ang) * r;
      let ok = true;
      for (let j = 0; j < ISLAND_MAX; j++) {
        if (j === i) continue;
        const ox = islandX[j] + gx - fx - rx, oz = islandZ[j] + gz - fz - rz;
        if (ox * ox + oz * oz < 150 * 150) { ok = false; break; }
      }
      if (ok) break;
    }
    const lx = fx + rx - gx, lz = fz + rz - gz;
    islandX[i] = lx; islandZ[i] = lz;

    const high = Math.random() < 0.3;
    const sxz = (16 + Math.random() * 34) * (high ? 0.7 : 1);
    const sy = sxz * (0.75 + Math.random() * 0.5);
    const y = high ? 30 + Math.random() * 70 : -(26 + Math.random() * 55);
    _q.setFromAxisAngle(UP, Math.random() * TAU);
    _p.set(lx, y, lz);
    _s.set(sxz, sy, sxz);
    _m.compose(_p, _q, _s);
    rockMesh.setMatrixAt(i, _m);
    topMesh.setMatrixAt(i, _m);
    islandSp[i * 2] = mode === 1 ? envClock : -1e4;
    islandSp[i * 2 + 1] = ALIVE;
  }

  function scatterIslands(fx, fz) {
    // mark everything far away first so spacing checks ignore stale slots
    for (let i = 0; i < ISLAND_MAX; i++) { islandX[i] = 1e7; islandZ[i] = 1e7; }
    for (let i = 0; i < ISLAND_MAX; i++) placeIsland(i, fx, fz, 0);
    rockMesh.instanceMatrix.needsUpdate = true;
    topMesh.instanceMatrix.needsUpdate = true;
    islandSpawn.needsUpdate = true;
  }

  function updateIslands(fx, fz) {
    let dirty = false, spDirty = false;
    const gx = islands.position.x, gz = islands.position.z;
    for (let i = 0; i < ISLAND_MAX; i++) {
      const gone = islandSp[i * 2 + 1];
      if (gone < ALIVE) { // sinking into the haze: respawn once fully gone
        if (envClock >= gone) { placeIsland(i, fx, fz, 1); dirty = true; }
        continue;
      }
      const dx = islandX[i] + gx - fx, dz = islandZ[i] + gz - fz;
      const d2 = dx * dx + dz * dz;
      if (d2 > 760 * 760 || d2 < 320 * 320) {
        // likely on screen (winding track): fade out (~24 m more approach at most)
        islandSp[i * 2 + 1] = envClock + ISLAND_FADE; spDirty = true;
      } else if (headingValid && d2 > 420 * 420 && dx * hx + dz * hz < -0.3 * Math.sqrt(d2)) {
        placeIsland(i, fx, fz, 1); dirty = true; // behind -> respawn ahead right away
      }
    }
    if (dirty) {
      rockMesh.instanceMatrix.needsUpdate = true;
      topMesh.instanceMatrix.needsUpdate = true;
    }
    if (dirty || spDirty) islandSpawn.needsUpdate = true;
  }

  // ---------------------------------------------------------------- meteors
  function updateMeteor(dt, camera) {
    const mA = skyU.uMeteorA.value, mB = skyU.uMeteorB.value;
    if (meteorP >= 0) {
      meteorP += dt / meteorDur;
      if (meteorP >= 1) { meteorP = -1; mA.w = -1; } else mA.w = Math.max(meteorP, 1e-4);
      return;
    }
    if (B.stars < 0.3) return;
    meteorTimer -= dt;
    if (meteorTimer > 0) return;
    meteorTimer = (2.5 + Math.random() * 6) / B.stars;
    // spawn inside the current view: forward on the horizon plane
    let fx = 0, fz = -1;
    if (camera) {
      camera.getWorldDirection(_v1);
      const l = Math.hypot(_v1.x, _v1.z);
      if (l > 1e-3) { fx = _v1.x / l; fz = _v1.z / l; }
    }
    const rx = -fz, rz = fx; // right vector
    const yaw = (Math.random() * 2 - 1) * 0.65;
    const el = 0.3 + Math.random() * 0.45;
    const ce = Math.cos(el), cy = Math.cos(yaw), sy = Math.sin(yaw);
    _v1.set((fx * cy + rx * sy) * ce, Math.sin(el), (fz * cy + rz * sy) * ce).normalize();
    const side = Math.random() < 0.5 ? -1 : 1;
    _v2.set(rx * side, -0.45 - Math.random() * 0.35, rz * side);
    _v2.addScaledVector(_v1, -_v2.dot(_v1)).normalize();
    mA.set(_v1.x, _v1.y, _v1.z, 1e-4);
    mB.set(_v2.x, _v2.y, _v2.z, 0.35 + Math.random() * 0.3);
    meteorDur = 0.65 + Math.random() * 0.5;
    meteorP = 0;
  }

  // ---------------------------------------------------------------- per frame
  function reinit(focus) {
    prevX = focus.x; prevY = focus.y; prevZ = focus.z;
    velX = velZ = speedXZ = 0;
    headingValid = false;
    cloudY = focus.y;
    seaBase = focus.y;
    clouds.position.set(windX, cloudY, windZ);
    islands.position.set(focus.x * ISLAND_PARALLAX, seaBase, focus.z * ISLAND_PARALLAX);
    scatterClouds(focus.x, focus.z);
    scatterIslands(focus.x, focus.z);
    started = true;
  }

  function update(dt, time, focus, camera) {
    if (!focus) return;
    dt = dt > 0 ? Math.min(dt, 0.1) : 0;
    const fx = focus.x, fy = focus.y, fz = focus.z;
    envClock += dt;
    clockU.value = envClock;

    // teleports (restart) re-seed everything; small jumps (respawn) are absorbed by smoothing
    if (!started) reinit(focus);
    else {
      const jx = fx - prevX, jy = fy - prevY, jz = fz - prevZ;
      const j2 = jx * jx + jy * jy + jz * jz;
      if (j2 > 300 * 300) reinit(focus);
      else if (dt > 0 && jx * jx + jz * jz < 40 * 40) {
        const k = 1 - Math.exp(-dt * 1.5);
        velX += (jx / dt - velX) * k;
        velZ += (jz / dt - velZ) * k;
      }
    }
    prevX = fx; prevY = fy; prevZ = fz;
    speedXZ = Math.hypot(velX, velZ);
    headingValid = speedXZ > 3;
    if (speedXZ > 1e-3) { hx = velX / speedXZ; hz = velZ / speedXZ; headingAng = Math.atan2(hx, hz); }

    // sky follows the camera
    if (camera) sky.position.copy(camera.position);
    else sky.position.copy(focus);
    skyU.uTime.value = time;
    skyU.uStarRot.value = time * 0.004;
    updateMeteor(dt, camera);

    // sun + shadow camera: follow (slightly ahead of) focus, snapped to the shadow texel grid
    const lead = Math.min(speedXZ / 12, 1) * SHADOW_LEAD;
    _v1.set(fx + hx * lead, fy, fz + hz * lead);
    _lx.crossVectors(UP, sunDir);
    if (_lx.lengthSq() < 1e-8) _lx.set(1, 0, 0); else _lx.normalize();
    _ly.crossVectors(sunDir, _lx); // matches the shadow camera's lookAt basis (up = +Y)
    const px = Math.round(_v1.dot(_lx) / SHADOW_TEXEL) * SHADOW_TEXEL;
    const py = Math.round(_v1.dot(_ly) / SHADOW_TEXEL) * SHADOW_TEXEL;
    const pz = _v1.dot(sunDir);
    sun.target.position.set(0, 0, 0)
      .addScaledVector(_lx, px).addScaledVector(_ly, py).addScaledVector(sunDir, pz);
    sun.position.copy(sun.target.position).addScaledVector(sunDir, SHADOW_DIST);

    // cloud sea: lags focus.y so falls visibly approach it; XZ snapped to the grid
    seaBase += (fy - seaBase) * (1 - Math.exp(-dt * 0.4));
    if (seaBase < fy - 150) seaBase = fy - 150; else if (seaBase > fy + 150) seaBase = fy + 150;
    sea.position.set(Math.round(fx / SEA_SNAP) * SEA_SNAP, seaBase - SEA_DEPTH, Math.round(fz / SEA_SNAP) * SEA_SNAP);
    seaU.uTime.value = time;

    // floating clouds: whole layer drifts with the wind and follows focus.y (clamped lag)
    cloudY += (fy - cloudY) * (1 - Math.exp(-dt * 0.8));
    if (cloudY < fy - CLOUD_FOLLOW_CLAMP) cloudY = fy - CLOUD_FOLLOW_CLAMP;
    else if (cloudY > fy + CLOUD_FOLLOW_CLAMP) cloudY = fy + CLOUD_FOLLOW_CLAMP;
    windX += WIND_X * dt;
    windZ += WIND_Z * dt;
    clouds.position.set(windX, cloudY, windZ);
    updateClouds(fx, fz);

    // islands: parallax layer riding with the cloud sea
    islands.position.set(fx * ISLAND_PARALLAX, seaBase, fz * ISLAND_PARALLAX);
    updateIslands(fx, fz);
  }

  // ---------------------------------------------------------------- quality
  function setDefine(mat, name, on) {
    const has = Object.prototype.hasOwnProperty.call(mat.defines, name);
    if (on === has) return;
    if (on) mat.defines[name] = 1; else delete mat.defines[name];
    mat.needsUpdate = true;
  }

  function setQuality(q) {
    quality = q === 'low' ? 'low' : 'high';
    const high = quality === 'high';
    sun.castShadow = high;
    clouds.count = high ? CLOUD_MAX : CLOUD_LOW;
    rockMesh.count = topMesh.count = high ? ISLAND_MAX : ISLAND_LOW;
    setDefine(skyMat, 'LOW', !high);
    setDefine(seaMat, 'LOW', !high);
  }

  function getFogColor() {
    return fog.color;
  }

  function dispose() {
    scene.remove(sky, sea, clouds, islands, hemi, sun, sun.target);
    if (scene.fog === fog) scene.fog = null;
    skyGeo.dispose(); skyMat.dispose(); noiseTex.dispose();
    seaGeo.dispose(); seaMat.dispose();
    clouds.geometry.dispose(); cloudMat.dispose(); clouds.dispose();
    rockMesh.geometry.dispose(); topMesh.geometry.dispose();
    rockMat.dispose(); topMat.dispose();
    rockMesh.dispose(); topMesh.dispose();
    sun.dispose(); hemi.dispose();
  }

  // ---- initial state (valid before the first update / setZoneBlend)
  setQuality(quality);
  setZoneBlend(ZONES[0], ZONES[0], 0);
  _v1.set(0, 0, 0);
  reinit(_v1);
  started = false; // re-seed around the real focus on the first update

  return { sun, update, setZoneBlend, setQuality, getFogColor, dispose };
}
