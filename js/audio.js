// bobobike — audio. Every sound is synthesized live with the WebAudio API:
//  • procedural music: 132 BPM chiptune / synthwave loop on a lookahead scheduler. Each zone
//    picks a key, scale, chord progression and timbre set, plus a seeded 8-bar melody built
//    from repeated motifs (strong beats snapped to chord tones). Intensity 0..1 adds layers
//    (hats → arp → lead → driving drums/bass → lead doubling) at bar boundaries.
//  • engine + wind: persistent nodes created once, driven per frame with smoothed AudioParams.
//  • one-shot SFX (jump, coin, "oof", fanfares, risers…) sharing one noise buffer.
// Every public call is a silent no-op until unlock() succeeds, and nothing ever throws.

const BPM = 132;
const S16 = 60 / BPM / 4; // one 16th note in seconds
const LOOKAHEAD = 0.12; // schedule this far ahead (s)
const TICK_MS = 25; // scheduler period (ms)
const MASTER_LVL = 0.9;
const NONE = -99;

const MTOF = new Float32Array(128);
for (let i = 0; i < 128; i++) MTOF[i] = 440 * Math.pow(2, (i - 69) / 12);

const noop = () => {};
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mod7 = (d) => ((d % 7) + 7) % 7;
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---------------------------------------------------------------------------------------------
// Music data
// ---------------------------------------------------------------------------------------------
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

// 16-step lookup from [step, semitones above chord root, length in steps] triples.
function pattern(list) {
  const off = new Int8Array(16).fill(NONE);
  const len = new Uint8Array(16);
  for (const [s, o, l] of list) { off[s] = o; len[s] = l; }
  return { off, len };
}
const hits = (str) => Uint8Array.from(str, (ch) => (ch === 'x' ? 1 : 0));

const BASS = {
  chip: pattern([[0, 0, 2], [2, 12, 1], [4, 0, 2], [6, 12, 1], [8, 0, 2], [10, 12, 1], [12, 7, 2], [14, 12, 1]]),
  synth: pattern([[0, 0, 1], [2, 0, 1], [4, 0, 1], [6, 12, 1], [8, 0, 1], [10, 0, 1], [12, 0, 1], [14, 12, 1]]),
  drive: pattern([[0, 0, 1], [1, 0, 1], [2, 12, 1], [3, 0, 1], [4, 0, 1], [5, 0, 1], [6, 12, 1], [7, 0, 1],
    [8, 0, 1], [9, 0, 1], [10, 12, 1], [11, 0, 1], [12, 0, 1], [13, 0, 1], [14, 12, 1], [15, 7, 1]]),
  funk: pattern([[0, 0, 2], [3, 0, 1], [6, 12, 2], [8, 0, 1], [10, 7, 1], [11, 12, 1], [13, 0, 1], [14, 7, 2]]),
  dream: pattern([[0, 0, 6], [6, 7, 2], [8, 12, 3], [11, 7, 3], [14, 0, 2]]),
};
const KICK = {
  chip: { lo: hits('x.......x.x.....'), hi: hits('x.....x.x.x...x.') },
  synth: { lo: hits('x.......x.......'), hi: hits('x...x...x...x...') },
  dream: { lo: hits('x.........x.....'), hi: hits('x.....x...x.....') },
};
const SNARE = hits('....x.......x...');
// Arp patterns index the 6 chord tones of a bar (two octaves of the triad).
const ARP_UP = [0, 1, 2, 3, 4, 5];
const ARP_UPDOWN = [0, 1, 2, 3, 4, 3, 2, 1];
const ARP_BROKEN = [0, 2, 1, 3, 2, 4, 3, 5];
const ARP_WIDE = [0, 3, 1, 4, 2, 5, 1, 4];

// Lead melody rhythms: [step, length]. RHY = motif bars, CAD = cadence bars (long last note).
const RHY = [
  [[0, 3], [3, 3], [6, 2], [8, 2], [10, 2], [12, 4]],
  [[0, 2], [2, 2], [4, 3], [7, 1], [8, 4], [12, 2], [14, 2]],
  [[0, 4], [4, 2], [6, 2], [8, 3], [11, 3], [14, 2]],
  [[0, 3], [3, 3], [6, 4], [10, 2], [12, 4]],
  [[0, 2], [3, 1], [4, 2], [6, 2], [8, 2], [10, 3], [13, 3]],
  [[2, 2], [4, 2], [6, 2], [8, 4], [12, 2], [14, 2]],
  [[0, 1], [1, 1], [2, 2], [4, 4], [8, 1], [9, 1], [10, 2], [12, 4]],
];
const CAD = [
  [[0, 3], [3, 3], [6, 10]],
  [[0, 2], [2, 2], [4, 2], [6, 2], [8, 8]],
  [[0, 4], [4, 4], [8, 8]],
  [[0, 2], [2, 4], [6, 10]],
];
const START_DEG = [2, 4, 4, 0, 7];
const DEG_LO = -2, DEG_HI = 7;
const REPEAT_ESC = [2, -2, 1, -1, 3, -3];
const CYCLE_SHIFT = [0, 2, 5, 1]; // key shift on each full lap of the 7 zones

// Timbre/groove sets. Waves: native types, 'p12'/'p25' pulse, 'p50' square, 'soft' flute-ish.
const STYLES = {
  // NES-like: pulse lead + thin pulse arps, bouncing octave bass, rock beat.
  chip: {
    lead: 'p25', dbl: 'p12', leadVol: 0.12, leadCut: 7500, glide: 0, vib: 16,
    arp: 'p12', arpVol: 0.2, arpCut: 7000, arpDecay: 0.4, arpRate: 1, arpPat: ARP_UP,
    bass: 'p50', bassVol: 0.15, bassCut: 950, bassPat: 'chip', bassHi: null,
    pad: 'triangle', padVol: 0.025, padCut: 3200, pump: 0,
    kick: KICK.chip, openHat: false, delay: 0.12,
  },
  // Synthwave: detuned saw lead with glide, side-chain pumping saw pad, driving bass.
  synth: {
    lead: 'saw2', dbl: 'square', leadVol: 0.08, leadCut: 3600, glide: 0.03, vib: 14,
    arp: 'sawtooth', arpVol: 0.16, arpCut: 2600, arpDecay: 0.4, arpRate: 1, arpPat: ARP_UPDOWN,
    bass: 'sawtooth', bassVol: 0.15, bassCut: 650, bassPat: 'synth', bassHi: 'drive',
    pad: 'sawtooth', padVol: 0.03, padCut: 1500, pump: 0.65,
    kick: KICK.synth, openHat: true, delay: 0.26,
  },
  // Dreamy: soft flute lead, broken-chord arps, half-time groove, big wet pad.
  dream: {
    lead: 'soft', dbl: 'triangle', leadVol: 0.1, leadCut: 5200, glide: 0.02, vib: 20,
    arp: 'triangle', arpVol: 0.13, arpCut: 4200, arpDecay: 0.4, arpRate: 1, arpPat: ARP_BROKEN,
    bass: 'sawtooth', bassVol: 0.18, bassCut: 420, bassPat: 'dream', bassHi: 'synth',
    pad: 'sawtooth', padVol: 0.036, padCut: 1100, pump: 0.35,
    kick: KICK.dream, openHat: false, delay: 0.34,
  },
};

