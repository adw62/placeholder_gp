// =====================================================================
// Game orchestration: renderer/scene setup, input, race state machine
// (menu -> countdown -> racing -> finished), lap/checkpoint logic,
// camera, and per-frame wiring of physics / AI / effects / audio / HUD.
// =====================================================================

import * as THREE from "three";
import { CONFIG } from "../../shared/src/config.js";
import { TRACKS } from "./tracks.js";
import { loadLevels } from "./levels.js";
import { buildTrack } from "../../shared/src/track.js";
import { buildEnvironment, applyTheme, mulberry32, hashSeed } from "../../shared/src/environment.js";
import { buildAllTrackObjects } from "../../shared/src/trackObjects.js";
import { CarPhysics, collideWithWall } from "./physics.js";
import { AIRacer } from "./ai.js";
import { Effects } from "./effects.js";
import { GameAudio } from "./audio.js";
import { HUD, fmtTime } from "./hud.js";
import { applyCarPhysics, loadCarProfiles } from "./carProfiles.js";
import { preloadAssets, buildPlayerCar, WHEEL, updateCrowdBillboard, ASSETS, randomCarId } from "../../shared/src/placeholders.js";
import { mergeStaticGroup } from "./batching.js";

const clamp = THREE.MathUtils.clamp;

// TRACKS plus whatever init() finds in levels/ — menu and the ?track= dev
// shortcut read this so a user-generated level is indistinguishable from a built-in one.
let allTracks = TRACKS;

// ---------------------------------------------------------------------
// Renderer / scene / lights
// ---------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: false }); // PS1 look + fill rate: no MSAA
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// Shadows are BAKED once per race (see startRace): the sun frames the whole
// track statically instead of following the car, so there's no reason to
// re-render the shadow map (= redraw every caster) each frame.
renderer.shadowMap.autoUpdate = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.domElement.classList.add("game");
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);

const camera = new THREE.PerspectiveCamera(CONFIG.camera.baseFov, window.innerWidth / window.innerHeight, 0.1, 900);
camera.position.set(0, 4, -8);

const hemi = new THREE.HemisphereLight(0xffffff, 0x445533, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
sun.position.set(30, 45, -20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
// frustum is re-fit to each track's bounds in startRace (whole-track bake);
// big texels need normalBias rather than plain bias to stay acne-free
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.5;
scene.add(sun, sun.target);

// PS1 internal resolution: render at CONFIG.render.internalHeight (~240p),
// stretch the canvas over the window with nearest-neighbor upscaling. The
// particle shader sizes points in framebuffer pixels tuned at full res, so
// it gets told the ratio. Polled from tick() rather than event-driven so
// the tuning-lab slider (and window resizes) both just work.
const sizeState = { w: 0, h: 0, ih: 0 };
function applyRenderSize() {
  const w = window.innerWidth, h = window.innerHeight;
  const ih = Math.max(16, Math.round(CONFIG.render.internalHeight));
  if (w === sizeState.w && h === sizeState.h && ih === sizeState.ih) return;
  sizeState.w = w; sizeState.h = h; sizeState.ih = ih;
  const iw = Math.max(16, Math.round(ih * (w / h)));
  renderer.setPixelRatio(1);
  renderer.setSize(iw, ih, false); // false: leave CSS size to us
  const cv = renderer.domElement;
  cv.style.width = w + "px";
  cv.style.height = h + "px";
  cv.style.imageRendering = ih < h ? "pixelated" : "auto";
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  race?.effects.setPixelScale(ih / h);
}
// note: first call happens in init() — `race` is in TDZ this early in the module

// PS1 texture sampling: nearest + no mipmaps kills the bilinear/mipmap
// averaging that reads as fuzz at 240p, restoring the raw texel crawl.
// Applied to every texture in the scene; polled so the tuning-lab toggle
// works live. startRace resets `applied` so fresh track textures get it.
const filterState = { applied: null };
function applyTextureFiltering() {
  const on = CONFIG.render.ps1Textures >= 0.5;
  if (on === filterState.applied) return;
  filterState.applied = on;
  const setTex = (t) => {
    if (!t || t.userData.keepFilter) return;
    if (t.userData.spriteMip) {
      // pre-downsampled billboard sprites (placeholders.js): almost always
      // minified on screen, so raw no-mip nearest shimmers — keep mips,
      // nearest within each level for the pixelated look
      t.magFilter = on ? THREE.NearestFilter : THREE.LinearFilter;
      // crispMip (static cross sprites): one discrete mip level — the
      // inter-level blend averages two sizes together and reads blurry
      t.minFilter = on
        ? (t.userData.crispMip ? THREE.NearestMipmapNearestFilter : THREE.NearestMipmapLinearFilter)
        : THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
    } else {
      t.magFilter = on ? THREE.NearestFilter : THREE.LinearFilter;
      t.minFilter = on ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = !on;
    }
    t.needsUpdate = true;
  };
  scene.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) setTex(m.map);
  });
  // crowd pose materials swap in at runtime — not in the graph yet
  if (race) {
    for (const b of race.billboards) {
      const entry = b.userData?.crowd?.entry;
      if (entry) for (const m of entry.materials) setTex(m.map);
    }
  }
}

// ---------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------
const keys = {};
const isTyping = (e) => e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
window.addEventListener("keydown", (e) => {
  if (isTyping(e)) return; // don't drive the car while editing tuning fields
  if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
  if (!e.repeat) handleKeyPress(e.code);
  keys[e.code] = true;
});
window.addEventListener("keyup", (e) => {
  if (isTyping(e)) return;
  keys[e.code] = false;
});

function readInput() {
  return {
    throttle: keys.KeyW || keys.ArrowUp ? 1 : 0,
    brake: keys.KeyS || keys.ArrowDown ? 1 : 0,
    steer: (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0),
    handbrake: keys.Space ? 1 : 0,
  };
}

