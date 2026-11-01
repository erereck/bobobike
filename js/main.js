// bobobike — bootstrap, game loop, camera, input and run state.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CONFIG, VEHICLE_STATS, VEHICLE_ORDER, SKINS, SKIN_BY_ID, MODES, gradeFor } from './config.js';
import { zoneAt } from './themes.js';
import { createTrack } from './track.js';
import { createPlayer } from './player.js';
import { createVehicle } from './vehicles.js';
import { createEnvironment } from './environment.js';
import { createAudio } from './audio.js';
import { createFX } from './fx.js';
import { createUI } from './ui.js';

const STEP = 1 / 120;
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerpAngle = (a, b, t) => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
  return a + d * t;
};

// ------------------------------------------------------------ persistence
const store = {
  bestDistance: 0, bestAvgKmh: 0, bestTopKmh: 0, runs: 0, infBestDistance: 0, infBestAvgKmh: 0,
  vehicle: 'bike', skin: 'noob', mode: 'normal', muted: false, haptics: true, quality: null,
};
try { Object.assign(store, JSON.parse(localStorage.getItem(CONFIG.storageKey) || '{}')); } catch (e) { /* storage blocked */ }
function save() { try { localStorage.setItem(CONFIG.storageKey, JSON.stringify(store)); } catch (e) { /* ignore */ } }
// corrupt/old saves: a NaN record would block every future record ("x > NaN" is always false)
for (const k of ['bestDistance', 'bestAvgKmh', 'bestTopKmh', 'runs', 'infBestDistance', 'infBestAvgKmh']) { const v = +store[k]; store[k] = Number.isFinite(v) && v > 0 ? v : 0; }
if (store.quality !== 'high' && store.quality !== 'low') store.quality = null;
if (!Object.prototype.hasOwnProperty.call(VEHICLE_STATS, store.vehicle)) store.vehicle = 'bike';
if (!Object.prototype.hasOwnProperty.call(MODES, store.mode)) store.mode = 'normal';
store.haptics = store.haptics !== false;
// best distance of the mode being played (infinite runs keep separate records)
const modeRecord = (mode) => (mode === 'infinite' ? store.infBestDistance : store.bestDistance);
if (!Object.prototype.hasOwnProperty.call(SKIN_BY_ID, store.skin)) store.skin = 'noob';
const skinUnlocked = (sk) => !!sk && store.bestDistance >= sk.unlock;
if (!skinUnlocked(SKIN_BY_ID[store.skin])) store.skin = 'noob';

const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
let touchMode = coarse;
let quality = store.quality || (coarse ? 'low' : 'high');

// ------------------------------------------------------------ boot
const ui = createUI();
ui.setLoading(0.1);

let renderer, scene, camera, composer = null, bloom = null, env, track, player, rig = null, fx, audio;
const container = document.getElementById('game');

try {
  // with the bloom composer on, the canvas only shows a fullscreen quad, so MSAA lives in the composer target
  renderer = new THREE.WebGLRenderer({ antialias: quality === 'low', powerPreference: 'high-performance' });
} catch (e) {
  showFatal('Seu navegador não conseguiu iniciar o WebGL. Tente outro navegador ou ative a aceleração de hardware.');
  throw e;
}
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = quality === 'high';
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

scene = new THREE.Scene();
camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 1400);
camera.position.set(0, 4, 8);

env = createEnvironment({ scene, renderer, quality });
track = createTrack({ scene });
fx = createFX({ scene, camera, quality });
audio = createAudio();
audio.setMuted(!!store.muted);
ui.setMuted(!!store.muted);
ui.setQuality(quality);
ui.setLoading(0.4);

const runState = {
  time: 0, coins: 0, tricks: 0, falls: 0, checkpoints: 0, topSpeed: 0,
  samples: [], nextSample: 10, recordBeaten: false, lives: CONFIG.startLives,
  deadTimer: 0, cd: 0, cdShown: 0, zoneShown: 0, recordAtStart: 0, skinToasts: new Set(), mode: 'normal',
};

player = createPlayer(track, onPlayerEvent);

let maxPR = 1.5;
let pixelRatio = 1;
let prCeil = 1.5; // adaptive resolution never climbs back to a level that was measured too slow
function applyQuality() {
  const high = quality === 'high';
  renderer.shadowMap.enabled = high;
  track.setShadows(high);
  env.setQuality(quality);
  fx.setQuality(quality);
  // phones have dense screens: 1.0 looks blurry there, so low quality allows a little more on touch devices
  maxPR = high ? Math.min(window.devicePixelRatio || 1, 1.6) : Math.min(window.devicePixelRatio || 1, coarse ? 1.3 : 1);
  pixelRatio = maxPR;
  prCeil = maxPR;
  renderer.setPixelRatio(pixelRatio);
  if (high && !composer) {
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.45, 0.86);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  } else if (!high && composer) {
    if (bloom) bloom.dispose(); // EffectComposer.dispose() does not free its passes' render targets
    composer.dispose();
    composer = null; bloom = null;
  }
  onResize();
}
function onResize() {
  const w = innerWidth, h = innerHeight;
  if (!w || !h) return; // hidden/minimized views report 0: keep the last size (zero-size targets break the composer)
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (composer) { composer.setPixelRatio(pixelRatio); composer.setSize(w, h); }
}
window.addEventListener('resize', onResize);
// some phones report the new size only after the rotation animation
window.addEventListener('orientationchange', () => setTimeout(onResize, 250));
// iOS Safari: no pinch-zoom / double-tap zoom while playing
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

