# Placeholder GP

This is the **shipped game** — no editor or pipeline tooling lives in this
directory. It depends on one thing outside itself: `../shared/src/` (asset
registry, track/environment building, spline math) — code the standalone
track/crowd editors in `../editor/` also import, so the two can never drift
apart. Everything editor/pipeline-side — Scene Forge, the standalone track
editor, headless verification, car/track generation CLIs — lives in
`../editor/`; see `../editor/PIPELINE.md` for the AI-drivable content
workflow (headless validation, completability tests, screenshot verification).

Arcade/sim racer built on three.js. Every visual/audio asset is a procedural
placeholder designed to be swapped for real art without touching game code
(see `../shared/src/placeholders.js`).

## Run

Needs an HTTP server — ES modules + GLTF loading don't work over `file://`,
and several features (levels/, crowd kits, ribbon/cutout texture folders)
rely on the dev server returning a directory listing, which Python's does:

```bash
cd game
python3 -m http.server 8000
# open http://localhost:8000
```

## Controls

| Key | Action |
|---|---|
| W/S / ↑↓ | Throttle / brake-reverse |
| A/D / ←→ | Steer |
| Space | Handbrake |
| C | Cycle camera | R | Reset to checkpoint | Esc | Pause | M | Mute |
| F | Perf overlay (frame time avg/worst, draw calls, triangles) |
| Mouse drag/wheel | Orbit/zoom chase camera |

## Architecture

```
index.html          Race UI shell + importmap
src/
  tracks.js         Built-in track/level definitions — pure data
  physics.js        Two-axle Pacejka bicycle model
  ai.js             Spline-following opponents (currently disabled, see CONFIG.ai.enabled)
  effects.js        Skid marks, particles, camera shake
  audio.js          Procedural WebAudio (engine/skid/wind/impacts/UI)
  hud.js            DOM HUD, minimap, menus, results
  tuninglab.js      Physics/audio tuning panel — lives in ../editor/tuningLab.html
                    now, not raced live; kept here since carProfiles.js (below)
                    needs its param list/apply logic too
  carProfiles.js    Car physics baseline + carProfiles/*.json layering (see
                    "Swapping in real assets" -> Cars below)
  levels.js         Auto-discovers levels/*.json at boot
  batching.js       Race-only static-scenery chunk merging (draw calls + pop-in)
  main.js           Race state machine + per-frame wiring
```

```
../shared/src/       CODE THIS GAME SHARES WITH THE EDITORS — no duplication, no drift
  config.js           ALL gameplay tuning (physics, camera, AI, track params)
  placeholders.js      Asset registry + procedural placeholder factory  ← swap point
  track.js             Main-track-only: road ribbon/checkpoints/AI-line/minimap
  spline.js            Generic open/closed Catmull-Rom sampling (main track + extraSplines)
  trackObjects.js       Rule-based trackside object placement (bands + points)
  environment.js       Theme + terrain + ambient scatter (trees/rocks/billboards)
  crowd.js              Shared crowd-figure rigging (used by race + crowdEditor.js)
```

```
../editor/            AUTHORING TOOLS — not part of the shipped game, see ../editor/PIPELINE.md
  editor.html           Standalone track editor shell
  crowdEditor.html      Standalone crowd-kit authoring tool
  sketch.html           2D layout sketch -> hands off to editor.html
  forge/index.html      Scene Forge — photo→low-poly-asset tool
  src/editor.js, crowdEditor.js, sketch.js
```

**editor.js and main.js call the same `buildTrack`/`buildEnvironment`/
`buildAllTrackObjects` functions** — the editor preview can never drift from
what actually races. Same relationship between `crowdEditor.js` and `crowd.js`.

**Race-time rendering differs from the editor in one deliberate way**
(`batching.js`): after building, the race merges static props into one mesh
per 70 m chunk × material family (world transform + material color baked
into vertex colors), and culls chunks + billboards past
`CONFIG.render.drawDistance` — PS1 draw-distance
pop-in, deliberately aggressive at the default 100 m. The frame renders at
`CONFIG.render.internalHeight` (240p, PS1-style) and upscales
nearest-neighbor to the window. Shadows are baked
once per race into a whole-track static shadow map (the sun no longer
follows the car); moving cars get a blob shadow instead. The editor keeps
every prop individually selectable and skips all of this.

## Tuning lab

Lives outside the shipped game now, at `../editor/tuningLab.html` — an open
plane with a few static (collidable) obstacles, car-select dropdown, and the
panel always open, so physics feel can be tuned without racing a real track.
Sliders write straight to `CONFIG` (live) and auto-save to localStorage,
keyed per selected car — switching cars loads that car's own saved tune, or
its code-defined preset (`ASSETS.carModels[].physics`, see below) if none yet
saved. Reset reverts to that car's own baseline, not a single shared default.

