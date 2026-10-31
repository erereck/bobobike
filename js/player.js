// Arcade vehicle physics on top of the track colliders. Runs at a fixed timestep.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { KIND } from './track.js';

const R = 0.45;          // collision radius
const H = 1.75;          // collision height
const STEP_UP = 0.5;
const TAU = Math.PI * 2;
const FLIP_RATE = TAU / 0.6;
const SPIN_RATE = TAU / 0.5;
const JUMP_PAD_VY = 21;
const JUMP_PAD_MIN_FWD = 19; // worst pad gap (10 m, +6 m) needs ~18 m/s

export function createPlayer(track, emit) {
  const g = { y: 0, col: null, k: 0 };
  const hit = { px: 0, pz: 0, nx: 0, nz: 0 };
  const near = { px: 0, pz: 0, nx: 0, nz: 0 };

  const p = {
    pos: new THREE.Vector3(),
    prevPos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    yaw: 0, prevYaw: 0,
    stats: null,
    grounded: true,
    groundCol: null,
    slope: 0,            // ground gradient along heading (dy per meter forward)
    lastGroundY: 0,
    coyote: 0, jumpBuf: 0,
    airTime: 0,
    steer: 0,
    lean: 0,
    pitch: 0,
    landImpact: 0,
    boosting: false,
    boostPad: 0,
    turbo: 0.4,
    flip: 0, spin: 0,
    flipHeld: false, spinHeld: false,
    progress: 0, maxProgress: 0,
    checkpoint: null,
    dead: false,
    wobble: 0,
    throttle: 0,
    lastPadCol: null,
    nearCd: 0,

    setStats(s) { p.stats = s; },

    reset(spawn) {
      p.pos.set(spawn.x, spawn.y, spawn.z);
      p.prevPos.copy(p.pos);
      p.vel.set(0, 0, 0);
      p.yaw = p.prevYaw = spawn.yaw;
      p.grounded = true; p.groundCol = null; p.slope = 0;
      p.lastGroundY = spawn.y;
      p.coyote = 0; p.jumpBuf = 0; p.airTime = 0;
      p.steer = 0; p.lean = 0; p.pitch = 0; p.landImpact = 0;
      p.boosting = false; p.boostPad = 0;
      p.flip = 0; p.spin = 0;
      p.dead = false; p.wobble = 0;
      p.progress = spawn.dist;
      p.lastPadCol = null;
    },

    get speed() { return Math.hypot(p.vel.x, p.vel.z); },

    get forwardSpeed() { return p.vel.x * -Math.sin(p.yaw) + p.vel.z * -Math.cos(p.yaw); },

    die(reason) {
      if (p.dead) return;
      p.dead = true;
      emit('dead', reason);
    },

    step(dt, inp, time) {
      if (p.dead) return;
      const st = p.stats;
      p.prevPos.copy(p.pos);
      p.prevYaw = p.yaw;
      track.stepMovers(time);

      // steering eases in, but snaps back to center faster than it builds up
      const sRate = Math.abs(inp.steer) < Math.abs(p.steer) ? 16 : 11;
      p.steer += (inp.steer - p.steer) * Math.min(1, dt * sRate);
      if (inp.jumpPressed) p.jumpBuf = 0.2;
      else p.jumpBuf = Math.max(0, p.jumpBuf - dt);

      // turbo
      const wantTurbo = inp.boost && p.turbo > 0.005;
      if (wantTurbo) p.turbo = Math.max(0, p.turbo - 0.3 * dt);
      p.boostPad = Math.max(0, p.boostPad - dt);
      p.boosting = wantTurbo || p.boostPad > 0;
      const maxS = st.maxSpeed * (p.boosting ? CONFIG.boostMultiplier : 1);

      let fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      let rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
      let fwd = p.vel.x * fx + p.vel.z * fz;
      let lat = p.vel.x * rx + p.vel.z * rz;
      p.throttle = inp.throttle;

      if (p.grounded) {
        if (inp.throttle > 0 && fwd < maxS) {
          const a = st.accel * (p.boosting ? 1.9 : 1) * inp.throttle * (1 - 0.55 * Math.max(0, fwd) / maxS);
          fwd = Math.min(maxS, fwd + a * dt);
        }
        if (inp.brake > 0) {
          if (fwd > 0.5) fwd = Math.max(0, fwd - st.brake * inp.brake * dt);
          else fwd = Math.max(-6, fwd - 9 * inp.brake * dt);
        }
        if (inp.throttle <= 0 && inp.brake <= 0) {
          const f = Math.min(Math.abs(fwd), 1.4 * dt);
          fwd -= Math.sign(fwd) * f;
        }
        if (fwd > maxS) fwd = Math.max(maxS, fwd - 7 * dt);
        fwd -= CONFIG.gravity * p.slope * 0.5 * dt;
        lat *= Math.exp(-14 * dt);

        const sp01 = Math.min(1, Math.abs(fwd) / st.maxSpeed);
        const rate = (st.turnRate + (st.turnRateHigh - st.turnRate) * sp01) * Math.min(1, 0.3 + Math.abs(fwd) / 5);
        p.yaw -= p.steer * rate * dt * (fwd < -0.2 ? -1 : 1);
        // track assist: with no steering input, gently align with the platform under the wheels
        const gc = p.groundCol;
        if (gc && gc.d0 > -1e8 && Math.abs(inp.steer) < 0.15 && fwd > 4) {
          let d = (gc.yaw - p.yaw) % TAU;
          if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
          if (Math.abs(d) < 0.6) p.yaw += d * Math.min(1, dt * 2.2);
        }
        fx = -Math.sin(p.yaw); fz = -Math.cos(p.yaw);
        rx = Math.cos(p.yaw); rz = -Math.sin(p.yaw);
        p.vel.x = fx * fwd + rx * lat;
        p.vel.z = fz * fwd + rz * lat;
        p.vel.y = fwd * p.slope;
        p.lean += (p.steer * sp01 * 0.42 - p.lean) * Math.min(1, dt * 8);
        p.pitch += (Math.atan(p.slope) - p.pitch) * Math.min(1, dt * 14);
        p.coyote = 0.2;
      } else {
        p.vel.y -= CONFIG.gravity * dt;
        // air control: turn heading and drag velocity along with it
        const dyaw = -p.steer * st.turnRateHigh * 1.3 * st.airControl * dt;
        p.yaw += dyaw;
        const a = dyaw * 0.85, ca = Math.cos(a), sa = Math.sin(a);
        const vx = p.vel.x, vz = p.vel.z;
        p.vel.x = vx * ca + vz * sa;
        p.vel.z = -vx * sa + vz * ca;
        if (inp.throttle > 0 && fwd < maxS * 0.9) {
          p.vel.x += fx * st.accel * 0.3 * dt; p.vel.z += fz * st.accel * 0.3 * dt;
        }
        // Roblox-style air brake: S kills horizontal speed hard, then drifts slightly backwards
        if (inp.brake > 0) {
          if (fwd > 0.5) {
            const hs = Math.hypot(p.vel.x, p.vel.z) || 1;
            const k = Math.max(0, hs - 30 * inp.brake * dt) / hs;
            p.vel.x *= k; p.vel.z *= k;
          } else if (fwd > -5) {
            p.vel.x -= fx * 10 * inp.brake * dt; p.vel.z -= fz * 10 * inp.brake * dt;
          }
        }
        p.coyote = Math.max(0, p.coyote - dt);
        p.airTime += dt;
        p.lean *= Math.exp(-4 * dt);
        const hs = Math.max(4, Math.hypot(p.vel.x, p.vel.z));
        p.pitch += (Math.atan2(p.vel.y, hs) * 0.45 - p.pitch) * Math.min(1, dt * 4);

        // tricks
        if (p.airTime > 0.1) {
          if (inp.flip) p.flip += FLIP_RATE * dt;
          else {
            const rem = p.flip % TAU;
            if (rem > 0.001) p.flip = Math.min(p.flip + FLIP_RATE * dt, p.flip - rem + TAU);
          }
          if (inp.spin) p.spin += SPIN_RATE * dt;
          else {
            const rem = p.spin % TAU;
            if (rem > 0.001) p.spin = Math.min(p.spin + SPIN_RATE * dt, p.spin - rem + TAU);
          }
        }
      }

      // jump (with buffer + coyote time)
      if (p.jumpBuf > 0 && (p.grounded || p.coyote > 0)) {
        p.vel.y = st.jump + Math.max(0, p.vel.y * 0.6);
        p.grounded = false; p.coyote = 0; p.jumpBuf = 0; p.airTime = 0;
        p.groundCol = null;
        emit('jump');
      }

      // integrate
      const oldY = p.pos.y;
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.pos.z += p.vel.z * dt;
      if (p.grounded && p.groundCol && p.groundCol.move && p.groundCol.move.type === 1) {
        p.pos.x += p.groundCol.vx * dt;
        p.pos.z += p.groundCol.vz * dt;
      }

      // walls & kill bricks
      const res = track.collide(p.pos.x, p.pos.y, p.pos.z, R, H, STEP_UP, hit);
      if (res === 2) { p.die('kill'); return; }
      if (res === 1) {
        p.pos.x = hit.px; p.pos.z = hit.pz;
        const nl = Math.hypot(hit.nx, hit.nz) || 1;
        const nx = hit.nx / nl, nz = hit.nz / nl;
        const vn = p.vel.x * nx + p.vel.z * nz;
        if (vn < 0) {
          p.vel.x -= nx * vn * 1.25;
          p.vel.z -= nz * vn * 1.25;
          const ff = -Math.sin(p.yaw) * nx + -Math.cos(p.yaw) * nz;
          if (vn < -6 && ff < -0.6) {
            p.vel.x *= 0.35; p.vel.z *= 0.35;
            emit('bonk', -vn);
          }
        }
      }

      // near miss: skimming past (or just over) a kill brick at speed rewards a little turbo
      if (p.nearCd > 0) p.nearCd -= dt;
      else if (p.speed > 14 && track.collide(p.pos.x, p.pos.y - 0.6, p.pos.z, R + 0.8, H + 0.6, STEP_UP, near) === 2) {
        p.nearCd = 0.8;
        p.turbo = Math.min(1, p.turbo + 0.04);
        emit('nearMiss');
      }

      // ground
      if (p.grounded) {
        const down = 0.45 + Math.abs(p.forwardSpeed) * 0.012;
        if (track.ground(p.pos.x, p.pos.y, p.pos.z, STEP_UP, down, g, 0.35)) p.onGround(g, time);
        else {
          p.grounded = false;
          p.groundCol = null;
          p.airTime = 0;
        }
      } else if (p.vel.y <= 0) {
        // same step-up allowance as walls (collide ignores the top STEP_UP of a block), else a rider
        // crossing a small gap a few cm low slides into the far block and is shoved back into the gap
        const up = Math.max(STEP_UP, oldY - p.pos.y + 0.05);
        if (track.ground(p.pos.x, p.pos.y, p.pos.z, up, 0.05, g, 0.3)) {
          const impact = Math.min(1, -p.vel.y / 24);
          p.grounded = true;
          p.onGround(g, time);
          if (!p.dead) p.land(impact);
        }
      }

      if (p.dead) return;
      if (p.pos.y < p.lastGroundY - CONFIG.killY) p.die('fall');
      p.landImpact = Math.max(0, p.landImpact - dt * 3);
      p.wobble = Math.max(0, p.wobble - dt);
    },

    onGround(gr, time) {
      const col = gr.col;
      p.pos.y = gr.y;
      p.groundCol = col;
      p.lastGroundY = gr.y;
      p.slope = gr.k ? gr.k * Math.cos(col.yaw - p.yaw) : 0;
      if (col.kind === KIND.KILL) { p.die('kill'); return; }
      if (col.kind === KIND.BOOST) {
        p.boostPad = 1.15;
        const fwd = p.forwardSpeed;
        const target = p.stats.maxSpeed * 1.15;
        if (fwd < target) {
          const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
          p.vel.x += fx * (target - fwd); p.vel.z += fz * (target - fwd);
        }
        if (p.lastPadCol !== col) { p.lastPadCol = col; p.turbo = Math.min(1, p.turbo + 0.06); emit('boostPad'); }
      } else if (col.kind === KIND.JUMP) {
        p.vel.y = JUMP_PAD_VY;
        // the pad spans the whole road: rolling onto it slowly must still carry you to the high platform
        const fwd = p.forwardSpeed;
        if (fwd < JUMP_PAD_MIN_FWD) {
          p.vel.x += -Math.sin(p.yaw) * (JUMP_PAD_MIN_FWD - fwd);
          p.vel.z += -Math.cos(p.yaw) * (JUMP_PAD_MIN_FWD - fwd);
        }
        p.grounded = false; p.groundCol = null; p.airTime = 0;
        emit('jumpPad');
        return;
      } else if (col.kind === KIND.CHECK) {
        if (col.cp > (p.checkpoint ? p.checkpoint.cp : -1)) { p.checkpoint = col; emit('checkpoint', col); }
      } else if (col.kind === KIND.FALL) {
        if (track.touchFall(col, time)) emit('crumble', col);
      }
      if (col.kind !== KIND.BOOST) p.lastPadCol = null;
      const prog = track.progressOn(col, p.pos.x, p.pos.z);
      if (prog >= 0) {
        p.progress = prog;
        // window must exceed the longest possible flight (turbo + trick bonus off a kicker ~96 m),
        // otherwise one big jump freezes maxProgress for the rest of the run
        if (prog > p.maxProgress && prog < p.maxProgress + 160) p.maxProgress = prog;
      }
    },

    land(impact) {
      p.landImpact = Math.max(p.landImpact, impact);
      const remF = p.flip % TAU, remS = p.spin % TAU;
      const errF = Math.min(remF, TAU - remF), errS = Math.min(remS, TAU - remS);
      const flips = Math.round(p.flip / TAU), spins = Math.round(p.spin / TAU);
      if (p.flip > 0.3 || p.spin > 0.3) {
        if (errF < 0.6 && errS < 0.6 && flips + spins > 0) {
          p.turbo = Math.min(1, p.turbo + 0.17 * (flips + spins));
          const fwd = p.forwardSpeed;
          const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
          const bonus = 3 * (flips + spins);
          p.vel.x += fx * bonus; p.vel.z += fz * bonus;
          if (fwd < 0) { p.vel.x *= 0.5; p.vel.z *= 0.5; }
          emit('trick', { flips, spins });
        } else {
          p.vel.x *= 0.6; p.vel.z *= 0.6;
          p.wobble = 0.8;
          emit('trickFail');
        }
      }
      p.flip = 0; p.spin = 0;
      p.airTime = 0;
      emit('land', impact);
    },
  };
  return p;
}