function setVehicle(id) {
  if (rig) { scene.remove(rig.group); rig.dispose(); }
  rig = createVehicle(id, { skin: SKIN_BY_ID[store.skin] });
  rig.group.rotation.order = 'YXZ';
  scene.add(rig.group);
  player.setStats(VEHICLE_STATS[id]);
  store.vehicle = id;
  save();
}

function newSeed() { return (Math.random() * 0xffffffff) >>> 0; }
// dev/test hook: ?only=pieceA,pieceB builds the track from those pieces only
const ONLY = (() => { try { const v = new URLSearchParams(location.search).get('only'); return v ? { only: v.split(',') } : null; } catch (e) { return null; } })();

// ------------------------------------------------------------ input
const keys = new Set();
let jumpEdge = false, prevTouchJump = false, prevPadJump = false, prevPadStart = false;
const GAME_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);
const input = { steer: 0, throttle: 0, brake: 0, boost: false, flip: false, spin: false, jumpPressed: false };

window.addEventListener('keydown', (e) => {
  if (GAME_KEYS.has(e.code) && state !== 'menu') e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'Space' || e.code === 'KeyW' || e.code === 'ArrowUp') audio.unlock();
  if (e.code === 'Space') jumpEdge = true;
  if (e.code === 'KeyM') toggleMute();
  if ((state === 'play' || state === 'countdown' || state === 'dead') && (e.code === 'Escape' || e.code === 'KeyP')) pause();
  else if (state === 'paused' && e.code === 'KeyP') resume();
  if (state === 'play' && e.code === 'KeyR') player.die('reset');
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => { keys.clear(); pause(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
window.addEventListener('touchstart', () => {
  audio.unlock();
  // the touch layer only shows on the HUD screen, so enabling it while dead/paused is safe; without it a
  // first touch during death/pause left auto-throttle on with no on-screen buttons until the next run
  if (!touchMode) { touchMode = true; if (state !== 'menu' && state !== 'over' && state !== 'loading') ui.setTouch(true); }
}, { passive: true });
window.addEventListener('pointerdown', () => audio.unlock());

// Roblox-style camera: hold the right mouse button and drag to orbit, mouse wheel to zoom.
let rmbDown = false, orbitYaw = 0, orbitPitch = 0, camZoom = 1, lastOrbitInput = -10;
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('pointerdown', (e) => {
  if (e.button !== 2 || e.pointerType !== 'mouse') return;
  rmbDown = true;
  lastOrbitInput = wallTime;
  document.body.style.cursor = 'grabbing';
});
const endOrbit = (e) => {
  if (!rmbDown || (e.button !== undefined && e.button !== 2 && e.type === 'pointerup')) return;
  rmbDown = false;
  lastOrbitInput = wallTime;
  document.body.style.cursor = '';
};
window.addEventListener('pointerup', endOrbit);
window.addEventListener('blur', endOrbit);
window.addEventListener('pointermove', (e) => {
  if (!rmbDown) return;
  if ((e.buttons & 2) === 0) { endOrbit(e); return; }
  lastOrbitInput = wallTime;
  if (state === 'menu') { orbitA -= e.movementX * 0.006; return; }
  orbitYaw -= e.movementX * 0.006;
  // keep in (-PI, PI]: after circling the rider several times the camera must not unwind every turn
  if (orbitYaw > Math.PI) orbitYaw -= TAU; else if (orbitYaw < -Math.PI) orbitYaw += TAU;
  orbitPitch = clamp(orbitPitch + e.movementY * 0.004, -0.45, 0.9);
});
window.addEventListener('wheel', (e) => {
  if (state === 'over' || state === 'paused') return; // let menus scroll
  // scale by the delta: a trackpad sends dozens of tiny events per swipe (a fixed x1.1 each slammed
  // the zoom to its limit) and horizontal swipes (deltaY 0) used to zoom in
  const d = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
  if (!d) return;
  camZoom = clamp(camZoom * Math.exp(clamp(d, -120, 120) * 0.001), 0.6, 1.9);
}, { passive: true });

let padSeen = false;
window.addEventListener('gamepadconnected', () => { padSeen = true; });

function readInput() {
  const k = keys;
  let steer = 0;
  if (k.has('KeyA') || k.has('ArrowLeft')) steer -= 1;
  if (k.has('KeyD') || k.has('ArrowRight')) steer += 1;
  let throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
  let brake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
  let boost = k.has('ShiftLeft') || k.has('ShiftRight');
  let flip = k.has('KeyQ');
  let spin = k.has('KeyE');
  if (touchMode) {
    const t = ui.touch;
    steer += +t.steer || 0;
    throttle = Math.max(throttle, clamp(+t.throttle || 0, 0, 1));
    brake = Math.max(brake, clamp(+t.brake || 0, 0, 1));
    boost = boost || !!t.boost;
    flip = flip || !!t.flip;
    spin = spin || !!t.spin;
    if (t.jump && !prevTouchJump) jumpEdge = true;
    prevTouchJump = !!t.jump;
  }
  // getGamepads() returns a fresh array every call: only poll once a pad has announced itself
  const pads = padSeen && navigator.getGamepads ? navigator.getGamepads() : null;
  let gp = null; // Windows may put the pad at index 2/3 (other XInput devices, reconnects)
  if (pads) for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) { gp = pads[i]; break; }
  if (gp) {
    const ax = gp.axes[0] || 0;
    if (Math.abs(ax) > 0.15) steer += ax;
    const b = gp.buttons;
    const rt = b[7] ? b[7].value : 0, lt = b[6] ? b[6].value : 0;
    if (rt > 0.05) throttle = Math.max(throttle, rt);
    if (lt > 0.05) brake = Math.max(brake, lt);
    if (b[2]?.pressed || b[5]?.pressed) boost = true;
    if (b[3]?.pressed) flip = true;
    if (b[1]?.pressed) spin = true;
    const pj = !!b[0]?.pressed;
    if (pj && !prevPadJump) {
      audio.unlock();
      if (state === 'menu') startRun(false);
      // like the keyboard, ignore A for a moment so jump-mashing while dying does not skip the report
      else if (state === 'over') { if (wallTime - overAt > 0.8) startRun(true); }
      else if (state === 'paused') resume(); // no jumpEdge: resuming must not also jump (e.g. off a beam)
      else jumpEdge = true;
    }
    prevPadJump = pj;
    const ps = !!b[9]?.pressed;
    if (ps && !prevPadStart) { if (state === 'paused') resume(); else pause(); }
    prevPadStart = ps;
  }
  if (ui.consumeCameraDrag) {
    const d = ui.consumeCameraDrag();
    if (d && (d.dx || d.dy)) {
      lastOrbitInput = wallTime;
      if (state === 'menu') orbitA -= d.dx * 0.008;
      else {
        orbitYaw -= d.dx * 0.008;
        if (orbitYaw > Math.PI) orbitYaw -= TAU; else if (orbitYaw < -Math.PI) orbitYaw += TAU;
        orbitPitch = clamp(orbitPitch + d.dy * 0.005, -0.45, 0.9);
      }
    }
  }
  input.steer = clamp(steer, -1, 1);
  input.throttle = throttle;
  input.brake = brake;
  input.boost = boost;
  input.flip = flip;
  input.spin = spin;
}

// ------------------------------------------------------------ phone helpers
// Vibration only on touch devices (navigator.vibrate is a no-op elsewhere / on iOS).
function buzz(pattern) {
  if (!store.haptics || !touchMode || !navigator.vibrate) return;
  try { navigator.vibrate(pattern); } catch (e) { /* ignore */ }
}
// Keep the screen awake while racing.
let wakeLock = null, wakeWanted = false;
async function setWake(on) {
  wakeWanted = on;
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      const l = await navigator.wakeLock.request('screen');
      if (!wakeWanted) { l.release(); return; }
      wakeLock = l;
      l.addEventListener('release', () => { if (wakeLock === l) wakeLock = null; });
    } else if (!on && wakeLock) {
      const l = wakeLock; wakeLock = null; await l.release();
    }
  } catch (e) { /* denied or unsupported */ }
}
async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      try { await screen.orientation.lock('landscape'); } catch (e) { /* not allowed on this device */ }
    } else {
      await document.exitFullscreen();
    }
  } catch (e) { /* fullscreen refused */ }
}

