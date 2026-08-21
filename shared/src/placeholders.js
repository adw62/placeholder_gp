// =====================================================================
// ASSET REGISTRY + PLACEHOLDER FACTORY
//
// This module is the single swap point for real art. Every texture and
// prop in the game is generated procedurally here; register a GLTF url
// in ASSETS and it will be used instead of the placeholder (props are
// preloaded once and cloned per instance).
// =====================================================================

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { discoverCrowdKitUrls, loadCrowdKitFromUrl, pickFigure, drawFigure } from "./crowd.js";
import { CONFIG } from "./config.js";

export const ASSETS = {
  // Selectable car models: the player picks one from the main menu, and
  // each AI opponent independently picks one at random per race (see
  // randomCarId()). Both preloaded once at boot (preloadAssets) and cloned
  // per instance from then on. Original photo-livery version of the #11 car
  // kept at "scene (11).gltf" if it's ever wanted as a third option.
  //
  // This list is only for cars that need a hand-authored `physics`/
  // `wheelOffset` override (see below). Any .gltf/.glb dropped into
  // assets/models/cars/ that ISN'T listed here gets auto-discovered and
  // registered at boot with a filename-derived id/name and no override —
  // see discoverCarModels() further down. Drop a file in, it's selectable
  // next reload; add an entry here only when the default (shared WHEEL fit,
  // RWD tune) isn't right for it.
  //
  // `physics` is an optional partial override of CONFIG.physics applied by
  // src/carProfiles.js's applyCarPhysics() whenever this car is selected —
  // only the drivetrain-identity fields listed in CAR_PHYSICS_KEYS are
  // touched here. That's usually just `drivetrain`: the full handling tune
  // comes from whichever carProfiles/*.json file matches, falling back from
  // this car's own id to a drivetrain default ("fwd"/"rwd") if it has no
  // profile of its own — see carProfiles.js's header comment. A car with no
  // `physics` field at all defaults to "rwd" and picks up rwd-default.tune.json.
  // `wheelOffset` is an optional partial override of WHEEL (buildPlayerCar,
  // below) for cars whose body proportions don't match the shared WHEEL
  // baseline. Empty/omitted = uses WHEEL as-is.
  carModels: [
    {
      id: "red11", name: "Red #11", url: "assets/models/cars/red11.gltf",
      // Identity only — the actual tune (weight bias, tire curves, launch
      // torque, assists, ...) lives in carProfiles/fwd-default.tune.json and
      // applies automatically via the drivetrain-default fallback (see the
      // ASSETS-level comment above and carProfiles.js).
      physics: { drivetrain: "fwd" },
      // WHEEL (below) is tuned to fit White #7's body; Red #11's body has
      // different proportions and needs its own position.
      wheelOffset: { localX: 0.29, rearZ: -0.52 },
      // Optional per-car multiplier on CONFIG.carScale (default 1) — visual
      // rig size only (buildPlayerCar/buildOpponentCar), not the shared
      // physics tuning (mass/grip/wheelbase/collision radius all still come
      // from CONFIG.carScale alone, same for every car — AI already shares
      // one physics profile across cars, not a per-car one, so a small
      // visual-only difference here doesn't create a mismatched hitbox
      // anyone would actually notice).
      scale: 0.9,
    },
    { id: "white7", name: "White #7", url: "assets/models/cars/white7.gltf" },
    // Green #5 is NOT listed here — it's auto-discovered from
    // assets/models/cars/ (see discoverCarModels below), same as any other
    // .gltf/.glb dropped in with no hand-authored entry of its own.
  ],
  // Drop .glb/.gltf files in assets/models/ and register them here by the
  // prop key they should replace — preloaded once at boot, then cloned per
  // instance. Commented out (not a fixed path) because pointing at a file
  // that doesn't exist yet fails preloadAssets() and blocks the game from
  // loading; uncomment a line once the matching file actually exists.
  models: {
    // tree: "assets/models/tree.glb",
    // rock: "assets/models/rock.glb",
    // billboard: "assets/models/billboard.glb",
    // barrier: "assets/models/barrier.glb",
    // apexKerb: "assets/models/apex-kerb.glb",
    // tireBarrier: "assets/models/tire-barrier.glb",
    building: "assets/models/buildings.gltf",
  },
  // Folder auto-discovered at load time for the "Spline Barrier" ribbon's
  // texture variety (see loadRibbonAtlas below) — relies on the dev server
  // returning a directory listing (Python's `http.server` does this by
  // default). Safe to point at even while empty: an empty/missing folder
  // just yields zero images and falls back to procedural stripe variants.
  // Drop image files (.png/.jpg/.webp) into assets/textures/barriers/ and
  // they show up next boot/race — no code edit needed.
  ribbonFolders: {
    barrier: "assets/textures/barriers/",
    // Separate atlas key so a track can opt a splineBarrier band into this
    // set via `tex: "barrierExpressway"` (mirrors splineTarmac's `tex`
    // field) instead of pulling from the shared `barrier` atlas above —
    // keeps themed variants (no sponsor-board branding here) from mixing
    // with whatever other tracks' barrier art lives in that folder.
    barrierExpressway: "assets/textures/barriersExpressway/",
    // Mountain-road guardrails (timber log rail, weathered plank rail,
    // plain Armco, dry-stone retaining wall) — opted into via a
    // splineBarrier band's `tex: "barrierTimber"`. Separate from the shared
    // `barrier` atlas above because that one is full of Italian sponsor
    // boards belonging to Circuito di Roma.
    barrierTimber: "assets/textures/barriersTimber/",
    // Low sandstone/mudbrick wall — Giza Desert Raceway's desert-perimeter
    // and Old Town wall look (coursed sandstone, weathered blocks, carved
    // relief, mudbrick). Opted into via a splineBarrier band's
    // `tex: "barrierSandstone"`. Its own key for the same reason
    // barrierTimber/barrierExpressway get their own: keeps it from mixing
    // with other tracks' barrier art in the shared folders above.
    barrierSandstone: "assets/textures/barrierSandstone/",
    // Plain unbranded galvanized Armco (red/white rail, yellow/black hazard
    // rail, a sun-dusted variant) — Giza Desert Raceway's open-circuit
    // safety barrier. NOT the shared `barrier` atlas above: that folder's
    // otherwise-generic tiles are mixed in with Circuito di Roma's own
    // sponsor boards (spqr/veloce/roma/caffe/gomme, one of them literally
    // the Italian flag) baked into the same shared atlas, so pulling from
    // it here would put Roman sponsor branding on a Giza barrier. This key
    // is genuinely generic (no place-specific branding at all) and reusable
    // by any future track that wants a plain rail. Opt in via a
    // splineBarrier band's `tex: "barrierPlain"`.
    barrierPlain: "assets/textures/barrierPlain/",
  },
  // Road-surface textures for the "Spline Tarmac" ribbon, discovered the
  // same way. Each file is one named surface a band picks via its `tex`
  // field (basename without extension, default "asphalt") — e.g. cobble.png
  // for cobbled streets. A PNG with transparency becomes an overlay decal
  // strip (wear/markings laid over the main road) instead of an opaque
  // surface. Swap any file to reskin, add a file to add a surface.
  roadFolder: "assets/textures/road/",
  // One "Cutout: <Name>" placeable type per entry (see trackObjects.js) — a
  // 2D billboard for any subject not worth a real 3D model yet. Add a
  // subject = new folder + one line, nothing else to touch. width/height
  // size the plane (meters). Faces the camera every frame by default
  // (`billboard: true`); `static: true` opts out for a fixed orientation
  // (facing tangent, tunable via rotY) — for backdrops that should hold still.
  spriteFolders: {
    crowd: { folder: "assets/textures/crowd/", width: 6 * CONFIG.crowdScale, height: 1.8 * CONFIG.crowdScale },
    // cross: true = two static quads at right angles instead of a camera-
    // facing billboard. Re-facing micro-rotates the quad every frame and
    // nearest sampling re-picks texels each time — trees shimmered in
    // motion no matter the texture size. A cross never rotates.
    tree: { folder: "assets/textures/tree/", width: 3, height: 4.5, cross: true },
    building: { folder: "assets/textures/building/", width: 10, height: 14 },
    scenery: { folder: "assets/textures/scenery/", width: 30, height: 14, static: true },
    pine: { folder: "assets/textures/pine/", width: 4.2, height: 5.6, cross: true },
    ruins: { folder: "assets/textures/ruins/", width: 24, height: 9, static: true },
    skyline: { folder: "assets/textures/skyline/", width: 64, height: 12, static: true },
    // Dense illuminated Tokyo-style skyscraper skyline silhouette (distinct
    // from the shared Roman-ish `skyline` folder above, which other tracks
    // already depend on) — a backdrop, so static: true.
    citySkyline: { folder: "assets/textures/citySkyline/", width: 64, height: 12, static: true },
    // Overhead expressway gantry sign — full-height support legs reach the
    // image's own bottom edge (ground contact baked in, base plates and
    // all), truss + sign panels sit at the top, and the whole middle/lower
    // span between the legs is transparent for a car to drive through.
    // Place at offset 0 with yOffset 0 (or omit) — no manual lift needed,
    // unlike a plain billboard cutout. static: true (fixed sign bridge, not
    // camera-facing).
    gantry: { folder: "assets/textures/gantry/", width: 12, height: 7.5, static: true },
    // City-track dressing kit — flat cutouts by design (cheap, and each is
    // replaceable by dropping a photo in its folder, like everything above).
    lamp: { folder: "assets/textures/lamp/", width: 0.95, height: 2.1 },
    // Tall single-arm expressway sodium lamp, distinct from the ornate
    // plaza `lamp` above. `light` is an opt-in extra: buildCutoutSprite()
    // attaches a real (non-shadow-casting) THREE.PointLight positioned near
    // the fixture head to any spriteFolder entry that sets it — used here so
    // a night track can actually be lit by its own lamp posts rather than
    // just flat ambient/hemi. Keep instances of a `light`-tagged type
    // sparsely spaced (tens of meters apart): every placed instance is a
    // real dynamic light, and this renderer only has the sun+hemi otherwise.
    lampTokyo: {
      folder: "assets/textures/lampTokyo/", width: 1.3, height: 7.2,
      light: { color: 0xffb066, intensity: 1.6, distance: 17, decay: 2, heightFrac: 0.84 },
    },
    // Mountain-circuit dressing kit (Trial Mountain). `conifer` is
    // deliberately NOT more images in pine/: that folder holds Roman stone
    // pines and every instance picks from it at random, so a Sierra fir
    // dropped in there would sprout on Circuito di Roma too.
    conifer: { folder: "assets/textures/conifer/", width: 4.6, height: 10.5, cross: true },
    // Forested ridgeline and distant granite summits — the layer a
    // "mountain" track's mountains actually live in. static: true (fixed
    // backdrops, never camera-facing).
    ridge: { folder: "assets/textures/ridge/", width: 72, height: 18, static: true },
    peak: { folder: "assets/textures/peak/", width: 96, height: 36, static: true },
    // Marshal post (post + flag/board + a marshal in hi-vis). cross: true —
    // it sits on the barrier line where a single re-facing quad reads flat.
    marshal: { folder: "assets/textures/marshal/", width: 1.7, height: 2.5, cross: true },
    // Trackside mesh fence panel. static: true so it holds still along the
    // road rather than swinging to face the camera — place with
    // rotY: Math.PI/2 so the panel runs parallel to the track.
    fence: { folder: "assets/textures/fence/", width: 3.4, height: 1.9, static: true },
    // Service bridge over the road: legs reach the image's own bottom edge
    // and the span between them is transparent, same drive-through
    // convention as gantry/ above. Place at offset 0, yOffset 0.
    bridge: { folder: "assets/textures/bridge/", width: 15.5, height: 9.7, static: true },
    flag: { folder: "assets/textures/flag/", width: 1.3, height: 2.6 },
    obelisk: { folder: "assets/textures/obelisk/", width: 1.6, height: 4.8 },
    chevron: { folder: "assets/textures/chevron/", width: 2.2, height: 1.05, static: true },
    grandstand: { folder: "assets/textures/grandstand/", width: 9, height: 2.7, static: true },
    pitbox: { folder: "assets/textures/pitbox/", width: 6.4, height: 2.0, static: true },
    // ---- Giza Desert Raceway kit ----
    // Giza plateau skyline (three pyramids, coursed stone bands, capstone
    // remnant) — the desert horizon backdrop. static: true. Sized down from
    // an earlier 110x38 pass that dwarfed everything else on the track at
    // typical horizon-spline distance; 80x27.7 still reads as monumental at
    // the 55-95m this is placed at without swallowing the frame.
    pyramid: { folder: "assets/textures/pyramid/", width: 80, height: 27.7, static: true },
    // The Great Sphinx now ships as a real 3D hero prop (OBJECT_TYPES.sphinx
    // in trackObjects.js, built by buildSphinx in this file) placed close to
    // the road at Sphinx Sweep, not this cutout — a billboard read as flat
    // paper at the range the corner reveals it. This folder is kept
    // registered (unused by the shipped track) in case a distant echo
    // silhouette is ever wanted well past the 3D one on the horizon spline;
    // per the one-representation-per-class-in-view rule, don't place both
    // in sight of each other.
    sphinx: { folder: "assets/textures/sphinx/", width: 26, height: 11, static: true },
    // Old Cairo skyline — the Old Town horizon, distinct from the shared
    // Roman-ish `skyline` and Tokyo `citySkyline` folders other tracks
    // depend on. All 3 images are plain flat-roofed concrete apartment
    // blocks (roof water tanks/dishes, punched windows) — real Cairo's
    // ordinary building stock. static: true backdrop. Sized down from an
    // earlier 100x30 pass that over-dominated the horizon at typical
    // placement distance.
    cairoSkyline: { folder: "assets/textures/cairoSkyline/", width: 78, height: 23.4, static: true },
    // The ONE mosque — a single dome + twin minarets rising over a low
    // rooftop line. Deliberately its own one-image folder rather than a
    // 4th cairoSkyline variant: a repeating band would pick it at random
    // right alongside the plain apartment blocks, diluting "rare landmark"
    // into "1-in-4 chance." Placed exactly once, as a `point`, on the
    // Corkscrew's approach. static: true.
    cairoMosque: { folder: "assets/textures/cairoMosque/", width: 30, height: 13.5, static: true },
    // Broken pylon gate / papyrus columns — Egyptian archaeological ruins
    // framing the outer desert circuit. Deliberately a NEW folder, not
    // more images in the Roman `ruins/` folder (aqueduct+temple) that
    // Circuito di Roma depends on. static: true (mid-far backdrop).
    ruinsEgypt: { folder: "assets/textures/ruinsEgypt/", width: 26, height: 10, static: true },
    // Scattered Bedouin tents framing the outer desert sections. Camera-
    // facing (not static) like crowd/building — a tent silhouette reads
    // fine re-facing at the distance these sit.
    bedouinTent: { folder: "assets/textures/bedouinTent/", width: 5, height: 3 },
    // Palm trees (plaza + desert oases). cross: true, same shimmer-avoidance
    // reasoning as tree/pine/conifer above.
    palm: { folder: "assets/textures/palm/", width: 2.6, height: 6.5, cross: true },
    // Low rolling sand-dune banks — foreground desert scatter. static: true
    // (a landform, not something that should spin to face the camera).
    dune: { folder: "assets/textures/dune/", width: 22, height: 7, static: true },
    // Cable + hanging-lantern span over the Corkscrew's narrow streets —
    // same drive-through convention as gantry/bridge (legs reach the
    // image's own bottom edge, transparent middle). static: true.
    cableSpan: { folder: "assets/textures/cableSpan/", width: 8, height: 7, static: true },
    // Old Town market stall, close to the Corkscrew's barrier line.
    // Camera-facing like lamp/flag/obelisk — small roadside furniture.
    marketStall: { folder: "assets/textures/marketStall/", width: 3.2, height: 2.4 },
    // ---- Monaco Street Circuit kit ----
    // Monegasque red/white bicolour pennant — deliberately its own folder,
    // not more images in the shared `flag` folder above (that one is
    // italia.png/roma.png, locked to Circuito di Roma per the theme-gating
    // rule). Small trackside/marshal-post flourish, camera-facing.
    flagMonaco: { folder: "assets/textures/flagMonaco/", width: 1.3, height: 2.6 },
    // Distant Riviera hillside — pastel apartment blocks stacked up a green
    // hillside, the "city rising almost vertically from the water" backdrop
    // the brief calls for. static: true (fixed horizon art, never camera-
    // facing) — placed on an extraSpline behind the climbing section.
    rivieraSkyline: { folder: "assets/textures/rivieraSkyline/", width: 90, height: 30, static: true },
  },
  // Rigged crowd kits authored in crowdEditor.html (see that page + the
  // "crowd" trackObjects type below) — every *.crowd.json dropped here is
  // auto-discovered the same way as the folders above. Each placed "Crowd"
  // instance picks a random loaded kit, then a random figure from it (see
  // src/crowd.js). Safe to point at even while empty: falls back to the
  // same generic labeled-card placeholder as an empty Cutout folder.
  crowdFolder: "assets/crowd/",
};

