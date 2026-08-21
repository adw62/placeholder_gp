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
import { makeGroundSampler } from "./environment.js";
import {
  buildTree, buildBillboard, buildBarrier, buildApexKerb, buildTireBarrier, buildBuilding, buildCutoutSprite, buildCrowdFigure,
  buildPillar, buildLampTokyo, buildLightCone,
  buildRockOutcrop, buildMonkeyTree, buildTimberRail,
  buildTunnelPortalMountain, buildTunnelPortalExpressway,
  buildOldTownFacade,
  buildSphinx, buildMarketStall,
  buildRivieraFacade, buildCasino, buildYacht, buildHarbourCrane, buildOcean,
  TIMBER_HALF_THICKNESS, TIMBER_HALF_LENGTH,
  OLDTOWN_HALF_THICKNESS, OLDTOWN_HALF_LENGTH,
  RIVIERA_HALF_THICKNESS, RIVIERA_HALF_LENGTH,
  kerbTexture, getRoadTexture, getRibbonAtlas, ASSETS,
  tunnelWallTexture, tunnelCeilingTexture,
  BARRIER_HALF_THICKNESS, BARRIER_HALF_LENGTH, TIRE_RADIUS,
} from "./placeholders.js";

export const OBJECT_TYPES = {
  barrier: { label: "Barrier", build: buildBarrier },
  apexKerb: { label: "Apex Kerb", build: buildApexKerb },
  tireBarrier: { label: "Tire Barrier", build: buildTireBarrier },
  tree: { label: "Tree", build: buildTree },
  building: { label: "Building", build: buildBuilding },
  // Concrete overpass support column — origin at the top (see buildPillar),
  // so a point's scaleY is literally "how tall," hanging down to the ground.
  pillar: { label: "Pillar", build: buildPillar },
  // Real 3D mast-arm streetlamp (pole + arm + fixture + its own light/cone
  // at a fixed local position) — see buildLampTokyo for why this isn't the
  // cutoutLampTokyo billboard.
  lampTokyo: { label: "Lamp (Tokyo)", build: buildLampTokyo },
  // Mountain props (see the builders in placeholders.js). All three are
  // real geometry because all three live inside the range where a flat
  // billboard reads as cardboard from the chase camera.
  rockOutcrop: { label: "Rock Outcrop", build: buildRockOutcrop },
  monkeyTree: { label: "Monkey Tree (dead)", build: buildMonkeyTree },
  timberRail: { label: "Timber Rail", build: buildTimberRail },
  // Facades that close a splineTunnel's raw mouth (its walls/roof are
  // zero-thickness ribbons that otherwise end in a razor edge in mid-air).
  // Place as a `point` at the band's from/to arc position with offset 0 —
  // they're built symmetric about local Z, so the same prop works at an
  // entry mouth, an exit mouth and seen from inside. Sized for a nominal
  // PORTAL_SPAN x PORTAL_RISE bore; use scaleX/scaleY for a band whose
  // offset/height differ. Two shapes rather than one shape with two
  // textures, because the silhouette is what says which country it's in.
  tunnelPortalMountain: { label: "Tunnel Portal (mountain)", build: buildTunnelPortalMountain },
  tunnelPortalExpressway: { label: "Tunnel Portal (expressway)", build: buildTunnelPortalExpressway },
  // Giza Desert Raceway's Old Town facade — real 3D (not a cutout) because
  // it lines the Corkscrew within a couple of metres of the car. Collidable
  // like a barrier: the claustrophobic narrow street IS the wall. See
  // buildOldTownFacade for why this isn't just buildBuilding.
  buildingOldTown: { label: "Building (Old Town facade)", build: buildOldTownFacade },
  // Giza Desert Raceway hero landmarks — real 3D because both sit close
  // enough to the road to be seen edge-on (the Sphinx at Sphinx Sweep, the
  // market stall on the Corkscrew's barrier line). Neither is in
  // COLLIDABLE_BARRIER_TYPES: the Sphinx is a backdrop monument set back
  // beyond the runoff, the stall sits recessed against the building line.
  sphinx: { label: "The Sphinx", build: buildSphinx },
  marketStall: { label: "Market Stall", build: buildMarketStall },
  // Monaco Street Circuit kit. buildingRiviera is real 3D + collidable for
  // the same reason buildingOldTown is (lines the tight climbing streets
  // within a couple of metres of the car). casinoMonteCarlo is the one
  // genuinely grand building — a hero landmark placed as a single `point`,
  // never banded (see the singular-landmark rule). yacht/harbourCrane are
  // marina infrastructure — plural by nature, so bands/sparse points are
  // both fine — real 3D because the harbourfront puts them close enough to
  // read edge-on from the chase camera. None of the marina props are
  // collidable: they sit beyond the harbour wall, over the water.
  buildingRiviera: { label: "Building (Riviera facade)", build: buildRivieraFacade },
  casinoMonteCarlo: { label: "Casino de Monte-Carlo", build: buildCasino },
  yacht: { label: "Yacht", build: buildYacht },
  harbourCrane: { label: "Harbour Crane", build: buildHarbourCrane },
  // Plain flat square, positioned/sized with the same translate/scale gizmo
  // every other point already has (Object tab -> Select) — no footprint math,
  // just drag it where the water should be and stretch it to cover the bay.
  ocean: { label: "Ocean", build: buildOcean },
  billboard: { label: "Billboard", build: buildBillboard },
  // Rigged crowd figure (crowdEditor.html + src/crowd.js) — shares the
  // Cutout types' placement/facing machinery. Bands support multiple rows
  // (placeBand's rows/rowSpacing) for stadium-style depth.
  crowd: { label: "Crowd", build: buildCrowdFigure, billboard: true },
  splineBarrier: { label: "Spline Barrier", ribbon: true, buildRibbon: buildSplineBarrierRibbon },
  splineApexKerb: { label: "Spline Apex Kerb", ribbon: true, buildRibbon: buildSplineApexKerbRibbon },
  splineTarmac: { label: "Spline Tarmac", ribbon: true, buildRibbon: buildSplineTarmacRibbon },
  // Enclosing tunnel bore (walls + ceiling + a few interior lights) over a
  // band's from/to range — a real 3D structure, not a texture swap. It's a
  // single full-width structure, not a per-side thing, so bands using this
  // type should set side: "left" (one call); buildSplineTunnelRibbon ignores
  // the "right"/negative-sign call so an accidental side:"both" doesn't
  // double it up.
  splineTunnel: { label: "Spline Tunnel", ribbon: true, buildRibbon: buildSplineTunnelRibbon },
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
// A band's `offset`/`from`/`to` position each instance's ORIGIN, but what the
// driver sees — and expects to stop against — is its SURFACE, so both need
// the prop's own dimensions added back:
//   thick = origin -> road-facing surface, laterally. Ignoring it put the
//           wall a whole tire radius behind the visible tire stack.
//   reach = half-extent ALONG the track, i.e. how much further than the
//           band's from/to the props actually run.
// A tire stack is a 0.48 m circle in plan, so both are its radius; a guardrail
// is a thin 2.2 m beam; a ribbon is a zero-thickness strip drawn exactly over
// its own from/to range, so it needs neither.
const COLLIDABLE_BARRIER_TYPES = new Map([
  ["barrier", { thick: BARRIER_HALF_THICKNESS, reach: BARRIER_HALF_LENGTH }],
  ["splineBarrier", { thick: 0, reach: 0 }],
  ["tireBarrier", { thick: TIRE_RADIUS, reach: TIRE_RADIUS }],
  ["timberRail", { thick: TIMBER_HALF_THICKNESS, reach: TIMBER_HALF_LENGTH }],
  ["buildingOldTown", { thick: OLDTOWN_HALF_THICKNESS, reach: OLDTOWN_HALF_LENGTH }],
  ["buildingRiviera", { thick: RIVIERA_HALF_THICKNESS, reach: RIVIERA_HALF_LENGTH }],
]);

export function computeWallProfile(samples, length, bands, fallbackDist) {
  const N = samples.length;
  const left = new Float32Array(N).fill(fallbackDist);
  const right = new Float32Array(N).fill(fallbackDist);
  const ds = length / N; // samples are evenly arc-spaced (getSpacedPoints)

  // Curvature for the degeneracy test below, averaged over +-2 samples: the raw
  // per-sample value is a second difference across one ~0.85 m step and
  // underestimates radius by 15-20% through a tight apex, enough to fire that
  // test on estimator noise and mangle a perfectly valid barrier. NOT written
  // back into samples[].curv — vtAI, kerb runs and band spacing are all tuned
  // against the raw values.
  const SMOOTH = 2;
  const curvSmooth = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let k = -SMOOTH; k <= SMOOTH; k++) sum += samples[(((i + k) % N) + N) % N].curv;
    curvSmooth[i] = sum / (2 * SMOOTH + 1);
  }

  for (const band of bands) {
    const spec = COLLIDABLE_BARRIER_TYPES.get(band.type);
    if (!spec) continue;
    const offset = (band.offset ?? fallbackDist) - spec.thick;
    // The arc range this band's props actually OCCUPY: its own from/to grown
    // by each instance's half-extent along the track, because placeBand puts
    // instance CENTERS at from/to.
    const s0 = (band.from ?? 0) * length - spec.reach;
    const s1 = (band.to ?? 1) * length + spec.reach;
    // Narrow sample i only where its OWN arc falls inside that range. The wall
    // is piecewise-constant per sample, so a band boundary can't land
    // mid-sample; testing the sample's arc (its cell midpoint) bounds the error
    // to half a cell either way, versus a full cell for any rounding. Erring
    // toward including it would put invisible wall in open air; `reach` above is
    // what stops this from over-excluding the first/last instance.
    for (const sign of signsFor(band.side ?? "both")) {
      const arr = sign > 0 ? left : right;
      for (let k = Math.floor(s0 / ds) - 1; k <= Math.ceil(s1 / ds) + 1; k++) {
        const arcK = k * ds;
        if (arcK < s0 || arcK > s1) continue;
        const i = ((k % N) + N) % N;
        // A lateral offset only traces a sane parallel curve while it stays
        // under the local radius of curvature on the concave (inside) face —
        // push it past that and the offset curve folds back through the
        // center of curvature, so this band's `offset` stops meaning a
        // distance at all right there.
        //
        // CLAMP to the innermost still-sane parallel curve rather than skipping
        // the band: skipping fell back to the uniform margin, which is LOOSER
        // than the barrier, so collision switched off where it was needed most.
        // A degeneracy must never widen the wall.
        const concaveCurv = -sign * curvSmooth[i];
        const eff = concaveCurv > 0 ? Math.min(offset, 0.95 / concaveCurv) : offset;
        if (eff < arr[i]) arr[i] = eff;
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
  const yOffset = band.yOffset ?? 0;
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
        obj.position.y += yOffset; // manual vertical nudge for the whole band — same convention as a point's yOffset
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
// Meters between geometry samples along a ribbon. A ribbon is a chord chain,
// so on a corner's INSIDE face its chords bow away from the true offset curve
// while collision sits on the curve itself — which reads as the barrier
// standing slightly off the car at an apex. The bow is a sagitta, so it falls
// with the SQUARE of this: measured against the wall over Circuito di Roma's
// ribbon-backed samples, 1.5 m left 119 samples gapped by 1-2 cm (mean 3.4
// mm); 0.75 m leaves 2 (mean 1.5 mm) for ~4k more triangles and no extra draw
// calls (a ribbon is one mesh at any density). 0.5 m only reaches 1.1 mm for
// another 4k, so this is the knee. The 2 that remain are the start/finish seam,
// where the 3.95 and 4.30 ribbons overlap and the nearer one is correctly the
// wall — not faceting, and not fixable by sampling harder.
const RIBBON_STEP = 0.75;

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
  // band.tex opts into a differently-themed ribbon atlas (see
  // ASSETS.ribbonFolders) instead of the default shared "barrier" one —
  // same convention as splineTarmac's tex field, different lookup table.
  const atlas = getRibbonAtlas(band.tex ?? "barrier");
  const geo = ribbonWallGeometry(spline, fromS, toS, offset, CONFIG.track.wallHeight, atlas.count, tileLength, rng, sign < 0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: atlas.texture, roughness: 0.7, side: THREE.DoubleSide }));
  mesh.receiveShadow = mesh.castShadow = true;
  return mesh;
}

