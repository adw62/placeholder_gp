// =====================================================================
// Rule-based trackside object placement — single source of truth, used
// identically by editor.js and main.js, so preview and race can't drift.
//
// A track's `trackObjects` (tracks.js) has two parts:
//   bands  — "place <type> every <spacing>m along <side> from <from> to
//            <to>" (fractions of lap length) — the primary mechanism.
//   points — one-off placements/exceptions a rule shouldn't blanket-cover.
// Omitting `trackObjects` falls back to defaultBands() (full-lap barriers +
// curvature-triggered apexKerb), materialized as real editable rows.
//
// `billboard: true` types are camera-facing sprites whose rotation is fully
// owned by main.js/editor.js's per-frame facing update — placement only
// sets position. `ribbon: true` types (splineBarrier/splineApexKerb) are one
// continuous strip mesh over a band's whole range instead of discrete
// instances — bands only, placePoint skips them.
//
// placeBand/placePoint take any spline-like object with .length/.samples/
// .posAt, not just the main track — buildAllTrackObjects() also runs them
// against every def.extraSplines entry. .wallDist/.halfW (main-track-only)
// read via `?? 0` so extra splines default to sitting right on the line.
// =====================================================================

import * as THREE from "three";
import { CONFIG } from "./config.js";
import { buildSpline } from "./spline.js";
import {
  buildTree, buildBillboard, buildBarrier, buildApexKerb, buildTireBarrier, buildBuilding, buildCutoutSprite, buildCrowdFigure,
  kerbTexture, getRoadTexture, getRibbonAtlas, ASSETS,
} from "./placeholders.js";

export const OBJECT_TYPES = {
  barrier: { label: "Barrier", build: buildBarrier },
  apexKerb: { label: "Apex Kerb", build: buildApexKerb },
  tireBarrier: { label: "Tire Barrier", build: buildTireBarrier },
  tree: { label: "Tree", build: buildTree },
  building: { label: "Building", build: buildBuilding },
  billboard: { label: "Billboard", build: buildBillboard },
  // Rigged crowd figure (crowdEditor.html + src/crowd.js) — shares the
  // Cutout types' placement/facing machinery. Bands support multiple rows
  // (placeBand's rows/rowSpacing) for stadium-style depth.
  crowd: { label: "Crowd", build: buildCrowdFigure, billboard: true },
  splineBarrier: { label: "Spline Barrier", ribbon: true, buildRibbon: buildSplineBarrierRibbon },
  splineApexKerb: { label: "Spline Apex Kerb", ribbon: true, buildRibbon: buildSplineApexKerbRibbon },
  splineTarmac: { label: "Spline Tarmac", ribbon: true, buildRibbon: buildSplineTarmacRibbon },
};

// One "cutout" type per registered sprite folder (spriteFolders.tree ->
// "cutoutTree"); a `static: true` folder becomes a "Backdrop" instead,
// getting the one-time tangent-facing orient() rather than per-frame billboarding.
for (const [key, spec] of Object.entries(ASSETS.spriteFolders)) {
  const name = key[0].toUpperCase() + key.slice(1);
  OBJECT_TYPES[`cutout${name}`] = {
    label: spec.static ? `Backdrop: ${name}` : `Cutout: ${name}`,
    build: (rng) => buildCutoutSprite(key, rng),
    billboard: !spec.static,
  };
}

// Contiguous sample runs where the corner is tight enough to deserve kerbs.
// Ported unchanged from the old track.js (kerbRuns) — same threshold/run
// detection, now emitting fraction-of-length band ranges instead of mesh.
function curvatureRuns(samples, minCurv) {
  const N = samples.length;
  const flag = samples.map((s) => Math.abs(s.curv) > minCurv);
  const dil = flag.slice();
  for (let i = 0; i < N; i++) {
    if (!flag[i]) continue;
    for (let d = -6; d <= 6; d++) dil[(i + d + N) % N] = true;
  }
  const start = dil.indexOf(false);
  if (start === -1) return [{ i0: 0, count: N }];
  const runs = [];
  let runStart = -1;
  for (let k = 1; k <= N; k++) {
    const i = (start + k) % N;
    if (dil[i] && runStart < 0) runStart = i;
    if (!dil[i] && runStart >= 0) {
      const len = (i - runStart + N) % N;
      if (len >= 8) runs.push({ i0: runStart, count: len });
      runStart = -1;
    }
  }
  return runs;
}

