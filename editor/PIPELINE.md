# Asset pipeline — manual for AI agents (and humans)

This directory (`editor/`) is the authoring/tooling side of the repo, kept separate from
the shipped game (`../game/`) so the game can stay lean and deployable on its own. Runtime
code the two sides both need (track building, environment, placeholder assets, spline math)
lives in `../shared/` and is imported by both — see the top-level layout below.

An AI can build the game out to a complete state from small user prompts — new tracks,
cars, textures — with the existing interactive tools (`editor.html`, Scene Forge
`forge/index.html`, `crowdEditor.html`) reserved for **hand polish at the end**, not for
bulk authoring.

**The core rule: every asset is data (JSON) or a swappable image file. Never bake new
content into engine code.** Generation writes files; verification is headless; polish
is human, in the browser.

## Top-level layout

```
game/                 THE SHIPPED GAME — no editor/tooling code, only ../shared/ as a dependency
  index.html           Race UI shell + importmap
  src/                 main.js + everything only the race needs (physics, ai, hud, audio, ...)
  levels/*.json         tracks (auto-discovered at boot; also src/tracks.js built-ins)
  carProfiles/*.json     car physics tunes (auto-discovered; tagged with a carId, one
                        active profile per car — authored in editor/tuningLab.html).
                        carId "fwd"/"rwd" are drivetrain-default fallbacks: a car
                        with no profile of its own inherits one of these by its
                        own drivetrain, so a new car needs only physics.drivetrain
                        declared to get a complete handling tune for free.
  assets/textures/<k>/  sprite/ribbon/road folders — dropping a PNG is a deploy
  assets/crowd/*.crowd.json  crowd kits
  assets/models/        3D props + models/cars/
shared/                CODE SHARED between game/ and editor/ — no duplication, no drift
  src/                  config.js, placeholders.js, spline.js, track.js, trackObjects.js,
                        environment.js, crowd.js
editor/                YOU ARE HERE — everything authoring-related
  forge/index.html      Scene Forge — photo→low-poly-asset tool (human polish stage)
  editor.html, crowdEditor.html, sketch.html   standalone track/crowd editors (share
                        generation code with the game via ../shared/)
  preview.html, carViewer.html   headless-verification pages driven by tools/screenshot.js
  tuningLab.html         driveable open plane + collidable obstacles, physics/audio
                        tuning panel always open (was an in-race 'T' toggle; now lives
                        here — see game/README.md's "Tuning lab" section)
  src/                  editor.js, crowdEditor.js, sketch.js
  ingest/               RAW INPUTS — dropped by the user or fetched on request
    photos/              source photography (texture material, liveries, facades)
    refs/                blueprints, style references, high-poly .obj to decimate
  work/                 INTERMEDIATE — pipeline working files, never loaded by the game
    cars/                car-kit JSONs / Scene Forge projects awaiting polish/export
    textures/            texture WIP before stylization/placement
    shots/               screenshot output (tools/screenshot.js default)
  tools/                 headless CLIs (Node; `three` pinned to the game's 0.160.0)
  schemas/                JSON Schemas for the data formats
```

## Tools (run from `editor/`; each spawns its own dev server rooted at the repo root)

| Command | What it does |
|---|---|
| `node tools/validate-track.js --all` (or `<file.json\|id>`) | Static lint: schema shape, corner radius vs width, grades, self-crossing (the track query is 2D — same-height crossings break physics), band/point types, `tex`/sprite-folder references, id collisions. Exit 1 on errors. |
| `node tools/drive-test.js <id\|file> [--laps 2]` | Laps the track headlessly with the game's real `CarPhysics` at 240 Hz under a modest pure-pursuit bot. Proves completability, reports lap times/wall hits, and compares achieved pace against `medalAvgSpeed` for calibration. |
| `node tools/screenshot.js track <id> [--s 0.3 --h 3]` | `preview.html` capture: whole-track overhead (no `--s`) or on-track at lap-fraction `s`. |
| `node tools/screenshot.js sheet <id> [--shots 8]` | Overhead + N driver's-eye shots spaced around the lap → `work/shots/sheet-<id>/`. Review a whole track in one pass. |
| `node tools/screenshot.js race <id>` | The actual game (`game/index.html?track=` skips the menu), HUD and all. |
| `node tools/screenshot.js car <carId> [--yaw --pitch --dist]` | `carViewer.html`: the car as the game rigs it (real `WHEEL` placement + `carScale`), over a 1 m grid with printed bounds. `--url <path.gltf>` inspects an unregistered export (raw, no wheels). |