function handleKeyPress(code) {
  if (code === "KeyM") audio.toggleMute();
  if (code === "KeyF") togglePerf();
  if (!race) return;
  if (code === "KeyC") camState.mode = (camState.mode + 1) % CONFIG.camera.modes.length;
  if (code === "KeyR" && race.state === "racing") respawn();
  if (code === "Escape" && (race.state === "racing" || race.state === "countdown") && !race.finishedShown) {
    if (videoOpen) hud.onVideoBack(); // back to Pause instead of resuming the race
    else setPaused(!paused);
  }
}

// Camera orbit / zoom (chase modes only)
const camState = { mode: 0, yaw: 0, pitch: 0.26, zoom: 1, dragging: false, lastX: 0, lastY: 0, fov: CONFIG.camera.baseFov };
renderer.domElement.addEventListener("mousedown", (e) => {
  camState.dragging = true;
  camState.lastX = e.clientX;
  camState.lastY = e.clientY;
});
window.addEventListener("mouseup", () => (camState.dragging = false));
window.addEventListener("mousemove", (e) => {
  if (!camState.dragging) return;
  const dx = e.clientX - camState.lastX, dy = e.clientY - camState.lastY;
  camState.lastX = e.clientX;
  camState.lastY = e.clientY;
  camState.yaw -= dx * 0.006;
  camState.pitch = clamp(camState.pitch - dy * 0.004, -0.1, 0.85);
});
renderer.domElement.addEventListener("wheel", (e) => {
  camState.zoom = clamp(camState.zoom + e.deltaY * 0.0012, CONFIG.camera.zoomMin, CONFIG.camera.zoomMax);
}, { passive: true });

// ---------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------
const bestLapFor = (id) => {
  const v = localStorage.getItem(`pgp-bestlap-${id}`);
  return v ? Number(v) : null;
};
const saveBestLap = (id, ms) => {
  const cur = bestLapFor(id);
  if (cur == null || ms < cur) {
    localStorage.setItem(`pgp-bestlap-${id}`, String(ms));
    return true;
  }
  return false;
};
const loadSelectedCarId = () => {
  const saved = localStorage.getItem("pgp-car");
  return ASSETS.carModels.some((c) => c.id === saved) ? saved : ASSETS.carModels[0].id;
};

// ---------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------
const hud = new HUD();
hud.wireVideoOptions(CONFIG.render);
const audio = new GameAudio();

// Car-profile discovery (game/carProfiles/*.json, tuned in editor/tuningLab.html)
// — populated in init(), applied by applyCarPhysics() in setPlayerCar() below.
let carProfiles = new Map();
let playerRig = null;
let selectedCarId = loadSelectedCarId();
let race = null;
let lastDef = null;
let paused = false;
let lastTime = performance.now();

// (Re)builds the player rig for the given car model and swaps it into the
// scene in place of whatever was there. Cheap after boot — preloadAssets()
// already cached every ASSETS.carModels entry, so this is just a clone.
async function setPlayerCar(carId) {
  selectedCarId = carId;
  localStorage.setItem("pgp-car", carId);
  applyCarPhysics(carId, carProfiles);
  const wasVisible = playerRig?.group.visible ?? false;
  const newRig = await buildPlayerCar(carId);
  if (playerRig) {
    scene.remove(playerRig.group);
    disposeDeep(playerRig.group);
  }
  newRig.group.visible = wasVisible;
  scene.add(newRig.group);
  playerRig = newRig;
}

hud.onRestart = () => {
  if (!lastDef) return;
  paused = false;
  hud.showPause(false);
  hud.hideResults();
  audio.init();
  audio.resume();
  startRace(lastDef);
};
hud.onResume = () => setPaused(false);
hud.onQuitToMenu = () => {
  paused = false;
  hud.showPause(false);
  hud.hideResults();
  showMenu();
};
hud.onVideoOpen = () => { videoOpen = true; hud.showPause(false); hud.showVideo(true); };
hud.onVideoBack = () => { videoOpen = false; hud.showVideo(false); hud.showPause(true); };

let videoOpen = false; // pause stays "on" the whole time the video screen is open — see handleKeyPress's Escape case

function setPaused(on) {
  paused = on;
  if (videoOpen) hud.onVideoBack(); // any other way out of pause (Resume/Restart/Quit) also backs out of Video first
  hud.showPause(on);
  if (on) audio.suspend();
  else audio.resume();
}

