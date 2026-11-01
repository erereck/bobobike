# bobobike — architecture spec (game name is always lowercase: "bobobike")

The game is called **bobobike** (always lowercase, never "Obby Rush"). A 3D endless, procedurally generated Roblox-style obby ridden on a BMX, an electric
scooter or a kick scooter ("patinete"). Goal: beat your distance record. The end screen
shows average speed (with a grade S/A/B/C/D) to push players to never slow down.
All UI text is **Brazilian Portuguese**. Runs in a browser (desktop + mobile touch), as a
multi-file static site (later published as a claude.ai Artifact).

Target: 60 fps on a mid laptop. Performance rules apply to EVERY module:
- No allocations in per-frame code paths (reuse module-level temp Vector3/Color/Matrix4).
- Few draw calls: use InstancedMesh / merged geometry / Points. One material per kind.
- No per-frame DOM layout thrash: only write textContent/style when the value changed.
- Each module exports a factory. No side effects at import time other than constants.
- Two quality levels: `'high'` and `'low'` (low: no shadows, fewer particles/clouds, no bloom).

## Tech
- Three.js **0.160.0** via importmap (in index.html):
  - `"three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"`
  - `"three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"`
- Modules import `import * as THREE from 'three';`
- No other libraries. No images/audio files: everything procedural (canvas textures, shaders, WebAudio synthesis).
- Renderer: `outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`, shadows `PCFSoftShadowMap`.

## Coordinates & conventions
- Y up. 1 unit = 1 meter. Speed shown in km/h = m/s × 3.6.
- Heading `yaw` rotates around +Y. `yaw = 0` faces **-Z**. forward = `(-sin yaw, 0, -cos yaw)`.
  A THREE object with `rotation.y = yaw` has its local -Z pointing forward.
- The track starts at the origin and heads roughly toward -Z (it curves left/right but stays within ±70° of -Z).

## Files & owners
| file | owner | purpose |
|---|---|---|
| `index.html` | UI builder | page fragment (no `<!doctype>/<html>/<head>/<body>` tags — the host wraps it), title, fonts, importmap, CSS, DOM for HUD/menus, `<script type="module" src="js/main.js">` |
| `js/ui.js` | UI builder | all DOM/HUD/menu logic |
| `js/vehicles.js` | vehicle builder | blocky vehicle + Roblox-style rider models and their animation |
| `js/environment.js` | environment builder | sky, sun, lights, shadows, fog, clouds, cloud sea, stars, aurora, distant islands |
| `js/audio.js` | audio builder | all synthesized sound + procedural music |
| `js/fx.js` | fx builder | particles, speed lines, trail, confetti |
| `js/config.js`, `js/themes.js` | core (exists) | shared constants, vehicle stats, zone themes — **read these** |
| `js/track.js`, `js/player.js`, `js/main.js` | core | generator, collision, physics, camera, game loop, input, post-processing |

---