export function defaultBands(track) {
  const TC = CONFIG.track;
  const N = track.samples.length;
  const bands = [
    { type: "barrier", side: "both", from: 0, to: 1, spacing: 6, offset: track.wallDist, conform: true },
  ];
  for (const run of curvatureRuns(track.samples, TC.kerbMinCurv)) {
    bands.push({
      type: "apexKerb",
      side: "both",
      from: run.i0 / N,
      to: (run.i0 + run.count) / N, // may exceed 1 — wraps through the start/finish
      spacing: 2.5,
      offset: track.halfW + 0.3,
      conform: true,
    });
  }
  return bands;
}

// "left" -> +side, "right" -> -side, "both" -> both. Which physical side
// that is depends on the spline's winding direction — not load-bearing,
// just needs to be consistent between the editor and the race. Exported:
// computeWallProfile (below) needs the identical mapping to line collision
// up with wherever a band's objects actually get placed.
export function signsFor(side) {
  if (side === "left") return [1];
  if (side === "right") return [-1];
  return [1, -1];
}

// The bands a track ACTUALLY places — factored out of buildTrackObjects so
// computeWallProfile (physics wall) and the visuals can never disagree
// about what "the barriers" are.
export function resolveBands(def, spline) {
  return def.trackObjects?.bands ?? defaultBands(spline);
}

// Barrier-type bands (real, walkable-into trackside obstacles) narrow the
// physics wall in from the generic uniform margin wherever one is placed
// closer to the road than that — so the car hits the barrier/tire stack it
// can actually see instead of driving through it into invisible air (or,
// on a track authored with barriers set further out, stopping short of one
// that was never there). Per sample, per side; closest collidable band on
// that side wins (it's what gets hit first). Stretches with no collidable
// band at all keep the flat fallback distance. Only meaningful for the main
// track (extra splines have no wallDist/physics concept).
const COLLIDABLE_BARRIER_TYPES = new Set(["barrier", "splineBarrier", "tireBarrier"]);

export function computeWallProfile(samples, length, bands, fallbackDist) {
  const N = samples.length;
  const left = new Float32Array(N).fill(fallbackDist);
  const right = new Float32Array(N).fill(fallbackDist);
  for (const band of bands) {
    if (!COLLIDABLE_BARRIER_TYPES.has(band.type)) continue;
    const offset = band.offset ?? fallbackDist;
    const i0 = Math.floor((band.from ?? 0) * N);
    const i1 = Math.ceil((band.to ?? 1) * N);
    for (const sign of signsFor(band.side ?? "both")) {
      const arr = sign > 0 ? left : right;
      for (let k = i0; k <= i1; k++) {
        const i = ((k % N) + N) % N;
        if (offset < arr[i]) arr[i] = offset;
      }
    }
  }
  return { left, right };
}

// sign: same convention as spline query()'s q.lateral (positive = +side,
// matching signsFor("left")) — pass Math.sign(q.lateral) || 1.
export function wallDistAt(profile, idx, sign) {
  return sign >= 0 ? profile.left[idx] : profile.right[idx];
}

// Curvature at a given arc distance (nearest sample — plenty for spacing
// and orientation purposes, no need to interpolate).
function curvatureAt(spline, s) {
  const N = spline.samples.length;
  let sd = s % spline.length;
  if (sd < 0) sd += spline.length;
  const i = Math.floor((sd / spline.length) * N) % N;
  return spline.samples[i].curv;
}

const _pos = new THREE.Vector3(), _tan = new THREE.Vector3(), _side = new THREE.Vector3();
const _normal = new THREE.Vector3(), _mat = new THREE.Matrix4(), _quat = new THREE.Quaternion();

// conform=true tilts flush with the road's local pitch (never banks side-to-
// side) instead of staying world-upright. rot={x,y,z} layers an extra local
// Euler rotation on top (y=heading, mirroring folds into rot.y before this
// is called; x/z are freeform tilt/cant, e.g. canting a barrier).
function orient(obj, tan, side, conform, rot) {
  if (conform) {
    _normal.crossVectors(tan, side).normalize();
    _mat.makeBasis(side, _normal, tan);
    _quat.setFromRotationMatrix(_mat);
    obj.quaternion.copy(_quat);
  } else {
    obj.rotation.set(0, Math.atan2(tan.x, tan.z), 0);
  }
  if (rot.x) obj.rotateX(rot.x);
  if (rot.y) obj.rotateY(rot.y);
  if (rot.z) obj.rotateZ(rot.z);
}