// ---------------------------------------------------------------------
// Race lifecycle
// ---------------------------------------------------------------------
function disposeDeep(root) {
  root.traverse((o) => {
    // Cached module-level singletons (barrier/apexKerb geo+mat+texture, see
    // placeholders.js) are shared across every instance — skip anything tagged shared.
    if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m.userData?.shared) continue;
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
}

function teardownRace() {
  if (!race) return;
  scene.remove(race.track.group, race.env, race.objects);
  disposeDeep(race.track.group);
  disposeDeep(race.env);
  disposeDeep(race.objects);
  for (const a of race.ai) {
    scene.remove(a.group);
    disposeDeep(a.group);
  }
  race.effects.dispose();
  audio.stopRaceSounds();
  race = null;
}

function showMenu() {
  teardownRace();
  hud.hideRaceUI();
  playerRig.group.visible = false;
  scene.background = new THREE.Color(0x0b0e14);
  scene.fog = null;
  hud.showCarPicker(ASSETS.carModels, selectedCarId, (car) => {
    audio.init();
    audio.click();
    setPlayerCar(car.id);
  });
  hud.showMenu(allTracks, bestLapFor, (def) => {
    audio.init();
    audio.click();
    hud.hideMenu();
    startRace(def);
  });
}

const GRID = [
  { s: 3, lat: 1.5 },   // player (starts last)
  { s: 7, lat: -1.5 },
  { s: 11, lat: 1.5 },
  { s: 15, lat: -1.5 },
];

function startRace(def) {
  teardownRace();
  lastDef = def;

  const rng = mulberry32(hashSeed(def.id));
  const track = buildTrack(def);
  scene.add(track.group);
  applyTheme(def.theme, scene, sun, hemi);
  const env = buildEnvironment(def, track, rng);
  scene.add(env);
  const { group: objects, billboards } = buildAllTrackObjects(def, track, rng);
  scene.add(objects);
  const effects = new Effects(scene);
  effects.setPixelScale(sizeState.ih / Math.max(1, sizeState.h));

  // --- draw-call batching (batching.js): merge static props into one mesh
  // per 70 m chunk. The editor keeps individual meshes; only the race merges. ---
  const exclude = new Set(billboards);
  const staticBatches = [];
  for (const g of [env, objects]) {
    const merged = mergeStaticGroup(g, exclude);
    for (const m of merged) g.add(m);
    staticBatches.push(...merged);
  }
  // Chunks far from the road (the background hill ring) are horizon
  // dressing — exempt from draw-distance culling or the skyline vanishes.
  for (const m of staticBatches) {
    const c = m.userData.cullCenter;
    let best = Infinity;
    for (let i = 0; i < track.samples.length; i += 8) {
      const p = track.samples[i].p;
      const dx = c.x - p.x, dz = c.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) best = d2;
    }
    if (best > 140 * 140) m.userData.noCull = true;
  }

  // --- static sun: frame the whole track, bake the shadow map once.
  // (Following the car forced a full shadow-map redraw every frame.) ---
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of track.samples) {
    minX = Math.min(minX, s.p.x); maxX = Math.max(maxX, s.p.x);
    minZ = Math.min(minZ, s.p.z); maxZ = Math.max(maxZ, s.p.z);
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const shadowR = Math.max(maxX - minX, maxZ - minZ) / 2 + 110; // scatter reaches ~90 m past the walls
  const sunDist = shadowR * 2.5;
  sun.position.set(cx + 0.52 * sunDist, 0.78 * sunDist, cz - 0.35 * sunDist);
  sun.target.position.set(cx, 0, cz);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -shadowR;
  sun.shadow.camera.right = sun.shadow.camera.top = shadowR;
  sun.shadow.camera.near = Math.max(1, sunDist - shadowR * 2);
  sun.shadow.camera.far = sunDist + shadowR * 2;
  sun.shadow.camera.updateProjectionMatrix();
  renderer.shadowMap.needsUpdate = true; // bake on the next render

  // Moving cars can't live in a baked shadow map (they'd leave a frozen
  // shadow on the grid) — they get a PS1 blob shadow instead.
  playerRig.group.traverse((o) => { o.castShadow = false; });
  attachBlobShadow();
  filterState.applied = null; // fresh track textures: reapply filtering next tick

  // player on the grid
  const player = new CarPhysics();
  const spawnPos = new THREE.Vector3(), spawnTan = new THREE.Vector3();
  track.posAt(GRID[0].s, GRID[0].lat, spawnPos, spawnTan);
  player.reset(spawnPos, Math.atan2(spawnTan.x, spawnTan.z));
  playerRig.group.visible = true;

  // AI opponents (CONFIG.ai.enabled=false -> solo time trial)
  const ai = (CONFIG.ai.enabled ? CONFIG.ai.skills : []).map((skill, i) => {
    const racer = new AIRacer(track, {
      skill,
      color: CONFIG.ai.colors[i],
      offset: CONFIG.ai.offsets[i],
      startS: GRID[i + 1].s,
      startLat: GRID[i + 1].lat,
      carId: randomCarId(),
    });
    racer.group.traverse((o) => { o.castShadow = false; }); // baked shadow map — see above
    scene.add(racer.group);
    return racer;
  });

  // Pre-built once per race and mutated in place every frame in drawHud()
  // (position only — color/big are fixed for the race) instead of
  // rebuilding a fresh array + objects + re-formatting each AI's color
  // string 60x/sec.
  const minimapDots = ai.map((a) => ({ x: 0, z: 0, color: "#" + a.color.toString(16).padStart(6, "0"), big: false }));
  minimapDots.push({ x: 0, z: 0, color: "#ffffff", big: true });

  // Warm the GPU now, not mid-race: three.js compiles each material's
  // shader program and uploads each texture the first time its object is
  // actually rendered — so the first skid mark, the first crowd row to
  // scroll into view, and each cutout variant's first appearance would all
  // land a hitch somewhere in lap 1. Do it all here instead.
  renderer.compile(scene, camera);
  scene.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) if (m.map) renderer.initTexture(m.map);
  });
  for (const b of billboards) {
    // crowd figures swap between pose materials at runtime — upload the
    // not-currently-assigned poses too
    const entry = b.userData?.crowd?.entry;
    if (entry) for (const m of entry.materials) if (m.map) renderer.initTexture(m.map);
  }

  race = {
    def, track, env, objects, billboards, effects, player, ai, minimapDots,
    staticBatches, bakeFrames: 0,
    state: "countdown", countT: 3.999, beeped: 4,
    raceT: 0, lapStartT: 0, lapsDone: 0, cp: 0, lapTimes: [],
    lastIdx: 0, bumpCd: 0,
    driftChain: 0, driftEnd: 0, driftTotal: 0,
    wrongWayT: 0, finishT: 0, finishedShown: false, finalPos: 4,
    newRecord: false,
  };

  posePlayerRig(0);
  hud.showRaceUI();
  hud.minimapInit(track.minimapPts);
  hud.setWrongWay(false);
  snapCamera();
}

