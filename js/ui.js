// js/ui.js — every DOM concern of bobobike: screens, HUD, speedometer, toasts,
// banners, game-over report (with sparkline) and multi-touch controls.
// Markup + CSS live in index.html. updateHUD() runs every frame: it caches the last
// displayed (rounded) values and only touches the DOM / gauge canvas when they change.
import { CONFIG, gradeFor, MODES, MODE_ORDER } from './config.js';
import { zoneAt } from './themes.js';

// ---------------------------------------------------------------- constants
const INK = '#0b0d17';
const GRADE_COLORS = { S: '#ffc93c', A: '#46e06b', B: '#3aa0ff', C: '#ff9a3c', D: '#ff4d5e' };
const GRADE_WORDS = { S: 'INSANO!', A: 'VELOZ!', B: 'BOM RITMO', C: 'DÁ PRA MAIS', D: 'DEVAGAR...' };
const VEHICLE_ACCENTS = { bike: '#ffb703', scooter: '#3aa0ff', kick: '#ff4d8d' };
const ACCENT_CYCLE = ['#ffb703', '#3aa0ff', '#ff4d8d', '#46e06b', '#c86bff'];
const STAT_DEFS = [
  ['speed', 'Velocidade', '#ff9f1c'],
  ['accel', 'Aceleração', '#46e06b'],
  ['handling', 'Controle', '#3aa0ff'],
  ['jump', 'Pulo', '#c86bff'],
];
const TIPS = [
  'sua <b>média de velocidade</b> vira nota no fim. Busque o <b>S</b>!',
  'truques no ar (<b>Q</b> e <b>E</b>) enchem o <b>TURBO</b>.',
  'moedas e plataformas de impulso também dão turbo.',
  'caiu? Você volta no último <b>checkpoint</b>.',
  'frear derruba a média. Só freie quando precisar!',
  'cada zona muda o céu. Até onde você chega?',
];
const TOAST_KINDS = { trick: 1, good: 1, bad: 1, record: 1, info: 1 };
const DEBOUNCED = { play: 1, restart: 1, menu: 1, resume: 1, pause: 1, end: 1, fullscreen: 1 };
// Chunky infinity sign (ink outline under a colored stroke), shared by the HUD badge and the mode toggle.
const INF_PATH = 'M9 4a5 5 0 1 0 0 10c5 0 11-10 16-10a5 5 0 1 1 0 10c-5 0-11-10-16-10z';
const INF_SVG =
  '<svg class="inf-svg" viewBox="0 0 34 18" aria-hidden="true"><path d="' + INF_PATH + '" fill="none" stroke="#0b0d17" stroke-width="7" stroke-linejoin="round"/>' +
  '<path d="' + INF_PATH + '" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linejoin="round"/></svg>';
const MODE_ICONS = {
  normal: '<svg class="heart-svg" viewBox="-0.6 -0.6 8.2 7.2" aria-hidden="true"><path d="M1 0H3V1H4V0H6V1H7V3H6V4H5V5H4V6H3V5H2V4H1V3H0V1H1Z"/></svg>',
  infinite: INF_SVG,
};

// Grade bands, ascending by speed: [{ grade, lo, hi, color }]
const GRADES_DESC = CONFIG.grades.slice().sort((a, b) => b.min - a.min);
const BANDS = GRADES_DESC.map((g, i) => ({
  grade: g.grade,
  lo: g.min,
  hi: i === 0 ? Infinity : GRADES_DESC[i - 1].min,
  color: GRADE_COLORS[g.grade] || '#ffffff',
})).reverse();
const GRADE_RANK = {};
GRADES_DESC.forEach((g, i) => { GRADE_RANK[g.grade] = GRADES_DESC.length - i; });

// Speedometer geometry (CSS px). 240° arc open at the bottom.
const GW = 220, GH = 166, GCX = 110, GCY = 106, GR = 92, GLW = 16;
const GA0 = (Math.PI * 5) / 6, GSW = (Math.PI * 4) / 3;

// Blocky vehicle icons for the menu cards.
const iconSvg = (inner) =>
  `<svg viewBox="0 0 64 40" aria-hidden="true"><g fill="none" stroke="${INK}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`;
const VEHICLE_ICONS = {
  bike: iconSvg('<circle cx="14" cy="27" r="9" fill="#fff"/><circle cx="50" cy="27" r="9" fill="#fff"/><path d="M14 27 25 14h17l8 13M25 14l6 13 11-13M31 27H14M20 9h8M25 14l-2-5M42 14l2-8h6"/>'),
  scooter: iconSvg('<path d="M7 29c0-8 5-12 13-12h10l3 8h13l3-14h5l-2 18z" fill="#fff"/><path d="M15 13h13M51 11l1-6m-4 0h8"/><circle cx="14" cy="31" r="6" fill="#fff"/><circle cx="51" cy="31" r="6" fill="#fff"/>'),
  kick: iconSvg('<path d="M8 29h39" stroke-width="5"/><path d="M47 29l6-23M46 6h13M47 29l5 4"/><circle cx="12" cy="33" r="4.5" fill="#fff"/><circle cx="53" cy="33" r="4.5" fill="#fff"/>'),
};
const HEART_HTML =
  '<i class="heart"><svg viewBox="-0.6 -0.6 8.2 7.2" aria-hidden="true"><path d="M1 0H3V1H4V0H6V1H7V3H6V4H5V5H4V6H3V5H2V4H1V3H0V1H1Z"/><rect class="hs" x="1" y="1" width="1" height="1"/></svg></i>';

// Skin chips: tiny CSS Roblox R6 figures (styles in index.html, .r6 / .skchip).
const SKIN_FACES = { smile: 1, happy: 1, cool: 1, ninja: 1, robot: 1 };
const SKIN_ACCS = { none: 1, bacon: 1, long: 1, cap: 1, bandana: 1, antenna: 1, crown: 1 };
const LOCK_SVG =
  '<svg viewBox="0 0 18 21" aria-hidden="true"><path d="M4.5 9V6.5a4.5 4.5 0 0 1 9 0V9" fill="none" stroke="#0b0d17" stroke-width="5"/><path d="M4.5 9V6.5a4.5 4.5 0 0 1 9 0V9" fill="none" stroke="#dfe5f5" stroke-width="2.2"/><rect x="1.5" y="8.5" width="15" height="11" rx="2.5" fill="#ffc93c" stroke="#0b0d17" stroke-width="2"/><path d="M9 12.4v3" stroke="#0b0d17" stroke-width="2.2" stroke-linecap="round"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 6.4 5 9l4.8-6"/></svg>';
const safeColor = (c, fb) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : fb);
/** Inline-styled R6 figure for one skin (head/torso/arms/legs colors, face, accessory, metal shine). */
function skinFigure(sk) {
  const face = SKIN_FACES[sk.face] ? sk.face : 'smile';
  const acc = SKIN_ACCS[sk.acc] ? sk.acc : 'none';
  const head = safeColor(sk.head, '#f5cd30');
  const style =
    '--hd:' + head + ';--to:' + safeColor(sk.torso, '#0d69ac') + ';--ar:' + safeColor(sk.arms, head) +
    ';--lg:' + safeColor(sk.legs, '#a4bd47') + ';--ac:' + safeColor(sk.accColor, '#000000');
  return '<span class="r6 f-' + face + ' a-' + acc + (num(sk.metal) >= 0.3 ? ' metal' : '') + '" style="' + style + '" aria-hidden="true">' +
    '<i class="r6-arm l"></i><i class="r6-arm r"></i><i class="r6-leg l"></i><i class="r6-leg r"></i><i class="r6-torso"></i>' +
    '<i class="r6-head"><i class="r6-face"></i></i><i class="r6-acc"></i></span>';
}

// WAAPI keyframes (shared, never re-allocated).
const KF_POP = [{ transform: 'scale(1)' }, { transform: 'scale(1.3)', offset: 0.3 }, { transform: 'scale(1)' }];
const OPT_POP = { duration: 340, easing: 'ease-out' };
const KF_GRADE_UP = [
  { transform: 'scale(1) rotate(0deg)' },
  { transform: 'scale(1.7) rotate(-14deg)', offset: 0.28 },
  { transform: 'scale(0.92) rotate(4deg)', offset: 0.6 },
  { transform: 'scale(1) rotate(0deg)' },
];
const OPT_GRADE = { duration: 520, easing: 'ease-out' };
const KF_NUDGE = [
  { transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(4px)' },
  { transform: 'translateX(-2px)' }, { transform: 'translateX(0)' },
];
const OPT_NUDGE = { duration: 300, easing: 'linear' };
const KF_NOPE = [
  { transform: 'translateX(0) rotate(0deg)' }, { transform: 'translateX(-6px) rotate(-4deg)' }, { transform: 'translateX(5px) rotate(3deg)' },
  { transform: 'translateX(-4px) rotate(-2deg)' }, { transform: 'translateX(2px) rotate(1deg)' }, { transform: 'translateX(0) rotate(0deg)' },
];
const OPT_NOPE = { duration: 380, easing: 'ease-out' };
const KF_BUMP = [{ transform: 'scale(1) rotate(0deg)' }, { transform: 'scale(1.45) rotate(-14deg)', offset: 0.3 }, { transform: 'scale(1) rotate(0deg)' }];
const OPT_BUMP = { duration: 300, easing: 'ease-out' };
const KF_HEART_LOSE = [
  { transform: 'scale(1) rotate(0deg)' },
  { transform: 'scale(1.75) rotate(-16deg)', offset: 0.22 },
  { transform: 'scale(0.78) rotate(10deg)', offset: 0.55 },
  { transform: 'scale(1) rotate(0deg)' },
];
const OPT_HEART = { duration: 640, easing: 'ease-out' };
const KF_SHAKE = [
  { transform: 'translate(0,0)' }, { transform: 'translate(-8px,4px)' }, { transform: 'translate(7px,-5px)' },
  { transform: 'translate(-5px,3px)' }, { transform: 'translate(3px,-2px)' }, { transform: 'translate(0,0)' },
];
const OPT_SHAKE = { duration: 340, easing: 'linear' };
const KF_FLASH = [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 0 }];
const OPT_FLASH = { duration: 560, easing: 'ease-out' };
const KF_CD = [
  { transform: 'scale(2.8)', opacity: 0 },
  { transform: 'scale(0.9)', opacity: 1, offset: 0.2 },
  { transform: 'scale(1.06)', opacity: 1, offset: 0.32 },
  { transform: 'scale(1)', opacity: 1, offset: 0.72 },
  { transform: 'scale(0.6)', opacity: 0 },
];
const OPT_CD = { duration: 900, easing: 'ease-out', fill: 'both' };
const KF_CD_GO = [
  { transform: 'scale(0.3) rotate(-10deg)', opacity: 0 },
  { transform: 'scale(1.25) rotate(3deg)', opacity: 1, offset: 0.22 },
  { transform: 'scale(1) rotate(0deg)', opacity: 1, offset: 0.4 },
  { transform: 'scale(1.05) rotate(0deg)', opacity: 1, offset: 0.72 },
  { transform: 'scale(1.6) rotate(0deg)', opacity: 0 },
];
const OPT_CD_GO = { duration: 1000, easing: 'ease-out', fill: 'both' };
const KF_ZB_BAND = [
  { transform: 'skewY(-3deg) scaleX(0) translateX(0)', opacity: 1, easing: 'cubic-bezier(.2,.9,.25,1)' },
  { transform: 'skewY(-3deg) scaleX(1) translateX(0)', opacity: 1, offset: 0.16 },
  { transform: 'skewY(-3deg) scaleX(1) translateX(0)', opacity: 1, offset: 0.84, easing: 'ease-in' },
  { transform: 'skewY(-3deg) scaleX(1) translateX(14%)', opacity: 0 },
];
const KF_ZB_TEXT = [
  { transform: 'skewY(-3deg) translateX(-90px)', opacity: 0 },
  { transform: 'skewY(-3deg) translateX(-90px)', opacity: 0, offset: 0.08, easing: 'cubic-bezier(.2,1.35,.4,1)' },
  { transform: 'skewY(-3deg) translateX(0)', opacity: 1, offset: 0.24 },
  { transform: 'skewY(-3deg) translateX(14px)', opacity: 1, offset: 0.82, easing: 'ease-in' },
  { transform: 'skewY(-3deg) translateX(120px)', opacity: 0 },
];
const OPT_ZB = { duration: 2300, fill: 'both' };