// ------------------------------------------------------------ game state
let state = 'loading';
let prevState = 'play';
let overAt = -10; // wallTime when the game-over report appeared
let simTime = 0;
let camYaw = 0;
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
let camFov = 70;
let shake = 0;
let orbitA = 0.6;
let blinkT = 0;
let lastOpacity = 1;
let pendingImpact = 0;
let speedSmooth = 0;
const rPos = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const deathPos = new THREE.Vector3();

function resetRunState() {
  Object.assign(runState, {
    time: 0, coins: 0, tricks: 0, falls: 0, checkpoints: 0, topSpeed: 0,
    samples: [], nextSample: 10, recordBeaten: false, lives: CONFIG.startLives,
    deadTimer: 0, cd: 3.4, cdShown: 0, zoneShown: 0, recordAtStart: modeRecord(store.mode), skinToasts: new Set(),
    mode: store.mode,
  });
}

function preparePlayer() {
  player.reset(track.startSpawn);
  player.maxProgress = 0;
  player.progress = 0;
  player.checkpoint = null;
  player.turbo = 0.4;
  blinkT = 0; // a leftover respawn blink would keep flickering the rider in the menu / next countdown
  if (rig) { rig.reset(); rig.setOpacity(1); lastOpacity = 1; }
}

function toMenu() {
  bankRun();
  runLive = false;
  state = 'menu';
  setWake(false);
  track.reset(newSeed(), modeRecord(store.mode), ONLY);
  preparePlayer();
  fx.clear();
  ui.setTouch(false);
  ui.setRecords(recordsForUI());
  if (ui.setSkins) ui.setSkins(SKINS, store.skin, store.bestDistance);
  ui.showScreen('menu');
}

function startRun(newTrack) {
  audio.unlock();
  bankRun();
  runLive = true;
  ftCount = 0; lowFpsTime = 0; // judge performance after the track-rebuild hitch has left the average
  if (newTrack) track.reset(newSeed(), modeRecord(store.mode), ONLY);
  preparePlayer();
  resetRunState();
  fx.clear();
  camYaw = player.yaw;
  ui.showScreen('hud');
  ui.setTouch(touchMode);
  state = 'countdown';
  setWake(true);
  audio.startMusic();
  audio.setZone(0);
}

function pause() {
  // 'dead' too: otherwise alt-tab/Esc during the 1.8 s death respawns into a run nobody is watching
  if (state !== 'play' && state !== 'countdown' && state !== 'dead') return;
  prevState = state;
  state = 'paused';
  keys.clear();
  ui.showScreen('pause');
  setWake(false);
  bankRun(); // a backgrounded mobile tab may be killed while paused
}
function resume() {
  if (state !== 'paused') return;
  state = prevState;
  ui.showScreen('hud');
  setWake(true);
}

