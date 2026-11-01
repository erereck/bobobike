# bobobike — progress log (read this first when resuming)

Game: **bobobike** (always lowercase). 3D endless procedural Roblox-style obby on BMX / scooter / patinete.
Web game: static files, Three.js 0.160.0 via importmap from jsDelivr. Contract for all modules: `SPEC.md`.

## Published
- GitHub: https://github.com/erereck/bobobike — GitHub Pages: https://erereck.github.io/bobobike/
- index.html is now a full HTML document (for Pages). To republish the claude.ai artifact, publish a fragment copy (strip doctype/html/head/body wrappers).
Artifact (private to the owner until shared): https://claude.ai/artifact/CSa6DKFVboWDB1nwDufGz4 — republish by publishing obby/index.html again with the same files map (js/*.js).

## Status
| file | owner | state |
|---|---|---|
| js/config.js, js/themes.js | lead | done |
| js/track.js (generator, colliders, instanced render) | lead | done; renders in browser; headless bot test passes physics sanity |
| js/player.js (physics, tricks) | lead | done; verified jump/land/ramp headless |
| js/main.js (loop, camera, input, records) | lead | done; runs with dev stubs (dev/index.html?timer) |
| js/vehicles.js | workflow wf_e9f58c95-8ef | landed, works in game (review pending) |
| js/environment.js | workflow wf_e9f58c95-8ef | landed, works in game (review pending) |
| js/audio.js | workflow wf_e9f58c95-8ef | landed, in review |
| js/fx.js | workflow wf_e9f58c95-8ef | landed, works in game, in review |
| index.html + js/ui.js | workflow wf_e9f58c95-8ef | landed, works; TODO rename logo/title to bobobike, game-over card too tall at 720p (buttons below fold) |

## How to resume if a session dies
- Every agent writes its file straight to disk, so finished modules survive. Check which files exist in `js/`.
- The module workflow can be resumed (cached agents return instantly):
  Workflow({ scriptPath: "<session>/workflows/scripts/obby-rush-modules-wf_e9f58c95-8ef.js", resumeFromRunId: "wf_e9f58c95-8ef" })
  If that is unavailable, rebuild only the missing modules from SPEC.md.
- Local preview: `node tools/serve.mjs . 5179` (add ?timer when the tab is in the background).

## v2 (user feedback, 2026-10-31)
- DONE: easier tuning (track.js/config.js), handling + track assist + air brake on S (player.js), RMB orbit + wheel zoom (main.js), SKINS in config.js + main.js wiring.
- DONE (wf_e9f58c95-8ef, all 10 agents finished): modules reviewed; UI renamed to bobobike; game-over fits 720p.
- DONE wf_70755bcb-b9e (skins v2): R6 model + 7 skins with setSkin; menu skin picker; unlock notice.
- DONE wf_32aa2e10-93d (core review): physics/main fixes landed; lead applied safe perf items (partial instance uploads, no canvas MSAA with composer, skip render while paused), wider slalom/kill-strip spacing, early pillars as rhythm section, landing strip after every gap. Bot (tools/bot.mjs) now reaches 500-1000 m on most seeds.
- Lives: start 3, +1 every 3 checkpoints, cap 6. Grades S84/A66/B48/C30.

## v3 (2026-11-01): infinite-lives mode + mobile overhaul
- Contract: SPEC.md "v3". config.js MODES/MODE_ORDER.
- DONE (lead): main.js — infinite mode + separate records (infBestDistance/infBestAvgKmh), skins only from normal mode, 'end' event, analog joystick input (no auto-throttle), touch camera drag via ui.consumeCameraDrag(), haptics, wake lock, fullscreen + landscape lock, portrait FOV, sharper low-quality pixel ratio on phones.
- DONE workflow wf_49fce5a9-b14 (mobile UI): floating joystick, right-side buttons with turbo ring, camera drag, compact HUD (speed pill), mode toggle, haptics/fullscreen settings, pause ENCERRAR CORRIDA. Verified in phone emulation 844x390, 740x360, 375x812.

## v4 (2026-11-01): many more track variations
- DONE (lead, commit 0ffc65c, local only): piece registry + ctx API (SPEC.md "v4"), new kinds CONVEYOR/ICE/BOUNCE, laser look, motions slide-y/pendulum/blink/orbit/spin-carry, turbo rings, player carry/ice/bounce physics, tools/piece-test.mjs, ?only=<piece> URL hook.
- DONE (commit 7db2ce4, local): 41 pack pieces built (m_ 11, t_ 11, s_ 10, x_ 9); motion + surfaces reviewed and fixed.
- DONE: wf_73009875-2aa finished (resumed once after the session limit); all 4 packs reviewed and fixed in place (commit 0c8b1b5).
- DONE: piece-test all (56 types, 3 seeds, 40 s bots): 0 geometry problems, 0 NaN; remaining bot deaths only on timed hazards (same as built-in movers/spinner/gates). Browser walk 380 -> 3200 m through 6 zones: no console errors; desktop + 844x390 phone checked. Banners renamed (x_gelo "REINO DO GELO", t_megaRamp "ACELERA COM TUDO!"). main.js onResize ignores 0x0 sizes (zero-size composer targets).
- DONE (lead): conveyor chevrons now scroll forward (shader time sign); pickType recency (same type within 160 m x0.2, within 420 m x0.6; set pieces x_* at least 380 m apart, same one x0.12 within 1600 m); early s_iceRink pillars are solid bumpers (deadly only past d01 0.6).
- Mixed-track check (8 seeds x 6 km, scratch mix.mjs): 56 distinct types, ~45% pack pieces after 260 m, set pieces min 390 m / median ~985 m apart, no overlap, no warnings.
- Known minor: the record gate spans only the collider holding the record, so on multi-strip pieces (s_iceRink) its visual posts can stand inside the wider deck (posts have no collider).

## Dev tools
- `dev/index.html` + `dev/stubs.js`: runs the core with stand-in modules (importmap remaps /js/ui.js etc.). `?timer` keeps the loop alive when the browser pane is hidden.
- Headless bot: `node tools/bot.mjs <absolute obby path> bike <seed> <seconds>` (needs `npm i --no-save three@0.160.0`).
- `window.bobobike` debug handle exposes state/player/track/camera.

## Next steps
1. DONE: full game runs end-to-end (menu → countdown → run → death → game over). After workflow ends: rename UI to bobobike, fix game-over height.
2. Headless bot test of track feasibility (jumps reachable, no impossible pieces).
3. Adversarial review workflow (bugs/perf/feel), playtest, polish.
4. Publish as an Artifact (index.html + js/*.js via `files`).