function respawn() {
  const r = race;
  const idx = r.track.checkpoints[r.cp];
  const s = r.track.samples[idx];
  r.player.reset(s.p, Math.atan2(s.t.x, s.t.z));
  r.lastIdx = idx;
  posePlayerRig(0);
  snapCamera();
}

function finishRace() {
  const r = race;
  r.state = "finished";
  r.finalPos = currentPosition();
  r.driftTotal += Math.round(r.driftChain);
  r.driftChain = 0;
  hud.center("FINISH!", "go", 1600);
  audio.fanfare();
  hud.setWrongWay(false);
}

function currentPosition() {
  const r = race;
  const q = r.track.query(r.player.pos, r.lastIdx);
  const region = Math.floor(q.idx / (r.track.samples.length / r.track.ncp)) % r.track.ncp;
  const within = region === r.cp ? q.idx / r.track.samples.length : r.cp / r.track.ncp;
  const score = r.lapsDone + within;
  return 1 + r.ai.filter((a) => a.progress > score).length;
}

function showResults() {
  const r = race;
  const total = r.lapTimes.reduce((a, b) => a + b, 0);
  const raceMeters = r.track.length * r.def.laps;
  const tGold = (raceMeters / r.def.medalAvgSpeed.gold) * 1000;
  const tSilver = (raceMeters / r.def.medalAvgSpeed.silver) * 1000;
  const tBronze = (raceMeters / r.def.medalAvgSpeed.bronze) * 1000;
  let medal = "No medal — bronze pace: " + fmtTime(tBronze);
  if (total <= tGold) medal = "🥇 GOLD";
  else if (total <= tSilver) medal = "🥈 SILVER";
  else if (total <= tBronze) medal = "🥉 BRONZE";

  const bestIdx = r.lapTimes.indexOf(Math.min(...r.lapTimes));
  const titles = r.ai.length ? ["WINNER!", "2ND PLACE", "3RD PLACE", "4TH PLACE"] : ["FINISH!"];
  const subParts = [];
  if (r.newRecord) subParts.push(`<b style="color:#ffcc33">NEW BEST LAP!</b>`);
  subParts.push(`Gold ${fmtTime(tGold)} &middot; Silver ${fmtTime(tSilver)} &middot; Bronze ${fmtTime(tBronze)}`);
  if (r.driftTotal > 10) subParts.push(`Drift score: <b>${r.driftTotal}</b>`);

  hud.showResults({
    title: titles[r.finalPos - 1] ?? "FINISH",
    medal,
    sub: subParts.join("<br>"),
    laps: r.lapTimes,
    bestIdx,
    total,
  });
}

// ---------------------------------------------------------------------
// Per-frame update
// ---------------------------------------------------------------------
function gearAndRpm(v, throttle) {
  const G = CONFIG.gearSpeeds;
  if (v < -0.3) return { gear: "R", rpm: 0.3 + 0.5 * Math.min(1, -v / CONFIG.physics.maxReverse) };
  if (v < 0.3) return { gear: throttle ? "1" : "N", rpm: throttle ? 0.55 : 0.12 };
  let g = 1;
  while (g < G.length - 1 && v > G[g]) g++;
  return { gear: String(g), rpm: 0.25 + 0.72 * clamp((v - G[g - 1]) / (G[g] - G[g - 1]), 0, 1) };
}

const rigState = { roll: 0, pitch: 0 };

// PS1-style blob shadow under the player (the baked static shadow map
// can't contain a moving car). Child of the rig group: inherits heading
// and road pitch, sits just above the road, sized from carScale.
let blobShadow = null;
function attachBlobShadow() {
  if (!blobShadow) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d");
    const grad = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
    grad.addColorStop(0, "rgba(0,0,0,0.40)");
    grad.addColorStop(0.65, "rgba(0,0,0,0.28)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.userData.keepFilter = true; // nearest sampling would band the gradient into rings
    blobShadow = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    blobShadow.renderOrder = 1;
  }
  const L = CONFIG.wheelBase * CONFIG.carScale;
  blobShadow.scale.set(L * 1.5, 1, L * 2.1);
  blobShadow.position.y = -playerRig.lift + 0.055;
  playerRig.group.add(blobShadow);
}

// Terrain frame (elevation+slope) at the player's position — AI cars get
// this for free from track.posAt(), but CarPhysics.pos stays planar (x/z
// only), so the visual rig sources it separately. Must be CONTINUOUS as the
// car moves: anything keyed off the single nearest sample (its p, t or arc)
// steps discretely every time the nearest index flips — invisible on a flat
// track, but visible y/pitch jitter on one with elevation, amplified through
// the camera height and lookAt. So: true closest-point projection onto the
// two polyline segments flanking the nearest sample (the projection onto a
// polyline is continuous; per-sample quantities aren't).
const _groundPos = new THREE.Vector3(), _groundTan = new THREE.Vector3(), _gq = new THREE.Vector3();

// Continuous closest-point projection of a world position onto the track
// polyline — shared by the player ground frame and effects ground queries.
function projectArcLat(pos) {
  const q = race.track.query(pos, race.lastIdx);
  const samples = race.track.samples;
  const N = samples.length;
  let bestD2 = Infinity, arc = q.s.arc, lat = q.lateral;
  for (let k = -1; k <= 0; k++) {
    const sa = samples[(q.idx + k + N) % N], a = sa.p;
    const b = samples[(q.idx + k + 1 + N) % N].p;
    const ex = b.x - a.x, ez = b.z - a.z;
    const len2 = ex * ex + ez * ez;
    if (len2 < 1e-12) continue;
    const u = clamp(((pos.x - a.x) * ex + (pos.z - a.z) * ez) / len2, 0, 1);
    const dx = pos.x - (a.x + ex * u), dz = pos.z - (a.z + ez * u);
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      const len = Math.sqrt(len2);
      arc = sa.arc + u * len;
      lat = (dx * ez - dz * ex) / len; // signed distance, side = (t.z, -t.x)
    }
  }
  return { arc, lat };
}

