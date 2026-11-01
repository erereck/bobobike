// bobobike piece pack: terrain. Default export: array of piece definitions (see SPEC.md "v4").
// Theme: the SHAPE of the course — waves, mega ramps, split lanes, tunnels, funnels, cascades,
// floating islands, S-curves, rail bridges and a ski jump. Everything goes through ctx.

const G = 34; // gravity (m/s²), mirrors CONFIG.gravity
// Jump-pad climbs (pad vy 21, forward >= 19 m/s) onto a deck 3.6-4.0 m higher: with a 4 m pad and the
// deck's front edge 17 m after the pad's near edge, a 19 m/s launch from the near edge lands on the
// deck (~18.7 m) and a 48 m/s (turbo) launch from the far edge still clears the edge rising (13 m).
const PAD_DECK = 17;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

// +1 = turn left (yaw grows), -1 = turn right. Pulls the heading back toward -Z when it drifts.
function turnDir(ctx, lim = 0.45) {
  const y = ctx.cur.yaw;
  if (y > lim) return -1;
  if (y < -lim) return 1;
  return ctx.rng() < 0.5 ? -1 : 1;
}

// -1 when the course is high (prefer going down), +1 when low (prefer going up), else 0.
function heightPull(ctx, lim = 28) {
  const y = ctx.cur.y;
  return y > lim ? -1 : y < -lim ? 1 : 0;
}

// Coins along a ballistic arc leaving forward f0 at height h0 with speeds (vf, vy).
function arcCoins(ctx, f0, h0, vf, vy, n, dt = 0.1, t0 = 0.08) {
  for (let i = 0; i < n; i++) {
    const t = t0 + i * dt;
    ctx.addCoin(0, f0 + vf * t, h0 + vy * t - 0.5 * G * t * t + 0.9);
  }
}

