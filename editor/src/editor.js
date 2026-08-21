// =====================================================================
// Standalone track editor: draw the main track spline (closed, with real
// elevation) plus any number of free-standing extra splines (open or
// closed — see the Splines panel), place trackside objects on any of them
// via automatic rule "bands" or one-off "points", tune theme/terrain,
// export the result as a track-definition JSON to paste into tracks.js.
//
// Deliberately reuses the exact same generation functions the real race
// uses (buildTrack / applyTheme / buildEnvironment / buildAllTrackObjects)
// so the editor preview can never drift from what actually races.
// =====================================================================

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { buildTrack } from "../../shared/src/track.js";
import { buildSpline } from "../../shared/src/spline.js";
import { buildEnvironment, applyTheme, mulberry32, hashSeed, sunDirection, buildSunVisual, applySunVisual, buildSkyDome, applySkyDome, DEFAULT_SUN_AZIMUTH_DEG, DEFAULT_SUN_ELEVATION_DEG, DEFAULT_SUN_VISUAL_DISTANCE } from "../../shared/src/environment.js";
import { buildAllTrackObjects, buildTrackObjects, defaultBands, OBJECT_TYPES, updateOceanTime } from "../../shared/src/trackObjects.js";
import { preloadAssets, updateCrowdBillboard } from "../../shared/src/placeholders.js";

const round2 = (n) => Math.round(n * 100) / 100;
const isTyping = (e) => e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");

// ---------------------------------------------------------------------
// Renderer / scene / lights / camera
// ---------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.domElement.classList.add("game");
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1500);
camera.position.set(0, 70, 100);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;
controls.target.set(0, 0, 0);

// ---------------------------------------------------------------------
// Transform gizmo (Object tab's Select/Transform mode). r160's
// TransformControls is itself an Object3D (later three versions split a
// separate getHelper()), so it's added to the scene directly. 'objectChange'
// fires continuously during a drag — see syncGizmoToData below.
// ---------------------------------------------------------------------
const transformControls = new TransformControls(camera, renderer.domElement);
scene.add(transformControls);
let gizmoWasDragging = false; // consumed once by the pointerup right after a gizmo drag ends, so it isn't also treated as a click
transformControls.addEventListener("dragging-changed", (e) => {
  controls.enabled = !e.value;
  if (e.value) gizmoWasDragging = true;
  else refreshPointList(); // drag just ended — one full re-render now (not every drag frame, see syncGizmoToData)
});
transformControls.addEventListener("objectChange", () => syncGizmoToData());

// ---------------------------------------------------------------------
// WASD/QE fly — keyboard translation since orbit alone can't reach an
// arbitrary spot on a large track. WASD pans in the camera's yawed
// direction (pitch ignored, Minecraft-creative-flight style); Q/E move
// world-space up/down; Shift boosts speed. Moves camera.position AND
// controls.target by the same delta so mouse-orbit keeps pivoting around a
// sensible point afterward (OrbitControls recomputes its offset from
// camera.position each update()).
// ---------------------------------------------------------------------
const FLY_KEYS = { KeyW: "fwd", KeyS: "back", KeyA: "left", KeyD: "right", KeyQ: "up", KeyE: "down" };
const flyState = { fwd: false, back: false, left: false, right: false, up: false, down: false };
let flyBoost = false;

window.addEventListener("keydown", (e) => {
  if (isTyping(e)) return;
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") flyBoost = true;
  const k = FLY_KEYS[e.code];
  if (k) flyState[k] = true;
});
window.addEventListener("keyup", (e) => {
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") flyBoost = false;
  const k = FLY_KEYS[e.code];
  if (k) flyState[k] = false;
});
// Lose focus (alt-tab, clicking outside) mid-press would otherwise leave a
// key "stuck" down since no keyup ever fires.
window.addEventListener("blur", () => {
  for (const k of Object.keys(flyState)) flyState[k] = false;
  flyBoost = false;
});

const FLY_SPEED = 30; // m/s, x3 with Shift
const _flyFwd = new THREE.Vector3(), _flyRight = new THREE.Vector3(), _flyDelta = new THREE.Vector3();

function updateFlyCamera(dt) {
  const { fwd, back, left, right, up, down } = flyState;
  if (!(fwd || back || left || right || up || down)) return;
  _flyFwd.setFromMatrixColumn(camera.matrixWorld, 2).negate(); // camera looks down local -Z
  _flyFwd.y = 0;
  if (_flyFwd.lengthSq() > 1e-6) _flyFwd.normalize(); else _flyFwd.set(0, 0, 0);
  _flyRight.setFromMatrixColumn(camera.matrixWorld, 0);
  _flyRight.y = 0;
  if (_flyRight.lengthSq() > 1e-6) _flyRight.normalize(); else _flyRight.set(0, 0, 0);

  const speed = FLY_SPEED * (flyBoost ? 3 : 1) * dt;
  _flyDelta.set(0, 0, 0);
  if (fwd) _flyDelta.addScaledVector(_flyFwd, speed);
  if (back) _flyDelta.addScaledVector(_flyFwd, -speed);
  if (right) _flyDelta.addScaledVector(_flyRight, speed);
  if (left) _flyDelta.addScaledVector(_flyRight, -speed);
  if (up) _flyDelta.y += speed;
  if (down) _flyDelta.y -= speed;

  camera.position.add(_flyDelta);
  controls.target.add(_flyDelta);
}