Interactive play is unchanged in spirit: `cd ../game && python3 -m http.server 8000` serves
the game standalone. Editor pages (`editor.html`, `crowdEditor.html`, `preview.html`,
`carViewer.html`, `tuningLab.html`, Scene Forge) reach into `../shared/` and `../game/` by relative path, so
serve them from the **repo root** instead: `cd .. && python3 -m http.server 8000`, then open
`/editor/editor.html`, `/editor/forge/index.html`, etc. Directory listings are load-bearing
(levels/crowd/texture auto-discovery) — Python's server provides them; most static hosts
don't.

Headless notes: captures use the Playwright-cached Chromium via puppeteer-core
(`PIPELINE_CHROME=/path/to/chrome` to override) with SwiftShader (no GPU needed).
`preview.html`/`carViewer.html` set `window.__READY` after their first real frame;
screenshot.js waits on it — don't replace that with fixed sleeps.

## Workflows

### New track (works end-to-end today)
1. Write `../game/levels/<name>.json` — schema: `schemas/track.schema.json`.
   Or start from `sketch.html` zones. Reuse existing texture folders where the theme fits.
2. New scenery subjects: PNGs into `../game/assets/textures/<key>/` — new key = one
   `ASSETS.spriteFolders` line in `shared/src/placeholders.js` (width/height in meters;
   `static`, `cross` flags per `../game/README.md`). That registry line is the only code
   touch allowed.
3. `node tools/validate-track.js <file>` → fix errors, judge warnings.
4. `node tools/drive-test.js <id>` → must finish; calibrate `medalAvgSpeed` from the
   bot's reported pace (bot ≈ solid-but-not-optimal; put bronze at/under bot pace).
5. `node tools/screenshot.js sheet <id>` → review, iterate placement.
6. Hand off: user polishes in `editor.html` (drag points, gizmo objects) → Export back
   to the same file. The editor and race share generation code, so no drift.

### New car (works end-to-end — CLI or fully inside Scene Forge)

**In-editor path** (same code, `tools/lib/carlib.js`, as the CLI): open Scene
Forge (`forge/index.html`), **Load photo…** a studio-style side profile (colorful paint on a
neutral backdrop — the tracer masks by dominant hue), **🚗 From photo**
(facing/length dialog) → traced, lofted body replaces the scene (one undo
step). Tweak the mesh with the normal tools, then **🎨 Auto livery**
(colors/number/team/sponsors dialog) → paints the GT1 livery for the
*current* mesh — works after vert tweaks — and wires every face as an
editable photo grab. Re-run it any time with new colors; layer detail with
Stylize/re-grab/Draw region as usual; **Export .gltf** when happy. The kit
rides inside the saved project (`carkit` field), so build-car projects
loaded here prefill the livery dialog. Headless handles for tools:
`window.forgeCarFromPhoto/forgeAutoLivery/forgeLoadPhotoUrl`.

**CLI path:**
1. AI writes `work/cars/<id>.carkit.json` — schema: `schemas/carkit.schema.json`.
   Game-meter dimensions read off a profile photo: side silhouette top+bottom
   polylines, optional plan taper, optional spoiler/scoop boxes, wheel positions.
   Sample: `work/cars/gt-coupe.carkit.json`.
2. `node tools/build-car.js work/cars/<id>.carkit.json` → `<id>.forge.json`, a Scene
   Forge **project**: hull lofted with semantically named faces (Hood, Windshield,
   Roof, Rear Glass, sides as full-silhouette caps), mirrored left/right verts
   (enable ⇋X in Scene Forge to pair them). Heed the floor-height warning — a floor
   below wheel-hub height (~0.16–0.22 m) swallows the wheels.
   **Automatic livery**: a `livery` block in the kit makes build-car run
   `tools/paint-car.py` (PIL), which paints GT1-style side/wrap views — beltline,
   roundel numbers, sponsor decals, windows and wheel arches painted rather than
   modeled, hue-preserving grain — in the manner of the existing scene(7)/scene(11)
   cars. Every body face is then wired as a **real photo grab** (photos + exact
   handles embedded in the project), so in Scene Forge each face remains fully
   editable: drag handles, restyle (Detail/Colors/Dither), or re-grab from a real
   photo instead. Conventions: hood text reads from the nose, roundel/tail text
   from the rear; pixel mappings are documented in paint-car.py's header and must
   stay in sync with build-car.js's handle math.