function toggleMute() {
  store.muted = !store.muted;
  audio.setMuted(store.muted);
  ui.setMuted(store.muted);
  save();
}
function toggleQuality(persist = true) {
  quality = quality === 'high' ? 'low' : 'high';
  if (persist) { store.quality = quality; save(); } // the automatic downgrade only lasts this session
  applyQuality();
  ui.setQuality(quality);
}

function recordsForUI() {
  return {
    bestDistance: store.bestDistance, bestAvgKmh: store.bestAvgKmh, bestTopKmh: store.bestTopKmh, runs: store.runs,
    infBestDistance: store.infBestDistance, infBestAvgKmh: store.infBestAvgKmh,
  };
}

const TRICK_NAMES = ['', 'MORTAL', 'MORTAL DUPLO', 'MORTAL TRIPLO'];
function trickName(flips, spins) {
  const parts = [];
  if (flips > 0) parts.push(TRICK_NAMES[flips] || `MORTAL x${flips}`);
  if (spins > 0) parts.push(`${spins * 360}`);
  return parts.join(' + ') + '!';
}

function onPlayerEvent(type, data) {
  const pos = player.pos;
  switch (type) {
    case 'jump':
      audio.play('jump');
      fx.burst('dust', pos, { intensity: 0.35 });
      break;
    case 'land':
      pendingImpact = Math.max(pendingImpact, data);
      if (data > 0.45) buzz(Math.round(10 + data * 25));
      if (data > 0.12) {
        audio.play('land', { intensity: data });
        fx.burst('dust', pos, { intensity: data });
        shake = Math.max(shake, data * 0.35);
      }
      break;
    case 'bonk':
      audio.play('land', { intensity: 1 });
      buzz(35);
      fx.burst('sparks', tmpV.copy(pos).setY(pos.y + 0.8), { color: '#ffffff', count: 20 });
      shake = Math.max(shake, 0.6);
      break;
    case 'boostPad':
      audio.play('boost');
      buzz(10);
      fx.burst('boost', pos);
      shake = Math.max(shake, 0.12);
      break;
    case 'jumpPad':
      audio.play('jumppad');
      buzz(18);
      fx.burst('ring', pos, { color: '#7dff6b' });
      break;
    case 'checkpoint':
      if (data.cp > 0) {
        track.activateCheckpoint(data);
        runState.checkpoints++;
        buzz([15, 40, 25]);
        if (runState.mode !== 'infinite' && runState.checkpoints % CONFIG.lifeEveryCheckpoints === 0 && runState.lives < CONFIG.maxLives) {
          runState.lives++;
          ui.toast('+1 VIDA!', 'good');
          audio.play('coin');
          fx.burst('stars', tmpV.copy(pos).setY(pos.y + 1.6));
        }
        ui.checkpoint(data.cp);
        audio.play('checkpoint');
        fx.burst('confetti', tmpV.copy(pos).setY(pos.y + 2.5), { count: 140 });
        fx.burst('ring', pos, { color: '#2bd96b' });
      }
      break;
    case 'crumble':
      break;
    case 'bounce':
      audio.play('jumppad');
      buzz(15);
      fx.burst('ring', pos, { color: '#ff4fa3' });
      break;
    case 'nearMiss':
      audio.play('whoosh');
      ui.toast('QUASE! +TURBO', 'good');
      break;
    case 'trick': {
      const n = data.flips + data.spins;
      runState.tricks += n;
      ui.toast(trickName(data.flips, data.spins), 'trick');
      ui.toast(`+TURBO`, 'good');
      audio.play('trick', { level: Math.min(4, n) });
      buzz(20);
      fx.burst('stars', tmpV.copy(pos).setY(pos.y + 1));
      break;
    }
    case 'trickFail':
      ui.toast('ATERRISSOU TORTO', 'bad');
      audio.play('trickFail');
      shake = Math.max(shake, 0.4);
      break;
    case 'dead':
      onDeath(data);
      break;
  }
}

function onDeath(reason) {
  if (state !== 'play') return;
  state = 'dead';
  runState.deadTimer = 0;
  // R ("voltar ao checkpoint") is free: on the last life it used to end the run under a "VOLTANDO..." toast
  if (reason !== 'reset') { runState.falls++; if (runState.mode !== 'infinite') runState.lives--; }
  buzz([40, 30, 70]);
  deathPos.copy(player.pos);
  rig.breakApart(tmpV.copy(player.vel));
  audio.play('oof');
  ui.flashDamage();
  ui.toast(reason === 'fall' ? 'CAIU!' : reason === 'reset' ? 'VOLTANDO...' : 'OOF!', 'bad');
  if (reason === 'kill') fx.burst('sparks', tmpV.copy(player.pos).setY(player.pos.y + 1), { color: '#ff2a3d', count: 40 });
  if (reason === 'fall') fx.burst('puff', tmpV.copy(player.pos));
  shake = Math.max(shake, 0.5);
}

function respawn() {
  const sp = player.checkpoint ? player.checkpoint.spawn : track.startSpawn;
  const cp = player.checkpoint;
  player.reset(sp);
  player.checkpoint = cp;
  track.respawnReset();
  rig.reset();
  blinkT = 1.3;
  camYaw = player.yaw;
  state = 'play';
  audio.play('respawn');
  if (runState.mode !== 'infinite') ui.toast(runState.lives === 1 ? 'ÚLTIMA VIDA!' : `${runState.lives} VIDAS`, 'info');
}