// Real enclosing tunnel bore: two solid concrete walls + a ceiling capping
// them, plus a handful of real interior point lights (the bore blocks
// sun/hemi, so without these it'd just go black). Ignores `sign` — this is
// one full-width structure regardless of how many times signsFor() calls it
// (see the "side: left" note on the OBJECT_TYPES entry above).
function buildSplineTunnelRibbon(spline, band, sign, rng) {
  const group = new THREE.Group();
  if (sign < 0) return group; // guards against an accidental side:"both" doubling the structure
  const fromS = (band.from ?? 0) * spline.length;
  const toS = (band.to ?? 1) * spline.length;
  const halfSpan = band.offset ?? (spline.wallDist ?? 3.5) + 0.5;
  const boreHeight = band.height ?? 4.6;
  const tileLength = Math.max(1, band.spacing ?? 5);

  const wallMat = new THREE.MeshStandardMaterial({ map: tunnelWallTexture(), roughness: 0.85, side: THREE.DoubleSide });
  for (const s of [1, -1]) {
    const geo = ribbonWallGeometry(spline, fromS, toS, halfSpan * s, boreHeight, 1, tileLength, rng, s < 0);
    const wall = new THREE.Mesh(geo, wallMat);
    wall.receiveShadow = wall.castShadow = true;
    group.add(wall);
  }

  const roofGeo = ribbonFlatGeometry(spline, fromS, toS, -halfSpan, halfSpan, boreHeight, 1 / tileLength);
  const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({
    map: tunnelCeilingTexture(), roughness: 0.9, side: THREE.DoubleSide,
  }));
  roof.receiveShadow = true;
  group.add(roof);

  // Sparse interior lighting along the bore's own length — independent of
  // any lamp band outside; a tunnel needs to light itself.
  const lightSpacing = Math.max(6, band.lightSpacing ?? 13);
  const len = toS - fromS;
  const n = Math.max(1, Math.round(len / lightSpacing));
  const pos = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    spline.posAt(fromS + (i / n) * len, 0, pos);
    const lightY = pos.y + boreHeight * 0.82;
    const light = new THREE.PointLight(0xffcf9a, 1.3, boreHeight * 3.4, 2);
    light.position.set(pos.x, lightY, pos.z);
    light.castShadow = false;
    group.add(light);
    const cone = buildLightCone(0xffcf9a, halfSpan * 0.5, lightY - pos.y, 0.09); // full height so the base touches the road, not hovering short of it
    cone.position.set(pos.x, lightY, pos.z);
    group.add(cone);
  }

  return group;
}