// ---------------------------------------------------------------- helpers
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const num = (x) => {
  const n = +x;
  return Number.isFinite(n) ? n : 0;
};
/** Integer with pt-BR thousands separators: 12345 -> "12.345". */
function fmtInt(n) {
  n = Math.floor(n > 0 ? n : 0);
  const s = String(n);
  if (n < 1000) return s;
  let i = s.length % 3 || 3;
  let out = s.slice(0, i);
  for (; i < s.length; i += 3) out += '.' + s.slice(i, i + 3);
  return out;
}
function fmtTime(sec) {
  sec = Math.floor(sec > 0 ? sec : 0);
  const m = Math.floor(sec / 60), s = sec % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}
/** q = multiplier * 10 (integer) -> "×2" / "×1,5" */
function fmtMult(q) {
  return '×' + (q % 10 === 0 ? String(q / 10) : (q / 10).toFixed(1).replace('.', ','));
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function rgba(hex, a) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16) || 0;
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}
function bandIndex(kmh) {
  for (let i = BANDS.length - 1; i >= 0; i--) if (kmh >= BANDS[i].lo) return i;
  return 0;
}
function setGradeClass(el, g) {
  if (!el) return;
  el.classList.remove('g-S', 'g-A', 'g-B', 'g-C', 'g-D');
  el.classList.add('g-' + (GRADE_COLORS[g] ? g : 'D'));
}
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  if (typeof c.roundRect === 'function') c.roundRect(x, y, w, h, r);
  else c.rect(x, y, w, h);
}

