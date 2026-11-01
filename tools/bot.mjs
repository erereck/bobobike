// Headless playtest bot: drives the real track + player physics and reports where it dies.
const ctx2d = new Proxy({}, { get: () => () => {} });
globalThis.document = { createElement: () => ({ getContext: () => ctx2d, width: 0, height: 0 }) };
// Headless playtest bot: node tools/bot.mjs <absolute project path> <bike|scooter|kick> <seed> <seconds>
// Needs: npm i --no-save three@0.160.0
const ROOT = process.argv[2];
const THREE = await import('file:///' + ROOT + '/node_modules/three/build/three.module.js');
const { createTrack } = await import('file:///' + ROOT + '/js/track.js');
const { createPlayer } = await import('file:///' + ROOT + '/js/player.js');
const { VEHICLE_STATS, CONFIG } = await import('file:///' + ROOT + '/js/config.js');

const vehicle = process.argv[3] || 'bike';
const seed = Number(process.argv[4] || 12345);
const simSeconds = Number(process.argv[5] || 300);
const scene = new THREE.Scene();
const track = createTrack({ scene });
track.reset(seed, 0, process.env.ONLY ? { only: process.env.ONLY.split(',') } : null);
const deaths = {}; const events = { jump: 0, land: 0, trick: 0, bonk: 0, checkpoint: 0 };
let deadFlag = null;
const p = createPlayer(track, (t, d) => { if (t === 'dead') deadFlag = d; else if (t in events) events[t]++; });
p.setStats(VEHICLE_STATS[vehicle]);
p.reset(track.startSpawn);
const STEP = 1 / 120;
const inp = { steer: 0, throttle: 1, brake: 0, boost: false, flip: false, spin: false, jumpPressed: false };
const pp = {}, probe = { px: 0, pz: 0, nx: 0, nz: 0 }, g = {};
let t = 0, distSamples = [], stuckCp = 0, stuckCount = 0, lastProg = 0, noProgT = 0;
const SLOW = { pillars: 15, beam: 18, zigzag: 15, movers: 15, spinner: 13, fallTiles: 22, stairs: 15 };
let n = 0, typeAtDeath = {}; let airTravel = 0;
let NaNs = 0;
for (; t < simSeconds; t += STEP) {
  track.update(p.progress, p.checkpoint ? p.checkpoint.spawn.dist : 0);
  const spd = p.speed;
  if (p.grounded) airTravel = 0; else airTravel += spd * STEP;
  const estProg = p.progress + airTravel;
  const look = 5 + spd * 0.3;
  const tp = track.pathPoint(estProg + look, pp);
  const here = track.pathPoint(estProg + 2, {});
  let steer = 0, jump = false;
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  if (tp) {
    let tx = tp.x, tz = tp.z;
    // dodge kill bricks / walls ahead by probing lateral offsets
    for (const dd of [1 + spd * 0.16, 1 + spd * 0.1, 1 + spd * 0.05]) {
      const ax = p.pos.x + fx * dd, az = p.pos.z + fz * dd;
      const r = track.collide(ax, p.pos.y, az, 0.5, 1.7, 0.5, probe);
      if (r && !track.collide(ax, p.pos.y + 1.3, az, 0.5, 0.4, 0.5, probe)) { jump = true; break; }
      if (r) {
        let bestOff = null;
        for (let o = 0.5; o <= 5; o += 0.5) for (const s of [-1, 1]) {
          if (bestOff !== null) break;
          const ox = ax + Math.cos(p.yaw) * o * s, oz = az - Math.sin(p.yaw) * o * s;
          if (!track.collide(ox, p.pos.y, oz, 0.6, 1.7, 0.5, probe) && track.ground(ox, p.pos.y, oz, 0.6, 1.5, g)) bestOff = o * s;
        }
        if (bestOff !== null && Math.abs(bestOff) < 4) { tx = ax + Math.cos(p.yaw) * bestOff * 1.6 + fx * 3; tz = az - Math.sin(p.yaw) * bestOff * 1.6 + fz * 3; }
        else jump = true;
        break;
      }
    }
    const desired = Math.atan2(-(tx - p.pos.x), -(tz - p.pos.z));
    let d = p.yaw - desired; d = Math.atan2(Math.sin(d), Math.cos(d));
    steer = Math.max(-1, Math.min(1, d * 3));
  }
  // gap ahead?
  const ga = 0.8 + spd * 0.06;
  if (p.grounded && !track.ground(p.pos.x + fx * ga, p.pos.y, p.pos.z + fz * ga, 0.55, 1.2, g)) jump = true;
  const ahead = track.pathPoint(estProg + 10 + spd * 0.8, {}); const target = Math.min((here && SLOW[here.type]) || 99, (ahead && SLOW[ahead.type]) || 99);
  inp.steer = steer;
  inp.throttle = spd < target ? 1 : 0;
  inp.brake = spd > target + 3 ? 1 : 0;
  inp.jumpPressed = jump;
  if (process.env.DBG && n % 2 === 0 && p.maxProgress > Number(process.env.DBG) && p.maxProgress < Number(process.env.DBG)+40) console.log(t.toFixed(2), "prog", p.progress.toFixed(1), "pos", p.pos.x.toFixed(1), p.pos.y.toFixed(1), p.pos.z.toFixed(1), "spd", spd.toFixed(1), "steer", steer.toFixed(2), "jump", jump, "gr", p.grounded, "lat", tp ? (Math.cos(p.yaw)*(p.pos.x-tp.x) - Math.sin(p.yaw)*(p.pos.z-tp.z)).toFixed(2) : 0, "type", here && here.type, "tp", tp && tp.x.toFixed(1), tp && tp.z.toFixed(1));
  p.step(STEP, inp, t);
  if (!Number.isFinite(p.pos.x + p.pos.y + p.pos.z)) { NaNs++; break; }
  if (p.maxProgress > lastProg + 1) { lastProg = p.maxProgress; noProgT = 0; } else noProgT += STEP;
  if (noProgT > 25) { deadFlag = 'stuck'; noProgT = 0; }
  if (deadFlag) {
    const key = (here && here.type) || '?';
    typeAtDeath[key + ':' + deadFlag] = (typeAtDeath[key + ':' + deadFlag] || 0) + 1;
    if (process.env.DBG) console.log("DEATH", deadFlag, key, "prog", p.progress.toFixed(1), "y", p.pos.y.toFixed(1));
    deadFlag = null;
    const cp = p.checkpoint;
    if (cp && cp === stuckCp) stuckCount++; else { stuckCp = cp; stuckCount = 0; }
    if (stuckCount > 12) { console.log('STUCK at checkpoint', cp && cp.cp, 'dist', Math.round(p.maxProgress)); break; }
    p.reset(cp ? cp.spawn : track.startSpawn); p.checkpoint = cp;
    track.respawnReset();
  }
  n++;
}
console.log(JSON.stringify({ vehicle, seed, simTime: Math.round(t), maxDist: Math.round(p.maxProgress), avgKmh: Math.round(p.maxProgress / t * 3.6), events, deaths: typeAtDeath, NaNs }));