function playerGroundFrame() {
  const { arc, lat } = projectArcLat(race.player.pos);
  race.track.posAt(arc, lat, _groundPos, _groundTan);
  return { y: _groundPos.y, tan: _groundTan };
}

// Road elevation under an arbitrary world x/z — skid marks, smoke and dust
// must sit on the road surface, not at a fixed world height (a mark laid
// at y=0.045 on a +2 m hill is 2 m underground).
function groundHeightAt(x, z) {
  const { arc, lat } = projectArcLat(_gq.set(x, 0, z));
  race.track.posAt(arc, lat, _groundPos);
  return _groundPos.y;
}

// Even the segment projection above has an unavoidable discontinuity: a
// polyline has kinks, and a closest-point projection jumps by
// lateral·kinkAngle (~0.1 m arc here) whenever the car crosses a concave
// vertex's bisector — ~5 mm of ground height on a grade, a dozen times a
// second at speed, feeding car pose AND camera as visible jitter on any
// track with elevation. So the two scalars every consumer actually needs
// (height, slope = tangent Y) go through a short low-pass, computed once
// per frame (updateGroundFrame) and read by physics/rig/camera from here.
const groundState = { y: 0, ty: 0, init: false };
function updateGroundFrame(dt) {
  const g = playerGroundFrame();
  const gs = groundState;
  const k = 1 - Math.exp(-dt * 12); // ~80 ms — jitter gone, crest lag ~4 cm at speed
  if (!gs.init || dt <= 0 || Math.abs(g.y - gs.y) > 1.5) {
    gs.y = g.y; gs.ty = g.tan.y; gs.init = true; // first frame / teleport: snap
  } else {
    gs.y += (g.y - gs.y) * k;
    gs.ty += (g.tan.y - gs.ty) * k;
  }
}

function posePlayerRig(dt) {
  const p = race.player;
  const g = groundState;
  playerRig.group.position.set(p.pos.x, g.y + playerRig.lift, p.pos.z);
  // Yaw first, then tilt the nose around the now-yawed local X axis to
  // match the road's slope — same rotate-after-set composition as
  // trackObjects.js's "conform to slope". Uses the road's own pitch, not
  // projected onto heading — fine while roughly on-line, a cosmetic
  // approximation if pointed sharply off the track's direction.
  // rotateX(+angle) tilts the nose DOWN (local +Z maps to (0,-sinθ,cosθ)) —
  // negate so climbing (ty > 0) tilts the nose up. Tangents are unit
  // vectors, so pitch derives from the Y component alone.
  const pitch = -Math.asin(clamp(g.ty, -1, 1));
  playerRig.group.rotation.set(0, p.heading, 0);
  playerRig.group.rotateX(pitch);
  for (const sp of playerRig.steerPivots) sp.rotation.y = p.steer;
  // Wheel roll rate: circumference grows with the scaled-up rig (see
  // CONFIG.carScale), so the physical radius used for rolling speed must
  // scale too, else the wheels visually spin faster than they roll.
  const base = (p.vLong / (WHEEL.radius * CONFIG.carScale)) * dt;
  const dir = p.vLong >= 0 ? 1 : -1;
  const extraF = dir * p.spinF * 14 * dt; // wheelspin: driven wheels visibly overspin
  const extraR = dir * p.spinR * 14 * dt;
  playerRig.spinPivots[0].rotation.x += base + extraF;
  playerRig.spinPivots[1].rotation.x += base + extraF;
  playerRig.spinPivots[2].rotation.x += base + extraR;
  playerRig.spinPivots[3].rotation.x += base + extraR;

  // body roll/pitch on the tilt group
  const targetRoll = clamp(-p.vLat * 0.05 - p.steer * Math.min(1, p.speed / 10) * 0.05, -0.15, 0.15);
  const targetPitch = clamp(-p.aLong * 0.005, -0.07, 0.07);
  const k = dt > 0 ? 1 - Math.exp(-dt * 8) : 1;
  rigState.roll += (targetRoll - rigState.roll) * k;
  rigState.pitch += (targetPitch - rigState.pitch) * k;
  playerRig.tilt.rotation.z = rigState.roll;
  playerRig.tilt.rotation.x = rigState.pitch;
  playerRig.group.updateMatrixWorld(true);
}

function snapCamera() {
  const p = race.player;
  updateGroundFrame(0); // dt 0 = snap the smoothed frame (resets/teleports)
  const groundY = groundState.y;
  const mode = CONFIG.camera.modes[camState.mode] ?? CONFIG.camera.modes[0];
  const dist = (mode.dist || 5.8) * camState.zoom * CONFIG.carScale;
  camState.yaw = 0;
  camera.position.set(
    p.pos.x - Math.sin(p.heading) * dist,
    groundY + (mode.height || 2.3) * camState.zoom * CONFIG.carScale,
    p.pos.z - Math.cos(p.heading) * dist
  );
  camera.lookAt(p.pos.x, groundY + 0.6, p.pos.z);
}

const camLook = new THREE.Vector3();
const camDesired = new THREE.Vector3();