## js/vehicles.js
```js
export function createVehicle(type /* 'bike'|'scooter'|'kick' */, opts = { shirtColor: '#0d69ac' }) => rig
rig = {
  type,
  group,            // THREE.Group. Main sets group.position (contact point on ground) and group.quaternion (yaw + slope).
  update(dt, s),    // animate internals; s described below
  breakApart(vel),  // Roblox-style death: rider + vehicle parts detach and fly/tumble outward (vel: THREE.Vector3 world velocity to inherit). Pieces animate inside update() for ~2 s.
  reset(),          // reassemble instantly (after respawn)
  setOpacity(a),    // 0..1 (used for respawn blink / ghost); a<1 => transparent materials
  dispose(),
}
s = {
  speed,        // signed forward speed m/s
  steer,        // -1..1 (positive = turning right)
  throttle,     // 0..1
  grounded,     // bool
  lean,         // radians, positive = lean right; main computes it — apply to an inner pivot around the contact line
  landImpact,   // 0..1, set >0 on the frame of landing (squash suspension / rider crouch, decays internally)
  boosting,     // bool (scooter: glow/exhaust flicker; bike: rider tucks low)
  trickSpin,    // radians, rotate the whole visual (vehicle+rider) around local Y about a pivot ~0.9 m high
  trickFlip,    // radians, rotate around local X about the same pivot (positive = backflip, nose up)
  time,         // seconds since start (for idle anims)
}
```
- Origin = ground contact point, centered between wheels, facing -Z. Wheelbase ~1.1–1.3 m. Wheel radius: bike 0.36, scooter 0.22, kick 0.12.
- Rider: classic Roblox R6 "noob" proportions — blocky head (yellow `#f5cd30`, with a smiley face drawn on a canvas texture), torso (shirt color, default `#0d69ac`), yellow arms, green legs `#a4bd47`. Total height (vehicle + rider) ≈ 2.0–2.3 m.
- Bike: frame tubes, fork, handlebar, seat, crank + pedals, tires with spokes (thin boxes), rider sitting & **pedaling** (legs driven by wheel angle), hands on the bars.
- Scooter (electric moped/Vespa-like): rounded body (boxes + cylinders), seat, headlight (emissive), small wheels, rider seated; when boosting, a tail glow/exhaust strip emissive pulse.
- Kick (patinete): deck, stem, T-bar, tiny wheels, rider standing; **kick animation** (one leg pushes back) when throttle>0 and speed < 75% of max; otherwise standing crouched.
- All: wheels spin from speed (`angle += speed/radius*dt`), handlebar/fork steers with `steer` (±0.4 rad), body leans with `lean`, landing squash, idle bob, airborne pose (arms up a bit) and trick rotations.
- Keep each vehicle < 6k triangles. `MeshStandardMaterial` (roughness ~0.55, metalness 0–0.3). Share geometries/materials within a rig. `castShadow = true` on main meshes.
- breakApart: collect the main visible meshes (head, torso, arms, legs, wheels, frame pieces), re-parent them to the group root preserving world transform, give each a random velocity (+ inherited vel, mostly upward/outward 4–9 m/s) and angular velocity, integrate with gravity 34 m/s² for ~2 s, they may fall below. reset() restores original parents/transforms.

## js/environment.js
```js
export function createEnvironment({ scene, renderer, quality }) => env
env = {
  sun,                       // THREE.DirectionalLight (already added to scene along with its target)
  update(dt, time, focus /* Vector3 player position */, camera),
  setZoneBlend(zoneA, zoneB, t), // zone objects from themes.js; t in 0..1 blends A->B. Called every frame — must early-out if unchanged (compare A, B, quantized t).
  setQuality(q),             // 'high' | 'low'
  getFogColor(),             // THREE.Color currently applied
}
```
- Sky dome: big sphere (radius ~900, `BackSide`, `depthWrite:false`, `fog:false`) that follows the camera position every frame. ShaderMaterial: vertical 3-color gradient (bottom/horizon/top), sun disc + soft glow in sun direction, **stars** (procedural hash in shader, twinkle, faded by `stars`), **aurora** (animated ribbons near the horizon in green/purple, by `aurora`), **nebula** (soft colored noise clouds, by `nebula`). All uniforms lerped between the two zones.
- `scene.fog = new THREE.Fog(color, near, far)` blended per zone; also `renderer.toneMappingExposure` from `exposure`.
- HemisphereLight (sky/ground/intensity per zone) + DirectionalLight sun (color/intensity per zone; direction from elevation/azimuth where azimuth 0 = toward -Z... any consistent mapping; the sun should generally be ahead-left/right so shadows fall toward the camera side diagonally).
- Shadows (quality high): mapSize 2048, orthographic shadow camera ±38 m, near 1, far 200, `bias -0.0004`, `normalBias 0.02`. The light and its target follow `focus` each frame; **snap the light target to the shadow texel grid** (in light space) to prevent shimmering. quality low: `castShadow=false`.
- Cloud sea: large plane (~1600 m) at `focus.y - 90` following focus in XZ (snap to 50 m grid to avoid texture swimming, use world-position-based noise in shader), soft animated fbm cloud tops, color `cloudSea`, fades into fog color with distance. This is what you fall into.
- Floating clouds: one InstancedMesh of puffy low-poly blobs (each cloud = a few merged icospheres, or an icosphere instance cluster), ~60 instances (low: 25), recycled in a ring 60–420 m around focus, **always at least 14 m below or 22 m above focus.y** so they never block the track. Slow drift. Color `cloud`, slight emissive so they read at night.
- Distant floating islands: ~12 instanced low-poly islands (rock cone + grassy/neon top) 350–700 m away, recycled; fog makes them silhouettes.
- Everything that moves with focus must be cheap: only update instance matrices for recycled items.