// scale defaults to 1 on any axis left unset — [sx, sy, sz] in object space,
// applied regardless of billboard/conform/orient path since it's independent
// of rotation.
function applyScale(obj, scale) {
  obj.scale.set(scale?.x ?? 1, scale?.y ?? 1, scale?.z ?? 1);
}

function placeBand(group, spline, band, rng, billboards, splineId, bandIndex) {
  const type = OBJECT_TYPES[band.type];
  if (!type) return;
  const fromS = (band.from ?? 0) * spline.length;
  const toS = (band.to ?? 1) * spline.length;
  const spacing = Math.max(0.5, band.spacing ?? 5);
  const jitter = band.jitter ?? 0;
  const offset = band.offset ?? spline.wallDist ?? 0;
  const conform = band.conform ?? false;
  const scale = { x: band.scaleX ?? 1, y: band.scaleY ?? 1, z: band.scaleZ ?? 1 };
  const rotX = band.rotX ?? 0, rotY = band.rotY ?? 0, rotZ = band.rotZ ?? 0;
  // rows >1 gives stadium-style depth (e.g. Crowd behind a fence) instead of
  // a second band per row — each row is just a bigger lateral offset, so it
  // rides the same curvature spacing-correction below.
  const rows = Math.max(1, Math.round(band.rows ?? 1));
  const rowSpacing = band.rowSpacing ?? 1.2;
  for (const sign of signsFor(band.side ?? "both")) {
    for (let row = 0; row < rows; row++) {
      const n = (offset + row * rowSpacing) * sign; // signed lateral offset, same convention as curvature
      for (let s = fromS; s <= toS + 1e-6; ) {
        const jit = jitter ? (rng() - 0.5) * 2 * jitter : 0;
        spline.posAt(s + jit, n, _pos, _tan, _side);
        const obj = type.build(rng);
        obj.position.copy(_pos);
        applyScale(obj, scale);
        if (type.billboard) billboards.push(obj);
        else orient(obj, _tan, _side, conform, { x: rotX, y: rotY + (sign < 0 ? Math.PI : 0), z: rotZ });
        // Identity for the editor: clicking any instance selects the band
        // row that generated it (there's no per-instance transform to edit).
        obj.userData.splineId = splineId;
        obj.userData.bandIndex = bandIndex;
        group.add(obj);
        // Parallel-curve arc-length relation: ds_offset = ds_center * (1 +
        // curvature * n) — offset curves run longer on a bend's outside,
        // shorter inside. Step centerline arc distance accordingly so
        // instances stay evenly spaced instead of bunching/spreading.
        const denom = Math.max(0.2, 1 + curvatureAt(spline, s) * n);
        s += spacing / denom;
      }
    }
  }
}

function placePoint(group, spline, pt, rng, billboards, splineId, index) {
  const type = OBJECT_TYPES[pt.type];
  if (!type || type.ribbon) return; // ribbon types need a from/to range — bands only
  const sign = pt.side === "right" ? -1 : 1;
  const offset = pt.offset ?? spline.wallDist ?? 0;
  spline.posAt(pt.s ?? 0, offset * sign, _pos, _tan, _side);
  const obj = type.build(rng);
  obj.position.copy(_pos);
  obj.position.y += pt.yOffset ?? 0; // manual vertical nudge — everything else follows the spline's own terrain height
  applyScale(obj, { x: pt.scaleX ?? 1, y: pt.scaleY ?? 1, z: pt.scaleZ ?? 1 });
  if (type.billboard) billboards.push(obj);
  else orient(obj, _tan, _side, pt.conform ?? false, { x: pt.rotX ?? 0, y: pt.rotY ?? pt.rotation ?? 0, z: pt.rotZ ?? 0 });
  // Identity for the editor's Object tab (select-in-viewport + transform
  // gizmo, see editor.js) to map a clicked mesh back to the trackObjects.points
  // entry it came from — irrelevant/unused at race time (main.js never reads it).
  obj.userData.splineId = splineId;
  obj.userData.pointIndex = index;
  group.add(obj);
}

// ---------------------------------------------------------------------
// Ribbon geometry — a single strip mesh over an arc-length range, sampled
// at a fixed step (not tied to track.samples' own resolution; posAt already
// handles the interpolation/wraparound). Mirrors the old track.js
// stripGeometry/wallGeometry, generalized to an arbitrary [fromS, toS] band
// instead of the whole lap.
// ---------------------------------------------------------------------
const RIBBON_STEP = 1.5; // meters between geometry samples along a ribbon