// One song per zone theme (index = zone % 7). prog = scale degrees, one chord per bar.
const SONGS = [
  { key: 0, scale: MAJOR, prog: [0, 4, 5, 3], style: 'chip' }, // C    I-V-vi-IV
  { key: 2, scale: MAJOR, prog: [5, 3, 0, 4], style: 'synth', swing: 0.14, // D vi-IV-I-V
    over: { lead: 'p25', dbl: 'p12', leadVol: 0.11, leadCut: 5200, glide: 0, bassPat: 'funk', bassHi: 'funk', arpPat: ARP_BROKEN, pump: 0.4 } },
  { key: 3, scale: MAJOR, prog: [3, 4, 2, 5], style: 'synth', over: { arpPat: ARP_WIDE } }, // Eb IV-V-iii-vi
  { key: 9, scale: MINOR, prog: [0, 5, 2, 6], style: 'synth' }, // Am   i-VI-III-VII
  { key: 4, scale: MINOR, prog: [5, 6, 0, 3], style: 'dream' }, // Em   VI-VII-i-iv
  { key: 0, scale: MINOR, prog: [0, 3, 6, 2], style: 'dream', // Cm   i-iv-VII-III
    over: { kick: KICK.synth, bassHi: 'drive', openHat: true, arpPat: ARP_UPDOWN } },
  { key: 7, scale: MAJOR, prog: [0, 5, 3, 4], style: 'chip', swing: 0.16, over: { arpPat: ARP_UPDOWN } }, // G I-vi-IV-V
];
for (const s of SONGS) s.st = Object.assign({}, STYLES[s.style], s.over || null);

function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clampDeg = (d) => (d < DEG_LO ? DEG_LO : d > DEG_HI ? DEG_HI : d);
const isChordTone = (d, chordDeg) => { const r = mod7(d - chordDeg); return r === 0 || r === 2 || r === 4; };
// Weak-beat notes that clash easily (4th/7th in major, 2nd/b6th in minor) unless in the chord.
const isAvoid = (d, minor, chordDeg) => {
  if (isChordTone(d, chordDeg)) return false;
  const r = mod7(d);
  return minor ? r === 1 || r === 5 : r === 3 || r === 6;
};
function snapToChord(d, chordDeg, dir) {
  if (isChordTone(d, chordDeg)) return d;
  const a = d + dir, b = d - dir; // one neighbour is always a chord tone
  if (isChordTone(a, chordDeg) && a >= DEG_LO - 1 && a <= DEG_HI) return a;
  if (isChordTone(b, chordDeg) && b >= DEG_LO - 1 && b <= DEG_HI) return b;
  return isChordTone(a, chordDeg) ? a : b;
}
// Melodic random walk in scale degrees: mostly steps, occasional leaps that recover by step.
function walk(rng, n, start) {
  const out = new Int8Array(n);
  let d = start, last = 0;
  out[0] = d;
  for (let i = 1; i < n; i++) {
    let m;
    if (last >= 3 || last <= -3) m = last > 0 ? -1 : 1;
    else {
      const r = rng();
      m = r < 0.36 ? -1 : r < 0.72 ? 1 : r < 0.78 && last !== 0 ? 0 : r < 0.92 ? (rng() < 0.5 ? -2 : 2) : (rng() < 0.5 ? -3 : 3);
      if (m === 0 && last === 0) m = 1;
      if ((d >= 5 && m > 0) || (d <= -1 && m < 0)) m = -m;
    }
    d = clampDeg(d + m);
    out[i] = d;
    last = m;
  }
  return out;
}

// Build everything the sequencer needs for one zone (called only on zone change).
function composeSong(zoneIndex) {
  const z = Math.max(0, Math.floor(+zoneIndex || 0));
  const def = SONGS[z % SONGS.length];
  const key = (def.key + CYCLE_SHIFT[Math.floor(z / SONGS.length) & 3]) % 12;
  const scale = def.scale, minor = scale === MINOR, prog = def.prog;
  const pcOf = (deg) => (key + scale[mod7(deg)]) % 12;

  // Chord voicings per bar: bass root C2..B2, pad G3..F#4 window (smooth voice leading),
  // arp = triad in C4..B4 plus its octave.
  const bassRoot = new Uint8Array(4), pad = new Uint8Array(12), arp = new Uint8Array(24);
  for (let c = 0; c < 4; c++) {
    const tri = [pcOf(prog[c]), pcOf(prog[c] + 2), pcOf(prog[c] + 4)];
    bassRoot[c] = 36 + tri[0];
    const p = tri.map((x) => 55 + ((x + 5) % 12)).sort((a, b) => a - b);
    const a = tri.map((x) => 60 + x).sort((x, y) => x - y);
    for (let i = 0; i < 3; i++) pad[c * 3 + i] = p[i];
    for (let i = 0; i < 6; i++) arp[c * 6 + i] = a[i % 3] + (i >= 3 ? 12 : 0);
  }

  // Melody: phrase A B A cad | A B A' cad over the 4-chord loop played twice.
  const tonic = 65 + ((key + 7) % 12); // F4..E5
  const degMidi = (d) => tonic + 12 * Math.floor(d / 7) + scale[mod7(d)];
  const rng = mulberry32(0x5eed + z * 7919);
  const pick = (arr) => arr[(rng() * arr.length) | 0];
  const ra = pick(RHY);
  let rb = pick(RHY);
  if (rb === ra) rb = RHY[(RHY.indexOf(ra) + 3) % RHY.length];
  const e1 = pick(CAD), e2 = pick(CAD);
  const start = pick(START_DEG);
  const ca = walk(rng, ra.length, start);
  const cb = walk(rng, rb.length, clampDeg(ca[ca.length - 1] + (rng() < 0.5 ? 1 : -1)));
  const plan = [ra, rb, ra, e1, ra, rb, ra, e2];
  const cont = [ca, cb, ca, null, ca, cb, ca, null];
  // Bar 7 restates motif A shifted (up for a climax when there is headroom).
  let hiA = DEG_LO, loA = DEG_HI;
  for (let i = 0; i < ca.length; i++) { hiA = Math.max(hiA, ca[i]); loA = Math.min(loA, ca[i]); }
  const lift = hiA + 2 <= DEG_HI ? 2 : loA - 2 >= DEG_LO ? -2 : 0;

  const melNote = new Uint8Array(128), melLen = new Uint8Array(128), melFrom = new Uint8Array(128);
  let prev = start, prevEnd = -1, prevMidi = 0, reps = 0;
  for (let b = 0; b < 8; b++) {
    const cd = prog[b & 3], rh = plan[b], k = rh.length;
    let first = 0, target = 0;
    if (!cont[b]) {
      // Cadence: walk stepwise from a chord tone to the goal (5th mid-phrase, tonic at the end).
      const goal = b === 7 ? (Math.abs(prev - 7) < Math.abs(prev) ? 7 : 0) : 4;
      target = snapToChord(goal, cd, prev > goal ? 1 : -1);
      // Approach the goal by step from the side the melody is coming from.
      const dirC = prev >= target ? 1 : -1;
      first = snapToChord(clampDeg(target + dirC * (k - 1)), cd, dirC);
      if (first === target) first = snapToChord(target + dirC * 2, cd, dirC);
    }
    for (let i = 0; i < k; i++) {
      const stp = rh[i][0], len = rh[i][1];
      let d;
      if (cont[b]) {
        d = clampDeg(cont[b][i] + (b === 6 ? lift : 0));
        const dir = d >= prev ? 1 : -1;
        const strong = (stp & 3) === 0 || len >= 4;
        if (strong || isAvoid(d, minor, cd)) {
          let sn = snapToChord(d, cd, dir);
          if (sn === prev && d !== prev) { const alt = snapToChord(d, cd, -dir); if (alt !== prev) sn = alt; }
          d = sn; // strong beats / long notes land on chord tones
        }
        if (d === prev && reps >= 1) { // never three identical notes in a row
          for (let j = 0; j < REPEAT_ESC.length; j++) {
            const y = d + REPEAT_ESC[j] * (d > 3 ? -1 : 1);
            if (y >= DEG_LO && y <= DEG_HI && (strong ? isChordTone(y, cd) : !isAvoid(y, minor, cd))) { d = y; break; }
          }
        }
      } else if (i === k - 1) d = target;
      else if (i === 0) d = first;
      else {
        d = Math.round(first + ((target - first) * i) / (k - 1));
        if (isAvoid(d, minor, cd)) d = snapToChord(d, cd, target > d ? 1 : -1);
      }
      const idx = b * 16 + stp, m = degMidi(d);
      melNote[idx] = m;
      melLen[idx] = len;
      if (prevEnd === idx) melFrom[idx] = prevMidi; // legato → glide source
      reps = d === prev ? reps + 1 : 0;
      prev = d; prevEnd = idx + len; prevMidi = m;
    }
  }
  return {
    zone: z, key, minor, bright: minor ? (key + 3) % 12 : key, // bright = relative major (for SFX)
    st: def.st, swing: def.swing || 0, bassRoot, pad, arp, melNote, melLen, melFrom,
  };
}