## js/audio.js
```js
export function createAudio() => audio
audio = {
  unlock(),                     // call on first user gesture: create/resume AudioContext; safe to call repeatedly
  setMuted(b), isMuted(),
  startMusic(), stopMusic(),
  setZone(zoneIndex),           // musical variation per zone (key/scale/instrument tint), switch at next bar
  setMusicIntensity(x),         // 0..1 (speed-based): adds layers (arp, hats, lead) progressively
  setEngine({ vehicle, speed01, throttle, grounded, boosting }), // every frame; smooth params with setTargetAtTime; no node creation per frame
  play(name, opts),             // one-shots, see list
}
```
One-shot names: `jump`, `land` (opts.intensity 0..1), `boost` (pad/turbo whoosh), `jumppad` (spring boing), `checkpoint` (bright chime), `coin` (ding), `trick` (opts.level 1..4, rising fanfare), `trickFail` (wobble), `oof` (Roblox-style "oof" vocal-ish synthesized with formants + pitch drop), `respawn`, `record` (big fanfare), `countdown` (opts.n = 3/2/1 beep), `go` (higher beep), `click`, `hover`, `gameover`, `whoosh` (near-miss/air), `zone` (sweeping riser for zone change).
- Everything synthesized with WebAudio (oscillators, noise buffers created once, filters, envelopes). Master compressor + master gain. Separate music & sfx buses.
- Music: upbeat chiptune/synthwave loop (~128–140 BPM), lookahead scheduler (setInterval ~25 ms, schedule 0.12 s ahead). Drums (kick: sine pitch drop; snare/hats: filtered noise), bass, chord pads, arpeggio, lead melody generated from a seeded pattern per zone. Keep it pleasant, not harsh; cap polyphony.
- Engine: bike = rolling tire noise + freewheel ticks rate ∝ speed (when throttle 0) ; scooter = electric motor whine (two detuned saws/triangle through lowpass, pitch ∝ speed) ; kick = deck/wheel rumble. Plus wind noise (bandpassed) ∝ speed for all. Engine silent when airborne except wind.
- Must not throw if AudioContext unavailable (no-op object).

## js/fx.js
```js
export function createFX({ scene, camera, quality }) => fx
fx = {
  update(dt, ctx),  // ctx = { playerPos: Vector3, playerVel: Vector3, speed01, boosting, grounded, camera, time }
  burst(type, pos, opts = {}), // 'dust' {intensity,color}, 'sparks' {color,count}, 'confetti' {count}, 'coin' (gold sparkle), 'boost' (streak burst behind), 'ring' {color} (expanding flat ring), 'puff' (big cloud splash when falling in the cloud sea), 'stars' (trick success sparkle) 
  setQuality(q),
  clear(),
}
```
- One pooled particle system as `THREE.Points` with a custom ShaderMaterial (per-particle color, size, alpha, size attenuation, soft round sprite drawn in shader, additive or normal blending variants => at most 2 Points objects). Capacity 3000 (low 1200). Typed arrays, update only live range, `frustumCulled = false`.
- Confetti: an InstancedMesh of small quads (400) with tumbling rotation, gravity, drag, multicolor.
- Speed lines: InstancedMesh of thin long quads (60, low 25) placed in a cylinder around the camera's forward axis that stream past the camera; opacity ∝ max(0, speed01-0.45)*2 and stronger when boosting. Must be cheap.
- Trail: a ribbon (BufferGeometry, ~48 segments) following the player's rear position, additive, fading tail, colored cyan normally / orange-pink when boosting, only visible above ~60% speed.