// Vertical strip (barrier-like): one lateral offset, ground to `height`.
// UV.u is remapped per `tileLength`-meter segment into a random cell of the
// shared atlas — one mesh/material/draw-call regardless of variant count.
// `flipU` mirrors each tile's u-run: the strip's triangle winding is fixed
// while the lateral offset just translates vertices, so one side's wall
// always shows the road its *back* face — without the flip that wall's ad
// text reads mirrored from the track. (Back faces seen from off-track still
// mirror — inherent to one DoubleSide strip sharing UVs.)
function ribbonWallGeometry(spline, fromS, toS, offset, height, atlasCount, tileLength, rng, flipU) {
  const totalLen = toS - fromS;
  const steps = Math.max(1, Math.ceil(Math.abs(totalLen) / RIBBON_STEP));
  const pos = [], uv = [], idx = [];
  const p = new THREE.Vector3(), prev = new THREE.Vector3();
  let run = 0, tileStart = 0, tileVariant = (rng() * atlasCount) | 0, havePrev = false;
  for (let k = 0; k <= steps; k++) {
    spline.posAt(fromS + (k / steps) * totalLen, offset, p);
    if (havePrev) run += p.distanceTo(prev);
    prev.copy(p);
    havePrev = true;
    if (run - tileStart > tileLength) { tileStart = run; tileVariant = (rng() * atlasCount) | 0; }
    const frac = THREE.MathUtils.clamp((run - tileStart) / tileLength, 0, 1);
    const u = (tileVariant + (flipU ? 1 - frac : frac)) / atlasCount;
    pos.push(p.x, p.y, p.z, p.x, p.y + height, p.z);
    uv.push(u, 0, u, 1);
    if (k < steps) { const b = k * 2; idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Flat strip (kerb-like): two lateral offsets (inner/outer edge), plain
// continuous UV tiling (no atlas — kerbs don't need sponsor-style variety).
function ribbonFlatGeometry(spline, fromS, toS, offA, offB, yLift, uvScale) {
  const totalLen = toS - fromS;
  const steps = Math.max(1, Math.ceil(Math.abs(totalLen) / RIBBON_STEP));
  const pos = [], uv = [], idx = [];
  const pA = new THREE.Vector3(), pB = new THREE.Vector3(), mid = new THREE.Vector3(), prevMid = new THREE.Vector3();
  let run = 0, havePrev = false;
  for (let k = 0; k <= steps; k++) {
    const s = fromS + (k / steps) * totalLen;
    spline.posAt(s, offA, pA);
    spline.posAt(s, offB, pB);
    mid.copy(pA).add(pB).multiplyScalar(0.5);
    if (havePrev) run += mid.distanceTo(prevMid);
    prevMid.copy(mid);
    havePrev = true;
    pos.push(pA.x, pA.y + yLift, pA.z, pB.x, pB.y + yLift, pB.z);
    uv.push(run * uvScale, 0, run * uvScale, 1);
    // wind so faces point up (+y): +side × tangent points down, so A→B→A'
    // order would face the strip at the ground — see the wall ribbon's
    // DoubleSide for why that one never noticed.
    if (k < steps) { const b = k * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// `band.spacing` doubles as the atlas tile length here (how many meters of
// ribbon each texture-variant cell covers) — same field the instance types
// use for their repeat interval, just reinterpreted for a continuous strip.
function buildSplineBarrierRibbon(spline, band, sign, rng) {
  const fromS = (band.from ?? 0) * spline.length;
  const toS = (band.to ?? 1) * spline.length;
  const offset = (band.offset ?? spline.wallDist ?? 0) * sign;
  const tileLength = Math.max(1, band.spacing ?? 6);
  const atlas = getRibbonAtlas("barrier");
  const geo = ribbonWallGeometry(spline, fromS, toS, offset, CONFIG.track.wallHeight, atlas.count, tileLength, rng, sign < 0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: atlas.texture, roughness: 0.7, side: THREE.DoubleSide }));
  mesh.receiveShadow = mesh.castShadow = true;
  return mesh;
}

function buildSplineApexKerbRibbon(spline, band, sign) {
  const fromS = (band.from ?? 0) * spline.length;
  const toS = (band.to ?? 1) * spline.length;
  const halfW = CONFIG.track.kerbWidth / 2;
  const center = (band.offset ?? (spline.halfW ?? 0) + 0.3) * sign;
  const geo = ribbonFlatGeometry(spline, fromS, toS, center - halfW, center + halfW, 0.03, 0.5);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: kerbTexture(), roughness: 0.8 }));
  mesh.receiveShadow = true;
  return mesh;
}

// Flat road-surface strip (pit aprons, side streets, wear decals) — the kerb
// ribbon's geometry skinned with a named texture from assets/textures/road/
// (band.tex, default "asphalt"). Width comes from the band's scaleX (meters)
// since it isn't tied to CONFIG.track.kerbWidth; `offset` is the strip
// center; `spacing` is meters of strip per texture repeat (the same
// reinterpretation splineBarrier gives it). A texture with transparency
// renders as an overlay: lifted a little higher and drawn without depth
// writes so it decals cleanly onto the road beneath.
const _tarmacMats = new Map();
function buildSplineTarmacRibbon(spline, band, sign) {
  const name = band.tex ?? "asphalt";
  if (!_tarmacMats.has(name)) {
    const { texture, hasAlpha } = getRoadTexture(name);
    const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95 });
    if (hasAlpha) { mat.transparent = true; mat.depthWrite = false; }
    mat.userData.shared = true;
    _tarmacMats.set(name, mat);
  }
  const mat = _tarmacMats.get(name);
  const fromS = (band.from ?? 0) * spline.length;
  const toS = (band.to ?? 1) * spline.length;
  const w = Math.max(1, band.scaleX ?? 5);
  const center = (band.offset ?? 0) * sign;
  const tile = Math.max(1, band.spacing ?? 8);
  const geo = ribbonFlatGeometry(spline, fromS, toS, center - w / 2, center + w / 2, mat.transparent ? 0.05 : 0.02, 1 / tile);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function placeRibbonBand(group, spline, band, rng, splineId, bandIndex) {
  const type = OBJECT_TYPES[band.type];
  for (const sign of signsFor(band.side ?? "both")) {
    const mesh = type.buildRibbon(spline, band, sign, rng);
    mesh.userData.splineId = splineId; // same click-to-band-row identity as placeBand
    mesh.userData.bandIndex = bandIndex;
    mesh.userData.ribbon = true; // owns its geometry (instance types share cached geo) — editor live-refresh disposes accordingly
    group.add(mesh);
  }
}