function buildSplineApexKerbRibbon(spline, band, sign) {
  const fromS = (band.from ?? 0) * spline.length;
  const toS = (band.to ?? 1) * spline.length;
  const halfW = CONFIG.track.kerbWidth / 2;
  const center = (band.offset ?? (spline.halfW ?? 0) + 0.3) * sign;
  const geo = ribbonFlatGeometry(spline, fromS, toS, center - halfW, center + halfW, 0.03, 0.5);
  // band.tex opts into a different kerb color scheme (kerbTexture's
  // `scheme` param, e.g. "yellow" for a mountain track's painted kerbs) --
  // same convention as splineTarmac/splineBarrier's own `tex` field.
  // Undefined -> kerbTexture()'s own default, so every existing track
  // (never sets this) keeps the red/white look unchanged.
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: kerbTexture(band.tex), roughness: 0.8 }));
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
    // DoubleSide: ribbonFlatGeometry winds faces up (for the common
    // ground-level road case, only ever seen from above) — but a
    // splineTarmac band can also be an elevated deck (an overpass on an
    // extraSpline) that a car drives underneath, which needs the underside
    // visible too. Trivial extra overdraw for a thin strip either way.
    const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95, side: THREE.DoubleSide });
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
  // yLift clears the base road mesh's own 0.02 lift (track.js's stripGeometry)
  // — an opaque overlay (cobble, dock, ...) sitting at that exact same height
  // z-fights it, so this needs to be visibly different, not just non-zero.
  const geo = ribbonFlatGeometry(spline, fromS, toS, center - w / 2, center + w / 2, mat.transparent ? 0.05 : 0.035, 1 / tile);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function placeRibbonBand(group, spline, band, rng, splineId, bandIndex) {
  const type = OBJECT_TYPES[band.type];
  for (const sign of signsFor(band.side ?? "both")) {
    const mesh = type.buildRibbon(spline, band, sign, rng);
    mesh.position.y += band.yOffset ?? 0; // manual vertical nudge — same field/convention as placeBand/placePoint, just unwired for ribbons until now
    mesh.userData.splineId = splineId; // same click-to-band-row identity as placeBand
    mesh.userData.bandIndex = bandIndex;
    mesh.userData.ribbon = true; // owns its geometry (instance types share cached geo) — editor live-refresh disposes accordingly
    group.add(mesh);
  }
}