// Every ASSETS.*.folder/url string above is a path relative to game/ (they
// double as the exact strings tools/build-car.js prints for pasting into
// ASSETS.carModels, and what a human edits by hand) — resolved against this
// module's own file rather than whatever document imported it, since
// editor/ pages (preview.html, carViewer.html, editor.html, crowdEditor.html)
// sit one level away from game/ while game/index.html sits right next to it.
// Plain string concat, not `new URL(p, GAME_ROOT)` — the URL constructor
// percent-encodes spaces (car filenames have them, e.g. "scene (11) red.gltf"),
// and loadGLTF's own encodeURI() below would then double-encode them.
const GAME_ROOT = new URL("../../game/", import.meta.url).href;
const gamePath = (p) => GAME_ROOT + p;

const loader = new GLTFLoader();
const modelCache = new Map();
const carKey = (id) => `__car_${id}`;

export function loadGLTF(url) {
  return new Promise((resolve, reject) =>
    loader.load(encodeURI(url), (g) => resolve(g.scene), undefined, reject)
  );
}

// Directory-listing discovery (Python's http.server returns one
// automatically) — same trick as levels.js/carProfiles.js/crowd.js's
// discoverCrowdKitUrls, here for assets/models/cars/.
async function discoverCarUrls(folderUrl) {
  try {
    const res = await fetch(folderUrl);
    if (!res.ok) return [];
    const html = await res.text();
    const hrefs = [...html.matchAll(/href="([^"]+\.(?:gltf|glb))"/gi)].map((m) => m[1]);
    const base = new URL(folderUrl, location.href);
    return [...new Set(hrefs)].map((h) => new URL(h, base).href);
  } catch {
    return [];
  }
}

// filename -> display name ("green5" -> "Green5", "gt-coupe" -> "Gt Coupe")
// — a reasonable guess, not a hand-picked name (no "#" numbering, no word-
// splitting a bare "green5"). Add an explicit ASSETS.carModels entry instead
// if a specific display name matters.
function humanizeCarName(id) {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Cars dropped into assets/models/cars/ with no ASSETS.carModels entry of
// their own get one auto-generated — id/name from the filename, no physics/
// wheelOffset override, i.e. exactly the "sensible default" every other
// car with no override already gets: fits the shared WHEEL baseline, RWD
// via the drivetrain-default profile fallback (see carProfiles.js). Mutates
// ASSETS.carModels in place so every consumer (menu, tuning lab,
// randomCarId, buildOpponentCar, ...) just sees a longer list — called once
// from preloadAssets(), before it starts loading each car's model.
async function discoverCarModels() {
  const urls = await discoverCarUrls(gamePath("assets/models/cars/"));
  const knownFiles = new Set(ASSETS.carModels.map((c) => c.url.split("/").pop()));
  const knownIds = new Set(ASSETS.carModels.map((c) => c.id));
  for (const url of urls) {
    const filename = decodeURIComponent(url.split("/").pop());
    if (knownFiles.has(filename)) continue; // already hand-registered — don't double up
    const id = filename.replace(/\.(gltf|glb)$/i, "");
    if (knownIds.has(id)) continue; // id collision safety
    ASSETS.carModels.push({ id, name: humanizeCarName(id), url: `assets/models/cars/${filename}` });
    knownIds.add(id);
  }
}

// Picks a random registered car model's id — used for AI opponents so a
// grid of them doesn't render as identical clones. Returns null if no car
// models are registered (buildOpponentCar falls back to the boxy placeholder).
export function randomCarId() {
  if (!ASSETS.carModels.length) return null;
  return ASSETS.carModels[Math.floor(Math.random() * ASSETS.carModels.length)].id;
}

const crowdKits = [];

export async function preloadAssets() {
  await discoverCarModels(); // must finish before the ASSETS.carModels loop below
  const jobs = Object.entries(ASSETS.models).map(async ([name, url]) => {
    modelCache.set(name, await loadGLTF(gamePath(url)));
  });
  for (const car of ASSETS.carModels) {
    jobs.push(loadGLTF(gamePath(car.url)).then((m) => modelCache.set(carKey(car.id), m)));
  }
  // Every registered ribbon atlas, not a hardcoded pair — adding a key to
  // ASSETS.ribbonFolders is supposed to be the whole job, and a key that
  // never got preloaded silently renders the red/white fallback stripe.
  for (const [key, folder] of Object.entries(ASSETS.ribbonFolders)) {
    jobs.push(loadRibbonAtlas(key, gamePath(folder), drawFallbackBarrierVariants));
  }
  if (ASSETS.roadFolder) jobs.push(loadRoadTextures(gamePath(ASSETS.roadFolder)));
  for (const [key, spec] of Object.entries(ASSETS.spriteFolders)) {
    jobs.push(loadCutoutVariants(key, spec.folder ? gamePath(spec.folder) : spec.folder));
  }
  if (ASSETS.crowdFolder) {
    jobs.push((async () => {
      const urls = await discoverCrowdKitUrls(gamePath(ASSETS.crowdFolder));
      const kits = await Promise.all(urls.map((u) => loadCrowdKitFromUrl(u).catch(() => null)));
      crowdKits.push(...kits.filter(Boolean));
      buildCrowdPool(); // must run after crowdKits is populated, before this job (and preloadAssets) resolves
    })());
  }
  await Promise.all(jobs);
}

function cachedClone(name) {
  const m = modelCache.get(name);
  if (!m) return null;
  const clone = m.clone(true);
  clone.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  return clone;
}

// ---------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------

// PS1-era look = low resolution + normal bilinear/mipmap filtering + a light
// RANDOM (not tiled/Bayer) brightness jitter scaling R/G/B together (hue/sat
// never shift) — same grain trick crowd.js's coloredSilhouette uses. A
// periodic dither pattern here reads as an aliased checkerboard; this doesn't.
function addGrain(ctx, w, h, amount = 0.08) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue; // leave fully transparent pixels alone
    const scale = 1 + (Math.random() * 2 - 1) * amount;
    d[i] = Math.max(0, Math.min(255, Math.round(d[i] * scale)));
    d[i + 1] = Math.max(0, Math.min(255, Math.round(d[i + 1] * scale)));
    d[i + 2] = Math.max(0, Math.min(255, Math.round(d[i + 2] * scale)));
  }
  ctx.putImageData(img, 0, 0);
}

function canvasTexture(w, h, draw, amount = 0.08) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  draw(ctx, w, h);
  addGrain(ctx, w, h, amount);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function asphaltTexture() {
  // u spans the full road width; white edge lines + dashed center baked in.
  return canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = "#303236";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 400; i++) {
      const g = 40 + Math.random() * 30;
      ctx.fillStyle = `rgba(${g},${g},${g + 4},${0.25 + Math.random() * 0.3})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
    }
    ctx.fillStyle = "rgba(235,235,235,0.9)";
    ctx.fillRect(3, 0, 3, h);
    ctx.fillRect(w - 6, 0, 3, h);
    ctx.fillStyle = "rgba(240,220,120,0.75)";
    ctx.fillRect(w / 2 - 2, 0, 3, h * 0.28);
    ctx.fillRect(w / 2 - 2, h * 0.5, 3, h * 0.28);
  });
}

// Plain tarmac (no lane markings) — the "Spline Tarmac" ribbon's surface
// for pit aprons / service areas.
export function tarmacTexture() {
  return canvasTexture(64, 64, (ctx, w, h) => {
    ctx.fillStyle = "#33353a";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 120; i++) {
      const g = 44 + Math.random() * 26;
      ctx.fillStyle = `rgba(${g},${g},${g + 4},${0.3 + Math.random() * 0.3})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
    }
  });
}

// scheme: "redwhite" (default, every existing track keeps this look
// unchanged) | "yellow" (mountain-circuit painted-kerb look, opted into via
// a splineApexKerb band's `tex` field -- see buildSplineApexKerbRibbon).
// Same striped-block layout either way, just a different palette, so this
// stays a pure drop-in: no caller that doesn't pass a scheme is affected.
export function kerbTexture(scheme = "redwhite") {
  const palette = scheme === "yellow" ? ["#e8e8e8", "#e0a91c"] : ["#e8e8e8", "#d3382e"];
  return canvasTexture(64, 16, (ctx, w, h) => {
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 ? palette[0] : palette[1];
      ctx.fillRect(i * (w / 4), 0, w / 4, h);
    }
  });
}

// Enclosing tunnel bore walls/ceiling (see trackObjects.js's splineTunnel) —
// plain procedural concrete, not the sponsor-atlas system: a tunnel bore
// should read as one consistent structure, not sponsor-board variety.
export function tunnelWallTexture() {
  return canvasTexture(64, 64, (ctx, w, h) => {
    ctx.fillStyle = "#4a4d52";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    for (let i = 0; i <= 4; i++) {
      const x = (i / 4) * w;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let i = 0; i < 40; i++) {
      const g = 40 + Math.random() * 30;
      ctx.fillStyle = `rgba(${g | 0},${g | 0},${(g + 3) | 0},${0.12 + Math.random() * 0.18})`;
      ctx.fillRect(Math.random() * w, 0, 1, h);
    }
  });
}

export function tunnelCeilingTexture() {
  return canvasTexture(64, 32, (ctx, w, h) => {
    ctx.fillStyle = "#35373b";
    ctx.fillRect(0, 0, w, h);
    // embedded fluorescent light strip down the middle (v isn't tiled on a
    // ribbonFlatGeometry roof, so this sits as one continuous line the
    // length of the tunnel)
    ctx.fillStyle = "rgba(255,225,180,0.55)";
    ctx.fillRect(0, h * 0.28, w, h * 0.44);
    ctx.fillStyle = "#ffdca0";
    ctx.fillRect(0, h * 0.42, w, h * 0.16);
  });
}

// Overpass pier — lighter than tunnelWallTexture on purpose (a pier stands
// against open night sky/distant buildings, not lit tunnel walls, so it
// needs its own contrast to read at a glance) with a painted hazard band
// near its base, same convention as real elevated-highway piers.
export function pillarTexture() {
  return canvasTexture(64, 64, (ctx, w, h) => {
    ctx.fillStyle = "#a8a8ac";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(70,70,74,0.6)";
    for (const sy of [0, h / 3, (h * 2) / 3, h]) {
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(w, sy); ctx.stroke();
    }
    // Drawn near both texture edges, not just one — CanvasTexture v-flip
    // convention isn't worth pinning down for a decorative stripe; this way
    // it reads right regardless of which end lands at the ground.
    const bandH = h * 0.14;
    for (let i = 0, x = 0; x < w; i++, x += w / 8) {
      ctx.fillStyle = i % 2 === 0 ? "#ebb21e" : "#1e1e1c";
      ctx.fillRect(x, h - bandH, w / 8, bandH);
      ctx.fillRect(x, 0, w / 8, bandH);
    }
  });
}

export function wallTexture() {
  return canvasTexture(64, 32, (ctx, w, h) => {
    ctx.fillStyle = "#e8e8e6";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#c8372f";
    ctx.fillRect(0, h * 0.45, w, h * 0.55);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(0, 0, w, 2);
    ctx.fillRect(w - 2, 0, 2, h);
  });
}

// ---------------------------------------------------------------------
// Ribbon texture atlas — "Spline Barrier" is one continuous strip mesh, so
// variety can't come from swapping materials per segment (that's the
// many-draw-calls cost discrete barriers already fixed). All variants get
// baked into one shared atlas canvas; each length-segment's UVs point at a
// random cell — one draw call regardless of variant count.
// ---------------------------------------------------------------------

const RIBBON_CELL = 256;
const ribbonAtlasCache = new Map();

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// Parses a directory-listing HTML page (what Python's `http.server` returns
// for a folder URL) for image links. Any host that doesn't return a listing
// (most static hosts) just yields no matches — callers fall back cleanly.
async function discoverFolderImages(folderUrl) {
  try {
    const res = await fetch(folderUrl);
    if (!res.ok) return [];
    const html = await res.text();
    const hrefs = [...html.matchAll(/href="([^"]+\.(?:png|jpe?g|webp))"/gi)].map((m) => m[1]);
    const base = new URL(folderUrl, location.href);
    const urls = [...new Set(hrefs)].map((h) => new URL(h, base).href);
    const imgs = await Promise.all(urls.map(loadImage));
    return imgs.filter(Boolean);
  } catch {
    return [];
  }
}

// A real discovered image becomes its own texture directly (unlike the
// barrier ribbon, which bakes variants into one shared atlas — discrete
// crowd instances don't need that, each just gets a whole material). No
// wrap/repeat: a dropped-in photo/cutout is meant to show once per plane,
// not tile.
function textureFromImage(img) {
  const tex = new THREE.Texture(img);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Box-downsample by repeated halving (each step properly averages 2x2)
// then one final smooth resize to maxDim. Hi-res cutout art nearest-
// sampled at ~300p internal res shimmers hard in minification — averaging
// down to near screen scale first is most of the fix; mip-nearest
// sampling at render time (main.js applyTextureFiltering) is the rest.
function downsampleImage(img, maxDim) {
  let w = img.width, h = img.height;
  if (Math.max(w, h) <= maxDim) return img;
  let src = img;
  while (Math.max(w, h) > maxDim * 2) {
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(src, 0, 0, w, h);
    src = c;
  }
  const s = maxDim / Math.max(w, h);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function spriteTextureFromImage(img, maxDim, crisp = false) {
  const tex = textureFromImage(downsampleImage(img, maxDim));
  tex.userData.spriteMip = true; // billboards are nearly always minified: keep mips even in PS1 mode
  // crisp: pick ONE mip level (no inter-level blend blur). Safe only for
  // non-rotating sprites (cross trees) — re-facing sprites wobble the
  // level choice, which is why the others keep the smooth blend.
  tex.userData.crispMip = crisp;
  tex.anisotropy = 1;
  return tex;
}

function drawFallbackBarrierVariants(ctx, n) {
  const palettes = [
    ["#e8e8e6", "#c8372f"],
    ["#e8e8e6", "#2b4fae"],
    ["#f2e6b8", "#1c1f26"],
  ];
  for (let i = 0; i < n; i++) {
    const [a, b] = palettes[i % palettes.length];
    ctx.fillStyle = a;
    ctx.fillRect(i * RIBBON_CELL, 0, RIBBON_CELL, RIBBON_CELL);
    ctx.fillStyle = b;
    ctx.fillRect(i * RIBBON_CELL, RIBBON_CELL * 0.45, RIBBON_CELL, RIBBON_CELL * 0.22);
  }
}

// Loads (or falls back to procedural placeholders for) a ribbon type's
// texture variants and bakes them into one shared atlas. Call during
// preloadAssets() so it's ready before any track builds.
async function loadRibbonAtlas(key, folderUrl, drawFallback) {
  const real = folderUrl ? await discoverFolderImages(folderUrl) : [];
  const n = Math.max(1, real.length);
  const c = document.createElement("canvas");
  c.width = RIBBON_CELL * n;
  c.height = RIBBON_CELL;
  const ctx = c.getContext("2d");
  if (real.length) real.forEach((img, i) => ctx.drawImage(img, i * RIBBON_CELL, 0, RIBBON_CELL, RIBBON_CELL));
  else drawFallback(ctx, n);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  ribbonAtlasCache.set(key, { texture, count: n });
}

// Synchronous accessor for trackObjects.js. preloadAssets() is always
// awaited before any track builds, so the real atlas should already be
// cached; this lazy single-variant fallback exists only so a ribbon never
// throws if something calls it before that resolves.
export function getRibbonAtlas(key) {
  if (!ribbonAtlasCache.has(key)) {
    const c = document.createElement("canvas");
    c.width = c.height = RIBBON_CELL;
    drawFallbackBarrierVariants(c.getContext("2d"), 1);
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    ribbonAtlasCache.set(key, { texture, count: 1 });
  }
  return ribbonAtlasCache.get(key);
}

// ---------------------------------------------------------------------
// Road-surface textures — one file per surface in ASSETS.roadFolder; the
// "Spline Tarmac" ribbon looks one up by name (its band's `tex` field).
// ---------------------------------------------------------------------

const roadTextureCache = new Map();

// Overlay detection: any transparent pixel means this surface is a decal
// strip meant to be laid over the road, not an opaque surface.
function imageHasAlpha(img) {
  const size = 32;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, size, size);
  const d = ctx.getImageData(0, 0, size, size).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

async function loadRoadTextures(folderUrl) {
  const imgs = await discoverFolderImages(folderUrl);
  for (const img of imgs) {
    const name = decodeURIComponent(img.src.split("/").pop()).replace(/\.[^.]+$/, "");
    const texture = textureFromImage(img);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    roadTextureCache.set(name, { texture, hasAlpha: imageHasAlpha(img) });
  }
}

// Synchronous accessor for trackObjects.js (same contract as getRibbonAtlas):
// preloadAssets() resolves before any track builds, so a miss just means no
// file by that name exists — fall back to the procedural plain tarmac.
export function getRoadTexture(name) {
  if (!roadTextureCache.has(name)) {
    roadTextureCache.set(name, { texture: tarmacTexture(), hasAlpha: false });
  }
  return roadTextureCache.get(name);
}

export function grassTexture(baseColor) {
  return canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, w, h);
    const base = ctx.getImageData(0, 0, 1, 1).data;
    for (let i = 0; i < 550; i++) {
      const k = 0.75 + Math.random() * 0.5;
      ctx.fillStyle = `rgba(${base[0] * k | 0},${base[1] * k | 0},${base[2] * k | 0},0.5)`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
    }
  });
}