function updateCamera(dt) {
  const p = race.player;
  const groundY = groundState.y;
  const mode = CONFIG.camera.modes[camState.mode];
  const C = CONFIG.camera;
  let targetFov;

  if (mode.name === "hood") {
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    camera.position.set(p.pos.x + fx * 0.15, groundY + playerRig.lift + 0.62, p.pos.z + fz * 0.15);
    camLook.set(p.pos.x + fx * 12, groundY + 0.5, p.pos.z + fz * 12);
    camera.lookAt(camLook);
    targetFov = C.hoodFov + C.speedFov * Math.pow(p.speed / CONFIG.physics.maxSpeed, 1.5);
  } else {
    const dist = mode.dist * camState.zoom * CONFIG.carScale;
    const height = (mode.height + camState.pitch * 4) * camState.zoom * CONFIG.carScale;
    const ang = p.heading + camState.yaw;
    camDesired.set(p.pos.x - Math.sin(ang) * dist, groundY + height, p.pos.z - Math.cos(ang) * dist);
    camera.position.lerp(camDesired, 1 - Math.exp(-dt * C.lerp)); // exponential: uniform smoothing even when dt varies
    camLook.set(p.pos.x, groundY + 0.6, p.pos.z);
    camera.lookAt(camLook);
    targetFov = C.baseFov + C.speedFov * Math.pow(p.speed / CONFIG.physics.maxSpeed, 1.5);
  }

  const shake = race.effects.shake;
  if (shake > 0.001) {
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake * 0.6;
    camera.position.z += (Math.random() - 0.5) * shake;
  }

  camState.fov += (targetFov - camState.fov) * (1 - Math.exp(-dt * 4));
  if (Math.abs(camera.fov - camState.fov) > 0.05) {
    camera.fov = camState.fov;
    camera.updateProjectionMatrix();
  }

}

