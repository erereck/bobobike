// bobobike piece pack: setpieces. Default export: array of piece definitions (see SPEC.md "v4").
// Named showcase sections: each one is a small "level" (40–130 m) with ONE banner, mixing
// mechanics and scenery. They are rarer than regular pieces and mostly gated by minDist so the
// player keeps discovering new ones deeper into a run.

const RAINBOW = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff', '#af52de'];
const G = 34; // gravity (m/s²), see SPEC physics facts

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// -1 when the track is getting too high, +1 when too low, 0 otherwise (rule 2)
function heightBias(ctx) {
  const y = ctx.cur.y;
  return y > 35 ? -1 : y < -35 ? 1 : 0;
}

// a stack of shrinking blocks beside the road (coin piles, snowmen, idols...)
function stack(ctx, lx, lf, dy, sizes, colors) {
  let h = dy;
  for (let i = 0; i < sizes.length; i++) {
    const s = sizes[i];
    ctx.decor(lx, lf, h + s[1] / 2, s[0], s[1], s[2] ?? s[0], { color: ctx.col3(colors[i % colors.length]) });
    h += s[1];
  }
  return h;
}

export default [
  // ------------------------------------------------------------------ CHUVA DE MOEDAS
  // Easy, wide golden boulevard packed with coins and turbo rings: an optional bounce pad with a
  // coin arc over it, a ring slalom, a little kicker through a ring and a "rain" grid of coins
  // (high ones need a hop). No hazards at all, so it may show up in the friendly start.
  {
    name: 'x_moedas',
    weight: (d) => 0.5 - d * 0.2,
    early: true,
    gen(ctx) {
      const { KIND } = ctx;
      const rng = ctx.rng;
      const w = Math.max(ctx.W() + 2.5, 9.5);
      // long enough that a boosted (or turbo) scooter jumping off the kicker at 48 m still comes
      // down on the golden road (~52 m flight)
      const L = 102;
      const goldA = ctx.col3('#ffd23f'), goldB = ctx.col3('#ffb703');
      ctx.slab(KIND.SOLID, 0, 10, w);
      ctx.banner(5, w, ['CHUVA DE MOEDAS', 'PEGA TUDO!'], '#ffb703', '#1b1f3b', true);
      for (let f = 10, i = 0; f < L; f += 12, i++) {
        ctx.slab(KIND.SOLID, f, Math.min(L, f + 12), w, { color: i % 2 ? goldA : goldB });
      }
      // optional trampoline off to one side (the middle line stays free, so nobody gets thrown up
      // by surprise in the friendly start), coins lead onto it and follow a typical bounce arc
      const side = rng() < 0.5 ? -1 : 1;
      const tx = side * (w / 2 - 2.2);
      ctx.slab(KIND.BOUNCE, 13, 16, 3.6, { off: tx, dy: 0.06, th: 0.3 });
      for (let i = 0; i < 3; i++) ctx.addCoin(tx * (0.4 + i * 0.3), 4 + i * 2.5, 1.15);
      for (let i = 1; i <= 8; i++) {
        const t = i * 0.12;
        ctx.addCoin(tx, 14.5 + 24 * t, 16 * t - 0.5 * G * t * t + 1.0);
      }
      // coin zigzag along the road + ring slalom (hop to grab the rings)
      const amp = w / 2 - 1.6;
      for (let i = 0; i < 10; i++) ctx.addCoin(side * Math.sin(i * 0.8) * amp, 20 + i * 2.6, 1.15);
      for (let i = 0; i < 3; i++) ctx.addRing((i - 1) * 2.2 * side, 29 + i * 6, 2.7);
      // little kicker through a ring
      ctx.ramp(42, 48, 5, 1.1, ctx.col3('#fff3b0'));
      ctx.addRing(0, 54, 3.0);
      // coin rain: low coins on the road, high coins that need a hop
      for (let r = 0; r < 6; r++) {
        for (let k = -1; k <= 1; k++) {
          const high = (r + k + 2) % 2 === 0;
          ctx.addCoin(k * 2.6, 60 + r * 3.4, high ? 3.3 : 1.15);
        }
      }
      ctx.coinLine(84, L - 4, 0, 5);
      // boost in the middle (not at the end: it must not fling riders into the next piece);
      // a boosted hop off the kicker still lands on the golden road
      ctx.slab(KIND.BOOST, 24, 28, Math.min(w, 4.5), { dy: 0.06, th: 0.3 });
      // scenery: piles of giant coins and a treasure chest
      for (const f of [18, 44, 70, 88]) {
        for (const s of [-1, 1]) {
          const n = 3 + Math.floor(rng() * 2);
          const sizes = [];
          for (let i = 0; i < n; i++) sizes.push([2.8 - i * 0.45, 0.5]);
          stack(ctx, s * (w / 2 + 3 + rng() * 2), f + rng() * 4, -0.2, sizes, ['#ffd23f', '#ffb703']);
        }
      }
      const cs = rng() < 0.5 ? -1 : 1;
      ctx.decor(cs * (w / 2 + 4), L - 6, 0.8, 3.2, 1.6, 2.2, { color: ctx.col3('#8b5a2b') });
      ctx.decor(cs * (w / 2 + 4), L - 6, 1.9, 3.4, 0.6, 2.4, { color: ctx.col3('#ffd23f') });
      ctx.advance(L);
    },
  },

  // ------------------------------------------------------------------ ESCADA ARCO-ÍRIS
  // A staircase in rainbow colors (0.45 m steps roll up on their own; later some need a hop or
  // cross a small gap), a striped rainbow plateau under a blocky rainbow gateway, then a
  // rainbow cascade back down onto a long landing and a pot of gold.
  {
    name: 'x_arcoiris',
    weight: () => 0.5,
    minDist: 200,
    gen(ctx) {
      const { KIND } = ctx;
      const rng = ctx.rng, d = ctx.d01;
      const w = Math.max(ctx.W(), 6.4);
      const bias = heightBias(ctx);
      ctx.slab(KIND.SOLID, 0, 10, w);
      ctx.banner(5, w, ['ESCADA ARCO-ÍRIS', 'SOBE, SOBE, SOBE!'], '#7b2ff7', '#ffffff', true);
      ctx.advance(10);
      // ---- the stairs
      const n = 7 + Math.floor(rng() * 2) + (d > 0.35 ? 1 : 0);
      const maxClimb = bias < 0 ? 4 : 8.5;
      let climbed = 0;
      let side = rng() < 0.5 ? -1 : 1;
      // 0.45 m steps roll up by themselves. Later some steps need a hop (~1 m): those are long
      // (room to land), never two in a row, and at most one of them sits behind a small chasm.
      let prevJump = true, usedGap = false;
      for (let i = 0; i < n; i++) {
        let rise = 0.45, gap = 0, len = 4.6 + rng() * 0.6;
        const jumpStep = !prevJump && d > 0.18 && rng() < 0.25 + d * 0.45;
        if (jumpStep) {
          rise = 0.85 + rng() * 0.3 * Math.min(1, d * 1.6);
          len = 7.5 + rng();
          if (d > 0.5 && !usedGap && rng() < 0.5) { gap = 1.0 + rng() * 0.8; rise = Math.min(rise, 0.9); usedGap = true; }
        }
        prevJump = jumpStep;
        if (climbed + rise > maxClimb) rise = climbed + 0.45 > maxClimb ? 0 : 0.45;
        ctx.advance(gap, rise);
        climbed += rise;
        ctx.slab(KIND.SOLID, 0, len, w, { th: 1.4 + climbed, color: ctx.col3(RAINBOW[i % 7]) });
        // a high coin right in front of a tall step (or over its gap) says "hop here"
        if (rise > 0.5 || gap > 0) ctx.addCoin(0, -gap / 2 - 0.4, 1.0);
        ctx.addCoin(side * Math.min(1.6, w / 2 - 1), len / 2, 1.15);
        side = -side;
        ctx.advance(len);
      }
      // ---- rainbow plateau: seven stripes (center first, so the path follows the middle)
      const PL = 12, sw = w / 7;
      for (const k of [3, 2, 4, 1, 5, 0, 6]) {
        ctx.slab(KIND.SOLID, 0, PL, sw + 0.02, { off: (k - 3) * sw, th: 1.4 + climbed, color: ctx.col3(RAINBOW[k]) });
      }
      // blocky rainbow gateway: seven nested frames, red outside, violet inside
      for (let k = 0; k < 7; k++) {
        const hw = w / 2 + 1.2 + (6 - k) * 0.75, top = 5.4 + (6 - k) * 0.75;
        const c = { color: ctx.col3(RAINBOW[k]) };
        ctx.decor(-hw, 7, top / 2, 0.75, top, 0.8, c);
        ctx.decor(hw, 7, top / 2, 0.75, top, 0.8, c);
        ctx.decor(0, 7, top - 0.375, hw * 2 + 0.75, 0.75, 0.8, c);
      }
      ctx.addRing(0, 7, 2.6);
      ctx.coinLine(2, 10, 0, 4);
      ctx.advance(PL);
      // ---- rainbow cascade back down; the last slab catches even turbo flights off the top
      let drop = climbed + (bias < 0 ? 4 : bias > 0 ? -2.5 : 0);
      drop = clamp(drop, 1.5, 11);
      const steps = 3;
      const sd = drop / (steps + 1);
      for (let i = 0; i < steps; i++) {
        ctx.advance(0, -sd);
        ctx.slab(KIND.SOLID, 0, 5, w, { th: 1.4, color: ctx.col3(RAINBOW[6 - ((i * 2) % 7)]) });
        ctx.advance(5);
      }
      ctx.advance(0, -sd);
      // a turbo rider (48 m/s) rolling off the plateau flies over the whole cascade: the landing
      // reaches 8 m past where that flight comes down
      // and a turbo hop for the plateau ring (from ~4 m in, 48 m/s, vy 12.2) comes down 55–60 m out
      const hop = (48 * (12.2 + Math.sqrt(12.2 * 12.2 + 2 * G * drop))) / G;
      const land = Math.max(24, Math.ceil(48 * Math.sqrt((2 * drop) / G)) - steps * 5 + 8, Math.ceil(hop - (PL - 4) - steps * 5 + 2));
      ctx.slab(KIND.SOLID, 0, land, w + 1.5);
      ctx.coinLine(6, 20, 0, 5);
      // pot of gold at the end of the rainbow
      const ps = rng() < 0.5 ? -1 : 1;
      ctx.decor(ps * (w / 2 + 3.5), 18, 0.9, 2.6, 1.8, 2.6, { color: ctx.col3('#1d1d26') });
      ctx.decor(ps * (w / 2 + 3.5), 18, 2.0, 2.2, 0.5, 2.2, { color: ctx.col3('#ffd23f') });
      ctx.advance(land);
    },
  },

  // ------------------------------------------------------------------ CASTELO
  // A lava moat crossed by a wooden drawbridge that slides in and out of the castle gate (when it
  // is pulled in, hop the gap), a walled courtyard with split portcullises (the two halves go up
  // and down in turns, so one lane is always open) and, later on, a patrolling guard block.
  {
    name: 'x_castelo',
    weight: () => 0.45,
    minDist: 350,
    gen(ctx) {
      const { KIND } = ctx;
      const rng = ctx.rng, d = ctx.d01;
      const w = Math.max(ctx.W() + 1, 7);
      const stone = ctx.col3('#a3a7b8'), stoneD = ctx.col3('#6c7086'), wood = ctx.col3('#9c6b3c');
      const flagCols = ['#e63946', '#3a86ff', '#ffd23f', '#2bd96b'];
      const tower = (lx, lf, top, size) => {
        ctx.decor(lx, lf, (top - 7) / 2, size, top + 7, size, { color: stone });
        for (const [mx, mz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          ctx.decor(lx + mx * (size / 2 - 0.45), lf + mz * (size / 2 - 0.45), top + 0.45, 0.9, 0.9, 0.9, { color: stoneD });
        }
        ctx.decor(lx, lf, top + 1.6, 0.2, 3.2, 0.2, { color: ctx.col3('#f4f4f8') });
        ctx.decor(lx + 0.75, lf, top + 2.6, 1.3, 0.85, 0.12, { color: ctx.col3(flagCols[Math.floor(rng() * 4)]) });
      };
      // ---- approach
      ctx.slab(KIND.SOLID, 0, 12, w);
      ctx.banner(4, w, ['O CASTELO', 'NÃO CAI NA LAVA!'], '#3d405b', '#ffd23f', false);
      ctx.coinLine(6, 11, 0, 3);
      // ---- lava moat + drawbridge that slides into the gate (near gap opens up to 2A - 0.5 m)
      const m0 = 12, M = 13, m1 = m0 + M;
      ctx.slab(KIND.KILL, m0 - 0.5, m1 + 0.5, w + 12, { dy: -5, th: 1 });
      const A = 1.2 + d * 1.6, BL = M + 1;
      const bridge = ctx.slab(KIND.SOLID, m0 - 0.5 + A, m0 - 0.5 + A + BL, w - 0.8, { dy: -0.04, th: 0.8, pool: 'dyn', color: wood });
      ctx.move(bridge, { type: 'slide', axis: 'z', amp: A, speed: 1.0 + d * 0.6, phase: rng() * 6.28 });
      ctx.addCoin(0, m0 + 6, 2.4);
      // ---- gate: towers, facade and a lintel high above the road
      tower(-(w / 2 + 2.2), m1 + 1.8, 11, 3.6);
      tower(w / 2 + 2.2, m1 + 1.8, 11, 3.6);
      for (const s of [-1, 1]) ctx.decor(s * (w / 2 + 9.5), m1 + 1.2, 0.5, 11, 13, 1.6, { color: stoneD });
      ctx.decor(0, m1 + 1.2, 9.8, w + 0.8, 1.4, 1.6, { color: stoneD });
      // ---- courtyard with low battlements (they keep you on the floor)
      const C = 46, c0 = m1, c1 = m1 + C;
      // two lanes in two stone tones (they hint at the split portcullises ahead)
      const l1 = rng() < 0.5 ? -1 : 1;
      ctx.slab(KIND.SOLID, c0, c1, w / 2 + 0.01, { off: l1 * w / 4, color: stone });
      ctx.slab(KIND.SOLID, c0, c1, w / 2 + 0.01, { off: -l1 * w / 4, color: ctx.col3('#c9ccd8') });
      for (const s of [-1, 1]) {
        // top 4 m: well over any jump apex (2.8 m) plus the 0.5 m step-up, so nobody hops out
        ctx.box(KIND.SOLID, s * (w / 2 + 0.4), c0 + C / 2 + 2, 1.3, 0.8, 5.4, C - 4, { color: stoneD });
        for (let f = c0 + 4; f < c1 - 2; f += 4.5) ctx.decor(s * (w / 2 + 0.4), f, 4.4, 0.8, 0.8, 1.2, { color: stoneD });
      }
      // split portcullises: each half rises and falls opposite to the other
      const nGates = d > 0.3 ? 2 : 1;
      const guarded = d > 0.45; // the guard patrols between the two gates, which then sit further apart
      for (let g = 0; g < nGates; g++) {
        const f = c0 + (guarded ? 12 + g * 19 : 13 + g * 17);
        // iron gates (solid: a closed lane is a bonk, never a death). The bottom edge travels
        // -0.05 .. 5.15 m, a lane is open ~60% of the time and the two lanes are in opposite
        // phase, so one of them is always open: pick it to keep your speed.
        const ph = rng() * 6.28, sp = 0.8 + d * 0.5;
        // solid center post splits the two lanes (riding the middle is a bonk, not a death)
        ctx.box(KIND.SOLID, 0, f, 3.4, 0.8, 6.8, 0.9, { color: stone });
        ctx.decor(0, f, 8.6, w + 1.6, 0.8, 0.9, { color: stoneD });
        // slim wedge in front of the post deflects a rider into a lane instead of a head-on bonk
        for (const s of [-1, 1]) {
          ctx.box(KIND.SOLID, s * 0.2, f - 2.45, 1.6, 0.3, 3.2, 4.02, { yaw: -s * 0.0997, color: stoneD });
        }
        for (const s of [-1, 1]) {
          const half = ctx.box(KIND.SOLID, s * (w / 4 + 0.2), f, 4.05, w / 2 - 0.5, 3, 0.6, { pool: 'dyn', color: ctx.col3('#3f4257') });
          ctx.move(half, { type: 'slide', axis: 'y', amp: 2.6, speed: sp, phase: ph + (s > 0 ? Math.PI : 0) });
          ctx.decor(s * (w / 2 + 0.4), f, 4.6, 0.9, 6, 0.9, { color: stone });
          ctx.addCoin(s * (w / 4 + 0.2), f - 3, 1.15);
        }
      }
      // a guard block patrolling side to side (later in the run)
      // (9.5 m after a gate and slow, max ~3.5 m/s sideways, so it can be read and dodged)
      if (guarded) {
        const guard = ctx.box(KIND.KILL, 0, c0 + 21.5, 1.1, 1.2, 2.2, 1.2, { pool: 'dyn' });
        ctx.move(guard, { type: 'slide', axis: 'x', amp: w / 2 - 1.1, speed: 0.75 + d * 0.35, phase: rng() * 6.28 });
      }
      ctx.coinLine(c1 - 12, c1 - 3, 0, 4);
      // ---- back gate and the way out
      tower(-(w / 2 + 2), c1 - 1.6, 8, 3.2);
      tower(w / 2 + 2, c1 - 1.6, 8, 3.2);
      ctx.slab(KIND.SOLID, c1, c1 + 10, w);
      ctx.advance(c1 + 10);
    },
  },

  // ------------------------------------------------------------------ FÁBRICA
  // A toy factory: a conveyor belt carries you under crushers that cover one side at a time
  // (the other side is always safe), a cross belt with sliding crates (solid: just a bonk), a
  // low laser fence to hop over and a turbo belt with laser walls sweeping side to side.
  {
    name: 'x_fabrica',
    weight: () => 0.45,
    minDist: 500,
    gen(ctx) {
      const { KIND } = ctx;
      const rng = ctx.rng, d = ctx.d01;
      const w = Math.max(ctx.W() + 1, 7);
      const metal = ctx.col3('#8d99ae'), dark = ctx.col3('#2b2d42'), yellow = ctx.col3('#ffc300');
      const brick = ctx.col3('#b5523b'), white = ctx.col3('#f4f4f8');
      // ---- entry + chimneys puffing blocky smoke
      ctx.slab(KIND.SOLID, 0, 10, w, { color: metal });
      ctx.banner(5, w, ['A FÁBRICA', 'CUIDADO COM A PRENSA!'], '#ffc300', '#1b1f3b', false);
      for (const s of [-1, 1]) {
        const lx = s * (w / 2 + 6 + rng() * 4), lf = 6 + rng() * 30, h = 14 + rng() * 6;
        ctx.decor(lx, lf, h / 2 - 6, 3, h, 3, { color: brick });
        ctx.decor(lx, lf, h - 6.5, 3.3, 0.8, 3.3, { color: white });
        for (let i = 0; i < 3; i++) ctx.decor(lx + (rng() - 0.5), lf - i * 0.6, h - 4.5 + i * 1.8, 1.4 + i * 0.5, 1.4 + i * 0.5, 1.4 + i * 0.5, { color: white });
      }
      // ---- belt 1 with crushers, alternating sides (the other lane is always free)
      const b0 = 10, b1 = 42;
      const belt = ctx.slab(KIND.CONVEYOR, b0, b1, w);
      ctx.conveyor(belt, 5 + d * 2);
      let side = rng() < 0.5 ? -1 : 1;
      // under half the width: a ~1.4 m strip down the middle of the belt is never crushed
      // (~0.9 m for the rider's center once the kill hitbox is counted)
      const cw = Math.min(w * (0.42 + d * 0.05), w / 2 - 0.7);
      for (let i = 0; i < 3; i++) {
        const f = b0 + 6 + i * 9.5, lx = side * (w - cw) / 2;
        const sp = 1.6 + d * 1.0, ph = rng() * 6.28;
        ctx.decor(lx, f, 0.03, cw, 0.06, 2.6, { color: yellow }); // crush zone marking
        // bottom edge travels 0.05 .. 5.0 m
        const press = ctx.box(KIND.KILL, lx, f, 3.625, cw, 2.2, 2.4, { pool: 'dyn' });
        ctx.move(press, { type: 'slide', axis: 'y', amp: 2.475, speed: sp, phase: ph });
        const rod = ctx.decor(lx, f, 3.625 + 1.1 + 1.6, 0.6, 3.2, 0.6, { pool: 'dyn', color: metal });
        ctx.move(rod, { type: 'slide', axis: 'y', amp: 2.475, speed: sp, phase: ph });
        // gantry
        ctx.decor(-(w / 2 + 0.7), f, 5.2, 0.7, 10.4, 0.7, { color: yellow });
        ctx.decor(w / 2 + 0.7, f, 5.2, 0.7, 10.4, 0.7, { color: yellow });
        ctx.decor(0, f, 10.4, w + 2.1, 0.8, 1.0, { color: dark });
        ctx.addCoin(-side * (w / 2 - (w - cw) / 4 - 0.2), f, 1.15);
        side = -side;
      }
      // ---- cross belt with sliding crates (solid crates, a bonk at worst)
      ctx.slab(KIND.SOLID, b1, b1 + 4, w, { color: metal });
      const x0 = b1 + 4, xl = 6;
      const push = rng() < 0.5 ? 1 : -1;
      const cross = ctx.slab(KIND.CONVEYOR, x0 + xl / 2 - w / 2, x0 + xl / 2 + w / 2, xl, { yaw: push * Math.PI / 2, noDist: true });
      ctx.conveyor(cross, 2.5 + d * 1.5);
      // a plain plate under the cross belt keeps the distance counting and the path through it
      ctx.slab(KIND.SOLID, x0, x0 + xl, w, { dy: -0.06, color: dark });
      // yellow rail on the side the belt pushes toward: a rider slowed by a crate is never
      // carried off the edge (push +1 moves riders to -lx)
      ctx.box(KIND.SOLID, -push * (w / 2 + 0.3), x0 + xl / 2, 0.3, 0.6, 1.4, xl + 1, { color: yellow });
      const ph0 = rng() * 6.28;
      for (let k = 0; k < 2; k++) {
        const crate = ctx.box(KIND.SOLID, 0, x0 + 1.5 + k * 3, 0.8, 1.6, 1.6, 1.6, { pool: 'dyn', color: ctx.col3(k ? '#c98b45' : '#e0a458') });
        ctx.move(crate, { type: 'slide', axis: 'x', amp: w / 2 - 1.5, speed: 1.1 + d * 0.5, phase: ph0 + k * Math.PI });
      }
      // ---- laser fence: low beam across the road, hop it (coin above rewards the jump)
      const lf0 = x0 + xl;
      ctx.slab(KIND.SOLID, lf0, lf0 + 8, w, { color: metal });
      const blink = d > 0.35;
      const beam = ctx.box(KIND.KILL, 0, lf0 + 4, 0.6, w, 0.3, 0.3, { laser: true, pool: blink ? 'dyn' : 'static' });
      if (blink) ctx.move(beam, { type: 'blink', on: 1.8, off: 1.0, phase: rng() * 3 });
      for (const s of [-1, 1]) ctx.decor(s * (w / 2 + 0.4), lf0 + 4, 0.7, 0.6, 1.4, 0.6, { color: dark });
      ctx.addCoin(0, lf0 + 4, 2.4);
      // ---- turbo belt, then laser walls sweeping side to side over a plain plate
      // a fast hop over the laser fence comes down ~20–30 m later: the sweepers start beyond that
      const t0 = lf0 + 8, tm = t0 + 12, t1 = tm + 26;
      const tb = ctx.slab(KIND.CONVEYOR, t0, tm, w);
      ctx.conveyor(tb, 6 + d * 2);
      ctx.coinLine(t0 + 2, tm - 2, 0, 4);
      ctx.slab(KIND.SOLID, tm, t1, w, { color: metal });
      // two sweepers move in sync, so one line through the free side clears both; early on the
      // sweeper is a low beam you can also hop over
      const lw = w * 0.36, nSweep = d > 0.4 ? 2 : 1, sph = rng() * 6.28;
      const sh = d < 0.3 ? 0.7 : 3;
      for (let k = 0; k < nSweep; k++) {
        const f = tm + 13 + k * 8; // 13 m of plain floor after the belt to pick the free side
        const sw = ctx.box(KIND.KILL, 0, f, sh / 2, lw, sh, 0.3, { laser: true, pool: 'dyn' });
        ctx.move(sw, { type: 'slide', axis: 'x', amp: (w - lw) / 2 - 0.1, speed: 0.8 + d * 0.5, phase: sph });
        ctx.decor(0, f, 3.6, w + 1.4, 0.5, 0.6, { color: dark });
        for (const s of [-1, 1]) ctx.decor(s * (w / 2 + 0.5), f, 1.9, 0.5, 3.8, 0.6, { color: dark });
      }
      // ---- exit: finished toys stacked beside the road
      ctx.slab(KIND.SOLID, t1, t1 + 10, w, { color: metal });
      const gs = rng() < 0.5 ? -1 : 1;
      ctx.decor(gs * (w / 2 + 3), t1 + 5, 1.2, 2.4, 2.4, 2.4, { color: ctx.col3('#ff4fa3') });
      ctx.decor(gs * (w / 2 + 3), t1 + 5, 1.2, 2.5, 0.5, 2.5, { color: yellow });
      ctx.decor(gs * (w / 2 + 3), t1 + 5, 1.2, 0.5, 2.5, 2.5, { color: yellow });
      ctx.advance(t1 + 10);
    },
  },

  // ------------------------------------------------------------------ LABIRINTO DE LASER
  // A dark walled arena crossed by rows of laser walls: doors (find the hole, they zig-zag),
  // low beams (hop them) and, later, twin walls that blink in turns (one side is always off;
  // a wall flickers before it switches on). Tall arena walls with glowing trim keep you inside.
  {
    name: 'x_laser',
    weight: () => 0.45,
    minDist: 650,
    gen(ctx) {
      const { KIND } = ctx;
      const rng = ctx.rng, d = ctx.d01;
      const w = Math.max(ctx.W() + 3.5, 10);
      const floor = ctx.col3('#1c1a3a'), wall = ctx.col3('#2a2650');
      ctx.slab(KIND.SOLID, 0, 10, Math.max(ctx.W(), 7));
      ctx.banner(5, w, ['LABIRINTO LASER', 'NÃO ENCOSTA!'], '#14112b', '#ff2a6d', true);
      const rows = Math.min(7, 4 + Math.floor(rng() * 2 + d * 2.5)); // <= 7 keeps the piece under 130 m
      const sp = 13 - d * 1.5;
      const a0 = 10;
      const holeW = Math.max(3.6, 4.6 - d);
      const lim = w / 2 - holeW / 2 - 0.4;
      // plan the rows first: types and door holes (each hole 1.4–2.8 m sideways from the last)
      const plan = [];
      let ho = (rng() - 0.5) * 0.8, lastType = '', first = true, fRow = a0 + 10 - sp;
      for (let i = 0; i < rows; i++) {
        const r = rng();
        let type = 'door';
        // never a low beam last: a fast hop over it would sail past the exit into the next piece
        if (lastType !== 'low' && r < 0.3 && i < rows - 1) type = 'low';
        else if (d > 0.3 && i > 0 && lastType !== 'twin' && r > 0.72) type = 'twin';
        const prevType = lastType;
        lastType = type;
        if (type === 'door') {
          if (first) ho = clamp(ho + (rng() - 0.5) * 2.4, -lim, lim); // the first hole stays near the middle
          // after a twin you come out of either half: the next hole sits near the middle
          else if (prevType === 'twin') ho = clamp((rng() - 0.5) * 1.2, -lim, lim);
          else {
            let nh = clamp(ho + (rng() < 0.5 ? -1 : 1) * (1.4 + rng() * 1.4), -lim, lim);
            if (Math.abs(nh - ho) < 1.3) nh = clamp(ho > 0 ? ho - 2.1 : ho + 2.1, -lim, lim);
            ho = nh;
          }
          first = false;
        }
        // a twin row gets 3 m more run-up: you may have to cross from a door hole at the edge
        // to the half that is off
        fRow += sp + (type === 'twin' ? 3 : 0);
        plan.push({ f: fRow, type, ho });
      }
      const a1 = fRow + sp;
      // a low beam takes the lane of the NEXT door: you line up on the ground, then hop straight
      // through (a normal hop over it is still in the air when it crosses that door)
      for (let i = 0; i < plan.length - 1; i++) {
        if (plan[i].type === 'low' && plan[i + 1].type === 'door') plan[i].ho = plan[i + 1].ho;
      }
      // arena walls, top 4 m: over any jump apex plus the 0.5 m step-up, so nobody lands on them
      for (const s of [-1, 1]) {
        ctx.box(KIND.SOLID, s * (w / 2 + 0.4), (a0 + a1) / 2, 1.3, 0.8, 5.4, a1 - a0, { color: wall });
        ctx.decor(s * (w / 2 + 0.4), (a0 + a1) / 2, 4.1, 0.3, 0.2, a1 - a0, { laser: true });
      }
      // floor: a lighter trail leads to each next hole, dark tiles fill the rest
      const trail = ctx.col3('#4a3f8f');
      const seg = (s0, s1, lane) => {
        ctx.slab(KIND.SOLID, s0, s1, holeW, { off: lane, color: trail });
        const lw = lane - holeW / 2 + w / 2, rw = w / 2 - lane - holeW / 2;
        if (lw > 0.05) ctx.slab(KIND.SOLID, s0, s1, lw, { off: -w / 2 + lw / 2, color: floor });
        if (rw > 0.05) ctx.slab(KIND.SOLID, s0, s1, rw, { off: w / 2 - rw / 2, color: floor });
      };
      let s0 = a0;
      for (const row of plan) { seg(s0, row.f + 0.5, row.ho); s0 = row.f + 0.5; }
      seg(s0, a1, plan[plan.length - 1].ho);
      const tall = (lx, f, width) => ctx.box(KIND.KILL, lx, f, 1.6, width, 3.2, 0.25, { laser: true });
      for (const { f, type, ho } of plan) {
        if (type === 'low') {
          // hop over it; the coin above marks the jump
          ctx.box(KIND.KILL, 0, f, 0.6, w, 0.3, 0.25, { laser: true });
          ctx.addCoin(ho, f, 2.4);
        } else if (type === 'twin') {
          // each half is on 35% of the cycle, half a cycle apart: one side is always off and
          // both are off 30% of the time (a wall flickers 0.45 s before it switches on)
          const per = 3.2 - d * 0.4, on = per * 0.35, ph = rng() * per;
          for (const s of [-1, 1]) {
            const beam = ctx.box(KIND.KILL, s * w / 4, f, 1.6, w / 2, 3.2, 0.25, { laser: true, pool: 'dyn' });
            ctx.move(beam, { type: 'blink', on, off: per - on, phase: ph + (s > 0 ? per / 2 : 0) });
          }
          ctx.decor(0, f, 3.6, 0.5, 0.8, 0.5, { color: wall });
        } else {
          const lw = ho - holeW / 2 + w / 2, rw = w / 2 - ho - holeW / 2;
          if (lw > 0.05) tall(-w / 2 + lw / 2, f, lw);
          if (rw > 0.05) tall(w / 2 - rw / 2, f, rw);
          ctx.addCoin(ho, f - 2.5, 1.15);
          ctx.addCoin(ho, f + 0.1, 1.15);
        }
      }
      // glowing pylons outside the arena
      for (let i = 0; i < 4; i++) {
        const s = i % 2 ? 1 : -1, f = a0 + (i + 0.5) * (a1 - a0) / 4;
        ctx.decor(s * (w / 2 + 4 + rng() * 3), f, 2, 0.5, 12, 0.5, { laser: true });
      }
      // exit as wide as the arena: the last hole can be near a wall, and riding straight out of it
      // must not drop you off the side; coins pull you back to the middle
      ctx.slab(KIND.SOLID, a1, a1 + 10, w);
      ctx.coinLine(a1 + 2, a1 + 9, 0, 3);
      ctx.advance(a1 + 10);
    },
  },

  // ------------------------------------------------------------------ MONTANHA-RUSSA
  // A roller coaster on stilts: a blocky lift hill with a crest and a drop (airtime!), then
  // either a set of whoops (small bumps that pop you) or a railed S-curve, a flat run-in and a
  // bigger second hill. Every landing is long enough for a turbo flight; rings sit on the arcs.
  {
    name: 'x_montanha',
    weight: () => 0.5,
    minDist: 300,
    gen(ctx) {
      const { KIND } = ctx;
      const rng = ctx.rng, d = ctx.d01;
      const w = Math.max(ctx.W(), 6.5);
      const bias = heightBias(ctx);
      const red = ctx.col3('#e63946'), white = ctx.col3('#f4f4f8'), steel = ctx.col3('#8d99ae');
      const stilts = (f0, f1, top) => { // support columns under the track, every 6 m
        for (let f = f0 + 1; f < f1; f += 6) {
          for (const s of [-1, 1]) ctx.decor(s * (w / 2 - 0.6), f, top - 1.4 - 5, 0.5, 10, 0.5, { color: steel });
        }
      };
      // a hill: blocky lift (0.3 m steps roll up on their own and, unlike a wedge, are safe to
      // jump onto), a short crest, then the track continues `drop` lower (airtime)
      const hill = (rise, drop, len, last) => {
        const c = rng() < 0.5 ? red : white;
        const n = Math.ceil(rise / 0.3), sl = len / n, sr = rise / n;
        for (let i = 0; i < n; i++) {
          ctx.advance(i ? sl : 0, sr);
          ctx.slab(KIND.SOLID, 0, sl, w, { th: 1.4 + sr * (i + 1), color: i % 2 ? c : ctx.shade(c) });
        }
        ctx.advance(sl);
        stilts(-len, 0, -rise / 2);
        // the crest is a full-height block: a rider who bonks on the lift can never slip into a
        // void under the hill
        ctx.slab(KIND.SOLID, 0, 3, w, { color: c, th: 1.4 + rise });
        ctx.decor(-(w / 2 + 0.3), 1.5, 0.6, 0.3, 1.2, 3, { color: red });
        ctx.decor(w / 2 + 0.3, 1.5, 0.6, 0.3, 1.2, 3, { color: red });
        ctx.advance(3, -drop);
        // landing. Hill 1: anything flying further comes down on the middle section, which is at
        // the same level. Hill 2 ends the piece, so its landing catches a turbo flight rolling off
        // the crest (48 m/s for sqrt(2*drop/G) s) and a hop off the crest at top speed (35 m/s)
        const hop = (35 * (12.2 + Math.sqrt(12.2 * 12.2 + 2 * G * drop))) / G;
        const land = last ? Math.max(22, 48 * Math.sqrt((2 * drop) / G) + 2, hop + 2) : 21;
        ctx.slab(KIND.SOLID, 0, land, w + 1, { color: white });
        stilts(0, land, 0);
        ctx.addRing(0, 7, drop - 0.2);
        return land;
      };
      // ---- station
      // (lengths trimmed so the longest variant stays within the 130 m piece limit)
      ctx.slab(KIND.SOLID, 0, 9, w, { color: red });
      ctx.banner(4, w, ['MONTANHA-RUSSA', 'SEGURA O CHAPÉU!'], '#e63946', '#ffffff', false);
      ctx.coinLine(3, 8, 0, 3);
      ctx.advance(9);
      // ---- hill 1
      const r1 = 3 + rng() * 0.6;
      const d1 = clamp(r1 + (bias < 0 ? 2.5 : bias > 0 ? -1.5 : 0), 1.5, 5.5);
      const l1 = hill(r1, d1, 12, false);
      ctx.coinLine(l1 * 0.5, l1 - 2, 0, 4);
      ctx.advance(l1);
      // ---- middle: whoops or a railed S-curve
      if (rng() < 0.5) {
        for (let i = 0; i < 2; i++) {
          const c = i % 2 ? red : white;
          ctx.ramp(0, 4.5, w, 0.6 + d * 0.2, c);
          ctx.slab(KIND.SOLID, 4.5, 10, w, { color: ctx.shade(c) });
          ctx.addCoin(0, 7, 2.2);
          ctx.advance(10);
        }
      } else {
        const segs = 3;
        let dir = rng() < 0.5 ? -1 : 1;
        if (ctx.cur.yaw > 0.4) dir = -1; else if (ctx.cur.yaw < -0.4) dir = 1;
        const step = 0.1 * dir;
        for (let half = 0; half < 2; half++) {
          for (let i = 0; i < segs; i++) {
            const L = 3.4, sd = half === 0 ? dir : -dir;
            ctx.slab(KIND.SOLID, -0.15, L + w * 0.1 * 0.6, w, { color: i % 2 ? red : white });
            // rail on the outside of the turn (turning left = yaw grows = outside is +lx)
            ctx.slab(KIND.SOLID, 0, L + 0.3, 0.6, { off: sd * (w / 2 + 0.3), dy: 0.7, th: 2.1, color: i % 2 ? steel : red, noDist: true });
            if (i === 1) ctx.addCoin(-sd * 1.2, L / 2, 1.15);
            ctx.advance(L);
            ctx.turn(half === 0 ? step : -step);
          }
        }
      }
      // flat run-in, so nobody is still airborne (from a whoop pop) when the next lift starts
      ctx.slab(KIND.SOLID, 0, 10, w, { color: white });
      ctx.addRing(0, 5, 2.6);
      ctx.advance(10);
      // ---- hill 2 (bigger)
      const r2 = 3.8 + rng() * 1 + d * 0.8;
      const d2 = clamp(r2 + (bias < 0 ? 2.5 : bias > 0 ? -1.5 : 0), 2, 6.2);
      const l2 = hill(r2, d2, 12, true);
      ctx.coinLine(l2 * 0.55, l2 - 2, 0, 4);
      ctx.advance(l2);
    },
  },

  // ------------------------------------------------------------------ PISTA DE GELO
  // An ice rink with tall boards (you slide, but you can't fall off): a snowman slalom (solid,
  // a bonk at worst), a boarded ice curve, ice floes over the void (moving later on) and a
  // zone of hockey pucks sliding across (low red blocks: hop them or dodge).
  {
    name: 'x_gelo',
    weight: () => 0.45,
    minDist: 400,
    gen(ctx) {
      const { KIND } = ctx;
      const rng = ctx.rng, d = ctx.d01;
      const w = Math.max(ctx.W() + 2, 8);
      const snow = ctx.col3('#f4f9ff'), board = ctx.col3('#ffffff'), glass = ctx.col3('#cfe9ff');
      const blue = ctx.col3('#3a86ff'), orange = ctx.col3('#ff8c1a'), black = ctx.col3('#1d1d26');
      // boards along a straight stretch: one solid wall per side, white board + frosted glass.
      // Top 4 m: a hop while sliding into the boards (kick apex 2.8 m + 0.5 m step-up) never
      // lands on top of them
      const boards = (f0, f1) => {
        const L = f1 - f0, fm = (f0 + f1) / 2;
        for (const s of [-1, 1]) {
          ctx.box(KIND.SOLID, s * (w / 2 + 0.3), fm, 1.3, 0.6, 5.4, L, { color: board });
          ctx.decor(s * (w / 2 + 0.3), fm, 3.1, 0.3, 1.8, L, { color: glass });
          ctx.decor(s * (w / 2 + 0.3), fm, 1.15, 0.7, 0.2, L, { color: blue });
        }
      };
      const snowman = (lx, lf) => {
        ctx.box(KIND.SOLID, lx, lf, 1.75, 1.6, 3.5, 1.6, { color: snow });
        ctx.decor(lx, lf, 2.1, 1.75, 0.15, 1.75, { color: ctx.col3('#e63946') }); // scarf
        ctx.decor(lx, lf - 0.95, 2.95, 0.22, 0.22, 0.5, { color: orange }); // nose
        ctx.decor(lx, lf, 3.85, 1.1, 0.7, 1.1, { color: black }); // hat
      };
      // Order matters: every part where people jump (floes, pucks) is followed by a long
      // runway, so even a top-speed hop lands inside this piece.
      // ---- entry
      ctx.slab(KIND.SOLID, 0, 10, w, { color: snow });
      ctx.banner(5, w, ['PISTA DE GELO', 'ESCORREGA, MAS NÃO CAI!'], '#bde7ff', '#1b1f3b', false);
      ctx.advance(10);
      // ---- ice floes over the void (they drift sideways later in the run)
      // short gaps on purpose: even a rider who jumps at top speed and comes down inside a gap
      // reaches the next floe less than a step (0.5 m) below its top, so it never becomes a wall
      const nF = 3, fl = 6, moving = d > 0.25;
      for (let i = 0; i < nF; i++) {
        const gap = 1.0 + rng() * 0.3 + d * 0.3;
        ctx.advance(gap);
        const fw = Math.max(5.5, w - 1.5);
        const floe = ctx.slab(KIND.ICE, 0, fl, fw, { th: 1.2, pool: moving ? 'dyn' : 'static', color: i % 2 ? glass : ctx.colors.ICE });
        if (moving) ctx.move(floe, { type: 'slide', axis: 'x', amp: 1.2 + d * 0.8, speed: 0.8 + rng() * 0.5, phase: rng() * 6.28 });
        ctx.addCoin(0, fl / 2, 1.15);
        ctx.advance(fl);
      }
      ctx.advance(1.0 + d * 0.3);
      // ---- boarded straight (penguins watching), then the boarded ice curve
      ctx.slab(KIND.ICE, 0, 12, w);
      boards(0, 12);
      for (let i = 0; i < 3; i++) {
        const s = i % 2 ? 1 : -1, f = 2 + i * 4 + rng() * 2, lx = s * (w / 2 + 2.5 + rng() * 3);
        ctx.decor(lx, f, 0.7, 0.9, 1.4, 0.7, { color: black });
        ctx.decor(lx, f - 0.36, 0.6, 0.6, 1.0, 0.05, { color: board });
        ctx.decor(lx, f - 0.4, 1.2, 0.25, 0.12, 0.3, { color: orange });
      }
      ctx.advance(12);
      let dir = rng() < 0.5 ? -1 : 1;
      if (ctx.cur.yaw > 0.45) dir = -1; else if (ctx.cur.yaw < -0.45) dir = 1;
      const segs = 6, step = 0.09 * dir;
      for (let i = 0; i < segs; i++) {
        const L = 3.4;
        ctx.slab(KIND.ICE, -0.15, L + w * 0.06, w);
        for (const s of [-1, 1]) {
          ctx.slab(KIND.SOLID, -0.1, L + 0.4, 0.6, { off: s * (w / 2 + 0.3), dy: 4.0, th: 5.4, color: i % 2 ? board : glass, noDist: true });
        }
        if (i === 2) ctx.addCoin(-dir * (w / 2 - 1.5), L / 2, 1.15);
        ctx.advance(L);
        ctx.turn(step);
      }
      // ---- rink: hockey pucks slide across first (low red blocks: hop or dodge), then a
      // snowman slalom (solid, a bonk at worst) where any puck hop comes down
      ctx.slab(KIND.ICE, 0, 8, w);
      boards(0, 8);
      ctx.advance(8);
      const R = 38;
      ctx.slab(KIND.ICE, 0, R, w);
      boards(0, R);
      const nP = 2 + (d > 0.6 ? 1 : 0);
      for (let i = 0; i < nP; i++) {
        const f = 3 + i * 4.5;
        const puck = ctx.box(KIND.KILL, 0, f, 0.3, 1.2, 0.5, 1.2, { pool: 'dyn' });
        ctx.move(puck, { type: 'slide', axis: 'x', amp: w / 2 - 1.0, speed: 1.0 + d * 0.6 + rng() * 0.3, phase: rng() * 6.28 });
        ctx.addCoin(0, f, 2.3);
      }
      // snowmen early enough that a top-speed hop over one still lands in this piece
      let side = rng() < 0.5 ? -1 : 1;
      for (let i = 0; i < 2; i++) {
        const f = 16.5 + i * 7;
        snowman(side * (w / 2 - 1.8 - rng() * 0.6), f);
        ctx.addCoin(-side * 1.4, f, 1.15);
        side = -side;
      }
      // hockey goal beside the exit
      const gs = rng() < 0.5 ? -1 : 1;
      ctx.decor(gs * (w / 2 - 1.6), R - 1.2, 1.3, 2.4, 0.15, 0.15, { color: ctx.col3('#e63946') });
      ctx.decor(gs * (w / 2 - 2.8), R - 1.6, 0.65, 0.15, 1.3, 1.0, { color: ctx.col3('#e63946') });
      ctx.decor(gs * (w / 2 - 0.4), R - 1.6, 0.65, 0.15, 1.3, 1.0, { color: ctx.col3('#e63946') });
      ctx.advance(R);
      // ---- exit
      ctx.slab(KIND.SOLID, 0, 10, w, { color: snow });
      ctx.advance(10);
    },
  },

  // ------------------------------------------------------------------ TEMPLO
  // A lost temple: steps up into a colonnade with torches, a hall of swinging pendulum blades
  // (they sweep side to side; wait for the gap or zip through when the blade is at the far
  // end), stepping stones over a chasm (short gaps) and a golden idol by the exit.
  {
    name: 'x_templo',
    weight: () => 0.45,
    minDist: 550,
    gen(ctx) {
      const { KIND } = ctx;
      const rng = ctx.rng, d = ctx.d01;
      const w = Math.max(ctx.W() + 0.5, 7);
      const sand = ctx.col3('#e9c46a'), stone = ctx.col3('#c2a878'), dark = ctx.col3('#7f5539');
      const gold = ctx.col3('#ffd23f'), fire = ctx.col3('#ff7b00');
      const column = (lx, lf, h) => {
        ctx.decor(lx, lf, h / 2 - 2, 1.2, h + 4, 1.2, { color: stone });
        ctx.decor(lx, lf, h + 0.25, 1.7, 0.5, 1.7, { color: sand });
      };
      // ---- entry and steps up to the temple floor
      ctx.slab(KIND.SOLID, 0, 10, w, { color: sand });
      ctx.banner(4, w, ['TEMPLO PERDIDO', 'CUIDADO COM O PÊNDULO!'], '#7f5539', '#ffd23f', false);
      ctx.advance(10);
      let up = 0;
      for (let i = 0; i < 3; i++) {
        ctx.advance(0, 0.45);
        up += 0.45;
        ctx.slab(KIND.SOLID, 0, 3.5, w + 2 - i * 0.6, { th: 1.4 + up, color: i % 2 ? sand : stone });
        ctx.advance(3.5);
      }
      // ---- pendulum hall
      const H = 39;
      ctx.slab(KIND.SOLID, 0, H, w, { th: 1.4 + up, color: stone });
      for (let f = 3; f < H; f += 6.5) {
        for (const s of [-1, 1]) {
          column(s * (w / 2 + 1.4), f, 5.5);
          if ((f | 0) % 2) ctx.decor(s * (w / 2 + 1.4), f, 6.3, 0.5, 0.6, 0.5, { color: fire, vkind: KIND.KILL });
        }
      }
      const nPend = 2 + (d > 0.35 ? 1 : 0);
      const L = 7.5, reach = w / 2 + 0.6, amp = Math.asin(Math.min(0.95, reach / L));
      const sp = 1.4 + d * 0.6, ph0 = rng() * 6.28, dir = rng() < 0.5 ? 1 : -1;
      for (let i = 0; i < nPend; i++) {
        const f = 8 + i * 12;
        const ph = ph0 + dir * i * 1.9;
        const blade = ctx.box(KIND.KILL, 0, f, 1.15, 1.1, 1.6, 0.5, { pool: 'dyn' });
        ctx.move(blade, { type: 'pendulum', length: L, amp, speed: sp, phase: ph, axis: 'x' });
        const armLen = L - 0.8, fr = armLen / (2 * L);
        const arm = ctx.decor(0, f, 1.15 + 0.8 + armLen / 2, 0.22, armLen, 0.22, { pool: 'dyn', color: dark });
        ctx.move(arm, { type: 'pendulum', length: L, amp, speed: sp, phase: ph, axis: 'x', fraction: fr });
        ctx.decor(0, f, 1.15 + L + 0.3, w + 3.6, 0.7, 0.9, { color: dark }); // beam the blade hangs from
        ctx.addCoin(0, f, 1.15);
      }
      ctx.advance(H);
      // ---- stepping stones over the chasm (short gaps: even a top-speed hop lands on stone)
      const nS = 4 + (d > 0.5 ? 1 : 0);
      const ss = 4;
      let off = 0;
      for (let i = 0; i < nS; i++) {
        const gap = 1.0 + rng() * 0.25 + d * 0.3;
        // the first stone is as wide as the hall: you may leave it off-center after a pendulum.
        // Stones never rise more than 0.15 m, so a hop that comes down inside a gap still meets
        // the next stone within step height.
        const dy = i === 0 ? 0 : (rng() - 0.7) * 0.5;
        ctx.advance(gap, dy);
        up += dy;
        if (i > 0) off = clamp(off + (rng() - 0.5) * 1.6, -0.9, 0.9);
        ctx.slab(KIND.SOLID, 0, ss, i === 0 ? w : ss + 0.4, { off, th: 9, color: i % 2 ? sand : stone });
        ctx.addCoin(off, ss / 2, 1.15);
        ctx.advance(ss);
      }
      const gA = 1.0 + d * 0.4;
      ctx.advance(gA);
      // ---- idol altar, then steps back down
      ctx.slab(KIND.SOLID, 0, 12, w, { th: 1.4 + Math.max(0, up), color: sand });
      const is = rng() < 0.5 ? -1 : 1;
      ctx.decor(is * (w / 2 + 2.5), 6, 0.6, 2.2, 1.2, 2.2, { color: stone });
      ctx.decor(is * (w / 2 + 2.5), 6, 1.7, 1.0, 1.0, 1.0, { color: gold });
      ctx.decor(is * (w / 2 + 2.5), 6, 2.6, 0.8, 0.8, 0.8, { color: gold });
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        ctx.addCoin(Math.cos(a) * 1.6, 6 + Math.sin(a) * 1.6, 1.15);
      }
      // back down to the entry level: the exit is long enough to catch a turbo flight off the drop
      const down = Math.max(0, up);
      ctx.advance(12, -down);
      // ...and a hop over the last chasm gap at turbo (48 m/s, vy 12.2) comes down ~35–41 m later
      // (~28 m at plain top speed): altar + exit catch it instead of the next piece (maybe a gap)
      const hop = (48 * (12.2 + Math.sqrt(12.2 * 12.2 + 2 * G * down))) / G;
      const ex = Math.max(10, 48 * Math.sqrt((2 * down) / G) + 2, hop + 1 - gA - 12);
      ctx.slab(KIND.SOLID, 0, ex, w, { color: stone });
      ctx.advance(ex);
    },
  },

  // ------------------------------------------------------------------ SALTO DA FÉ
  // A launch pad throws you over a 6 m deep pit. Slow riders come down on a huge pink
  // trampoline field and bounce out; fast ones fly straight onto the blocky stairs. Either way
  // you climb back to a long ledge at the starting height (it catches even turbo flights).
  // Physics: pad vy 21 (fwd >= 19) lands 28–71 m out at -6 m; a bounce off the floor (vy <= 24)
  // reaches the ledge within ~33 m from the end of the field.
  {
    name: 'x_salto',
    weight: () => 0.4,
    minDist: 450,
    gen(ctx) {
      const { KIND } = ctx;
      const rng = ctx.rng;
      const w = Math.max(ctx.W() + 1, 7.5);
      const D = 6, wp = w + 5;
      const pink = ctx.col3('#ff4fa3'), pinkL = ctx.col3('#ffc2e2'), cloud = ctx.col3('#ffffff');
      // ---- run-up and launch pad (spans the road)
      ctx.slab(KIND.SOLID, 0, 12, w);
      ctx.banner(3.5, w, ['SALTO DA FÉ', 'CONFIA E VAI!'], '#2b2d42', '#7df9ff', true);
      ctx.slab(KIND.JUMP, 8, 11.5, w, { dy: 0.06, th: 0.3 });
      // rings along the typical arc (~27 m/s)
      ctx.addRing(0, 25, 7.3);
      ctx.addRing(0, 33, 5.6);
      // back wall of the pit, from the field up to just under the road: a rider who holds S in
      // the air drifts backwards while bouncing and must not slip into the void under the run-up
      ctx.box(KIND.SOLID, 0, 11.6, -D / 2 - 0.65, wp + 1.6, D + 1.2, 0.8, { color: pinkL });
      ctx.advance(12, -D);
      // ---- the trampoline field, striped like a target: a bounce house with tall walls
      // the field reaches past where a 35 m/s rider (top speed without turbo) comes down, so
      // at normal speeds nobody lands at the foot of the stairs
      const F = 52, n = 16, WL = F + n;
      for (let i = 0; i < 4; i++) {
        ctx.slab(KIND.BOUNCE, i * 13, i * 13 + 13, wp, { th: 1.2, color: i % 2 ? pinkL : pink });
      }
      for (const s of [-1, 1]) {
        // walls run along the field and the stairs, top 9.4 m: higher than the biggest bounce
        // (24 m/s -> 8.5 m) plus the step-up, so air control can't carry anyone out of the pit
        ctx.box(KIND.SOLID, s * (wp / 2 + 0.4), WL / 2, 4.1, 0.8, 10.6, WL, { color: pinkL });
        for (const h of [3, 6.5, 9.4]) ctx.decor(s * (wp / 2 + 0.4), WL / 2, h, 0.9, 0.35, WL, { color: h > 9 ? pink : cloud });
        for (let k = 0; k < 3; k++) {
          const f = 6 + k * 17 + rng() * 4, lx = s * (wp / 2 + 5 + rng() * 6), sz = 2.5 + rng() * 2;
          ctx.decor(lx, f, -3 + rng() * 3, sz * 1.6, sz, sz * 1.2, { color: cloud });
          ctx.decor(lx + s * sz * 0.5, f + 0.8, -2.2 + rng() * 2, sz, sz * 0.8, sz, { color: cloud });
        }
      }
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        ctx.addCoin(Math.cos(a) * 3, 30 + Math.sin(a) * 3, 1.2);
      }
      ctx.addRing(0, 30, 3.3);
      ctx.advance(F);
      // ---- blocky stairs back up (boxes, so a rider flying into them just bonks; no wedge traps)
      // as wide as the field: a bounce next to a side wall must still come down on them
      const sr = D / n;
      for (let i = 0; i < n; i++) {
        ctx.advance(i ? 1 : 0, sr);
        ctx.slab(KIND.SOLID, 0, 1, wp, { th: 1.4 + sr * (i + 1), color: i % 2 ? pink : cloud });
      }
      ctx.advance(1);
      // ---- long ledge back at the starting height, field-wide: a fast bounce from the far end
      // of the field comes down ~20 m along it, wherever it was across the field
      const LE = 28;
      ctx.slab(KIND.SOLID, 0, LE, wp);
      ctx.coinLine(6, 22, 0, 5);
      ctx.advance(LE);
    },
  },
];