export function desertTexture(baseColor) {
  return canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, w, h);
    const base = ctx.getImageData(0, 0, 1, 1).data;
    // sparse sand-ripple flecks — sand reads far more uniform than grass
    for (let i = 0; i < 125; i++) {
      const k = 0.82 + Math.random() * 0.35;
      ctx.fillStyle = `rgba(${base[0] * k | 0},${base[1] * k | 0},${base[2] * k | 0},0.35)`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 2, 1);
    }
    // occasional dark pebble specks
    for (let i = 0; i < 30; i++) {
      ctx.fillStyle = `rgba(80,65,50,${0.2 + Math.random() * 0.3})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
    }
  });
}

export function checkerTexture() {
  return canvasTexture(64, 16, (ctx, w, h) => {
    const s = 8;
    for (let x = 0; x < w / s; x++)
      for (let y = 0; y < h / s; y++) {
        ctx.fillStyle = (x + y) % 2 ? "#111" : "#f2f2f2";
        ctx.fillRect(x * s, y * s, s, s);
      }
  });
}

const BILLBOARD_TEXTS = ["YOUR AD HERE", "PLACEHOLDER™", "SWAP ME", "TIRE CO.", "MEGA CORP", "INSERT SPONSOR"];

// Lazily builds and caches one material (texture + all) per BILLBOARD_TEXTS
// entry (6 total, same idea as cutoutMaterialCache below) instead of a
// fresh 256x128 canvas + GPU upload per placed billboard instance — same
// stutter risk buildTree/buildRock had before their fix, just worse
// per-instance since this canvas is ~128x bigger.
const billboardMatCache = new Map();
function cachedBillboardMaterial(index) {
  if (!billboardMatCache.has(index)) {
    const tex = billboardTexture(BILLBOARD_TEXTS[index], (index * 360) / BILLBOARD_TEXTS.length);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, side: THREE.DoubleSide });
    mat.userData.shared = true;
    billboardMatCache.set(index, mat);
  }
  return billboardMatCache.get(index);
}

export function billboardTexture(text, hue) {
  const tex = canvasTexture(256, 128, (ctx, w, h) => {
    ctx.fillStyle = `hsl(${hue | 0}, 60%, 82%)`;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#1c1f26";
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, w - 10, h - 10);
    ctx.fillStyle = "#1c1f26";
    ctx.font = "bold 30px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, w / 2, h / 2);
  });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// ---------------------------------------------------------------------
// Prop builders (all check the registry first)
// ---------------------------------------------------------------------

// std() is called per prop *instance* (every scattered tree/rock/wheel), so
// a fresh canvas+upload per call was a real stutter source once scatter
// counts hit the hundreds. One shared neutral (white) grained texture +
// material `color` tinting (color*map) gives the same look for one texture total.
let _propGrainTex = null;
function propGrainTexture() {
  if (!_propGrainTex) {
    _propGrainTex = canvasTexture(16, 16, (ctx, w, h) => {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
    });
    _propGrainTex.repeat.set(3, 3);
    _propGrainTex.userData.shared = true;
  }
  return _propGrainTex;
}

function std(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, map: propGrainTexture(), roughness: 0.9, metalness: 0, ...extra });
}

export function buildTree(rng) {
  const real = cachedClone("tree");
  if (real) return real;
  const g = new THREE.Group();
  const h = 2.5 + rng() * 3;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, h * 0.35, 6), std(0x6b4a2b));
  trunk.position.y = h * 0.175;
  const leaf = new THREE.Mesh(
    new THREE.ConeGeometry(h * 0.28, h * 0.75, 7),
    std(new THREE.Color().setHSL(0.28 + rng() * 0.07, 0.45, 0.24 + rng() * 0.12))
  );
  leaf.position.y = h * 0.35 + h * 0.37;
  trunk.castShadow = leaf.castShadow = true;
  g.add(trunk, leaf);
  return g;
}

export function buildRock(rng) {
  const real = cachedClone("rock");
  if (real) return real;
  const r = 0.4 + rng() * 1.3;
  const rock = new THREE.Mesh(
    new THREE.IcosahedronGeometry(r, 0),
    std(new THREE.Color().setHSL(0.08, 0.08 + rng() * 0.1, 0.4 + rng() * 0.15), { flatShading: true })
  );
  rock.scale.y = 0.55 + rng() * 0.3;
  rock.position.y = r * rock.scale.y * 0.5;
  rock.castShadow = true;
  const g = new THREE.Group();
  g.add(rock);
  return g;
}

// Concrete support pier for an elevated deck (e.g. an overpass extraSpline's
// "pillar" points) — a plain tapered column. Origin is at the TOP (geometry
// translated so it spans local y = -1..0) so a point placed AT deck height
// with scaleY = (deck height above ground) hangs straight down and plants
// itself in the ground without needing a separate yOffset per instance.
let _pillarGeo = null, _pillarMat = null;
function pillarAssets() {
  if (_pillarMat) return;
  const shaft = new THREE.CylinderGeometry(0.85, 1.3, 1, 10);
  shaft.translate(0, -0.5, 0);
  _pillarGeo = shaft;
  _pillarMat = new THREE.MeshStandardMaterial({ map: pillarTexture(), roughness: 0.85 });
  _pillarGeo.userData.shared = true;
  _pillarMat.userData.shared = true;
}
export function buildPillar(rng) {
  pillarAssets();
  const mesh = new THREE.Mesh(_pillarGeo, _pillarMat);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

// Real 3D Tokyo-expressway mast-arm sodium lamp — a "real real 3D prop", not
// a billboard: a cutout re-faces the camera every frame, which means its arm
// (and therefore its bulb) doesn't sit at a fixed point in world space, so a
// light/cone attached to "the bulb" can never actually line up with the art.
// A rigid mesh has no such problem — pole, arm, and fixture are one fixed
// shape, and the light/cone are parented at the fixture's exact local
// position. Faces along the object's local +Z like every other non-billboard
// prop here (orient() in trackObjects.js sets yaw from track tangent); the
// arm reaches out along local -X — pick the placing band's `side` so that's
// toward the road, or add rotY: Math.PI on the band if it comes out backwards.
const LAMP_POLE_HEIGHT = 6.2;
const LAMP_ARM_END = new THREE.Vector3(-1.7, 6.85, 0);
let _lampPoleGeo = null, _lampArmGeo = null, _lampFixtureGeo = null, _lampMetalMat = null, _lampBulbMat = null;

function lampAssets() {
  if (_lampMetalMat) return;
  _lampPoleGeo = new THREE.CylinderGeometry(0.09, 0.13, LAMP_POLE_HEIGHT, 8);
  _lampPoleGeo.translate(0, LAMP_POLE_HEIGHT / 2, 0);
  const armVec = LAMP_ARM_END.clone().sub(new THREE.Vector3(0, LAMP_POLE_HEIGHT, 0));
  _lampArmGeo = new THREE.CylinderGeometry(0.06, 0.08, armVec.length(), 6);
  _lampArmGeo.translate(0, armVec.length() / 2, 0); // base at the local origin, tip toward +Y, before the tilt below
  _lampArmGeo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), armVec.clone().normalize()));
  _lampFixtureGeo = new THREE.BoxGeometry(0.5, 0.18, 0.3);
  _lampMetalMat = std(0x33363c, { metalness: 0.4, roughness: 0.55 });
  _lampBulbMat = new THREE.MeshStandardMaterial({ color: 0xfff0d0, emissive: 0xffb066, emissiveIntensity: 2.2, roughness: 0.4 });
  for (const shared of [_lampPoleGeo, _lampArmGeo, _lampFixtureGeo, _lampMetalMat, _lampBulbMat]) shared.userData.shared = true;
}

export function buildLampTokyo(rng) {
  lampAssets();
  const g = new THREE.Group();
  const pole = new THREE.Mesh(_lampPoleGeo, _lampMetalMat);
  pole.position.set(0, 0, 0);
  pole.castShadow = true;
  g.add(pole);
  const arm = new THREE.Mesh(_lampArmGeo, _lampMetalMat);
  arm.position.set(0, LAMP_POLE_HEIGHT, 0);
  arm.castShadow = true;
  g.add(arm);
  const fixture = new THREE.Mesh(_lampFixtureGeo, _lampMetalMat);
  fixture.position.copy(LAMP_ARM_END);
  fixture.castShadow = true;
  g.add(fixture);
  const bulb = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.22), _lampBulbMat);
  bulb.position.set(LAMP_ARM_END.x, LAMP_ARM_END.y - 0.1, LAMP_ARM_END.z);
  bulb.rotation.x = -Math.PI / 2; // face down at the road
  g.add(bulb);

  const light = new THREE.PointLight(0xffb066, 1.6, 17, 2);
  light.position.set(LAMP_ARM_END.x, LAMP_ARM_END.y - 0.1, LAMP_ARM_END.z);
  light.castShadow = false;
  g.add(light);
  const cone = buildLightCone(0xffb066, 17 * 0.22, light.position.y, 0.1);
  cone.position.copy(light.position);
  g.add(cone);
  return g;
}

// Short Armco-style guardrail — the default "barrier" type. Geometry/
// material are cached module-level singletons (100+ instances per track;
// per-instance canvas generation was the dominant slow-rebuild cost).
// Convention: forward is local +Z, so the long axis must run along Z or
// every barrier ends up perpendicular to the road instead of parallel.
const BARRIER_HEIGHT = 0.55; // matches the old default wall height
// Distance from this prop's ORIGIN to its road-facing surface. A band's
// `offset` positions the origin, so trackObjects.js's computeWallProfile has
// to subtract this to put the physics wall on the face the driver can see
// rather than half a prop behind it. Swapping in a real GLTF via
// ASSETS.models.barrier means measuring its own half-thickness here.
export const BARRIER_HALF_THICKNESS = 0.05;
// Half-extent ALONG the track (local Z, the long axis) — computeWallProfile
// needs it because a band's from/to positions instance CENTERS, so the props
// reach this much further along the track than the band's own range.
export const BARRIER_HALF_LENGTH = 1.1;
let _barrierPostGeo = null, _barrierBeamGeo = null, _barrierPostMat = null, _barrierBeamMat = null;

function barrierAssets() {
  if (_barrierBeamMat) return;
  const t = BARRIER_HALF_THICKNESS;
  _barrierPostGeo = new THREE.CylinderGeometry(t, t, BARRIER_HEIGHT, 6);
  _barrierBeamGeo = new THREE.BoxGeometry(t * 2, BARRIER_HEIGHT * 0.55, BARRIER_HALF_LENGTH * 2); // long axis Z
  _barrierPostMat = std(0x3a3f47, { metalness: 0.3, roughness: 0.6 });
  _barrierBeamMat = new THREE.MeshStandardMaterial({ map: wallTexture(), roughness: 0.7 });
  for (const shared of [_barrierPostGeo, _barrierBeamGeo, _barrierPostMat, _barrierBeamMat]) shared.userData.shared = true;
}

export function buildBarrier(rng) {
  const real = cachedClone("barrier");
  if (real) return real;
  barrierAssets();
  const g = new THREE.Group();
  for (const z of [-1.0, 1.0]) {
    const post = new THREE.Mesh(_barrierPostGeo, _barrierPostMat);
    post.position.set(0, BARRIER_HEIGHT / 2, z);
    post.castShadow = true;
    g.add(post);
  }
  const beam = new THREE.Mesh(_barrierBeamGeo, _barrierBeamMat);
  beam.position.y = BARRIER_HEIGHT * 0.62;
  beam.castShadow = beam.receiveShadow = true;
  g.add(beam);
  return g;
}

// Short striped curbstone block — the default "apexKerb" object. Same
// long-axis-along-Z and asset-caching reasoning as buildBarrier above.
let _apexKerbGeo = null, _apexKerbMat = null;

function apexKerbAssets() {
  if (_apexKerbMat) return;
  _apexKerbGeo = new THREE.BoxGeometry(0.4, 0.12, 1); // long axis Z
  _apexKerbMat = new THREE.MeshStandardMaterial({ map: kerbTexture(), roughness: 0.8 });
  _apexKerbGeo.userData.shared = true;
  _apexKerbMat.userData.shared = true;
}

export function buildApexKerb(rng) {
  const real = cachedClone("apexKerb");
  if (real) return real;
  apexKerbAssets();
  const block = new THREE.Mesh(_apexKerbGeo, _apexKerbMat);
  block.position.y = 0.06;
  block.receiveShadow = block.castShadow = true;
  const g = new THREE.Group();
  g.add(block);
  return g;
}

// Tire-stack tower — a lighter, cheaper-looking "Tire Barrier" alternative
// to buildBarrier's Armco rail, alternating red/white per tire the same way
// kerbTexture does. Radially symmetric (each tire is just a squat cylinder
// stacked on the last), so unlike buildBarrier/buildApexKerb it doesn't need
// a "long axis along Z" convention — orient()'s heading rotation is a no-op
// on it either way.
// TIRE_RADIUS doubles as this prop's origin-to-road-facing-surface distance
// (a stack is centered on the band offset) — see BARRIER_HALF_THICKNESS.
export const TIRE_RADIUS = 0.24;
const TIRE_HEIGHT = 0.17, TIRE_COUNT = 4;
let _tireGeo = null, _tireMatRed = null, _tireMatWhite = null;

function tireBarrierAssets() {
  if (_tireMatRed) return;
  _tireGeo = new THREE.CylinderGeometry(TIRE_RADIUS, TIRE_RADIUS, TIRE_HEIGHT, 16);
  _tireMatRed = std(0xd3382e, { roughness: 0.85 });
  _tireMatWhite = std(0xe8e8e8, { roughness: 0.85 });
  for (const shared of [_tireGeo, _tireMatRed, _tireMatWhite]) shared.userData.shared = true;
}

export function buildTireBarrier(rng) {
  const real = cachedClone("tireBarrier");
  if (real) return real;
  tireBarrierAssets();
  const g = new THREE.Group();
  for (let i = 0; i < TIRE_COUNT; i++) {
    const tire = new THREE.Mesh(_tireGeo, i % 2 ? _tireMatWhite : _tireMatRed);
    // small lateral jitter per tire so the stack reads as loosely piled
    // rather than a perfectly extruded column
    tire.position.set((rng() - 0.5) * 0.06, TIRE_HEIGHT * (i + 0.5), (rng() - 0.5) * 0.06);
    tire.castShadow = tire.receiveShadow = true;
    g.add(tire);
  }
  return g;
}

// =====================================================================
// Mountain-circuit props (Trial Mountain). All three are REAL 3D geometry
// rather than cutouts on purpose: each one either sits inside the ~15 m
// band where a flat plane reads as cardboard from the chase camera, or is
// something the car can hit. Same construction rules as everything above —
// a couple of THREE primitives in a Group, module-level shared geometry/
// material so a few hundred instances don't reallocate, std()'s grained
// material for the PS1 look.
// =====================================================================

// --- granite outcrop -------------------------------------------------
// Close-range rock. A cliff face near the road CANNOT be a splineBarrier-
// style ribbon (zero-thickness plane, razor top edge, one stretched
// texture); banded with jitter + varied scaleX/Y/Z these read as a broken
// rock cut instead. Origin at ground level; a band's scaleY is "how tall".
let _rockBlockGeos = null, _rockMats = null;
function rockOutcropAssets() {
  if (_rockMats) return;
  // Four angular blocks — low-poly icosahedra squashed into slabs/shards,
  // flat-shaded so every facet is one quantized tone.
  _rockBlockGeos = [];
  for (const [rx, ry, rz] of [[1.0, 1.0, 1.0], [1.35, 0.6, 0.9], [0.7, 1.6, 0.75], [0.9, 1.1, 1.4]]) {
    const g = new THREE.IcosahedronGeometry(1, 0);
    g.scale(rx, ry, rz);
    g.userData.shared = true;
    _rockBlockGeos.push(g);
  }
  _rockMats = [0x8d8b84, 0x9a978e, 0x7c7a75, 0xa3a099].map((c) =>
    std(c, { flatShading: true, roughness: 1 })
  );
  for (const m of _rockMats) m.userData.shared = true;
}

export function buildRockOutcrop(rng) {
  rockOutcropAssets();
  const g = new THREE.Group();
  const blocks = 2 + ((rng() * 3) | 0);
  for (let i = 0; i < blocks; i++) {
    const geo = _rockBlockGeos[(rng() * _rockBlockGeos.length) | 0];
    const m = new THREE.Mesh(geo, _rockMats[(rng() * _rockMats.length) | 0]);
    const s = (i === 0 ? 0.95 : 0.4 + rng() * 0.6) * (0.8 + rng() * 0.45);
    m.scale.set(s * (0.8 + rng() * 0.6), s * (1.0 + rng() * 0.9), s * (0.8 + rng() * 0.6));
    // keep the cluster compact: a band's scaleX/Z multiplies these offsets
    // too, so a wide spread here becomes a boulder in the road at scale 3
    m.position.set((rng() - 0.5) * 0.9, m.scale.y * (0.35 + rng() * 0.2), (rng() - 0.5) * 1.3);
    m.rotation.set((rng() - 0.5) * 0.5, rng() * Math.PI * 2, (rng() - 0.5) * 0.5);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

// --- the "monkey tree" ----------------------------------------------
// Trial Mountain's signature landmark: a dead, bleached, gnarled trunk
// leaning out over the road with bare overhanging limbs. One-off hero prop
// (placed as a `point`, not a band), so it builds its own geometry per
// instance for the gnarl to be genuinely irregular; only the two materials
// are shared. Leans and reaches along local -X, the same convention
// buildLampTokyo's arm uses — pick the point's `side` so that's the road,
// or add rotY: Math.PI.
let _deadWoodMat = null, _deadWoodDarkMat = null;
function deadWoodAssets() {
  if (_deadWoodMat) return;
  _deadWoodMat = std(0x9a9186, { roughness: 1 });
  _deadWoodDarkMat = std(0x6b6258, { roughness: 1 });
  _deadWoodMat.userData.shared = _deadWoodDarkMat.userData.shared = true;
}

// One tapered limb from `a` to `b`, oriented by rotating +Y onto (b-a).
function limb(a, b, r0, r1, mat) {
  const v = b.clone().sub(a);
  const geo = new THREE.CylinderGeometry(r1, r0, v.length(), 5);
  geo.translate(0, v.length() / 2, 0);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.clone().normalize()));
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(a);
  m.castShadow = true;
  return m;
}

export function buildMonkeyTree(rng) {
  deadWoodAssets();
  const g = new THREE.Group();
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  // trunk: three kinked segments, leaning out over the road (-X)
  const p0 = V(0, 0, 0);
  const p1 = V(-0.35 - rng() * 0.2, 2.1, 0.15 * (rng() - 0.5));
  const p2 = V(-1.15 - rng() * 0.4, 3.9, 0.3 * (rng() - 0.5));
  const p3 = V(-2.5 - rng() * 0.6, 5.0 + rng() * 0.5, 0.4 * (rng() - 0.5));
  g.add(limb(p0, p1, 0.42, 0.30, _deadWoodDarkMat));
  g.add(limb(p1, p2, 0.30, 0.20, _deadWoodMat));
  g.add(limb(p2, p3, 0.20, 0.10, _deadWoodMat));
  // root flare so it doesn't look pushed into the ground like a peg
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rng() * 0.6;
    g.add(limb(V(0, 0.35, 0), V(Math.cos(a) * 0.7, 0, Math.sin(a) * 0.7), 0.16, 0.07, _deadWoodDarkMat));
  }
  // bare overhanging limbs, weighted out over the road
  const anchors = [p1, p2, p2, p3, p3, p3];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const out = 1.2 + rng() * 2.2;
    const tip = V(a.x - out * (0.35 + rng() * 0.9), a.y + 0.5 + rng() * 1.5, a.z + (rng() - 0.5) * 2.6);
    g.add(limb(a, tip, 0.13, 0.045, _deadWoodMat));
    if (rng() < 0.75) {
      const mid = a.clone().lerp(tip, 0.55);
      g.add(limb(mid, V(mid.x - rng() * 1.2, mid.y + 0.6 + rng() * 1.1, mid.z + (rng() - 0.5) * 1.6),
                 0.07, 0.025, _deadWoodMat));
    }
  }
  // one snapped-off stub, low and blunt
  g.add(limb(V(-0.2, 1.5, 0), V(0.9 + rng() * 0.5, 2.3, (rng() - 0.5) * 0.8), 0.12, 0.08, _deadWoodDarkMat));
  return g;
}

// --- timber post-and-rail --------------------------------------------
// The mountain-road guardrail: two rails on stout posts. Collidable (see
// COLLIDABLE_BARRIER_TYPES in trackObjects.js), so its half-thickness and
// half-length are exported for computeWallProfile exactly like the Armco's.
// Long axis along Z, same convention as buildBarrier/buildApexKerb.
export const TIMBER_HALF_THICKNESS = 0.09;
export const TIMBER_HALF_LENGTH = 1.15;
const TIMBER_HEIGHT = 0.72;
let _timberPostGeo = null, _timberRailGeo = null, _timberMats = null;
function timberRailAssets() {
  if (_timberMats) return;
  _timberPostGeo = new THREE.BoxGeometry(TIMBER_HALF_THICKNESS * 2.2, TIMBER_HEIGHT, 0.17);
  _timberRailGeo = new THREE.CylinderGeometry(0.075, 0.075, TIMBER_HALF_LENGTH * 2, 6);
  _timberRailGeo.rotateX(Math.PI / 2); // long axis -> Z
  _timberMats = [0x7d5f3c, 0x8a6a44, 0x6d5436].map((c) => std(c, { roughness: 1 }));
  for (const shared of [_timberPostGeo, _timberRailGeo, ..._timberMats]) shared.userData.shared = true;
}

export function buildTimberRail(rng) {
  timberRailAssets();
  const g = new THREE.Group();
  const mat = _timberMats[(rng() * _timberMats.length) | 0];
  for (const z of [-1.0, 1.0]) {
    const post = new THREE.Mesh(_timberPostGeo, mat);
    post.position.set(0, TIMBER_HEIGHT / 2, z);
    post.rotation.y = (rng() - 0.5) * 0.08; // hand-set posts, not a machined fence
    post.castShadow = post.receiveShadow = true;
    g.add(post);
  }
  for (const y of [TIMBER_HEIGHT * 0.92, TIMBER_HEIGHT * 0.52]) {
    const rail = new THREE.Mesh(_timberRailGeo, _timberMats[(rng() * _timberMats.length) | 0]);
    rail.position.set(0, y + (rng() - 0.5) * 0.03, 0);
    rail.castShadow = rail.receiveShadow = true;
    g.add(rail);
  }
  return g;
}

// --- tunnel portals ---------------------------------------------------
// A splineTunnel bore is two zero-thickness wall planes plus a flat roof
// (see buildSplineTunnelRibbon), so its mouth ends in a razor edge hanging
// in mid-air — the raw block-out look. These props are the facade that
// closes it: a collar of real geometry sized to the bore, built SYMMETRIC
// about local Z so one prop reads correctly at an entry mouth, an exit
// mouth, and from inside the bore looking out. No rotY needed either end.
//
// Geometry is authored around a NOMINAL bore — PORTAL_SPAN half-width by
// PORTAL_RISE tall, which is what both shipped tracks' tunnel bands use to
// within a few percent. A point's scaleX/scaleY adapts it to a band whose
// `offset`/`height` differ (scaleX 0.96 for a 4.4 m half-span, and so on).
// Opening spans local X (lateral), thickness runs along local Z (the road),
// matching the placePoint/orient convention every other prop here uses.
//
// The two variants are deliberately NOT a texture swap on one shape: an
// American mountain portal is a battered rubble-granite arch and a Japanese
// expressway portal is a flat precast concrete frame with a signboard, and
// the silhouettes are what make them read as different places.
export const PORTAL_SPAN = 4.6;  // opening half-width, metres
export const PORTAL_RISE = 4.6;  // opening height, metres
const PORTAL_OVERLAP = 0.08;     // how far the frame laps OVER the bore edge, so there is no seam

// ---- American mountain: coursed granite, battered piers, segmental arch
let _portalStoneMats = null, _portalUnitBox = null, _portalTrimMat = null;
function mountainPortalAssets() {
  if (_portalStoneMats) return;
  // Same granite family as buildRockOutcrop so the portal reads as cut from
  // the rock the road is already running through.
  _portalStoneMats = [0x7c7b76, 0x6e6d69, 0x8a8880, 0x63625e, 0x77746c].map((c) => std(c, { roughness: 1 }));
  _portalTrimMat = std(0x9d9a92, { roughness: 0.95 }); // dressed stone: coping + keystone
  _portalUnitBox = new THREE.BoxGeometry(1, 1, 1);
  for (const shared of [..._portalStoneMats, _portalTrimMat, _portalUnitBox]) shared.userData.shared = true;
}

export function buildTunnelPortalMountain(rng) {
  mountainPortalAssets();
  const g = new THREE.Group();
  const S = PORTAL_SPAN, H = PORTAL_RISE;
  const D = 1.3;                 // facade thickness along the road
  const W = S + 2.5;             // outer half-width of the whole facade
  const springY = H * 0.70;      // where the arch springs from the pier tops
  const parapetY = H + 2.0;      // top of the masonry, before the coping

  const block = (x, y, z, sx, sy, sz, mat) => {
    const m = new THREE.Mesh(_portalUnitBox, mat ?? _portalStoneMats[(rng() * _portalStoneMats.length) | 0]);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    return m;
  };

  // Piers. Inner face laps over the bore wall by PORTAL_OVERLAP so the
  // ribbon's razor edge is buried; outer face batters outward as it drops,
  // which is what makes masonry look like it is carrying a load.
  for (const sgn of [-1, 1]) {
    let y = -1.6; // start below grade so uneven terrain can't reveal a floating base
    while (y < springY) {
      const h = 0.42 + rng() * 0.26;
      const t = Math.min(1, (springY - y) / (springY + 1.6));       // 0 at base, 1 at top
      const wide = 2.5 - t * 0.9 + rng() * 0.12;                     // batter
      const xIn = sgn * (S - PORTAL_OVERLAP);
      block(xIn + sgn * wide / 2, y + h / 2, (rng() - 0.5) * 0.06, wide, h, D + rng() * 0.1);
      // a couple of proud rubble stones per course, outer face only
      if (rng() < 0.55) {
        const rs = 0.3 + rng() * 0.35;
        block(xIn + sgn * (wide - rs * 0.3), y + h * (0.3 + rng() * 0.4), (rng() - 0.5) * (D * 0.8),
              rs, rs * (0.7 + rng() * 0.5), rs * (0.8 + rng() * 0.7));
      }
      y += h;
    }
  }

  // Segmental arch over the opening: an arc through (±S, springY) with its
  // crown a little above the bore roof. Radius from the classic sagitta
  // relation, so the voussoirs sit on a real circle rather than a guess.
  const rise = (H + 0.35) - springY;
  const R = (S * S + rise * rise) / (2 * rise);   // intrados radius
  const cy = (H + 0.35) - R;                       // arc centre, well below the road
  const t = 0.8;                                   // voussoir depth (radial)
  const thetaMax = Math.asin(Math.min(1, S / R));
  const n = 15;
  for (let i = 0; i < n; i++) {
    const th = -thetaMax + (2 * thetaMax) * ((i + 0.5) / n);
    const isKey = Math.abs(th) < thetaMax / n;
    const rc = R + t / 2;
    const chord = (2 * thetaMax * R) / n * 1.12;   // slight overlap so no light leaks between stones
    const m = block(rc * Math.sin(th), cy + rc * Math.cos(th), 0,
                    chord, t * (isKey ? 1.45 : 1), D + 0.12,
                    isKey ? _portalTrimMat : undefined);
    m.rotation.z = -th;                            // local +Y points radially outward
  }

  // Spandrel: fill from the arch's extrados (or the pier tops beside it) up
  // to the parapet, column by column, so there is never a gap to see sky
  // through above the arch. Coursed in two courses for a masonry read.
  const Ro = R + t;
  const cols = 24;
  for (let i = 0; i < cols; i++) {
    const x0 = -W + (2 * W) * (i / cols), x1 = -W + (2 * W) * ((i + 1) / cols);
    const xm = (x0 + x1) / 2, wCol = (x1 - x0) * 1.06;
    const base = Math.abs(xm) < Ro ? Math.max(springY - 0.3, cy + Math.sqrt(Ro * Ro - xm * xm) - 0.12)
                                   : springY - 0.3;
    if (base >= parapetY) continue;
    const mid = base + (parapetY - base) * (0.45 + rng() * 0.12);
    block(xm, (base + mid) / 2, (rng() - 0.5) * 0.05, wCol, mid - base, D + rng() * 0.08);
    block(xm, (mid + parapetY) / 2, (rng() - 0.5) * 0.05, wCol, parapetY - mid, D + rng() * 0.08);
  }

  // Dressed coping, overhanging both faces — the line that reads as "built"
  // rather than "piled", and it caps the spandrel's ragged top.
  block(0, parapetY + 0.19, 0, W * 2 + 0.5, 0.38, D + 0.55, _portalTrimMat);
  // Buttress stones where the facade meets the rock cut, both sides of the
  // road AND both sides of the facade (kept symmetric in Z on purpose).
  for (const sgn of [-1, 1]) {
    for (const zs of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const s = 0.75 + rng() * 0.85;
        block(sgn * (W - 0.2 - rng() * 0.6), s * 0.45 + i * 0.9, zs * (D * 0.5 + 0.2 + rng() * 0.5),
              s * 1.3, s * (0.9 + rng() * 0.6), s * 1.2);
      }
    }
  }
  return g;
}

// ---- Japanese expressway: flat precast concrete frame, hood, signboard
let _pcMat = null, _pcDarkMat = null, _pcTrimMat = null, _signMat = null, _portalUnitBox2 = null;
function expresswayPortalAssets() {
  if (_pcMat) return;
  _pcMat = std(0xb6b9bd, { roughness: 0.82 });      // precast concrete
  _pcDarkMat = std(0x86898d, { roughness: 0.85 });  // recesses / louvres
  _pcTrimMat = std(0xd8dade, { roughness: 0.7 });   // painted band
  _portalUnitBox2 = new THREE.BoxGeometry(1, 1, 1);
  // Signboard: a dark plate with pale glyph blocks — deliberately abstract
  // shapes at PS1 resolution, not real characters, in the same flat-region
  // + grain idiom as every other texture here.
  const signTex = canvasTexture(64, 24, (ctx, w, h) => {
    ctx.fillStyle = "#1d3a2a"; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#e8eee9";
    ctx.fillRect(2, 2, w - 4, 1); ctx.fillRect(2, h - 3, w - 4, 1);
    for (let i = 0; i < 4; i++) {
      const x = 6 + i * 13;
      ctx.fillRect(x, 7, 9, 2);
      ctx.fillRect(x + (i % 2 ? 1 : 3), 10, 2, 6);
      ctx.fillRect(x + 5, 10, 2, 6);
      if (i % 2 === 0) ctx.fillRect(x, 16, 9, 2);
    }
  }, 0.05);
  _signMat = new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.6 });
  for (const shared of [_pcMat, _pcDarkMat, _pcTrimMat, _signMat, _portalUnitBox2]) shared.userData.shared = true;
}

export function buildTunnelPortalExpressway(rng) {
  expresswayPortalAssets();
  const g = new THREE.Group();
  const S = PORTAL_SPAN, H = PORTAL_RISE;
  const D = 1.1;                 // frame thickness along the road
  const W = S + 1.9;             // outer half-width
  const headY = H + 1.9;         // top of the head beam

  const slab = (x, y, z, sx, sy, sz, mat) => {
    const m = new THREE.Mesh(_portalUnitBox2, mat ?? _pcMat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    return m;
  };

  // Piers — flat slabs, no batter. Fluted with shallow ribs, which is what
  // sells "precast panel" instead of "grey box" at speed.
  for (const sgn of [-1, 1]) {
    const xIn = sgn * (S - PORTAL_OVERLAP);
    const wide = W - S + PORTAL_OVERLAP;
    slab(xIn + sgn * wide / 2, (H + 1.6) / 2 - 0.8, 0, wide, H + 1.6 + 1.6, D);
    for (let i = 0; i < 4; i++) {
      const fx = xIn + sgn * (0.35 + i * (wide - 0.7) / 3);
      slab(fx, H * 0.5, sgn * 0, 0.13, H * 1.02, D + 0.14, _pcDarkMat);
    }
    // kerb-height plinth, slightly proud
    slab(xIn + sgn * wide / 2, 0.3, 0, wide + 0.12, 0.6, D + 0.22, _pcDarkMat);
  }

  // Head beam over the opening, and a projecting hood both sides of it —
  // the deep shadow line under a hood is the single most recognisable thing
  // about an expressway portal.
  slab(0, (H - PORTAL_OVERLAP + headY) / 2, 0, W * 2, headY - H + PORTAL_OVERLAP, D);
  slab(0, headY + 0.28, 0, W * 2 + 0.7, 0.56, D + 1.9);              // hood slab, symmetric in Z
  slab(0, headY - 0.06, 0, W * 2 + 0.3, 0.16, D + 1.5, _pcTrimMat);  // painted band under the hood

  // Ventilation louvres flanking the signboard.
  for (const sgn of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      slab(sgn * (S * 0.62), H + 0.42 + i * 0.24, D / 2 + 0.03, S * 0.5, 0.13, 0.14, _pcDarkMat);
      slab(sgn * (S * 0.62), H + 0.42 + i * 0.24, -D / 2 - 0.03, S * 0.5, 0.13, 0.14, _pcDarkMat);
    }
  }

  // Signboard on both faces (symmetric prop), on a small standoff.
  for (const zs of [-1, 1]) {
    const sign = new THREE.Mesh(_portalUnitBox2, _signMat);
    sign.position.set(0, H + 0.95, zs * (D / 2 + 0.09));
    sign.scale.set(S * 1.05, 0.85, 0.12);
    sign.castShadow = sign.receiveShadow = true;
    g.add(sign);
  }

  // Clearance-bar chevrons at the opening's top corners: hazard marking
  // where a truck would actually clip the head beam.
  for (const sgn of [-1, 1]) {
    for (const zs of [-1, 1]) {
      slab(sgn * (S - 0.42), H - 0.5, zs * (D / 2 + 0.05), 0.7, 0.9, 0.1, _pcTrimMat);
    }
  }
  return g;
}

// =====================================================================
// Giza Desert Raceway — Old Town facade. A real 3D close-range building
// wall for the Corkscrew's narrow cobbled streets: unlike buildBuilding's
// plain flat-color box (fine at 15m+), this sits within a couple of metres
// of the car through a claustrophobic chicane, so it needs actual surface
// detail (punched windows, a door, a balcony ledge) or it reads as a grey
// slab, not a street. Same construction convention as the mountain props
// above: a couple of primitives in a Group, a small cached pool of
// procedural textures (not one-per-instance — dozens of these line the
// descent), std()-style grain via canvasTexture. Ground-origin (not
// center-origin like buildBuilding) so a band/point needs no yOffset
// gymnastics: y=0 is the base of the wall, matching barrier/apexKerb/
// tireBarrier's convention. Long axis (the visible facade) faces local +Z,
// same as buildBarrier — orient() only ever rotates around Y, so a facade
// band's `side` should be picked so +Z already faces the street; add
// rotY: Math.PI on the band if it comes out backwards.
// =====================================================================
// Origin sits AT the road-facing surface (not centered in the box, unlike
// the thin barrier/apexKerb props above) — the wall is thick (a few
// metres of real building depth), so centering it on the placement point
// like a thin guardrail would bury half the building INSIDE the road.
// thick is therefore just a nominal skin, not half the true depth.
const OLDTOWN_HALF_THICKNESS = 0.12; // origin -> road-facing surface (computeWallProfile)
const OLDTOWN_HALF_LENGTH = 2.9; // half-extent along the track (local Z)
const OLDTOWN_DEPTH = 4.2; // full building depth, extending away from the road (+local X)
const _oldTownFacadeTexCache = [];
// Most of Cairo is plain concrete block / bare brick, not carved sandstone —
// this pool is weighted that way on purpose (see the file-level note above
// buildOldTownFacade): 5 of 6 cached variants are utilitarian unfinished
// stock (poured concrete or bare red brick, flat parapet, rebar stubs on the
// roofline, a stained streak below a sill, laundry line, AC box) and only 1
// of 6 is the old warm-sandstone coursed-stone look — kept as the rare
// old-quarter building it should be, not the default. Real 3D massing (not
// just texture) is what actually reads as "domed/ornate" from a distance;
// that vocabulary now lives ONLY in the Cairo skyline backdrop's one rare
// mosque silhouette (see cairoSkyline registration) and isn't duplicated here.
function oldTownFacadeTexture(rng) {
  if (_oldTownFacadeTexCache.length < 6) {
    const isOrnate = _oldTownFacadeTexCache.length === 5; // last slot = the rare one
    const stories = 2 + ((rng() * 3) | 0);
    const tex = canvasTexture(64, 96, (ctx, w, h) => {
      const storyH = h / (stories + 1);
      if (isOrnate) {
        // the old warm-sandstone coursed-stone look, kept as the exception
        const hue = 0.08 + rng() * 0.05;
        const baseL = 0.5 + rng() * 0.18;
        const base = new THREE.Color().setHSL(hue, 0.32, baseL);
        ctx.fillStyle = `#${base.getHexString()}`;
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = "rgba(90,64,40,0.25)";
        for (let y = 0; y < h; y += 6) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
        for (let s = 0; s < stories; s++) {
          const y0 = h - (s + 1) * storyH;
          for (let x = 6; x < w - 6; x += 14) {
            if (Math.random() < 0.75) {
              ctx.fillStyle = "rgba(40,32,26,0.85)";
              ctx.fillRect(x, y0 + storyH * 0.25, 8, storyH * 0.5);
              ctx.fillStyle = "rgba(210,190,150,0.7)";
              ctx.fillRect(x - 1, y0 + storyH * 0.25 - 1, 10, 2);
            }
          }
        }
        ctx.fillStyle = "#5a3c22";
        ctx.fillRect(w * 0.42, h - storyH * 0.9, w * 0.16, storyH * 0.9);
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        ctx.fillRect(w * 0.42, h - storyH * 0.9, w * 0.16, 3);
      } else {
        // plain unfinished concrete / bare brick — the ordinary building
        // stock most of the street should be made of
        const brick = rng() < 0.4;
        const hue = brick ? 0.02 + rng() * 0.03 : 0.13 + rng() * 0.05; // bare red brick vs dusty grey/beige concrete
        const sat = brick ? 0.35 + rng() * 0.1 : 0.05 + rng() * 0.08;
        const baseL = brick ? 0.42 + rng() * 0.1 : 0.55 + rng() * 0.15;
        const base = new THREE.Color().setHSL(hue, sat, baseL);
        ctx.fillStyle = `#${base.getHexString()}`;
        ctx.fillRect(0, 0, w, h);
        // flat poured-slab lines between stories (no decorative coursing)
        ctx.strokeStyle = "rgba(0,0,0,0.15)";
        for (let s = 1; s <= stories; s++) {
          const y = h - s * storyH;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }
        // plain square punched windows, irregular open/shuttered/AC-box mix
        for (let s = 0; s < stories; s++) {
          const y0 = h - (s + 1) * storyH;
          for (let x = 5; x < w - 5; x += 12) {
            const roll = Math.random();
            if (roll < 0.62) {
              ctx.fillStyle = "rgba(30,30,32,0.8)";
              ctx.fillRect(x, y0 + storyH * 0.3, 7, storyH * 0.4);
              if (Math.random() < 0.3) { // AC box under the sill
                ctx.fillStyle = "rgba(200,200,195,0.8)";
                ctx.fillRect(x - 1, y0 + storyH * 0.72, 9, storyH * 0.16);
              }
            }
            // water-stain streak below the sill on a few windows
            if (roll < 0.3) {
              ctx.fillStyle = "rgba(20,15,10,0.12)";
              ctx.fillRect(x + 1, y0 + storyH * 0.7, 5, storyH * 1.3);
            }
          }
        }
        // rebar stubs + an unfinished top course along the roofline — the
        // "still building the next floor" look real Cairo streets have
        ctx.strokeStyle = "rgba(60,55,50,0.55)";
        for (let x = 4; x < w - 2; x += 7) {
          if (Math.random() < 0.55) {
            ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x + (Math.random() - 0.5) * 2, -3); ctx.stroke();
          }
        }
        // plain doorway, no shutter/frame styling
        ctx.fillStyle = "rgba(35,30,28,0.9)";
        ctx.fillRect(w * 0.4, h - storyH * 0.85, w * 0.18, storyH * 0.85);
      }
    });
    _oldTownFacadeTexCache.push(tex);
  }
  return _oldTownFacadeTexCache[(rng() * _oldTownFacadeTexCache.length) | 0];
}