Export/Download hands off a named tune as JSON tagged with the car it was
tuned against (`carId`). Drop the file into `carProfiles/` and it's a **car
profile**: auto-discovered at boot (same directory-listing trick `levels/`
uses) and layered onto that car's physics in the real game too — one active
profile per car, last file discovered for a given `carId` wins, no in-game
picker. See `src/carProfiles.js`.

Two of these are special: `carProfiles/fwd-default.tune.json` and
`rwd-default.tune.json` (`carId: "fwd"`/`"rwd"`) are the fallback a car uses
when it has no profile of its own — so a new car needs only
`physics: { drivetrain: "fwd" }` (or nothing, defaulting to `"rwd"`) to
inherit a complete, already-tuned handling identity. Red #11 and White #7
work exactly this way today (their old hand-authored inline tunes are what
these two files were seeded from).

## Track editor

Shares generation code with the race, so what you see is what races.

- **Splines tab**: "Main Track" (fixed, closed, real elevation) + any number
  of **extra splines** (open or closed, independent of the track) for
  scenery that shouldn't follow the road — a crowd line along a fence, rocks
  along a canyon wall. Only one spline is "active" at a time (Select
  button); its points are draggable, everyone else's render dim/inert.
  Shift+click adds a point to the active spline regardless of tab/mode.
  An extra spline with no bands/points of its own places **nothing** — no
  curvature-based default like the main track gets.
