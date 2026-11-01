// Shared tuning constants. Units: meters, seconds, radians. 1 unit = 1 m.
export const CONFIG = {
  gravity: 34,
  startLives: 3,
  lifeEveryCheckpoints: 3, // +1 life every N checkpoints
  maxLives: 6,            // cap
  checkpointEvery: 150,   // meters of track between checkpoints
  zoneLength: 620,        // meters per zone (theme change)
  zoneBlend: 70,          // meters over which sky/fog blend into the next zone
  boostMultiplier: 1.38,  // top speed multiplier while turbo/boost pad is active
  killY: 26,              // fall this far below the last ground to die
  // Average-speed grade thresholds (km/h). Highest first.
  grades: [
    { grade: 'S', min: 84 },
    { grade: 'A', min: 66 },
    { grade: 'B', min: 48 },
    { grade: 'C', min: 30 },
    { grade: 'D', min: 0 },
  ],
  storageKey: 'bobobike.v1',
};

// Vehicle handling. bars (1..5) are for the menu stat display.
export const VEHICLE_STATS = {
  bike: {
    id: 'bike', name: 'BMX Turbo', tagline: 'Equilibrada. Pedala até voar.',
    maxSpeed: 31, accel: 17, brake: 30, turnRate: 2.8, turnRateHigh: 1.7, jump: 12.8, airControl: 0.8,
    bars: { speed: 4, accel: 3, handling: 3, jump: 3 },
  },
  scooter: {
    id: 'scooter', name: 'Scooter Elétrica', tagline: 'Motor no talo. Curva com respeito.',
    maxSpeed: 35, accel: 14, brake: 28, turnRate: 2.5, turnRateHigh: 1.45, jump: 12.2, airControl: 0.7,
    bars: { speed: 5, accel: 2, handling: 2, jump: 2 },
  },
  kick: {
    id: 'kick', name: 'Patinete Pro', tagline: 'Leve, ágil e pula alto.',
    maxSpeed: 27.5, accel: 21, brake: 34, turnRate: 3.2, turnRateHigh: 2.05, jump: 13.8, airControl: 0.95,
    bars: { speed: 3, accel: 5, handling: 5, jump: 5 },
  },
};
export const VEHICLE_ORDER = ['bike', 'scooter', 'kick'];

// Game modes. Infinite-lives runs keep their own records and do not unlock skins.
export const MODES = {
  normal: { id: 'normal', name: 'Normal', desc: '3 vidas, +1 a cada 3 checkpoints. Vale recorde e desbloqueia skins.' },
  infinite: { id: 'infinite', name: 'Vidas Infinitas', desc: 'Treine sem game over. Recordes separados.' },
};
export const MODE_ORDER = ['normal', 'infinite'];

// Rider skins (Roblox R6 style). unlock = best distance (m) needed; 0 = free.
// acc: accessory on the head — 'none' | 'bacon' | 'long' | 'cap' | 'bandana' | 'antenna' | 'crown'
// face: 'smile' | 'happy' | 'cool' | 'ninja' | 'robot'
// metal: 0..1 extra shine for the body parts; vehicle: optional vehicle body tint.
export const SKINS = [
  { id: 'noob', name: 'Noob Clássico', unlock: 0, head: '#f5cd30', torso: '#0d69ac', arms: '#f5cd30', legs: '#a4bd47', face: 'smile', acc: 'none', accColor: '#000000' },
  { id: 'bacon', name: 'Cabelo de Bacon', unlock: 0, head: '#ffcc99', torso: '#2f9e5b', arms: '#ffcc99', legs: '#22304f', face: 'happy', acc: 'bacon', accColor: '#7a4520' },
  { id: 'pop', name: 'Estrela Pop', unlock: 0, head: '#ffd9b8', torso: '#ff5fa2', arms: '#ffd9b8', legs: '#f4f1ff', face: 'happy', acc: 'long', accColor: '#ff8fc8' },
  { id: 'guest', name: 'Visitante', unlock: 0, head: '#e8c9a0', torso: '#1c1c22', arms: '#e8c9a0', legs: '#1c1c22', face: 'smile', acc: 'cap', accColor: '#121216' },
  { id: 'ninja', name: 'Ninja das Sombras', unlock: 500, head: '#1d1d26', torso: '#1d1d26', arms: '#1d1d26', legs: '#1d1d26', face: 'ninja', acc: 'bandana', accColor: '#e63946' },
  { id: 'robo', name: 'Robô Turbo', unlock: 1200, head: '#c3ccd6', torso: '#5b6b7c', arms: '#c3ccd6', legs: '#3e4a57', face: 'robot', acc: 'antenna', accColor: '#00e5ff', metal: 0.6 },
  { id: 'ouro', name: 'Lenda Dourada', unlock: 2500, head: '#ffd23f', torso: '#ffb703', arms: '#ffd23f', legs: '#e09f00', face: 'cool', acc: 'crown', accColor: '#fff3b0', metal: 0.85, vehicle: '#ffcc33' },
];
export const SKIN_BY_ID = Object.fromEntries(SKINS.map((s) => [s.id, s]));

export function gradeFor(kmh) {
  for (const g of CONFIG.grades) if (kmh >= g.min) return g.grade;
  return 'D';
}