export default [
  // ------------------------------------------------------------------ ONDAS
  // Rollercoaster rhythm: small/big bumps on a continuous road. Fast riders hop crest to crest;
  // later on the troughs open into short pits right behind each crest (the crest shadows them).
  {
    name: 't_waves',
    early: true,
    weight: (d) => 0.8 - d * 0.15,
    gen(ctx) {
      const { KIND } = ctx, rng = ctx.rng, d01 = ctx.d01;
      const w = Math.max(ctx.W() + 1.2, 7);
      const c = ctx.pickColor(), cs = ctx.shade(c), road = ctx.pickColor();
      const pits = ctx.cur.dist > 400 && d01 > 0.25 && rng() < 0.3 + d01 * 0.45;
      // 3-4 bumps: leaves room for the long exit within the 130 m piece budget
      const n = Math.min(4, 3 + Math.floor(rng() * 1.4 + d01 * 0.9));
      ctx.slab(KIND.SOLID, 0, 8, w, { color: road });
      ctx.advance(8);
      // the big bump comes first so turbo flights off it (lip jump at 48 m/s: ~65 m) still land
      // inside the piece: it is followed by >= 2 bumps and the 48 m exit (>= 75 m of road)
      const bigIdx = 0;
      for (let i = 0; i < n; i++) {
        const last = i === n - 1;
        let h = last ? 0.7 + rng() * 0.25 : (i % 2 ? 1.45 : 0.9) + rng() * 0.5 + d01 * 0.35;
        if (i === bigIdx) h += 0.5;
        if (i === n - 2 && i !== bigIdx) h = Math.min(h, 1.1);
        const len = last ? h * 5.5 : 3.6 + h * 2.1; // slope ~0.25-0.3 (last one gentle)
        const pit = pits && !last ? 1.6 + d01 * 1.5 + rng() * 0.4 : 0;
        const flat = pit ? 6 + rng() * 2 : 6 + rng() * 3.5;
        // road under the bump (and the trough when there is no pit)
        ctx.slab(KIND.SOLID, 0, pit ? len : len + flat, w, { color: road });
        ctx.ramp(0, len, w, h, i % 2 ? c : cs);
        // coins over the crest follow a medium-speed hop
        const v = 22, k = h / len;
        arcCoins(ctx, len, h, v, v * k, 3, 0.1);
        if (i === bigIdx) ctx.addRing(0, len + 7.5, h + 3.4);
        ctx.advance(len);
        if (pit) {
          ctx.advance(pit);
          ctx.slab(KIND.SOLID, 0, flat, w, { color: road });
        }
        ctx.advance(flat);
      }
      // long exit: a turbo lip jump off the last bump (scooter 48 m/s: ~52 m from the crest) lands
      // here, not in a gap after the piece (30 m was measured too short)
      ctx.slab(KIND.SOLID, 0, 48, w, { color: road });
      ctx.coinLine(8, 40, 0, 5);
      ctx.advance(48);
    },
  },

  // ------------------------------------------------------------------ MEGA RAMPA
  // Two full-width boost pads guarantee speed, a 4-6 m ramp throws you into a long flight through
  // turbo rings, and a huge landing deck (lip + 88 m) catches even turbo + lip-jump flights.
  {
    name: 't_megaRamp',
    minDist: 280,
    weight: (d) => 0.45 + d * 0.15,
    gen(ctx) {
      const { KIND } = ctx, rng = ctx.rng, d01 = ctx.d01;
      const w = Math.max(ctx.W(), 7) + 3;
      const c = ctx.pickColor(), road = ctx.pickColor();
      const pull = heightPull(ctx, 25);
      ctx.slab(KIND.SOLID, 0, 22, w, { color: road });
      ctx.banner(4, w, ['MEGA RAMPA', 'SEGURA O W!'], '#1b1f3b', '#ffd23f', true);
      ctx.slab(KIND.BOOST, 9, 13, w, { dy: 0.06, th: 0.3 });
      ctx.slab(KIND.BOOST, 16, 20, w, { dy: 0.06, th: 0.3 });
      ctx.coinLine(10, 20, 0, 4);
      ctx.advance(22);
      const L = 13 + rng() * 2;
      const R = 4.2 + rng() * 0.8 + d01 * 0.6;
      ctx.ramp(0, L, w, R, c);
      // lip towers + striped kerbs on the ramp sides (visual)
      for (const s of [-1, 1]) {
        ctx.decor(s * (w / 2 + 0.7), L - 0.6, R / 2 + 1.6, 1.1, R + 3.2, 1.1, { color: ctx.colors.WHITE });
        ctx.decor(s * (w / 2 + 0.7), L - 0.6, R + 3.4, 1.5, 0.6, 1.5, { color: ctx.colors.BOOST, vkind: KIND.BOOST });
      }
      ctx.advance(L);
      // short gap: a rider who bonks on the ramp face (jumping at its foot while still rising) reaches
      // the lip at ~14 m/s and still clears it
      const gap = 5 + d01 * 2;
      const D = pull < 0 ? 3 : pull > 0 ? 0 : 1.5;
      // flight: rings follow a mid-speed no-jump arc (only where the arc is still well above the
      // landing deck: a flat ramp's arc lands before t = 1 s and that ring would sit in the floor)
      const v = 35, vy = v * (R / L);
      for (const t of [0.35, 0.7, 1.0]) {
        const h = R + vy * t - 0.5 * G * t * t + 0.9;
        if (h > -D + 2.4) ctx.addRing(0, v * t, h);
      }
      // deck ends 88 m past the lip: the worst flight (scooter 48 m/s + lip jump off the steepest
      // ramp, R 5.6 / L 13, deck 3 m lower) lands ~84 m out
      const land = 88 - gap;
      ctx.advance(gap, -D);
      ctx.slab(KIND.SOLID, 0, land, w + 4, { color: road, th: 2 });
      // landing zone marks every 15 m
      for (let f = 12, i = 0; f < land - 6; f += 15, i++) {
        ctx.decor(0, f, 0.04, w + 4, 0.1, 0.9, { color: i % 2 ? ctx.colors.KERB_DARK : ctx.colors.WHITE });
      }
      ctx.coinLine(land * 0.45, land - 6, -2, 4);
      ctx.coinLine(land * 0.45, land - 6, 2, 4);
      ctx.advance(land);
    },
  },

  // ------------------------------------------------------------------ ESCOLHA
  // The road splits into 3 parallel lanes over the void: a plain safe lane, a boost lane with
  // short roll-over gaps and coins, and in the center a kicker over a gap through turbo rings, the
  // safe lane, or a stepping-stone lane. There is always a center lane, so a long flight that
  // arrives straight lands on something. Lanes merge into a wide exit.
  {
    name: 't_split',
    minDist: 260,
    weight: (d) => 0.7,
    gen(ctx) {
      const { KIND } = ctx, rng = ctx.rng, d01 = ctx.d01;
      const lw = Math.max(3.3, 4.1 - d01 * 0.8);
      const sep = 2.3 + rng() * 0.6;
      const step = lw + sep;
      const xs = [-step, 0, step];
      const TW = Math.max(ctx.W(), 3 * lw + 2 * sep);
      const road = ctx.pickColor();
      // long entry: a turbo hop over a gap before this piece lands here, not between the lanes
      ctx.slab(KIND.SOLID, 0, 26, TW, { color: road });
      ctx.banner(12, TW, ['ESCOLHA!', 'SEGURO OU RADICAL?'], '#ffffff', '#1b1f3b', false);
      ctx.advance(26);
      const LL = 50;
      const center = rng() < 0.6 ? 'ramp' : 'safe';
      const sides = center === 'ramp' ? ['safe', 'boost'] : ['boost', 'hop'];
      if (rng() < 0.5) sides.reverse();
      const kinds = [sides[0], center, sides[1]];
      // the safe lane is built first: its collider is then the track's reference path (headless bot)
      const order = xs.map((_, i) => i).sort((a, b) => (kinds[a] === 'safe' ? -1 : 0) - (kinds[b] === 'safe' ? -1 : 0));
      for (const li of order) {
        const x = xs[li], kind = kinds[li], c = ctx.pickColor();
        if (kind === 'safe') {
          ctx.slab(KIND.SOLID, 0, LL, lw, { off: x, color: c });
          ctx.addCoin(x, LL * 0.3); ctx.addCoin(x, LL * 0.6);
        } else if (kind === 'boost') {
          // full-lane boost pad, then platforms with short gaps that you roll over at boost speed
          // (gaps stay <= 4.7 m: at boost speed (>= 31 m/s) you drop < 0.4 m crossing one)
          let f = 0, i = 0;
          const gaps = 3;
          ctx.slab(KIND.BOOST, 1, 5, lw, { off: x, dy: 0.06, th: 0.3 });
          while (f < LL - 1) {
            const len = i === 0 ? 11 : i <= gaps - 1 ? 8 + rng() * 2 : LL - f;
            ctx.slab(KIND.SOLID, f, f + len, lw, { off: x, color: i % 2 ? ctx.shade(c) : c });
            if (i > 0 && i < gaps + 1 && rng() < 0.6) ctx.slab(KIND.BOOST, f + 1, f + 3.5, lw, { off: x, dy: 0.06, th: 0.3 });
            f += len;
            if (i < gaps && f < LL - 8) {
              const g = 3.0 + d01 * 1.2 + rng() * 0.5;
              for (let k = 0; k < 3; k++) ctx.addCoin(x, f + g * (k + 0.5) / 3, 1.4);
              f += g;
            }
            i++;
          }
        } else if (kind === 'ramp') {
          const rl = 6, rise = 1.8, r0 = 6, gap = 5.5 + d01 * 1.5;
          ctx.slab(KIND.SOLID, 0, r0 + rl, lw, { off: x, color: c });
          ctx.slab(KIND.BOOST, 1, 4.5, lw, { off: x, dy: 0.06, th: 0.3 });
          ctx.ramp(r0, r0 + rl, lw, rise, ctx.shade(c)); // center lane only (ramps cannot be offset)
          const lip = r0 + rl;
          const v = 33, vy = v * rise / rl;
          for (const t of [0.3, 0.6]) ctx.addRing(x, lip + v * t, rise + vy * t - 0.5 * G * t * t + 0.9);
          ctx.slab(KIND.SOLID, lip + gap, LL, lw, { off: x, color: c });
          ctx.coinLine(lip + gap + 10, LL - 4, x, 4);
        } else {
          // stepping stones: roll over them fast, or hop stone to stone
          let f = 0;
          ctx.slab(KIND.SOLID, 0, 6, lw, { off: x, color: c });
          f = 6;
          let i = 0;
          while (f < LL - 12) {
            const g = 1.8 + d01 * 1.2 + rng() * 0.6;
            f += g;
            const s = 3.4;
            const ox = x + (rng() - 0.5) * 0.8;
            ctx.slab(KIND.SOLID, f, f + s, s, { off: ox, th: 6, color: i % 2 ? c : ctx.shade(c) });
            ctx.addCoin(ox, f + s / 2, 1.5);
            f += s;
            i++;
          }
          f += 2;
          ctx.slab(KIND.SOLID, f, LL, lw, { off: x, color: c });
        }
      }
      ctx.advance(LL);
      // hidden strip inside the merge deck that continues the safe lane's line: keeps the reference
      // path (headless bot / record gate) from cutting diagonally across the void toward the center
      const safeX = xs[kinds.indexOf('safe')] ?? 0;
      if (safeX) ctx.slab(KIND.SOLID, 0, 14, lw, { off: safeX, dy: -0.03, th: 0.5, color: road });
      // long merge deck: turbo hops off the last stones / gaps / the kicker land on it (a scooter's
      // turbo + lip jump off the kicker comes down ~63 m past its lip, i.e. ~25 m into this deck)
      ctx.slab(KIND.SOLID, 0, 30, TW, { color: road });
      ctx.coinLine(10, 24, 0, 3);
      ctx.advance(30);
    },
  },

  // ------------------------------------------------------------------ TÚNEL
  // A (slightly bending) tunnel: solid side walls you cannot fall past, decor arches and roof ribs.
  // Inside: boost pads + coins (early), low kill bars to hop, or a half-width slalom.
  {
    name: 't_tunnel',
    early: true,
    weight: (d) => 0.7,
    gen(ctx) {
      const { KIND } = ctx, rng = ctx.rng, d01 = ctx.d01;
      const w = clamp(ctx.W() + 0.6, 6.4, 9);
      let n = 6 + Math.floor(rng() * 3 + d01 * 2);
      const L = 6;
      const bend = rng() < 0.6 ? turnDir(ctx, 0.5) * (0.02 + rng() * 0.03) : 0;
      // walls > jump apex (2.8 m) + step-up (0.5 m): a hop cannot clear them or land on their top
      const wallH = 3.6, wallT = 0.8, archY = 7.4;
      const floor = ctx.pickColor(), wall = ctx.pickColor(), arch = ctx.pickColor();
      const modes = d01 < 0.12 ? ['boost'] : ['boost', 'bars', 'slalom', 'bars'];
      const mode = modes[Math.floor(rng() * modes.length)];
      // hazard segments. The first one is in segment 5 (~40 m in, ~54 m past a gap before the piece):
      // a turbo hop over that gap comes down <= ~45 m past it (bot runs landed on bars placed in
      // segment 2). Bars are 36 m apart: a hop flies 0.72-0.81 s, i.e. up to ~35 m at turbo, so it
      // always lands before the next bar. Slalom blocks are steered around: 24 m apart, 18 m later on.
      const haz = new Set();
      if (mode === 'bars') { n = 13; haz.add(5); haz.add(11); }
      else if (mode === 'slalom') {
        n = 11 + Math.floor(rng() * 2 + d01);
        for (let i = 5; i <= n - 2; i += d01 > 0.5 ? 3 : 4) haz.add(i);
      }
      const lastHaz = haz.size ? Math.max(...haz) : -1;
      // floor after the last hazard (tunnel + exit) >= 37 m: a turbo hop over it lands inside the piece
      const exitL = lastHaz < 0 ? 10 : Math.max(10, 37 - ((n - 1 - lastHaz) * L + L / 2));
      ctx.slab(KIND.SOLID, 0, 8, w + 2 * wallT, { color: floor });
      if (mode === 'boost') ctx.banner(2, w + 2 * wallT, ['TÚNEL TURBO', 'ACELERA!'], '#1b1f3b', '#7df9ff', true);
      ctx.advance(8);
      let side = rng() < 0.5 ? -1 : 1;
      for (let i = 0; i < n; i++) {
        ctx.slab(KIND.SOLID, -0.15, L + 0.15, w, { color: i % 2 ? floor : ctx.shade(floor) });
        for (const s of [-1, 1]) {
          ctx.slab(KIND.SOLID, -0.2, L + 0.2, wallT, { off: s * (w / 2 + wallT / 2), dy: wallH, th: wallH + 1.4, color: wall, noDist: true });
          ctx.decor(s * (w / 2 + wallT / 2), 0.45, (wallH + archY) / 2, wallT + 0.2, archY - wallH, 0.9, { color: arch });
        }
        ctx.decor(0, 0.45, archY, w + 2 * wallT + 0.2, 0.8, 0.9, { color: arch });
        if (i % 2 === 1) ctx.decor(0, L / 2 + 0.45, archY + 0.1, w + 2 * wallT, 0.35, L - 1.2, { color: wall });
        // content: never in the first or last segment
        if (i > 0 && i < n - 1) {
          if (mode === 'boost') {
            if (i % 2 === 1) ctx.slab(KIND.BOOST, 1, 5, Math.min(w, 4.5), { dy: 0.06, th: 0.3 });
            else ctx.coinLine(1, 5, 0, 3);
          } else if (mode === 'bars' && haz.has(i)) {
            ctx.slab(KIND.KILL, 2.6, 3.4, w, { dy: 0.45, th: 0.45 });
            ctx.addCoin(0, 3, 2.6);
          } else if (mode === 'slalom' && haz.has(i)) {
            const bw = w * 0.42;
            ctx.slab(KIND.KILL, 2.3, 3.7, bw, { off: side * (w - bw) / 2, dy: 1.05, th: 1.05 });
            ctx.addCoin(-side * bw / 2, 3, 1.15);
            side = -side;
          }
        }
        ctx.advance(L);
        if (bend) ctx.turn(bend);
      }
      ctx.slab(KIND.SOLID, 0, exitL, w + 2 * wallT, { color: floor });
      if (exitL > 16) ctx.coinLine(8, exitL - 6, 0, 3);
      ctx.advance(exitL);
    },
  },

  // ------------------------------------------------------------------ FUNIL
  // A wide mouth squeezed by two angled walls into a narrow neck with a boost pad. Coins converge
  // toward the neck; later on a few kill cubes sit in the mouth and the neck loses its rails.
  {
    name: 't_funnel',
    early: true,
    weight: (d) => 0.6,
    gen(ctx) {
      const { KIND } = ctx, rng = ctx.rng, d01 = ctx.d01;
      const Wm = clamp(ctx.W() + 5, 12, 15);
      const Wn = Math.max(3.0, 4.4 - d01 * 1.4);
      const Lf = 26 + rng() * 6;
      const Ln = 12 + d01 * 6 + rng() * 4;
      const floor = ctx.pickColor(), wall = ctx.pickColor(), neckC = ctx.pickColor();
      ctx.slab(KIND.SOLID, 0, 7, Wm, { color: floor });
      ctx.advance(7);
      // stepped floor under the converging walls (each step a bit wider than the walls at its start)
      const segs = Math.ceil(Lf / 4);
      for (let i = 0; i < segs; i++) {
        const f0 = (i * Lf) / segs, f1 = ((i + 1) * Lf) / segs;
        const wi = lerp(Wm, Wn, f0 / Lf) + 0.7;
        ctx.slab(KIND.SOLID, f0 - 0.05, f1 + 0.05, wi, { color: i % 2 ? floor : ctx.shade(floor) });
      }
      // walls taller than any jump apex (2.8 m) + the 0.5 m step-up (collide ignores a wall's top
      // 0.5 m): a rider hopping a kill cube near a wall cannot sail over it into the void
      const wallT = 0.6, wallH = 3.6;
      const cubes = [];
      if (d01 > 0.2) {
        const nCubes = 2 + Math.floor(rng() * (1 + d01 * 2.5));
        for (let k = 0; k < nCubes; k++) {
          const f = Lf * (0.2 + 0.55 * (k + rng() * 0.5) / nCubes);
          const half = lerp(Wm, Wn, f / Lf) / 2;
          const side = k % 2 ? 1 : -1;
          const x = side * (1.3 + rng() * Math.max(0.2, half - 2.6));
          ctx.box(KIND.KILL, x, f, 0.6, 1.2, 1.2, 1.2);
          cubes.push([x, f]);
        }
      }
      for (const s of [-1, 1]) {
        const x0 = s * (Wm / 2 + wallT / 2 - 0.3), x1 = s * (Wn / 2 + wallT / 2);
        const dx = x1 - x0, lw = Math.hypot(dx, Lf);
        ctx.box(KIND.SOLID, (x0 + x1) / 2, Lf / 2, wallH / 2, wallT, wallH, lw, { yaw: Math.atan2(-dx, Lf), color: wall });
        // coins sliding down along the walls into the neck (never right next to a kill cube)
        for (let k = 0; k < 4; k++) {
          const t = 0.2 + k * 0.22;
          const cx = lerp(x0, x1, t) * 0.62, cf = Lf * t;
          if (cubes.some(([x, f]) => Math.hypot(x - cx, f - cf) < 2.4)) continue;
          ctx.addCoin(cx, cf);
        }
      }
      ctx.advance(Lf);
      // the neck
      ctx.slab(KIND.SOLID, -0.1, Ln, Wn, { color: neckC });
      ctx.slab(KIND.BOOST, 1, 5, Wn, { dy: 0.06, th: 0.3 });
      ctx.coinLine(6, Ln - 1, 0, 4);
      if (d01 < 0.45) {
        for (const s of [-1, 1]) {
          ctx.slab(KIND.SOLID, 0, Ln, 0.5, { off: s * (Wn / 2 + 0.25), dy: 0.7, th: 2.1, color: ctx.colors.WHITE, noDist: true });
        }
      }
      ctx.advance(Ln);
      ctx.slab(KIND.SOLID, 0, 12, Math.max(ctx.W(), 7), { color: floor });
      ctx.advance(12);
    },
  },

  // ------------------------------------------------------------------ CASCATA
  // A staircase of terraces dropping 1-2.4 m each (small gaps and side shifts later on). Fast riders
  // fly over several terraces; the last one is long. When the course is already low, a jump pad
  // first throws you up onto a high deck and the drops are shallow (net height goes up).
  {
    name: 't_cascade',
    early: false,
    minDist: 300,
    weight: (d) => 0.65,
    gen(ctx) {
      const { KIND } = ctx, rng = ctx.rng, d01 = ctx.d01;
      const w = Math.max(ctx.W(), 6.5) + 0.5;
      const low = ctx.cur.y < -24;
      const n = low ? 3 : 4 + Math.floor(rng() * 2.5);
      const c = ctx.pickColor(), c2 = ctx.pickColor();
      if (low) {
        // pad climb (see PAD_DECK notes): 4 m pad, deck front 17 m after its near edge; the pad
        // sits at the end of a 32 m runway so a turbo hop over a gap before the piece (up to ~47 m
        // with a drop) lands before it instead of sailing past it into the wall of the high deck.
        // Turbo pad flights overshoot the 22 m deck onto the (lower) terraces.
        const rise = 3.8 + rng() * 0.2;
        ctx.slab(KIND.SOLID, 0, 36, w, { color: ctx.shade(c) });
        ctx.slab(KIND.JUMP, 32, 36, w, { dy: 0.06, th: 0.3 });
        ctx.coinLine(8, 28, 0, 5);
        ctx.advance(32);
        ctx.addRing(0, 11, 7.2);
        ctx.advance(PAD_DECK, rise);
        ctx.slab(KIND.SOLID, 0, 22, w + 1, { th: 1.4 + rise, color: c });
        ctx.coinLine(8, 19, 0, 4);
        ctx.advance(22);
      } else {
        ctx.slab(KIND.SOLID, 0, 8, w, { color: ctx.shade(c) });
        ctx.coinLine(3, 7, 0, 2);
        ctx.advance(8);
      }
      let off = 0, dropLeft = 11; // net height change stays within the ±12 m rule
      for (let i = 0; i < n; i++) {
        const want = low ? 0.8 + rng() * 0.4 : 1.2 + rng() * 0.8 + d01 * 0.4;
        const drop = Math.max(0.8, Math.min(want, dropLeft - 0.8 * (n - 1 - i)));
        dropLeft -= drop;
        const gap = d01 > 0.25 && rng() < 0.6 ? 0.8 + rng() * 1.2 : 0;
        // coins hang where a medium-speed rider falls off the edge
        ctx.addCoin(off, gap * 0.5 + 2, -drop * 0.25 + 0.4);
        ctx.advance(gap, -drop);
        if (d01 > 0.4) off = clamp(off + (rng() - 0.5) * 2.4, -1.4, 1.4);
        // last terrace + exit >= 34 m: a turbo hop off the previous edge lands on it
        const len = i === n - 1 ? (low ? 24 : 28) : 7 + rng() * 2 - d01;
        ctx.slab(KIND.SOLID, 0, len, w, { off, th: 3, color: i % 2 ? c : c2 });
        // white lip stripe on each terrace edge so the drops read from the chase camera
        if (i < n - 1) ctx.decor(off, len - 0.35, 0.05, w, 0.1, 0.7, { color: ctx.colors.WHITE });
        if (i === 1 && !low) ctx.addRing(off, 7, 2.6);
        ctx.advance(len);
      }
      ctx.slab(KIND.SOLID, 0, 10, w, { off, color: c });
      ctx.advance(10);
    },
  },

  // ------------------------------------------------------------------ PONTE
  // A long, narrow, gently swaying suspension bridge with low side rails (0.7 m solid kerbs), tall
  // towers at both ends and hanger posts. Later: missing rail sections and kill strips to hop.
  {
    name: 't_bridge',
    early: true,
    weight: (d) => 0.7,
    gen(ctx) {
      const { KIND } = ctx, rng = ctx.rng, d01 = ctx.d01;
      const bw = Math.max(2.9, 3.9 - d01 * 1.1);
      // kill bars sit 5 segments (40 m) apart: a hop flies up to ~35 m at turbo, so it always lands
      // before the next bar; the first one is 44 m in (~58 m past a gap before the piece: a turbo
      // hop over that gap comes down <= ~45 m past it)
      const bars = d01 > 0.3 ? (rng() < 0.35 + d01 * 0.5 ? 2 : 1) : 0;
      const n = bars === 2 ? 11 : bars ? 6 + Math.floor(rng() * 2) : 5 + Math.floor(rng() * 3);
      const L = 8;
      const barAt = new Set(bars ? (bars > 1 ? [4, 9] : [4]) : []);
      const lastBar = bars ? (bars > 1 ? 9 : 4) : -1;
      // deck after the last bar (bridge + exit) >= 37 m: a turbo hop over it lands inside the piece
      const exitL = lastBar < 0 ? 10 : Math.max(10, 37 - ((n - 1 - lastBar) * L + L / 2));
      const w0 = Math.max(ctx.W(), 6);
      const deck = ctx.pickColor(), tower = ctx.pickColor();
      const towers = () => {
        // solid posts just outside the rail line (riding through a 9.6 m tower looked broken)
        for (const s of [-1, 1]) ctx.box(KIND.SOLID, s * (bw / 2 + 1.1), 0.6, 4.2, 1.1, 9.6, 1.1, { color: tower });
        ctx.decor(0, 0.6, 8.8, bw + 3.3, 0.8, 1.1, { color: tower });
      };
      ctx.slab(KIND.SOLID, 0, 8, w0, { color: deck });
      ctx.advance(7);
      towers();
      ctx.advance(1);
      let dir = turnDir(ctx, 0.4);
      const sway = 0.02 + rng() * 0.03;
      let broken = d01 > 0.35 && rng() < 0.6 ? 2 + Math.floor(rng() * (n - 3)) : -1;
      for (let i = 0; i < n; i++) {
        const ext = bw * sway * 0.6;
        ctx.slab(KIND.SOLID, -0.15, L + ext, bw, { color: i % 2 ? deck : ctx.shade(deck), th: 1.0 });
        for (const s of [-1, 1]) {
          const missing = i === broken && s === (broken % 2 ? 1 : -1);
          if (!missing) {
            ctx.slab(KIND.SOLID, -0.1, L + 0.2, 0.4, { off: s * (bw / 2 + 0.2), dy: 0.7, th: 1.7, color: i % 2 ? ctx.colors.WHITE : ctx.colors.KERB_DARK, noDist: true });
            ctx.decor(s * (bw / 2 + 0.2), L / 2, 2.0, 0.18, 2.6, 0.18, { color: tower });
          }
          ctx.decor(s * (bw / 2 + 0.2), L / 2, 3.35, 0.25, 0.25, L + 0.4, { color: tower });
        }
        if (barAt.has(i)) {
          ctx.slab(KIND.KILL, L / 2 - 0.4, L / 2 + 0.4, bw, { dy: 0.45, th: 0.45 });
          ctx.addCoin(0, L / 2, 2.7);
        } else if (i % 2 === 0) ctx.coinLine(2, L - 2, 0, 2);
        ctx.advance(L);
        ctx.turn(dir * sway);
        if (i % 2 === 1) dir = -dir;
      }
      towers();
      ctx.slab(KIND.SOLID, -0.15, exitL, w0, { color: deck });
      if (exitL > 16) ctx.coinLine(8, exitL - 6, 0, 3);
      ctx.advance(exitL);
    },
  },

  // ------------------------------------------------------------------ CURVA S
  // An S (left-right-left or the mirror) built from short segments, with small gaps (1-2.6 m, the
  // far side 0.15 m lower) that you roll over at speed. Kerbs on the outside early on.
  {
    name: 't_scurve',
    minDist: 260,
    weight: (d) => 0.75,
    gen(ctx) {
      const { KIND } = ctx, rng = ctx.rng, d01 = ctx.d01;
      const w = Math.max(ctx.W(), 5.6) + 0.4;
      const L = 3.6;
      const half = 4 + Math.floor(rng() * 3);
      const y0 = ctx.cur.yaw;
      const dir = turnDir(ctx, 0.3);
      // the S swings A to one side, 2A back, A again: keep both extremes inside the yaw limit.
      // <= 0.09 rad per 3.6 m (radius >= 40 m): the scooter at turbo (48 m/s, 1.45 rad/s) can follow it
      const A = Math.min(half * (0.065 + rng() * 0.025), 1.08 - Math.abs(y0));
      const step = A / half;
      const c = ctx.pickColor(), c2 = ctx.shade(c);
      const rails = d01 < 0.6;
      const gdy = ctx.cur.y < -30 ? 0 : -0.15; // gaps step down a little, never when already low
      const plan = [];
      for (let i = 0; i < half; i++) plan.push(dir);
      for (let i = 0; i < half * 2; i++) plan.push(-dir);
      for (let i = 0; i < half; i++) plan.push(dir);
      ctx.slab(KIND.SOLID, 0, 7, w, { color: c2 });
      ctx.advance(7);
      let lastGap = 0;
      for (let i = 0; i < plan.length; i++) {
        const d = plan[i];
        const canGap = i > 1 && i < plan.length - 4 && i - lastGap >= 3;
        if (canGap && rng() < 0.45 + d01 * 0.3) {
          const g = 1.0 + d01 * 1.2 + rng() * 0.4;
          ctx.addCoin(0, g / 2, 1.3);
          ctx.advance(g, gdy);
          lastGap = i;
        }
        ctx.slab(KIND.SOLID, -0.15, L + w * step * 0.6, w, { color: i % 2 ? c : c2 });
        if (rails) {
          // kerb on the outside of the turn (d +1 = yaw grows = left turn, so outside = +lx)
          ctx.slab(KIND.SOLID, 0, L + 0.3, 0.7, { off: d * (w / 2 + 0.35), dy: 0.7, th: 2.1, color: i % 2 ? ctx.colors.KERB_DARK : ctx.colors.WHITE, noDist: true });
        }
        if (i % 3 === 1) ctx.addCoin(-d * w * 0.22, L / 2);
        ctx.advance(L);
        ctx.turn(d * step);
      }
      // >= 34 m of road after the last gap: a turbo hop over it lands inside the piece
      ctx.slab(KIND.SOLID, -0.15, 20, w, { color: c2 });
      ctx.advance(20);
    },
  },

  // ------------------------------------------------------------------ SALTO DE ESQUI
  // Climb an inrun ramp, hit the boost on the start deck, fly off a small lip over a stepped
  // landing hill with distance boards (10 m apart) and a long outrun. The hill starts right under
  // the lip, so a slow rider just drops onto it; fast flights land on the hill or the outrun.
  {
    name: 't_skiJump',
    minDist: 300,
    weight: (d) => 0.45,
    gen(ctx) {
      const { KIND } = ctx, rng = ctx.rng, d01 = ctx.d01;
      const w = Math.max(ctx.W(), 7) + 1;
      const c = ctx.pickColor(), snow = ctx.colors.WHITE, hillC = ctx.col3('#dfe9f5');
      const low = ctx.cur.y < -30;
      const Ri = 2.4 + rng() * 0.4;
      // gentle inrun (slope 0.14): a turbo rider who jumps at its foot is still less than 0.5 m
      // under the surface at the apex, so the landing check catches him (a rising rider cannot land)
      const inL = Ri / 0.14;
      ctx.slab(KIND.SOLID, 0, 6, w, { color: c });
      ctx.advance(6);
      ctx.ramp(0, inL, w, Ri, ctx.shade(c));
      ctx.advance(inL, Ri);
      // start deck (block down to the base) with boost, then the lip
      ctx.slab(KIND.SOLID, 0, 10, w, { th: Ri + 1.4, color: c });
      ctx.banner(1, w, ['SALTO DE ESQUI', 'VOA LONGE!'], '#e63946', '#ffffff', false);
      ctx.slab(KIND.BOOST, 1.5, 5, Math.min(w, 5), { dy: 0.06, th: 0.3 });
      ctx.ramp(6.5, 10, w, 0.9, snow);
      ctx.advance(10);
      // lip is at +0.9 here (Ri + 0.9 above the base)
      const v = 36, k = 0.9 / 3.5;
      for (const t of [0.35, 0.7]) ctx.addRing(0, v * t, 0.9 + v * k * t - 0.5 * G * t * t + 0.9);
      // stepped landing hill: starts 1.5 m below the lip and drops 0.32 m every 2.4 m (a short hill
      // and a longer outrun when the course is already low, so the piece does not sink further)
      // (low: 5 steps keep the net height change positive: Ri - 0.6 - 5 * 0.32 > 0)
      const stepL = 2.4, stepD = 0.32, steps = low ? 5 : 16;
      ctx.advance(1.2, -0.6);
      const hillTop = Ri - 0.6; // above the base
      for (let i = 0; i < steps; i++) {
        const hAbove = hillTop - i * stepD; // this step's top above the base
        const outrunY = hillTop - steps * stepD; // outrun top above the base
        // the first step reaches back under the deck: no crevice for a rider creeping off the lip
        ctx.slab(KIND.SOLID, i ? 0 : -1.2, stepL, w + 2, { th: hAbove - outrunY + 1.4, color: i % 2 ? hillC : snow });
        // distance boards every ~10 m on both sides
        if (i % 4 === 3) {
          const board = i < 6 ? ctx.colors.JUMP : i < 12 ? ctx.colors.BOOST : ctx.colors.KILL;
          for (const s of [-1, 1]) ctx.decor(s * (w / 2 + 1.6), stepL / 2, 1.2, 0.3, 2.4, 1.6, { color: board });
        }
        ctx.advance(stepL, -stepD);
      }
      // outrun one step below the last hill step; hill + outrun cover the longest flight (scooter
      // 48 m/s + lip jump: ~69 m, ~63 m on the short low hill)
      const run = low ? 52 : 40;
      ctx.slab(KIND.SOLID, 0, run, w + 2, { color: snow });
      ctx.coinLine(10, run - 8, 0, 6);
      ctx.advance(run);
    },
  },

  // ------------------------------------------------------------------ ARQUIPÉLAGO
  // Floating islands (grass top, rock underside): a long jump pad throws you up onto a high island,
  // then you drop island to island (each one lower, small gaps, side shifts) back to the course.
  {
    name: 't_islands',
    minDist: 350,
    weight: (d) => 0.55,
    gen(ctx) {
      const { KIND } = ctx, rng = ctx.rng, d01 = ctx.d01;
      const zone = ctx.zone();
      const grass = ctx.col3(zone.glow > 0.3 ? '#2ec4b6' : '#7bc950');
      const grass2 = ctx.shade(grass);
      const rock = ctx.col3(zone.glow > 0.3 ? '#3a2f5b' : '#7a6a58'), rock2 = ctx.col3(zone.glow > 0.3 ? '#2a2145' : '#5e5146');
      const leaf = ctx.col3('#3fa34d'), trunk = ctx.col3('#8a5a33');
      const w = Math.max(ctx.W(), 7.5) + 1.5;
      // island top + a rocky cone under it (decor), centered on (off, f0..f1)
      const island = (f0, f1, iw, off, dy = 0, c = grass) => {
        const len = f1 - f0, mid = (f0 + f1) / 2;
        ctx.slab(KIND.SOLID, f0, f1, iw, { off, dy, th: 1.6, color: c });
        ctx.decor(off, mid, dy - 2.6, iw * 0.78, 2.2, len * 0.8, { color: rock });
        ctx.decor(off, mid, dy - 4.6, iw * 0.45, 1.8, len * 0.5, { color: rock2 });
      };
      const tree = (lx, lf, dy) => {
        ctx.decor(lx, lf, dy + 1.4, 0.5, 2.8, 0.5, { color: trunk });
        ctx.decor(lx, lf, dy + 3.3, 2.4, 1.6, 2.4, { color: leaf });
      };
      const y0 = ctx.cur.y;
      // A: launch island with a 32 m runway, then a 4 m pad: a turbo hop over a gap before the piece
      // (up to ~47 m with a drop) lands before the pad instead of sailing past it into the void
      const rise = 3.6 + rng() * 0.4;
      island(0, 36, w, 0, 0, grass2);
      ctx.slab(KIND.JUMP, 32, 36, w, { dy: 0.06, th: 0.3 });
      ctx.coinLine(8, 28, 0, 5);
      ctx.advance(32);
      ctx.addRing(0, 10, 7.1);
      // B: high island, front edge PAD_DECK after the pad's near edge (see PAD_DECK notes); turbo
      // pad flights (~50 m) overshoot it and drop onto C
      const offB = (rng() - 0.5) * 3;
      ctx.advance(PAD_DECK, rise);
      const lenB = 32;
      island(0, lenB, w, offB, 0, grass);
      tree(offB + (w / 2 - 1) * (rng() < 0.5 ? -1 : 1), lenB * 0.55, 0);
      ctx.coinLine(10, lenB - 6, offB, 5);
      ctx.advance(lenB);
      // C, D: drop down island to island
      let off = offB;
      let dC = 2.2 + rng() * 1.2, dD = 1.0 + rng() * 0.8 + d01 * 0.6;
      // net height: never lower when the course is already low, never higher when it is high
      if (y0 < -30) { dC = Math.min(dC, rise - 1.1); dD = Math.min(dD, rise - dC); }
      else if (y0 > 30) dD = Math.max(dD, rise - dC + 0.5);
      const drops = [dC, dD];
      for (let i = 0; i < drops.length; i++) {
        const last = i === drops.length - 1;
        const gap = 2.6 + d01 * 1.4 + rng() * 0.8;
        ctx.addCoin(off, gap / 2 + 1, 0.2);
        ctx.advance(gap, -drops[i]);
        off = last ? 0 : clamp(off + (rng() - 0.5) * 4, -2.2, 2.2);
        const len = last ? 20 : 12 + rng() * 2;
        island(0, len, w - (last ? 0 : 1), off, 0, i % 2 ? grass2 : grass);
        if (!last) ctx.coinLine(3, len - 3, off, 3);
        else tree(-(w / 2 - 1), 8, 0);
        ctx.advance(len);
      }
      ctx.slab(KIND.SOLID, 0, 6, Math.max(ctx.W(), 7), { color: grass2 });
      ctx.advance(6);
    },
  },

  // ------------------------------------------------------------------ QUEIJO SUÍÇO
  // A wide checkerboard deck full of holes. A guaranteed path wanders across the columns (when it
  // shifts, both tiles of the new row stay solid); single holes can be rolled over at speed.
  {
    name: 't_cheese',
    minDist: 450,
    weight: (d) => 0.5 + d * 0.15,
    gen(ctx) {
      const { KIND } = ctx, rng = ctx.rng, d01 = ctx.d01;
      const cols = rng() < 0.5 ? 3 : 4;
      const tw = cols === 3 ? 3.4 : 3.0, tl = 3.0;
      const w = cols * tw;
      const rows = 8 + Math.floor(rng() * 3 + d01 * 2);
      const cheese = ctx.col3('#ffd166'), cheese2 = ctx.col3('#f4b942');
      // 26 m entry (+ 2 hole-free rows): a turbo hop over a gap just before the piece comes down
      // <= ~45 m past it (gap strip 14 m), i.e. before the first holes (bot runs fell into them
      // with a 7 m entry)
      ctx.slab(KIND.SOLID, 0, 26, w, { color: cheese2 });
      ctx.banner(8, w, ['QUEIJO SUÍÇO', 'OLHO NOS BURACOS!'], '#ffd166', '#1b1f3b', false);
      ctx.coinLine(14, 24, 0, 3);
      ctx.advance(26);
      const xOf = (k) => (k - (cols - 1) / 2) * tw;
      let sc = Math.floor(rng() * cols);
      const solid = [];
      const path = [];
      for (let r = 0; r < rows; r++) {
        const prev = sc;
        if (r > 1 && rng() < 0.55) sc = clamp(sc + (rng() < 0.5 ? -1 : 1), 0, cols - 1);
        const row = new Array(cols).fill(true);
        if (r >= 2 && r < rows - 1) {
          const nHoles = Math.min(cols - 2, 1 + Math.floor(rng() * (1 + d01 * 1.8)));
          for (let h = 0; h < nHoles; h++) {
            const k = Math.floor(rng() * cols);
            if (k !== sc && k !== prev) row[k] = false;
          }
        }
        solid.push(row);
        path.push(sc);
      }
      // the path tiles go in first: they become the track's reference line (record gate, test bot)
      for (let r = 0; r < rows; r++) {
        const k = path[r];
        ctx.slab(KIND.SOLID, r * tl, (r + 1) * tl, tw, { off: xOf(k), th: 1.2, color: (r + k) % 2 ? cheese : cheese2 });
        if (r % 2 === 1) ctx.addCoin(xOf(k), r * tl + tl / 2);
      }
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k < cols; k++) {
          if (k === path[r] || !solid[r][k]) continue;
          ctx.slab(KIND.SOLID, r * tl, (r + 1) * tl, tw, { off: xOf(k), th: 1.2, color: (r + k) % 2 ? cheese : cheese2 });
        }
      }
      ctx.advance(rows * tl);
      // long exit: a hop over one of the last holes (up to ~35 m at turbo) lands here, not in
      // whatever follows
      ctx.slab(KIND.SOLID, 0, 30, w, { color: cheese2 });
      ctx.coinLine(8, 24, 0, 4);
      ctx.advance(30);
    },
  },
];