// A run that is abandoned (pause -> menu/restart) or whose tab is closed/killed while paused still
// keeps its distance + top speed, so skins announced as unlocked mid-run stay unlocked.
// The average record still needs a finished run.
let runLive = false;
function bankRun() {
  if (!runLive) return;
  const top = runState.topSpeed * 3.6;
  let changed = false;
  if (runState.mode === 'infinite') {
    if (player.maxProgress > store.infBestDistance) { store.infBestDistance = player.maxProgress; changed = true; }
  } else if (player.maxProgress > store.bestDistance) { store.bestDistance = player.maxProgress; changed = true; }
  if (top > store.bestTopKmh) { store.bestTopKmh = top; changed = true; }
  if (changed) save();
}

function gameOver() {
  state = 'over';
  runLive = false;
  overAt = wallTime;
  const dist = player.maxProgress;
  const time = Math.max(0.001, runState.time);
  const avgKmh = (dist / time) * 3.6;
  const topKmh = runState.topSpeed * 3.6;
  const prevRecord = runState.recordAtStart; // store.bestDistance may already hold this run's banked distance
  const isNewRecord = dist > prevRecord && dist > 1;
  const qualifiesAvg = dist >= 150;
  const inf = runState.mode === 'infinite';
  const bestAvgBefore = inf ? store.infBestAvgKmh : store.bestAvgKmh;
  const isNewAvg = qualifiesAvg && avgKmh > bestAvgBefore;
  // skins only unlock from normal-mode distance
  const unlockedSkins = inf ? [] : SKINS.filter((sk) => sk.unlock > prevRecord && sk.unlock <= dist).map((sk) => sk.name);
  if (inf) {
    if (dist > store.infBestDistance) store.infBestDistance = dist;
    if (isNewAvg) store.infBestAvgKmh = avgKmh;
  } else {
    if (dist > store.bestDistance) store.bestDistance = dist;
    if (isNewAvg) store.bestAvgKmh = avgKmh;
  }
  if (topKmh > store.bestTopKmh) store.bestTopKmh = topKmh;
  store.runs++;
  save();
  const grade = gradeFor(avgKmh);
  let hint = '';
  const gi = CONFIG.grades.findIndex((g) => g.grade === grade);
  if (gi > 0) {
    const next = CONFIG.grades[gi - 1];
    hint = `Mantenha ${next.min} km/h de média para nota ${next.grade}`;
  } else hint = 'Nota máxima! Agora é bater a distância.';
  if (!qualifiesAvg) hint = 'Corra pelo menos 150 m para valer recorde de média.';
  ui.setTouch(false);
  setWake(false);
  if (isNewRecord) buzz([30, 50, 30, 50, 60]);
  ui.showGameOver({
    distance: dist, record: isNewRecord ? dist : prevRecord, isNewRecord,
    avgKmh, bestAvgKmh: inf ? store.infBestAvgKmh : store.bestAvgKmh, isNewAvgRecord: isNewAvg, mode: runState.mode,
    topKmh, time, tricks: runState.tricks, coins: runState.coins, falls: runState.falls,
    checkpoints: runState.checkpoints, grade, speedSamples: runState.samples.slice(),
    vehicleName: player.stats.name, nextGradeHint: hint, unlockedSkins,
  });
  ui.setRecords(recordsForUI());
  if (ui.setSkins) ui.setSkins(SKINS, store.skin, store.bestDistance);
  // showGameOver already switched to the report screen (and sized its chart)
  audio.play(isNewRecord ? 'record' : 'gameover');
}

const onRing = (r) => {
  player.turbo = Math.min(1, player.turbo + 0.2);
  audio.play('boost');
  buzz(12);
  fx.burst('ring', tmpV2.set(r.x, r.y, r.z), { color: '#7df9ff' });
  fx.burst('stars', tmpV2);
};

const onCoin = (c) => {
  runState.coins++;
  player.turbo = Math.min(1, player.turbo + 0.045);
  audio.play('coin');
  fx.burst('coin', tmpV2.set(c.x, c.y, c.z));
};

// ------------------------------------------------------------ UI wiring
ui.setVehicles(VEHICLE_ORDER.map((id) => VEHICLE_STATS[id]), store.vehicle);
ui.setRecords(recordsForUI());
ui.on('sfx', (name) => audio.play(name));
ui.on('vehicle', (id) => { if (VEHICLE_STATS[id] && id !== store.vehicle) setVehicle(id); });
ui.on('skin', (id) => {
  const sk = SKIN_BY_ID[id];
  if (!skinUnlocked(sk) || id === store.skin) return;
  store.skin = id;
  save();
  if (rig && rig.setSkin) rig.setSkin(sk); else setVehicle(store.vehicle);
  if (ui.setSkins) ui.setSkins(SKINS, store.skin, store.bestDistance);
});
if (ui.setSkins) ui.setSkins(SKINS, store.skin, store.bestDistance);
ui.on('play', () => { audio.unlock(); if (state === 'menu') startRun(false); });
ui.on('restart', () => { if (state === 'over' || state === 'paused') startRun(true); });
ui.on('menu', () => toMenu());
ui.on('resume', () => resume());
ui.on('pause', () => pause());
ui.on('mute', () => { audio.unlock(); toggleMute(); });
ui.on('quality', () => toggleQuality());
if (ui.setMode) ui.setMode(store.mode);
if (ui.setHaptics) ui.setHaptics(store.haptics);
ui.on('mode', (id) => {
  if (!Object.prototype.hasOwnProperty.call(MODES, id) || id === store.mode) return;
  store.mode = id;
  save();
  if (ui.setMode) ui.setMode(id);
  // the menu track carries the record gate of the selected mode
  if (state === 'menu') { track.reset(newSeed(), modeRecord(id), ONLY); preparePlayer(); }
});
ui.on('end', () => { if (runLive && (state === 'paused' || state === 'play' || state === 'dead' || state === 'countdown')) gameOver(); });
ui.on('haptics', (v) => {
  store.haptics = typeof v === 'boolean' ? v : !store.haptics;
  save();
  if (ui.setHaptics) ui.setHaptics(store.haptics);
  buzz(25);
});
ui.on('fullscreen', () => toggleFullscreen());

