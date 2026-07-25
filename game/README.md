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
rely on the dev server returning a directory listing, which Python's does.
`src/main.js`'s imports reach two levels up (`../../shared/src/...`), which
a browser resolves to `<server root>/shared/src/...` — so the server root
must be **this repo's top level**, not `game/` itself, or those imports
404:

```bash
cd .. # repo root, if you're in game/
python3 -m http.server 8000
# open http://localhost:8000/game/index.html
```

## Controls

| Key | Action |
|---|---|
| W/S / ↑↓ | Throttle / brake-reverse |
| A/D / ←→ | Steer |
| Space | Handbrake |
| C | Cycle camera | R | Reset to checkpoint | Esc | Pause | M | Mute |
| F | Perf overlay (frame time, draw calls, triangles, barrier clearance) |
| G | Collision wireframe — see "Barrier collision" below |
| Mouse drag/wheel | Orbit/zoom chase camera |

## Architecture

```
index.html          Race UI shell + importmap
src/
  tracks.js         Built-in track/level definitions — pure data
  physics.js        Two-axle Pacejka bicycle model
  ai.js             AI opponents — each drives a real CarPhysics instance (same
                    tire model/wall collision/substep rate as the player) via
                    pure-pursuit steering targeting track.vtAI's speed table,
                    a stuck/reverse recovery loop, and a per-corner "spline
                    assist" that reins in slip on most (not all — some spins
                    are kept on purpose) corners. See CONFIG.ai.
  damage.js         Crash-damage vertex deformation (crumple) for any car rig,
                    used on both the player and AI on hard wall/car impacts.
                    Each vertex has its own displacement cap, ramped by where
                    it sits in the body: nose/tail crumple, the middle of the
                    cell barely moves (crush structure vs. stiff cell)
  collisionDebug.js Wireframe overlay (G): the actual barrier segments physics
                    collides against + each car's footprint box. Built per race
  effects.js        Skid marks, point particles (smoke/dust/sparks), tumbling
                    paint-chip shards on impact, camera shake
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
  barriers.js          Collidable barriers as world-space segments (see below)
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
  `trackObjects.js`'s `computeWallProfile` narrows the wall in to match
  wherever one of these bands is actually placed, per sample and per side
  (closest wins if they overlap, e.g. a tire stack in front of the main
  barrier), offset by the prop's own size so the wall lands on the surface
  you can see rather than its origin. Custom `offset` isn't just visual —
  it's where the car stops. A stretch with none of these bands keeps the flat
  `halfW + wallMargin` fallback. What those distances then become is
  "Barrier collision" below.
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
  needs hand-tuning to match. AI opponents are scaled by it too (same rig
  size as the player, since they now drive the same physics body — see
  "Handling model" below). New cars come from the asset pipeline (`../editor/PIPELINE.md`): a
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
  - `scale` optionally multiplies `CONFIG.carScale` for just this car (e.g.
    Red #11 ships at `0.9`) — rig size only (`buildPlayerCar`/
    `buildOpponentCar`, both player and AI honor it), not the shared physics
    tuning (collision radius/wheelbase stay uniform across cars).
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

**Contact never adds velocity.** Hitting a wall or a tuning-lab obstacle is
fully inelastic (`collideWithWall`): the car is pushed out of the surface and
only the *into-surface* component of its velocity is cancelled — along-surface
motion is untouched. There is no restitution term and no speed scrub, so a
graze neither kicks the car off its line nor costs it a flat percentage of
speed; it scrapes and carries on. (The scrub used to be 6% of total speed *per
substep* of contact, 240 a second — a 15° brush with the throttle pinned went
from 9.45 m/s to 0.16 m/s within two seconds.) Car-vs-car is position-only for
the same reason — see `CONFIG.ai.bump`. Impact speed is still reported, so
damage, sparks and the thud all still fire; only the velocity response is gone.

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

## AI opponents

`src/ai.js`'s `AIRacer` drives a real `CarPhysics` instance — the same tire
model, wall collision, and 240Hz substep rate the player uses, not a
kinematic spline-follower — so AI cars slip, slide, and can genuinely crash
or get stuck like the player can:

- **Driving**: pure-pursuit steering toward a lookahead point on the car's
  own preferred lane (`CONFIG.ai.offsets` + a slow sinusoidal wander),
  speed targeted against `track.js`'s `vtAI` table (per-sample cornering
  limit with braking lookahead, tuned by `CONFIG.ai.lateralAccel`/`brake`/
  `maxSpeed`), scaled by a per-opponent skill factor and mild rubber-banding
  (`CONFIG.ai.rubberBand`) so the pack stays close without it being obvious.
- **Corner assist**: raw physics alone spins an AI out on tight corners
  reasonably often — a little of that is good texture, too much just reads
  as broken driving. On ~90% of corners (`CONFIG.ai.cornerAssist.chance`,
  rolled once per corner so it's consistent for the corner's whole
  duration, not flickering mid-turn) the car's heading gets nudged toward
  the spline tangent and its lateral slip bled off; the rest run on
  completely raw physics, so real spins still happen on purpose.
- **Stuck recovery**: ported from `../editor/tools/drive-test.js`'s proven
  headless-validator logic — sustained low speed past a startup grace
  period triggers a few seconds of brake-only reverse, then a resume,
  repeating indefinitely (unlike the headless tool, a live AI never "gives
  up").
- **Player-vs-AI collision** (`main.js`'s bump block): cars are checked as
  oriented rectangles around their own heading (`obbOverlap`, a small SAT
  implementation), not a single collision radius — a car is much longer
  than it is wide, so one radius is either too small nose-to-tail or too
  cautious side-by-side. Contact is **position-only**: overlap gets
  resolved every frame (split unevenly via `CONFIG.ai.bump.pushPlayerShare`/
  `pushAiShare` so the AI consistently gives up a bit more ground — "equal
  but a little in the player's favour") with no added velocity and no
  per-frame speed drain, so two cars can rub doors and slide past each
  other without bouncing off or stalling out. Hard contact (wall or car)
  still triggers `damage.js`'s crumple deformation and an `effects.js`
  spark burst on both the player and whichever AI was involved.

## Barrier collision

`shared/src/barriers.js` bakes the wall into **world-space polylines**, one per
side, once per track — from the same per-sample distances `computeWallProfile`
produces. `physics.js`'s `collideWithBarriers` then does box-vs-segment SAT
against those segments, and `collisionDebug.js` (G) draws the very same
segments, so the debug fence and the collision surface are one dataset and
cannot disagree.

This replaced a curvilinear test (project the car onto the spline, compare its
lateral against the wall's). That frame is degenerate near a tight corner's
inside — equal-lateral curves bunch toward the centre of curvature — while the
car is a rigid ~2 m box in world space, so every way of bridging the two was an
approximation whose error grew with curvature × car length. Collision fired with
visible daylight on tight corners however it was patched. Box-vs-segment in
world space needs no frame conversion and is exact at any radius.

Working in real geometry does mean the polyline itself has to be valid, and
`buildBarriers` enforces three things a lateral-distance test could ignore:

- **Fold cap.** An offset only traces a valid parallel curve while it stays
  inside the local radius on the concave face; past that it folds through the
  centre of curvature and its segments lie tangled across the track. Capped at
  90% of the radius.
- **Slope limit.** A step in distance (a band starting/ending) becomes a segment
  running *radially* across the track, which the car hits edge-on like a
  kerbstone. The profile tapers at most 0.2 m per sample; relaxing with `min()`
  only pulls the wall in, so a taper can't open a drivable gap.
- **Knot skip** (`MIN_BARRIER_RADIUS`). Where the barrier's *own* radius would
  fall under 1.5 m, the "wall" is a sub-metre loop almost centred on the
  corner's centre — normals there are ill-defined. Those segments are dropped,
  leaving that stretch uncontained rather than fabricating a tangle. Purely
  geometric, so it generalises: a wide oval drops nothing, Circuito di Roma
  drops 11 of 1400 at one hairpin, a 6 m ring with a 5 m offset drops 39%. If a
  track needs a barrier there, the corner is too tight for its offset.

Two safety rails in `collideWithBarriers`: overlaps deeper than a car length are
treated as bad data and ignored (a backwards normal on a pathological curve
would otherwise hurl the car metres sideways), and extraction is capped per
substep so resolving a large overlap can't teleport the car.

What collides is the car's oriented footprint (`carHalfLength`/`carHalfWidth`,
the same rectangle the car-vs-car bump uses), deliberately ~91% of the tightest
rigged car so contact reads as touching rather than stopping short.

**Debug view (G)** — `collisionDebug.js` draws the collision segments as a
fence, magenta where a barrier band sets the distance and blue where it's the
flat fallback, plus each car's footprint box (green player, yellow AI). Depth
testing is off so the fence shows *through* the barrier art it should line up
with, and it's clipped to a window around the car. The F overlay's `clr` reading
comes from the same routine collision uses: `0.00` is touching, anything
positive means the car is not in contact.

## Race structure

Menu → countdown → race (vs AI if `config.js`'s `ai.enabled` (`../shared/src/config.js`), currently
`true`) → checkpoint-validated laps (R resets to last checkpoint, no
shortcuts) → results with medals, drift score, and persistent best laps
(localStorage, keyed by track id).

## Credits

- `assets/textures/scenery/c1.png` (Colosseum cutout, used on Circuito di
  Roma) is a cropped version of ["Colosseo 2020"](https://en.wikipedia.org/wiki/File:Colosseo_2020.jpg)
  by FeaturedPics, licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
  Unlike every other visual asset in this game (see intro above), it's a
  real photo, not a procedural placeholder — kept under this license's
  share-alike terms rather than swapped out.