export function buildOldTownFacade(rng) {
  const g = new THREE.Group();
  const width = 3.6 + rng() * 2.2;
  const depth = OLDTOWN_DEPTH;
  const height = 6 + rng() * 4.5;
  const mat = new THREE.MeshStandardMaterial({ map: oldTownFacadeTexture(rng), roughness: 0.9 });
  const wallGeo = new THREE.BoxGeometry(depth, height, width);
  wallGeo.translate(depth / 2, 0, 0); // shift so the near (road-facing) face sits at local x=0
  const wall = new THREE.Mesh(wallGeo, mat);
  wall.position.set(0, height / 2, 0);
  wall.castShadow = wall.receiveShadow = true;
  g.add(wall);
  // a shallow balcony ledge partway up, overhanging the street from the
  // front face — the detail that reads as "pressing in on the street" from
  // the driver's seat, not just a wall. Kept modest (bare concrete/rust,
  // not a carved ornament) and not on every building — most Cairo balconies
  // are a plain slab with washing hung off it, not decoration.
  if (rng() < 0.4) {
    const ledgeY = height * (0.45 + rng() * 0.2);
    const overhang = 0.9;
    const ledgeMat = std(0x736b5e, { roughness: 0.95 });
    const ledge = new THREE.Mesh(new THREE.BoxGeometry(overhang, 0.12, width * 0.85), ledgeMat);
    ledge.position.set(-overhang / 2, ledgeY, 0);
    ledge.castShadow = ledge.receiveShadow = true;
    g.add(ledge);
    // a couple of support posts under the ledge
    for (const zs of [-0.3, 0.3]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, ledgeY * 0.3, 5), ledgeMat);
      post.position.set(-overhang * 0.6, ledgeY - ledgeY * 0.15, width * zs);
      g.add(post);
    }
  }
  return g;
}
export { OLDTOWN_HALF_THICKNESS, OLDTOWN_HALF_LENGTH };

