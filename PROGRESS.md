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

## Dev tools
- `dev/index.html` + `dev/stubs.js`: runs the core with stand-in modules (importmap remaps /js/ui.js etc.). `?timer` keeps the loop alive when the browser pane is hidden.
- Headless bot: `node tools/bot.mjs <absolute obby path> bike <seed> <seconds>` (needs `npm i --no-save three@0.160.0`).
- `window.bobobike` debug handle exposes state/player/track/camera.

## Next steps
1. DONE: full game runs end-to-end (menu → countdown → run → death → game over). After workflow ends: rename UI to bobobike, fix game-over height.
2. Headless bot test of track feasibility (jumps reachable, no impossible pieces).
3. Adversarial review workflow (bugs/perf/feel), playtest, polish.
4. Publish as an Artifact (index.html + js/*.js via `files`).
