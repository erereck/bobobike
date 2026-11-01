// bobobike piece pack: motion — things that move (lifts, hammers, crushers, lasers, turntables...).
// Default export: array of piece definitions (see SPEC.md "v4 — piece packs").
// Cursor-local coordinates: lx = lateral (+ right), lf = forward from the cursor, dy = height over the road top.

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const RAINBOW = ['#ff595e', '#ff924c', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93', '#ff66c4'];

// solid road from the cursor, then move the cursor to its end
function road(ctx, len, w, o) {
  ctx.slab(ctx.KIND.SOLID, 0, len, w, o);
  ctx.advance(len);
}

// a named arch over the entry, only sometimes (each one is a canvas texture)
function maybeBanner(ctx, chance, lf, w, lines, bg, fg, glow) {
  if (ctx.rng() < chance) ctx.banner(lf, w, lines, bg, fg, glow);
}

export default [
  // ------------------------------------------------------------------ XILOFONE
  // Rainbow keys bobbing up and down in a rolling wave. Adjacent keys never differ by more than
  // ~0.44 m (< 0.5 step-up), so it is a bumpy, friendly ride: no gaps, no hazards.
  {
    name: 'm_xylophone',
    early: true,
    weight: (d) => 0.6 - d * 0.25,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w = Math.max(ctx.W() + 1, 7);
      road(ctx, 8, w);
      maybeBanner(ctx, 0.5, -4, w, ['XILOFONE', 'TOCA UMA MÚSICA!'], '#6a4c93', '#ffca3a', false);
      const n = 14 + Math.floor(rng() * 5 + d01 * 6);
      const K = 2.4, gapK = 0; // keys touch: colour alone separates them (no seams to trip over)
      const A = 0.8 + d01 * 0.15;
      const dph = 0.45; // 2 * A * sin(dph / 2) <= 0.43 m between neighbours
      const ws = 1.9 + d01 * 1.2;
      const ph0 = rng() * TAU;
      const dir = rng() < 0.5 ? 1 : -1; // wave rolls toward or away from the rider
      const c0 = Math.floor(rng() * RAINBOW.length);
      for (let i = 0; i < n; i++) {
        const a = A * Math.min(1, (i + 1) / 4, (n - i) / 4); // ease in/out so the ends meet the road
        const f = i * K;
        const col = ctx.slab(KIND.SOLID, f, f + K - gapK, w, {
          pool: 'dyn', th: 1.6 + 2 * A, color: ctx.col3(RAINBOW[(c0 + i) % RAINBOW.length]),
        });
        ctx.move(col, { type: 'slide', axis: 'y', amp: a, speed: ws, phase: ph0 + dir * i * dph });
      }
      ctx.coinLine(K * 2, K * (n - 2), 0, Math.min(8, Math.floor(n / 2)));
      ctx.advance(n * K);
      road(ctx, 14, w); // long exit: a hop off the last bump at top speed still lands on road
    },
  },

  // ------------------------------------------------------------------ MARTELOS
  // Hammers on long arms swing sideways across the road from a beam overhead. At the end of each
  // swing the head is out past the road edge (and ~3 m up), so every lane opens up in turn.
  {
    name: 'm_pendulums',
    minDist: 300,
    weight: (d) => 0.45 + d * 0.35,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w = Math.max(ctx.W() + 1.5, 7.5);
      road(ctx, 8, w);
      maybeBanner(ctx, 0.45, -4, w, ['MARTELOS', 'PASSA NA HORA CERTA!'], '#1b1f3b', '#ff595e', false);
      const n = 2 + Math.floor(rng() * 2 + d01 * 2.6); // 2..5
      const sp = 9.5 - d01 * 1.5;
      const L = 7 + d01;          // pivot -> head centre
      const headY = 1.45;         // head centre at the bottom of the swing (bottom edge 0.55 above the road)
      const pivotY = headY + L;
      const amp = clamp(Math.asin(clamp((w / 2 + 1.7) / L, 0, 0.98)) + 0.12, 0.85, 1.3);
      const ws = 1.45 + d01 * 0.8;
      const len = 5 + (n - 1) * sp + 9;
      ctx.slab(KIND.SOLID, 0, len, w);
      // frame: a beam along the road at pivot height, held by an arch at each end
      const fc = ctx.colors.KERB_DARK;
      ctx.decor(0, len / 2, pivotY + 0.4, 0.8, 0.8, len - 1.4, { color: fc });
      for (const f of [0.8, len - 0.8]) {
        for (const s of [-1, 1]) ctx.decor(s * (w / 2 + 0.9), f, (pivotY + 0.8 - 3) / 2, 0.7, pivotY + 3.8, 0.7, { color: fc });
        ctx.decor(0, f, pivotY + 0.4, w + 2.5, 0.7, 0.7, { color: fc });
      }
      let ph = rng() * TAU;
      const step = (rng() < 0.5 ? 1 : -1) * (Math.PI / 2 + rng() * 0.5);
      for (let i = 0; i < n; i++) {
        const f = 5 + i * sp;
        const spec = { type: 'pendulum', length: L, amp, speed: ws, phase: ph, axis: 'x' };
        const head = ctx.box(KIND.KILL, 0, f, headY, 2.4, 1.8, 1.5, { pool: 'dyn' });
        ctx.move(head, { ...spec, fraction: 1 });
        const arm = ctx.decor(0, f, headY + L / 2, 0.35, L, 0.35, { pool: 'dyn', color: fc });
        ctx.move(arm, { ...spec, fraction: 0.5 });
        ctx.decor(0, f, pivotY, 1.1, 1.1, 1.1, { color: ctx.colors.WHITE }); // pivot hub
        ctx.addCoin(0, f, 1.15);
        ph += step;
      }
      ctx.advance(len);
      road(ctx, 10, w);
    },
  },

  // ------------------------------------------------------------------ ESMAGADORES
  // Red presses slam onto the road and lift 5 m up (higher than any jump reaches). Their phases form
  // a "green wave" for ~19 m/s: hold a steady speed and they open one after another. Later variant:
  // split lanes whose halves press in turn, so one side is always open.
  {
    name: 'm_crushers',
    minDist: 320,
    weight: (d) => 0.4 + d * 0.4,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w = Math.max(ctx.W() + 1, 7);
      road(ctx, 8, w);
      maybeBanner(ctx, 0.45, -4, w, ['ESMAGADORES', 'NÃO VIRA PANQUECA!'], '#ff2a3d', '#ffffff', false);
      const split = d01 > 0.3 && rng() < 0.45;
      const n = 3 + Math.floor(rng() * 2 + d01 * 2); // 3..6 rows
      const sp = 10 - d01 * 1.5;
      const D = 2.6, ch = 2.4;           // press depth (along the road) and height
      const lo = 0, hi = 5;              // press bottom edge travels between these heights
      const A = (hi - lo) / 2, cy = (hi + lo) / 2 + ch / 2;
      const ws = 1.25 + d01 * 0.85;
      const vT = 19;                     // green-wave speed (m/s)
      const rodLen = 6.4;
      const housingY = hi + ch + 1.2;
      const len = 6 + (n - 1) * sp + 9;
      const fc = ctx.colors.KERB_DARK;
      ctx.slab(KIND.SOLID, 0, len, w);
      const ph0 = rng() * TAU;
      for (let i = 0; i < n; i++) {
        const f = 6 + i * sp;
        const ph = ph0 - ws * (i * sp) / vT;
        // gantry: two posts and a housing the piston rods run through
        for (const s of [-1, 1]) ctx.decor(s * (w / 2 + 0.7), f, (housingY + 0.6 - 3) / 2, 0.8, housingY + 3.6, 0.8, { color: fc });
        ctx.decor(0, f, housingY, w + 2.2, 1.2, D + 0.6, { color: ctx.colors.WHITE });
        // halves span 0.1 .. w/2 + 0.2 from the centre: past the road edge, so the 0.35 m ledge
        // forgiveness cannot be used to sneak along the rim under a closed half
        const parts = split
          ? [[-(w / 4 + 0.15), w / 2 + 0.1, ph], [w / 4 + 0.15, w / 2 + 0.1, ph + Math.PI]]
          : [[0, w + 0.4, ph]];
        for (const [lx, cw, p] of parts) {
          const spec = { type: 'slide', axis: 'y', amp: A, speed: ws, phase: p };
          ctx.move(ctx.box(KIND.KILL, lx, f, cy, cw, ch, D, { pool: 'dyn' }), spec);
          ctx.move(ctx.decor(lx, f, cy + ch / 2 + rodLen / 2, 0.7, rodLen, 0.7, { pool: 'dyn', color: fc }), spec);
        }
        if (i < n - 1) ctx.addCoin(split ? (i % 2 ? 1 : -1) * w / 4 : 0, f + sp / 2, 1.15);
      }
      ctx.advance(len);
      road(ctx, 10, w);
    },
  },

  // ------------------------------------------------------------------ CORREDOR LASER
  // A dark corridor of laser gates: low beams (always on, jump them), blinking curtains (too tall to
  // jump; they flicker before switching on and form a green wave for ~20 m/s), half curtains (steer
  // to the open side) and later a "scanner" beam sliding up and down (go under it or hop it).
  {
    name: 'm_lasers',
    minDist: 260,
    weight: (d) => 0.4 + d * 0.4,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w = Math.max(ctx.W() + 0.5, 6.5);
      road(ctx, 8, w);
      maybeBanner(ctx, 0.5, -4, w, ['CORREDOR LASER', 'NÃO ENCOSTA!'], '#1b1f3b', '#ff2a6d', true);
      const n = 4 + Math.floor(rng() * 2 + d01 * 3); // 4..8 gates
      const sp = 9.5 + rng() * 2;
      const vT = 20;
      const on = 1.0 + d01 * 0.5, off = 1.5 - d01 * 0.35, per = on + off;
      // plan the gates first: a timed gate right after a low beam gets extra room, so a hop over the
      // beam (up to ~23 m of flight at top speed) lands before it
      const gates = [];
      let f = 6, curtains = 0, last = '';
      for (let i = 0; i < n; i++) {
        let type = 'low';
        if (i > 0) {
          const r = rng();
          if (d01 < 0.25) type = r < 0.55 ? 'curtain' : 'low';
          else if (r < 0.4) type = 'curtain';
          else if (r < 0.62) type = 'half';
          else if (r < 0.82 && d01 > 0.4) type = 'scan';
        }
        if (type === 'curtain' && (curtains >= 6 || last === 'curtain' && rng() < 0.5)) type = 'low';
        if (type === 'curtain') curtains++;
        const nf = i > 0 ? f + sp + (last === 'low' && (type === 'curtain' || type === 'scan') ? 8 : 0) : f;
        if (nf > 100) break; // keep the piece under 130 m
        f = nf;
        gates.push([f, type]);
        last = type;
      }
      const len = f + 12;
      const dark = ctx.colors.KERB_DARK;
      ctx.slab(KIND.SOLID, 0, len, w, { color: ctx.col3('#2b2d42') });
      const ph0 = rng() * per;
      const beamW = w + 0.6, bh = 0.22, bd = 0.22;
      for (const [f, type] of gates) {
        for (const s of [-1, 1]) ctx.decor(s * (w / 2 + 0.4), f, 1.6, 0.55, 4.4, 0.55, { color: dark });
        if (type === 'low') {
          ctx.box(KIND.KILL, 0, f, 0.5, beamW, bh, bd, { laser: true });
          ctx.addCoin(0, f, 2.4);
        } else if (type === 'curtain') {
          const ph = ph0 - f / vT; // every curtain shows the same state to a rider holding vT
          for (const y of [0.5, 1.5, 2.5, 3.5]) {
            ctx.move(ctx.box(KIND.KILL, 0, f, y, beamW, bh, bd, { laser: true, pool: 'dyn' }), { type: 'blink', on, off, phase: ph });
          }
          ctx.addCoin(0, f, 1.15);
        } else if (type === 'half') {
          const side = rng() < 0.5 ? -1 : 1, hw = w / 2 + 0.6;
          for (const y of [0.5, 1.5, 2.5, 3.5]) ctx.box(KIND.KILL, side * (hw / 2 - 0.3), f, y, hw, bh, bd, { laser: true });
          ctx.addCoin(-side * w / 4, f, 1.15);
        } else {
          // scanner: one beam sweeping 0.6 .. 3.8 m; under it when high, hop it when low
          const sc = ctx.box(KIND.KILL, 0, f, 2.2, beamW, bh, bd, { laser: true, pool: 'dyn' });
          ctx.move(sc, { type: 'slide', axis: 'y', amp: 1.6, speed: 1.7 + d01 * 0.6, phase: rng() * TAU });
        }
      }
      ctx.advance(len);
      road(ctx, 8, w);
    },
  },

  // ------------------------------------------------------------------ ELEVADOR
  // 2-3 lifts in walled shafts climb (or, high up, descend) one level each. A lift overshoots both
  // levels by 0.6 m and sits flush against the next landing, so you can never fall through: drive on
  // when it is down, ride it up (coins inside the shaft) and roll off at the top. The next lift is
  // phased to be waiting at the bottom when you arrive.
  {
    name: 'm_elevators',
    minDist: 200,
    weight: (d) => 0.4 + d * 0.1,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w = Math.max(ctx.W(), 6.5);
      // mostly up; down only now and then (or when high), since a fast rider can sail over a falling staircase
      const y0 = ctx.cur.y;
      const dir = y0 > 24 ? -1 : y0 < -10 ? 1 : rng() < 0.15 ? -1 : 1;
      road(ctx, 8, w);
      maybeBanner(ctx, 0.5, -4, w, dir > 0 ? ['ELEVADOR', 'SOBE AÍ!'] : ['ELEVADOR', 'DESCENDO!'], '#1b1f3b', '#7df9ff', false);
      const k = dir < 0 ? 2 : 2 + (rng() < 0.4 + d01 * 0.3 ? 1 : 0);
      const Lp = 7;
      const ws = 1.1 + d01 * 0.5;
      const tau = 0.6; // ~time to cross a landing
      const c = ctx.pickColor(), wall = ctx.shade(ctx.pickColor());
      let ph = rng() * TAU;
      for (let i = 0; i < k; i++) {
        const rise = (2.2 + rng() * 0.8) * dir;
        const lo = Math.min(0, rise), hi = Math.max(0, rise);
        const amp = (hi - lo) / 2 + 0.6;
        const lift = ctx.slab(KIND.SOLID, 0.04, Lp - 0.04, w, {
          dy: (hi + lo) / 2, th: hi - lo + 2.2, pool: 'dyn', color: ctx.col3('#ffd23f'),
        });
        ctx.move(lift, { type: 'slide', axis: 'y', amp, speed: ws, phase: ph });
        // shaft walls keep you on the lift while it moves
        const wb = lo - 1.4, wt = hi + 1.2;
        for (const s of [-1, 1]) ctx.box(KIND.SOLID, s * (w / 2 + 0.3), Lp / 2, (wb + wt) / 2, 0.6, wt - wb, Lp + 0.6, { color: wall });
        ctx.addCoin(0, Lp / 2, (hi + lo) / 2 + 1.15);
        ctx.advance(Lp, rise);
        ph += Math.PI - ws * tau; // next lift reaches the far end just as you arrive
        // going down, a hop at turbo speed (48 m/s) off the top flies ~52 m: give it a long runout
        const landing = i < k - 1 ? 6 : dir < 0 ? 30 : 12;
        ctx.slab(KIND.SOLID, 0, landing, w, { th: Math.abs(rise) + 1.6, color: i % 2 ? c : ctx.shade(c) });
        if (i === k - 1) ctx.slab(KIND.BOOST, 2.5, 7, Math.min(w, 4.5), { dy: 0.06, th: 0.3 });
        ctx.advance(landing);
      }
      road(ctx, dir < 0 ? 8 : 6, w);
    },
  },

  // ------------------------------------------------------------------ CARROSSEL
  // A big octagonal turntable spins under you and turns you with it: counter-steer to ride straight
  // across. Thin lips overhang the disc at both ends, so getting on and off never has a gap. Later a
  // red pole stands in the middle (with a spinning canopy) and red posts ride around on the disc.
  {
    name: 'm_carousel',
    minDist: 280,
    weight: (d) => 0.4 + d * 0.2,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w0 = ctx.W();
      // octagon inradius; big enough that every point of the entry lip's tip sits over the disc
      const r = Math.max(8 + d01 * 1.2 + rng() * 0.8, (w0 * w0 / 4 + 3) / 3.4 + 0.3);
      const R = r * 1.0824;            // circumradius (r / cos 22.5°)
      const s = 2 * r * 0.41421;       // octagon side = band width
      const T = -0.5, X = -0.05;       // disc top and exit level, relative to the entry road
      const e0 = 8, c = e0 + R + 0.3;  // thick entry length, disc centre
      const ws = (0.45 + d01 * 0.55) * (rng() < 0.5 ? 1 : -1);
      const pole = d01 > 0.22 && rng() < 0.75;
      const posts = d01 > 0.35 ? 2 + (d01 > 0.7 ? 1 : 0) : 0;
      const col = ctx.pickColor(), white = ctx.colors.WHITE;
      ctx.slab(KIND.SOLID, 0, e0, w0);
      ctx.slab(KIND.SOLID, e0, c - r + 1.2, w0, { th: 0.3, color: ctx.shade(col) });           // entry lip
      ctx.slab(KIND.SOLID, c + r - 1.6, c + R + 0.3, w0 + 2, { dy: X, th: 0.25, color: ctx.shade(col) }); // exit lip
      ctx.slab(KIND.SOLID, c + R + 0.3, c + R + 10.3, w0 + 2, { dy: X }); // as wide as the lip: a rider the disc carried sideways still has road
      maybeBanner(ctx, 0.5, 3, w0, ['CARROSSEL', 'SEGURA O GUIDÃO!'], '#ff66c4', '#ffffff', false);
      // the disc: four bands at 45° steps (their union is an exact octagon), tops staggered by 3 cm
      for (let j = 0; j < 4; j++) {
        const top = T + j * 0.03;
        const band = ctx.box(KIND.SOLID, 0, c, top - 0.5, s, 1.0, 2 * r, { pool: 'dyn', yaw: j * Math.PI / 4, color: j % 2 ? white : col });
        ctx.move(band, { type: 'spin', speed: ws, phase: 0 });
      }
      ctx.decor(0, c, T - 3.5, 1.6, 6, 1.6, { color: ctx.colors.KERB_DARK }); // axle under the disc
      if (pole) {
        ctx.box(KIND.KILL, 0, c, T + 1.6, 1.4, 3.2, 1.4);
        ctx.decor(0, c, T + 5.1, 0.6, 3.8, 0.6, { color: white });
        for (let j = 0; j < 2; j++) {
          const roof = ctx.decor(0, c, T + 7.2, r * 1.1, 0.5, r * 1.1, { pool: 'dyn', yaw: j * Math.PI / 4, color: j ? white : ctx.colors.KILL });
          ctx.move(roof, { type: 'spin', speed: ws, phase: 0 });
        }
      }
      // red posts riding on the disc (orbit turns the opposite way to yaw, hence -ws)
      const a0 = rng() * TAU;
      for (let j = 0; j < posts; j++) {
        const p = ctx.box(KIND.KILL, 0, c, T + 0.9, 1.1, 1.8, 1.1, { pool: 'dyn' });
        ctx.move(p, { type: 'orbit', radius: r * 0.58, speed: -ws, phase: a0 + j * TAU / posts });
      }
      const lane = pole ? (rng() < 0.5 ? -2.4 : 2.4) : 0;
      ctx.coinLine(c - r + 2.5, c + r - 2.5, lane, 5);
      ctx.advance(c + R + 10.3, X);
    },
  },

  // ------------------------------------------------------------------ COBRA
  // The road itself slithers: a chain of short striped segments sliding sideways in a travelling
  // wave. Neighbours are never more than ~0.85 m apart and the ends taper into the fixed road, so it
  // is one continuous wiggling road to follow (you ride along with the segment under you).
  {
    name: 'm_snake',
    minDist: 150,
    weight: (d) => 0.45 + d * 0.1,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w0 = ctx.W();
      road(ctx, 8, w0);
      maybeBanner(ctx, 0.45, -4, w0, ['COBRA!', 'SEGUE O RABO DELA'], '#2f9e44', '#ffe066', false);
      const n = 14 + Math.floor(rng() * 6 + d01 * 6); // 14..25 segments
      const Ls = 3;
      const sw = Math.max(4.2, 6.2 - d01 * 1.8);
      const A = 2.6 + d01 * 1.4 + rng() * 0.5;
      const dph = 2 * Math.asin(0.85 / (2 * A)) * (rng() < 0.5 ? 1 : -1); // neighbour offset <= 0.85 m
      const ws = 1.0 + d01 * 0.6;
      const ph0 = rng() * TAU;
      const green = ctx.col3('#2f9e44'), yellow = ctx.col3('#ffe066');
      for (let i = 0; i < n; i++) {
        const a = A * Math.min(1, (i + 1) / 5, (n - i) / 5);
        const seg = ctx.slab(KIND.SOLID, i * Ls, (i + 1) * Ls, sw, { pool: 'dyn', th: 1.2, color: i % 2 ? yellow : green });
        ctx.move(seg, { type: 'slide', axis: 'x', amp: a, speed: ws, phase: ph0 + i * dph });
      }
      ctx.advance(n * Ls);
      ctx.slab(KIND.SOLID, 0, 12, w0);
      ctx.coinLine(2, 10, 0, 4);
      ctx.advance(12);
    },
  },

  // ------------------------------------------------------------------ VAI-E-VEM
  // Bridge sections shuttle forward and back on rails between fixed islands: the gap behind a
  // shuttle closes while the one in front opens (never more than ~5 m, always jumpable). Later the
  // shuttles come in pairs side by side, moving opposite ways: pick the lane that is docked.
  {
    name: 'm_shuttles',
    minDist: 220,
    weight: (d) => 0.45 + d * 0.15,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w = Math.max(ctx.W(), 6.6);
      road(ctx, 8, w);
      maybeBanner(ctx, 0.45, -4, w, ['VAI-E-VEM', 'PULA NA HORA H!'], '#1b1f3b', '#4cc9f0', false);
      const k = 2 + (rng() < 0.35 + d01 * 0.3 ? 1 : 0);
      const A = 1.4 + d01 * 0.7 + rng() * 0.2; // max gap 2A + 0.25 <= 4.85 m: rollable at top speed
      const ws = 0.9 + d01 * 0.7;
      const twin = d01 > 0.3 && rng() < 0.45;
      const g0 = A + 0.25;
      const cyan = ctx.col3('#4cc9f0'), dark = ctx.colors.KERB_DARK;
      let ph = rng() * TAU;
      for (let i = 0; i < k; i++) {
        const Ls = 10 + rng() * 3;
        const span = 2 * g0 + Ls;
        for (const s of [-1, 1]) ctx.decor(s * w / 3, span / 2, -1.7, 0.4, 0.4, span + 1, { color: dark }); // rails
        const lanes = twin ? [[-(w / 4 + 0.15), w / 2 - 0.3, ph], [w / 4 + 0.15, w / 2 - 0.3, ph + Math.PI]] : [[0, w, ph]];
        for (const [off, sw, p] of lanes) {
          const sh = ctx.slab(KIND.SOLID, g0, g0 + Ls, sw, { off, pool: 'dyn', th: 1.2, color: cyan });
          ctx.move(sh, { type: 'slide', axis: 'z', amp: A, speed: ws, phase: p });
        }
        ctx.addCoin(0, g0, 2.4);
        ctx.addCoin(0, g0 + Ls, 2.4);
        ctx.advance(span);
        const land = i < k - 1 ? 8 : 16;
        ctx.slab(KIND.SOLID, 0, land, w);
        ctx.advance(land);
        ph += 1.2 + rng() * 2.5;
      }
    },
  },

  // ------------------------------------------------------------------ MOINHO
  // A big square deck with a windmill tower in the middle (steer around it) and long sweeper arms
  // turning at shin height (0.95 m: hop them, or slip through between two). Early the arms are white
  // and only shove you; later they are red. Far in, two decks spin in opposite directions.
  {
    name: 'm_windmill',
    minDist: 240,
    weight: (d) => 0.4 + d * 0.2,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w0 = ctx.W();
      road(ctx, 7, w0);
      maybeBanner(ctx, 0.45, -3.5, w0, ['MOINHO', 'PULA AS PÁS!'], '#ffffff', '#1b1f3b', false);
      const S = 17 + d01 * 2;
      const kill = d01 > 0.45;
      const decks = d01 > 0.6 && rng() < 0.35 ? 2 : 1;
      let ws = (0.65 + d01 * 0.5) * (rng() < 0.5 ? 1 : -1);
      const white = ctx.colors.WHITE, red = ctx.colors.KILL;
      const lane = rng() < 0.5 ? -1 : 1;
      const dc = ctx.pickColor();
      // the deck is much wider than the road: step it down in a funnel, so a rider who dodged round
      // the tower on the far side is not dumped off the deck's edge beside a narrow exit
      const funnel = () => {
        const w1 = Math.max(w0, S - 3), w2 = Math.max(w0, (S - 3 + w0) / 2);
        ctx.slab(KIND.SOLID, 0, 4, w1, { color: ctx.shade(dc) });
        ctx.slab(KIND.SOLID, 4, 8, w2, { color: dc });
        ctx.advance(8);
      };
      for (let k = 0; k < decks; k++) {
        const arms = d01 > 0.6 && rng() < 0.5 ? 3 : 2; // bars through the hub: 2 = cross, 3 = six arms
        const c = S / 2;
        ctx.slab(KIND.SOLID, 0, S, S, { color: dc });
        ctx.box(KIND.SOLID, 0, c, 3, 2.4, 6, 2.4, { color: white }); // tower
        ctx.decor(0, c, 6.6, 3.2, 1.2, 3.2, { color: red });          // roof
        const ph = rng() * TAU;
        for (let j = 0; j < arms; j++) {
          const bar = ctx.box(kill ? KIND.KILL : KIND.SOLID, 0, c, 0.5, S - 1.2, 0.9, 0.6, { pool: 'dyn', yaw: j * Math.PI / arms, color: kill ? red : white });
          ctx.move(bar, { type: 'spin', speed: ws, phase: ph });
        }
        for (let j = 0; j < 2; j++) { // rotor on the roof, just for show
          const blade = ctx.decor(0, c, 7.5, S * 0.55, 0.25, 1.1, { pool: 'dyn', yaw: j * Math.PI / 2, color: white });
          ctx.move(blade, { type: 'spin', speed: ws * 2.5, phase: 0 });
        }
        ctx.coinLine(2.5, S - 2.5, lane * 3.6, 5);
        ctx.advance(S);
        funnel();
        if (k < decks - 1) ws = -ws;
      }
      road(ctx, 6, w0);
    },
  },

  // ------------------------------------------------------------------ PORTA MÓVEL
  // Rows of tall red walls (too tall to jump) with one opening each; the walls slide side to side,
  // so the hole wanders across the road and you steer to stay in it. At any position the walls
  // still reach past both road edges. Rows are out of step, so the holes zigzag.
  {
    name: 'm_slidegates',
    minDist: 300,
    weight: (d) => 0.35 + d * 0.4,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w = Math.max(ctx.W() + 1.5, 7.5);
      road(ctx, 8, w);
      maybeBanner(ctx, 0.45, -4, w, ['PORTA MÓVEL', 'ACHA O BURACO!'], '#ff2a3d', '#ffe066', false);
      const n = 3 + Math.floor(rng() * 2 + d01 * 2); // 3..6 rows
      const sp = 12 - d01 * 2;
      const hole = Math.max(3.4, 5.2 - d01 * 1.6);
      const A = (w - hole) / 2 - 0.2;   // hole centre travels ±A and never leaves the road
      const ws = 0.9 + d01 * 0.7;
      const H = 3.4, T = 0.8;           // wall height (above any jump) and thickness
      const ext = w / 2 + A + 0.6;      // outer wall ends, measured from the centre at rest
      const lw = ext - hole / 2;
      const len = 6 + (n - 1) * sp + 9;
      ctx.slab(KIND.SOLID, 0, len, w);
      let ph = rng() * TAU;
      const turn = rng() < 0.5 ? 1 : -1;
      for (let i = 0; i < n; i++) {
        const f = 6 + i * sp;
        const spec = { type: 'slide', axis: 'x', amp: A, speed: ws, phase: ph };
        for (const s of [-1, 1]) ctx.move(ctx.box(KIND.KILL, s * (hole / 2 + lw / 2), f, H / 2, lw, H, T, { pool: 'dyn' }), spec);
        ctx.decor(0, f, H + 0.35, 2 * (ext + A), 0.35, 0.5, { color: ctx.colors.KERB_DARK }); // guide rail
        if (i < n - 1) ctx.addCoin(0, f + sp / 2, 1.15);
        ph += turn * (0.6 + d01 * 0.6 + rng() * 0.6); // gentle zigzag early, sharper later
      }
      ctx.advance(len);
      road(ctx, 10, w);
    },
  },

  // ------------------------------------------------------------------ PLATAFORMAS DANÇANTES
  // Platforms over the void, each circling its own small orbit on a crank, a quarter turn out of
  // step with the next. Gaps breathe between ~0.4 m and ~5 m early (~8 m late, still a plain hop)
  // and neighbours never touch. Ride along, hop when they line up.
  {
    name: 'm_orbiters',
    minDist: 350,
    weight: (d) => 0.35 + d * 0.3,
    gen(ctx) {
      const { KIND, rng, d01 } = ctx;
      const w0 = ctx.W();
      road(ctx, 7, w0);
      maybeBanner(ctx, 0.4, -3.5, w0, ['PLATAFORMAS', 'DANÇANTES'], '#ff66c4', '#1b1f3b', false);
      const n = 4 + Math.floor(rng() * 2 + d01 * 2); // 4..7
      const s = Math.max(4.8, 6.2 - d01 * 1.4);       // width
      const L = s + 1.5;                               // length along the road
      const R = 1.4 + d01 * 0.8 + rng() * 0.2;         // orbit radius
      const dph = (Math.PI / 2) * (rng() < 0.5 ? 1 : -1);
      const rel = 2 * R * Math.sin(Math.PI / 4);       // largest offset between neighbours
      const g = rel + 0.4 + d01 * 0.8;                 // rest gap: neighbours never touch
      const ow = (0.8 + d01 * 0.5) * (rng() < 0.5 ? 1 : -1);
      const ph0 = rng() * TAU;
      const yaw = ctx.cur.yaw;
      const c = ctx.pickColor(), dark = ctx.colors.KERB_DARK;
      let f = R + 0.4; // first platform comes within 0.4 m of the entry
      for (let i = 0; i < n; i++) {
        const ph = ph0 + i * dph, mid = f + L / 2;
        const p = ctx.slab(KIND.SOLID, f, f + L, s, { pool: 'dyn', th: 1.0, color: i % 2 ? c : ctx.shade(c) });
        ctx.move(p, { type: 'orbit', radius: R, speed: ow, phase: ph });
        // crank under it: a bar turning about the axle with one end under the platform
        // (orbit angle runs opposite to yaw, so the bar spins at -ow with its phase mirrored)
        const crank = ctx.decor(0, mid, -1.6, 2 * R + 0.8, 0.4, 0.5, { pool: 'dyn', color: dark });
        ctx.move(crank, { type: 'spin', speed: -ow, phase: -ph - yaw });
        ctx.decor(0, mid, -4.7, 0.6, 6.2, 0.6, { color: dark }); // axle
        ctx.addCoin(0, mid, 1.15);
        f += L + (i < n - 1 ? g : R + 0.4);
      }
      ctx.slab(KIND.SOLID, f, f + 14, w0);
      ctx.advance(f + 14);
    },
  },
];