// ---------------------------------------------------------------- factory
export function createUI() {
  const doc = document;
  const $ = (id) => doc.getElementById(id);
  const root = $('ui');
  if (!root) throw new Error('[ui] #ui root not found: index.html markup is missing');

  const RM = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(RM && RM.matches);
  /** Decorative WAAPI animation; skipped under prefers-reduced-motion. */
  function anim(el, kf, opt) {
    if (!el || typeof el.animate !== 'function' || reduced()) return null;
    try { return el.animate(kf, opt); } catch (_) { return null; }
  }

  const E = {
    screens: { loading: $('s-loading'), menu: $('s-menu'), hud: $('s-hud'), pause: $('s-pause'), gameover: $('s-over') },
    ldBar: $('ld-bar'), ldFill: $('ld-fill'), ldPct: $('ld-pct'), ldTip: $('ld-tip'),
    grades: $('m-grades'), vlist: $('m-vlist'), navName: $('m-navname'), navTag: $('m-navtag'), navDots: $('m-navdots'),
    skins: $('m-skins'), skRow: $('m-skrow'), skName: $('m-skname'),
    goScroll: root.querySelector('#s-over .go-scroll'), goCard: root.querySelector('#s-over .go-card'),
    goUnlock: $('go-unlock'), goUnlockLbl: $('go-unlocklbl'), goUnlockNames: $('go-unlocknames'),
    recDist: $('rec-dist'), recAvg: $('rec-avg'), recGrade: $('rec-grade'), recTop: $('rec-top'), recRuns: $('rec-runs'),
    hud: $('s-hud'), distBox: $('h-distbox'), dist: $('h-dist'), mult: $('h-mult'), rec: $('h-rec'), recBar: $('h-recbar'),
    zonePill: $('h-zonepill'), zone: $('h-zone'), zname: $('h-zname'), time: $('h-time'),
    lives: $('h-lives'), coinIcon: $('h-coinicon'), coins: $('h-coins'),
    speed: $('h-speed'), gauge: $('h-gauge'), avgMark: $('h-avgmark'), kmh: $('h-kmh'),
    avg: $('h-avg'), trend: $('h-trend'), grade: $('h-grade'), avgProg: $('h-avgprog'),
    turbo: $('h-turbo'), turboFill: $('h-turbofill'),
    over: $('s-over'), goVeh: $('go-veh'), goDist: $('go-dist'), goRec: $('go-rec'), goStamp: $('go-stamp'),
    goGrade: $('go-grade'), goAvg: $('go-avg'), goWord: $('go-word'), goBestAvg: $('go-bestavg'), goNewAvg: $('go-newavg'),
    goSpark: $('go-spark'), goHint: $('go-hint'), goHintTxt: $('go-hinttxt'),
    goTop: $('go-top'), goTime: $('go-time'), goTricks: $('go-tricks'), goCoins: $('go-coins'), goFalls: $('go-falls'), goCps: $('go-cps'),
    touch: $('touch'), tBoost: $('t-boost'), stick: $('t-stick'), knob: $('t-knob'), tHint: $('t-hint'),
    pill: $('h-pill'), pkmh: $('h-pkmh'), pavg: $('h-pavg'), pgrade: $('h-pgrade'),
    mode: $('m-mode'), seg: $('m-seg'), modeDesc: $('m-modedesc'), goMode: $('go-mode'),
    recInf: $('rec-inf'), recInfDist: $('rec-infdist'), recInfAvg: $('rec-infavg'), recInfAvgW: $('rec-infavgw'),
    toasts: $('toasts'), zb: $('zone-banner'), zbBand: $('zb-band'), zbText: $('zb-text'), zbNum: $('zb-num'), zbName: $('zb-name'),
    cd: $('countdown'), cdTxt: $('cd-txt'), flash: $('flash'),
  };
  const muteVals = Array.from(root.querySelectorAll('[data-act="mute"] .v'));
  const qualVals = Array.from(root.querySelectorAll('[data-act="quality"] .v'));
  const hapVals = Array.from(root.querySelectorAll('[data-act="haptics"] .v'));
  const fsVals = Array.from(root.querySelectorAll('[data-act="fullscreen"] .v'));
  const muteBtns = Array.from(root.querySelectorAll('[data-act="mute"]'));
  const hapBtns = Array.from(root.querySelectorAll('[data-act="haptics"]'));
  const fsBtns = Array.from(root.querySelectorAll('[data-act="fullscreen"]'));

  // ------------------------------------------------------------ events
  const handlers = Object.create(null);
  const lastEmitAt = Object.create(null);
  function on(ev, cb) {
    if (typeof cb !== 'function') return () => {};
    (handlers[ev] || (handlers[ev] = [])).push(cb);
    return () => {
      const l = handlers[ev];
      const i = l ? l.indexOf(cb) : -1;
      if (i >= 0) l.splice(i, 1);
    };
  }
  function emit(ev, arg) {
    if (DEBOUNCED[ev]) {
      // guards against double fire (click + key in the same gesture, double clicks)
      const now = performance.now();
      if (now - (lastEmitAt[ev] || -1e9) < 300) return;
      lastEmitAt[ev] = now;
    }
    const l = handlers[ev];
    if (!l) return;
    for (let i = 0; i < l.length; i++) {
      try { l[i](arg); } catch (err) { console.error('[ui] "' + ev + '" handler failed:', err); }
    }
  }
  // Optional extra event for UI sounds: ui.on('sfx', name => audio.play(name)) with 'click' | 'hover'.
  const sfx = (name) => emit('sfx', name);

  // ------------------------------------------------------------ state
  let screen = 'loading';
  let screenAt = 0;
  let muted = false;
  let quality = 'high';
  let touchEnabled = false;
  let vehicles = [];
  let selIdx = -1;
  let cards = [];
  let navDots = [];
  let hearts = [];
  // Last displayed HUD values (sentinels force the first write).
  const C = {
    dist: -1, rec: -2, prog: -1, beaten: null, kmh: -1, avg: -1, grade: '', trend: 9, avgProg: -1,
    avgMark: -1, markOn: null, lives: -2, maxLives: -1, turbo: -1, full: null, boost: null, coins: -1,
    time: -1, zoneNum: undefined, zoneName: undefined, mult: -1, load: -1, inf: false,
  };

  // ------------------------------------------------------------ speedometer (canvas)
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const gctx = E.gauge.getContext('2d');
  E.gauge.width = Math.round(GW * dpr);
  E.gauge.height = Math.round(GH * dpr);
  const gBg = doc.createElement('canvas'); // static layer: outline, grade bands, ticks, labels
  gBg.width = E.gauge.width;
  gBg.height = E.gauge.height;
  const bctx = gBg.getContext('2d');
  let gaugeMax = 160;
  const gAng = (v) => GA0 + GSW * clamp01(v / gaugeMax);

  function makeGlow(color) {
    const c = doc.createElement('canvas');
    const s = Math.round(48 * dpr);
    c.width = c.height = s;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.28, rgba(color, 0.85));
    g.addColorStop(1, rgba(color, 0));
    x.fillStyle = g;
    x.fillRect(0, 0, s, s);
    return c;
  }
  const glowSprites = BANDS.map((b) => makeGlow(b.color));

  function buildGaugeBg() {
    const c = bctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, gBg.width, gBg.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const aEnd = GA0 + GSW;
    // chunky dark outline + dark track
    c.lineCap = 'round';
    c.strokeStyle = INK;
    c.lineWidth = GLW + 8;
    c.beginPath(); c.arc(GCX, GCY, GR, GA0, aEnd); c.stroke();
    c.lineCap = 'butt';
    c.lineWidth = GLW - 2;
    c.strokeStyle = '#1b1f40';
    c.beginPath(); c.arc(GCX, GCY, GR, GA0, aEnd); c.stroke();
    // dim grade bands so the player sees where S/A/B... start
    c.globalAlpha = 0.3;
    for (let i = 0; i < BANDS.length; i++) {
      const b = BANDS[i];
      const s = gAng(b.lo), e = gAng(Math.min(b.hi, gaugeMax));
      if (e - s < 0.001) continue;
      c.strokeStyle = b.color;
      c.beginPath(); c.arc(GCX, GCY, GR, s, e); c.stroke();
    }
    c.globalAlpha = 1;
    // threshold notches
    c.strokeStyle = INK;
    c.lineWidth = 2.5;
    for (let i = 0; i < BANDS.length; i++) {
      const lo = BANDS[i].lo;
      if (lo <= 0 || lo >= gaugeMax) continue;
      const a = gAng(lo), cs = Math.cos(a), sn = Math.sin(a);
      c.beginPath();
      c.moveTo(GCX + cs * (GR - GLW / 2), GCY + sn * (GR - GLW / 2));
      c.lineTo(GCX + cs * (GR + GLW / 2), GCY + sn * (GR + GLW / 2));
      c.stroke();
    }
    // ticks + labels
    const step = gaugeMax > 160 ? 30 : 20;
    const rT = GR - GLW / 2 - 5;
    c.font = '600 11px "Chakra Petch", ui-monospace, monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let v = 0; v <= gaugeMax + 0.01; v += 10) {
      const major = v % step === 0;
      const a = gAng(v), cs = Math.cos(a), sn = Math.sin(a);
      const r2 = rT - (major ? 9 : 5);
      c.strokeStyle = major ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.38)';
      c.lineWidth = major ? 2.5 : 1.5;
      c.beginPath(); c.moveTo(GCX + cs * rT, GCY + sn * rT); c.lineTo(GCX + cs * r2, GCY + sn * r2); c.stroke();
      if (major) {
        const rl = rT - 17;
        c.fillStyle = 'rgba(255,255,255,0.8)';
        c.fillText(String(v), GCX + cs * rl, GCY + sn * rl + 0.5);
      }
    }
  }

  function drawGauge(kmh) {
    const c = gctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, E.gauge.width, E.gauge.height);
    c.drawImage(gBg, 0, 0);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = kmh < 0 ? 0 : kmh > gaugeMax ? gaugeMax : kmh;
    const aV = gAng(v);
    let bi = 0;
    if (v > 0) {
      // bright fill, colored by the grade band each part of the arc belongs to
      c.lineCap = 'butt';
      c.lineWidth = GLW - 2;
      for (let i = 0; i < BANDS.length; i++) {
        const b = BANDS[i];
        if (v <= b.lo) break;
        bi = i;
        c.strokeStyle = b.color;
        c.beginPath(); c.arc(GCX, GCY, GR, gAng(b.lo), gAng(v < b.hi ? v : b.hi)); c.stroke();
      }
      c.lineWidth = 2.5;
      c.strokeStyle = 'rgba(255,255,255,0.5)';
      c.beginPath(); c.arc(GCX, GCY, GR + GLW / 2 - 4, GA0, aV); c.stroke();
    }
    // glowing tip + knob
    const tx = GCX + Math.cos(aV) * GR, ty = GCY + Math.sin(aV) * GR;
    c.drawImage(glowSprites[bi], tx - 24, ty - 24, 48, 48);
    c.beginPath(); c.arc(tx, ty, GLW / 2 - 1, 0, Math.PI * 2);
    c.fillStyle = '#ffffff'; c.fill();
    c.lineWidth = 3; c.strokeStyle = INK; c.stroke();
  }

  buildGaugeBg();
  drawGauge(0);
  // Re-render the tick labels once the number font is ready.
  if (doc.fonts && typeof doc.fonts.load === 'function') {
    doc.fonts.load('600 11px "Chakra Petch"').then(() => {
      buildGaugeBg();
      drawGauge(C.kmh > 0 ? C.kmh : 0);
    }).catch(() => {});
  }

  // ------------------------------------------------------------ screens
  function showScreen(name) {
    const el = E.screens[name];
    if (!el || name === screen) return;
    const prevEl = E.screens[screen];
    if (name === 'hud' && (screen === 'menu' || screen === 'gameover')) newRun();
    if (prevEl) prevEl.classList.remove('on');
    el.classList.add('on');
    root.classList.remove('scr-' + screen);
    root.classList.add('scr-' + name);
    screen = name;
    screenAt = performance.now();
    const ae = doc.activeElement;
    if (ae && ae !== doc.body && root.contains(ae) && typeof ae.blur === 'function') ae.blur();
    if (name === 'hud') rectsDirty = true;
    else clearTouch();
    if (name !== 'loading' && tipTimer) { clearInterval(tipTimer); tipTimer = 0; }
    if (name !== 'gameover') stopCountUp();
    if (name === 'menu' || name === 'loading') clearOverlays();
    else if (name === 'pause' || name === 'gameover') clearToasts(); // no stale "CAIU!" over the report
  }

  // ------------------------------------------------------------ loading
  let tipIdx = Math.floor(Math.random() * TIPS.length);
  const showTip = () => { E.ldTip.innerHTML = 'Dica: ' + TIPS[tipIdx]; };
  showTip();
  let tipTimer = setInterval(() => { tipIdx = (tipIdx + 1) % TIPS.length; showTip(); }, 2800);

  function setLoading(p) {
    const q = Math.round(clamp01(num(p)) * 100);
    if (q === C.load) return;
    C.load = q;
    E.ldFill.style.transform = 'translateX(' + (Math.max(q, 3) - 100) + '%)';
    E.ldPct.textContent = q + '%';
    if (E.ldBar) E.ldBar.setAttribute('aria-valuenow', String(q));
  }

  // ------------------------------------------------------------ menu
  // grade legend chips (from CONFIG so it always matches the scoring)
  {
    let html = '<span class="lbl">NOTA DA MÉDIA<i> (KM/H)</i></span>';
    for (let i = 0; i < GRADES_DESC.length; i++) {
      const g = GRADES_DESC[i];
      const range = g.min > 0 ? g.min + '+' : '<' + (i > 0 ? GRADES_DESC[i - 1].min : 1);
      html += '<span class="gchip g-' + g.grade + '"><b>' + g.grade + '</b><span>' + esc(range) + '</span></span>';
    }
    E.grades.innerHTML = html;
  }

  const accentFor = (id, i) => VEHICLE_ACCENTS[id] || ACCENT_CYCLE[i % ACCENT_CYCLE.length];
  function gaugeMaxFor(v) {
    const top = num(v && v.maxSpeed) * 3.6 * (CONFIG.boostMultiplier || 1);
    return Math.max(80, Math.ceil((top || 140) / 20) * 20);
  }

  function setVehicles(list, selectedId) {
    vehicles = Array.isArray(list) ? list.filter((v) => v && v.id != null) : [];
    let html = '';
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      const bars = v.bars || {};
      let stats = '';
      for (let s = 0; s < STAT_DEFS.length; s++) {
        const [key, label, color] = STAT_DEFS[s];
        const n = Math.max(0, Math.min(5, Math.round(num(bars[key]))));
        let pips = '';
        for (let p = 0; p < 5; p++) pips += p < n ? '<i class="f"></i>' : '<i></i>';
        stats += '<span class="st-l">' + label + '</span><span class="pips" style="--sc:' + color + '" role="img" aria-label="' + label + ' ' + n + ' de 5">' + pips + '</span>';
      }
      html +=
        '<button type="button" class="vcard" data-id="' + esc(v.id) + '" style="--va:' + accentFor(v.id, i) + '" aria-pressed="false">' +
        '<span class="vc-icon">' + (VEHICLE_ICONS[v.id] || VEHICLE_ICONS.bike) + '</span>' +
        '<span class="vc-main"><span class="vc-name">' + esc(v.name || v.id) + '</span><span class="vc-tag">' + esc(v.tagline || '') + '</span></span>' +
        '<span class="vc-stats">' + stats + '</span>' +
        '<span class="sel-badge">SELECIONADO</span></button>';
    }
    E.vlist.innerHTML = html;
    cards = Array.from(E.vlist.children);
    E.navDots.innerHTML = '<i></i>'.repeat(vehicles.length);
    navDots = Array.from(E.navDots.children);
    selIdx = -1;
    let id = vehicles.length ? vehicles[0].id : null;
    for (let i = 0; i < vehicles.length; i++) if (vehicles[i].id === selectedId) id = selectedId;
    if (id != null) selectVehicle(id, false);
  }

  function selectVehicle(id, fromUser) {
    let idx = -1;
    for (let i = 0; i < vehicles.length; i++) if (vehicles[i].id === id) { idx = i; break; }
    if (idx < 0) return;
    const changed = idx !== selIdx;
    selIdx = idx;
    const v = vehicles[idx];
    for (let i = 0; i < cards.length; i++) {
      const on = i === idx;
      cards[i].classList.toggle('sel', on);
      cards[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    for (let i = 0; i < navDots.length; i++) navDots[i].classList.toggle('on', i === idx);
    E.navName.textContent = v.name || v.id;
    E.navTag.textContent = v.tagline || '';
    root.style.setProperty('--va', accentFor(v.id, idx));
    const gm = gaugeMaxFor(v);
    if (gm !== gaugeMax) {
      gaugeMax = gm;
      buildGaugeBg();
      drawGauge(C.kmh > 0 ? C.kmh : 0);
      C.avg = -1; // re-place the average marker on the new scale
    }
    if (fromUser && changed) {
      const icon = cards[idx] && cards[idx].firstElementChild;
      anim(icon, KF_POP, OPT_POP);
      anim(E.navName, KF_POP, OPT_POP);
      emit('vehicle', v.id);
    }
  }
  function cycleVehicle(dir) {
    if (!vehicles.length) return;
    const n = vehicles.length;
    const i = ((selIdx < 0 ? 0 : selIdx) + dir + n) % n;
    selectVehicle(vehicles[i].id, true);
  }

  function setRecords(r) {
    r = r || {};
    E.recDist.textContent = fmtInt(num(r.bestDistance));
    const avgRaw = num(r.bestAvgKmh);
    E.recAvg.textContent = String(Math.floor(avgRaw));
    const g = gradeFor(avgRaw);
    E.recGrade.textContent = g;
    setGradeClass(E.recGrade, g);
    E.recGrade.hidden = !(avgRaw > 0);
    E.recTop.textContent = String(Math.round(num(r.bestTopKmh)));
    E.recRuns.textContent = fmtInt(num(r.runs));
    // infinite-lives records live on their own line (shown once there is one)
    const infD = num(r.infBestDistance);
    if (E.recInf) {
      E.recInf.hidden = !(infD > 0);
      if (infD > 0) {
        E.recInfDist.textContent = fmtInt(infD);
        const infA = Math.floor(num(r.infBestAvgKmh));
        E.recInfAvg.textContent = String(infA);
        // runs under 150 m set no average: no "média 0 km/h"
        if (E.recInfAvgW) E.recInfAvgW.hidden = !(infA > 0);
      }
    }
  }

  function setMuted(b) {
    muted = !!b;
    for (let i = 0; i < muteVals.length; i++) muteVals[i].textContent = muted ? 'DESLIGADO' : 'LIGADO';
    for (let i = 0; i < muteBtns.length; i++) muteBtns[i].classList.toggle('off', muted);
    root.classList.toggle('is-muted', muted);
  }
  /** VIBRAÇÃO toggle state (main owns the setting and the actual buzzing; the touch buttons tick when on). */
  function setHaptics(b) {
    hapticsOn = !!b;
    for (let i = 0; i < hapVals.length; i++) hapVals[i].textContent = hapticsOn ? 'LIGADA' : 'DESLIGADA';
    for (let i = 0; i < hapBtns.length; i++) hapBtns[i].classList.toggle('off', !hapticsOn);
  }
  // TELA CHEIA: only where the page may go fullscreen (not iPhone Safari); the label follows the real state.
  const fsOK = !!doc.fullscreenEnabled;
  function syncFullscreen() {
    const on = !!doc.fullscreenElement;
    root.classList.toggle('fs-on', on);
    for (let i = 0; i < fsVals.length; i++) fsVals[i].textContent = on ? 'SAIR DA TELA CHEIA' : 'TELA CHEIA';
    rectsDirty = true;
  }
  for (let i = 0; i < fsBtns.length; i++) fsBtns[i].hidden = !fsOK;
  if (fsOK) doc.addEventListener('fullscreenchange', syncFullscreen);
  // VIBRAÇÃO only where vibration exists (Android); CSS also hides it until a touch screen is in use
  for (let i = 0; i < hapBtns.length; i++) hapBtns[i].hidden = typeof navigator.vibrate !== 'function';

  // ------------------------------------------------------------ game mode toggle (menu, above JOGAR)
  let modeSel = '';
  let segBtns = [];
  {
    let html = '';
    const order = Array.isArray(MODE_ORDER) ? MODE_ORDER : [];
    for (let i = 0; i < order.length; i++) {
      const m = MODES && MODES[order[i]];
      if (!m) continue;
      html += '<button type="button" class="seg-b seg-' + esc(m.id || order[i]) + '" data-mode="' + esc(order[i]) + '" aria-pressed="false">' +
        (MODE_ICONS[order[i]] || '') + '<span>' + esc(m.name || order[i]) + '</span></button>';
    }
    if (E.seg) {
      E.seg.innerHTML = html;
      segBtns = Array.from(E.seg.children);
    }
    if (E.mode) E.mode.hidden = segBtns.length < 2;
  }
  /** ui.setMode(id): highlight the mode and show its one-line description. */
  function setMode(id) {
    if (!MODES || !MODES[id]) return;
    modeSel = id;
    for (let i = 0; i < segBtns.length; i++) {
      const on = segBtns[i].getAttribute('data-mode') === id;
      segBtns[i].classList.toggle('sel', on);
      segBtns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (E.modeDesc) E.modeDesc.textContent = MODES[id].desc || '';
    root.classList.toggle('mode-inf', id === 'infinite');
  }
  function pickMode(btn) {
    const id = btn.getAttribute('data-mode');
    if (!MODES || !MODES[id]) return;
    if (id === modeSel) { anim(btn, KF_NUDGE, OPT_NUDGE); return; }
    setMode(id);
    anim(btn.firstElementChild, KF_POP, OPT_POP);
    emit('mode', id);
  }
  function setQuality(q) {
    quality = q === 'low' ? 'low' : 'high';
    for (let i = 0; i < qualVals.length; i++) qualVals[i].textContent = quality === 'low' ? 'BAIXA' : 'ALTA';
    root.classList.toggle('q-low', quality === 'low');
  }

  // ------------------------------------------------------------ skins
  // Chips are rebuilt only when the skin list or a locked/unlocked state changes;
  // selection changes just toggle classes (main calls setSkins again after every pick).
  let skins = [];
  let skinSel = null;
  let skinSig = '';
  let skinChips = [];
  let skinLockedPrev = null; // Set of ids locked at the previous setSkins call
  const freshSkins = new Set(); // unlocked since the page loaded: "NOVA!" ribbon until picked
  let nopeChip = null, nopeTimer = 0;
  let skinBest = 0;
  const skinLocked = (sk) => num(sk.unlock) > skinBest;
  function skinById(id) {
    for (let i = 0; i < skins.length; i++) if (skins[i].id === id) return skins[i];
    return null;
  }

  function buildSkinChips() {
    let html = '';
    for (let i = 0; i < skins.length; i++) {
      const sk = skins[i];
      const name = esc(sk.name || sk.id);
      const locked = skinLocked(sk);
      const req = fmtInt(num(sk.unlock));
      html +=
        '<button type="button" class="skchip' + (locked ? ' locked' : '') + (freshSkins.has(sk.id) ? ' fresh' : '') + '" data-skin="' + esc(sk.id) + '"' +
        ' aria-pressed="false"' + (locked ? ' aria-disabled="true"' : '') +
        ' aria-label="' + name + (locked ? ': bloqueada, Recorde ' + req + ' m' : '') + '">' +
        skinFigure(sk) +
        (locked ? '<span class="sk-lock">' + LOCK_SVG + '</span><span class="sk-req">' + req + ' m</span>' : '') +
        '<span class="sk-ok">' + CHECK_SVG + '</span><span class="sk-new">NOVA!</span>' +
        '<span class="sk-tip">' + name + (locked ? '<span class="req">' + LOCK_SVG + 'Recorde ' + req + ' m</span>' : '') + '</span>' +
        '</button>';
    }
    E.skRow.innerHTML = html;
    skinChips = Array.from(E.skRow.children);
    nopeChip = null;
  }

  function showSkinName() {
    const sk = skinById(skinSel);
    const t = sk ? sk.name || sk.id : '';
    if (E.skName.textContent !== t) E.skName.textContent = t;
  }

  function applySkinSel(pop) {
    for (let i = 0; i < skinChips.length; i++) {
      const c = skinChips[i];
      const on = c.getAttribute('data-skin') === skinSel;
      if (c.classList.contains('sel') !== on) {
        c.classList.toggle('sel', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (on && pop) anim(c.firstElementChild, KF_POP, OPT_POP);
      }
    }
    showSkinName();
  }

  /** ui.setSkins(SKINS, selectedId, bestDistance): skins with unlock > bestDistance are locked. */
  function setSkins(list, selectedId, bestDistance) {
    skins = Array.isArray(list) ? list.filter((s) => s && s.id != null) : [];
    skinBest = num(bestDistance);
    const lockedNow = new Set();
    let sig = '';
    for (let i = 0; i < skins.length; i++) {
      const sk = skins[i];
      const locked = skinLocked(sk);
      if (locked) lockedNow.add(sk.id);
      // unlocked since the previous call (e.g. a run just beat the requirement)
      else if (skinLockedPrev && skinLockedPrev.has(sk.id)) freshSkins.add(sk.id);
      sig += sk.id + (locked ? '!' : '') + '|';
    }
    skinLockedPrev = lockedNow;
    if (sig !== skinSig) {
      skinSig = sig;
      clearTimeout(nopeTimer);
      buildSkinChips();
    }
    const want = skinById(selectedId);
    if (want && !skinLocked(want)) skinSel = want.id;
    else if (!skinById(skinSel) || skinLocked(skinById(skinSel))) {
      skinSel = null;
      for (let i = 0; i < skins.length; i++) if (!skinLocked(skins[i])) { skinSel = skins[i].id; break; }
    }
    applySkinSel(false);
    E.skins.hidden = skins.length === 0;
  }

  function clearNope() {
    nopeTimer = 0;
    if (nopeChip) nopeChip.classList.remove('nope');
    nopeChip = null;
  }

  function pickSkin(chip) {
    const sk = skinById(chip.getAttribute('data-skin'));
    if (!sk) return;
    if (skinLocked(sk)) {
      // not selectable: shake + "Recorde N m" bubble over the chip
      sfx('trickFail');
      anim(chip, KF_NOPE, OPT_NOPE);
      if (nopeChip && nopeChip !== chip) nopeChip.classList.remove('nope');
      nopeChip = chip;
      chip.classList.add('nope');
      clearTimeout(nopeTimer);
      nopeTimer = setTimeout(clearNope, 2000);
      return;
    }
    sfx('click');
    if (nopeChip) { clearTimeout(nopeTimer); clearNope(); }
    if (freshSkins.delete(sk.id)) chip.classList.remove('fresh');
    if (sk.id === skinSel) { anim(chip.firstElementChild, KF_POP, OPT_POP); return; }
    skinSel = sk.id;
    applySkinSel(true);
    emit('skin', sk.id);
  }

  // ------------------------------------------------------------ HUD
  function buildHearts(n) {
    n = Math.max(0, Math.min(12, n | 0));
    E.lives.innerHTML = HEART_HTML.repeat(n);
    hearts = Array.from(E.lives.children);
  }

  function updateHUD(h) {
    if (!h) return;

    // distance / record progress
    const d = Math.floor(h.distance > 0 ? h.distance : 0);
    if (d !== C.dist) { C.dist = d; E.dist.textContent = fmtInt(d); }
    const rec = Math.floor(h.record > 0 ? h.record : 0);
    if (rec !== C.rec) { C.rec = rec; E.rec.textContent = rec > 0 ? fmtInt(rec) + ' m' : '—'; }
    const beaten = !!h.recordBeaten;
    if (beaten !== C.beaten) { C.beaten = beaten; E.distBox.classList.toggle('beaten', beaten); }
    const prog = beaten ? 200 : rec > 0 ? Math.round(Math.min(1, d / rec) * 200) : 0;
    if (prog !== C.prog) { C.prog = prog; E.recBar.style.transform = 'translateX(' + (prog / 2 - 100) + '%)'; }

    // speed (gauge canvas redraws only when the integer km/h changes)
    const speedRaw = h.speedKmh > 0 ? h.speedKmh : 0;
    const kmh = Math.round(speedRaw);
    if (kmh !== C.kmh) {
      C.kmh = kmh;
      const ks = String(kmh);
      E.kmh.textContent = ks;
      E.pkmh.textContent = ks;
      if (!compact) drawGauge(kmh); // compact HUD shows the pill instead of the gauge
    }

    // live average + grade
    const avgRaw = h.avgKmh > 0 ? h.avgKmh : 0;
    const avg = Math.floor(avgRaw);
    if (avg !== C.avg) {
      C.avg = avg;
      E.avg.textContent = String(avg);
      E.pavg.textContent = String(avg);
      const g = gradeFor(avg);
      if (g !== C.grade) {
        const prevG = C.grade;
        C.grade = g;
        E.grade.textContent = g;
        E.pgrade.textContent = g;
        setGradeClass(E.speed, g);
        setGradeClass(E.pill, g);
        if (prevG) {
          const up = (GRADE_RANK[g] || 0) > (GRADE_RANK[prevG] || 0);
          const ge = compact ? E.pgrade : E.grade;
          if (up) anim(ge, KF_GRADE_UP, OPT_GRADE);
          else anim(ge, KF_NUDGE, OPT_NUDGE);
        }
      }
      // progress through the current grade band toward the next letter
      const b = BANDS[bandIndex(avg)];
      const p = b.hi === Infinity ? 100 : Math.round(clamp01((avg - b.lo) / (b.hi - b.lo)) * 100);
      if (p !== C.avgProg) { C.avgProg = p; E.avgProg.style.transform = 'translateX(' + (p - 100) + '%)'; }
      // average marker on the gauge arc (half-degree steps)
      const mk = Math.round(clamp01(avg / gaugeMax) * 480);
      if (mk !== C.avgMark) { C.avgMark = mk; E.avgMark.style.transform = 'rotate(' + (150 + mk / 2) + 'deg)'; }
      const markOn = avg > 0;
      if (markOn !== C.markOn) { C.markOn = markOn; E.avgMark.style.opacity = markOn ? '1' : '0'; }
    }
    // trend arrow: is the current speed pulling the average up or down? (with hysteresis)
    let tr = 0;
    if (avgRaw > 0) {
      if (C.trend === 1) tr = speedRaw > avgRaw + 0.5 ? 1 : speedRaw < avgRaw - 2 ? -1 : 0;
      else if (C.trend === -1) tr = speedRaw < avgRaw - 0.5 ? -1 : speedRaw > avgRaw + 2 ? 1 : 0;
      else tr = speedRaw > avgRaw + 2 ? 1 : speedRaw < avgRaw - 2 ? -1 : 0;
    }
    if (tr !== C.trend) { C.trend = tr; E.trend.className = tr > 0 ? 'trend up' : tr < 0 ? 'trend down' : 'trend'; }

    // lives (infinite mode: one ∞ badge instead of the hearts, no pops)
    const inf = !!h.infinite;
    if (inf !== C.inf) {
      C.inf = inf;
      E.lives.classList.toggle('inf', inf);
      E.lives.classList.remove('danger');
      E.lives.setAttribute('aria-label', inf ? 'Vidas infinitas' : 'Vidas');
      if (inf) { E.lives.innerHTML = '<i class="inf-badge">' + INF_SVG + '</i>'; hearts = []; }
      C.maxLives = -1; // rebuild the hearts (silently) when back to normal
      C.lives = -2;
    }
    const ml = num(h.maxLives) | 0, lv = num(h.lives) | 0;
    // main grows the row with the lives (maxLives = max(3, lives)): keep the previous count
    // across the rebuild so an earned heart still pops in
    const rebuilt = !inf && ml !== C.maxLives;
    if (rebuilt) { C.maxLives = ml; buildHearts(ml); }
    if (!inf && (lv !== C.lives || rebuilt)) {
      const prev = C.lives;
      C.lives = lv;
      for (let i = 0; i < hearts.length; i++) hearts[i].classList.toggle('lost', i >= lv);
      if (prev >= 0 && lv !== prev) {
        if (lv < prev) for (let i = lv; i < prev && i < hearts.length; i++) anim(hearts[i], KF_HEART_LOSE, OPT_HEART);
        else for (let i = Math.max(0, prev); i < lv && i < hearts.length; i++) anim(hearts[i], KF_POP, OPT_POP);
      }
      E.lives.classList.toggle('danger', lv === 1 && ml > 1);
    }

    // turbo
    const tp = Math.round(clamp01(num(h.turbo)) * 100);
    if (tp !== C.turbo) {
      C.turbo = tp;
      E.turboFill.style.transform = 'translateX(' + (tp - 100) + '%)';
      E.tBoost.style.setProperty('--t', String(tp / 100));
      const full = tp >= 100;
      if (full !== C.full) { C.full = full; E.turbo.classList.toggle('full', full); E.tBoost.classList.toggle('full', full); }
    }
    const bo = !!h.boosting;
    if (bo !== C.boost) {
      C.boost = bo;
      E.turbo.classList.toggle('boost', bo);
      E.speed.classList.toggle('boost', bo);
      E.pill.classList.toggle('boost', bo);
      E.tBoost.classList.toggle('boost', bo);
    }

    // coins
    const coins = Math.floor(h.coins > 0 ? h.coins : 0);
    if (coins !== C.coins) {
      if (C.coins >= 0 && coins > C.coins) anim(E.coinIcon, KF_BUMP, OPT_BUMP);
      C.coins = coins;
      E.coins.textContent = fmtInt(coins);
    }

    // timer + zone
    const t = Math.floor(h.time > 0 ? h.time : 0);
    if (t !== C.time) { C.time = t; E.time.textContent = fmtTime(t); }
    if (h.zoneNum !== C.zoneNum) {
      C.zoneNum = h.zoneNum;
      const zn = h.zoneNum != null ? h.zoneNum : 1;
      E.zone.textContent = 'ZONA ' + zn;
      // keep the pill dot on the zone's accent (also correct after a restart drops back to zone 1)
      const z = zoneAt(Math.max(0, (zn | 0) - 1));
      if (z && z.accent) root.style.setProperty('--zone', z.accent);
    }
    if (h.zoneName !== C.zoneName) { C.zoneName = h.zoneName; E.zname.textContent = h.zoneName || ''; }

    // score multiplier chip (hidden at ×1)
    const mq = Math.round((h.multiplier > 0 ? h.multiplier : 1) * 10);
    if (mq !== C.mult) {
      const up = C.mult > 0 && mq > C.mult;
      C.mult = mq;
      if (mq <= 10) E.mult.hidden = true;
      else {
        E.mult.hidden = false;
        E.mult.textContent = fmtMult(mq);
        if (up) anim(E.mult, KF_POP, OPT_POP);
      }
    }
  }

  // ------------------------------------------------------------ overlays
  let toastN = 0;
  function onToastEnd(e) {
    if (e.target === this && (e.animationName === 'toast' || e.animationName === 'toastFade')) this.remove();
  }
  function removeToast(el) { if (el.parentNode) el.remove(); }
  function addToast(text, kind) {
    const el = doc.createElement('div');
    el.className = 'toast t-' + kind;
    el.textContent = String(text);
    el.style.setProperty('--tilt', (toastN++ & 1 ? 1.5 : -1.5) + 'deg');
    el.addEventListener('animationend', onToastEnd);
    E.toasts.insertBefore(el, E.toasts.firstChild);
    while (E.toasts.childElementCount > 2) E.toasts.lastElementChild.remove();
    setTimeout(removeToast, kind === 'record' ? 3100 : 2300, el); // fallback if animations never run
    fitZoneBanner();
  }
  function toast(text, kind) {
    if (text == null || text === '') return;
    addToast(text, TOAST_KINDS[kind] ? kind : 'info');
  }
  function checkpoint(n) {
    addToast('CHECKPOINT' + (n != null && n !== '' ? ' ' + n : ''), 'cp');
    anim(E.distBox, KF_POP, OPT_POP);
  }
  function clearToasts() { E.toasts.textContent = ''; }

  let zbA = null, zbB = null, zbTimer = 0;
  function hideZoneBanner() { zbTimer = 0; E.zb.hidden = true; E.zb.style.marginTop = ''; }
  // Toasts and the zone banner can show together (a checkpoint or skin unlock right at a zone change):
  // push the band below the toast stack. 12px = the band's inset; 28px covers its skew across a toast,
  // its accent stripe and the toasts' tilt/pop (layout boxes ignore transforms).
  function fitZoneBanner() {
    if (E.zb.hidden) return;
    E.zb.style.marginTop = '';
    if (!E.toasts.childElementCount) return;
    const need = E.toasts.getBoundingClientRect().bottom + 28 - (E.zb.getBoundingClientRect().top + 12);
    if (need > 0) E.zb.style.marginTop = Math.ceil(need) + 'px';
  }
  function zoneBanner(zoneNum, name, accent) {
    const acc = typeof accent === 'string' && accent ? accent : '#3a86ff';
    root.style.setProperty('--zone', acc);
    E.zb.style.setProperty('--accent', acc);
    E.zbNum.textContent = 'ZONA ' + (zoneNum != null ? zoneNum : '');
    E.zbName.textContent = name || '';
    if (zbA) zbA.cancel();
    if (zbB) zbB.cancel();
    E.zb.hidden = false;
    fitZoneBanner();
    zbA = anim(E.zbBand, KF_ZB_BAND, OPT_ZB);
    zbB = anim(E.zbText, KF_ZB_TEXT, OPT_ZB);
    clearTimeout(zbTimer);
    zbTimer = setTimeout(hideZoneBanner, OPT_ZB.duration + 60);
    anim(E.zonePill, KF_POP, OPT_POP);
  }

  let cdAnim = null, cdTimer = 0;
  function hideCountdown() {
    cdTimer = 0;
    E.cd.hidden = true;
    E.cd.classList.remove('go');
  }
  function countdown(v) {
    clearTimeout(cdTimer);
    if (cdAnim) { cdAnim.cancel(); cdAnim = null; }
    if (v === null || v === undefined || v === '' || v === false) { hideCountdown(); return; }
    const isGo = !(typeof v === 'number' || /^\d+$/.test(String(v)));
    E.cdTxt.textContent = String(v);
    E.cdTxt.setAttribute('data-n', isGo ? 'go' : String(v));
    E.cd.classList.toggle('go', isGo);
    E.cd.hidden = false;
    cdAnim = anim(E.cdTxt, isGo ? KF_CD_GO : KF_CD, isGo ? OPT_CD_GO : OPT_CD);
    cdTimer = setTimeout(hideCountdown, isGo ? 1000 : 950);
  }

  let flashAnim = null;
  function flashDamage() {
    // The red flash is gameplay feedback, so it plays even with reduced motion; the shake does not.
    if (typeof E.flash.animate === 'function') {
      try {
        if (flashAnim) flashAnim.cancel();
        flashAnim = E.flash.animate(KF_FLASH, OPT_FLASH);
      } catch (_) { /* ignore */ }
    }
    anim(E.hud, KF_SHAKE, OPT_SHAKE);
  }

  function clearOverlays() {
    clearToasts();
    if (zbA) { zbA.cancel(); zbA = null; }
    if (zbB) { zbB.cancel(); zbB = null; }
    clearTimeout(zbTimer);
    hideZoneBanner();
    clearTimeout(cdTimer);
    if (cdAnim) { cdAnim.cancel(); cdAnim = null; }
    hideCountdown();
  }

  // ------------------------------------------------------------ game over
  const cu = { raf: 0, timer: 0, t0: 0, dist: 0, avg: 0, ld: -1, la: -1 };
  function cuTick(now) {
    const t = clamp01((now - cu.t0) / 1000);
    const e = 1 - (1 - t) * (1 - t) * (1 - t);
    const d = Math.floor(cu.dist * e), a = Math.floor(cu.avg * e);
    if (d !== cu.ld) { cu.ld = d; E.goDist.textContent = fmtInt(d); }
    if (a !== cu.la) { cu.la = a; E.goAvg.textContent = String(a); }
    cu.raf = t < 1 ? requestAnimationFrame(cuTick) : 0;
  }
  function stopCountUp() {
    if (cu.raf) cancelAnimationFrame(cu.raf);
    clearTimeout(cu.timer);
    cu.raf = cu.timer = 0;
  }
  // rAF is paused in background tabs: make sure the final numbers always land
  function finishCountUp() {
    stopCountUp();
    E.goDist.textContent = fmtInt(cu.dist);
    E.goAvg.textContent = String(cu.avg);
  }

  /** Speed-over-distance chart: grade bands, grade-colored line, dashed average, top-speed marker.
   *  Rendered at the canvas's laid-out CSS size (call while the game-over screen is visible). */
  function drawSpark(samples, avg, distance) {
    const cv = E.goSpark;
    const c = cv.getContext('2d');
    if (!c) return;
    // size the backing store to the CSS box (fallback when not laid out yet)
    const W = cv.clientWidth || 800, H = cv.clientHeight || 200;
    const bw0 = Math.round(W * dpr), bh0 = Math.round(H * dpr);
    if (cv.width !== bw0) cv.width = bw0;
    if (cv.height !== bh0) cv.height = bh0;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const src = Array.isArray(samples) ? samples : [];
    const n = src.length;
    const m = Math.min(n, Math.max(60, Math.min(300, Math.floor(W / 3))));
    if (n < 2 || m < 2) {
      c.font = '800 16px Nunito, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = 'rgba(255,255,255,0.7)';
      c.fillText('Corrida curta demais para o gráfico', W / 2, H / 2);
      return;
    }
    // bucket-average down to m points (the label keeps the raw maximum)
    const pts = new Float32Array(m);
    let rawMax = 0, rawMaxI = 0;
    for (let j = 0; j < n; j++) { const v = num(src[j]); if (v > rawMax) { rawMax = v; rawMaxI = j; } }
    for (let i = 0; i < m; i++) {
      const a = Math.floor((i * n) / m), b = Math.max(a + 1, Math.floor(((i + 1) * n) / m));
      let s = 0;
      for (let j = a; j < b; j++) s += num(src[j]);
      pts[i] = s / (b - a);
    }
    const maxI = Math.min(m - 1, Math.floor((rawMaxI * m) / n));

    const padL = 52, padR = 12, padT = 14, padB = 26;
    const pw = W - padL - padR, ph = H - padT - padB;
    const yMax = Math.max(40, Math.ceil((Math.max(rawMax, avg) * 1.1) / 20) * 20);
    const X = (i) => padL + (i / (m - 1)) * pw;
    const Y = (v) => padT + ph - clamp01(v / yMax) * ph;
    c.lineJoin = 'round';
    c.textBaseline = 'middle';

    // grade bands, threshold lines and letters
    for (let i = 0; i < BANDS.length; i++) {
      const b = BANDS[i];
      const top = Y(Math.min(b.hi, yMax)), bot = Y(b.lo);
      if (bot - top < 1) continue;
      c.fillStyle = rgba(b.color, 0.08);
      c.fillRect(padL, top, pw, bot - top);
      if (bot - top >= 11) {
        c.font = '400 17px "Lilita One", sans-serif';
        c.textAlign = 'center';
        c.lineWidth = 4;
        c.strokeStyle = INK;
        c.strokeText(b.grade, 13, (top + bot) / 2 + 1);
        c.fillStyle = b.color;
        c.fillText(b.grade, 13, (top + bot) / 2 + 1);
      }
      if (b.lo > 0) {
        c.setLineDash([2, 5]);
        c.strokeStyle = rgba(b.color, 0.55);
        c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(padL, bot); c.lineTo(padL + pw, bot); c.stroke();
        c.setLineDash([]);
        c.font = '600 11px "Chakra Petch", monospace';
        c.textAlign = 'right';
        c.fillStyle = rgba(b.color, 0.95);
        c.fillText(String(b.lo), padL - 6, bot);
      }
    }
    c.strokeStyle = 'rgba(255,255,255,0.3)';
    c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(padL, Y(0)); c.lineTo(padL + pw, Y(0)); c.stroke();

    // vertical gradient with hard stops at the thresholds: the line takes the grade color of its speed
    const grad = c.createLinearGradient(0, Y(0), 0, Y(yMax));
    for (let i = 0; i < BANDS.length; i++) {
      const b = BANDS[i];
      grad.addColorStop(clamp01(b.lo / yMax), b.color);
      grad.addColorStop(clamp01((b.hi === Infinity ? yMax : b.hi) / yMax), b.color);
    }
    const tracePath = () => {
      c.beginPath();
      c.moveTo(X(0), Y(pts[0]));
      for (let i = 1; i < m - 1; i++) {
        c.quadraticCurveTo(X(i), Y(pts[i]), (X(i) + X(i + 1)) / 2, (Y(pts[i]) + Y(pts[i + 1])) / 2);
      }
      c.lineTo(X(m - 1), Y(pts[m - 1]));
    };
    tracePath();
    c.lineTo(X(m - 1), Y(0));
    c.lineTo(X(0), Y(0));
    c.closePath();
    c.globalAlpha = 0.22;
    c.fillStyle = grad;
    c.fill();
    c.globalAlpha = 1;
    tracePath();
    c.lineCap = 'round';
    c.lineWidth = 6.5;
    c.strokeStyle = INK;
    c.stroke();
    c.lineWidth = 3.5;
    c.strokeStyle = grad;
    c.stroke();

    // dashed average line + label pill
    const ya = Y(avg);
    c.lineCap = 'butt';
    c.setLineDash([10, 7]);
    c.lineWidth = 5;
    c.strokeStyle = INK;
    c.beginPath(); c.moveTo(padL, ya); c.lineTo(padL + pw, ya); c.stroke();
    c.lineWidth = 2.5;
    c.strokeStyle = '#ffffff';
    c.stroke();
    c.setLineDash([]);
    const label = 'MÉDIA ' + Math.floor(avg) + ' km/h';
    c.font = '400 15px "Lilita One", sans-serif';
    const bw = c.measureText(label).width + 18, bh = 24;
    const bx = padL + pw - bw - 2;
    let by = ya - bh - 6;
    if (by < 1) by = ya + 6;
    roundRect(c, bx, by, bw, bh, 7);
    c.fillStyle = GRADE_COLORS[gradeFor(avg)] || '#fff';
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = INK;
    c.stroke();
    c.textAlign = 'center';
    c.lineWidth = 3.5;
    c.strokeText(label, bx + bw / 2, by + bh / 2 + 1);
    c.fillStyle = '#ffffff';
    c.fillText(label, bx + bw / 2, by + bh / 2 + 1);

    // top-speed marker
    const mx = X(maxI), my = Y(pts[maxI]);
    c.beginPath(); c.arc(mx, my, 5.5, 0, Math.PI * 2);
    c.fillStyle = '#ffffff'; c.fill();
    c.lineWidth = 3; c.strokeStyle = INK; c.stroke();
    const topLabel = 'MÁX ' + Math.round(rawMax);
    c.font = '700 13px "Chakra Petch", monospace';
    const tw = c.measureText(topLabel).width;
    let tx = Math.min(Math.max(mx, padL + tw / 2 + 2), padL + pw - tw / 2 - 2);
    let ty = my - 15 < 8 ? my + 16 : my - 15;
    // keep the label off the average pill
    const hitsPill = () => tx + tw / 2 > bx - 3 && tx - tw / 2 < bx + bw + 3 && ty + 8 > by - 2 && ty - 8 < by + bh + 2;
    if (hitsPill()) ty = ty < my ? my + 16 : my - 15;
    if (hitsPill()) tx = bx - tw / 2 - 8;
    c.lineWidth = 3.5; c.strokeStyle = INK; c.strokeText(topLabel, tx, ty);
    c.fillStyle = '#ffffff'; c.fillText(topLabel, tx, ty);

    // distance axis
    const dist = distance > 0 ? distance : n * 10;
    c.font = '600 12px "Chakra Petch", monospace';
    c.fillStyle = 'rgba(255,255,255,0.75)';
    const ly = H - 10;
    c.textAlign = 'left'; c.fillText('0 m', padL, ly);
    c.textAlign = 'center'; c.fillText(fmtInt(dist / 2) + ' m', padL + pw / 2, ly);
    c.textAlign = 'right'; c.fillText(fmtInt(dist) + ' m', padL + pw, ly);
  }

  const spark = { samples: null, avg: 0, dist: 0, raf: 0 };
  /** Desktop/laptop: if the report is taller than the window (e.g. an extra "NOVA SKIN" line at 720p),
   *  give the chart less height so the whole card still fits without scrolling. Phones keep scrolling. */
  function fitReport() {
    const cv = E.goSpark;
    if (cv.style.height) cv.style.height = '';
    if (!E.goScroll || !E.goCard || window.innerWidth <= 700 || window.innerHeight <= 500) return;
    const cs = getComputedStyle(E.goScroll);
    // layout sizes only (offsetHeight ignores the entrance-animation transforms)
    const need = E.goCard.offsetHeight + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const over = need - E.goScroll.clientHeight;
    if (over > 0) cv.style.height = Math.max(60, cv.offsetHeight - over - 2) + 'px';
  }
  function redrawSpark() {
    spark.raf = 0;
    if (screen !== 'gameover') return;
    fitReport();
    drawSpark(spark.samples, spark.avg, spark.dist);
  }
  // keep the chart crisp when the window changes size while the report is open
  window.addEventListener('resize', () => {
    if (screen === 'gameover' && !spark.raf) spark.raf = requestAnimationFrame(redrawSpark);
  }, { passive: true });

  function showGameOver(stats) {
    const s = stats || {};
    const dist = Math.floor(num(s.distance));
    const rec = Math.floor(num(s.record));
    const avgRaw = num(s.avgKmh);
    const avg = Math.floor(avgRaw);
    const grade = GRADE_COLORS[s.grade] ? s.grade : gradeFor(avgRaw);
    setGradeClass(E.over, grade);

    const vname = s.vehicleName || (vehicles[selIdx] && vehicles[selIdx].name) || '';
    E.goVeh.textContent = vname;
    E.goVeh.hidden = !vname;
    if (E.goMode) E.goMode.hidden = s.mode !== 'infinite';

    let recHtml = '';
    if (s.isNewRecord) {
      recHtml = rec > 0 && rec < dist
        ? 'Recorde anterior: <b>' + fmtInt(rec) + ' m</b> · <b>+' + fmtInt(dist - rec) + ' m</b>'
        : 'Seu novo recorde pessoal!';
    } else if (rec > 0) {
      recHtml = 'Recorde: <b>' + fmtInt(rec) + ' m</b> · faltaram <b>' + fmtInt(Math.max(0, rec - dist)) + ' m</b>';
    }
    E.goRec.innerHTML = recHtml; // numbers only, safe
    E.goStamp.classList.toggle('show', !!s.isNewRecord);

    E.goGrade.textContent = grade;
    E.goWord.textContent = GRADE_WORDS[grade] || '';
    E.goBestAvg.textContent = String(Math.floor(num(s.bestAvgKmh)));
    E.goNewAvg.classList.toggle('show', !!s.isNewAvgRecord);

    E.goTop.textContent = Math.round(num(s.topKmh)) + ' km/h';
    E.goTime.textContent = fmtTime(num(s.time));
    E.goTricks.textContent = fmtInt(num(s.tricks));
    E.goCoins.textContent = fmtInt(num(s.coins));
    E.goFalls.textContent = fmtInt(num(s.falls));
    E.goCps.textContent = fmtInt(num(s.checkpoints));

    let hint = typeof s.nextGradeHint === 'string' ? s.nextGradeHint : '';
    if (!hint && grade === 'S') hint = 'Nota S! Você é uma lenda da velocidade.';
    E.goHintTxt.textContent = hint;
    E.goHint.hidden = !hint;

    // skins unlocked by this run (names; skin objects / ids are accepted too)
    const unl = [];
    if (Array.isArray(s.unlockedSkins)) {
      for (let i = 0; i < s.unlockedSkins.length; i++) {
        const u = s.unlockedSkins[i];
        const key = u && typeof u === 'object' ? u.name || u.id : u;
        if (key == null || key === '') continue;
        let sk = null;
        for (let j = 0; j < skins.length; j++) if (skins[j].name === key || skins[j].id === key) { sk = skins[j]; break; }
        unl.push({ name: sk ? sk.name || sk.id : String(key), sk: sk || (u && typeof u === 'object' ? u : null) });
      }
    }
    if (unl.length) {
      E.goUnlockLbl.textContent = unl.length > 1 ? 'NOVAS SKINS DESBLOQUEADAS:' : 'NOVA SKIN DESBLOQUEADA:';
      let html = '';
      for (let i = 0; i < unl.length; i++) {
        html += '<span class="gu-skin">' + (unl[i].sk ? skinFigure(unl[i].sk) : '') + esc(unl[i].name) + '</span>';
      }
      E.goUnlockNames.innerHTML = html;
    }
    E.goUnlock.hidden = !unl.length;
    if (E.goCard) E.goCard.classList.toggle('has-unlock', unl.length > 0);

    showScreen('gameover'); // visible first so the chart can be sized to its layout box
    spark.samples = s.speedSamples;
    spark.avg = avgRaw;
    spark.dist = dist;
    redrawSpark();
    // canvas text needs the web fonts: redraw once they are ready
    if (doc.fonts && doc.fonts.status !== 'loaded') doc.fonts.ready.then(redrawSpark).catch(() => {});

    // count the hero numbers up
    stopCountUp();
    cu.dist = dist;
    cu.avg = avg;
    cu.ld = cu.la = -1;
    if (reduced()) {
      E.goDist.textContent = fmtInt(dist);
      E.goAvg.textContent = String(avg);
    } else {
      E.goDist.textContent = '0';
      E.goAvg.textContent = '0';
      cu.t0 = performance.now() + 220;
      cu.raf = requestAnimationFrame(cuTick);
      cu.timer = setTimeout(finishCountUp, 1700);
    }
  }

  // ------------------------------------------------------------ touch controls (v3)
  // Floating joystick (left ~44% of the screen), action buttons (right) and camera drag (any other
  // touch on the right). One pointerdown listener on the layer routes each finger by where it lands;
  // pointer capture + window listeners follow it. main reads ui.touch every frame (no auto-throttle).
  const touch = { steer: 0, throttle: 0, brake: 0, jump: false, boost: false, flip: false, spin: false };
  const TKEYS = ['jump', 'boost', 'flip', 'spin'];
  const STICK_ZONE = 0.44; // left share of the screen that spawns the joystick
  const DZ_X = 0.12, DZ_Y = 0.15; // dead zones (fraction of the radius)
  const FULL_X = 0.95, FULL_Y = 0.85; // deflection that already gives full steer / throttle / brake
  const FOLLOW = 1.5; // the base trails a thumb that strays further than this (x radius)
  const HIT_PAD = 10; // px of forgiveness around the round buttons
  const tBtn = Object.create(null), tCount = Object.create(null), tOn = Object.create(null), tHit = Object.create(null);
  E.touch.querySelectorAll('[data-k]').forEach((el) => { tBtn[el.getAttribute('data-k')] = el; });
  for (let i = 0; i < TKEYS.length; i++) {
    const k = TKEYS[i];
    tCount[k] = 0;
    tOn[k] = false;
    tHit[k] = [0, 0, 0]; // cx, cy, r (client px)
  }
  const tPtr = new Map(); // pointerId -> { kind: 'btn' | 'stick' | 'cam' | 'none', key, x, y }
  let rectsDirty = true;
  const stick = { id: -1, bx: 0, by: 0, hx: 0, hy: 0, r: 56, thr: false, brk: false };
  let camId = -1, camDx = 0, camDy = 0;
  const camOut = { dx: 0, dy: 0 };
  let hapticsOn = true;
  const gameEl = $('game');

  // Hit circles + the joystick's home spot are cached (re-read on show/resize) so pointermove never forces layout.
  function cacheRects() {
    rectsDirty = false;
    for (let i = 0; i < TKEYS.length; i++) {
      const k = TKEYS[i], el = tBtn[k], h = tHit[k];
      if (!el) { h[2] = 0; continue; }
      const b = el.getBoundingClientRect();
      h[0] = (b.left + b.right) * 0.5;
      h[1] = (b.top + b.bottom) * 0.5;
      h[2] = Math.max(b.width, b.height) * (el.classList.contains('on') ? 0.5 / 0.9 : 0.5); // undo the pressed scale
    }
    // layout box (ignores the transform of an active / returning stick)
    const s = E.stick;
    if (s && s.offsetWidth) {
      stick.r = s.offsetWidth * 0.5;
      stick.hx = s.offsetLeft + stick.r;
      stick.hy = s.offsetTop + s.offsetHeight * 0.5;
    }
  }
  function hitKey(x, y) {
    let best = '', bs = Infinity;
    for (let i = 0; i < TKEYS.length; i++) {
      const k = TKEYS[i], h = tHit[k];
      if (h[2] <= 0) continue;
      const dx = x - h[0], dy = y - h[1], d = Math.sqrt(dx * dx + dy * dy);
      if (d > h[2] + HIT_PAD) continue;
      const score = d / h[2]; // relative distance: the nearer button wins where the pads overlap
      if (score < bs) { bs = score; best = k; }
    }
    return best;
  }
  // A tap shorter than one frame would be released before main polls ui.touch (lost jump / flip on a
  // 30 fps phone): every press is reported for at least MIN_HOLD ms. The button art still releases at once.
  const MIN_HOLD = 70;
  const tDownAt = Object.create(null);
  let holdTimer = 0;
  function releaseHeld() { holdTimer = 0; syncButtons(false); }
  function syncButtons(force) {
    const now = performance.now();
    let wait = 0;
    for (let i = 0; i < TKEYS.length; i++) {
      const k = TKEYS[i], isOn = tCount[k] > 0;
      if (isOn && !touch[k]) tDownAt[k] = now;
      const left = isOn || force ? 0 : MIN_HOLD - (now - (tDownAt[k] || 0));
      touch[k] = isOn || (touch[k] && left > 0);
      if (!isOn && touch[k] && left > wait) wait = left;
      if (isOn !== tOn[k]) {
        tOn[k] = isOn;
        if (tBtn[k]) tBtn[k].classList.toggle('on', isOn);
      }
    }
    if (force && holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
    if (wait > 0 && !holdTimer) holdTimer = setTimeout(releaseHeld, wait + 1);
  }
  function setKey(p, k) {
    if (p.key === k) return;
    if (p.key) tCount[p.key]--;
    if (k) tCount[k]++;
    p.key = k;
    syncButtons();
  }

  // --- joystick
  const HINT_KEY = 'bobobike.stickHint';
  let hintRuns = 0;
  try { hintRuns = parseInt(localStorage.getItem(HINT_KEY) || '0', 10) || 0; } catch (_) { /* storage blocked */ }
  let stickUsedRun = false;
  function newRun() {
    stickUsedRun = false;
    if (E.tHint) E.tHint.hidden = hintRuns >= 2; // "ARRASTE" over the ghost stick for the first 2 runs
  }
  function placeBase() {
    E.stick.style.transform = 'translate3d(' + (stick.bx - stick.hx).toFixed(1) + 'px,' + (stick.by - stick.hy).toFixed(1) + 'px,0)';
  }
  function stickApply(dx, dy) {
    const R = stick.r;
    // knob stays on the ring
    const d = Math.sqrt(dx * dx + dy * dy);
    const kk = d > R ? R / d : 1;
    E.knob.style.transform = 'translate3d(' + (dx * kk).toFixed(1) + 'px,' + (dy * kk).toFixed(1) + 'px,0)';
    // axes are read independently (square gate): up-right gives full throttle AND full steer
    const nx = dx / R, ny = dy / R;
    const ax = nx < 0 ? -nx : nx;
    let s = ax <= DZ_X ? 0 : Math.min(1, (ax - DZ_X) / (FULL_X - DZ_X));
    s *= 0.6 + 0.4 * s; // slight curve: finer control near the center
    touch.steer = nx < 0 ? -s : s;
    const up = -ny;
    touch.throttle = up > DZ_Y ? Math.min(1, (up - DZ_Y) / (FULL_Y - DZ_Y)) : 0;
    touch.brake = -up > DZ_Y ? Math.min(1, (-up - DZ_Y) / (FULL_Y - DZ_Y)) : 0;
    const thr = touch.throttle > 0, brk = touch.brake > 0;
    if (thr !== stick.thr) { stick.thr = thr; E.stick.classList.toggle('thr', thr); }
    if (brk !== stick.brk) { stick.brk = brk; E.stick.classList.toggle('brk', brk); }
  }
  function stickStart(id, x, y) {
    stick.id = id;
    stick.bx = x;
    stick.by = y;
    E.stick.classList.remove('idle');
    placeBase();
    stickApply(0, 0);
    if (!stickUsedRun) {
      stickUsedRun = true;
      hintRuns++;
      try { localStorage.setItem(HINT_KEY, String(hintRuns)); } catch (_) { /* ignore */ }
    }
  }
  function stickMove(x, y) {
    let dx = x - stick.bx, dy = y - stick.by;
    const lim = stick.r * FOLLOW, d = Math.sqrt(dx * dx + dy * dy);
    if (d > lim) {
      // drag the base along so reversing direction never needs a long trip back
      const f = (d - lim) / d;
      stick.bx += dx * f;
      stick.by += dy * f;
      dx -= dx * f;
      dy -= dy * f;
      placeBase();
    }
    stickApply(dx, dy);
  }
  function stickEnd() {
    stick.id = -1;
    touch.steer = 0;
    touch.throttle = 0;
    touch.brake = 0;
    E.stick.classList.add('idle'); // glides back home
    E.stick.style.transform = '';
    E.knob.style.transform = '';
    if (stick.thr) { stick.thr = false; E.stick.classList.remove('thr'); }
    if (stick.brk) { stick.brk = false; E.stick.classList.remove('brk'); }
  }

  // --- pointer routing
  function onTouchDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // right-drag camera belongs to main
    e.preventDefault();
    if (rectsDirty) cacheRects();
    const id = e.pointerId, x = e.clientX, y = e.clientY;
    if (tPtr.has(id)) endPointer(id);
    const p = { kind: 'none', key: '', x, y };
    const k = hitKey(x, y);
    if (k) {
      p.kind = 'btn';
      setKey(p, k);
      const ua = navigator.userActivation;
      if (hapticsOn && navigator.vibrate && e.isTrusted && (!ua || ua.hasBeenActive)) {
        try { navigator.vibrate(8); } catch (_) { /* ignore */ }
      }
    } else if (x < lastW * STICK_ZONE) { // cached width: window.innerWidth may force a layout
      if (stick.id === -1) { p.kind = 'stick'; stickStart(id, x, y); }
    } else if (camId === -1) {
      p.kind = 'cam';
      camId = id;
    }
    tPtr.set(id, p);
    try { E.touch.setPointerCapture(id); } catch (_) { /* pointer already gone */ }
  }
  function onPtrMove(e) {
    const p = tPtr.get(e.pointerId);
    if (!p) return;
    const x = e.clientX, y = e.clientY;
    if (p.kind === 'stick') stickMove(x, y);
    else if (p.kind === 'cam') { camDx += x - p.x; camDy += y - p.y; }
    else if (p.kind === 'btn') setKey(p, hitKey(x, y)); // fingers may slide between buttons (PULO -> MORTAL)
    p.x = x;
    p.y = y;
  }
  function endPointer(id) {
    const p = tPtr.get(id);
    if (!p) return;
    tPtr.delete(id);
    if (p.kind === 'btn') setKey(p, '');
    else if (p.kind === 'stick' && stick.id === id) stickEnd();
    else if (p.kind === 'cam' && camId === id) camId = -1;
  }
  const onPtrEnd = (e) => endPointer(e.pointerId);
  function clearTouch() {
    tPtr.clear();
    for (let i = 0; i < TKEYS.length; i++) tCount[TKEYS[i]] = 0;
    syncButtons(true); // everything to false right now (no tap hold-over into pause / background)
    stickEnd();
    camId = -1;
    camDx = camDy = 0;
  }
  /** Camera orbit from touch drags, in CSS px accumulated since the previous call (main calls it every frame). */
  function consumeCameraDrag() {
    camOut.dx = camDx;
    camOut.dy = camDy;
    camDx = camDy = 0;
    return camOut;
  }

  E.touch.addEventListener('pointerdown', onTouchDown);
  window.addEventListener('pointermove', onPtrMove, { passive: true });
  window.addEventListener('pointerup', onPtrEnd);
  window.addEventListener('pointercancel', onPtrEnd);
  E.touch.addEventListener('lostpointercapture', onPtrEnd);
  // menu: dragging the 3D scene behind the menu spins the vehicle preview
  window.addEventListener('pointerdown', (e) => {
    if (screen !== 'menu' || e.pointerType !== 'touch' || camId !== -1 || !gameEl || !gameEl.contains(e.target)) return;
    camId = e.pointerId;
    tPtr.set(camId, { kind: 'cam', key: '', x: e.clientX, y: e.clientY });
  }, { passive: true });
  // no long-press menu / callout on the controls (never stopPropagation: main's right-drag camera listens on window)
  E.touch.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('blur', clearTouch);
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) clearTouch(); });
  // URL-bar show/hide only changes the height: keep the stick; a real rotation resets everything
  let lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    rectsDirty = true;
    if (window.innerWidth !== lastW) { lastW = window.innerWidth; clearTouch(); }
  }, { passive: true });
  const onRotate = () => { rectsDirty = true; clearTouch(); };
  window.addEventListener('orientationchange', onRotate, { passive: true });
  try { if (window.screen && screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', onRotate); } catch (_) { /* ignore */ }

  // Compact HUD (speed pill, no gauge / zone pill / turbo bar): touch play, or short / narrow screens.
  const MQ_COMPACT = typeof window.matchMedia === 'function' ? window.matchMedia('(max-height: 520px), (max-width: 760px)') : null;
  let compact = false;
  function updateCompact() {
    const c = touchEnabled || !!(MQ_COMPACT && MQ_COMPACT.matches);
    if (c === compact) return;
    compact = c;
    root.classList.toggle('compact', c);
    if (!c) drawGauge(C.kmh > 0 ? C.kmh : 0); // the gauge skips redraws while hidden
    rectsDirty = true;
  }
  if (MQ_COMPACT) {
    if (typeof MQ_COMPACT.addEventListener === 'function') MQ_COMPACT.addEventListener('change', updateCompact);
    else if (typeof MQ_COMPACT.addListener === 'function') MQ_COMPACT.addListener(updateCompact);
  }

  function setTouch(enabled) {
    touchEnabled = !!enabled;
    root.classList.toggle('is-touch', touchEnabled);
    rectsDirty = true;
    updateCompact();
    if (touchEnabled) setHintTouch(true);
    else clearTouch();
  }

  // Menu/pause/game-over hints (ENTER/ESC keycaps vs touch help) follow the last input modality.
  // Kept separate from setTouch(): main turns the on-screen controls off outside of a run.
  let hintTouch = false;
  function setHintTouch(b) {
    if (b === hintTouch) return;
    hintTouch = b;
    root.classList.toggle('hint-touch', b);
  }
  setHintTouch(typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);
  window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') setHintTouch(true); }, { capture: true, passive: true });

  // ------------------------------------------------------------ input wiring
  // Clicks: one delegated listener for every [data-act] button and the vehicle cards.
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const chip = t.closest('.skchip');
    if (chip) {
      if (e.detail > 0 && typeof chip.blur === 'function') chip.blur();
      pickSkin(chip);
      return;
    }
    const seg = t.closest('.seg-b');
    if (seg) {
      if (e.detail > 0 && typeof seg.blur === 'function') seg.blur();
      sfx('click');
      pickMode(seg);
      return;
    }
    const card = t.closest('.vcard');
    const btn = card || t.closest('[data-act]');
    if (!btn) return;
    if (e.detail > 0 && typeof btn.blur === 'function') btn.blur(); // mouse/touch click: don't keep focus (Space/Enter belong to the game)
    sfx('click');
    if (card) { selectVehicle(card.getAttribute('data-id'), true); return; }
    switch (btn.getAttribute('data-act')) {
      case 'play': emit('play'); break;
      case 'resume': emit('resume'); break;
      case 'restart': emit('restart'); break;
      case 'menu': emit('menu'); break;
      case 'pause': emit('pause'); break;
      case 'prev': cycleVehicle(-1); break;
      case 'next': cycleVehicle(1); break;
      case 'mute': setMuted(!muted); emit('mute', muted); break;
      case 'quality': setQuality(quality === 'high' ? 'low' : 'high'); emit('quality', quality); break;
      case 'end': emit('end'); break;
      case 'haptics': setHaptics(!hapticsOn); emit('haptics', hapticsOn); break;
      case 'fullscreen': emit('fullscreen'); break; // main calls requestFullscreen inside this click
      default: break;
    }
  });

  // Hover blips (mouse only, throttled).
  let hoverEl = null, hoverAt = 0;
  root.addEventListener('pointerover', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (b === hoverEl) return;
    hoverEl = b;
    if (b) {
      const now = performance.now();
      if (now - hoverAt > 70) { hoverAt = now; sfx('hover'); }
    }
  });

  // Keyboard for menu / pause / game over. Game keys during play belong to main.
  // Handled keys are consumed (stopImmediatePropagation) so main's listener never double-acts.
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    // a real keyboard in use -> show keycap hints (only for keys the game uses, not e.g. volume keys)
    if (hintTouch && !e.repeat && k && (k.length === 1 || k.startsWith('Arrow') || k === 'Enter' || k === 'Escape' || k === 'Shift')) setHintTouch(false);
    if (screen !== 'menu' && screen !== 'gameover' && screen !== 'pause') return;
    // Ignore the very keypress that opened this screen (e.g. main pausing on the same Esc).
    if (e.timeStamp > 0 && e.timeStamp < 1e11 && e.timeStamp < screenAt) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Enter/Space on a keyboard-focused (Tab) UI button activates that button, not the screen shortcut.
    // Clicked here because main preventDefaults Space, which would cancel the native activation.
    const ae = doc.activeElement;
    const focusedBtn = (k === 'Enter' || k === ' ') && ae && ae.tagName === 'BUTTON' && root.contains(ae);
    let handled = false;
    if (focusedBtn) {
      if (!e.repeat) ae.click();
      handled = true;
    } else if (screen === 'menu') {
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { sfx('click'); cycleVehicle(-1); handled = true; }
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') { sfx('click'); cycleVehicle(1); handled = true; }
      else if (k === 'Enter') { if (!e.repeat) { sfx('click'); emit('play'); } handled = true; }
    } else if (screen === 'gameover') {
      if (performance.now() - screenAt < 700) return; // don't skip the report with a held jump key
      if (k === 'Enter' || k === ' ' || e.code === 'Space') { if (!e.repeat) { sfx('click'); emit('restart'); } handled = true; }
      else if (k === 'Escape') { if (!e.repeat) { sfx('click'); emit('menu'); } handled = true; }
    } else if (k === 'Escape') { // pause
      if (!e.repeat) emit('resume');
      handled = true;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  });

  // ------------------------------------------------------------ initial state
  if (!root.classList.contains('scr-loading')) root.classList.add('scr-loading');
  C.maxLives = CONFIG.maxLives | 0;
  buildHearts(C.maxLives);
  setMuted(false);
  setQuality('high');
  setHaptics(true);
  if (MODE_ORDER && MODE_ORDER[0]) setMode(MODE_ORDER[0]);
  if (fsOK) syncFullscreen();
  newRun();
  updateCompact();

  return {
    showScreen,
    on,
    setVehicles,
    setSkins,
    setRecords,
    updateHUD,
    zoneBanner,
    toast,
    countdown,
    flashDamage,
    checkpoint,
    showGameOver,
    setMuted,
    setQuality,
    setTouch,
    touch,
    consumeCameraDrag,
    setMode,
    setHaptics,
    setLoading,
  };
}