## js/ui.js (+ index.html, CSS)
```js
export function createUI() => ui
ui = {
  showScreen(name),            // 'loading' | 'menu' | 'hud' | 'pause' | 'gameover' (hud also visible under pause/gameover? no: only one overlay; hud hidden on menu)
  on(event, cb),               // events: 'play', 'vehicle' (id), 'resume', 'restart', 'menu', 'mute', 'quality', 'pause'
  setVehicles(list /* VEHICLE_STATS values in VEHICLE_ORDER */, selectedId),
  setRecords({ bestDistance, bestAvgKmh, bestTopKmh, runs }),
  updateHUD(h),                // every frame; h = { distance, record, speedKmh, avgKmh, lives, maxLives, turbo /*0..1*/, boosting, coins, time, zoneNum, zoneName, recordBeaten, multiplier }
  zoneBanner(zoneNum, name, accent),
  toast(text, kind),           // kinds: 'trick' | 'good' | 'bad' | 'record' | 'info' ; stack/animate, auto-remove
  countdown(v),                // 3,2,1,'VAI!'
  flashDamage(),
  checkpoint(n),
  showGameOver(stats),         // see below
  setMuted(b), setQuality(q),
  setTouch(enabled),           // show on-screen controls
  touch,                       // live object: { steer:-1..1, throttle:bool, brake:bool, jump:bool, boost:bool, flip:bool, spin:bool }
  setLoading(p),               // 0..1
}
stats = { distance, record, isNewRecord, avgKmh, bestAvgKmh, isNewAvgRecord, topKmh, time, tricks, coins, falls, checkpoints, grade, speedSamples /* number[] km/h every 10 m */, vehicleName, nextGradeHint /* e.g. 'Mantenha 62 km/h de média para nota A' or '' */ }
```
- Visual direction: chunky, playful Roblox-obby energy but polished: thick dark outlines, beveled 3D-looking buttons with a bottom "lip" that press down on click, bold rounded display font (**Lilita One**), numbers in **Chakra Petch** (tabular-nums), body **Nunito**. Single deliberate (game) look; set explicit colors, body background `#0b0d17`.
- HUD (all `pointer-events:none` except buttons): top-left big distance `1234 m` with record line under it and a thin progress bar toward the record (turns gold + "NOVO RECORDE!" pill once beaten); top-right lives as blocky hearts + coins; bottom-center **speedometer**: an arc gauge (SVG or canvas, redraw cheaply) with big km/h number, under it the **live average speed** with its current grade letter colored (S gold, A green, B blue, C orange, D red); bottom-right turbo bar (glows when full, label "TURBO [SHIFT]"); top-center zone pill "ZONA 3 · Noite Neon" + timer.
- Menu: big logo "bobobike" (lowercase) (CSS 3D-ish stacked text-shadow), tagline, 3 vehicle cards (name, tagline, stat bars speed/aceleração/controle/pulo) selectable by click or ←/→, big "JOGAR" button (Enter), records panel (recorde de distância, melhor média, velocidade máx., corridas), controls panel: W/↑ acelerar, S/↓ frear, A/D virar, ESPAÇO pular, SHIFT turbo, Q mortal (flip), E giro 360, R voltar ao checkpoint, ESC pausar, M som. Buttons for sound and quality (Alta/Baixa). The 3D scene renders behind the menu (leave the center/right area visually open so the vehicle preview shows; menu panels on the left side and bottom on desktop; stacked on mobile).
- Game over: "FIM DA CORRIDA" header, huge distance, "NOVO RECORDE!" stamp animation if new, **average speed as the hero stat** with grade letter in a big badge, best average, top speed, time (mm:ss), tricks, coins, falls; a **speed-over-distance sparkline** drawn on canvas from speedSamples with the average as a dashed line; `nextGradeHint`; buttons "JOGAR DE NOVO" (Enter/Space) and "MENU" (Esc).
- Pause: "PAUSADO", Continuar / Recomeçar / Menu.
- Touch controls (shown when `setTouch(true)`): left: ◀ ▶ big buttons; right: PULO (big), TURBO, FREIO, small TRUQUE buttons (MORTAL, GIRO). Use pointer events with multi-touch, update `ui.touch`. Throttle is automatic on touch (main handles), so no throttle button.
- Respect `prefers-reduced-motion` for non-essential UI animations. Must work at 400 px width.
- index.html must contain, in this order: `<title>bobobike</title>`, `<meta name="claude:viewport-fit-sides" content="cover">`, Google Fonts link, `<style>`, the importmap `<script type="importmap">`, DOM, then `<script type="module" src="js/main.js"></script>`. A `<div id="game"></div>` full-screen container (position fixed, inset 0) where main.js appends the canvas, under the UI layers. Respect safe-area insets for HUD edges. `html,body{height:100%;overflow:hidden;touch-action:none;user-select:none}`.