function step(now, dt) {
  const r = race;

  // Draw-distance culling (PS1 pop-in, per chunk/billboard): everything
  // past CONFIG.render.drawDistance is skipped — usually hidden by fog,
  // and lowering the distance in the tuning lab makes it a look. The
  // first two frames render everything so the one-shot shadow bake and
  // GPU warm-up see the full scene.
  const cullOn = r.bakeFrames >= 2;
  if (!cullOn) r.bakeFrames++;
  const dd = CONFIG.render.drawDistance;
  const dd2 = dd * dd;
  if (cullOn) {
    for (const m of r.staticBatches) {
      if (m.userData.noCull) continue;
      const c = m.userData.cullCenter;
      const dx = camera.position.x - c.x, dz = camera.position.z - c.z;
      const reach = dd + m.userData.cullRadius;
      m.visible = dx * dx + dz * dz < reach * reach;
    }
  }

  // Y-axis-only billboarding keeps sprites upright (unlike THREE.Sprite,
  // which also tilts with camera pitch). updateCrowdBillboard no-ops for
  // any type that isn't a rigged Crowd figure.
  for (const b of r.billboards) {
    const dx = camera.position.x - b.position.x, dz = camera.position.z - b.position.z;
    if (cullOn) {
      b.visible = dx * dx + dz * dz < dd2;
      if (!b.visible) continue;
    }
    if (!b.userData.noFace) { // cross sprites (trees/pines) are static, cull-only
      b.rotation.y = Math.atan2(dx, dz);
      updateCrowdBillboard(b, now, camera.position);
    }
  }

  const input = readInput();
  const N = r.track.samples.length;
  const ncp = r.track.ncp;
  updateGroundFrame(dt); // smoothed ground height/slope for this frame

  // ---------- countdown ----------
  if (r.state === "countdown") {
    r.countT -= dt;
    const c = Math.ceil(r.countT);
    if (c < r.beeped && c > 0) {
      r.beeped = c;
      hud.center(String(c), "", 850);
      audio.beep(440, 0.15, 0.3);
    }
    audio.setEngine(input.throttle ? 0.8 : 0.14, input.throttle ? 0.8 : 0);
    if (r.countT <= 0) {
      r.state = "racing";
      r.raceT = 0;
      r.lapStartT = 0;
      hud.center("GO!", "go", 900);
      audio.beep(880, 0.4, 0.35);
    }
    updateCamera(dt);
    drawHud(input, { onRoad: true });
    return;
  }

  r.raceT += dt;
  const inp = r.state === "finished" ? { throttle: 0, brake: 1, steer: 0, handbrake: 0 } : input;

  // ---------- surface + physics (substepped) ----------
  let q = r.track.query(r.player.pos, r.lastIdx);
  r.lastIdx = q.idx;
  const onRoad = Math.abs(q.lateral) <= r.track.halfW + CONFIG.track.kerbWidth;
  const off = CONFIG.physics.offroad;
  // Slope = tangent Y (already sinθ of the local grade, tangents are unit
  // vectors). Taken from the smoothed ground frame, NOT q.s.t.y — the
  // nearest sample's tangent steps discretely at sample boundaries, which
  // judders the gravity-along-road force on any track with elevation.
  // Reused for every substep this frame (same once-per-frame
  // simplification grip/drag/power already make below).
  const slope = groundState.ty;
  const surface = onRoad
    ? { grip: 1, drag: 0, power: 1, slope }
    : { grip: off.grip, drag: off.drag, power: off.power, slope };

  // The tire model is a stiff ODE — integrate at ≥240 Hz for stability.
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  let impact = 0;
  for (let i = 0; i < steps; i++) {
    r.player.update(h, inp, surface);
    q = r.track.query(r.player.pos, r.lastIdx);
    r.lastIdx = q.idx;
    impact = Math.max(impact, collideWithWall(r.player, q, r.track.wallDistAt(q.idx, Math.sign(q.lateral) || 1)));
  }
  if (impact > 2.5) {
    audio.thud(impact / 8);
    const sgn = Math.sign(q.lateral) || 1;
    r.effects.impact(r.player.pos.x, groundState.y, r.player.pos.z, q.s.side.x * sgn, q.s.side.z * sgn, impact);
  }

  // ---------- checkpoints & laps ----------
  if (r.state === "racing" && Math.abs(q.lateral) < r.track.wallDist + 2) {
    const region = Math.floor(q.idx / (N / ncp)) % ncp;
    const expect = (r.cp + 1) % ncp;
    if (region === expect) {
      r.cp = expect;
      if (expect === 0) {
        const lapMs = (r.raceT - r.lapStartT) * 1000;
        r.lapTimes.push(lapMs);
        r.lapStartT = r.raceT;
        r.lapsDone++;
        if (saveBestLap(r.def.id, lapMs)) r.newRecord = true;
        if (r.lapsDone >= r.def.laps) finishRace();
        else if (r.lapsDone === r.def.laps - 1) {
          hud.center("FINAL LAP", "info", 1600);
          audio.beep(700, 0.2, 0.25, "triangle");
        }
      }
    }
  }

  // ---------- player progress score for ranking ----------
  const region = Math.floor(q.idx / (N / ncp)) % ncp;
  const within = region === r.cp ? q.idx / N : r.cp / ncp;
  const playerScore = r.lapsDone + within;

  // ---------- AI ----------
  r.bumpCd = Math.max(0, r.bumpCd - dt);
  const RB = CONFIG.ai.rubberBand;
  for (const a of r.ai) {
    if (a.lap >= r.def.laps) a.finished = true;
    const rubber = clamp(1 + (playerScore - a.progress) * r.track.length * RB.gain, RB.min, RB.max);
    a.update(dt, rubber);

    // simple car-vs-car push (player only)
    const dx = r.player.pos.x - a.pos.x, dz = r.player.pos.z - a.pos.z;
    const dist = Math.hypot(dx, dz);
    const minD = CONFIG.physics.carRadius * CONFIG.carScale + CONFIG.ai.radius;
    if (dist < minD && dist > 1e-4) {
      const nx = dx / dist, nz = dz / dist;
      const push = minD - dist;
      r.player.pos.x += nx * push;
      r.player.pos.z += nz * push;
      r.player.vel.x += nx * 2.2;
      r.player.vel.z += nz * 2.2;
      a.v *= 0.97;
      if (r.bumpCd <= 0) {
        audio.thud(0.5);
        r.effects.impact(a.pos.x, 0, a.pos.z, -nx, -nz, 3);
        r.bumpCd = 0.5;
      }
    }
  }

  // ---------- drift scoring ----------
  if (r.state === "racing" && r.player.drifting && onRoad) {
    r.driftChain += Math.abs(r.player.slip) * r.player.speed * CONFIG.drift.scoreRate * dt;
    r.driftEnd = 0.6;
  } else if (r.driftChain > 0) {
    r.driftEnd -= dt;
    if (r.driftEnd <= 0) {
      r.driftTotal += Math.round(r.driftChain);
      r.driftChain = 0;
    }
  }

  // ---------- wrong way ----------
  const tangDot = r.player.vel.x * q.s.t.x + r.player.vel.z * q.s.t.z;
  if (r.state === "racing" && tangDot < -3) r.wrongWayT += dt;
  else r.wrongWayT = 0;
  hud.setWrongWay(r.wrongWayT > 1);

  // ---------- visuals / effects / audio ----------
  posePlayerRig(dt);

  // Drift/handbrake/brake-lockup marking is always a rear-axle phenomenon in
  // this model (handbrakes act on the rear regardless of drivetrain). Wheelspin
  // marking/smoke follows whichever axle is actually driven, so a FWD car
  // burns rubber at its front wheels instead of the rear (see effects.js).
  const rearSlideMark =
    (r.player.drifting || (inp.handbrake && r.player.speed > 3) || (inp.brake && r.player.vLong > 12)) && onRoad;
  const driveSpinMark = r.player.wheelspin > 0.3 && onRoad;
  const driveAnchors = CONFIG.physics.drivetrain === "rwd" ? playerRig.rearAnchors : playerRig.frontAnchors;
  // Understeer (front tire past its own peak slip angle) is a LATERAL scrub,
  // not wheelspin — physics.js's frontPush (0..1) is the dedicated signal for
  // it, independent of drivetrain, so it needs its own marking/smoke trigger
  // instead of riding on the wheelspin-driven ones above.
  const frontSlideMark = r.player.frontPush > 0.3 && onRoad;
  r.effects.update(dt, {
    rearSlideMark,
    driveSpinMark,
    frontSlideMark,
    drifting: r.player.drifting,
    burnout: r.player.wheelspin > 0.35,
    frontScrub: r.player.frontPush > 0.35,
    onRoad,
    speed: r.player.speed,
    vel: r.player.vel,
    rearAnchors: playerRig.rearAnchors,
    driveAnchors,
    frontAnchors: playerRig.frontAnchors,
    groundYAt: groundHeightAt,
  });

  const { gear, rpm } = gearAndRpm(r.player.vLong, inp.throttle);
  audio.setEngine(Math.min(1, rpm + r.player.wheelspin * 0.3), inp.throttle); // spin flares the revs
  const skidAmount = onRoad
    ? clamp((Math.abs(r.player.slip) - 0.08) * 2.5, 0, 1) * clamp(r.player.speed / 8, 0, 1)
    : 0;
  audio.setSkid(Math.max(
    skidAmount,
    inp.handbrake && onRoad && r.player.speed > 4 ? 0.55 : 0,
    onRoad ? r.player.wheelspin * 0.7 : 0,
    onRoad ? r.player.frontPush * 0.7 : 0 // front understeer scrub gets the same audible tire cue
  ));
  audio.setWind(r.player.speed / CONFIG.physics.maxSpeed);

  updateCamera(dt);
  drawHud(inp, { onRoad, gear });

  // ---------- results ----------
  if (r.state === "finished" && !r.finishedShown) {
    r.finishT += dt;
    if (r.finishT > 1.6) {
      r.finishedShown = true;
      showResults();
    }
  }
}