// =====================================================================
// Monaco Street Circuit — dense Belle Époque/Riviera apartment facade,
// real 3D (not a cutout) for the same reason buildOldTownFacade is: it
// lines the tight climbing streets within a couple of metres of the car.
// Collidable like Old Town — the narrow street IS the wall here too.
// Ordinary-stock rule applies the same way it did for Cairo: most of
// Monaco's building stock is nice-but-plain cream/pastel stucco apartment
// blocks with shutters and a plain iron rail, NOT the Casino itself — the
// one genuinely grand building is placed once, by hand, as its own hero
// prop (buildCasino below), not diluted into this pool.
// =====================================================================
export const RIVIERA_HALF_THICKNESS = 0.12; // origin -> road-facing surface (computeWallProfile)
export const RIVIERA_HALF_LENGTH = 3.0; // half-extent along the track (local Z)
const RIVIERA_DEPTH = 5.2; // full building depth, extending away from the road (+local X)
const _rivieraFacadeTexCache = [];
function rivieraFacadeTexture(rng) {
  if (_rivieraFacadeTexCache.length < 6) {
    const isGrand = _rivieraFacadeTexCache.length === 5; // last slot = the rare "grand hotel" exception
    const stories = 3 + ((rng() * 3) | 0);
    const tex = canvasTexture(64, 96, (ctx, w, h) => {
      const storyH = h / (stories + 1);
      // pastel Riviera stucco: cream, pale ochre, pale pink, pale blue-grey
      const hues = [0.11, 0.09, 0.98, 0.58];
      const hue = isGrand ? 0.12 : hues[(rng() * hues.length) | 0];
      const sat = isGrand ? 0.22 : 0.14 + rng() * 0.1;
      const baseL = isGrand ? 0.86 : 0.78 + rng() * 0.12;
      const base = new THREE.Color().setHSL(hue < 0 ? hue + 1 : hue, sat, baseL);
      ctx.fillStyle = `#${base.getHexString()}`;
      ctx.fillRect(0, 0, w, h);
      // stucco banding between stories
      ctx.strokeStyle = "rgba(120,100,80,0.18)";
      for (let s = 1; s <= stories; s++) {
        const y = h - s * storyH;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
      // shuttered windows, each with a thin wrought-iron balcony rail
      for (let s = 0; s < stories; s++) {
        const y0 = h - (s + 1) * storyH;
        for (let x = 5; x < w - 5; x += 11) {
          if (Math.random() < 0.8) {
            const shutterGreen = Math.random() < 0.5;
            ctx.fillStyle = shutterGreen ? "rgba(64,90,68,0.85)" : "rgba(150,60,55,0.8)";
            ctx.fillRect(x, y0 + storyH * 0.2, 7, storyH * 0.55);
            ctx.fillStyle = "rgba(255,255,240,0.55)";
            ctx.fillRect(x + 1, y0 + storyH * 0.25, 5, storyH * 0.45); // glass sliver between shutters
            if (Math.random() < 0.7) {
              ctx.strokeStyle = "rgba(40,40,42,0.6)";
              ctx.beginPath();
              ctx.moveTo(x - 1, y0 + storyH * 0.78);
              ctx.lineTo(x + 8, y0 + storyH * 0.78);
              ctx.stroke();
              for (let bx = x - 1; bx <= x + 8; bx += 3) {
                ctx.beginPath(); ctx.moveTo(bx, y0 + storyH * 0.78); ctx.lineTo(bx, y0 + storyH * 0.7); ctx.stroke();
              }
            }
          }
        }
      }
      if (isGrand) {
        // gold cornice trim between every story on the grand hotel variant
        ctx.strokeStyle = "rgba(190,155,70,0.5)";
        for (let s = 1; s <= stories; s++) {
          const y = h - s * storyH;
          ctx.beginPath(); ctx.moveTo(0, y + 2); ctx.lineTo(w, y + 2); ctx.stroke();
        }
      }
      // ground-floor awning stripe on a few (café/boutique frontage)
      if (Math.random() < 0.4) {
        ctx.fillStyle = Math.random() < 0.5 ? "rgba(170,55,50,0.85)" : "rgba(60,90,140,0.85)";
        ctx.fillRect(w * 0.1, h - storyH * 0.5, w * 0.8, storyH * 0.25);
      }
      // plain entrance
      ctx.fillStyle = "rgba(45,38,32,0.9)";
      ctx.fillRect(w * 0.42, h - storyH * 0.85, w * 0.18, storyH * 0.85);
    });
    _rivieraFacadeTexCache.push(tex);
  }
  return _rivieraFacadeTexCache[(rng() * _rivieraFacadeTexCache.length) | 0];
}

export function buildRivieraFacade(rng) {
  const g = new THREE.Group();
  const width = 4.0 + rng() * 2.6;
  const depth = RIVIERA_DEPTH;
  const height = 9 + rng() * 8;
  const mat = new THREE.MeshStandardMaterial({ map: rivieraFacadeTexture(rng), roughness: 0.85 });
  const wallGeo = new THREE.BoxGeometry(depth, height, width);
  wallGeo.translate(depth / 2, 0, 0); // shift so the near (road-facing) face sits at local x=0
  const wall = new THREE.Mesh(wallGeo, mat);
  wall.position.set(0, height / 2, 0);
  wall.castShadow = wall.receiveShadow = true;
  g.add(wall);
  // shallow cantilevered balcony slab (thin iron-rail suggestion baked into
  // the texture above) — the detail that presses the street in, same
  // reasoning buildOldTownFacade uses for its own ledge
  if (rng() < 0.6) {
    const ledgeY = height * (0.35 + rng() * 0.35);
    const overhang = 0.5;
    const balconyW = width * 0.7;
    const ledgeMat = std(0x9a9488, { roughness: 0.7 }); // darker than the pale wall so it actually reads against it
    const ledge = new THREE.Mesh(new THREE.BoxGeometry(overhang, 0.08, balconyW), ledgeMat);
    ledge.position.set(-overhang / 2, ledgeY, 0);
    ledge.castShadow = ledge.receiveShadow = true;
    g.add(ledge);
    // two thin support brackets tying the ledge back to the wall — without
    // these the ledge/rail reads as a plank floating off the facade
    const bracketMat = std(0x3a352c, { roughness: 0.8 });
    for (const bz of [-balconyW * 0.32, balconyW * 0.32]) {
      const bracket = new THREE.Mesh(new THREE.BoxGeometry(overhang, 0.04, 0.04), bracketMat);
      bracket.position.set(-overhang / 2, ledgeY - 0.05, bz);
      g.add(bracket);
    }
    // a real (thin) wrought-iron rail, not a solid slab
    const railMat = std(0x2c2f33, { metalness: 0.4, roughness: 0.5 });
    const railH = 0.75;
    const topRail = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.025, balconyW), railMat);
    topRail.position.set(-overhang, ledgeY + railH, 0);
    g.add(topRail);
    const barCount = 6;
    for (let bi = 0; bi < barCount; bi++) {
      const bz = (bi / (barCount - 1) - 0.5) * balconyW * 0.94;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.02, railH, 0.02), railMat);
      bar.position.set(-overhang, ledgeY + railH / 2, bz);
      g.add(bar);
    }
  }
  // striped ground-floor awning over the entrance on some instances
  if (rng() < 0.3) {
    const awnMat = std(rng() < 0.5 ? 0xa8352c : 0x3a5a8a, { roughness: 0.85 });
    const awning = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, width * 0.5), awnMat);
    awning.position.set(-0.45, 2.6, 0);
    awning.rotation.z = -0.15;
    awning.castShadow = true;
    g.add(awning);
  }
  return g;
}