// Bakes "how high is the ground here" into a small texture an Ocean point's
// shader samples to decide where waves actually break — the SAME height
// rule buildGroundGeometry's own vertices use (makeGroundSampler), just
// evaluated over the ocean mesh's own world footprint (+ margin) instead of
// the whole map. Re-baked on every full rebuild (Generate); a live gizmo
// drag between rebuilds just moves the existing bake, which is fine unless
// dragged well past the margin — same "Generate to make it authoritative"
// deal every other point already has.
const SHORE_TEX_RES = 96;
const SHORE_HEIGHT_RANGE = [-5, 25];
const SHORE_MARGIN = 30;
function bakeShoreTexture(spline, mesh) {
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const minX = box.min.x - SHORE_MARGIN, maxX = box.max.x + SHORE_MARGIN;
  const minZ = box.min.z - SHORE_MARGIN, maxZ = box.max.z + SHORE_MARGIN;
  const sample = makeGroundSampler(spline);
  const [rangeMin, rangeMax] = SHORE_HEIGHT_RANGE;
  const data = new Uint8Array(SHORE_TEX_RES * SHORE_TEX_RES);
  for (let iz = 0; iz < SHORE_TEX_RES; iz++) {
    const wz = minZ + ((maxZ - minZ) * iz) / (SHORE_TEX_RES - 1);
    for (let ix = 0; ix < SHORE_TEX_RES; ix++) {
      const wx = minX + ((maxX - minX) * ix) / (SHORE_TEX_RES - 1);
      const t = THREE.MathUtils.clamp((sample(wx, wz) - rangeMin) / (rangeMax - rangeMin), 0, 1);
      data[iz * SHORE_TEX_RES + ix] = Math.round(t * 255);
    }
  }
  const tex = new THREE.DataTexture(data, SHORE_TEX_RES, SHORE_TEX_RES, THREE.RedFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;

  const u = mesh.material.uniforms;
  u.uShoreTex.value?.dispose?.();
  u.uShoreTex.value = tex;
  u.uShoreMin.value.set(minX, minZ);
  u.uShoreSize.value.set(maxX - minX, maxZ - minZ);
  u.uRangeMin.value = rangeMin;
  u.uRangeMax.value = rangeMax;
}

// Places one def's worth of bands/points against one spline-like object —
// the main track (has wallDist/halfW) or a plain buildSpline() result for
// an extra spline (defaultBands() is the only thing that assumes
// wallDist/halfW, so it's never called for extra splines).
// Returns { group, billboards, waterMeshes } — billboards need per-frame
// camera-facing rotation from main.js/editor.js; waterMeshes (any placed
// "Ocean" point — see placeholders.js's buildOcean) need their shader's
// uTime uniform advanced each frame, same idea. splineId ("main" or
// extraSplines[].id) plus pointIndex/bandIndex is stamped onto each placed
// object's userData for the editor to map a clicked mesh back to its
// trackObjects entry (points get a transform gizmo, band instances select
// their band row); unused at race time.
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
  const waterMeshes = [];
  group.traverse((o) => { if (o.userData.animatedWater) waterMeshes.push(o); });
  for (const w of waterMeshes) bakeShoreTexture(spline, w);
  return { group, billboards, waterMeshes };
}