// Places one def's worth of bands/points against one spline-like object —
// the main track (has wallDist/halfW) or a plain buildSpline() result for
// an extra spline (defaultBands() is the only thing that assumes
// wallDist/halfW, so it's never called for extra splines).
// Returns { group, billboards } — billboards need per-frame camera-facing
// rotation from main.js/editor.js. splineId ("main" or extraSplines[].id)
// plus pointIndex/bandIndex is stamped onto each placed object's userData
// for the editor to map a clicked mesh back to its trackObjects entry
// (points get a transform gizmo, band instances select their band row);
// unused at race time.
export function buildTrackObjects(def, spline, rng, splineId = "main") {
  const group = new THREE.Group();
  const billboards = [];
  const bands = resolveBands(def, spline);
  const points = def.trackObjects?.points ?? [];
  bands.forEach((band, i) => {
    const type = OBJECT_TYPES[band.type];
    if (type?.ribbon) placeRibbonBand(group, spline, band, rng, splineId, i);
    else placeBand(group, spline, band, rng, billboards, splineId, i);
  });
  points.forEach((pt, i) => placePoint(group, spline, pt, rng, billboards, splineId, i));
  return { group, billboards };
}

// Builds objects for the main track AND every def.extraSplines entry —
// what main.js/editor.js should call instead of buildTrackObjects directly,
// so extra-spline objects actually race, not just preview.
export function buildAllTrackObjects(def, track, rng) {
  const group = new THREE.Group();
  const billboards = [];
  const main = buildTrackObjects(def, track, rng, "main");
  group.add(main.group);
  billboards.push(...main.billboards);
  for (const ex of def.extraSplines ?? []) {
    if (!ex.controlPoints || ex.controlPoints.length < 2) continue;
    const spline = buildSpline(ex.controlPoints, !!ex.closed, CONFIG.track.samples);
    // No defaultBands() fallback here (needs wallDist/halfW, which extra
    // splines don't have) — one with no trackObjects of its own places nothing.
    const trackObjects = ex.trackObjects ?? { bands: [], points: [] };
    const r = buildTrackObjects({ trackObjects }, spline, rng, ex.id);
    group.add(r.group);
    billboards.push(...r.billboards);
  }
  return { group, billboards };
}