// =====================================================================
// Monaco Street Circuit — the Casino de Monte-Carlo. The ONE genuinely
// grand building, placed exactly once as a `point` near the start/finish
// (not banded — see the singular-landmark rule), promoted to real 3D
// because it anchors the whole upper section and sits close enough to be
// looked at, not just glimpsed. Twin corner cupolas + a colonnaded front +
// a wide marble forecourt read as "the Casino" in silhouette even at
// this low a poly count, same "silhouette over detail" approach buildSphinx
// takes. NOT collidable — a backdrop monument set back off the racing line.
// =====================================================================
let _casinoMats = null;
function casinoAssets() {
  if (_casinoMats) return;
  const stone = std(0xe9dfc4, { roughness: 0.85 });
  const stoneShade = std(0xd6c9a4, { roughness: 0.88 });
  const dome = std(0x4f7a72, { roughness: 0.6, metalness: 0.15 }); // verdigris copper patina
  const gold = std(0xc7a04a, { roughness: 0.4, metalness: 0.5 });
  const glass = std(0x9fc4d4, { roughness: 0.3, metalness: 0.1 });
  const marble = std(0xf2ede0, { roughness: 0.6 });
  for (const m of [stone, stoneShade, dome, gold, glass, marble]) m.userData.shared = true;
  _casinoMats = { stone, stoneShade, dome, gold, glass, marble };
}

function casinoTower(g, x, z, scale, mats) {
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.9 * scale, 2.1 * scale, 7.5 * scale, 12), mats.stone);
  base.position.set(x, 3.75 * scale, z);
  base.castShadow = base.receiveShadow = true;
  g.add(base);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(2.15 * scale, 4.2 * scale, 12), mats.dome);
  cap.position.set(x, 7.5 * scale + 2.1 * scale, z);
  cap.castShadow = true;
  g.add(cap);
  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.22 * scale, 8, 6), mats.gold);
  finial.position.set(x, 7.5 * scale + 4.2 * scale + 0.2 * scale, z);
  g.add(finial);
}

export function buildCasino(rng) {
  casinoAssets();
  const mats = _casinoMats;
  const g = new THREE.Group();
  const scale = 0.94 + rng() * 0.12;

  // marble forecourt/plaza platform
  const plaza = new THREE.Mesh(new THREE.BoxGeometry(26 * scale, 0.5, 16 * scale), mats.marble);
  plaza.position.set(2 * scale, 0.25, 0);
  plaza.receiveShadow = plaza.castShadow = true;
  g.add(plaza);

  // main central block
  const main = new THREE.Mesh(new THREE.BoxGeometry(10 * scale, 9 * scale, 15 * scale), mats.stone);
  main.position.set(0, 4.5 * scale + 0.5, 0);
  main.castShadow = main.receiveShadow = true;
  g.add(main);

  // colonnaded portico facing the road (-X)
  const colCount = 7;
  for (let i = 0; i < colCount; i++) {
    const cz = (i / (colCount - 1) - 0.5) * 12.5 * scale;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.32 * scale, 0.36 * scale, 6.4 * scale, 8), mats.marble);
    col.position.set(-5.6 * scale, 3.2 * scale + 0.5, cz);
    col.castShadow = true;
    g.add(col);
  }
  const pediment = new THREE.Mesh(new THREE.BoxGeometry(1.4 * scale, 1.0 * scale, 14 * scale), mats.stoneShade);
  pediment.position.set(-5.6 * scale, 6.9 * scale + 0.5, 0);
  pediment.castShadow = true;
  g.add(pediment);
  // glazed entrance behind the colonnade
  const glassWall = new THREE.Mesh(new THREE.BoxGeometry(0.3 * scale, 5.4 * scale, 13 * scale), mats.glass);
  glassWall.position.set(-4.9 * scale, 3.0 * scale + 0.5, 0);
  g.add(glassWall);

  // central dome over the rotunda
  const domeBase = new THREE.Mesh(new THREE.CylinderGeometry(3.4 * scale, 3.6 * scale, 2.6 * scale, 16), mats.stone);
  domeBase.position.set(0, 9 * scale + 0.5 + 1.3 * scale, 0);
  domeBase.castShadow = true;
  g.add(domeBase);
  const domeCap = new THREE.Mesh(new THREE.SphereGeometry(3.5 * scale, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), mats.dome);
  domeCap.position.set(0, 9 * scale + 0.5 + 2.6 * scale, 0);
  domeCap.castShadow = true;
  g.add(domeCap);
  const domeFinial = new THREE.Mesh(new THREE.SphereGeometry(0.3 * scale, 8, 6), mats.gold);
  domeFinial.position.set(0, 9 * scale + 0.5 + 2.6 * scale + 2.6 * scale, 0);
  g.add(domeFinial);

  // twin corner cupola towers — the silhouette that actually reads as
  // "the Casino" from a distance
  casinoTower(g, 3 * scale, -8.6 * scale, scale, mats);
  casinoTower(g, 3 * scale, 8.6 * scale, scale, mats);

  return g;
}

// =====================================================================
// Monaco Street Circuit — berthed yachts (motor superyacht / sailboat).
// Real 3D, not cutouts: "yachts almost level with the racing surface" per
// the brief means the chase camera sees these edge-on at close range along
// the harbourfront. Banded repeatedly (a marina genuinely has many boats,
// unlike the Casino) — see the singular-landmark-vs-plural-infrastructure
// rule. NOT collidable — set back over the water beyond the harbour wall.
// =====================================================================
let _yachtMats = null;
function yachtAssets() {
  if (_yachtMats) return;
  const hullWhite = std(0xf1f0e8, { roughness: 0.45, metalness: 0.05 });
  const hullDark = std(0x263038, { roughness: 0.5 });
  const deckTeak = std(0x8a6a44, { roughness: 0.8 });
  const cabinGlass = std(0x3c5866, { roughness: 0.25, metalness: 0.2 });
  const mast = std(0xd6d6d2, { roughness: 0.4, metalness: 0.3 });
  const sailCloth = std(0xece8dc, { roughness: 0.9 });
  for (const m of [hullWhite, hullDark, deckTeak, cabinGlass, mast, sailCloth]) m.userData.shared = true;
  _yachtMats = { hullWhite, hullDark, deckTeak, cabinGlass, mast, sailCloth };
}

// Motor superyacht: long boxy hull, dark waterline stripe, stacked deck
// levels tapering toward the bow, small flybridge/radar mast.
function buildMotorYacht(rng, mats) {
  const g = new THREE.Group();
  const len = 9 + rng() * 10;
  const beam = 2.2 + rng() * 1.1;
  const hull = new THREE.Mesh(new THREE.BoxGeometry(beam, 1.5, len), mats.hullWhite);
  hull.position.set(0, 0.75, 0);
  hull.castShadow = hull.receiveShadow = true;
  g.add(hull);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(beam + 0.04, 0.28, len - 0.4), mats.hullDark);
  stripe.position.set(0, 0.32, 0);
  g.add(stripe);
  const deck1 = new THREE.Mesh(new THREE.BoxGeometry(beam * 0.82, 1.2, len * 0.58), mats.hullWhite);
  deck1.position.set(0, 1.5 + 0.6, -len * 0.05);
  deck1.castShadow = true;
  g.add(deck1);
  const deck2 = new THREE.Mesh(new THREE.BoxGeometry(beam * 0.6, 0.95, len * 0.3), mats.cabinGlass);
  deck2.position.set(0, 1.5 + 1.2 + 0.48, -len * 0.1);
  deck2.castShadow = true;
  g.add(deck2);
  const mastPole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 2.2, 5), mats.mast);
  mastPole.position.set(0, 1.5 + 1.2 + 0.95 + 1.1, len * 0.02);
  g.add(mastPole);
  return g;
}

// Sailboat: slim hull, single mast, boom + furled mainsail — the smaller
// craft filling the pontoons between the superyachts.
function buildSailboat(rng, mats) {
  const g = new THREE.Group();
  const len = 4.5 + rng() * 3.5;
  const beam = 1.1 + rng() * 0.4;
  const hull = new THREE.Mesh(new THREE.BoxGeometry(beam, 0.7, len), mats.hullWhite);
  hull.scale.set(1, 1, 1);
  hull.position.set(0, 0.35, 0);
  hull.castShadow = hull.receiveShadow = true;
  g.add(hull);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(beam * 0.75, 0.1, len * 0.85), mats.deckTeak);
  deck.position.set(0, 0.75, 0);
  g.add(deck);
  const mastH = 5 + rng() * 2.5;
  const mastPole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, mastH, 6), mats.mast);
  mastPole.position.set(0, 0.75 + mastH / 2, -len * 0.05);
  g.add(mastPole);
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, len * 0.35, 5), mats.mast);
  boom.rotation.x = Math.PI / 2;
  boom.position.set(0, 1.5, -len * 0.05 + len * 0.17);
  g.add(boom);
  const furled = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, mastH * 0.85, 5), mats.sailCloth);
  furled.position.set(0.09, 0.75 + mastH * 0.42, -len * 0.05);
  g.add(furled);
  return g;
}

export function buildYacht(rng) {
  yachtAssets();
  return rng() < 0.4 ? buildMotorYacht(rng, _yachtMats) : buildSailboat(rng, _yachtMats);
}

// =====================================================================
// Ocean — a plain flat square placed as a `point` (see trackObjects.js's
// OBJECT_TYPES), not derived from the track spline at all: drag it with the
// same translate/scale gizmo any other point uses (Object tab -> Select),
// no special-cased footprint math to fight. Lies flat via a geometry-baked
// rotation (orient() owns obj.rotation for points, so rotating the object
// itself here would just get overwritten) — scaleX resizes world-X width,
// scaleY resizes world-Z depth (same PlaneGeometry + bake-flat convention
// buildGroundGeometry's ground plane uses).
// Colors are deliberately saturated and `toneMapped = false`: a muted
// "realistic" blue read as near-black once the scene's ACES tone curve and
// exposure got hold of it — this bypasses that entirely and always renders
// exactly the specified color.
//
// Where the terrain actually pokes above the water is what decides where
// foam breaks (trackObjects.js's bakeShoreTexture fills uShoreTex/uShoreMin/
// uShoreSize right after placement — a tiny 1x1 placeholder here just keeps
// the shader valid before that runs). A flat "sin(x)*sin(z)" sparkle pattern
// LOOKS like a grid of dots sliding across the plane — it's the product of
// two independent traveling waves, i.e. literally a moving 2D lattice — so
// this reads shore proximity instead of trying to fake foam from noise.
// =====================================================================
const OCEAN_VERTEX_SHADER = `
  uniform float uTime;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  vec2 waveDir1 = vec2(0.6, 0.8);
  vec2 waveDir2 = vec2(-0.7, 0.4);
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    float k1 = 0.16, k2 = 0.24, s1 = 0.8, s2 = 1.1, a1 = 0.1, a2 = 0.06;
    float ph1 = dot(world.xz, waveDir1) * k1 + uTime * s1;
    float ph2 = dot(world.xz, waveDir2) * k2 + uTime * s2;
    world.y += sin(ph1) * a1 + sin(ph2) * a2;
    vec2 slope = cos(ph1) * a1 * k1 * waveDir1 + cos(ph2) * a2 * k2 * waveDir2;
    vNormal = normalize(vec3(-slope.x, 1.0, -slope.y));
    vWorldPos = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const OCEAN_FRAGMENT_SHADER = `
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uFoam;
  uniform float uTime;
  uniform sampler2D uShoreTex;
  uniform vec2 uShoreMin;
  uniform vec2 uShoreSize;
  uniform float uRangeMin;
  uniform float uRangeMax;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  void main() {
    // Baked ground height at this world XZ (same rule buildGroundGeometry's
    // vertices use — see makeGroundSampler) vs. this fragment's own
    // (wave-animated) water surface height. Ground above the water: no
    // water here at all, let the real ground mesh underneath show through.
    // Ground just below: the breaking-wave band. A slow wobble keeps the
    // line from sitting dead still.
    vec2 uv = (vWorldPos.xz - uShoreMin) / uShoreSize;
    float groundY = texture2D(uShoreTex, uv).r * (uRangeMax - uRangeMin) + uRangeMin;
    float wobble = sin(vWorldPos.x * 0.25 + vWorldPos.z * 0.2 + uTime * 1.6) * 0.12;
    float depth = (vWorldPos.y - groundY) + wobble;
    if (depth < -0.4) discard;
    float foam = 1.0 - smoothstep(-0.4, 1.3, depth);

    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fresnel = pow(1.0 - clamp(dot(viewDir, vNormal), 0.0, 1.0), 2.5);
    vec3 base = mix(uDeep, uShallow, fresnel * 0.5 + 0.15);
    // Soft sun glint off the wave normal — a broad moving highlight (the
    // wave normal itself is low-frequency, so this stays smooth, not speckled).
    vec3 lightDir = normalize(vec3(0.4, 0.75, 0.3));
    float spec = pow(max(dot(reflect(-lightDir, vNormal), viewDir), 0.0), 40.0);
    vec3 color = mix(base, uFoam, clamp(foam, 0.0, 1.0)) + spec * 0.35;
    gl_FragColor = vec4(color, 1.0);
  }