function drawHud(inp, extra) {
  const r = race;
  const { gear } = extra.gear ? extra : gearAndRpm(r.player.vLong, inp.throttle);
  const curMs = r.state === "racing" ? (r.raceT - r.lapStartT) * 1000 : r.state === "finished" ? null : 0;
  hud.update({
    speed: Math.round(Math.abs(r.player.vLong) * 3.6 * CONFIG.speedDisplayScale),
    gear,
    lap: Math.min(r.lapsDone + 1, r.def.laps),
    totalLaps: r.def.laps,
    pos: r.state === "finished" ? r.finalPos : currentPosition(),
    total: r.ai.length + 1,
    cur: curMs,
    last: r.lapTimes[r.lapTimes.length - 1] ?? null,
    best: bestLapFor(r.def.id),
    driftChain: r.driftChain,
  });
  for (let i = 0; i < r.ai.length; i++) {
    r.minimapDots[i].x = r.ai[i].pos.x;
    r.minimapDots[i].z = r.ai[i].pos.z;
  }
  const playerDot = r.minimapDots[r.minimapDots.length - 1];
  playerDot.x = r.player.pos.x;
  playerDot.z = r.player.pos.z;
  hud.minimapDraw(r.minimapDots);
}

// ---------------------------------------------------------------------
// Boot + loop
// ---------------------------------------------------------------------
// --- perf overlay (F): frame time avg/worst, draw calls, triangles ---
const perf = { on: false, el: null, frames: 0, accum: 0, worst: 0, nextAt: 0 };
function togglePerf() {
  perf.on = !perf.on;
  if (!perf.el) {
    perf.el = document.createElement("div");
    perf.el.style.cssText =
      "position:fixed;top:8px;left:8px;z-index:99;background:rgba(0,0,0,.65);color:#8f8;" +
      "font:12px/1.5 monospace;padding:6px 9px;border-radius:6px;pointer-events:none;white-space:pre";
    document.body.appendChild(perf.el);
  }
  perf.el.style.display = perf.on ? "block" : "none";
  perf.frames = 0; perf.accum = 0; perf.worst = 0; perf.nextAt = 0;
}
// `raw` is the unclamped frame delta — the 50 ms sim clamp would hide
// exactly the spikes this exists to expose.
function perfSample(now, raw) {
  perf.frames++; perf.accum += raw; perf.worst = Math.max(perf.worst, raw);
  if (now < perf.nextAt) return;
  const avg = perf.accum / Math.max(1, perf.frames);
  const info = renderer.info.render;
  let cull = "";
  if (race) {
    let cv = 0, bv = 0;
    for (const m of race.staticBatches) if (m.visible) cv++;
    for (const b of race.billboards) if (b.visible) bv++;
    cull = `\ndd ${CONFIG.render.drawDistance}m  chunks ${cv}/${race.staticBatches.length}  sprites ${bv}/${race.billboards.length}`;
  }
  const cv2 = renderer.domElement;
  cull += `\nres ${cv2.width}x${cv2.height}`;
  perf.el.textContent =
    `${(1 / avg).toFixed(0).padStart(3)} fps  avg ${(avg * 1000).toFixed(1)}ms  worst ${(perf.worst * 1000).toFixed(1)}ms\n` +
    `${info.calls} draw calls  ${(info.triangles / 1000).toFixed(0)}k tris` + cull;
  perf.frames = 0; perf.accum = 0; perf.worst = 0;
  perf.nextAt = now + 500;
}

// `now` is the vsync-aligned rAF timestamp from setAnimationLoop — NOT
// performance.now() read inside the callback. Frames are PRESENTED on the
// vsync grid, so the sim must advance by grid deltas; wall-clock-at-callback
// adds scheduling noise (GC, compositor) to dt, which moves the car unevenly
// between evenly-presented frames — whole-scene jitter that scales with speed.
function tick(now = performance.now()) {
  applyRenderSize(); // no-op unless window or internal-res slider changed
  applyTextureFiltering(); // no-op unless the PS1-textures toggle changed
  const raw = Math.max(0, (now - lastTime) / 1000);
  const dt = Math.min(0.05, raw);
  lastTime = now;
  if (race && !paused) step(now, dt);
  renderer.render(scene, camera);
  if (perf.on) perfSample(now, raw);
}

async function init() {
  hud.setLoading(true, "LOADING&hellip;");
  try {
    const [, discovered, profiles] = await Promise.all([preloadAssets(), loadLevels(), loadCarProfiles()]);
    allTracks = [...TRACKS, ...discovered]; // loadLevels() never rejects (see levels.js) — a broken levels/ folder just contributes nothing
    carProfiles = profiles; // same never-throws contract as loadLevels() — see carProfiles.js
    // Auto-discovered cars (placeholders.js's discoverCarModels) only exist
    // in ASSETS.carModels once preloadAssets() above resolves — the module-
    // level selectedCarId guess ran before that, so redo it now the full
    // list (and thus a saved preference for a discovered-only car) is in.
    selectedCarId = loadSelectedCarId();
    await setPlayerCar(selectedCarId);
  } catch (err) {
    console.error(err);
    hud.setLoading(true, "Failed to load the car model.<br><small>Serve this folder over HTTP, e.g. <code>python3 -m http.server</code></small>");
    return;
  }
  hud.setLoading(false);
  applyRenderSize();

  // Dev shortcut: ?track=<id or index> skips the menu.
  const auto = new URLSearchParams(location.search).get("track");
  const autoDef = auto != null ? allTracks.find((t) => t.id === auto) ?? allTracks[Number(auto)] : null;
  if (autoDef) startRace(autoDef);
  else showMenu();

  renderer.setAnimationLoop(tick);
}

init();
