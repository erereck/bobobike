// bobobike piece pack: surfaces. Default export: array of piece definitions (see SPEC.md "v4").
// Theme: special surfaces (conveyor belts, ice, trampolines) and pickups (turbo rings, coins).
//
// Physics notes used for tuning (player.js):
// - A conveyor shifts the rider's POSITION while grounded on it; the rider's own velocity is untouched,
//   so jumping off a belt you fly at your own speed only (gaps never rely on belt speed).
// - Bounce: vy = min(24, 15 + 0.35 * |vy at the last landing|). Airtime 2*vy/34 s.
// - Ice: lateral grip ~0.9/s instead of 14/s, half acceleration, 75% turn rate. Brakes work normally.

const PI = Math.PI;

// Shared helpers ------------------------------------------------------------------------------
function solid(ctx, len, w, o) { ctx.slab(ctx.KIND.SOLID, 0, len, w, o); ctx.advance(len); }

// A road-like conveyor slab that counts toward distance. The push is applied to that (unrotated)
// collider; for belts that push backwards or sideways a thin visual "skin" with the conveyor look is
// laid on top, rotated so its chevrons point where the belt actually pushes (rotating the collider
// itself would scramble the distance/progress mapping, which runs along the collider's local z).
// dir: 'fwd' | 'back' | 'left' | 'right'.
function belt(ctx, a, b, w, speed, dir, o = {}) {
  const { KIND } = ctx;
  const dy = o.dy ?? 0, off = o.off ?? 0;
  const col = ctx.slab(KIND.CONVEYOR, a, b, w, { off, dy, th: o.th ?? 1.4, color: ctx.colors.CONVEYOR });
  if (dir === 'fwd') return ctx.conveyor(col, speed);
  if (dir === 'back') {
    ctx.decor(off, (a + b) / 2, dy - 0.02, w + 0.04, 0.1, b - a + 0.04,
      { yaw: PI, color: ctx.colors.CONVEYOR, vkind: KIND.CONVEYOR });
    return ctx.conveyor(col, -speed);
  }
  // sideways: the skin's local forward points left (+PI/2) or right (-PI/2); its local x runs along the road
  const skin = ctx.decor(off, (a + b) / 2, dy - 0.02, b - a + 0.04, 0.1, w + 0.04,
    { yaw: dir === 'left' ? PI / 2 : -PI / 2, color: ctx.colors.CONVEYOR, vkind: KIND.CONVEYOR });
  ctx.conveyor(skin, speed);
  col.push = skin.push; // same world-space push, on the collider the rider actually stands on
  skin.push = null;
  return col;
}

// Low kerb (wall) along a stretch of road on one side (side -1 = left, +1 = right).
function rail(ctx, a, b, w, side, o = {}) {
  const h = o.h ?? 0.75;
  return ctx.slab(ctx.KIND.SOLID, a, b, 0.6, {
    off: side * (w / 2 + 0.3), dy: (o.dy ?? 0) + h, th: h + 1.4, noDist: true,
    color: o.color ?? (o.alt ? ctx.colors.KERB_DARK : ctx.colors.WHITE),
  });
}

// Exit funnel: a wide platform whose angled side walls guide riders from width `from` down to the
// standard width `to` over `len` meters, then a normal solid strip. Leaves the cursor at its end.
function funnel(ctx, from, to, len, tail, o = {}) {
  const { KIND } = ctx;
  ctx.slab(KIND.SOLID, 0, len, from, { color: o.color });
  const dx = (from - to) / 2;
  const L = Math.hypot(len, dx), yaw = Math.atan2(dx, len);
  for (const s of [-1, 1]) {
    ctx.box(KIND.SOLID, s * ((from + to) / 4 + 0.3), len / 2, 0.25, 0.6, 1.9, L,
      { yaw: s * yaw, color: s < 0 ? ctx.colors.WHITE : ctx.colors.KERB_DARK });
  }
  ctx.advance(len);
  solid(ctx, tail, to);
}