## Core (main.js / track.js / player.js) — for reference
- Track: procedural pieces (straights, gaps, ramps, narrow beams, kill bricks, slaloms, moving platforms, spinning kill bars, boost pads, jump pads, stepping pillars, curves, drops, falling tiles, checkpoints, coins). Rendered with InstancedMesh + world-space stud shader. Colliders: oriented boxes & ramps in a spatial hash.
- Player: arcade vehicle physics at fixed 120 Hz; tricks (Q flip, E spin) in air; turbo (Shift) fed by tricks/coins/pads; 3 lives; checkpoint respawn.
- main: renderer, camera (chase cam, FOV ↑ with speed), EffectComposer + UnrealBloomPass (high quality), game state machine, input (keyboard, gamepad, touch), localStorage records.

---

## v2 additions (skins, model upgrade, rename) — contract

### Skins
`SKINS` / `SKIN_BY_ID` live in `js/config.js` (read it). Each skin:
`{ id, name, unlock /*best distance m, 0 = free*/, head, torso, arms, legs /*hex*/, face: 'smile'|'happy'|'cool'|'ninja'|'robot', acc: 'none'|'bacon'|'long'|'cap'|'bandana'|'antenna'|'crown', accColor, metal? /*0..1*/, vehicle? /*hex tint for the vehicle body*/ }`

### js/vehicles.js (v2)
- `createVehicle(type, { skin })` — `skin` is a SKINS entry (fallback: SKIN_BY_ID.noob; keep accepting legacy `{ shirtColor }`).
- New `rig.setSkin(skin)` — swaps colors, face texture, accessory and vehicle tint IN PLACE (no rebuild, no leaks: dispose replaced textures/geometries). Must work while breakApart pieces are flying or after reset().
- Rider must read clearly as a Roblox R6 avatar: R6 proportions (head ≈ 1.2×1.2×1.2 rounded "cylinder-ish" block, torso 2×2×1, arms and legs 1×2×1, scaled to the vehicle), subtle bevels (RoundedBoxGeometry from `three/addons/geometries/RoundedBoxGeometry.js` is fine), crisp face decal on the front of the head only (canvas 256 px), the accessory meshes listed above, and `metal` → metalness/roughness on body materials.
- All existing API and animations unchanged.

