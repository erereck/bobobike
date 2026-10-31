// Temporary stand-ins for modules still being built (dev only, never published).
import * as THREE from 'three';
export function createUI() {
  const el = document.getElementById('dbg');
  const handlers = {};
  let last = 0;
  return {
    showScreen(n) { el.dataset.screen = n; if (n === 'menu') setTimeout(() => handlers.play && handlers.play(), 300); },
    on(e, cb) { handlers[e] = cb; }, setVehicles() {}, setRecords() {},
    updateHUD(h) { const t = performance.now(); if (t - last < 100) return; last = t; el.textContent = `${Math.round(h.distance)} m | ${Math.round(h.speedKmh)} km/h | avg ${Math.round(h.avgKmh)} | vidas ${h.lives} | turbo ${h.turbo.toFixed(2)} | ${h.zoneName}`; },
    zoneBanner() {}, toast(t) { console.log('toast', t); }, countdown(v) { console.log('cd', v); }, flashDamage() {}, checkpoint() {},
    showGameOver(s) { console.log('gameover', JSON.stringify(s)); }, setMuted() {}, setQuality() {}, setTouch() {}, setLoading() {},
    touch: { steer: 0, throttle: false, brake: false, jump: false, boost: false, flip: false, spin: false },
  };
}
export function createEnvironment({ scene }) {
  const hemi = new THREE.HemisphereLight('#cfe8ff', '#6b7f99', 1.1); scene.add(hemi);
  const sun = new THREE.DirectionalLight('#ffffff', 2.5); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  const c = sun.shadow.camera; c.left = -38; c.right = 38; c.top = 38; c.bottom = -38; c.near = 1; c.far = 200;
  scene.add(sun); scene.add(sun.target);
  scene.background = new THREE.Color('#9fd3ff'); scene.fog = new THREE.Fog('#bfe3ff', 70, 360);
  return { sun, update(dt, t, f) { sun.target.position.copy(f); sun.position.set(f.x + 30, f.y + 60, f.z - 20); }, setZoneBlend(a) { scene.fog.color.set(a.fog); scene.background.set(a.sky.horizon); }, setQuality() {}, getFogColor() { return scene.fog.color; } };
}
export function createAudio() { const n = () => {}; return { unlock: n, setMuted: n, isMuted: () => true, startMusic: n, stopMusic: n, setZone: n, setMusicIntensity: n, setEngine: n, play: n }; }
export function createFX() { const n = () => {}; return { update: n, burst: n, setQuality: n, clear: n }; }
export function createVehicle(type) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 1.4), new THREE.MeshStandardMaterial({ color: '#e63946' }));
  body.position.y = 0.6; body.castShadow = true; group.add(body);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: '#f5cd30' }));
  head.position.y = 1.6; group.add(head);
  return { type, group, update() {}, breakApart() { group.visible = false; }, reset() { group.visible = true; }, setOpacity() {}, dispose() {} };
}