`;

// 1x1 "open water everywhere" placeholder — decodes to uRangeMin, i.e. no
// foam/discard — used only in the instant before bakeShoreTexture replaces it.
function placeholderShoreTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  return tex;
}

export function buildOcean() {
  const size = 60, segs = 24;
  const geo = new THREE.PlaneGeometry(size, size, segs, segs);
  geo.rotateX(-Math.PI / 2); // baked into the geometry — points' orient() owns obj.rotation
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color(0x155c78) },
      uShallow: { value: new THREE.Color(0x49b8d1) },
      uFoam: { value: new THREE.Color(0xf2fbfa) },
      uShoreTex: { value: placeholderShoreTexture() },
      uShoreMin: { value: new THREE.Vector2(0, 0) },
      uShoreSize: { value: new THREE.Vector2(1, 1) },
      uRangeMin: { value: -5 },
      uRangeMax: { value: 25 },
    },
    vertexShader: OCEAN_VERTEX_SHADER,
    fragmentShader: OCEAN_FRAGMENT_SHADER,
    side: THREE.DoubleSide,
  });
  mat.toneMapped = false;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.animatedWater = true;
  return mesh;
}

// =====================================================================
// Monaco Street Circuit — harbour crane. Sparse hero points along the
// marina (cranes servicing the yachts/dry-dock the brief calls for), real
// 3D because it's a tall close-range silhouette. NOT collidable.
// =====================================================================
let _craneMats = null;
function craneAssets() {
  if (_craneMats) return;
  const yellow = std(0xd8a821, { roughness: 0.7, metalness: 0.2 });
  const dark = std(0x2c2d2f, { roughness: 0.6, metalness: 0.3 });
  for (const m of [yellow, dark]) m.userData.shared = true;
  _craneMats = { yellow, dark };
}

export function buildHarbourCrane(rng) {
  craneAssets();
  const { yellow, dark } = _craneMats;
  const g = new THREE.Group();
  const h = 9 + rng() * 4;
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 1.4), dark);
  base.position.set(0, 0.3, 0);
  base.castShadow = base.receiveShadow = true;
  g.add(base);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, h, 6), yellow);
  mast.position.set(0, h / 2 + 0.6, 0);
  mast.castShadow = true;
  g.add(mast);
  // boom: base anchored at the mast top (geometry translated so its own
  // origin sits at the near end, same convention as placeholders.js's limb()
  // helper) then rotated to lean out — anchoring by the CENTER (as before)
  // let the far half poke back through the mast while the near half fell
  // short of it, reading as a boom disconnected from its own tower.
  const boomLen = 6 + rng() * 3;
  const boomGeo = new THREE.CylinderGeometry(0.14, 0.16, boomLen, 5);
  boomGeo.translate(0, boomLen / 2, 0);
  const boom = new THREE.Mesh(boomGeo, yellow);
  boom.rotation.z = -(Math.PI / 2 - 0.35); // lean out over the water (+X)
  boom.position.set(0, h + 0.6, 0);
  boom.castShadow = true;
  g.add(boom);
  const counter = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), dark);
  counter.position.set(-1.1, h + 0.6, 0);
  counter.castShadow = true;
  g.add(counter);
  // a short strut bracing the counterweight back to the mast, so it doesn't
  // read as a second unconnected floating box
  const strut = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.12), dark);
  strut.position.set(-0.55, h + 0.35, 0);
  strut.rotation.z = 0.25;
  g.add(strut);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), dark);
  cab.position.set(0, h - 0.3, 0);
  cab.castShadow = true;
  g.add(cab);
  return g;
}

// =====================================================================
// Giza Desert Raceway — the Great Sphinx. A one-off hero landmark (placed
// as a single `point`, not a band), promoted from a flat cutout to real 3D
// on the same reasoning as buildMonkeyTree/tunnel portals: it sits close to
// the road at "Sphinx Sweep" so the player actually looks at it through the
// corner, not just glimpses a silhouette in passing — a billboard read as a
// paper cutout at that range. Lying-lion pose: long body + tapered
// forelegs reaching toward the road (-X, same "reach toward the track"
// convention buildMonkeyTree uses for its leaning trunk), head + nemes
// headdress at the far/raised end. NOT collidable (COLLIDABLE_BARRIER_TYPES)
// — it's a backdrop monument set back beyond the runoff, not something the
// car should be able to clip.
let _sphinxMats = null;
function sphinxAssets() {
  if (_sphinxMats) return;
  const stone = std(0xcbb08a, { roughness: 0.95 });
  const shade = std(0xa88c68, { roughness: 0.95 }); // weathered/undercut faces
  const dark = std(0x8a7154, { roughness: 1 }); // deep erosion / shadowed recesses
  for (const m of [stone, shade, dark]) m.userData.shared = true;
  _sphinxMats = { stone, shade, dark };
}

export function buildSphinx(rng) {
  sphinxAssets();
  const { stone, shade, dark } = _sphinxMats;
  const g = new THREE.Group();
  const scale = 0.92 + rng() * 0.16; // mild per-instance size variance even though this is a one-off

  // stepped stone platform it "sits" on, eroded sand drifted against one side
  const platform = new THREE.Mesh(new THREE.BoxGeometry(15.5 * scale, 0.7, 7.6 * scale), dark);
  platform.position.set(0, 0.35, 0);
  platform.receiveShadow = platform.castShadow = true;
  g.add(platform);

  // haunches (rear, tall) tapering down to the shoulders
  const haunch = new THREE.Mesh(new THREE.BoxGeometry(3.6 * scale, 4.6 * scale, 6.2 * scale), stone);
  haunch.position.set(4.6 * scale, 0.7 + 2.3 * scale, 0);
  haunch.castShadow = haunch.receiveShadow = true;
  g.add(haunch);

  const shoulders = new THREE.Mesh(new THREE.BoxGeometry(3.2 * scale, 3.4 * scale, 5.6 * scale), shade);
  shoulders.position.set(1.6 * scale, 0.7 + 1.9 * scale, 0);
  shoulders.castShadow = shoulders.receiveShadow = true;
  g.add(shoulders);

  // long low torso running forward, narrowing toward the paws
  const torso = new THREE.Mesh(new THREE.BoxGeometry(5.2 * scale, 2.1 * scale, 4.4 * scale), stone);
  torso.position.set(-2.0 * scale, 0.7 + 1.15 * scale, 0);
  torso.castShadow = torso.receiveShadow = true;
  g.add(torso);

  // two extended forepaws reaching toward the road
  for (const zs of [-1, 1]) {
    const paw = new THREE.Mesh(new THREE.BoxGeometry(3.4 * scale, 1.15 * scale, 1.35 * scale), shade);
    paw.position.set(-6.1 * scale, 0.7 + 0.65 * scale, zs * 1.3 * scale);
    paw.castShadow = paw.receiveShadow = true;
    g.add(paw);
    // a rougher, eroded step at each paw's tip
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.7 * scale, 0.9 * scale, 1.5 * scale), dark);
    tip.position.set(-7.9 * scale, 0.7 + 0.5 * scale, zs * 1.3 * scale);
    tip.castShadow = tip.receiveShadow = true;
    g.add(tip);
  }

  // head block, raised above the shoulders at the rear
  const head = new THREE.Mesh(new THREE.BoxGeometry(2.0 * scale, 2.3 * scale, 2.5 * scale), shade);
  head.position.set(5.4 * scale, 0.7 + 3.9 * scale + 1.15 * scale, 0);
  head.castShadow = head.receiveShadow = true;
  g.add(head);
  // simplified brow/face slab, slightly forward and undercut
  const face = new THREE.Mesh(new THREE.BoxGeometry(0.5 * scale, 1.6 * scale, 2.1 * scale), dark);
  face.position.set(6.35 * scale, 0.7 + 3.9 * scale + 1.0 * scale, 0);
  face.castShadow = face.receiveShadow = true;
  g.add(face);

  // nemes headdress: a wider flat-topped block over the head + two lappets
  // (flat slabs) hanging down either side of the neck — the silhouette that
  // actually reads as "sphinx" from a distance
  const crown = new THREE.Mesh(new THREE.BoxGeometry(2.3 * scale, 1.0 * scale, 3.0 * scale), stone);
  crown.position.set(5.2 * scale, 0.7 + 3.9 * scale + 2.55 * scale, 0);
  crown.castShadow = crown.receiveShadow = true;
  g.add(crown);
  for (const zs of [-1, 1]) {
    const lappet = new THREE.Mesh(new THREE.BoxGeometry(1.5 * scale, 2.0 * scale, 0.55 * scale), stone);
    lappet.position.set(5.7 * scale, 0.7 + 3.9 * scale + 0.4 * scale, zs * 1.55 * scale);
    lappet.rotation.z = zs * 0.06;
    lappet.castShadow = lappet.receiveShadow = true;
    g.add(lappet);
  }

  // wind-drifted sand dune banked against the flank, motivating why the
  // platform's far side is half-buried — real erosion detail, not filler
  const drift = new THREE.Mesh(new THREE.ConeGeometry(3.2 * scale, 1.6 * scale, 8, 1, true), dark);
  drift.scale.set(1, 0.5, 1.6);
  drift.position.set(3.4 * scale, 0.55, -4.6 * scale);
  drift.rotation.x = Math.PI;
  drift.castShadow = false; drift.receiveShadow = true;
  g.add(drift);

  return g;
}

// =====================================================================
// Giza Desert Raceway — Old Town market stall. Promoted from a flat cutout
// to real 3D on the same "too close to be 2D" reasoning as the Sphinx: it
// sits right at the Corkscrew's barrier line, close enough for the chase
// camera to see it edge-on. Small and cheap (a handful of boxes/cylinders),
// shares one striped-awning material pool across instances the way
// buildTireBarrier shares its tire materials. NOT collidable — it sits
// recessed against the building line, not out in the car's path.
let _stallAssets = null;
function marketStallAssets() {
  if (_stallAssets) return;
  const postMat = std(0x5a4128, { roughness: 0.95 });
  const counterMat = std(0x7a5a36, { roughness: 0.9 });
  const awningRed = std(0xa8352c, { roughness: 0.85 });
  const awningWhite = std(0xd8cdb8, { roughness: 0.85 });
  const awningGold = std(0xc99a3a, { roughness: 0.85 });
  const goodsMats = [0xc97a2e, 0x7a9a4a, 0xd4b23a, 0x9a3a2e, 0xc2c47a].map((c) => std(c, { roughness: 0.8 }));
  for (const m of [postMat, counterMat, awningRed, awningWhite, awningGold, ...goodsMats]) m.userData.shared = true;
  _stallAssets = { postMat, counterMat, awnings: [awningRed, awningWhite, awningGold], goodsMats };
}

export function buildMarketStall(rng) {
  marketStallAssets();
  const { postMat, counterMat, awnings, goodsMats } = _stallAssets;
  const g = new THREE.Group();
  const w = 2.6 + rng() * 0.8, depth = 1.1 + rng() * 0.3;

  // two front support posts holding the awning out over the counter
  for (const zs of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 2.25, 5), postMat);
    post.position.set(depth * 0.42, 1.125, zs * (w / 2 - 0.1));
    post.castShadow = true;
    g.add(post);
  }
  // counter/table
  const counter = new THREE.Mesh(new THREE.BoxGeometry(depth * 0.85, 0.85, w), counterMat);
  counter.position.set(0, 0.425, 0);
  counter.castShadow = counter.receiveShadow = true;
  g.add(counter);
  // striped canvas awning, tilted, overhanging the street
  const stripes = 5 + ((rng() * 3) | 0);
  const awningGroup = new THREE.Group();
  const stripeMat = awnings[(rng() * awnings.length) | 0];
  const altMat = awnings[(rng() * awnings.length) | 0];
  for (let i = 0; i < stripes; i++) {
    const seg = new THREE.Mesh(
      new THREE.BoxGeometry(depth * 1.35, 0.06, w / stripes),
      i % 2 ? stripeMat : altMat
    );
    seg.position.set(0, 0, -w / 2 + (i + 0.5) * (w / stripes));
    seg.castShadow = true;
    awningGroup.add(seg);
  }
  awningGroup.position.set(depth * 0.55, 2.3, 0);
  awningGroup.rotation.z = -0.16; // pitched down toward the street
  g.add(awningGroup);
  // goods heaped on the counter — small produce-stall clutter, cheap
  // spheres/boxes so a whole street of these stays low-poly
  const goodsCount = 5 + ((rng() * 5) | 0);
  for (let i = 0; i < goodsCount; i++) {
    const mat = goodsMats[(rng() * goodsMats.length) | 0];
    const r = 0.08 + rng() * 0.07;
    const item = new THREE.Mesh(new THREE.SphereGeometry(r, 6, 5), mat);
    item.position.set(
      depth * (0.15 + rng() * 0.3),
      0.85 + r * 0.8,
      -w / 2 + 0.15 + rng() * (w - 0.3)
    );
    item.castShadow = true;
    g.add(item);
  }
  return g;
}

// Block-massing placeholder for a real 3D building. Unlike barrier/apexKerb/
// tireBarrier (fixed shared material, placed by the hundreds), buildings are
// sparse and prominent enough that per-instance size/color variety (like
// buildTree/buildRock) matters more than sharing one material.
export function buildBuilding(rng) {
  const real = cachedClone("building");
  if (real) {
    // Every facade shares the same texture, so a random quarter turn per
    // instance shows a different face and keeps a row of clones from
    // reading as copy-paste. Applied to the model INSIDE a wrapper group:
    // orient() owns the returned object's own rotation and would stomp it.
    real.rotation.y = ((rng() * 4) | 0) * (Math.PI / 2);
    const g = new THREE.Group();
    g.add(real);
    return g;
  }
  const w = 6 + rng() * 10, d = 6 + rng() * 10, h = 8 + rng() * 22;
  const color = new THREE.Color().setHSL(rng(), 0.06 + rng() * 0.08, 0.55 + rng() * 0.2); // muted concrete/stucco tones
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(color, { roughness: 0.85 }));
  box.position.y = h / 2;
  box.castShadow = box.receiveShadow = true;
  const g = new THREE.Group();
  g.add(box);
  return g;
}

// Cutout sprites — a flat camera-facing quad standing in for any 3D subject.
// Rotated every frame around Y only (unlike THREE.Sprite, which also tilts
// with camera pitch). Discrete, not a strip, so no atlas — each key's
// folder is an array of whole materials, one picked at random per instance.
const cutoutGeoCache = new Map(); // key -> shared PlaneGeometry
const cutoutMaterialCache = new Map(); // key -> Material[]

function cutoutGeometry(key, width, height) {
  if (!cutoutGeoCache.has(key)) {
    const geo = new THREE.PlaneGeometry(width, height);
    geo.userData.shared = true;
    cutoutGeoCache.set(key, geo);
  }
  return cutoutGeoCache.get(key);
}

// Two quads at right angles merged into ONE geometry (one draw call per
// tree) — for `cross: true` sprite folders. Same UV per quad: both faces
// show the full image.
function cutoutCrossGeometry(key, width, height) {
  const cacheKey = key + ":cross";
  if (!cutoutGeoCache.has(cacheKey)) {
    const a = new THREE.PlaneGeometry(width, height);
    const b = new THREE.PlaneGeometry(width, height);
    b.rotateY(Math.PI / 2);
    const geo = new THREE.BufferGeometry();
    for (const name of ["position", "normal", "uv"]) {
      const A = a.attributes[name], B = b.attributes[name];
      const merged = new Float32Array(A.array.length + B.array.length);
      merged.set(A.array);
      merged.set(B.array, A.array.length);
      geo.setAttribute(name, new THREE.BufferAttribute(merged, A.itemSize));
    }
    const ia = a.index.array, ib = b.index.array, off = a.attributes.position.count;
    const idx = new Uint16Array(ia.length + ib.length);
    idx.set(ia);
    for (let i = 0; i < ib.length; i++) idx[ia.length + i] = ib[i] + off;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.userData.shared = true;
    cutoutGeoCache.set(cacheKey, geo);
  }
  return cutoutGeoCache.get(cacheKey);
}

// Generic "swap me" placeholder — a labeled card, same convention as
// billboardTexture()'s "YOUR AD HERE" — since a real subject-specific
// silhouette can't be guessed for an arbitrary future key.
function cutoutFallbackTexture(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return canvasTexture(256, 256, (ctx, w, hgt) => {
    ctx.fillStyle = `hsl(${h % 360}, 55%, 60%)`;
    ctx.fillRect(0, 0, w, hgt);
    ctx.strokeStyle = "#1c1f26";
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, w - 8, hgt - 8);
    ctx.fillStyle = "#1c1f26";
    ctx.font = "bold 26px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(key.toUpperCase(), w / 2, hgt / 2);
  });
}

function makeCutoutMaterial(tex) {
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide });
  mat.userData.shared = true;
  return mat;
}

// Discovers images in a sprite folder (same directory-listing trick as the
// barrier ribbon) and builds one material per image; falls back to the
// generic labeled-card placeholder if none are found. Called from
// preloadAssets() — once per ASSETS.spriteFolders entry — so it's ready
// before any track builds.
async function loadCutoutVariants(key, folderUrl) {
  const real = folderUrl ? await discoverFolderImages(folderUrl) : [];
  // static backdrops (skyline/ruins/...) are meters-wide — give them more
  // texels than ordinary sprites or they turn to mush
  const spec = ASSETS.spriteFolders[key] ?? {};
  const maxDim = spec.texSize ?? (spec.static ? 384 : 128);
  const textures = real.length
    ? real.map((img) => spriteTextureFromImage(img, maxDim, !!spec.cross))
    : [cutoutFallbackTexture(key)];
  cutoutMaterialCache.set(key, textures.map(makeCutoutMaterial));
}

function ensureCutoutVariants(key) {
  // Lazy same-process fallback so this never throws if called before
  // preloadAssets() resolves — shouldn't happen since both main.js and
  // editor.js await it before building any track.
  if (!cutoutMaterialCache.has(key)) cutoutMaterialCache.set(key, [makeCutoutMaterial(cutoutFallbackTexture(key))]);
}

// Faked volumetric light cone — no real scattering, just a soft additive
// translucent cone hanging from a light source down toward the road. Apex
// (the narrow tip) sits at local origin so a caller can just position this
// at the light itself; the cone widens as it drops. Geometry/material are
// cached per distinct (radius, height) / (color, radius, height, opacity)
// combo since every light of a given kind (all lamps, all tunnel lights)
// shares the same numbers.
const _lightConeGeoCache = new Map();
function lightConeGeometry(radius, height) {
  const key = `${radius}_${height}`;
  let geo = _lightConeGeoCache.get(key);
  if (!geo) {
    geo = new THREE.ConeGeometry(radius, height, 16, 1, true);
    geo.translate(0, -height / 2, 0); // ConeGeometry's apex defaults to +y; shift so the apex lands at y=0
    geo.userData.shared = true;
    _lightConeGeoCache.set(key, geo);
  }
  return geo;
}
const _lightConeMatCache = new Map();
export function buildLightCone(color, radius = 3, height = 6, opacity = 0.1) {
  const key = `${color}_${radius}_${height}_${opacity}`;
  let mat = _lightConeMatCache.get(key);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    mat.userData.shared = true;
    _lightConeMatCache.set(key, mat);
  }
  return new THREE.Mesh(lightConeGeometry(radius, height), mat);
}

export function buildCutoutSprite(key, rng) {
  ensureCutoutVariants(key);
  const mats = cutoutMaterialCache.get(key);
  const mat = mats[(rng() * mats.length) | 0];
  const spec = ASSETS.spriteFolders[key] ?? {};
  const width = spec.width ?? 4, height = spec.height ?? 3;
  const geo = spec.cross ? cutoutCrossGeometry(key, width, height) : cutoutGeometry(key, width, height);
  const plane = new THREE.Mesh(geo, mat);
  plane.position.y = height / 2; // lift so the group's origin (ground level) is the bottom edge
  const g = new THREE.Group();
  g.add(plane);
  if (spec.cross) {
    // static cross: never re-faced per frame (that micro-rotation is what
    // shimmers under nearest sampling); random fixed yaw for row variety.
    // Still goes through the billboards list for distance culling — the
    // noFace flag just skips the rotation update.
    g.userData.noFace = true;
    plane.rotation.y = rng() * Math.PI * 2;
  }
  if (spec.light) {
    const l = spec.light;
    const light = new THREE.PointLight(l.color ?? 0xffffff, l.intensity ?? 1, l.distance ?? 12, l.decay ?? 2);
    light.position.y = height * (l.heightFrac ?? 0.9);
    light.castShadow = false; // opt-in dynamic lights stay cheap — no shadow maps
    g.add(light);
    // coneHeight defaults to the light's own height above the group origin
    // (ground) so the cone's base actually touches the floor instead of
    // hovering short of it.
    const cone = buildLightCone(
      l.color ?? 0xffffff,
      l.coneRadius ?? (l.distance ?? 12) * 0.22,
      l.coneHeight ?? light.position.y,
      l.coneOpacity ?? 0.1
    );
    cone.position.y = light.position.y;
    g.add(cone);
  }
  return g;
}

// Rigged crowd figure — see src/crowd.js for the rigging/rendering itself.
//
// Does NOT composite a fresh canvas+texture per instance (doesn't scale to
// a full-lap crowd's hundreds-to-thousands of placements). Instead a small
// fixed POOL of figures is composited once at load, each with a few
// pre-baked poses; every instance just references (never clones) a pool
// material and occasionally swaps which pose it points at — no canvas
// work, no re-upload. Texture/material count stays constant regardless of
// instance count; per-instance cost is one Mesh + an occasional timestamp check.
const CROWD_CANVAS_W = 96, CROWD_CANVAS_H = 132;
const CROWD_WORLD_HEIGHT = 1.75 * CONFIG.crowdScale; // metres — full billboard plane height (see CONFIG.crowdScale)
const CROWD_PRIMARY_CHANCE = 40; // % chance a shirt rolls bright — matches the crowd editor's own default
const CROWD_POOL_SIZE = 24; // distinct composited figures shared across every placed instance

const CROWD_PLANE_W = CROWD_WORLD_HEIGHT * (CROWD_CANVAS_W / CROWD_CANVAS_H);
let crowdPlaneGeo = null; // one shared PlaneGeometry for every instance, built lazily with the pool
const crowdPool = []; // [{ materials: [rest, gestureL, gestureR] }, ...]

function poseMaterial(fig, angleL, angleR) {
  const canvas = document.createElement("canvas");
  canvas.width = CROWD_CANVAS_W;
  canvas.height = CROWD_CANVAS_H;
  const ctx = canvas.getContext("2d");
  drawFigure(ctx, CROWD_CANVAS_W / 2, CROWD_CANVAS_H * 0.97, CROWD_CANVAS_H * 0.9, fig, angleL, angleR);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.05, side: THREE.DoubleSide });
  // Shared across every instance that references this pool entry — must
  // survive an editor rebuild's disposeDeep() the same way buildBarrier's
  // cached geometry/material do (see that function's comment).
  mat.userData.shared = true;
  return mat;
}

// Built once from preloadAssets(), never rebuilt per track — the pool isn't
// track/seed-specific, just a fixed palette of "extras" every track draws from.
function buildCrowdPool() {
  if (!crowdKits.length || crowdPool.length) return;
  crowdPlaneGeo = new THREE.PlaneGeometry(CROWD_PLANE_W, CROWD_WORLD_HEIGHT);
  crowdPlaneGeo.userData.shared = true;
  for (let i = 0; i < CROWD_POOL_SIZE; i++) {
    const kit = crowdKits[(Math.random() * crowdKits.length) | 0];
    const fig = pickFigure(kit, Math.random, CROWD_PRIMARY_CHANCE);
    // Gesture poses swing to that figure's own authored extremes (one arm
    // at a time) rather than a fixed angle, so a part with a narrow
    // authored range doesn't get bent past what its art was drawn for.
    const gestureL = fig.armL?.armMin ?? -40, gestureR = fig.armR?.armMax ?? 40;
    crowdPool.push({
      materials: [
        poseMaterial(fig, 0, 0),
        poseMaterial(fig, gestureL, 0),
        poseMaterial(fig, 0, gestureR),
      ],
    });
  }
}

export function buildCrowdFigure(rng) {
  // No kit loaded — same generic labeled-card fallback an empty Cutout folder uses.
  if (!crowdPool.length) return buildCutoutSprite("crowd", rng);

  const entry = crowdPool[(rng() * crowdPool.length) | 0];
  const plane = new THREE.Mesh(crowdPlaneGeo, entry.materials[0]);
  plane.position.y = CROWD_WORLD_HEIGHT / 2;

  const g = new THREE.Group();
  g.add(plane);
  g.userData.crowd = { entry, plane, poseIdx: 0, nextSwapAt: performance.now() + 500 + Math.random() * 4000 };
  return g;
}

// Beyond this distance, skip even the "is it time to swap pose" check —
// most Crowd rows are off in the distance at any given moment.
const CROWD_ANIM_DIST2 = 55 * 55;

// Called every frame alongside the camera-facing billboard rotation.
// No-ops on any billboard without userData.crowd (plain Cutout/Billboard sprites).
export function updateCrowdBillboard(group, now, cameraPos) {
  const c = group.userData?.crowd;
  if (!c) return;
  if (now < c.nextSwapAt) return;
  if (cameraPos) {
    const dx = group.position.x - cameraPos.x, dz = group.position.z - cameraPos.z;
    if (dx * dx + dz * dz > CROWD_ANIM_DIST2) return;
  }
  // Alternate rest <-> a random one-armed gesture, mirroring the
  // idle/hold/return rhythm the crowd editor's own preview uses, just as
  // discrete pose snaps instead of a continuously tweened redraw.
  c.poseIdx = c.poseIdx === 0 ? 1 + ((Math.random() * (c.entry.materials.length - 1)) | 0) : 0;
  c.plane.material = c.entry.materials[c.poseIdx];
  c.nextSwapAt = now + (c.poseIdx === 0 ? 800 + Math.random() * 3500 : 300 + Math.random() * 500);
}

let _billboardPostGeo = null, _billboardPanelGeo = null, _billboardPostMat = null;

function buildBillboardAssets() {
  if (_billboardPostMat) return;
  _billboardPostGeo = new THREE.CylinderGeometry(0.07, 0.07, 2.4, 6);
  _billboardPanelGeo = new THREE.PlaneGeometry(3.2, 1.6);
  _billboardPostMat = std(0x555a60);
  for (const shared of [_billboardPostGeo, _billboardPanelGeo, _billboardPostMat]) shared.userData.shared = true;
}

export function buildBillboard(rng) {
  const real = cachedClone("billboard");
  if (real) return real;
  buildBillboardAssets();
  const g = new THREE.Group();
  for (const x of [-1.2, 1.2]) {
    const post = new THREE.Mesh(_billboardPostGeo, _billboardPostMat);
    post.position.set(x, 1.2, 0);
    post.castShadow = true;
    g.add(post);
  }
  const idx = (rng() * BILLBOARD_TEXTS.length) | 0;
  const panel = new THREE.Mesh(_billboardPanelGeo, cachedBillboardMaterial(idx));
  panel.position.y = 2.9;
  panel.castShadow = true;
  g.add(panel);
  return g;
}

export function buildStartGantry(span) {
  const g = new THREE.Group();
  const mat = std(0x3a3f47, { metalness: 0.4, roughness: 0.5 });
  for (const x of [-span / 2, span / 2]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 3.1, 8), mat);
    post.position.set(x, 1.55, 0);
    post.castShadow = true;
    g.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(span + 0.6, 0.32, 0.32), mat);
  beam.position.y = 3.05;
  beam.castShadow = true;
  g.add(beam);
  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(span * 0.6, 0.62),
    new THREE.MeshStandardMaterial({
      map: canvasTexture(512, 64, (ctx, w, h) => {
        ctx.fillStyle = "#15181f";
        ctx.fillRect(0, 0, w, h);
        for (let x = 0; x < w / 16; x++) for (let y = 0; y < 2; y++) {
          if ((x + y) % 2) continue;
          ctx.fillStyle = "#e8e8e8";
          ctx.fillRect(x * 16, y * 8, 16, 8);
          ctx.fillRect(x * 16, h - 16 + y * 8, 16, 8);
        }
        ctx.fillStyle = "#ffcc33";
        ctx.font = "bold 30px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("START / FINISH", w / 2, h / 2);
      }),
      side: THREE.DoubleSide,
    })
  );
  banner.position.y = 2.55;
  g.add(banner);
  return g;
}

// ---------------------------------------------------------------------
// Cars
// ---------------------------------------------------------------------

export const WHEEL = {
  radius: 0.12, width: 0.09,
  localX: 0.26, frontZ: 0.48, rearZ: -0.47, localY: -0.17,
};

function makeWheel() {
  const wheelGroup = new THREE.Group();
  const tireGeo = new THREE.CylinderGeometry(WHEEL.radius, WHEEL.radius, WHEEL.width, 24);
  tireGeo.rotateZ(Math.PI / 2);
  const tire = new THREE.Mesh(tireGeo, std(0x141414, { roughness: 0.9, metalness: 0.1 }));
  tire.castShadow = true;
  const rimGeo = new THREE.CylinderGeometry(WHEEL.radius * 0.6, WHEEL.radius * 0.6, WHEEL.width * 1.02, 16);
  rimGeo.rotateZ(Math.PI / 2);
  const rim = new THREE.Mesh(rimGeo, std(0xcccccc, { roughness: 0.35, metalness: 0.8 }));
  const spinPivot = new THREE.Group();
  spinPivot.add(tire, rim);
  wheelGroup.add(spinPivot);
  wheelGroup.userData.spinPivot = spinPivot;
  return wheelGroup;
}

// Player rig: GLTF body + procedural wheels with steering pivots.
// carId selects which ASSETS.carModels entry to use (defaults to the
// first); must already be preloaded (see preloadAssets/carKey).
// Returns { group, tilt, body, steerPivots, spinPivots, rearAnchors, frontAnchors, lift }.
// `body` is the cloned GLTF root (undivided from tilt) — game/src/damage.js
// hangs crash-damage vertex deformation off it; editor/tuningLab consumers
// can ignore it.
export async function buildPlayerCar(carId = ASSETS.carModels[0]?.id) {
  const group = new THREE.Group();
  const tilt = new THREE.Group(); // body roll/pitch applied here, wheels stay planted
  group.add(tilt);

  // WHEEL is the shared baseline (tuned against White #7's body); a car can
  // override any of localX/frontZ/rearZ/localY via ASSETS.carModels[].wheelOffset
  // when its body proportions don't match — see carModels below.
  const carDef = ASSETS.carModels.find((c) => c.id === carId);
  const w = { ...WHEEL, ...carDef?.wheelOffset };

  const wheelFL = makeWheel(), wheelFR = makeWheel(), wheelRL = makeWheel(), wheelRR = makeWheel();
  const steerFL = new THREE.Group(), steerFR = new THREE.Group();
  steerFL.add(wheelFL);
  steerFR.add(wheelFR);
  steerFL.position.set(-w.localX, w.localY, w.frontZ);
  steerFR.position.set(w.localX, w.localY, w.frontZ);
  wheelRL.position.set(-w.localX, w.localY, w.rearZ);
  wheelRR.position.set(w.localX, w.localY, w.rearZ);
  group.add(steerFL, steerFR, wheelRL, wheelRR);

  const body = cachedClone(carKey(carId));
  body.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.material) {
        o.material.roughness = 0.85;
        o.material.metalness = 0.1;
      }
    }
  });
  tilt.add(body);

  // Lift the whole car so the wheels rest on the ground plane (y = 0).
  const box = new THREE.Box3().setFromObject(body);
  const bodyMinY = box.min.y;
  const lift = w.radius - (bodyMinY < w.localY ? w.localY : bodyMinY + 0.02);

  // Scaling the whole rig keeps body+wheels proportional automatically.
  // `lift` is applied externally (main.js) outside this scaled group, so
  // scale it up here too rather than relying on it to inherit the scale.
  // carDef?.scale is an optional per-car multiplier (visual only — see
  // ASSETS.carModels' comment on it).
  const rigScale = CONFIG.carScale * (carDef?.scale ?? 1);
  group.scale.setScalar(rigScale);

  return {
    group, tilt, body, lift: lift * rigScale,
    steerPivots: [steerFL, steerFR],
    spinPivots: [wheelFL, wheelFR, wheelRL, wheelRR].map((w) => w.userData.spinPivot),
    frontAnchors: [steerFL, steerFR],
    rearAnchors: [wheelRL, wheelRR],
  };
}

// Opponent: registered GLTF if provided (carId defaults to a random pick
// among ASSETS.carModels — see randomCarId), otherwise a boxy placeholder.
// Returns { group, body, spinPivots, lift }. `body` is the damageable subset
// of group (chassis/cabin/nose, or the whole GLTF) — wheels are siblings,
// not children, of it, so game/src/damage.js's crumple never reaches them.
// `lift` is how far AIRacer needs to raise `group` so the wheels rest on
// the road surface (group.position.y = groundY + lift) — for a GLTF body,
// the same Box3-derived measurement buildPlayerCar uses, because that
// convention's local origin sits mid-body rather than at wheel-contact
// height; the boxy fallback is already authored ground-origin and needs none.
// group IS scaled by CONFIG.carScale here (unlike an earlier version of
// this function) — AI opponents should render the same physical size as
// the player, which the shared CarPhysics they now drive already assumes.
export function buildOpponentCar(color, carId = randomCarId()) {
  const group = new THREE.Group();
  const real = carId ? cachedClone(carKey(carId)) : null;
  let body;
  if (real) {
    group.add(real);
    body = real;
  } else {
    body = new THREE.Group();
    const bodyMat = std(color, { roughness: 0.5, metalness: 0.25 });
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.26, 1.28), bodyMat);
    chassis.position.y = 0.26;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.2, 0.55), std(0x1c2026, { roughness: 0.3, metalness: 0.5 }));
    cabin.position.set(0, 0.48, -0.08);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.14, 0.28), bodyMat);
    nose.position.set(0, 0.2, 0.74);
    chassis.castShadow = cabin.castShadow = nose.castShadow = true;
    body.add(chassis, cabin, nose);
    group.add(body);
  }

  // Every opponent gets procedural wheels now — previously only this
  // function's boxy fallback did; a real-GLTF opponent (the common case)
  // rendered wheel-less. Same WHEEL + per-car wheelOffset fit buildPlayerCar
  // uses, just without a steering pivot (AI doesn't need visual toe).
  const carDef = ASSETS.carModels.find((c) => c.id === carId);
  const w = { ...WHEEL, ...carDef?.wheelOffset };

  // The two body branches above use OPPOSITE vertical conventions, so wheel
  // height and lift must BOTH follow whichever one produced `body`:
  //   GLTF (`real`)  — origin mid-body, floor below wheel-center height, so
  //                    wheels hang at w.localY and the rig has to be lifted
  //                    until the tires reach the road.
  //   boxy fallback  — origin AT ground level, whole body above it, so
  //                    wheels at +radius already sit on the road: lift 0.
  // Mixing them (GLTF wheel height with the fallback's lift) buried the
  // fallback's wheels ~0.3 m under the road, so the two decisions are made
  // off the same test. The GLTF arm is kept expression-identical to
  // buildPlayerCar's so one model rigged both ways sits at the same height.
  const bodyMinY = new THREE.Box3().setFromObject(body).min.y;
  const wheelY = real ? w.localY : w.radius;
  const liftRaw = real ? w.radius - (bodyMinY < w.localY ? w.localY : bodyMinY + 0.02) : 0;

  const spinPivots = [];
  for (const [x, z] of [
    [-w.localX, w.frontZ], [w.localX, w.frontZ],
    [-w.localX, w.rearZ], [w.localX, w.rearZ],
  ]) {
    const wheel = makeWheel();
    wheel.position.set(x, wheelY, z);
    group.add(wheel);
    spinPivots.push(wheel.userData.spinPivot);
  }

  // carDef?.scale is an optional per-car multiplier (visual only — see
  // ASSETS.carModels' comment on it).
  const rigScale = CONFIG.carScale * (carDef?.scale ?? 1);
  group.scale.setScalar(rigScale);
  return { group, body, spinPivots, lift: liftRaw * rigScale };
}