### js/ui.js + index.html (v2)
- Name is **bobobike** (lowercase) everywhere: `<title>bobobike</title>`, logo, aria labels, comments.
- `ui.setSkins(list, selectedId, bestDistance)` — skin picker in the menu: a row of skin chips (tiny CSS R6 figure colored from the skin), selected name shown, locked skins show a padlock + "Recorde {unlock} m". Clicking an unlocked chip emits `'skin'` with the id. Locked chips are not selectable (shake animation + hint).
- `showGameOver(stats)` gets `stats.unlockedSkins` (array of skin names, may be empty): show a celebratory "NOVA SKIN DESBLOQUEADA" line when non-empty.
- Controls panel adds: "BOTÃO DIREITO + arrastar · girar câmera" and "RODINHA · zoom".
- Game-over card must fit in 1280×720 and 1366×768 without scrolling, with "JOGAR DE NOVO" and "MENU" visible; at phone sizes it may scroll but the two buttons stay reachable (sticky footer).
- Lives: start with `CONFIG.startLives` (3), +1 every `CONFIG.lifeEveryCheckpoints` (3) checkpoints, capped at `CONFIG.maxLives` (6). main passes `hud.maxLives = max(3, lives)`, so the heart row grows when a life is earned.

---

## v3 — game modes + mobile overhaul (contract)

### Game modes (`MODES`, `MODE_ORDER` in config.js)
- `ui.setMode(id)` — menu shows a two-option segmented toggle right above the JOGAR button: **Normal** / **Vidas Infinitas** (with the mode `desc` as a one-line hint). Clicking emits `'mode'` with the id. Keyboard: Tab-focusable; no new global hotkey.
- `ui.setRecords({ bestDistance, bestAvgKmh, bestTopKmh, runs, infBestDistance, infBestAvgKmh })` — the existing panel shows the normal records; when `infBestDistance > 0` add a small line "Infinito: {dist} m · média {avg} km/h".
- `ui.updateHUD(h)` — new field `h.infinite` (bool). When true the hearts are replaced by a single ∞ badge (no hearts, no pop animations).
- Pause screen: new button **ENCERRAR CORRIDA** emitting `'end'` (all modes). Main then shows the game-over report.
- `ui.showGameOver(stats)` — new `stats.mode` ('normal' | 'infinite'). In infinite mode show a small "VIDAS INFINITAS" badge next to the vehicle name and the record line compares against the infinite record (main passes the right `record`).

