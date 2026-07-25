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
    // City-track dressing kit — flat cutouts by design (cheap, and each is
    // replaceable by dropping a photo in its folder, like everything above).
    lamp: { folder: "assets/textures/lamp/", width: 0.95, height: 2.1 },
    flag: { folder: "assets/textures/flag/", width: 1.3, height: 2.6 },
    obelisk: { folder: "assets/textures/obelisk/", width: 1.6, height: 4.8 },
    chevron: { folder: "assets/textures/chevron/", width: 2.2, height: 1.05, static: true },
    grandstand: { folder: "assets/textures/grandstand/", width: 9, height: 2.7, static: true },
    pitbox: { folder: "assets/textures/pitbox/", width: 6.4, height: 2.0, static: true },
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
  jobs.push(loadRibbonAtlas("barrier", gamePath(ASSETS.ribbonFolders.barrier), drawFallbackBarrierVariants));
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

export function kerbTexture() {
  return canvasTexture(64, 16, (ctx, w, h) => {
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 ? "#e8e8e8" : "#d3382e";
      ctx.fillRect(i * (w / 4), 0, w / 4, h);
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
