// Validate track pieces headlessly.
//   node tools/piece-test.mjs <absolute project path> <pieceName|all> [seeds=6] [botSeconds=90]
// For each piece: builds tracks made only of that piece (plus gaps/checkpoints), checks geometry
// (finite numbers, forward progress, no overlap with earlier pieces, collider budget) and runs the
// playtest bot on bike and kick. Needs: npm i --no-save three@0.160.0
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ctx2d = new Proxy({}, { get: () => () => {} });
globalThis.document = { createElement: () => ({ getContext: () => ctx2d, width: 0, height: 0 }) };
const ROOT = process.argv[2];
const which = process.argv[3] || 'all';
const SEEDS = Number(process.argv[4] || 6);
const BOT_SECONDS = Number(process.argv[5] || 90);
const THREE = await import('file:///' + ROOT + '/node_modules/three/build/three.module.js');
const { createTrack, KIND } = await import('file:///' + ROOT + '/js/track.js');
const here = path.dirname(fileURLToPath(import.meta.url));

const probe = createTrack({ scene: new THREE.Scene() });
const names = which === 'all' ? probe.pieceNames() : which.split(',');

function geometry(name, seed) {
  const scene = new THREE.Scene();
  const t = createTrack({ scene });
  const problems = [];
  let warn = 0;
  const orig = console.warn;
  console.warn = (...a) => { warn++; problems.push('warn: ' + a.map(String).join(' ').slice(0, 160)); };
  try { t.reset(seed, 0, { only: [name] }); } catch (e) { problems.push('reset threw: ' + e.message); }
  for (let d = 0; d < 1400; d += 40) { try { t.update(d, 0); } catch (e) { problems.push('update threw: ' + e.message); break; } }
  console.warn = orig;
  // walk the colliders through pathPoint to sample, and check finiteness via instance matrices
  const pts = [];
  const o = {};
  for (let d = 0; d < 1700; d += 5) { const r = t.pathPoint(d, o); if (r) pts.push({ d, x: r.x, y: r.y, z: r.z, type: r.type }); }
  for (const p of pts) if (!Number.isFinite(p.x + p.y + p.z)) { problems.push('non-finite path point at ' + p.d); break; }
  const own = pts.filter((p) => p.type === name);
  // overlap: a point of this piece type must not sit inside the footprint of a much earlier part of the path
  for (let i = 0; i < own.length; i += 3) {
    const a = own[i];
    for (const b of pts) {
      if (b.d > a.d - 60) break;
      if (Math.abs(a.x - b.x) < 3 && Math.abs(a.z - b.z) < 3 && Math.abs(a.y - b.y) < 6) {
        problems.push(`overlap: ${name}@${a.d}m touches path@${b.d}m`); i = own.length; break;
      }
    }
  }
  return { problems, warn, samples: own.length };
}

const results = [];
for (const name of names) {
  const probs = [];
  let samples = 0;
  for (let s = 1; s <= SEEDS; s++) { const g = geometry(name, 1000 + s * 7919); probs.push(...g.problems); samples += g.samples; }
  const bots = [];
  for (const v of ['bike', 'kick']) {
    for (const seed of [11, 22]) {
      try {
        const out = execFileSync(process.execPath, [path.join(here, 'bot.mjs'), ROOT, v, String(seed), String(BOT_SECONDS)],
          { env: { ...process.env, ONLY: name }, encoding: 'utf8', timeout: 240000 });
        const last = out.trim().split('\n').pop();
        const j = JSON.parse(last);
        bots.push({ v, seed, maxDist: j.maxDist, deaths: j.deaths, NaNs: j.NaNs });
      } catch (e) { bots.push({ v, seed, error: String(e.message).slice(0, 200) }); }
    }
  }
  const r = { piece: name, samplesOnPath: samples, problems: [...new Set(probs)].slice(0, 8), bots };
  results.push(r);
  console.log(JSON.stringify(r));
}