const hemi = new THREE.HemisphereLight(0xffffff, 0x445533, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
sun.position.set(30, 70, -20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -90;
sun.shadow.camera.right = 90;
sun.shadow.camera.top = 90;
sun.shadow.camera.bottom = -90;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 300;
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

// Visible sun disc — shares its build/appearance code with the game
// (shared/src/environment.js) so what an author sees here while aiming the
// sun is what actually ships, not a hand-rolled editor-only approximation.
// Real depth test (not disabled) on purpose: occluding behind a building or
// tunnel here is the same thing that'll happen in-game, and that's exactly
// what "parity" needs — use the "Look at Sun" button to reframe on it.
const sunVisual = buildSunVisual();
scene.add(sunVisual);

// Sky glow dome — same shared effect as the game, so the sunset-sky look an
// author dials in here is exactly what ships.
const skyDome = buildSkyDome();
scene.add(skyDome);

function trackCenter() {
  const c = new THREE.Vector3();
  if (!track) return c;
  for (const s of track.samples) c.add(s.p);
  c.divideScalar(track.samples.length);
  return c;
}

// Repositions the real light from def.theme's sunAzimuthDeg/sunElevationDeg
// and refreshes the sky dome's colors — called on slider drag (live, no
// full Generate needed) and once per rebuild(). The visible sun disc's
// position is kept centered on the camera every frame instead (tick(),
// below) — a real sun doesn't parallax as the camera orbits.
function updateSunFromTheme() {
  if (!track || !def) return;
  const c = trackCenter();
  sun.target.position.copy(c);
  const dir = sunDirection(def.theme);
  const previewDist = 100; // editor shadow camera is a fixed +-90 box, not per-track fit like main.js
  sun.position.set(c.x + dir.x * previewDist, dir.y * previewDist, c.z + dir.z * previewDist);
  renderer.shadowMap.needsUpdate = true;
  applySkyDome(skyDome, def.theme);
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------
// Track definition state
// ---------------------------------------------------------------------
const STORE_KEY = "pgp-editor-draft";

function freshDef() {
  return {
    id: "new-track",
    name: "New Track",
    desc: "",
    laps: 3,
    width: 9,
    medalAvgSpeed: { gold: 12, silver: 10.5, bronze: 9 },
    theme: {
      sky: 0x87ceeb, fog: 0x9cc7de, fogNear: 70, fogFar: 340,
      ground: "#4c7a3f", hill: 0x50694a, terrain: "grass",
      sun: 0xfff4e0, sunIntensity: 2.2, hemiIntensity: 0.9,
      sunAzimuthDeg: DEFAULT_SUN_AZIMUTH_DEG, sunElevationDeg: DEFAULT_SUN_ELEVATION_DEG,
      props: { trees: 60, rocks: 12, billboards: 4 },
    },
    controlPoints: [
      [0, 0, -40], [40, 0, -40], [40, 8, 0], [40, 0, 40],
      [0, 0, 40], [-40, 0, 20], [-40, 0, -20],
    ],
    extraSplines: [],
  };
}

function normalizeDef(d) {
  d.theme ??= {};
  d.theme.sunAzimuthDeg ??= DEFAULT_SUN_AZIMUTH_DEG;
  d.theme.sunElevationDeg ??= DEFAULT_SUN_ELEVATION_DEG;
  d.theme.props ??= {};
  d.theme.props.trees ??= 60;
  d.theme.props.rocks ??= 12;
  d.theme.props.billboards ??= 4;
  d.medalAvgSpeed ??= { gold: 12, silver: 10.5, bronze: 9 };
  d.laps ??= 3;
  d.width ??= 9;
  d.desc ??= "";
  d.extraSplines ??= [];
  for (const ex of d.extraSplines) {
    ex.closed = !!ex.closed;
    ex.trackObjects ??= {};
    ex.trackObjects.bands ??= [];
    ex.trackObjects.points ??= [];
  }
  return d;
}

function validateDef(d) {
  if (!d || typeof d !== "object") return "Not a JSON object.";
  if (!Array.isArray(d.controlPoints) || d.controlPoints.length < 3)
    return "controlPoints must be an array of at least 3 [x, y, z] points.";
  for (const p of d.controlPoints) {
    if (!Array.isArray(p) || p.length !== 3 || p.some((n) => typeof n !== "number" || !isFinite(n)))
      return "Every control point must be [x, y, z] numbers.";
  }
  if (typeof d.width !== "number" || d.width <= 0) return "width must be a positive number.";
  if (d.extraSplines !== undefined) {
    if (!Array.isArray(d.extraSplines)) return "extraSplines must be an array.";
    for (const ex of d.extraSplines) {
      const min = ex.closed ? 3 : 2;
      if (!Array.isArray(ex.controlPoints) || ex.controlPoints.length < min)
        return `Each extraSpline needs at least ${min} [x, y, z] points (closed=${!!ex.closed}).`;
    }
  }
  return null;
}

function saveDraft() {
  localStorage.setItem(STORE_KEY, JSON.stringify(def));
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupted draft — ignore */ }
  return null;
}

let def = null;
let track = null, env = null, objects = null, guideLines = null, billboards = [], waterMeshes = [];
let markers = [], contextMarkers = [];
let selected = -1; // index into the active spline's own controlPoints (Splines tab)
let paletteType = "barrier";
let dirty = true;
let activeSplineId = "main"; // "main" or an extraSplines[].id

// Splines tab and Object tab are independent concerns (see editor.html's
// two data-tab panels) with their own mode state — replaces what used to
// be one flat "select"|"addPoint"|"placeObject" mode variable.
let activeTab = "splines"; // "splines" | "object"
let splineMode = "select"; // "select" | "addPoint" — spline control points
let objectMode = "place"; // "place" | "select" — placed object instances
let selectedPointRef = null; // { splineId, index } into that spline's trackObjects.points — Object tab's Select/Transform
let gizmoMode = "translate"; // "translate" | "rotate" | "scale"
const genBtn = document.getElementById("generateBtn");
genBtn.addEventListener("click", () => rebuild());

// ---------------------------------------------------------------------
// Which spline is being edited right now — drives point add/select/drag/
// delete, the Bands/Points panel, and default offsets. "Main Track" is
// always spline "main"; anything else is an entry in def.extraSplines.
// ---------------------------------------------------------------------
function getExtraSpline(id) {
  return def.extraSplines.find((s) => s.id === id);
}
function activeSplineData() {
  return activeSplineId === "main" ? null : getExtraSpline(activeSplineId);
}
function currentPoints() {
  const ex = activeSplineData();
  return ex ? ex.controlPoints : def.controlPoints;
}
function currentTrackObjects() {
  const ex = activeSplineData();
  return ex ? ex.trackObjects : def.trackObjects;
}
function currentMinPoints() {
  if (activeSplineId === "main") return 3;
  const ex = activeSplineData();
  return ex && ex.closed ? 3 : 2;
}
// A spline-like { samples, length, posAt, query } for whichever spline is
// active — `track` already has this shape (plus road-only extras), and a
// fresh buildSpline() call is cheap enough to redo per-click for an extra
// spline (no textures/geometry, just point math), so no caching needed.
function activeSplineHandle() {
  if (activeSplineId === "main") return track;
  const ex = activeSplineData();
  if (!ex || ex.controlPoints.length < 2) return null;
  return buildSpline(ex.controlPoints, !!ex.closed, 200);
}

// ---------------------------------------------------------------------
// Rebuild: dispose the previous generated groups and call the exact same
// pipeline the race uses. Editing the spline/objects/theme only marks
// `dirty` (cheap) — the scene regenerates when Generate is clicked, not on
// every drag frame or keystroke.
// ---------------------------------------------------------------------
function disposeDeep(root) {
  root.traverse((o) => {
    // Barrier/apexKerb assets are cached module-level singletons shared
    // across every instance and every rebuild — skip disposing them.
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

// Thin editor-only guide line per extra spline (not part of
// buildAllTrackObjects's output — nothing like it races) so its path stays
// visible even between edits to its own points. Highlights the active one.
function rebuildGuideLines() {
  if (guideLines) { scene.remove(guideLines); disposeDeep(guideLines); }
  guideLines = new THREE.Group();
  for (const ex of def.extraSplines) {
    if (!ex.controlPoints || ex.controlPoints.length < 2) continue;
    const spline = buildSpline(ex.controlPoints, !!ex.closed, 150);
    const pts = spline.samples.map((s) => s.p.clone());
    if (ex.closed) pts.push(pts[0].clone());
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    // Same always-on-top treatment as the markers (see MARKER_RENDER_ORDER's
    // comment, including why transparent: true is required) — a guide line
    // buried under terrain/objects would defeat the point of having it
    // visible while editing.
    const mat = new THREE.LineBasicMaterial({ color: ex.id === activeSplineId ? 0xffcc33 : 0x6d92c9, depthTest: false, depthWrite: false, transparent: true });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = MARKER_RENDER_ORDER;
    line.userData.splineId = ex.id;
    guideLines.add(line);
  }
  scene.add(guideLines);
}

function rebuild() {
  if (track) { scene.remove(track.group); disposeDeep(track.group); }
  if (env) { scene.remove(env); disposeDeep(env); }
  if (objects) {
    transformControls.detach(); // about to dispose whatever it's attached to — re-attach to the regenerated instance below
    scene.remove(objects);
    disposeDeep(objects);
  }

  track = buildTrack(def);
  scene.add(track.group);
  applyTheme(def.theme, scene, sun, hemi);

  // Materialize the resolved defaults once so they show up as real,
  // editable rows instead of invisible fallback logic.
  let firstTimeObjects = false;
  if (!def.trackObjects) {
    def.trackObjects = { bands: defaultBands(track), points: [] };
    firstTimeObjects = true;
  }
  def.trackObjects.points ??= [];
  def.trackObjects.bands ??= [];

  const rng = mulberry32(hashSeed(def.id || "untitled"));
  env = buildEnvironment(def, track, rng);
  scene.add(env);
  ({ group: objects, billboards, waterMeshes } = buildAllTrackObjects(def, track, rng));
  scene.add(objects);
  rebuildGuideLines();

  // The previous `objects` (and whatever the gizmo was attached to inside
  // it) was just disposed above — re-find the regenerated instance by its
  // stable { splineId, index } identity and re-attach, or clear the
  // selection if the point/spline it referred to doesn't exist anymore
  // (deleted while selected).
  if (selectedPointRef) {
    const obj = findObjectByRef(selectedPointRef.splineId, selectedPointRef.index);
    if (obj) transformControls.attach(obj);
    else deselectObject();
  }

  updateSunFromTheme();

  dirty = false;
  genBtn.classList.remove("pending");
  saveDraft();
  // Only refresh the list DOM on structural changes (materializing
  // defaults for the first time) — NOT on every rebuild, since rebuild()
  // can follow many small field edits and re-rendering the list innerHTML
  // would steal focus from whatever field the user is editing.
  if (firstTimeObjects) {
    refreshBandList();
    refreshPointList();
  }
}

// Rebuilding calls buildTrack + buildEnvironment + buildAllTrackObjects, which
// used to run every time anything changed (every drag frame, every
// keystroke) — regenerating the deformed ground grid and every barrier/kerb
// instance from scratch made editing feel sluggish. Edits now just mark
// dirty (cheap); the 3D scene only regenerates when Generate is pressed.
//
// `label` groups a burst of rapid edits into ONE undo step — see recordEdit.
// Pass a stable string for anything continuous (a marker drag, a slider);
// one-shot edits can leave it off.
function markDirty(label) {
  dirty = true;
  genBtn.classList.add("pending");
  recordEdit(label ?? "edit");
}

// ---------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------
// The entire editable state is `def`, a plain JSON object, so history is
// just a stack of serialized snapshots — no per-action inverse operations
// to write or keep in sync as new edit types are added. Restoring is
// loadDef(), which already does a full swap + rebuild for Apply/Load.
//
// markDirty() fires per pointermove during a drag and per keystroke in a
// field, so snapshotting on every call would make one undo step per pixel.
// Instead edits coalesce into a "burst": the first edit of a burst pushes
// the pre-edit state, subsequent edits carrying the same label within
// BURST_MS fold into it, and a different label (or the timer, or pointerup)
// closes it. That makes one drag or one field edit exactly one undo step.
//
// snapshot() is only called at burst boundaries, never mid-burst, so a
// drag doesn't re-serialize a large def every frame.
const UNDO_LIMIT = 80;   // snapshots; a big def is ~1 MB of JSON, so cap the stack
const BURST_MS = 450;    // quiet time that closes an edit burst

let undoStack = [], redoStack = [];
let baseline = null;     // serialized def as of the last checkpoint — what "undo now" returns to
let burstLabel = null, burstPushed = false, burstTimer = 0;
let restoring = false;   // guards markDirty() re-entry while a snapshot is being applied

const snapshot = () => JSON.stringify(def);

function closeBurst() {
  if (burstTimer) { clearTimeout(burstTimer); burstTimer = 0; }
  if (burstLabel === null) return;
  burstLabel = null;
  burstPushed = false;
  baseline = snapshot();
}

function recordEdit(label) {
  if (restoring || baseline === null) return;
  if (burstLabel !== null && burstLabel !== label) closeBurst();
  if (burstLabel === null) { burstLabel = label; burstPushed = false; }
  // Not yet pushed for this burst: capture the pre-burst state. Checked on
  // every call (not just the first) so a burst that opens with a no-op edit
  // — a colour input re-firing with an unchanged value — still records the
  // real change that follows it.
  if (!burstPushed && baseline !== snapshot()) {
    undoStack.push(baseline);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
    burstPushed = true;
    updateHistoryButtons();
  }
  clearTimeout(burstTimer);
  burstTimer = setTimeout(closeBurst, BURST_MS);
}

// Called before a wholesale state swap (Apply / Load file / New track) so
// those are undoable too — "New track" is otherwise an unrecoverable wipe.
function historyCheckpoint() {
  closeBurst();
  undoStack.push(snapshot());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

function applySnapshot(json) {
  // loadDef() resets the active spline to "main"; keep the one being
  // worked on if it still exists in the restored def, so undoing an edit
  // doesn't also throw you back to the main track.
  const keepSpline = activeSplineId;
  restoring = true;
  try {
    loadDef(JSON.parse(json));
    if (keepSpline !== "main" && def.extraSplines?.some((s) => s.id === keepSpline)) setActiveSpline(keepSpline);
  } finally {
    restoring = false;
  }
  baseline = json; // loadDef set this already; keep them provably identical
  updateHistoryButtons();
}

function undo() {
  closeBurst();
  if (!undoStack.length) { msg("Nothing to undo."); return; }
  redoStack.push(snapshot());
  applySnapshot(undoStack.pop());
  msg(`Undo — ${undoStack.length} step${undoStack.length === 1 ? "" : "s"} left.`);
}

function redo() {
  closeBurst();
  if (!redoStack.length) { msg("Nothing to redo."); return; }
  undoStack.push(snapshot());
  applySnapshot(redoStack.pop());
  msg(`Redo — ${redoStack.length} step${redoStack.length === 1 ? "" : "s"} left.`);
}

const undoBtn = document.getElementById("undoBtn");
const redoBtn = document.getElementById("redoBtn");

function updateHistoryButtons() {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
  undoBtn.title = `Undo (Ctrl+Z)${undoStack.length ? ` — ${undoStack.length} step${undoStack.length === 1 ? "" : "s"}` : ""}`;
  redoBtn.title = `Redo (Ctrl+Shift+Z)${redoStack.length ? ` — ${redoStack.length} step${redoStack.length === 1 ? "" : "s"}` : ""}`;
}

undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);

window.addEventListener("keydown", (e) => {
  // Inside a text field, let the browser's own text undo have the keystroke.
  if (isTyping(e) || !(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
});

// ---------------------------------------------------------------------
// Control point markers
// ---------------------------------------------------------------------
// depthTest: false + a high renderOrder draws these on top of the whole
// scene regardless of what's in front of them in the depth buffer, so a
// spline's nodes stay visible even when other geometry would occlude them.
// depthWrite: false keeps them from punching holes for what renders after.
//
// transparent: true (even at opacity 1) is load-bearing, not decorative:
// three.js always renders its opaque queue before its transparent queue,
// full stop — renderOrder only re-sorts objects *within* whichever queue
// they land in. A handful of road-surface textures (e.g. "expressway",
// "tunnelAsphalt") carry a hair of alpha so they can sit as lifted decals
// over the base road without z-fighting, which makes their material
// `transparent: true` — so without this, that deck geometry (opaque-queue
// markers vs. transparent-queue road) would silently paint over the
// markers regardless of depthTest/renderOrder. Marking markers transparent
// too puts them in the same queue, where renderOrder actually wins.
const MARKER_RENDER_ORDER = 999;
const markerGeo = new THREE.SphereGeometry(1.1, 16, 12);
const matNormal = new THREE.MeshBasicMaterial({ color: 0x4da6ff, depthTest: false, depthWrite: false, transparent: true });
const matStart = new THREE.MeshBasicMaterial({ color: 0x6dfa8f, depthTest: false, depthWrite: false, transparent: true });
const matSelected = new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false, depthWrite: false, transparent: true });
const matContext = new THREE.MeshBasicMaterial({ color: 0x555a63, depthTest: false, depthWrite: false, transparent: true });

// The active spline's points stay interactive (bright, draggable, in the
// `markers` array pickMarker raycasts against); every other spline's points
// render dim and non-interactive in `contextMarkers` (visual layout only)
// so the whole scene stays visible while editing just one spline at a time.
function refreshMarkers() {
  for (const m of markers) scene.remove(m);
  for (const m of contextMarkers) scene.remove(m);

  markers = currentPoints().map((p, i) => {
    const mesh = new THREE.Mesh(markerGeo, i === 0 ? matStart : matNormal);
    mesh.position.set(p[0], p[1] ?? 0, p[2]);
    mesh.userData.index = i;
    mesh.renderOrder = MARKER_RENDER_ORDER;
    scene.add(mesh);
    return mesh;
  });
  updateMarkerColors();

  contextMarkers = [];
  const addContext = (points) => {
    for (const p of points) {
      const mesh = new THREE.Mesh(markerGeo, matContext);
      mesh.position.set(p[0], p[1] ?? 0, p[2]);
      mesh.renderOrder = MARKER_RENDER_ORDER;
      mesh.scale.setScalar(0.55);
      scene.add(mesh);
      contextMarkers.push(mesh);
    }
  };
  if (activeSplineId !== "main") addContext(def.controlPoints);
  for (const ex of def.extraSplines) {
    if (ex.id !== activeSplineId) addContext(ex.controlPoints);
  }
}

function updateMarkerColors() {
  markers.forEach((m, i) => {
    m.material = i === selected ? matSelected : i === 0 ? matStart : matNormal;
  });
}

// ---------------------------------------------------------------------
// Raycasting / pointer interaction
// ---------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
raycaster.params.Line.threshold = 2; // generous — lets clicks near an extra spline's thin guide line register
const mouseNDC = new THREE.Vector2();

function setMouseNDC(e) {
  const r = renderer.domElement.getBoundingClientRect();
  mouseNDC.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  mouseNDC.y = -((e.clientY - r.top) / r.height) * 2 + 1;
}

// Horizontal plane at a fixed y — used while dragging an existing marker
// (so it only moves in x/z at its current elevation).
function pickPlane(e, y) {
  setMouseNDC(e);
  raycaster.setFromCamera(mouseNDC, camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
  const out = new THREE.Vector3();
  return raycaster.ray.intersectPlane(plane, out) ? out : null;
}

// Prefers the active spline's own surface (road mesh, or its guide line —
// both elevation-exact); falls back to a flat plane off in open ground, or
// for a brand-new extra spline with no guide line rendered yet.
function pickWorld(e, fallbackY) {
  setMouseNDC(e);
  raycaster.setFromCamera(mouseNDC, camera);
  const preferred = activeSplineId === "main" ? track?.group : guideLines;
  if (preferred) {
    const hits = raycaster.intersectObject(preferred, true);
    if (hits.length) return hits[0].point;
  }
  return pickPlane(e, fallbackY);
}

function pickMarker(e) {
  setMouseNDC(e);
  raycaster.setFromCamera(mouseNDC, camera);
  const hits = raycaster.intersectObjects(markers);
  return hits.length ? hits[0].object.userData.index : -1;
}

// Which spline (if any) the click landed near — guide lines checked first
// (deliberately-drawn paths), then the main track's road surface.
function pickSplineNear(e) {
  setMouseNDC(e);
  raycaster.setFromCamera(mouseNDC, camera);
  if (guideLines) {
    const hits = raycaster.intersectObject(guideLines, true);
    if (hits.length && hits[0].object.userData.splineId) return hits[0].object.userData.splineId;
  }
  if (track?.group && raycaster.intersectObject(track.group, true).length) return "main";
  return null;
}

function addPointToActiveSpline(e) {
  const pts = currentPoints();
  const lastY = pts.length ? pts[pts.length - 1][1] ?? 0 : 0;
  const hit = pickWorld(e, lastY);
  if (hit) {
    pts.push([round2(hit.x), round2(hit.y), round2(hit.z)]);
    refreshMarkers();
    markDirty();
  }
}

let downX = 0, downY = 0, downIndex = -1, isMarkerDrag = false;

renderer.domElement.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  downX = e.clientX;
  downY = e.clientY;
  downIndex = activeTab === "splines" && splineMode === "select" ? pickMarker(e) : -1;
  if (downIndex >= 0) {
    isMarkerDrag = true;
    controls.enabled = false;
  }
});

renderer.domElement.addEventListener("pointermove", (e) => {
  if (!isMarkerDrag || downIndex < 0) return;
  const pts = currentPoints();
  const y = pts[downIndex][1] ?? 0;
  const hit = pickPlane(e, y);
  if (!hit) return;
  pts[downIndex][0] = hit.x;
  pts[downIndex][2] = hit.z;
  markers[downIndex].position.set(hit.x, y, hit.z);
  if (downIndex === selected) syncInspectorFields();
  markDirty(`drag-point:${activeSplineId}:${downIndex}`);
});

// Object tab's Select/Transform mode: which placed object (if any) is under
// the pointer. Raycasts the whole `objects` group and walks up from the hit
// mesh to the first ancestor trackObjects.js tagged — points carry
// userData.pointIndex (individually transformable via gizmo), band-placed
// instances carry userData.bandIndex (no per-instance transform exists, so
// clicking one selects its band row in the Splines tab instead).
function pickPlacedObject(e) {
  if (!objects) return null;
  setMouseNDC(e);
  raycaster.setFromCamera(mouseNDC, camera);
  const hits = raycaster.intersectObject(objects, true);
  for (const h of hits) {
    // Cutout/billboard quads are mostly transparent — a hit on a see-through
    // pixel falls through to whatever's behind, so clicks land on what the
    // user actually sees, not an invisible plane in front of it.
    const mat = h.object.material;
    if (h.uv && mat?.map && mat.transparent && !Array.isArray(mat) && textureAlphaAt(mat.map, h.uv) < 0.4) continue;
    let o = h.object;
    while (o && o.userData.pointIndex == null && o.userData.bandIndex == null) o = o.parent;
    if (o) return o;
  }
  return null;
}

// CPU-side alpha lookup for pickPlacedObject — one ImageData readback per
// unique texture (canvas or loaded image), cached for the session.
const _alphaCache = new Map();
function textureAlphaAt(map, uv) {
  let entry = _alphaCache.get(map.uuid);
  if (entry === undefined) {
    try {
      const img = map.image;
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      entry = { data: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
    } catch {
      entry = null; // unreadable (shouldn't happen for same-origin assets) — treat as opaque
    }
    _alphaCache.set(map.uuid, entry);
  }
  if (!entry) return 1;
  const x = Math.min(entry.w - 1, Math.max(0, Math.floor(uv.x * entry.w)));
  const y = Math.min(entry.h - 1, Math.max(0, Math.floor((1 - uv.y) * entry.h))); // flipY: uv origin is bottom-left, canvas is top-left
  return entry.data[(y * entry.w + x) * 4 + 3] / 255;
}

window.addEventListener("pointerup", (e) => {
  closeBurst(); // a drag/click just ended — the next edit starts a fresh undo step
  if (gizmoWasDragging) {
    // TransformControls' own pointerup (registered first, so it runs first)
    // already reset dragging by now — this flag is what tells us this
    // release ended a gizmo drag, so it isn't also treated as a click below.
    gizmoWasDragging = false;
    isMarkerDrag = false;
    downIndex = -1;
    controls.enabled = true;
    return;
  }
  const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
  if (isMarkerDrag) {
    selected = downIndex;
    updateMarkerColors();
    showInspector(true);
    syncInspectorFields();
  } else if (moved < 6) {
    if (e.shiftKey) {
      // Shift+click adds a point to whichever spline is already active,
      // regardless of tab/mode — a shortcut so you don't have to switch
      // into Add Point mode just to extend the spline you're working on.
      addPointToActiveSpline(e);
    } else if (activeTab === "splines" && splineMode === "addPoint") {
      addPointToActiveSpline(e);
    } else if (activeTab === "splines" && splineMode === "select") {
      const idx = pickMarker(e);
      if (idx >= 0) {
        selected = idx;
        updateMarkerColors();
        showInspector(true);
        syncInspectorFields();
      } else {
        // No marker hit — a band-placed instance (crowd figure, lamp, wall
        // ribbon…) selects its band row right here in the Splines tab, so
        // repeat band clicks work without hopping back to the Object tab.
        // Failing that, clicking near a spline's own path (line or road)
        // makes it the active spline, same as picking "Select" in the
        // Splines panel. Falls through to a plain deselect if the click
        // wasn't near any of those.
        const bandObj = pickPlacedObject(e);
        const hitId = bandObj?.userData.bandIndex == null ? pickSplineNear(e) : null;
        if (bandObj && bandObj.userData.bandIndex != null) {
          selectBandRow(bandObj.userData.splineId, bandObj.userData.bandIndex);
        } else if (hitId && hitId !== activeSplineId) {
          setActiveSpline(hitId);
        } else {
          selected = -1;
          updateMarkerColors();
          showInspector(false);
          clearBandSelection();
        }
      }
    } else if (activeTab === "object" && objectMode === "place") {
      if (OBJECT_TYPES[paletteType]?.ribbon) {
        msg("Spline types are band-only — add one under Bands instead.");
        return;
      }
      const handle = activeSplineHandle();
      if (!handle) return;
      const hit = pickWorld(e, 0);
      if (hit) {
        const q = handle.query(new THREE.Vector3(hit.x, 0, hit.z));
        const s = handle.samples[q.idx].arc;
        const side = q.lateral >= 0 ? "left" : "right";
        const offset = Math.max(0.1, Math.abs(q.lateral));
        currentTrackObjects().points.push({ type: paletteType, s: round2(s), side, offset: round2(offset), rotation: 0, conform: true });
        refreshPointList();
        markDirty();
      }
    } else if (activeTab === "object" && objectMode === "select") {
      const obj = pickPlacedObject(e);
      if (obj && obj.userData.pointIndex != null) selectObject(obj);
      else if (obj) selectBandRow(obj.userData.splineId, obj.userData.bandIndex);
      else { deselectObject(); clearBandSelection(); }
    }
  }
  isMarkerDrag = false;
  downIndex = -1;
  controls.enabled = true;
});

window.addEventListener("keydown", (e) => {
  if (isTyping(e)) return;
  if (e.code !== "Delete" && e.code !== "Backspace") return;
  if (activeTab === "splines" && selected >= 0 && currentPoints().length > currentMinPoints()) {
    e.preventDefault();
    currentPoints().splice(selected, 1);
    selected = -1;
    showInspector(false);
    refreshMarkers();
    markDirty();
  } else if (activeTab === "object" && selectedPointRef) {
    e.preventDefault();
    currentTrackObjects().points.splice(selectedPointRef.index, 1);
    deselectObject();
    refreshPointList();
    markDirty();
  }
});

// ---------------------------------------------------------------------
// Object tab: selecting/deselecting a placed object and syncing the
// transform gizmo's live drag back into its trackObjects.points entry.
// ---------------------------------------------------------------------
const gizmoBox = document.getElementById("gizmoBox");
const gizmoHint = document.getElementById("gizmoHint");
const rotateGizmoBtn = document.querySelector('[data-gizmo="rotate"]');

function selectObject(obj) {
  clearBandSelection(); // a point selection replaces any highlighted band row
  const { splineId, pointIndex } = obj.userData;
  if (splineId !== activeSplineId) setActiveSpline(splineId); // also refreshes Points list for that spline
  selectedPointRef = { splineId, index: pointIndex };
  transformControls.attach(obj);
  gizmoBox.classList.remove("hidden");
  const pt = currentTrackObjects().points[pointIndex];
  const isBillboard = !!OBJECT_TYPES[pt?.type]?.billboard;
  // Billboards face the camera every frame (see tick()'s billboard loop),
  // which overwrites any rotation the gizmo would set — hide the handle
  // that would otherwise silently do nothing.
  rotateGizmoBtn.classList.toggle("hidden", isBillboard);
  if (isBillboard && gizmoMode === "rotate") setGizmoMode("translate");
  gizmoHint.textContent = OBJECT_TYPES[pt?.type]?.label ?? "";
  highlightSelectedPointRow();
}

function deselectObject() {
  selectedPointRef = null;
  transformControls.detach();
  gizmoBox.classList.add("hidden");
  highlightSelectedPointRow();
}

// Band instances have no per-instance transform to gizmo — clicking one
// jumps to the band row that generated it (Splines tab), highlighted and
// scrolled into view, so tweaking offset/spacing/range doesn't start with
// hunting through the list for the right rule.
let selectedBandRef = null; // { splineId, index } into that spline's trackObjects.bands

function selectBandRow(splineId, index) {
  deselectObject();
  if (splineId !== activeSplineId) setActiveSpline(splineId); // also re-renders the band list
  selectedBandRef = { splineId, index };
  setActiveTab("splines"); // band rows live in the Splines tab's Bands panel
  highlightSelectedBandRow();
  const band = currentTrackObjects()?.bands?.[index];
  msg(`Band #${index + 1} — ${OBJECT_TYPES[band?.type]?.label ?? band?.type ?? "?"}`);
}

function clearBandSelection() {
  selectedBandRef = null;
  highlightSelectedBandRow();
}

function highlightSelectedBandRow() {
  document.querySelectorAll("#bandList .item").forEach((row) => {
    const isSel = !!selectedBandRef && selectedBandRef.splineId === activeSplineId
      && Number(row.dataset.idx) === selectedBandRef.index;
    row.classList.toggle("selected", isSel);
    if (isSel) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

// ---------------------------------------------------------------------
// Live per-band refresh — Generate stays the full rebuild, but ONE band is
// cheap enough to re-place on every band-row input (sliders especially), so
// its instances move in the viewport as you drag. Old instances are found
// by the splineId/bandIndex tags trackObjects.js stamps for click-to-select.
// ---------------------------------------------------------------------
let _bandRefresh = null; // at most one pending refresh per animation frame
function queueBandRefresh(index) {
  const alreadyQueued = !!_bandRefresh;
  _bandRefresh = { splineId: activeSplineId, index };
  if (alreadyQueued) return;
  requestAnimationFrame(() => {
    const r = _bandRefresh;
    _bandRefresh = null;
    rebuildBandInstances(r.splineId, r.index);
  });
}

// retagAbove: after deleting row `index`, instances of later bands must slide
// their bandIndex down one so click-to-select keeps mapping to the right row.
function removeBandInstances(splineId, index, retagAbove = false) {
  if (!objects) return;
  const dead = [];
  objects.traverse((o) => {
    if (o.userData.splineId !== splineId || o.userData.bandIndex == null) return;
    if (o.userData.bandIndex === index) dead.push(o);
    else if (retagAbove && o.userData.bandIndex > index) o.userData.bandIndex--;
  });
  for (const o of dead) {
    o.parent?.remove(o);
    if (o.userData.ribbon) o.geometry?.dispose(); // ribbons own their geometry; instance types share cached geo/materials
    const bi = billboards.indexOf(o);
    if (bi >= 0) billboards.splice(bi, 1);
  }
}

function rebuildBandInstances(splineId, index) {
  if (!objects || splineId !== activeSplineId) return; // active spline changed mid-frame — Generate will catch up
  const band = currentTrackObjects()?.bands?.[index];
  const handle = activeSplineHandle();
  if (!band || !handle) return;
  removeBandInstances(splineId, index);
  const r = buildTrackObjects({ trackObjects: { bands: [band], points: [] } }, handle,
    mulberry32(hashSeed(def.id ?? "track") + index), splineId);
  r.group.traverse((o) => { if (o.userData.bandIndex != null) o.userData.bandIndex = index; }); // built alone as row 0 — restamp its real index
  objects.add(r.group);
  billboards.push(...r.billboards);
}

// Finds the live 3D instance for a { splineId, index } ref by searching the
// current `objects` tree — used both for the Points panel's per-row Select
// button and to re-attach the gizmo after a rebuild() regenerates `objects`
// from scratch (the previously-selected instance is disposed by then).
function findObjectByRef(splineId, index) {
  let found = null;
  objects?.traverse((o) => {
    if (!found && o.userData.splineId === splineId && o.userData.pointIndex === index) found = o;
  });
  return found;
}

function highlightSelectedPointRow() {
  document.querySelectorAll("#pointList .item").forEach((row) => {
    const isSel = !!selectedPointRef && Number(row.dataset.idx) === selectedPointRef.index;
    row.classList.toggle("selected", isSel);
  });
}

// Writes the gizmo-dragged transform back into its point, called every
// 'objectChange' during a drag — patches only the affected row's fields
// imperatively (same don't-rerender-every-frame principle as markDirty()
// vs rebuild(); a full re-render happens once when the drag ends).
const _yAxis = new THREE.Vector3(0, 1, 0);
const _gzPos = new THREE.Vector3(), _gzTan = new THREE.Vector3();
const _gzQBase = new THREE.Quaternion(), _gzQLocal = new THREE.Quaternion(), _gzEuler = new THREE.Euler();

function syncGizmoToData() {
  if (!selectedPointRef) return;
  const obj = transformControls.object;
  const pt = currentTrackObjects()?.points?.[selectedPointRef.index];
  const handle = activeSplineHandle();
  if (!obj || !pt || !handle) return;

  if (gizmoMode === "translate") {
    const q = handle.query(new THREE.Vector3(obj.position.x, 0, obj.position.z));
    const s = handle.samples[q.idx].arc;
    const side = q.lateral >= 0 ? "left" : "right";
    const offset = Math.max(0.1, Math.abs(q.lateral));
    handle.posAt(s, q.lateral, _gzPos); // the spline's own ground position directly under the object
    pt.s = round2(s);
    pt.side = side;
    pt.offset = round2(offset);
    pt.yOffset = round2(obj.position.y - _gzPos.y);
  } else if (gizmoMode === "scale") {
    pt.scaleX = round2(obj.scale.x);
    pt.scaleY = round2(obj.scale.y);
    pt.scaleZ = round2(obj.scale.z);
  } else if (gizmoMode === "rotate") {
    // conform bakes a full slope-following basis, not decomposable back into
    // a simple rotation — gizmo rotate and conform are alternatives, not composable.
    pt.conform = false;
    const sign = pt.side === "right" ? -1 : 1;
    handle.posAt(pt.s ?? 0, (pt.offset ?? 0) * sign, _gzPos, _gzTan);
    _gzQBase.setFromAxisAngle(_yAxis, Math.atan2(_gzTan.x, _gzTan.z));
    _gzQLocal.copy(_gzQBase).invert().multiply(obj.quaternion);
    _gzEuler.setFromQuaternion(_gzQLocal, "XYZ");
    pt.rotX = round2(_gzEuler.x);
    pt.rotY = round2(_gzEuler.y);
    pt.rotZ = round2(_gzEuler.z);
    delete pt.rotation; // stale alias (placePoint reads rotY ?? rotation ?? 0) — avoid it masking the new rotY
  }
  markDirty(`gizmo:${gizmoMode}:${selectedPointRef.splineId}:${selectedPointRef.index}`);
  updatePointRowFields(selectedPointRef.index);
}

function updatePointRowFields(idx) {
  const row = document.querySelector(`#pointList .item[data-idx="${idx}"]`);
  if (!row) return;
  const pt = currentTrackObjects().points[idx];
  const set = (f, v) => {
    const el = row.querySelector(`[data-f="${f}"]`);
    if (el && document.activeElement !== el) el.value = v;
  };
  set("side", pt.side);
  set("s", round2(pt.s ?? 0));
  set("offset", round2(pt.offset ?? 0));
  set("yOffset", round2(pt.yOffset ?? 0));
  set("scaleX", pt.scaleX ?? 1);
  set("scaleY", pt.scaleY ?? 1);
  set("scaleZ", pt.scaleZ ?? 1);
  set("rotXDeg", round2(((pt.rotX ?? 0) * 180) / Math.PI));
  set("rotYDeg", round2(((pt.rotY ?? 0) * 180) / Math.PI));
  set("rotZDeg", round2(((pt.rotZ ?? 0) * 180) / Math.PI));
  const conformChk = row.querySelector('[data-f="conform"]');
  if (conformChk && document.activeElement !== conformChk) conformChk.checked = !!pt.conform;
}

// ---------------------------------------------------------------------
// Splines list — Main Track (fixed) + any number of free-standing extra
// splines. Selecting one makes it "active": Add Point/Select-Drag/Del and
// the Bands/Points panel all operate on it (see currentPoints()/
// currentTrackObjects() above).
// ---------------------------------------------------------------------
function setActiveSpline(id) {
  activeSplineId = id;
  selected = -1;
  showInspector(false);
  refreshMarkers();
  refreshSplineList();
  refreshBandList();
  refreshPointList();
}

function deleteSpline(id) {
  if (!confirm("Delete this spline and everything placed on it?")) return;
  def.extraSplines = def.extraSplines.filter((s) => s.id !== id);
  setActiveSpline(activeSplineId === id ? "main" : activeSplineId);
  rebuild(); // structural change (like Apply/New Track) — rebuild immediately
}

function splineRowHtml(ex) {
  const active = ex.id === activeSplineId;
  return `
    <div class="item ${active ? "activeSpline" : ""}" data-id="${ex.id}">
      <div class="itemHead"><b>${active ? "● " : ""}${ex.name || ex.id}</b><button class="small danger" data-act="del">✕</button></div>
      <div class="row"><label>Name</label><input type="text" data-f="name" value="${ex.name ?? ""}"></div>
      <div class="row"><label>Shape</label><select data-f="closed">
        <option value="false" ${!ex.closed ? "selected" : ""}>Open</option>
        <option value="true" ${ex.closed ? "selected" : ""}>Closed</option>
      </select></div>
      <div class="btnRow"><button class="wide" data-act="select">${active ? "Active" : "Select"}</button></div>
    </div>`;
}

function refreshSplineList() {
  const el = document.getElementById("splineList");
  const mainActive = activeSplineId === "main";
  let html = `
    <div class="item ${mainActive ? "activeSpline" : ""}" data-id="main">
      <div class="itemHead"><b>${mainActive ? "● " : ""}Main Track</b></div>
      <div class="btnRow"><button class="wide" data-act="select">${mainActive ? "Active" : "Select"}</button></div>
    </div>`;
  html += def.extraSplines.map(splineRowHtml).join("");
  el.innerHTML = html;
  el.querySelectorAll(".item").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-act="select"]').addEventListener("click", () => setActiveSpline(id));
    const del = row.querySelector('[data-act="del"]');
    if (del) del.addEventListener("click", () => deleteSpline(id));
    row.querySelectorAll("[data-f]").forEach((input) => {
      const evt = input.tagName === "SELECT" ? "change" : "input";
      input.addEventListener(evt, () => {
        const ex = getExtraSpline(id);
        const f = input.dataset.f;
        // Name doesn't affect the 3D scene and re-rendering the list to
        // update the bolded header would steal focus mid-typing — just
        // store it silently, the header catches up on the next refresh.
        if (f === "name") ex.name = input.value;
        else if (f === "closed") { ex.closed = input.value === "true"; markDirty(); }
      });
    });
  });
}

document.getElementById("splineAdd").addEventListener("click", () => {
  // Starts with zero points — no seeded defaults to forget about and leave
  // behind. A spline needs >=2 points before anything is built (see the
  // length checks in rebuildGuideLines/buildAllTrackObjects), so nothing
  // renders until you place its first two points yourself.
  const id = "spline-" + Date.now().toString(36);
  def.extraSplines.push({
    id, name: `Spline ${def.extraSplines.length + 1}`, closed: false,
    controlPoints: [],
    trackObjects: { bands: [], points: [] },
  });
  setActiveSpline(id);
  setActiveTab("splines");
  setSplineMode("addPoint");
  msg("New spline active — click the ground to place its points.");
});

// ---------------------------------------------------------------------
// Tabs (Splines / Object) + their independent mode toolbars, + the Object
// tab's gizmo mode (Translate/Rotate/Scale) — see the module-level state
// comment above (activeTab/splineMode/objectMode/gizmoMode).
// ---------------------------------------------------------------------
const tabButtons = [...document.querySelectorAll("#editTabs .tab")];
function setActiveTab(t) {
  activeTab = t;
  if (t !== "object") deselectObject(); // the gizmo/selection only makes sense while the Object tab's own panel is showing
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
  document.querySelectorAll(".tabPanel").forEach((p) => p.classList.toggle("hidden", p.dataset.tab !== t));
}
tabButtons.forEach((b) => b.addEventListener("click", () => setActiveTab(b.dataset.tab)));

const splineModeButtons = [...document.querySelectorAll("[data-splinemode]")];
function setSplineMode(m) {
  splineMode = m;
  splineModeButtons.forEach((b) => b.classList.toggle("active", b.dataset.splinemode === m));
}
splineModeButtons.forEach((b) => b.addEventListener("click", () => setSplineMode(b.dataset.splinemode)));

const objectModeButtons = [...document.querySelectorAll("[data-objectmode]")];
function setObjectMode(m) {
  objectMode = m;
  objectModeButtons.forEach((b) => b.classList.toggle("active", b.dataset.objectmode === m));
  if (m !== "select") deselectObject(); // switching away from Select/Transform clears any gizmo selection
}
objectModeButtons.forEach((b) => b.addEventListener("click", () => setObjectMode(b.dataset.objectmode)));

const gizmoButtons = [...document.querySelectorAll("[data-gizmo]")];
function setGizmoMode(m) {
  gizmoMode = m;
  gizmoButtons.forEach((b) => b.classList.toggle("active", b.dataset.gizmo === m));
  transformControls.setMode(m);
}
gizmoButtons.forEach((b) => b.addEventListener("click", () => setGizmoMode(b.dataset.gizmo)));

// Shift cycles Translate -> Rotate -> Scale while an object is selected —
// keyboard alternative to the gizmo buttons. e.repeat guards against
// auto-repeat; scoped to selectedPointRef so it doesn't fight the WASD-fly
// Shift-boost (a separate held-state check elsewhere in this file).
const GIZMO_MODES = ["translate", "rotate", "scale"];
window.addEventListener("keydown", (e) => {
  if (isTyping(e) || e.repeat) return;
  if ((e.code !== "ShiftLeft" && e.code !== "ShiftRight") || !selectedPointRef) return;
  let next = GIZMO_MODES[(GIZMO_MODES.indexOf(gizmoMode) + 1) % GIZMO_MODES.length];
  if (next === "rotate" && rotateGizmoBtn.classList.contains("hidden")) {
    next = GIZMO_MODES[(GIZMO_MODES.indexOf(next) + 1) % GIZMO_MODES.length]; // billboard selected — skip rotate, it'd have no visible effect
  }
  setGizmoMode(next);
});

// ---------------------------------------------------------------------
// Palette (object type used by "Place Object" mode and "+ add" buttons)
// ---------------------------------------------------------------------
function buildPalette() {
  const el = document.getElementById("palette");
  el.innerHTML = "";
  for (const [key, t] of Object.entries(OBJECT_TYPES)) {
    const b = document.createElement("button");
    b.textContent = t.label;
    b.dataset.type = key;
    if (key === paletteType) b.classList.add("active");
    b.addEventListener("click", () => {
      paletteType = key;
      [...el.children].forEach((c) => c.classList.toggle("active", c.dataset.type === key));
    });
    el.appendChild(b);
  }
}

// ---------------------------------------------------------------------
// Point inspector (selected spline control point)
// ---------------------------------------------------------------------
const pointInspector = document.getElementById("pointInspector");
const pX = document.getElementById("pX"), pY = document.getElementById("pY"), pZ = document.getElementById("pZ");
const pYRange = document.getElementById("pYRange"), pDelete = document.getElementById("pDelete");

function showInspector(show) {
  pointInspector.classList.toggle("hidden", !show);
}
function syncInspectorFields() {
  const p = currentPoints()[selected];
  pX.value = p[0]; pY.value = p[1] ?? 0; pZ.value = p[2]; pYRange.value = p[1] ?? 0;
}
function wirePointInspector() {
  const apply = () => {
    if (selected < 0) return;
    const p = currentPoints()[selected];
    p[0] = Number(pX.value) || 0;
    p[1] = Number(pY.value) || 0;
    p[2] = Number(pZ.value) || 0;
    pYRange.value = p[1];
    markers[selected].position.set(p[0], p[1], p[2]);
    markDirty();
  };
  pX.addEventListener("input", apply);
  pY.addEventListener("input", apply);
  pZ.addEventListener("input", apply);
  pYRange.addEventListener("input", () => { pY.value = pYRange.value; apply(); });
  pDelete.addEventListener("click", () => {
    if (selected < 0 || currentPoints().length <= currentMinPoints()) return;
    currentPoints().splice(selected, 1);
    selected = -1;
    showInspector(false);
    refreshMarkers();
    markDirty();
  });
}

// ---------------------------------------------------------------------
// Bands list (automatic rules) + Points list (one-off placements)
// ---------------------------------------------------------------------
function typeOptions(selectedType) {
  return Object.keys(OBJECT_TYPES)
    .map((t) => `<option value="${t}" ${t === selectedType ? "selected" : ""}>${OBJECT_TYPES[t].label}</option>`)
    .join("");
}

function bandRowHtml(band, idx) {
  const sides = ["left", "right", "both"];
  return `
    <div class="item" data-idx="${idx}">
      <div class="itemHead"><b>#${idx + 1}</b><button class="small danger" data-act="del">✕</button></div>
      <div class="row"><label>Type</label><select data-f="type">${typeOptions(band.type)}</select></div>
      <div class="row"><label>Side</label><select data-f="side">${sides
        .map((s) => `<option value="${s}" ${s === band.side ? "selected" : ""}>${s}</option>`)
        .join("")}</select></div>
      <div class="row"><label>Position %</label><input type="range" data-f="posSlider" min="0" max="100" step="0.5" value="${round2((((band.from ?? 0) + (band.to ?? 1)) / 2) * 100)}"></div>
      <div class="row"><label>Coverage %</label><input type="range" data-f="lenSlider" min="0" max="100" step="0.5" value="${round2(((band.to ?? 1) - (band.from ?? 0)) * 100)}"></div>
      <div class="grid">
        <div><label>From %</label><input type="number" data-f="from" value="${round2((band.from ?? 0) * 100)}" step="1"></div>
        <div><label>To %</label><input type="number" data-f="to" value="${round2((band.to ?? 1) * 100)}" step="1"></div>
        <div><label>Spacing m</label><input type="number" data-f="spacing" value="${band.spacing ?? 5}" step="0.5"></div>
        <div><label>Offset m</label><input type="number" data-f="offset" value="${round2(band.offset ?? 2)}" step="0.1"></div>
        <div><label>Y offset m</label><input type="number" data-f="yOffset" value="${round2(band.yOffset ?? 0)}" step="0.1"></div>
        <div><label>Jitter m</label><input type="number" data-f="jitter" value="${band.jitter ?? 0}" step="0.1"></div>
        <div><label>Rows</label><input type="number" data-f="rows" value="${band.rows ?? 1}" step="1" min="1"></div>
        <div><label>Row spacing m</label><input type="number" data-f="rowSpacing" value="${band.rowSpacing ?? 1.2}" step="0.1" min="0.1"></div>
      </div>
      <div class="row"><label>Conform to slope</label><input type="checkbox" data-f="conform" ${band.conform ? "checked" : ""} style="width:auto;justify-self:start"></div>
      <div class="grid">
        <div><label>Scale X</label><input type="number" data-f="scaleX" value="${band.scaleX ?? 1}" step="0.1" min="0.01"></div>
        <div><label>Scale Y</label><input type="number" data-f="scaleY" value="${band.scaleY ?? 1}" step="0.1" min="0.01"></div>
        <div><label>Scale Z</label><input type="number" data-f="scaleZ" value="${band.scaleZ ?? 1}" step="0.1" min="0.01"></div>
        <div><label>Rot X °</label><input type="number" data-f="rotXDeg" value="${round2(((band.rotX ?? 0) * 180) / Math.PI)}" step="5"></div>
        <div><label>Rot Y °</label><input type="number" data-f="rotYDeg" value="${round2(((band.rotY ?? 0) * 180) / Math.PI)}" step="5"></div>
        <div><label>Rot Z °</label><input type="number" data-f="rotZDeg" value="${round2(((band.rotZ ?? 0) * 180) / Math.PI)}" step="5"></div>
      </div>
    </div>`;
}

function refreshBandList() {
  const el = document.getElementById("bandList");
  const bands = currentTrackObjects()?.bands ?? [];
  el.innerHTML = bands.map((b, i) => bandRowHtml(b, i)).join("");
  highlightSelectedBandRow(); // survive re-renders (e.g. after a click-to-select spline switch)
  el.querySelectorAll(".item").forEach((row) => {
    const idx = Number(row.dataset.idx);
    row.querySelector('[data-act="del"]').addEventListener("click", () => {
      currentTrackObjects().bands.splice(idx, 1);
      removeBandInstances(activeSplineId, idx, true); // live removal + slide later rows' instance tags down
      clearBandSelection(); // indices shifted — a stale ref would highlight the wrong row
      refreshBandList();
      markDirty();
    });
    const r4 = (v) => Math.round(v * 10000) / 10000;
    const setField = (f, v) => {
      const el = row.querySelector(`[data-f="${f}"]`);
      if (el && document.activeElement !== el) el.value = v;
    };
    row.querySelectorAll("[data-f]").forEach((input) => {
      const evt = input.type === "checkbox" ? "change" : "input";
      input.addEventListener(evt, () => {
        const f = input.dataset.f;
        const band = currentTrackObjects().bands[idx];
        if (f === "type" || f === "side") band[f] = input.value;
        else if (f === "conform") band[f] = input.checked;
        else if (f === "from" || f === "to") {
          band[f] = Number(input.value) / 100;
          setField("posSlider", round2((((band.from ?? 0) + (band.to ?? 1)) / 2) * 100));
          setField("lenSlider", round2(((band.to ?? 1) - (band.from ?? 0)) * 100));
        } else if (f === "posSlider" || f === "lenSlider") {
          // sliders edit the same from/to, just re-parameterized as
          // center ("Position") + length ("Coverage") — friendlier to drag
          // than typing percentages, and wrap-past-100% still works since
          // from/to are what's stored.
          const from = band.from ?? 0, to = band.to ?? 1;
          let center = (from + to) / 2, len = to - from;
          if (f === "posSlider") center = Number(input.value) / 100;
          else len = Number(input.value) / 100;
          band.from = r4(center - len / 2);
          band.to = r4(center + len / 2);
          setField("from", round2(band.from * 100));
          setField("to", round2(band.to * 100));
        }
        else if (f === "rotXDeg") band.rotX = (Number(input.value) * Math.PI) / 180;
        else if (f === "rotYDeg") band.rotY = (Number(input.value) * Math.PI) / 180;
        else if (f === "rotZDeg") band.rotZ = (Number(input.value) * Math.PI) / 180;
        else band[f] = Number(input.value);
        markDirty();
        queueBandRefresh(idx); // live: this band's instances re-place immediately, no Generate needed
      });
    });
  });
}

function pointRowHtml(pt, idx, isSelected) {
  const sides = ["left", "right"];
  return `
    <div class="item ${isSelected ? "selected" : ""}" data-idx="${idx}">
      <div class="itemHead"><b>#${idx + 1}</b><button class="small danger" data-act="del">✕</button></div>
      <div class="btnRow"><button class="wide" data-act="select">${isSelected ? "Selected" : "Select"}</button></div>
      <div class="row"><label>Type</label><select data-f="type">${typeOptions(pt.type)}</select></div>
      <div class="row"><label>Side</label><select data-f="side">${sides
        .map((s) => `<option value="${s}" ${s === pt.side ? "selected" : ""}>${s}</option>`)
        .join("")}</select></div>
      <div class="grid">
        <div><label>Arc s (m)</label><input type="number" data-f="s" value="${round2(pt.s ?? 0)}" step="0.5"></div>
        <div><label>Offset m</label><input type="number" data-f="offset" value="${round2(pt.offset ?? 3)}" step="0.1"></div>
        <div><label>Y offset m</label><input type="number" data-f="yOffset" value="${round2(pt.yOffset ?? 0)}" step="0.1"></div>
      </div>
      <div class="row"><label>Conform to slope</label><input type="checkbox" data-f="conform" ${pt.conform ? "checked" : ""} style="width:auto;justify-self:start"></div>
      <div class="grid">
        <div><label>Scale X</label><input type="number" data-f="scaleX" value="${pt.scaleX ?? 1}" step="0.1" min="0.01"></div>
        <div><label>Scale Y</label><input type="number" data-f="scaleY" value="${pt.scaleY ?? 1}" step="0.1" min="0.01"></div>
        <div><label>Scale Z</label><input type="number" data-f="scaleZ" value="${pt.scaleZ ?? 1}" step="0.1" min="0.01"></div>
        <div><label>Rot X °</label><input type="number" data-f="rotXDeg" value="${round2(((pt.rotX ?? 0) * 180) / Math.PI)}" step="5"></div>
        <div><label>Rot Y °</label><input type="number" data-f="rotYDeg" value="${round2(((pt.rotY ?? pt.rotation ?? 0) * 180) / Math.PI)}" step="5"></div>
        <div><label>Rot Z °</label><input type="number" data-f="rotZDeg" value="${round2(((pt.rotZ ?? 0) * 180) / Math.PI)}" step="5"></div>
      </div>
    </div>`;
}

function refreshPointList() {
  const el = document.getElementById("pointList");
  const points = currentTrackObjects()?.points ?? [];
  el.innerHTML = points
    .map((p, i) => pointRowHtml(p, i, !!selectedPointRef && selectedPointRef.splineId === activeSplineId && selectedPointRef.index === i))
    .join("");
  el.querySelectorAll(".item").forEach((row) => {
    const idx = Number(row.dataset.idx);
    row.querySelector('[data-act="del"]').addEventListener("click", () => {
      currentTrackObjects().points.splice(idx, 1);
      if (selectedPointRef && selectedPointRef.splineId === activeSplineId && selectedPointRef.index === idx) deselectObject();
      refreshPointList();
      markDirty();
    });
    row.querySelector('[data-act="select"]').addEventListener("click", () => {
      const obj = findObjectByRef(activeSplineId, idx);
      if (obj) { setActiveTab("object"); setObjectMode("select"); selectObject(obj); }
      else msg("Press Generate first to select this object in the 3D view.");
    });
    row.querySelectorAll("[data-f]").forEach((input) => {
      const evt = input.type === "checkbox" ? "change" : "input";
      input.addEventListener(evt, () => {
        const f = input.dataset.f;
        const pt = currentTrackObjects().points[idx];
        if (f === "type" || f === "side") pt[f] = input.value;
        else if (f === "conform") pt[f] = input.checked;
        else if (f === "rotXDeg") pt.rotX = (Number(input.value) * Math.PI) / 180;
        else if (f === "rotYDeg") pt.rotY = (Number(input.value) * Math.PI) / 180;
        else if (f === "rotZDeg") pt.rotZ = (Number(input.value) * Math.PI) / 180;
        else pt[f] = Number(input.value);
        markDirty();
      });
    });
  });
}

function defaultOffset() {
  return activeSplineId === "main" && track ? track.wallDist : 0;
}

document.getElementById("bandAdd").addEventListener("click", () => {
  currentTrackObjects().bands.push({
    type: paletteType, side: "both", from: 0, to: 1,
    spacing: 5, offset: defaultOffset(), jitter: 0, conform: true,
    scaleX: 1, scaleY: 1, scaleZ: 1, rotX: 0, rotY: 0, rotZ: 0,
  });
  refreshBandList();
  markDirty();
  queueBandRefresh(currentTrackObjects().bands.length - 1); // appears immediately, same as slider edits
});
document.getElementById("pointAdd").addEventListener("click", () => {
  if (OBJECT_TYPES[paletteType]?.ribbon) {
    msg("Spline types are band-only — use the palette default for a new band instead.");
    return;
  }
  currentTrackObjects().points.push({
    type: paletteType, side: "left", s: 0, offset: defaultOffset(), conform: true,
    scaleX: 1, scaleY: 1, scaleZ: 1, rotX: 0, rotY: 0, rotZ: 0,
  });
  refreshPointList();
  markDirty();
});

// ---------------------------------------------------------------------
// Meta / theme panel
// ---------------------------------------------------------------------
const fId = document.getElementById("fId"), fName = document.getElementById("fName"), fDesc = document.getElementById("fDesc");
const fLaps = document.getElementById("fLaps"), fWidth = document.getElementById("fWidth");
const fGold = document.getElementById("fGold"), fSilver = document.getElementById("fSilver"), fBronze = document.getElementById("fBronze");
const fSky = document.getElementById("fSky"), fFog = document.getElementById("fFog");
const fGround = document.getElementById("fGround"), fHill = document.getElementById("fHill"), fSun = document.getElementById("fSun");
const fSunAz = document.getElementById("fSunAz"), fSunAzRange = document.getElementById("fSunAzRange");
const fSunEl = document.getElementById("fSunEl"), fSunElRange = document.getElementById("fSunElRange");
const fTrees = document.getElementById("fTrees"), fRocks = document.getElementById("fRocks"), fBillboards = document.getElementById("fBillboards");
const tName = document.getElementById("tName"), tJson = document.getElementById("tJson");
const tFile = document.getElementById("tFile");

function colorToHex(c) {
  return "#" + new THREE.Color(c).getHexString();
}

function syncMetaFields() {
  fId.value = def.id; fName.value = def.name; fDesc.value = def.desc ?? "";
  fLaps.value = def.laps; fWidth.value = def.width;
  fGold.value = def.medalAvgSpeed.gold; fSilver.value = def.medalAvgSpeed.silver; fBronze.value = def.medalAvgSpeed.bronze;
  fSky.value = colorToHex(def.theme.sky); fFog.value = colorToHex(def.theme.fog);
  fGround.value = def.theme.ground; fHill.value = colorToHex(def.theme.hill); fSun.value = colorToHex(def.theme.sun);
  fSunAz.value = def.theme.sunAzimuthDeg ?? DEFAULT_SUN_AZIMUTH_DEG; fSunAzRange.value = fSunAz.value;
  fSunEl.value = def.theme.sunElevationDeg ?? DEFAULT_SUN_ELEVATION_DEG; fSunElRange.value = fSunEl.value;
  fTrees.value = def.theme.props.trees; fRocks.value = def.theme.props.rocks; fBillboards.value = def.theme.props.billboards;
  tName.value = def.id;
}

function wireMeta() {
  fId.addEventListener("input", () => { def.id = fId.value; tName.value = fId.value; });
  fName.addEventListener("input", () => (def.name = fName.value));
  fDesc.addEventListener("input", () => (def.desc = fDesc.value));
  fLaps.addEventListener("input", () => (def.laps = Number(fLaps.value) || 1));
  fWidth.addEventListener("input", () => { def.width = Number(fWidth.value) || 4; markDirty("fWidth"); });
  fGold.addEventListener("input", () => (def.medalAvgSpeed.gold = Number(fGold.value) || 0));
  fSilver.addEventListener("input", () => (def.medalAvgSpeed.silver = Number(fSilver.value) || 0));
  fBronze.addEventListener("input", () => (def.medalAvgSpeed.bronze = Number(fBronze.value) || 0));
  fSky.addEventListener("input", () => { def.theme.sky = fSky.value; markDirty("fSky"); });
  fFog.addEventListener("input", () => { def.theme.fog = fFog.value; markDirty("fFog"); });
  fGround.addEventListener("input", () => { def.theme.ground = fGround.value; markDirty("fGround"); });
  fHill.addEventListener("input", () => { def.theme.hill = fHill.value; markDirty("fHill"); });
  fSun.addEventListener("input", () => { def.theme.sun = fSun.value; updateSunFromTheme(); markDirty("fSun"); });
  // Azimuth/elevation reposition the light + its visible marker live, on
  // every drag tick — waiting for "Generate" would defeat the point of
  // being able to see the sun while aiming it.
  const setSunAz = (v) => { def.theme.sunAzimuthDeg = Number(v); fSunAz.value = v; fSunAzRange.value = v; updateSunFromTheme(); markDirty("sunAz"); };
  fSunAz.addEventListener("input", () => setSunAz(fSunAz.value));
  fSunAzRange.addEventListener("input", () => setSunAz(fSunAzRange.value));
  const setSunEl = (v) => { def.theme.sunElevationDeg = Number(v); fSunEl.value = v; fSunElRange.value = v; updateSunFromTheme(); markDirty("sunEl"); };
  fSunEl.addEventListener("input", () => setSunEl(fSunEl.value));
  fSunElRange.addEventListener("input", () => setSunEl(fSunElRange.value));
  // Sun marker sits wherever azimuth/elevation put it, which is very often
  // outside the current camera framing — reorient the existing camera to
  // look at it on demand rather than guessing which way to orbit.
  document.getElementById("sunLookBtn").addEventListener("click", () => {
    controls.target.copy(sunVisual.position);
    controls.update();
  });
  fTrees.addEventListener("input", () => { def.theme.props.trees = Number(fTrees.value) || 0; markDirty("fTrees"); });
  fRocks.addEventListener("input", () => { def.theme.props.rocks = Number(fRocks.value) || 0; markDirty("fRocks"); });
  fBillboards.addEventListener("input", () => { def.theme.props.billboards = Number(fBillboards.value) || 0; markDirty("fBillboards"); });

  document.getElementById("presetGrass").addEventListener("click", () => {
    Object.assign(def.theme, { sky: 0x87ceeb, fog: 0x9cc7de, ground: "#4c7a3f", hill: 0x50694a, sun: 0xfff4e0, terrain: "grass" });
    syncMetaFields();
    updateSunFromTheme();
    markDirty();
  });
  document.getElementById("presetDesert").addEventListener("click", () => {
    Object.assign(def.theme, { sky: 0xbfd3e0, fog: 0xd6c7a8, ground: "#c9a06a", hill: 0x8a6a48, sun: 0xffe9c4, terrain: "desert" });
    syncMetaFields();
    updateSunFromTheme();
    markDirty();
  });
}

// ---------------------------------------------------------------------
// Export / import footer
// ---------------------------------------------------------------------
function msg(text) {
  const m = document.getElementById("msg");
  m.textContent = text;
  clearTimeout(msg._t);
  msg._t = setTimeout(() => (m.textContent = ""), 3500);
}

document.querySelector('[data-act="export"]').addEventListener("click", () => {
  tJson.value = JSON.stringify(def, null, 2);
  msg("Exported — Download it into levels/ to make it playable, or paste into tracks.js to bundle it in permanently.");
});
document.querySelector('[data-act="copy"]').addEventListener("click", async () => {
  tJson.value = JSON.stringify(def, null, 2);
  try {
    await navigator.clipboard.writeText(tJson.value);
    msg("Copied to clipboard.");
  } catch {
    msg("Clipboard blocked — select the text box and copy manually.");
  }
});
document.querySelector('[data-act="download"]').addEventListener("click", () => {
  const json = JSON.stringify(def, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const filename = `${(def.id || "track").replace(/[^\w-]+/g, "-")}.track.json`;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  msg(`Downloaded ${filename} — move it into levels/ and reload the game to make it playable.`);
});
document.querySelector('[data-act="load"]').addEventListener("click", () => tFile.click());
tFile.addEventListener("change", () => {
  const file = tFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch {
      msg("Invalid JSON file.");
      tFile.value = "";
      return;
    }
    const err = validateDef(parsed);
    if (err) {
      msg(err);
      tFile.value = "";
      return;
    }
    tJson.value = JSON.stringify(parsed, null, 2); // keep Export/Copy/Apply in sync with what's now loaded
    historyCheckpoint(); // a full swap is undoable too
    loadDef(normalizeDef(parsed));
    msg(`Loaded ${file.name} — resume editing.`);
    tFile.value = ""; // reset so picking the same filename again still fires 'change'
  };
  reader.onerror = () => msg("Couldn't read that file.");
  reader.readAsText(file);
});
document.querySelector('[data-act="apply"]').addEventListener("click", () => {
  let parsed;
  try {
    parsed = JSON.parse(tJson.value);
  } catch {
    msg("Invalid JSON.");
    return;
  }
  const err = validateDef(parsed);
  if (err) {
    msg(err);
    return;
  }
  historyCheckpoint(); // a full swap is undoable too
  loadDef(normalizeDef(parsed));
  msg("Loaded.");
});
document.querySelector('[data-act="reset"]').addEventListener("click", () => {
  if (!confirm("Discard the current track and start a new one?")) return;
  historyCheckpoint(); // recoverable with Undo, unlike before
  loadDef(freshDef());
});

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
function loadDef(newDef) {
  // A full state swap (boot / Apply / New track) is a discrete action, not
  // continuous editing — rebuild immediately instead of waiting for
  // Generate, so the editor never shows a stale scene for a track that was
  // just loaded.
  def = normalizeDef(newDef);
  activeSplineId = "main"; // whatever was active may not exist in the new def
  selected = -1;
  showInspector(false);
  syncMetaFields();
  refreshMarkers();
  refreshSplineList();
  rebuild();
  // rebuild() only refreshes the list DOM when trackObjects didn't exist
  // yet; if the loaded JSON already had one, refresh explicitly here too.
  refreshBandList();
  refreshPointList();
  // Whatever def is now IS the state undo returns to. Any in-flight burst
  // belonged to the old def and must not survive the swap.
  if (burstTimer) { clearTimeout(burstTimer); burstTimer = 0; }
  burstLabel = null;
  burstPushed = false;
  baseline = snapshot();
  updateHistoryButtons();
}

let lastTickTime = performance.now();

function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastTickTime) / 1000);
  lastTickTime = now;
  updateFlyCamera(dt);
  controls.update();
  updateOceanTime(waterMeshes, now);
  // Same Y-axis-only billboarding as the race (main.js) — crowd sprites
  // face the free-orbiting editor camera so what you preview matches races.
  for (const b of billboards) {
    if (b.userData.noFace) continue; // static cross sprites (trees/pines) never re-face
    b.rotation.y = Math.atan2(camera.position.x - b.position.x, camera.position.z - b.position.z);
    updateCrowdBillboard(b, now, camera.position); // no-op for anything that isn't a rigged Crowd figure
  }
  if (def) {
    applySunVisual(sunVisual, def.theme, camera.position, DEFAULT_SUN_VISUAL_DISTANCE);
    skyDome.position.copy(camera.position);
  }
  renderer.render(scene, camera);
}

async function init() {
  try {
    await preloadAssets();
  } catch (err) {
    console.warn("Asset preload failed (non-fatal — placeholders still work):", err);
  }
  buildPalette();
  wireMeta();
  wirePointInspector();
  setActiveTab("splines");
  setSplineMode("select");
  setObjectMode("place");
  setGizmoMode("translate");
  loadDef(loadDraft() ?? freshDef());
  undoStack.length = 0; // boot state is the floor — nothing before it to undo to
  redoStack.length = 0;
  updateHistoryButtons();

  document.getElementById("loading").classList.add("hidden");
  document.getElementById("left").classList.remove("hidden");
  document.getElementById("right").classList.remove("hidden");
  document.getElementById("hint").classList.remove("hidden");

  renderer.setAnimationLoop(tick);
}

init();