- **Bands** (the primary placement mechanism): "place `<type>` every
  `<spacing>`m along `<side>` from `<from%>` to `<to%>` of the spline."
  Spacing is curvature-corrected (parallel-offset curves are longer on a
  bend's outside / shorter on the inside) so instances don't bunch/spread
  through corners. A track that omits `trackObjects` gets sensible
  defaults (full-lap barriers + curvature-triggered kerbs) materialized as
  real editable rows the first time you open it.
- **Points** (one-off placements): only these are individually selectable
  in **Object tab → Select/Transform** (gizmo drag writes back into that
  row live) — band-generated instances have no per-instance identity.
  Gizmo rotate turns off **Conform to slope** for that point (the two are
  alternative, non-composable ways to set orientation). The Rotate handle
  hides for billboard types since their rotation is overwritten every frame
  by the camera-facing update anyway.
- **Conform to slope**: on = tilts flush with road pitch (barriers/kerbs);
  off = stays world-upright (trees).
- **Cutout: `<Name>`** — one type auto-generated per `ASSETS.spriteFolders`
  entry in `../shared/src/placeholders.js` (crowd/tree/building/pine by default): a
  camera-facing billboard quad, not a 3D model. Add a new subject with a
  folder + one registry line. `static: true` on a folder gives a
  **Backdrop** instead — oriented once, not re-faced every frame (for fixed
  background art like a painted skyline) — scenery/ruins/skyline by default.
  `cross: true` (tree/pine by default) renders two static quads at right
  angles with a random fixed yaw instead of re-facing the camera — per-frame
  billboard rotation makes nearest-sampled sprites shimmer in motion.
- **Building** is an actual 3D box placeholder — distinct from "Cutout:
  Building" (flat sprite); pick whichever fits.
- **Spline Barrier / Spline Apex Kerb** — one continuous ribbon mesh over a
  band's whole range instead of repeated discrete props. `spacing` is
  reinterpreted as the atlas tile length for these. Texture variety comes
  from `ASSETS.ribbonFolders.barrier` (auto-discovered folder, baked into
  one shared atlas so any number of variants stays one draw call).
- **`barrier` / `splineBarrier` / `tireBarrier` are physically collidable** —
  the physics wall (`shared/src/track.js`'s `wallDistAt`, sourced from
  `trackObjects.js`'s `computeWallProfile`) narrows in to match wherever one
  of these bands is actually placed, per sample and per side (closest one
  wins if they overlap, e.g. a tire stack in front of the main barrier).
  Custom `offset` on these bands isn't just visual anymore — it's exactly
  where the car will stop. A stretch with none of these bands keeps the
  flat `halfW + wallMargin` fallback, same as always.
- **Spline Tarmac** — flat surface ribbon (pit aprons, side streets, piazzas).
  `scaleX` is the strip width in meters, `offset` the strip center, `spacing`
  the meters per texture repeat. The band's `tex` field (JSON only) names a
  file from `assets/textures/road/` — asphalt/cobble/wear by default; a PNG
  with transparency renders as a decal overlay (tire wear, patches) laid
  over the road instead of an opaque surface.
- **Generate**: editing data is instant/cheap; press Generate (highlighted
  when dirty) to actually rebuild the 3D scene — keeps dragging responsive
  even on a big track.

**Starting from a sketch** (`../editor/sketch.html`): click to drop the main loop,
drag boxes to block out Trees/Buildings/Crowd zones, then **Generate → Open
in Editor**. Zones become 2-point open extra splines carrying one band each
— refined afterward exactly like any hand-drawn extra spline (nothing
special-cased). Deliberately favors cheap types (`cutoutTree` sprites,
`splineBarrier` ribbon) over discrete 3D instances since it's a rough draft,
not a final layout.

## Adding a track / level

Same JSON shape either way (Export/Download from the editor):

- **Drop a file in `levels/`** — auto-discovered at boot, shows up in the
  menu. Easiest for a one-off track. (Directory-listing trick — most static
  hosts won't support this, local-dev only.)
- **Add an entry to `src/tracks.js`** — ships permanently with the game.

```js
{
  id: "my-track", name: "My Track", desc: "...",
  laps: 3,
  width: 8,                                        // road width, meters
  medalAvgSpeed: { gold: 16, silver: 14, bronze: 11.5 }, // self-scales to length
  theme: { sky, fog, ground, hill, sun, sunIntensity, terrain: "grass"|"desert", props: { trees, rocks, billboards } },
  controlPoints: [[x, y, z], ...],                 // y = real elevation — road/kerb/wall/terrain all follow it
  trackObjects: { bands: [...], points: [...] },   // optional, see trackObjects.js
  extraSplines: [ { id, name, closed, controlPoints, trackObjects }, ... ], // optional, no defaults applied
}
```

Note: car physics is still planar — slopes affect visuals only, not handling yet.

## Swapping in real assets

`../shared/src/placeholders.js` is the single swap point.

- **Cars** — `ASSETS.carModels` (an array of `{ id, name, url, physics?,
  wheelOffset? }`), plus **auto-discovery**: any `.gltf`/`.glb` dropped into
  `assets/models/cars/` that ISN'T listed in `ASSETS.carModels` gets
  auto-registered at boot (`placeholders.js`'s `discoverCarModels()`, called
  from `preloadAssets()`) — id/name derived from the filename ("green5" →
  "Green5"), no `physics`/`wheelOffset` override (shared `WHEEL` fit, RWD via
  the drivetrain-default profile). Good enough to drive and tune immediately;
  add a hand-authored entry here instead (or as well — an explicit entry
  always wins, discovery skips filenames already registered) once it needs a
  specific display name, a non-RWD identity, or a `wheelOffset` fit.
  The player picks one from the main menu; each AI
  opponent independently picks one at random (`randomCarId()`). Model faces
  **+Z**, kart scale (~1.4m). `CONFIG.carScale` is the one "resize the car"
  knob — physics, visuals, and camera all derive from it, so nothing else
  needs hand-tuning to match. AI opponents are deliberately *not* scaled by
  it. New cars come from the asset pipeline (`../editor/PIPELINE.md`): a
  `../editor/work/cars/*.carkit.json` through `../editor/tools/build-car.js`, or traced from a
  photo entirely inside Scene Forge (🚗 From photo / 🎨 Auto livery) — either
  way exported to `assets/models/cars/<id>.gltf`, selectable next reload with
  zero registration, or registered here by hand (build-car prints the exact
  snippet, `wheelOffset` included) for a curated name/tune.
  - `physics` optionally overrides a fixed set of `CONFIG.physics` fields
    (see `CAR_PHYSICS_KEYS` in `src/carProfiles.js`) whenever that car is
    selected — applied via `applyCarPhysics()`. In practice this is usually
    just `{ drivetrain: "fwd" }` (or omitted, defaulting to `"rwd"`): the
    actual handling tune comes from a `carProfiles/*.json` file matching
    this car's own id if one exists, otherwise the matching drivetrain
    default (`fwd-default.tune.json`/`rwd-default.tune.json`) — see "Tuning
    lab" above.
  - `wheelOffset` optionally overrides the shared `WHEEL` position
    (`localX`/`frontZ`/`rearZ`/`localY`, in `buildPlayerCar`) for a car whose
    body proportions don't match the shared default.
- **Props** — drop a `.glb` in `assets/models/`, register in `ASSETS.models`
  (`tree`, `rock`, `billboard`, `barrier`, `apexKerb`, `tireBarrier`,
  `building`). Left commented out by default — pointing at a missing file
  fails `preloadAssets()` and blocks the game from loading.
- **Barrier ribbon texture variety** — drop images in
  `assets/textures/barriers/` (auto-discovered, no code edit).
- **Road surfaces** — swap/add files in `assets/textures/road/`; each file
  is one named Spline Tarmac surface (see the `tex` band field above).
- **Cutout billboard variety** — drop images in `assets/textures/<key>/` per
  `ASSETS.spriteFolders` entry; each image becomes its own material, picked
  at random per instance (no atlas — unlike the barrier ribbon, these are
  discrete, not a continuous strip).
- **Textures** (road/kerb/wall/grass/checker) — canvas-generated in the same
  file; replace a function body with a `TextureLoader` call. Current
  PS1-era look = low resolution + normal bilinear/mipmap filtering + a
  small random (non-periodic) per-pixel grain that scales R/G/B together
  (hue-preserving) — not a dithering algorithm.
- **Audio** — `src/audio.js` synthesizes everything continuously; the class
  API (`setEngine`, `setSkid`, `setWind`, `thud`, `beep`, `fanfare`) only
  retargets existing oscillator/gain params, designed so method bodies can
  be swapped for sample playback one at a time.
- **Crowd** — author kits in `../editor/crowdEditor.html`, drop `*.crowd.json` in
  `assets/crowd/` (auto-discovered). Rendering is pooled: a small fixed set
  of pre-baked figures/poses is built once at load, and every placed
  instance just references (never clones) a pool material — this is what
  keeps a stadium's worth of spectators cheap.

## Handling model (dynamic bicycle model)

`src/physics.js`: two-axle model, per-axle slip angles feed a simplified
Pacejka tire curve (`Fy = cap·sin(C·atan(B·α))`), with load transfer and a
friction ellipse per axle. All classic behaviors are *emergent*:

- **Understeer** — front tire force saturates.
- **Snap oversteer** — rear tire peaks at a smaller slip angle and *falls*
  past it, sliding in positive feedback until countersteer brings slip
  angle back under the peak.
- **Trail-braking** — braking also loads the front axle (weight transfer).
- **Power oversteer / power understeer** — drive force goes to whichever
  axle(s) `physics.drivetrain` (`"rwd"`/`"fwd"`/`"awd"`) sends it to, eating
  that axle's friction-ellipse budget: RWD bites into the rear (oversteer),
  FWD bites into the front (understeer/push) — same mechanic, different axle.
- Slope-along-road gravity is a body force (mass-independent, like a ball on
  a ramp) — doesn't touch the friction ellipse.
- Wheelspin: torque beyond an axle's traction spins the tire up, which both
  weakens drive force *and* cuts lateral grip (burnouts, power-on washouts).
  `wheelspin` (0..1, driven axle) and `frontPush` (0..1, front tire past its
  own peak slip angle — a lateral scrub, not spin) are exposed on the
  `CarPhysics` instance; `main.js`/`effects.js` turn them into matching
  skid-mark/smoke/audio cues, so understeer is felt and heard, not just
  simulated.

On top sits a **GT1/2-style assist layer** (all in the tuning lab under
"Assists & Aero"; all at 0 = raw sim):

- `steerAssist` — grip-optimal steering limiter, GT's signature hidden
  assist: clamps the commanded wheel angle so front slip can't overshoot
  the tire's peak — full stick corners at max grip instead of
  plow-scrubbing. When the car is sideways the clamp window recenters on
  the velocity direction, which reads as subtle auto-countersteer.
- `stabilityAssist` — fills the rear tire's post-peak force falloff (the
  positive-feedback part of a slide), so slides still start but gather
  themselves instead of snapping into spins. Disabled while the handbrake
  is down so deliberate slides stay loose.
- `downforce` / `aeroBalance` — v²-proportional extra axle load, split
  front/rear: planted at speed without touching low-speed handling.

Tuning (`../shared/src/config.js` → `physics`): `cgToFront` sets understeer/oversteer
balance, `cgHeight` weight-transfer drama, `gyration` rotational laziness,
`mu` overall grip, tire `B`/`C` per axle how sharp vs. progressive the
breakaway is. Below `vBlend`, blends to kinematic steering (standard
low-speed fix for this model class). Integrated at 240Hz substeps (stiff
ODE).

## Race structure

Menu → countdown → race (vs AI if `config.js`'s `ai.enabled` (`../shared/src/config.js`), currently
`false`) → checkpoint-validated laps (R resets to last checkpoint, no
shortcuts) → results with medals, drift score, and persistent best laps
(localStorage, keyed by track id).

## Credits

- `assets/textures/scenery/c1.png` (Colosseum cutout, used on Circuito di
  Roma) is a cropped version of ["Colosseo 2020"](https://en.wikipedia.org/wiki/File:Colosseo_2020.jpg)
  by FeaturedPics, licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
  Unlike every other visual asset in this game (see intro above), it's a
  real photo, not a procedural placeholder — kept under this license's
  share-alike terms rather than swapped out.