3. **Hand polish**: open Scene Forge, **📂 Load** (or drag the file in, or
   `forge/index.html?project=<path relative to repo root>`), tweak verts, texture faces
   from `ingest/photos/` grabs, **💾 Save** back. Save/Load round-trips losslessly
   (photos embedded as data URIs); loading is a single undo step.
4. Export: **Export .gltf** in the page, or headless
   `node tools/forge-export.js work/cars/<id>.forge.json` (clicks the real exporter
   — one implementation of atlas/UV logic) → `../game/assets/models/cars/<id>.gltf`.
5. Registration is optional now — anything landing in `assets/models/cars/` that isn't
   already in `ASSETS.carModels` is auto-discovered at boot with a filename-derived
   id/name (`placeholders.js`'s `discoverCarModels()`), selectable/tunable immediately.
   Add an entry to `ASSETS.carModels` (`shared/src/placeholders.js`) instead when it needs
   a curated display name, a non-RWD `physics` identity, or a `wheelOffset` fit — build-car
   prints the exact snippet either way.
6. Verify: `node tools/screenshot.js car <id>` (full game rig: wheels, `carScale`,
   ground seating via `lift`) or `--url assets/models/cars/<id>.gltf` for the raw
   mesh with game material settings. Convention: **+Z forward**, White #7 rig
   measures 0.92 × 0.77 × 2.40 m at carScale 1.5.
   Note: GLTFExporter writes `metallicFactor 0.5` — dark without an envmap. The
   game always overrides to roughness 0.85 / metalness 0.1 (`buildPlayerCar`), and
   carViewer mirrors that; don't chase "the export looks dark" in other viewers.

### Textures / sprites
- Sources from `ingest/photos/`; WIP in `work/textures/`; finished PNGs into the game
  folder they belong to (`../game/assets/...`). Match the established look: low-res,
  quantized palette, hue-preserving grain (`addGrain` in `shared/src/placeholders.js`) — a
  pristine hi-res PNG reads as wrong next to everything else. (Stylize CLI lands in
  `tools/texture/` — Phase 3.)
- Sprite aspect: each `spriteFolders` entry renders images on a fixed width×height
  quad — author PNGs near that aspect or they stretch silently.

## Conventions that aren't written anywhere else

- Track `controlPoints` y is real elevation; physics is planar (slope affects
  gravity-along-road only). Catmull-Rom tension 0.55, closed.
- Point `s` is **meters** along the spline; band `from`/`to` are **lap fractions**.
- Building cubes are center-origin — a band of buildings needs its (extra) spline
  elevated by ~0.7×scale; points can use `yOffset`.
- Extra splines get **no** default bands; the main track without `trackObjects` gets
  barriers + curvature kerbs materialized on first editor open.
- `medalAvgSpeed` is raw m/s average over the whole race (`main.js` finishRace), not
  HUD km/h. The baseline car's flat-ground top speed is drag-limited (~9.8 m/s at
  current config) — set targets the physics can actually reach (drive-test reports this).
- Registering a model path that doesn't exist fails `preloadAssets()` and blocks the
  whole game from loading — validate before registering.
- Cars face **+Z**; `CONFIG.carScale` is the only resize knob; AI opponents are not
  scaled by it.
- Asset paths in `ASSETS` (`shared/src/placeholders.js`) are written relative to `game/`
  and resolved against that module's own file (`import.meta.url`), not against whichever
  page imports it — this is what lets `game/index.html`, `editor.html`, `preview.html`,
  and `carViewer.html` all load the same registry correctly despite sitting at different
  depths in the tree. Keep new entries as plain `assets/...` paths; don't hand-roll `../`.

## Roadmap / gaps still open

- **Phase 2 — done** (build-car, Scene Forge project save/load + `?project=`,
  forge-export, carViewer, and the two legacy `scene*.gltf` cars moved into
  `assets/models/cars/` as `white7.gltf`/`red11.gltf`).
- **Phase 3**: `tools/texture/` stylize + cutout-alpha CLIs for trackside sprites
  (the Rome-track generators, formalized); sprite-aspect lint. Car texturing is
  done (paint-car.py); trackside texture generation is what remains.
- **Phase 4**: crowd-kit JSON schema, `manifest.json` fallback for static hosting,
  drive-test with per-car physics presets (blocked on car kits carrying physics as data).
- Game-side: AI opponents disabled (`config.js ai.enabled`); several `medalAvgSpeed`
  targets appear unreachable with the current baseline car (see drive-test output).