// Pick a turn direction that keeps the track heading within its allowed fan.
function turnDir(ctx) {
  const y = ctx.cur.yaw;
  if (y > 0.45) return -1;
  if (y < -0.45) return 1;
  return ctx.rng() < 0.5 ? -1 : 1;
}

export default [
  // ------------------------------------------------------------------ s_speedBelt
  // ESTEIRA TURBO: a long forward conveyor (sometimes curving) that adds its speed to yours.
  // Rails early, turbo rings to grab on the belt, boost pad at the exit so the speed does not just drop.
  {
    name: 's_speedBelt',
    weight: () => 0.8,
    early: true,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w = Math.max(ctx.W(), 7);
      solid(ctx, 8, w);
      ctx.banner(4, w, ['ESTEIRA TURBO', 'SEGURA O CHAPÉU!'], '#2b2d42', '#ffd23f', true);
      const speed = 9 + d01 * 6 + rng() * 2;
      const curvy = rng() < 0.55;
      const dir = turnDir(ctx);
      const step = curvy ? (0.035 + rng() * 0.03) * dir : 0;
      const L = 4.5;
      const n = 9 + Math.floor(rng() * 5);
      const rails = d01 < 0.5;
      const hazards = d01 > 0.35 && !curvy;
      let side = rng() < 0.5 ? -1 : 1;
      for (let i = 0; i < n; i++) {
        belt(ctx, -0.15, L + w * Math.abs(step) * 0.6, w, speed, 'fwd');
        if (rails) {
          rail(ctx, 0, L + 0.3, w, -1, { alt: i % 2 });
          rail(ctx, 0, L + 0.3, w, 1, { alt: !(i % 2) });
        }
        if (i % 3 === 1) ctx.addRing(0, L / 2, 1.85);
        else if (i % 3 === 2) ctx.addCoin(0, L / 2, 1.15);
        if (hazards && i % 6 === 3 && i < n - 1) {
          // block from one edge to just short of the middle, 27 m apart (more than a hop at own
          // speed: the belt does not carry you in the air); coin shows the open side
          const bw = w * 0.42;
          ctx.box(KIND.KILL, side * (w - bw) / 2, L / 2, 0.5, bw, 1.0, 1.2);
          ctx.addCoin(-side * w / 4, L / 2, 1.15);
          side = -side;
        }
        ctx.advance(L);
        if (step) ctx.turn(step);
      }
      ctx.slab(KIND.BOOST, 0, 4, Math.min(w, 5), { dy: 0.06, th: 0.3 });
      solid(ctx, 10, w);
    },
  },

  // ------------------------------------------------------------------ s_sideBelts
  // ESTEIRA DE LADO: panels of sideways belts that shove you toward the edge; steer against them.
  // Early: a rail on the side they push toward. Later: no rails, stronger push, longer panels.
  {
    name: 's_sideBelts',
    weight: (d01) => 0.45 + d01 * 0.4,
    early: true,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w = Math.max(ctx.W() + 0.8, 7);
      solid(ctx, 7, w);
      ctx.banner(3.5, w, ['ESTEIRA DE LADO', 'VIRA CONTRA!'], '#2b2d42', '#ffd23f', true);
      const n = 3 + Math.floor(rng() * 2 + d01 * 1.5);
      const speed = 3 + d01 * 3.2 + rng() * 0.6;
      const rails = d01 < 0.35;
      let dir = rng() < 0.5 ? 'left' : 'right';
      for (let i = 0; i < n; i++) {
        const len = 10 + rng() * 3 + d01 * 3;
        const side = dir === 'left' ? -1 : 1;
        const next = i < n - 1 && rng() < 0.75 ? (dir === 'left' ? 'right' : 'left') : dir;
        belt(ctx, 0, len, w, speed, dir);
        if (rails) rail(ctx, -0.6, len + 0.6, w, side, { alt: i % 2 });
        // coins start on the upwind side. If the next panel pushes the other way they drift with this
        // belt to its downwind side (= the next panel's upwind side), so a coin chaser never ends a panel
        // hugging the edge the next belt shoves toward; otherwise they stay upwind.
        const x0 = -side * w * 0.28;
        const x1 = i === n - 1 ? 0 : next !== dir ? side * w * 0.2 : -side * w * 0.18;
        for (let k = 0; k < 4; k++) ctx.addCoin(x0 + (x1 - x0) * k / 3, 2 + (len - 4) * k / 3, 1.15);
        ctx.advance(len);
        if (i < n - 1) {
          ctx.slab(KIND.SOLID, 0, 1.4, w, { color: ctx.colors.KERB_DARK });
          ctx.advance(1.4);
        }
        dir = next;
      }
      solid(ctx, 9, w);
    },
  },

  // ------------------------------------------------------------------ s_reverseBelt
  // CONTRAMÃO: belts running backwards; keep the throttle down (or hop: in the air the belt can't
  // hold you back). Each belt starts on a small solid island, so a rider who stops is carried back
  // onto the island, never into a gap. Islands may carry a boost pad; later the islands float.
  {
    name: 's_reverseBelt',
    weight: (d01) => 0.5 + d01 * 0.2,
    minDist: 140,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w = Math.max(ctx.W(), 6.5);
      solid(ctx, 8, w);
      ctx.banner(4, w, ['CONTRAMÃO!', 'ACELERA COM TUDO!'], '#2b2d42', '#ff5d8f', true);
      const speed = 7 + d01 * 5 + rng() * 1.5;
      const gaps = d01 > 0.22;
      // with gaps, everything after a gap is >= 30 m of road: a full-speed (even turbo) hop from the
      // edge lands on it instead of overshooting into the next gap
      const segs = gaps ? 2 + (rng() < 0.45 ? 1 : 0) : 2 + (rng() < 0.5 ? 1 : 0);
      const c = ctx.pickColor();
      for (let i = 0; i < segs; i++) {
        if (i > 0) {
          if (gaps) ctx.advance(3 + d01 * 1.6 + rng() * 0.6);
          ctx.slab(KIND.SOLID, 0, 5, w, { color: c });
          if (rng() < 0.55) ctx.slab(KIND.BOOST, 0.8, 4.2, Math.min(w, 4.5), { dy: 0.06, th: 0.3 });
          ctx.advance(5);
        }
        // after a gap: island 5 + belt >= 28 = 33+ m of road past the gap (turbo scooter hop ~35 m)
        const len = gaps && i > 0 ? 28 + rng() * 3 : 13 + rng() * 5;
        belt(ctx, 0, len, w, speed, 'back');
        ctx.addRing(0, len * 0.35, 1.85);
        ctx.addRing(0, len * 0.75, 1.85);
        ctx.coinLine(2, len - 2, (rng() - 0.5) * (w - 2.5), 4);
        ctx.advance(len);
      }
      solid(ctx, 10, w);
    },
  },

  // ------------------------------------------------------------------ s_iceRink
  // PISTA DE GELO: a wide ice rink with rows of red pillars to drift around. Pillars are too tall to
  // hop, rows are far apart and lanes are wide (there is always a straight line through two
  // consecutive rows, plus the wall line). Bumper walls early. First 14 m and last 12 m of ice are
  // clear; an angled funnel brings sliding riders back to the normal road width.
  {
    name: 's_iceRink',
    weight: () => 0.6,
    minDist: 110,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w0 = ctx.W();
      solid(ctx, 12, w0); // long grippy run-in: pick your line before the ice
      const RW = 14 + rng() * 2;
      const sp = 20 - d01 * 3;
      const rows = 2 + Math.floor(rng() * 2 + d01 * 1.5);
      const RL = 14 + (rows - 1) * sp + 12;
      ctx.slab(KIND.ICE, 0, RL, RW);
      ctx.banner(3, RW, ['PISTA DE GELO', 'DERRAPA SEM MEDO!'], '#bde7ff', '#1b1f3b', false);
      if (d01 < 0.55) {
        rail(ctx, 0, RL, RW, -1, { h: 0.9 });
        rail(ctx, 0, RL, RW, 1, { h: 0.9 });
      }
      const P = 1.8; // pillar footprint
      // early rinks use solid bumpers (sliding into one is a bonk, not a death); later ones are red
      const deadly = d01 > 0.6;
      const pillar = (x, f) => ctx.box(deadly ? KIND.KILL : KIND.SOLID, x, f, 1.3, P, 2.6, P,
        deadly ? undefined : { color: ctx.colors.KERB_DARK });
      let last = 1; // the first row always leaves the middle open
      for (let r = 0; r < rows; r++) {
        const f = 14 + r * sp;
        let pat = r === 0 ? 0 : Math.floor(rng() * (d01 > 0.4 ? 3 : 2));
        if (pat === last) pat = (pat + 1) % (d01 > 0.4 ? 3 : 2);
        last = pat;
        // a straight line at |x| ~ 1.6..2.7 threads every pattern (pillar hitboxes shrink 0.22 m)
        if (pat === 0) { // two pillars, middle and walls open
          const a = 3.9 + rng() * 0.5;
          pillar(-a, f); pillar(a, f);
          ctx.coinLine(f - 4, f + 4, 0, 3);
        } else if (pat === 1) { // one pillar in the middle, both sides open
          const x = (rng() - 0.5) * 0.8;
          pillar(x, f);
          const s = rng() < 0.5 ? -1 : 1;
          ctx.coinLine(f - 4, f + 4, x + s * 3.2, 3);
        } else { // three pillars, two lanes
          const e = RW / 2 - 1.6;
          pillar(-e, f); pillar(0, f); pillar(e, f);
          ctx.addCoin(-e / 2, f, 1.15); ctx.addCoin(e / 2, f, 1.15);
        }
      }
      ctx.advance(RL);
      funnel(ctx, RW, w0, 12, 8);
    },
  },

  // ------------------------------------------------------------------ s_iceCurve
  // TOBOGÃ DE GELO: a bobsled channel of ice with walls on both sides, curving one way or as an S.
  // You can't fall off; slide along the walls, coins on the inside line reward a clean drift.
  {
    name: 's_iceCurve',
    weight: () => 0.6,
    minDist: 180,
    gen(ctx) {
      const { KIND, rng } = ctx;
      const w = Math.max(ctx.W(), 7) + 0.6;
      solid(ctx, 7, w);
      ctx.banner(3.5, w, ['TOBOGÃ DE GELO', 'SEGURA NA CURVA!'], '#bde7ff', '#1b1f3b', false);
      const sCurve = rng() < 0.5;
      let dir = turnDir(ctx);
      const step = 0.055 + rng() * 0.035;
      const n = 14 + Math.floor(rng() * 7);
      const L = 3.4;
      // bobsled walls: walls only block below (top - 0.5 m step-up), so 3.4 m keeps even the kick's
      // 2.8 m jump apex inside the channel (a hop while sliding on the outer wall used to fly out)
      const TH = 3.4;
      let flipped = false;
      for (let i = 0; i < n; i++) {
        // S: flip at the middle; any curve pinned at the yaw limit swings back instead of running
        // straight at the extreme (one flip only)
        const atLimit = ctx.cur.yaw * dir >= ctx.MAX_YAW - 0.01;
        if (!flipped && ((sCurve && i === Math.floor(n / 2)) || atLimit)) { dir = -dir; flipped = true; }
        ctx.slab(KIND.ICE, -0.15, L + w * step * 0.6, w);
        rail(ctx, -0.1, L + 0.4, w, -1, { h: TH, alt: i % 2 });
        rail(ctx, -0.1, L + 0.4, w, 1, { h: TH, alt: !(i % 2) });
        if (i % 3 === 1) ctx.addCoin(-dir * w * 0.22, L / 2, 1.15);
        ctx.advance(L);
        ctx.turn(step * dir);
      }
      ctx.slab(KIND.SOLID, 0, 10, w);
      rail(ctx, 0, 6, w, -1, { h: TH });
      rail(ctx, 0, 6, w, 1, { h: TH, alt: true });
      ctx.advance(10);
    },
  },

  // ------------------------------------------------------------------ s_bounceStairs
  // ESCADA PULA-PULA: giant steps, each with a trampoline right in front of the next step's wall.
  // Self-correcting: too slow and you land back on the trampoline (and bounce higher), too fast and
  // you bonk the wall and drop back onto it. No void between steps. High up, it starts with a drop.
  {
    name: 's_bounceStairs',
    weight: () => 0.6,
    early: true,
    gen(ctx) {
      const { KIND, rng } = ctx;
      const w = Math.max(ctx.W(), 7);
      const descend = ctx.cur.y > 22;
      const levels = descend ? 2 : 2 + (rng() < 0.35 ? 1 : 0);
      const rise = 2.3 + rng() * 0.4;
      const pad = 7.5;
      const c = ctx.pickColor(), c2 = ctx.shade(c);
      solid(ctx, 8, w);
      ctx.banner(4, w, ['PULA-PULA', 'QUICA PRA CIMA!'], '#ff4fa3', '#ffffff', true);
      // high up: step off the ledge onto a long, lower first floor (net -2 m for the piece)
      if (descend) ctx.advance(0, -(levels * rise + 2));
      for (let k = 0; k < levels; k++) {
        const run = k === 0 ? (descend ? 32 : 5) : 15 + rng() * 4;
        const th = 1.4 + rise;
        ctx.slab(KIND.SOLID, 0, run, w, { th, color: k % 2 ? c2 : c });
        if (k > 0) ctx.coinLine(run * 0.35, run - 1, 0, 3);
        ctx.advance(run);
        ctx.slab(KIND.BOUNCE, 0, pad, w, { th });
        ctx.addRing(0, pad + 0.6, rise + 1.7);
        ctx.advance(pad, rise);
      }
      // long top floor: jump pressed right after rolling onto a trampoline stacks (vy ~26), so flights
      // off the last one reach ~50 m at full speed and ~68 m with turbo (61.5 m of floor + air brake)
      ctx.slab(KIND.SOLID, 0, 54, w + 1, { th: 1.4 + rise, color: c });
      ctx.coinLine(8, 48, 0, 7);
      ctx.advance(54);
    },
  },

  // ------------------------------------------------------------------ s_ringJump
  // PORTAL TURBO: full-width boost pads, a full-width ramp and two lines of turbo rings in the air:
  // a low line along the plain launch arc and a high line along the arc you get by jumping at the
  // lip. Boosted launch speeds (~36-44 m/s) put both lines within ring reach for every vehicle.
  {
    name: 's_ringJump',
    weight: () => 0.6,
    early: true,
    gen(ctx) {
      const { KIND, rng } = ctx;
      const w = ctx.W() + 1;
      const c = ctx.pickColor();
      ctx.slab(KIND.SOLID, 0, 22, w, { color: c });
      ctx.slab(KIND.BOOST, 6, 10, w, { dy: 0.06, th: 0.3 });
      ctx.slab(KIND.BOOST, 13, 17, w, { dy: 0.06, th: 0.3 });
      ctx.banner(9, w, ['PORTAL TURBO', 'PULA NA PONTA!'], '#22d3ee', '#0b0d17', true);
      const rise = 2.4, rl = 7, lip = 22 + rl;
      ctx.ramp(22, lip, w, rise, ctx.shade(c));
      // feet height along the arc; ring centers sit 0.9 m above the feet
      const S = 39, k = rise / rl;
      const arc = (x, vy) => { const t = x / S; return rise + vy * t - 17 * t * t + 0.9; };
      for (const x of [4, 9, 14]) ctx.addRing(0, lip + x, arc(x, S * k));
      const vj = 12.8 + 0.6 * S * k;
      for (const x of [15, 21, 27]) ctx.addRing(0, lip + x, arc(x, vj));
      // short gap (a rider who brakes after the pads still clears it at ~15 m/s); long landing (a
      // scooter jumping at the lip at 48 m/s flies ~72 m)
      // deep down, land a little higher instead (steers the track back toward y = 0)
      // (the raised landing is only ~1.4 m below the lip, so its gap is shorter)
      const up = ctx.cur.y < -28;
      const gap = up ? 5.5 + rng() * 1.5 : 6.5 + rng() * 2.5, drop = up ? -(0.4 + rng() * 0.6) : 1.5 + rng() * 1.5;
      ctx.advance(lip + gap, -drop);
      const land = 76 - gap;
      ctx.slab(KIND.SOLID, 0, land, w + 2);
      ctx.coinLine(land * 0.45, land - 6, 0, 5);
      ctx.advance(land);
    },
  },

  // ------------------------------------------------------------------ s_iceChecker
  // XADREZ DE GELO: a checkerboard of ice and grippy tiles with a slalom of low kill blocks on top.
  // Grip comes and goes under your wheels; steer on the solid squares. Low blocks can be hopped.
  // The ice tiles sit 2 cm above one solid base slab (built first, so the center path follows it).
  {
    name: 's_iceChecker',
    weight: () => 0.55,
    minDist: 220,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w = Math.max(ctx.W() + 1, 7.5);
      solid(ctx, 7, w);
      ctx.banner(3.5, w, ['XADREZ DE GELO', 'PISA NO COLORIDO!'], '#bde7ff', '#1b1f3b', false);
      const cols = w >= 8.4 ? 4 : 3, t = w / cols, rowL = 3.4;
      const rows = 12 + Math.floor(rng() * 5 + d01 * 3);
      const L = rows * rowL;
      ctx.slab(KIND.SOLID, 0, L, w);
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k < cols; k++) {
          if ((r + k) % 2) continue;
          ctx.slab(KIND.ICE, r * rowL, (r + 1) * rowL, t, { off: (k - (cols - 1) / 2) * t, dy: 0.02, th: 0.4 });
        }
      }
      if (d01 < 0.4) {
        rail(ctx, 0, L, w, -1, { alt: true });
        rail(ctx, 0, L, w, 1);
      }
      // blocks alternate sides and stop short of the middle: a steady rider on the center line
      // threads them all, a jump over one lands beside the next
      const sp = 21 - d01 * 3;
      let side = rng() < 0.5 ? -1 : 1;
      for (let f = 11; f < L - 7; f += sp) {
        const bw = w * (0.4 + d01 * 0.04);
        ctx.box(KIND.KILL, side * (w - bw) / 2, f, 0.5, bw, 1.0, 1.2);
        ctx.coinLine(f - 3, f + 3, -side * (w - bw) / 2, 3);
        side = -side;
      }
      ctx.advance(L);
      solid(ctx, 9, w);
    },
  },

  // ------------------------------------------------------------------ s_funPark
  // PARQUE FELIZ: a full-width boost pad, then you drop into a walled trampoline pit full of turbo
  // rings and coins, and bounce out over the far wall onto a long exit. Can't go wrong: falling short
  // means another bounce, too fast means a bonk on the far wall and another bounce.
  {
    name: 's_funPark',
    weight: () => 0.5,
    early: true,
    gen(ctx) {
      const { KIND, rng } = ctx;
      const w = Math.max(ctx.W(), 7) + 2;
      // pit long enough that a rider who jumps off the edge at boosted speed lands on the trampoline
      // (not against the far wall) and the first bounce of everyone else clears that wall
      const drop = 2.4, PL = 42 + rng() * 3;
      solid(ctx, 8, w);
      ctx.banner(4, w, ['PARQUE FELIZ', 'SEM MEDO DE SER FELIZ!'], '#ff4fa3', '#ffffff', true);
      ctx.slab(KIND.SOLID, 0, 12, w);
      ctx.slab(KIND.BOOST, 2, 6, w, { dy: 0.06, th: 0.3 });
      ctx.coinLine(7, 11, 0, 2);
      ctx.advance(12);
      // the pit: bouncy floor, tall side walls (4.6 m above the floor; they block up to 4.1 m, bounces
      // peak at 6.6-8.5 m, so coins stay well inside to not lure riders over them)
      ctx.slab(KIND.BOUNCE, 0, PL, w, { dy: -drop });
      for (const s of [-1, 1]) {
        ctx.slab(KIND.SOLID, -0.5, PL + 0.5, 0.8, { off: s * (w / 2 + 0.4), dy: 2.2, th: drop + 3.6, noDist: true, color: s < 0 ? ctx.colors.WHITE : ctx.colors.BOUNCE });
      }
      [11, 19, 27, 35].forEach((x, i) => ctx.addRing((i % 2 ? 1 : -1) * 1.2, x, -drop + 4.4 + (i % 2) * 0.8));
      for (let i = 0; i < 8; i++) ctx.addCoin(Math.sin(i * 1.3) * (w / 2 - 3), 6 + i * 4.6, -drop + 3 + (i % 3) * 0.7);
      ctx.advance(PL);
      // far wall + long exit: a max bounce (vy 24) right before the wall at turbo carries ~62 m
      ctx.slab(KIND.SOLID, 0, 60, w, { th: 1.4 + drop });
      ctx.coinLine(10, 50, 0, 7);
      ctx.advance(60);
    },
  },

  // ------------------------------------------------------------------ s_dualBelts
  // ESCOLHE A ESTEIRA: two side-by-side lanes (switch any time; no divider wall, whose nose would
  // stop a rider coming down the middle). One lane is a fast forward belt with kill blocks to dodge,
  // the other a slow backward belt that pays in turbo rings. A funnel brings both back together.
  {
    name: 's_dualBelts',
    weight: () => 0.5,
    minDist: 300,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w0 = ctx.W();
      const lw = 4.8, w = lw * 2 + 0.8;
      const fast = rng() < 0.5 ? -1 : 1; // side of the fast lane
      const L = 52 + Math.floor(rng() * 3) * 6;
      solid(ctx, 8, w);
      ctx.banner(4, w, ['ESCOLHE A ESTEIRA', 'RÁPIDA OU SEGURA?'], '#2b2d42', '#ffd23f', true);
      const lane = (s) => s * (lw / 2 + 0.4);
      belt(ctx, 0, L, lw, 8 + d01 * 4, 'fwd', { off: lane(fast) });
      belt(ctx, 0, L, lw, 5 + d01 * 2, 'back', { off: lane(-fast) });
      // flat strip between the lanes, with white dashes painted on it
      ctx.slab(KIND.SOLID, 0, L, 0.8, { noDist: true, color: ctx.colors.KERB_DARK });
      for (let f = 2; f < L - 2; f += 6) ctx.decor(0, f + 1.5, 0.01, 0.3, 0.04, 3, { color: ctx.colors.WHITE });
      if (d01 < 0.5) for (const s of [-1, 1]) rail(ctx, 0, L, w, s, { alt: s > 0 });
      // fast lane: kill blocks alternating across the lane, coins on the free side. Spaced well past
      // a jump's length (~23 m at own speed: the belt does not push you in the air); they stop
      // short of the lane's middle, so a dead-straight line threads them even at turbo
      let side = rng() < 0.5 ? -1 : 1;
      for (let f = 22; f < L - 8; f += 29) {
        const bw = lw * 0.38;
        ctx.box(KIND.KILL, lane(fast) + side * (lw - bw) / 2, f, 0.5, bw, 1.0, 1.2);
        ctx.coinLine(f - 4, f + 4, lane(fast) - side * lw / 4, 3);
        side = -side;
      }
      // slow lane: turbo rings on the ground line
      for (let f = 10; f < L - 6; f += 13) ctx.addRing(lane(-fast), f, 1.85);
      ctx.advance(L);
      funnel(ctx, w, w0, 12, 8);
    },
  },
];