// SFX bookkeeping tables.
const MIN_GAP = { hover: 0.06, click: 0.03, coin: 0.03, whoosh: 0.16, land: 0.08, jump: 0.06, countdown: 0.2, oof: 0.2, boost: 0.12, jumppad: 0.1, zone: 0.5 };
const LOW_PRIO = { hover: 1, whoosh: 1, land: 1, click: 1, coin: 1 };
const COIN_STEPS = [0, 2, 4, 5, 7, 9, 11, 12];
const TRICK_ARP = [0, 4, 7, 12, 16, 19];
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16];
const MAJ_ARP = [0, 4, 7, 12];
const EMPTY = {};

// ---------------------------------------------------------------------------------------------
export function createAudio() {
  const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : undefined;

  let ctx = null, ready = false, failed = !AC, primed = false, muted = false, hiddenSuspended = false;
  // Intent survives calls made before unlock().
  let musicWanted = false, musicOn = false;
  let targetZone = 0, pendingSong = null;
  let intensityTarget = 0, intensity = 0;
  // Sequencer state
  let song = null, step = 0, bar = 0, nextTime = 0, lastTick = 0, crashNext = false, phrases = 0, switchHold = 0;
  let lI = 0, lHat8 = false, lArp = false, lLead = false, lHi = false, lTop = false;
  // Graph
  let master, sfxBus, sfxWet, reverbIn, musicRev, musicMix, musicFade, musicDuck, drumBus, drumWet, hatFilt, snareFilt;
  let duckUntil = 0, duckLvl = 1;
  let bassBus, leadIn, arpIn, padPump, padLevel, engineBus, tickSrc;
  const padOsc = [];
  let noiseBuf = null, clickBuf = null, waves = null;
  let pMusicCut, pLeadCut, pArpCut, pPadCut, pLeadSend, pArpSend, E;
  // SFX state
  let activeSfx = 0, coinCombo = 0, lastCoinT = -9;
  const lastPlay = Object.create(null);
  let engineLive = false, lastEngineCall = -1e9, tickLoopEnd = 0.1;

  const onSfxEnded = () => { if (activeSfx > 0) activeSfx--; };
  const track = (node) => { activeSfx++; node.onended = onSfxEnded; return node; };

  // ------------------------------------------------------------------ node helpers
  function gainN(v, dest) {
    const g = ctx.createGain();
    g.gain.value = v;
    if (dest) g.connect(dest);
    return g;
  }
  function biquad(type, f, q, dest) {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    if (dest) b.connect(dest);
    return b;
  }
  function panner(p, dest) {
    let n;
    if (ctx.createStereoPanner) { n = ctx.createStereoPanner(); n.pan.value = p; } else n = ctx.createGain();
    if (dest) n.connect(dest);
    return n;
  }
  function setWave(o, w) {
    if (w === 'p12' || w === 'p25' || w === 'soft') o.setPeriodicWave(waves[w]);
    else o.type = w === 'p50' ? 'square' : w;
  }
  function osc(w, f, t, end, dest) {
    const o = ctx.createOscillator();
    setWave(o, w);
    o.frequency.setValueAtTime(f, t);
    if (dest) o.connect(dest);
    o.start(t);
    o.stop(end);
    return o;
  }
  // Gain with a linear attack and exponential decay to silence by t+a+d.
  function env(t, peak, a, d, dest) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    if (dest) g.connect(dest);
    return g;
  }
  function noiseAt(t, end, dest) {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuf;
    n.loop = true;
    if (dest) n.connect(dest);
    n.start(t, Math.random() * 1.2);
    n.stop(end);
    return n;
  }
  const noiseHit = (t, vol, a, d, dest) => noiseAt(t, t + a + d + 0.03, env(t, vol, a, d, dest));
  // Smoothed parameter handle: only touches the AudioParam when the target really moved.
  const handle = (p) => ({ p, v: p.value });
  function drive(h, v, tc) {
    if (Math.abs(v - h.v) <= 0.004 * Math.abs(h.v) + 1e-5) return;
    h.v = v;
    h.p.setTargetAtTime(v, ctx.currentTime, tc);
  }
  function setAt(h, v, t, tc) { h.v = v; h.p.setTargetAtTime(v, t, tc); }
  // Smallest MIDI note >= lo with pitch class pc.
  const above = (pc, lo) => lo + ((pc - (lo % 12) + 24) % 12);

  // ------------------------------------------------------------------ build (once, on unlock)
  function pulseWave(duty) {
    const N = 48, re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 1; n < N; n++) {
      re[n] = Math.sin(2 * Math.PI * n * duty) / (n * Math.PI);
      im[n] = (1 - Math.cos(2 * Math.PI * n * duty)) / (n * Math.PI);
    }
    return ctx.createPeriodicWave(re, im);
  }
  function sineSeries(amps) {
    const re = new Float32Array(amps.length), im = Float32Array.from(amps);
    return ctx.createPeriodicWave(re, im);
  }
  function makeIR(sec) {
    const sr = ctx.sampleRate, n = Math.floor(sr * sec), b = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const x = i / n;
        lp += (Math.random() * 2 - 1 - lp) * (0.6 - 0.45 * x); // tail gets darker
        d[i] = lp * Math.pow(1 - x, 2.4) * (i < sr * 0.01 ? i / (sr * 0.01) : 1);
      }
    }
    return b;
  }

  function build() {
    const sr = ctx.sampleRate;
    noiseBuf = ctx.createBuffer(1, Math.floor(sr * 1.5), sr);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    // Freewheel pawl click (looped with a variable loopEnd for the tick rate).
    clickBuf = ctx.createBuffer(1, Math.floor(sr * 0.3), sr);
    const cd = clickBuf.getChannelData(0), cn = Math.floor(sr * 0.006);
    for (let i = 0; i < cn; i++) {
      const e = Math.exp(-i / (sr * 0.0011));
      cd[i] = (Math.sin((i / sr) * 2 * Math.PI * 3300) * 0.7 + (Math.random() * 2 - 1) * 0.5) * e;
    }
    waves = { p12: pulseWave(0.125), p25: pulseWave(0.25), soft: sineSeries([0, 1, 0.3, 0.12, 0.05, 0.03]) };

    // Master: buses → master gain (mute) → compressor/limiter → speakers.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 8;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;
    comp.connect(ctx.destination);
    master = gainN(muted ? 0 : MASTER_LVL, comp);

    const conv = ctx.createConvolver();
    conv.buffer = makeIR(2.0);
    conv.connect(gainN(0.5, master));
    reverbIn = gainN(1, conv);

    sfxBus = gainN(0.8, master);
    sfxWet = gainN(1, sfxBus); // SFX that also feed the reverb
    sfxWet.connect(gainN(0.45, reverbIn));

    // Music: parts → musicMix → intensity lowpass → fade (start/stop) → duck (big SFX) → level → master.
    const musicVol = gainN(0.5, master);
    musicDuck = gainN(1, musicVol);
    musicFade = gainN(0, musicDuck);
    const musicFilter = biquad('lowpass', 4000, 0.5, musicFade);
    musicMix = gainN(1, musicFilter);
    musicRev = gainN(0, reverbIn); // music reverb sends, faded with the music
    pMusicCut = handle(musicFilter.frequency);

    drumBus = gainN(0.9, musicMix);
    drumWet = gainN(0.3, musicRev);
    hatFilt = biquad('highpass', 7200, 0.5, panner(0.2, drumBus));
    snareFilt = biquad('bandpass', 1900, 0.65, drumBus);
    snareFilt.connect(drumWet);
    bassBus = gainN(1, musicMix);

    // Dotted-8th feedback delay shared by lead and arp.
    const delay = ctx.createDelay(1);
    delay.delayTime.value = S16 * 3;
    const dFilt = biquad('lowpass', 2600, 0.5, null);
    delay.connect(dFilt);
    dFilt.connect(gainN(0.34, delay));
    dFilt.connect(gainN(0.55, panner(-0.3, musicMix)));

    const leadFilt = biquad('lowpass', 5000, 0.7, musicMix);
    leadIn = gainN(1, leadFilt);
    const leadSend = gainN(0.2, delay);
    leadFilt.connect(leadSend);
    leadFilt.connect(gainN(0.22, musicRev));
    pLeadCut = handle(leadFilt.frequency);
    pLeadSend = handle(leadSend.gain);

    const arpPan = panner(0, musicMix);
    const arpFilt = biquad('lowpass', 4000, 0.8, arpPan);
    arpIn = gainN(1, arpFilt);
    const arpSend = gainN(0.16, delay);
    arpFilt.connect(arpSend);
    arpFilt.connect(gainN(0.15, musicRev));
    pArpCut = handle(arpFilt.frequency);
    pArpSend = handle(arpSend.gain);
    if (arpPan.pan) { // slow auto-pan for width
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.17;
      lfo.connect(gainN(0.4, arpPan.pan));
      lfo.start();
    }

    // Persistent pad: 3 voices × 2 detuned oscillators; chord changes glide per bar,
    // padPump gives the synthwave side-chain duck on each kick.
    padLevel = gainN(0, musicMix);
    padLevel.connect(gainN(0.35, musicRev));
    padPump = gainN(1, padLevel);
    const padFilt = biquad('lowpass', 2000, 0.6, padPump);
    pPadCut = handle(padFilt.frequency);
    for (let i = 0; i < 6; i++) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 220;
      o.detune.value = i & 1 ? 7 : -7;
      o.connect(padFilt);
      o.start();
      padOsc.push(o);
    }

    buildEngine();
    song = composeSong(targetZone);
    applySongParams(ctx.currentTime);
  }

  // Engine / wind / tyres: one shared looping noise source feeding several filters.
  function buildEngine() {
    engineBus = gainN(0, sfxBus);
    const n = ctx.createBufferSource();
    n.buffer = noiseBuf;
    n.loop = true;
    const windF = biquad('bandpass', 600, 0.8, null), windG = gainN(0, engineBus);
    const tireF = biquad('lowpass', 400, 0.7, null), tireG = gainN(0, engineBus);
    const rumF = biquad('lowpass', 250, 1.4, null), rumAM = gainN(0.55, null), rumG = gainN(0, engineBus);
    windF.connect(windG);
    tireF.connect(tireG);
    rumF.connect(rumAM);
    rumAM.connect(rumG);
    n.connect(windF);
    n.connect(tireF);
    n.connect(rumF);
    n.start();
    // Kick-scooter stud rattle: amplitude-modulate the rumble at a speed-dependent rate.
    const rumLfo = ctx.createOscillator();
    rumLfo.type = 'triangle';
    rumLfo.frequency.value = 20;
    rumLfo.connect(gainN(0.45, rumAM.gain));
    rumLfo.start();
    // Bike freewheel ticks.
    tickSrc = ctx.createBufferSource();
    tickSrc.buffer = clickBuf;
    tickSrc.loop = true;
    tickSrc.loopStart = 0;
    tickSrc.loopEnd = tickLoopEnd;
    const tickG = gainN(0, engineBus);
    tickSrc.connect(biquad('highpass', 900, 0.7, tickG));
    tickSrc.start();
    // Electric motor: saw + detuned 2nd harmonic through a resonant lowpass, plus a pure whine.
    const motorG = gainN(0, engineBus);
    const motorF = biquad('lowpass', 600, 2.5, motorG);
    const m1 = ctx.createOscillator(), m2 = ctx.createOscillator(), m3 = ctx.createOscillator();
    m1.type = 'sawtooth';
    m2.type = 'triangle';
    m1.frequency.value = 60;
    m2.frequency.value = 120;
    m3.frequency.value = 360;
    m1.connect(motorF);
    m2.connect(gainN(0.6, motorF));
    m3.connect(gainN(0.16, motorG));
    m1.start(); m2.start(); m3.start();
    E = {
      windG: handle(windG.gain), windF: handle(windF.frequency),
      tireG: handle(tireG.gain), tireF: handle(tireF.frequency),
      rumG: handle(rumG.gain), rumF: handle(rumF.frequency), rumRate: handle(rumLfo.frequency),
      tickG: handle(tickG.gain),
      motorG: handle(motorG.gain), motorF: handle(motorF.frequency),
      m1: handle(m1.frequency), m2: handle(m2.frequency), m3: handle(m3.frequency),
    };
  }

  // ------------------------------------------------------------------ music sequencer
  function applySongParams(t) {
    const st = song.st;
    setAt(pLeadCut, st.leadCut, t, 0.05);
    setAt(pArpCut, st.arpCut, t, 0.05);
    setAt(pPadCut, st.padCut, t, 0.2);
    setAt(pLeadSend, st.delay, t, 0.05);
    setAt(pArpSend, st.delay * 0.8, t, 0.05);
    const w = st.pad;
    setTimeout(() => { for (let i = 0; i < 6; i++) padOsc[i].type = w; }, Math.max(0, (t - ctx.currentTime) * 1000));
  }

  function beginMusic() {
    musicOn = true;
    const now = ctx.currentTime;
    if (pendingSong) { song = pendingSong; pendingSong = null; applySongParams(now); }
    step = 0; bar = 0; phrases = 0; crashNext = false; switchHold = 0;
    nextTime = now + 0.08;
    lastTick = now;
    intensity = intensityTarget;
    padLevel.gain.setTargetAtTime(0, now, 0.01);
    musicFade.gain.setTargetAtTime(1, now, 0.06);
    musicRev.gain.setTargetAtTime(1, now, 0.06);
  }

  function barStart(t) {
    if (pendingSong && switchHold > 0) switchHold--; // zone riser asked for one more bar
    else if (pendingSong) { // zone change lands on the downbeat
      song = pendingSong;
      pendingSong = null;
      applySongParams(t);
      bar = 0;
      crashNext = true;
    }
    if (bar === 0) phrases++;
    const I = (lI = intensity);
    lHat8 = I >= 0.2; lArp = I >= 0.35; lLead = I >= 0.5; lHi = I >= 0.7; lTop = I >= 0.86;
    const st = song.st, c = bar & 3;
    for (let v = 0; v < 3; v++) {
      const f = MTOF[song.pad[c * 3 + v]];
      padOsc[v * 2].frequency.setTargetAtTime(f, t, 0.012);
      padOsc[v * 2 + 1].frequency.setTargetAtTime(f, t, 0.012);
    }
    padLevel.gain.setTargetAtTime(st.padVol * (1.25 - 0.45 * I), t, 0.25);
    if (!muted && (crashNext || (bar === 0 && I >= 0.5 && phrases > 1))) crash(t, crashNext ? 1 : 0.7);
    crashNext = false;
  }

  function scheduleStep(t) {
    const s = step;
    if (s === 0) barStart(t);
    if (muted) return; // keep time, skip node creation
    const sg = song, st = sg.st, c = bar & 3;
    const onBeat = (s & 3) === 0;

    // Drums
    if ((lHi ? st.kick.hi : st.kick.lo)[s]) {
      kick(t, lHi ? 0.56 : 0.5);
      if (st.pump) pump(t, st.pump);
    }
    const fill = s >= 12 && ((bar === 7 && lI >= 0.45) || (pendingSong !== null && switchHold === 0));
    if (fill) snare(t, 0.4 + (s - 12) * 0.15); // 16th-note snare roll into the next phrase/zone
    else if (SNARE[s]) snare(t, lHi ? 0.85 : 0.72);
    if (lHi) {
      const open = lTop && st.openHat && (s & 3) === 2;
      hat(t, (s & 3) === 2 ? 0.8 : s & 1 ? 0.3 + Math.random() * 0.08 : 0.5, open);
    } else if (lHat8 && !(s & 1)) hat(t, (s & 3) === 2 ? 0.75 : 0.42, false);

    // Bass
    const bp = lHi && st.bassHi ? BASS[st.bassHi] : BASS[st.bassPat];
    const bo = bp.off[s];
    if (bo !== NONE) bass(t, sg.bassRoot[c] + bo, bp.len[s] * S16 * 0.85, onBeat ? 1 : 0.82);

    // Arp
    if (lArp && s % st.arpRate === 0) {
      const p = st.arpPat;
      arpNote(t, sg.arp[c * 6 + p[((s / st.arpRate) | 0) % p.length]], onBeat ? 1 : 0.7);
    }

    // Lead melody
    if (lLead) {
      const idx = bar * 16 + s, m = sg.melNote[idx];
      if (m) leadNote(t, m, sg.melLen[idx] * S16 * 0.92, sg.melFrom[idx], lTop);
    }
  }

  function tick() {
    if (!ctx) return;
    try {
      // Watchdog: if the game stops feeding setEngine (pause, menus), fade engine + wind out.
      const live = nowMs() - lastEngineCall < 300;
      if (live !== engineLive) {
        engineLive = live;
        engineBus.gain.setTargetAtTime(live ? 1 : 0, ctx.currentTime, live ? 0.03 : 0.15);
      }
      if (ctx.state !== 'running') return;
      const now = ctx.currentTime;
      const dt = Math.min(0.5, Math.max(0, now - lastTick));
      lastTick = now;
      // Rise quickly, fall slowly, so brief slow-downs don't strip the arrangement.
      const tc = intensityTarget > intensity ? 0.8 : 3;
      intensity += (intensityTarget - intensity) * (1 - Math.exp(-dt / tc));
      if (!musicOn) return;
      drive(pMusicCut, 2400 * Math.pow(7.5, intensity), 0.25);
      if (nextTime < now - 0.08) nextTime = now + 0.03; // recover after a stall
      while (nextTime < now + LOOKAHEAD) {
        scheduleStep(nextTime + (step & 1 ? song.swing * S16 : 0));
        nextTime += S16;
        if (++step === 16) { step = 0; bar = (bar + 1) & 7; }
      }
    } catch (e) { /* audio must never break the game */ }
  }

  // ------------------------------------------------------------------ music voices
  function kick(t, v) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(260, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.11);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.36);
    o.connect(g);
    g.connect(drumBus);
    o.start(t);
    o.stop(t + 0.38);
  }
  function snare(t, v) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(v * 1.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
    g.connect(snareFilt);
    noiseAt(t, t + 0.28, g);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(v * 0.5, t);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    bg.connect(drumBus);
    const o = osc('triangle', 210, t, t + 0.14, bg);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
  }
  function hat(t, v, open) {
    const d = open ? 0.24 : 0.075, g = ctx.createGain();
    g.gain.setValueAtTime(v * 0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    g.connect(hatFilt);
    noiseAt(t, t + d + 0.02, g);
  }
  function crash(t, v) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(v * 0.26, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
    g.connect(hatFilt);
    g.connect(drumWet);
    noiseAt(t, t + 1.65, g);
  }
  function pump(t, depth) {
    padPump.gain.setTargetAtTime(1 - depth, t, 0.004);
    padPump.gain.setTargetAtTime(1, t + 0.05, 0.09);
  }
  function bass(t, m, dur, v) {
    const st = song.st, vol = st.bassVol * v;
    const o = ctx.createOscillator();
    setWave(o, st.bass);
    o.frequency.setValueAtTime(MTOF[m], t);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 3;
    f.frequency.setValueAtTime(st.bassCut * 3, t);
    f.frequency.setTargetAtTime(st.bassCut, t + 0.002, 0.05); // pluck
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.006);
    g.gain.setTargetAtTime(vol * 0.75, t + 0.02, 0.1);
    g.gain.setTargetAtTime(0.0001, t + dur, 0.025);
    o.connect(f);
    f.connect(g);
    g.connect(bassBus);
    o.start(t);
    o.stop(t + dur + 0.15);
  }
  function arpNote(t, m, v) {
    const st = song.st, g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(st.arpVol * v, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + st.arpDecay);
    g.connect(arpIn);
    osc(st.arp, MTOF[m], t, t + st.arpDecay + 0.01, g);
  }
  function leadOsc(w, f, t, end, dest, fromF, glide, detune) {
    const o = ctx.createOscillator();
    setWave(o, w);
    if (detune) o.detune.value = detune;
    if (glide && fromF) {
      o.frequency.setValueAtTime(fromF, t);
      o.frequency.exponentialRampToValueAtTime(f, t + glide);
    } else o.frequency.setValueAtTime(f, t);
    o.connect(dest);
    o.start(t);
    o.stop(end);
    return o;
  }
  function leadNote(t, m, dur, from, dbl) {
    const st = song.st, f = MTOF[m], end = t + dur + 0.2, v = st.leadVol;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v, t + 0.012);
    g.gain.setTargetAtTime(v * 0.72, t + 0.03, 0.15);
    g.gain.setTargetAtTime(0.0001, t + dur, 0.035);
    g.connect(leadIn);
    const saw2 = st.lead === 'saw2', fromF = from ? MTOF[from] : 0;
    const o1 = leadOsc(saw2 ? 'sawtooth' : st.lead, f, t, end, g, fromF, st.glide, saw2 ? -9 : 0);
    const o2 = saw2 ? leadOsc('sawtooth', f, t, end, g, fromF, st.glide, 9) : null;
    if (dur > 0.38 && st.vib) { // delayed vibrato on long notes
      const lfo = ctx.createOscillator(), vg = ctx.createGain();
      lfo.frequency.value = 5.6;
      vg.gain.setValueAtTime(0, t);
      vg.gain.linearRampToValueAtTime(0, t + 0.16);
      vg.gain.linearRampToValueAtTime(st.vib, t + 0.45);
      lfo.connect(vg);
      vg.connect(o1.detune);
      if (o2) vg.connect(o2.detune);
      lfo.start(t);
      lfo.stop(end);
    }
    if (dbl) leadOsc(st.dbl, f * 2, t, end, gainN(0.22, g), fromF * 2, st.glide, 0);
  }

  // ------------------------------------------------------------------ SFX voices
  // Side-chain style music dip so fanfares / the oof / zone riser cut through, then swell back.
  // A lighter duck never shortens a deeper one that is still active.
  function duck(t, depth, hold, rel) {
    if (t < duckUntil && depth >= duckLvl) return;
    const p = musicDuck.gain;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(depth, t, 0.04);
    p.setTargetAtTime(1, t + hold, rel || 0.4);
    duckUntil = t + hold;
    duckLvl = depth;
  }
  function bell(t, m, vol, dur, dest) {
    const f = MTOF[m];
    osc('sine', f * 2.005, t, t + dur * 0.5 + 0.05, env(t, vol * 0.3, 0.002, dur * 0.45, dest));
    osc('sine', f * 3.01, t, t + dur * 0.25 + 0.05, env(t, vol * 0.1, 0.001, dur * 0.2, dest));
    return osc('sine', f, t, t + dur + 0.05, env(t, vol, 0.002, dur, dest));
  }
  function brass(t, m, dur, vol, dest) {
    const f = MTOF[m], end = t + dur + 0.45;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.025);
    g.gain.setTargetAtTime(vol * 0.75, t + 0.05, 0.2);
    g.gain.setTargetAtTime(0.0001, t + dur, 0.07);
    g.connect(dest);
    const lp = biquad('lowpass', 400, 1.5, g);
    lp.frequency.setValueAtTime(400, t);
    lp.frequency.linearRampToValueAtTime(3400, t + 0.05);
    lp.frequency.setTargetAtTime(1500, t + 0.06, 0.15);
    const a = osc('sawtooth', f, t, end, lp);
    a.detune.value = -6;
    const b = osc('sawtooth', f, t, end, lp);
    b.detune.value = 6;
    return b;
  }
  function sparkle(t, vol, dur, dest) {
    const hp = biquad('highpass', 6500, 0.7, dest);
    return noiseHit(t, vol, 0.04, dur, hp);
  }

  function sJump(t) {
    const o = osc('triangle', 300, t, t + 0.22, env(t, 0.3, 0.004, 0.18, sfxBus));
    o.frequency.exponentialRampToValueAtTime(820, t + 0.09);
    const o2 = osc('p25', 600, t, t + 0.15, env(t, 0.06, 0.004, 0.12, sfxBus));
    o2.frequency.exponentialRampToValueAtTime(1640, t + 0.09);
    noiseHit(t, 0.06, 0.005, 0.09, biquad('highpass', 2200, 0.7, sfxBus));
    track(o);
  }
  function sLand(t, o) {
    const i = clamp01(o.intensity == null ? 0.5 : +o.intensity || 0);
    const k = osc('sine', 140 + 40 * i, t, t + 0.35, env(t, 0.15 + 0.27 * i, 0.003, 0.16 + 0.12 * i, sfxBus));
    k.frequency.exponentialRampToValueAtTime(40, t + 0.15);
    noiseHit(t, 0.07 + 0.18 * i, 0.002, 0.07 + 0.1 * i, biquad('lowpass', 600 + 1800 * i, 0.7, sfxBus));
    if (i > 0.55) noiseHit(t, 0.09 * i, 0.001, 0.045, biquad('bandpass', 2600, 1.2, sfxBus));
    track(k);
  }
  function sBoost(t) {
    const bp = biquad('bandpass', 350, 1.3, sfxBus);
    bp.frequency.setValueAtTime(350, t);
    bp.frequency.exponentialRampToValueAtTime(3400, t + 0.32);
    bp.frequency.exponentialRampToValueAtTime(1200, t + 0.75);
    const n = noiseHit(t, 0.45, 0.05, 0.7, bp);
    const lp = biquad('lowpass', 500, 5, sfxBus);
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.exponentialRampToValueAtTime(4200, t + 0.28);
    lp.frequency.exponentialRampToValueAtTime(900, t + 0.6);
    const g = env(t, 0.1, 0.02, 0.5, lp);
    osc('sawtooth', 98, t, t + 0.6, g).frequency.exponentialRampToValueAtTime(392, t + 0.28);
    const b = osc('sawtooth', 147, t, t + 0.6, g);
    b.detune.value = 8;
    b.frequency.exponentialRampToValueAtTime(588, t + 0.28);
    osc('sine', 90, t, t + 0.25, env(t, 0.35, 0.004, 0.2, sfxBus)).frequency.exponentialRampToValueAtTime(45, t + 0.2);
    track(n);
  }
  function sJumppad(t) {
    // Spring "boing": fast pitch rise, then a decaying wobble on the frequency.
    const g = env(t, 0.3, 0.004, 0.55, sfxBus);
    const o = osc('triangle', 150, t, t + 0.62, g);
    o.frequency.exponentialRampToValueAtTime(480, t + 0.08);
    const o2 = osc('sine', 300, t, t + 0.62, gainN(0.5, g));
    o2.frequency.exponentialRampToValueAtTime(960, t + 0.08);
    const wob = ctx.createGain();
    wob.gain.setValueAtTime(110, t);
    wob.gain.exponentialRampToValueAtTime(3, t + 0.55);
    wob.connect(o.frequency);
    wob.connect(gainN(2, o2.frequency));
    osc('sine', 15, t, t + 0.62, wob);
    noiseHit(t, 0.18, 0.001, 0.04, biquad('lowpass', 1500, 0.8, sfxBus));
    track(o);
  }
  function sCheckpoint(t) {
    const b = above(song.bright, 72);
    let last = null;
    for (let i = 0; i < 4; i++) last = bell(t + i * 0.065, b + MAJ_ARP[i], 0.14, i === 3 ? 1.1 : 0.5, sfxWet);
    bell(t + 0.2, b + 16, 0.05, 1.0, sfxWet);
    sparkle(t + 0.05, 0.035, 0.4, sfxWet);
    track(last);
  }
  function sCoin(t) {
    // Rapid coins climb the scale (combo).
    coinCombo = t - lastCoinT < 0.8 ? Math.min(coinCombo + 1, COIN_STEPS.length - 1) : 0;
    lastCoinT = t;
    const m = above(song.bright, 71) + COIN_STEPS[coinCombo], t2 = t + 0.065;
    osc('p25', MTOF[m], t, t + 0.1, env(t, 0.17, 0.002, 0.09, sfxWet));
    const o = osc('p25', MTOF[m + 5], t2, t2 + 0.6, env(t2, 0.18, 0.002, 0.55, sfxWet));
    osc('sine', MTOF[m + 17], t2, t2 + 0.55, env(t2, 0.09, 0.002, 0.5, sfxWet));
    track(o);
  }
  function sTrick(t, o) {
    const L = Math.max(1, Math.min(4, Math.round(+o.level || 1)));
    const base = above(song.bright, 64), n = L + 2, dt = 0.07 - L * 0.006;
    let last = null;
    for (let i = 0; i < n; i++) {
      const tt = t + i * dt, m = base + TRICK_ARP[i], fin = i === n - 1;
      last = osc('p25', MTOF[m], tt, tt + (fin ? 0.85 : 0.18), env(tt, fin ? 0.12 : 0.095, 0.003, fin ? 0.8 : 0.16, sfxWet));
      if (fin) {
        osc('soft', MTOF[base + TRICK_ARP[i - 1]], tt, tt + 0.8, env(tt, 0.09, 0.003, 0.75, sfxWet));
        osc('triangle', MTOF[base - 12], tt, tt + 0.8, env(tt, 0.12, 0.003, 0.75, sfxWet));
        if (L >= 3) bell(tt + 0.04, m + 12, 0.05, 0.7, sfxWet);
        if (L >= 4) { sparkle(tt, 0.06, 0.6, sfxWet); bell(tt + 0.1, m + 19, 0.035, 0.8, sfxWet); }
      }
    }
    track(last);
  }
  function sTrickFail(t) {
    const g = env(t, 0.15, 0.01, 0.5, biquad('lowpass', 1100, 3, sfxBus));
    const a = osc('sawtooth', 330, t, t + 0.55, g);
    a.frequency.exponentialRampToValueAtTime(175, t + 0.5);
    const b = osc('square', 331, t, t + 0.55, gainN(0.4, g));
    b.frequency.exponentialRampToValueAtTime(176, t + 0.5);
    const wob = gainN(22, a.frequency);
    wob.connect(b.frequency);
    osc('sine', 9, t, t + 0.55, wob);
    osc('sine', 220, t, t + 0.15, env(t, 0.22, 0.002, 0.12, sfxBus)).frequency.exponentialRampToValueAtTime(110, t + 0.1);
    track(a);
  }
  function sOof(t) {
    // Roblox-style "oof": buzzy glottal source through 3 parallel formant bandpasses for an
    // "oo/ʊ" vowel, pitch rising briefly then falling ~188 → 108 Hz, short breathy "f" tail. ~0.28 s.
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.linearRampToValueAtTime(0.5, t + 0.018);
    out.gain.setValueAtTime(0.5, t + 0.1);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    out.connect(sfxBus);
    const src = ctx.createGain();
    const end = t + 0.3;
    const a = osc('sawtooth', 172, t, end, src);
    a.frequency.linearRampToValueAtTime(188, t + 0.035);
    a.frequency.exponentialRampToValueAtTime(108, t + 0.27);
    const b = osc('square', 173, t, end, gainN(0.3, src));
    b.frequency.linearRampToValueAtTime(189, t + 0.035);
    b.frequency.exponentialRampToValueAtTime(108.6, t + 0.27);
    noiseAt(t, end, gainN(0.08, src)); // breathiness
    const F = [[430, 330, 6, 2.8], [980, 780, 9, 1.5], [2400, 2250, 12, 0.6]];
    for (let i = 0; i < 3; i++) {
      const bp = biquad('bandpass', F[i][0], F[i][2], gainN(F[i][3], out));
      bp.frequency.setValueAtTime(F[i][0], t);
      bp.frequency.linearRampToValueAtTime(F[i][1], t + 0.24);
      src.connect(bp);
    }
    src.connect(biquad('lowpass', 380, 0.7, gainN(0.35, out))); // chest body
    noiseHit(t + 0.15, 0.035, 0.03, 0.12, biquad('highpass', 1800, 0.7, sfxBus));
    if (musicOn) duck(t, 0.5, 0.45);
    track(a);
  }
  function sRespawn(t) {
    const base = above(song.bright, 72);
    let last = null;
    for (let i = 0; i < 8; i++) {
      const tt = t + i * 0.042;
      last = osc('soft', MTOF[base + PENTA[i]], tt, tt + 0.4, env(tt, 0.075 + i * 0.008, 0.004, 0.35, sfxWet));
    }
    const bp = biquad('bandpass', 1500, 1, sfxWet);
    bp.frequency.setValueAtTime(1500, t);
    bp.frequency.exponentialRampToValueAtTime(8000, t + 0.42);
    noiseHit(t, 0.1, 0.25, 0.25, bp);
    track(last);
  }
  function sRecord(t) {
    const b = above(song.bright, 60), d = gainN(0.8, sfxWet);
    for (let i = 0; i < 3; i++) brass(t + i * 0.1, b + 7, 0.07, 0.11, d); // pickup triplet
    const t1 = t + 0.32;
    brass(t1, b + 12, 0.5, 0.12, d); brass(t1, b + 7, 0.5, 0.08, d); brass(t1, b + 4, 0.5, 0.08, d); brass(t1, b - 12, 0.5, 0.1, d);
    const t2 = t1 + 0.56;
    brass(t2, b + 14, 0.11, 0.11, d); brass(t2, b + 9, 0.11, 0.07, d);
    brass(t2 + 0.13, b + 16, 0.11, 0.11, d); brass(t2 + 0.13, b + 11, 0.11, 0.07, d);
    const t3 = t2 + 0.27;
    const last = brass(t3, b + 19, 1.1, 0.13, d);
    brass(t3, b + 16, 1.1, 0.08, d); brass(t3, b + 12, 1.1, 0.08, d); brass(t3, b, 1.1, 0.1, d); brass(t3, b - 12, 1.1, 0.09, d);
    sparkle(t3, 0.1, 1.2, d);
    osc('sine', 110, t3, t3 + 0.4, env(t3, 0.3, 0.004, 0.3, sfxBus)).frequency.exponentialRampToValueAtTime(45, t3 + 0.3);
    for (let i = 0; i < 4; i++) bell(t3 + 0.12 + i * 0.07, b + 24 + MAJ_ARP[i], 0.05, 0.8, d);
    if (musicOn) duck(t, 0.32, 2.1);
    track(last);
  }
  function sCountdown(t) {
    const g = env(t, 0.22, 0.004, 0.3, biquad('lowpass', 3200, 0.7, sfxBus));
    const o = osc('square', MTOF[74], t, t + 0.32, g);
    osc('sine', MTOF[86], t, t + 0.28, env(t, 0.08, 0.004, 0.25, sfxBus));
    track(o);
  }
  function sGo(t) {
    const lp = biquad('lowpass', 4200, 0.7, sfxWet);
    let last = null;
    const notes = [86, 90, 93];
    for (let i = 0; i < 3; i++) last = osc('square', MTOF[notes[i]], t, t + 0.85, env(t, i ? 0.07 : 0.11, 0.005, 0.8, lp));
    osc('sine', MTOF[74], t, t + 0.7, env(t, 0.14, 0.005, 0.65, sfxBus));
    sparkle(t, 0.05, 0.45, sfxWet);
    track(last);
  }
  function sClick(t) {
    const o = osc('triangle', 1250, t, t + 0.07, env(t, 0.2, 0.001, 0.05, sfxBus));
    o.frequency.exponentialRampToValueAtTime(620, t + 0.05);
    noiseHit(t, 0.05, 0.001, 0.015, biquad('highpass', 3500, 0.7, sfxBus));
    track(o);
  }
  function sHover(t) {
    track(osc('sine', 1760, t, t + 0.05, env(t, 0.045, 0.002, 0.035, sfxBus)));
  }
  function sGameover(t) {
    // Sad-trombone descent: wah filter per note, vibrato on the last.
    const b = above(song.key, 52) + 7, durs = [0.3, 0.3, 0.3, 1.1];
    let tt = t, last = null;
    for (let i = 0; i < 4; i++) {
      const dur = durs[i], f = MTOF[b - i], end = tt + dur + 0.3;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.linearRampToValueAtTime(0.12, tt + 0.03);
      g.gain.setTargetAtTime(0.0001, tt + dur - 0.04, 0.06);
      g.connect(sfxWet);
      const lp = biquad('lowpass', 350, 3, g);
      lp.frequency.setValueAtTime(350, tt);
      lp.frequency.linearRampToValueAtTime(1500, tt + 0.08);
      lp.frequency.setTargetAtTime(550, tt + 0.1, 0.12);
      const a = osc('sawtooth', f, tt, end, lp), c = osc('sawtooth', f, tt, end, lp);
      a.detune.value = -7;
      c.detune.value = 7;
      if (i === 3) {
        const vg = ctx.createGain();
        vg.gain.setValueAtTime(0, tt);
        vg.gain.linearRampToValueAtTime(45, tt + 0.6);
        vg.connect(a.detune);
        vg.connect(c.detune);
        osc('sine', 5.5, tt, end, vg);
      }
      last = a;
      tt += dur + 0.04;
    }
    if (musicOn) duck(t, 0.25, 2.3);
    track(last);
  }
  function sWhoosh(t) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    const pan = panner(-0.7 * dir, sfxBus);
    if (pan.pan) {
      pan.pan.setValueAtTime(-0.7 * dir, t);
      pan.pan.linearRampToValueAtTime(0.7 * dir, t + 0.42);
    }
    const bp = biquad('bandpass', 600, 1.8, pan);
    bp.frequency.setValueAtTime(600, t);
    bp.frequency.exponentialRampToValueAtTime(2400, t + 0.17);
    bp.frequency.exponentialRampToValueAtTime(800, t + 0.45);
    track(noiseHit(t, 0.55, 0.14, 0.32, bp));
  }
  function sZone(t) {
    // Riser into an arrival sparkle in the incoming zone's key. When a zone song is pending, the
    // riser is stretched to land exactly on the downbeat where the new groove (and crash) kicks in;
    // if that downbeat is too close, the switch is held back one bar.
    let T = 1.05;
    const sg = pendingSong || song;
    if (musicOn && pendingSong) {
      let toBar = nextTime + ((16 - step) & 15) * S16 - t;
      if (toBar < 0.75) { switchHold = 1; toBar += 16 * S16; }
      T = Math.max(0.4, toBar);
    }
    const bp = biquad('bandpass', 300, 2.5, sfxWet);
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(6500, t + T);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.002, t);
    ng.gain.exponentialRampToValueAtTime(0.25, t + T);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + T + 0.15);
    ng.connect(bp);
    noiseAt(t, t + T + 0.2, ng);
    const lp = biquad('lowpass', 600, 4, sfxBus);
    lp.frequency.setValueAtTime(600, t);
    lp.frequency.exponentialRampToValueAtTime(5000, t + T);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.002, t);
    og.gain.exponentialRampToValueAtTime(0.07, t + T);
    og.gain.exponentialRampToValueAtTime(0.0001, t + T + 0.12);
    og.connect(lp);
    osc('sawtooth', 110, t, t + T + 0.15, og).frequency.exponentialRampToValueAtTime(880, t + T);
    osc('sawtooth', 165, t, t + T + 0.15, og).frequency.exponentialRampToValueAtTime(1320, t + T);
    const ta = t + T, b = above(sg.bright, 72);
    // Dip the old groove under the riser, snap back right on the new zone's downbeat.
    if (musicOn) duck(t + T * 0.3, 0.45, T * 0.7 - 0.03, 0.05);
    sparkle(ta, 0.09, 1.1, sfxWet);
    bell(ta, b, 0.08, 1.2, sfxWet);
    bell(ta, b + 7, 0.06, 1.2, sfxWet);
    track(bell(ta, b + 12, 0.06, 1.3, sfxWet));
  }

  const SFX = {
    jump: sJump, land: sLand, boost: sBoost, jumppad: sJumppad, checkpoint: sCheckpoint, coin: sCoin,
    trick: sTrick, trickFail: sTrickFail, oof: sOof, respawn: sRespawn, record: sRecord,
    countdown: sCountdown, go: sGo, click: sClick, hover: sHover, gameover: sGameover,
    whoosh: sWhoosh, zone: sZone,
  };

  // ------------------------------------------------------------------ lifecycle
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (!ctx) return;
      try {
        if (document.hidden) {
          if (ctx.state === 'running') {
            hiddenSuspended = true;
            const p = ctx.suspend();
            if (p && p.catch) p.catch(noop);
          }
        } else if (hiddenSuspended) {
          hiddenSuspended = false;
          const p = ctx.resume();
          if (p && p.catch) p.catch(noop);
        }
      } catch (e) { /* ignore */ }
    });
  }
  // Mobile safety net: touchstart / touch pointerdown do not grant user activation, so a context
  // created there stays suspended. Once a context exists, retry on events that do grant it.
  if (typeof window !== 'undefined' && window.addEventListener) {
    const retry = () => {
      if (ctx && !failed && ctx.state !== 'running' && !hiddenSuspended) unlock();
    };
    const o = { capture: true, passive: true };
    window.addEventListener('touchend', retry, o);
    window.addEventListener('pointerup', retry, o);
    window.addEventListener('keydown', retry, o);
  }

  function unlock() {
    if (failed) return;
    try {
      if (!ctx) {
        try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
        build();
        ready = true;
        lastTick = ctx.currentTime;
        setInterval(tick, TICK_MS);
      }
      if (ctx.state !== 'running' && ctx.state !== 'closed' && !hiddenSuspended) {
        const p = ctx.resume();
        if (p && p.catch) p.catch(noop);
      }
      // iOS: a silent buffer started inside a gesture fully unlocks output. Retried while the
      // context is not running, since the first call may come from a non-activating event.
      if (!primed || ctx.state !== 'running') {
        primed = true;
        const s = ctx.createBufferSource();
        s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        s.connect(ctx.destination);
        s.start(0);
      }
      if (musicWanted && !musicOn) beginMusic();
    } catch (e) {
      failed = true;
      ready = false;
    }
  }

  function play(name, opts) {
    if (!ready || muted || ctx.state !== 'running') return;
    const fn = SFX[name];
    if (!fn) return;
    try {
      const now = ctx.currentTime, last = lastPlay[name];
      if (last !== undefined && now - last < (MIN_GAP[name] || 0.015)) return;
      if (activeSfx >= 40 || (activeSfx >= 22 && LOW_PRIO[name])) return;
      lastPlay[name] = now;
      fn(now + 0.004, opts || EMPTY);
    } catch (e) { /* ignore */ }
  }

  function setEngine(e) {
    if (!ready || !e) return;
    lastEngineCall = nowMs();
    try {
      const s = clamp01(+e.speed01 || 0), th = clamp01(+e.throttle || 0);
      const g = !!e.grounded, b = !!e.boosting, v = e.vehicle;
      const roll = Math.min(1, s * 1.6), gnd = g ? 1 : 0;
      // Wind for everyone, louder in the air and when boosting.
      drive(E.windG, (0.01 * s + 0.11 * s * s) * (g ? 1 : 1.35) * (b ? 1.25 : 1), 0.12);
      drive(E.windF, 380 + 1500 * s + (b ? 500 : 0), 0.15);
      // Rolling tyres (bike / e-scooter).
      drive(E.tireG, gnd * roll * (v === 'bike' ? 0.1 : v === 'scooter' ? 0.05 : 0), 0.05);
      drive(E.tireF, 220 + 900 * s, 0.1);
      // Bike: freewheel ticks while coasting, rate ∝ speed.
      const coast = v === 'bike' && g && th < 0.05 && s > 0.015;
      drive(E.tickG, coast ? 0.14 * Math.min(1, s * 5) : 0, 0.03);
      if (coast) {
        const le = 1 / (5 + 55 * s);
        if (Math.abs(le - tickLoopEnd) > tickLoopEnd * 0.04) { tickLoopEnd = le; tickSrc.loopEnd = le; }
      }
      // Kick scooter: tiny hard wheels rattling over studs.
      drive(E.rumG, v === 'kick' && g ? 0.18 * roll : 0, 0.05);
      drive(E.rumF, 160 + 600 * s, 0.1);
      drive(E.rumRate, 8 + 48 * s, 0.1);
      // E-scooter motor whine, pitch ∝ speed, brighter with throttle/boost.
      const f0 = 50 + 240 * s + (b ? 45 : 0) + 15 * th;
      drive(E.m1, f0, 0.06);
      drive(E.m2, f0 * 2.003, 0.06);
      drive(E.m3, f0 * 6, 0.06);
      const on = v === 'scooter' && g && (s > 0.004 || th > 0.02);
      drive(E.motorG, on ? 0.007 + 0.015 * th + 0.016 * s + (b ? 0.012 : 0) : 0, 0.07);
      drive(E.motorF, 260 + 1500 * (0.35 * th + 0.65 * s) + (b ? 900 : 0), 0.08);
    } catch (err) { /* ignore */ }
  }

  return {
    unlock,
    setMuted(b) {
      muted = !!b;
      if (!ready) return;
      try { master.gain.setTargetAtTime(muted ? 0 : MASTER_LVL, ctx.currentTime, 0.04); } catch (e) { /* ignore */ }
    },
    isMuted() { return muted; },
    startMusic() {
      musicWanted = true;
      if (!ready || musicOn) return;
      try { beginMusic(); } catch (e) { /* ignore */ }
    },
    stopMusic() {
      musicWanted = false;
      if (!ready || !musicOn) return;
      musicOn = false;
      try {
        const now = ctx.currentTime;
        musicFade.gain.setTargetAtTime(0, now, 0.15);
        musicRev.gain.setTargetAtTime(0, now, 0.15);
      } catch (e) { /* ignore */ }
    },
    setZone(zoneIndex) {
      const z = Math.max(0, Math.floor(+zoneIndex || 0));
      if (z === targetZone) return;
      targetZone = z;
      switchHold = 0;
      if (!ready) return; // composed at build time
      try {
        const s = composeSong(z);
        if (musicOn) pendingSong = s; // switches on the next downbeat
        else { song = s; pendingSong = null; applySongParams(ctx.currentTime); }
      } catch (e) { /* ignore */ }
    },
    setMusicIntensity(x) { intensityTarget = clamp01(+x || 0); },
    setEngine,
    play,
  };
}