// ------------------------------------------------------------ camera
function updateCamera(dt, pos, yaw) {
  const st = player.stats;
  const spd = player.speed;
  const sp01 = clamp(spd / st.maxSpeed, 0, 1.4);
  const fwdX = -Math.sin(yaw), fwdZ = -Math.cos(yaw);

  // orbit offsets drift back behind the rider shortly after the right mouse button is released
  if (!rmbDown && wallTime - lastOrbitInput > 1.1 && state !== 'menu') {
    const kr = 1 - Math.exp(-dt * 2.5);
    orbitYaw -= orbitYaw * kr;
    orbitPitch -= orbitPitch * kr;
  }

  if (state === 'menu' || state === 'loading') {
    if (!rmbDown && wallTime - lastOrbitInput > 1.5) orbitA += dt * 0.16;
    const r = 6.4 * camZoom;
    tmpV.set(pos.x, pos.y + 1.0, pos.z);
    camPos.set(tmpV.x + Math.sin(orbitA) * r, tmpV.y + 1.4 * camZoom + Math.sin(orbitA * 0.7) * 0.4, tmpV.z + Math.cos(orbitA) * r);
    camera.position.copy(camPos);
    // push the vehicle to the right of the screen on wide layouts so the menu panel can sit on the left
    const shift = camera.aspect > 1.15 ? 2.1 : 0;
    const rx = Math.cos(orbitA), rz = -Math.sin(orbitA);
    camLook.set(tmpV.x - rx * shift, tmpV.y - 1.05, tmpV.z - rz * shift);
    camera.lookAt(camLook);
    camFov = 55;
  } else {
    const k = state === 'countdown' ? 2.6 : 13;
    camYaw = lerpAngle(camYaw, yaw, 1 - Math.exp(-dt * (state === 'countdown' ? 3 : 5)));
    const portrait = camera.aspect < 1 ? 1 - camera.aspect : 0;
    const back = 5.6 + sp01 * 1.6 + portrait * 2.2, up = 2.75 + sp01 * 0.45 + portrait * 0.8;
    const dist = Math.hypot(back, up) * camZoom;
    const pitch = clamp(Math.atan2(up, back) + orbitPitch, -0.1, 1.35);
    const cy = camYaw + orbitYaw;
    const horiz = Math.cos(pitch) * dist;
    tmpV.set(pos.x + Math.sin(cy) * horiz, pos.y + Math.sin(pitch) * dist, pos.z + Math.cos(cy) * horiz);
    const falling = state === 'dead' || pos.y < player.lastGroundY - 5;
    if (falling) tmpV.y = Math.max(camPos.y, player.lastGroundY + 2);
    const ky = 1 - Math.exp(-dt * (falling ? 1 : rmbDown ? 25 : 7));
    const kx = 1 - Math.exp(-dt * (rmbDown ? 25 : k));
    camPos.x += (tmpV.x - camPos.x) * kx;
    camPos.z += (tmpV.z - camPos.z) * kx;
    camPos.y += (tmpV.y - camPos.y) * ky;
    // while orbiting, look at the rider instead of ahead of it
    const ahead = (4 + sp01 * 3) * Math.max(0, 1 - Math.abs(orbitYaw) * 1.3);
    const lookX = (state === 'dead' ? deathPos.x : pos.x) + fwdX * ahead;
    const lookY = (state === 'dead' ? deathPos.y : pos.y) + 1.45;
    const lookZ = (state === 'dead' ? deathPos.z : pos.z) + fwdZ * ahead;
    const kl = 1 - Math.exp(-dt * (rmbDown ? 30 : 12));
    camLook.x += (lookX - camLook.x) * kl;
    camLook.y += (lookY - camLook.y) * kl;
    camLook.z += (lookZ - camLook.z) * kl;
    camera.position.copy(camPos);
    if (shake > 0.001) {
      const s = shake * shake;
      camera.position.x += (Math.random() - 0.5) * s;
      camera.position.y += (Math.random() - 0.5) * s;
      camera.position.z += (Math.random() - 0.5) * s;
    }
    camera.lookAt(camLook);
    camera.rotateZ(-player.steer * Math.min(1, sp01) * 0.045);
    camFov = 68 + Math.min(1, sp01) * 13 + (player.boosting ? 7 : 0) + portrait * 26;
  }
  shake = Math.max(0, shake - dt * 1.6);
  const f = camera.fov + (camFov - camera.fov) * (1 - Math.exp(-dt * 4));
  if (Math.abs(f - camera.fov) > 0.01) { camera.fov = f; camera.updateProjectionMatrix(); }
}