### Touch controls v3 (replaces the old touch layer — NO auto-throttle anymore)
`ui.touch` (live object read every frame by main):
`{ steer: -1..1, throttle: 0..1, brake: 0..1, jump: bool, boost: bool, flip: bool, spin: bool }`
- **Floating joystick** (Roblox-mobile style) in the left ~42% of the screen: a touch there (not on another control) spawns the base at the touch point; the knob follows within radius R ≈ min(70px, 11vmin). x → `steer` (deadzone 0.12, slight response curve), up → `throttle`, down → `brake` (deadzone 0.15 on y). Releasing resets to 0. When idle, a faint ghost joystick sits at its default spot (bottom-left, safe-area aware) with a tiny "ARRASTE" hint for the first 2 runs (localStorage flag, try/catch).
- **Right-side buttons**: PULO (largest, bottom-right corner), TURBO (shows the turbo level as a ring/fill, driven by `updateHUD` `h.turbo`, glows when full), MORTAL and GIRO (smaller, above PULO). Semi-transparent at rest (~0.55), solid when pressed, scale-down press animation. Sizes in vmin so they scale with the phone; respect `env(safe-area-inset-*)`.
- **Camera drag**: a touch that starts on the right half of the screen and not on a control orbits the camera. `ui.consumeCameraDrag()` returns `{ dx, dy }` in CSS pixels accumulated since the last call and resets them; main calls it every frame.
- Multi-touch: joystick + any button + camera drag at the same time (pointer events with pointerId tracking, `setPointerCapture`, `touch-action: none`).
- `ui.setTouch(enabled)` — show the layer only during play/countdown (main controls it).
- Settings (in the menu's top-right settings row and in pause): **VIBRAÇÃO** on/off (`ui.setHaptics(b)`, emits `'haptics'`), **TELA CHEIA** button (emits `'fullscreen'`; hidden when `document.fullscreenEnabled` is false). Keep SOM and QUALIDADE.

### Mobile HUD (applies when touch mode is on, or on short/narrow screens: `max-height: 520px` or `max-width: 760px`)
The HUD must not cover the track. In compact mode:
- Top-left: distance (smaller) + thin record progress line. Top-right: lives (or ∞) + coins + pause button, all compact.
- Speed: a compact pill at top-center: "{km/h} km/h · MÉDIA {avg} [grade badge]" — replaces the big arc gauge (hide the gauge).
- Hide the zone pill and timer during play (the zone banner still announces zone changes, thinner).
- Turbo: no separate bar; the TURBO button shows it.
- Toasts: smaller, under the speed pill, max 2 visible at once.
- Countdown and zone banner scaled down.
- Portrait phones work too: same layout, joystick bottom-left, buttons bottom-right.
- Menu / pause / game over on phones: comfortable tap targets (≥ 44px), scrollable where needed, primary buttons always reachable.

### Main responsibilities (lead)
Infinite mode logic and separate records (`store.infBestDistance`, `store.infBestAvgKmh`), skins unlock only from normal-mode records, `'end'` → game over, joystick input (analog throttle/brake/steer), camera drag from `consumeCameraDrag()`, haptics via `navigator.vibrate`, Screen Wake Lock during play, fullscreen + landscape orientation lock attempt, wider FOV in portrait.

---

## v4 — piece packs (more track variety)

New pieces live in **piece packs**: `js/pieces/motion.js`, `js/pieces/terrain.js`, `js/pieces/surfaces.js`, `js/pieces/setpieces.js`.
Each pack `export default [ ...pieceDefs ]` (no imports from track.js — everything comes through `ctx`).

```js
{
  name: 'm_elevators',            // unique, prefixed by pack: m_ / t_ / s_ / x_
  weight: (d01) => 0.8,           // relative pick weight; d01 = difficulty 0 (start) .. 1 (5.2 km)
  minDist: 300,                   // optional: never before this distance (m)
  early: false,                   // optional: allowed in the friendly first 260 m
  gen(ctx) { ... },               // builds the piece starting at the cursor, leaves the cursor at its end
}
```

### ctx API (cursor-local coordinates: `lx` lateral, + = right; `lf` forward from the cursor; `dy` height relative to the cursor's road top)
- `ctx.KIND` — SOLID, KILL, BOOST, JUMP (launch pad), CHECK, FALL (crumbling), DECOR, CONVEYOR, ICE, BOUNCE (trampoline)
- `ctx.rng()` (seeded — ALWAYS use it, never Math.random), `ctx.d01`, `ctx.cur` (copy of {x,y,z,yaw,dist}), `ctx.MAX_YAW` (1.15 rad)
- `ctx.W()` standard road width for the current difficulty; `ctx.pickColor()`, `ctx.shade(color)`, `ctx.col3('#hex')`, `ctx.colors.{KILL,BOOST,JUMP,FALL,WHITE,KERB_DARK,CONVEYOR,ICE,BOUNCE,LASER}`, `ctx.zone()` (current theme)
- `ctx.slab(kind, a, b, w, o)` — platform from forward `a` to `b`, width `w`, top at `cur.y + (o.dy||0)`; `o`: `{ off (lateral), dy, th (thickness, default 1.4), color, pool: 'static'|'dyn', yaw (offset), noDist }`. Returns the collider. Road-like kinds count toward distance automatically.
- `ctx.ramp(a, b, w, rise, color)` — wedge rising forward.
- `ctx.box(kind, lx, lf, dy, w, h, d, o)` — any box with its CENTER at (lx, lf, cur.y+dy). `o`: `{ yaw, color, pool:'dyn', laser:true (glowing beam look; use with KILL), dist:true (road-like box that counts toward distance) }`.
- `ctx.decor(lx, lf, dy, w, h, d, o)` — visual-only block (no collision): towers, arms, arches, scenery. `o.pool:'dyn'` if it moves.
- `ctx.move(col, spec)` — motion (collider must be `pool:'dyn'` to render the motion):
  - `{ type:'slide', axis:'x'|'y'|'z', amp, speed, phase }` (x = lateral, z = forward, y = vertical; sinusoidal, speed in rad/s)
  - `{ type:'spin', speed, phase }` — turntable / spinning bar around its center (riders on a spinning platform are carried and turned)
  - `{ type:'pendulum', length, amp (rad), speed, phase, axis:'x'|'z', fraction }` — hangs from a pivot `length` above the box; `fraction` 0.5 for an arm (use a DECOR box for the arm with the same params)
  - `{ type:'blink', on, off, phase }` — collider toggles on/off (lasers); flickers 0.45 s before switching on
  - `{ type:'orbit', radius, speed, phase }` — circles around its start position
  Riders are carried by every moving platform type.
- `ctx.conveyor(col, speed)` — conveyor push in m/s along the collider's local forward (negative = backwards). Use with KIND.CONVEYOR so it shows moving chevrons (chevrons point to local forward: give the collider a yaw that matches the push direction, e.g. `yaw: Math.PI/2` for a sideways belt).
- `ctx.advance(len, dy)`, `ctx.turn(dyaw)`, `ctx.setYaw(abs)` (clamped to ±MAX_YAW)
- `ctx.addCoin(lx, lf, h)`, `ctx.coinLine(f0, f1, lx, n)`, `ctx.addRing(lx, lf, h)` — turbo ring (fly through its center for +turbo; ring radius ≈1.6 m, faces the track direction)
- `ctx.banner(lf, w, [line1, line2], bg, fg, glow)` — named arch across the road (one canvas texture each; max one per piece).

### Physics facts (for fair design)
gravity 34 m/s²; jump vy 12.2–13.8 (apex ≈2.2–2.8 m, flat airtime ≈0.75 s); top speeds 27.5–35 m/s, ×1.38 with turbo (up to ~48 m/s); boost pads set ≥1.15×max; jump pad vy 21 (+≥19 m/s forward); bounce pad vy ≥15; step-up 0.5 m (higher faces are walls); ledge forgiveness 0.35 m; kill hitbox is 0.22 m smaller than it looks; S brakes hard in the air; air control is strong. Crumbling tiles fall 0.8 s after touch. Conveyors carry at their speed; ice: almost no side grip, half acceleration.

### Rules
1. Start at the cursor with a solid entry (≥ 6 m, wide `ctx.W()`), end with a solid exit (≥ 8 m); total length 30–130 m; never build behind the cursor start (lf ≥ -1).
2. Always move forward; keep net height change within ±12 m per piece and steer it back toward 0 when `ctx.cur.y` > 35 or < -35.
3. Every jump/gap must be possible for ALL three vehicles at a moderate speed (12–20 m/s) AND must not become a death trap at max/turbo speed (long landings, or a wall/fence that stops overshoot). Hazards must be readable (KILL red / laser) and avoidable with skill, not luck.
4. Budget per piece: ≤ 120 colliders total, ≤ 40 on the `dyn` pool. Only things that move use `dyn`.
5. Difficulty scales with `ctx.d01`; mark only easy pieces `early: true`. Hard pieces get `minDist`.
6. Coins / rings should suggest the good line and reward risk.
7. Test: `node tools/piece-test.mjs <absolute project path> <name> [seeds] [botSeconds]` (geometry + bot; the bot is a dumb driver — it cannot time moving hazards, so treat its deaths as hints). Visual check: `http://localhost:5179/?timer&only=<name>` (server: `node tools/serve.mjs . 5179` from the project root, if not already running).