// Builds objects for the main track AND every def.extraSplines entry —
// what main.js/editor.js should call instead of buildTrackObjects directly,
// so extra-spline objects actually race, not just preview.
export function buildAllTrackObjects(def, track, rng) {
  const group = new THREE.Group();
  const billboards = [];
  const waterMeshes = [];
  const main = buildTrackObjects(def, track, rng, "main");
  group.add(main.group);
  billboards.push(...main.billboards);
  waterMeshes.push(...main.waterMeshes);
  for (const ex of def.extraSplines ?? []) {
    if (!ex.controlPoints || ex.controlPoints.length < 2) continue;
    const spline = buildSpline(ex.controlPoints, !!ex.closed, CONFIG.track.samples);
    // No defaultBands() fallback here (needs wallDist/halfW, which extra
    // splines don't have) — one with no trackObjects of its own places nothing.
    const trackObjects = ex.trackObjects ?? { bands: [], points: [] };
    const r = buildTrackObjects({ trackObjects }, spline, rng, ex.id);
    group.add(r.group);
    billboards.push(...r.billboards);
    waterMeshes.push(...r.waterMeshes);
  }
  return { group, billboards, waterMeshes };
}

// Per-frame hook (mirrors updateCrowdBillboard's own convention) — call from
// every render loop that owns a buildAllTrackObjects() result's waterMeshes:
// main.js's step(), editor.js's tick(), preview.html's animation loop.
export function updateOceanTime(waterMeshes, nowMs) {
  for (const w of waterMeshes) w.material.uniforms.uTime.value = nowMs / 1000;
}