// ------------------------------------------------------------ frame
const engineParams = { vehicle: 'bike', speed01: 0, throttle: 0, grounded: true, boosting: false };
const fxCtx = { playerPos: new THREE.Vector3(), playerVel: new THREE.Vector3(), speed01: 0, boosting: false, grounded: true, camera: null, time: 0 };
const rigState = { speed: 0, steer: 0, throttle: 0, grounded: true, lean: 0, landImpact: 0, boosting: false, trickSpin: 0, trickFlip: 0, time: 0 };
const hud = {
  distance: 0, record: 0, speedKmh: 0, avgKmh: 0, lives: 3, maxLives: CONFIG.startLives, turbo: 0, boosting: false,
  coins: 0, time: 0, zoneNum: 1, zoneName: '', recordBeaten: false, multiplier: 1, infinite: false,
};

let acc = 0;
let last = performance.now();
let ftAvg = 16.7, ftCount = 0, lowFpsTime = 0;
let pausedFrameDone = false;
let wallTime = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;
  if (dt <= 0) dt = 0.001;
  wallTime += dt;
  readInput();

  const active = state === 'play' || state === 'dead' || state === 'countdown';
  if (state !== 'paused') simTime += dt;

  if (state === 'countdown') {
    runState.cd -= dt;
    const n = Math.ceil(runState.cd - 0.4);
    if (n !== runState.cdShown && n >= 0) {
      runState.cdShown = n;
      if (n > 0 && n <= 3) { ui.countdown(n); audio.play('countdown', { n }); }
      else if (n === 0) { ui.countdown('VAI!'); audio.play('go'); }
    }
    track.stepMovers(simTime);
    if (runState.cd <= 0.4) { state = 'play'; jumpEdge = false; }
  } else if (state === 'play') {
    acc += dt;
    let n = 0;
    while (acc >= STEP && n < 10 && state === 'play') {
      input.jumpPressed = jumpEdge;
      jumpEdge = false;
      player.step(STEP, input, simTime - acc + STEP);
      acc -= STEP;
      n++;
    }
    if (n >= 10) acc = 0;
  } else if (state === 'dead') {
    runState.deadTimer += dt;
    track.stepMovers(simTime);
    if (runState.deadTimer > 1.8) {
      if (runState.lives > 0) respawn();
      else gameOver();
    }
  } else if (state === 'menu' || state === 'over') {
    track.stepMovers(simTime);
  }
  if (state !== 'play') { acc = 0; jumpEdge = false; }

  if (state === 'play' || state === 'dead') runState.time += dt;

  // render-interpolated player transform
  const alpha = state === 'play' ? acc / STEP : 1;
  rPos.lerpVectors(player.prevPos, player.pos, alpha);
  const rYaw = lerpAngle(player.prevYaw, player.yaw, alpha);

  // run bookkeeping
  const spd = player.speed;
  if (state === 'play') {
    if (spd > runState.topSpeed) runState.topSpeed = spd;
    while (player.maxProgress >= runState.nextSample) {
      runState.samples.push(Math.round(spd * 3.6));
      runState.nextSample += 10;
    }
    track.collectCoins(rPos.x, rPos.y, rPos.z, onCoin);
    track.collectRings(rPos.x, rPos.y, rPos.z, onRing);
    if (!runState.recordBeaten && runState.recordAtStart > 50 && player.maxProgress > runState.recordAtStart) {
      runState.recordBeaten = true;
      ui.toast('NOVO RECORDE!', 'record');
      buzz([30, 50, 30]);
      audio.play('record');
      fx.burst('confetti', tmpV.copy(rPos).setY(rPos.y + 3), { count: 320 });
    }
    // live unlock notice when this run passes a skin's distance requirement
    for (let i = 0; i < SKINS.length; i++) {
      const sk = SKINS[i];
      if (runState.mode !== 'infinite' && sk.unlock > runState.recordAtStart && sk.unlock <= player.maxProgress && !runState.skinToasts.has(sk.id)) {
        runState.skinToasts.add(sk.id);
        ui.toast('SKIN DESBLOQUEADA: ' + sk.name.toUpperCase(), 'record');
        audio.play('trick', { level: 4 });
      }
    }
  }

  // track streaming
  const keep = player.checkpoint ? player.checkpoint.spawn.dist : 0;
  track.update(Math.max(player.progress, 0), keep);

  // zones
  const zd = state === 'menu' ? 0 : Math.max(0, player.progress);
  const zi = Math.floor(zd / CONFIG.zoneLength);
  const into = zd - zi * CONFIG.zoneLength;
  const zt = clamp((into - (CONFIG.zoneLength - CONFIG.zoneBlend)) / CONFIG.zoneBlend, 0, 1);
  const zA = zoneAt(zi), zB = zoneAt(zi + 1);
  env.setZoneBlend(zA, zB, zt);
  const glow = zA.glow + (zB.glow - zA.glow) * zt;
  const maxZone = Math.floor(player.maxProgress / CONFIG.zoneLength);
  if (active && maxZone > runState.zoneShown) {
    runState.zoneShown = maxZone;
    const z = zoneAt(maxZone);
    ui.zoneBanner(maxZone + 1, z.name, z.accent);
    audio.setZone(maxZone);
    audio.play('zone');
  }

  // vehicle visuals
  if (rig) {
    rig.group.position.copy(rPos);
    rig.group.rotation.set(player.pitch, rYaw, player.wobble > 0 ? Math.sin(simTime * 30) * player.wobble * 0.15 : 0);
    rigState.speed = player.forwardSpeed;
    rigState.steer = player.steer;
    rigState.throttle = player.throttle;
    rigState.grounded = player.grounded;
    rigState.lean = player.lean;
    rigState.landImpact = pendingImpact;
    pendingImpact = 0;
    rigState.boosting = player.boosting && state === 'play';
    rigState.trickSpin = player.spin;
    rigState.trickFlip = player.flip;
    rigState.time = wallTime;
    // paused: freeze wheels (they kept spinning at the frozen speed), flying debris and the respawn blink
    const vdt = state === 'paused' ? 0 : dt;
    rig.update(vdt, rigState);
    if (blinkT > 0) {
      blinkT -= vdt;
      const o = blinkT > 0 ? (Math.floor(blinkT * 12) % 2 ? 0.3 : 1) : 1;
      if (o !== lastOpacity) { rig.setOpacity(o); lastOpacity = o; }
    }
  }

  updateCamera(dt, rPos, rYaw);

  // environment, fx, track visuals
  env.update(dt, wallTime, rPos, camera);
  const sp01 = clamp(spd / player.stats.maxSpeed, 0, 1.4);
  speedSmooth += (sp01 - speedSmooth) * Math.min(1, dt * 3);
  fxCtx.playerPos.copy(rPos);
  fxCtx.playerVel.copy(player.vel);
  fxCtx.speed01 = state === 'play' ? Math.min(1, sp01) : 0;
  fxCtx.boosting = player.boosting && state === 'play';
  fxCtx.grounded = player.grounded;
  fxCtx.camera = camera;
  fxCtx.time = wallTime;
  fx.update(state === 'paused' ? 0 : dt, fxCtx);
  track.flush(simTime, glow);
  if (bloom) {
    bloom.strength = 0.32 + glow * 0.55 + (player.boosting && state === 'play' ? 0.12 : 0);
  }

  // audio
  engineParams.vehicle = store.vehicle;
  engineParams.speed01 = state === 'play' ? Math.min(1, sp01) : 0;
  engineParams.throttle = state === 'play' ? input.throttle : 0;
  engineParams.grounded = player.grounded;
  engineParams.boosting = player.boosting && state === 'play';
  audio.setEngine(engineParams);
  audio.setMusicIntensity(active ? Math.min(1, speedSmooth) : 0.25);

  // HUD
  if (active || state === 'paused') {
    hud.distance = player.maxProgress;
    hud.record = runState.recordAtStart;
    hud.speedKmh = spd * 3.6;
    hud.avgKmh = runState.time > 1 ? (player.maxProgress / runState.time) * 3.6 : 0;
    hud.lives = runState.lives;
    hud.maxLives = Math.max(CONFIG.startLives, runState.lives);
    hud.turbo = player.turbo;
    hud.boosting = player.boosting && state === 'play';
    hud.coins = runState.coins;
    hud.time = runState.time;
    hud.zoneNum = maxZone + 1;
    hud.zoneName = zoneAt(maxZone).name;
    hud.recordBeaten = runState.recordBeaten;
    hud.infinite = runState.mode === 'infinite';
    ui.updateHUD(hud);
  }

  // behind the pause screen one frame is enough; skip GPU work after that (saves battery on phones)
  if (state !== 'paused' || !pausedFrameDone) {
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
  }
  pausedFrameDone = state === 'paused';

  // adaptive resolution
  ftAvg += (dt * 1000 - ftAvg) * 0.05;
  if (++ftCount > 90 && active) {
    ftCount = 0;
    if (ftAvg > 21 && pixelRatio > 0.7) { prCeil = pixelRatio - 0.05; pixelRatio = Math.max(0.7, pixelRatio - 0.15); renderer.setPixelRatio(pixelRatio); onResize(); }
    else if (ftAvg < 14 && pixelRatio < prCeil - 0.001) { pixelRatio = Math.min(prCeil, pixelRatio + 0.1); renderer.setPixelRatio(pixelRatio); onResize(); }
  }
  if (state === 'play' && quality === 'high') {
    lowFpsTime = ftAvg > 30 ? lowFpsTime + dt : 0;
    if (lowFpsTime > 4 && pixelRatio <= 0.75) {
      lowFpsTime = 0;
      toggleQuality(false);
      ui.toast('Qualidade ajustada para BAIXA', 'info');
    }
  }
}

function showFatal(msg) {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;background:#0b0d17;color:#fff;font:600 18px Nunito,system-ui,sans-serif;padding:24px;text-align:center;z-index:9999';
  d.textContent = msg;
  document.body.appendChild(d);
}

async function boot() {
  try {
    if (document.fonts && document.fonts.ready) {
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
    }
  } catch (e) { /* fonts optional */ }
  ui.setLoading(0.6);
  applyQuality();
  setVehicle(store.vehicle);
  track.reset(newSeed(), modeRecord(store.mode), ONLY);
  preparePlayer();
  ui.setLoading(0.8);
  // warm up shaders before showing the menu
  env.setZoneBlend(zoneAt(0), zoneAt(1), 0);
  env.update(0.016, 0, player.pos, camera);
  track.flush(0, 0);
  // compile the rider's transparent variant too, so the first respawn blink does not hitch
  try { rig.setOpacity(0.5); renderer.compile(scene, camera); rig.setOpacity(1); renderer.compile(scene, camera); } catch (e) { /* optional */ }
  ui.setLoading(1);
  state = 'menu';
  ui.showScreen('menu');
  last = performance.now();
  requestAnimationFrame(frame);
}

// Debug handle for automated playtests (read-only use).
window.bobobike = { get state() { return state; }, player, track, camera, env, fx, get audio() { return audio; }, get rig() { return rig; }, get pixelRatio() { return pixelRatio; }, get quality() { return quality; } };

boot().catch((e) => {
  console.error(e);
  showFatal('Falha ao iniciar o jogo: ' + (e && e.message ? e.message : e));
});
