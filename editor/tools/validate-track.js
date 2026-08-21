#!/usr/bin/env node
// =====================================================================
// Static lint for track/level definitions — catches what the editor lets
// you save but the game handles badly, before anyone drives it. Runs the
// game's own spline sampler (shared/src/spline.js + config.js import
// cleanly in Node; `three` resolves from editor/node_modules,
// pinned to the same 0.160.0 the import maps use).
//
//   node tools/validate-track.js <file.json | trackId> [more...]
//   node tools/validate-track.js --all         built-ins + every levels/*.json
//
// Exit 0 = no errors (warnings allowed), 1 = errors.
//
// Checks:
//   shape     required fields, types, medal ordering
//   drivable  grade vs. the grade the car can actually climb, and corner
//             radii vs. the radius above which everything is flat out —
//             both derived from CONFIG.physics, not from taste. This is the
//             check that would have caught Trial Mountain, which shipped
//             with 7% of its lap climbing steeper than the car can climb at
//             all, and not one corner tight enough to make a player lift.
//   geometry  corner radius vs road width, self-crossing / near-parallel
//             sections (the track query is 2D — see spline.js query() — so
//             same-height crossings break physics)
//   objects   band/point types exist, ranges sane, splineTarmac `tex`
//             names a real file in assets/textures/road/, cutout folders
//             referenced by bands actually contain images
//   scenery   depth layering: how many placement rules, how many distinct
//             types, and what spread of distances sit in each zone out from
//             the racing line (on-track / barrier line / behind barrier /
//             mid / far). Catches the other half of the Trial Mountain
//             failure — a bare horizon and a mid layer that was eight
//             identical pine bands at one offset.
//   ids       duplicate track ids across tracks.js + levels/
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpline } from "../../shared/src/spline.js";
import { CONFIG } from "../../shared/src/config.js";
import { TRACKS } from "../../game/src/tracks.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GAME = path.join(ROOT, "..", "game");
const SHARED = path.join(ROOT, "..", "shared");

// --- known placeable types: static list from trackObjects.js OBJECT_TYPES
// plus one cutout<Key> per spriteFolders entry, read from placeholders.js
// source (can't import it in Node — it builds canvas textures at module
// scope). Keep the static list in sync with trackObjects.js.
const STATIC_TYPES = [
  "barrier", "apexKerb", "tireBarrier", "tree", "building", "pillar", "lampTokyo", "billboard", "crowd",
  "rockOutcrop", "monkeyTree", "timberRail", "tunnelPortalMountain", "tunnelPortalExpressway",
  "buildingOldTown", "sphinx", "marketStall",
  "buildingRiviera", "casinoMonteCarlo", "yacht", "harbourCrane", "ocean",
  "splineBarrier", "splineApexKerb", "splineTarmac", "splineTunnel",
];
const RIBBON_TYPES = new Set(["splineBarrier", "splineApexKerb", "splineTarmac", "splineTunnel"]);
function spriteFolderKeys() {
  const src = fs.readFileSync(path.join(SHARED, "src/placeholders.js"), "utf8");
  const block = src.match(/spriteFolders:\s*\{([\s\S]*?)\n  \}/)?.[1] ?? "";
  return [...block.matchAll(/^\s*(\w+):\s*\{\s*folder:\s*"([^"]+)"/gm)].map((m) => ({ key: m[1], folder: m[2] }));
}
function ribbonFolderKeys() {
  const src = fs.readFileSync(path.join(SHARED, "src/placeholders.js"), "utf8");
  const block = src.match(/ribbonFolders:\s*\{([\s\S]*?)\n  \}/)?.[1] ?? "";
  return [...block.matchAll(/^\s*(\w+):\s*"([^"]+)"/gm)].map((m) => m[1]);
}
const SPRITES = spriteFolderKeys();
const RIBBON_ATLAS_KEYS = ribbonFolderKeys();
const KNOWN_TYPES = new Set([
  ...STATIC_TYPES,
  ...SPRITES.map(({ key }) => `cutout${key[0].toUpperCase()}${key.slice(1)}`),
]);
const ROAD_TEXTURES = fs.existsSync(path.join(GAME, "assets/textures/road"))
  ? fs.readdirSync(path.join(GAME, "assets/textures/road")).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).map((f) => f.replace(/\.\w+$/, ""))
  : [];

function loadAll() {
  const out = TRACKS.map((def) => ({ def, source: "tracks.js" }));
  const dir = path.join(GAME, "levels");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      try {
        const def = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        def.id ??= f.replace(/\.json$/i, ""); // same fallback levels.js applies
        out.push({ def, source: `levels/${f}` });
      } catch (e) {
        out.push({ def: null, source: `levels/${f}`, parseError: e.message });
      }
    }
  }
  return out;
}

class Report {
  constructor(label) { this.label = label; this.errors = []; this.warns = []; this.infos = []; }
  err(msg) { this.errors.push(msg); }
  warn(msg) { this.warns.push(msg); }
  // Measurements that aren't pass/fail on their own but that a track author
  // (human or agent) has to see to judge the layout — see the corner-rhythm
  // block in checkGeometry. Always printed, never affects exit status.
  info(msg) { this.infos.push(msg); }
  print() {
    const status = this.errors.length ? "FAIL" : this.warns.length ? "warn" : "ok";
    console.log(`[${status}] ${this.label}`);
    for (const e of this.errors) console.log(`   ERROR ${e}`);
    for (const w of this.warns) console.log(`   warn  ${w}`);
    for (const i of this.infos) console.log(`   info  ${i}`);
  }
}

// ---------------------------------------------------------------------
// The car this track has to be drivable BY, derived from CONFIG.physics so
// retuning the game retunes these checks (same principle drive-test.js's
// speed targets follow). All three numbers below are what separate a
// circuit from an undrivable or boring one, and none of them are guessable
// by eye from a control-point list:
//
//   vTop      flat-ground top speed. NOT CONFIG.physics.maxSpeed (a clamp
//             the car never reaches) — the real ceiling is where drive
//             force balances drag + rolling resistance.
//   gradeMax  the grade at which net accel hits zero: the car physically
//             cannot climb steeper, at any speed, ever. Momentum can carry
//             it over a short spike; a sustained stretch is a dead stop.
//   rFlatOut  corner radius whose grip-limited speed equals vTop. EVERY
//             corner gentler than this is taken at full throttle without
//             lifting — i.e. it is not a corner, it is a straight that
//             happens to bend. A track built entirely from these is the
//             "slow oval" failure mode however long or scenic it is.
// ---------------------------------------------------------------------
const P = CONFIG.physics;
const A_DRIVE = P.engineAccel / P.mass;
const CAR = (() => {
  const vTop = Math.sqrt(Math.max(0, (A_DRIVE - P.rollingResist) / P.dragK));
  const gradeMax = (A_DRIVE - P.rollingResist) / (9.81 * P.slopeGravity);
  // lateral capacity rises with downforce, so solve v² = r·μ·(g + df·v²) for v
  const vCorner = (radius) => {
    const k = 1 - radius * P.mu * P.downforce;
    return k <= 0 ? Infinity : Math.sqrt((radius * P.mu * 9.81) / k);
  };
  let lo = 0.5, hi = 1e4;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (vCorner(m) < vTop) lo = m; else hi = m; }
  return { vTop, gradeMax, rFlatOut: (lo + hi) / 2, vCorner, latCap: (v) => P.mu * (9.81 + P.downforce * v * v) };
})();

// Speed the car can hold indefinitely on a constant grade (0 = can't climb).
const sustainableOnGrade = (grade) => {
  const x = (A_DRIVE - P.rollingResist - 9.81 * P.slopeGravity * grade) / P.dragK;
  return x <= 0 ? 0 : Math.sqrt(x);
};

// Box-filter an arc-spaced per-sample series over `metres` of track. Raw
// per-sample grade/curvature is a difference over one ~0.85 m step and is
// noisy enough to trip any threshold on estimator error alone (the same
// reason barriers.js and computeWallProfile smooth before using curvature) —
// what matters for drivability is the grade the car spends real distance on.
function smoothRing(arr, ds, metres, closed) {
  const n = arr.length;
  const m = Math.max(1, Math.round(metres / ds / 2));
  const idx = closed
    ? (i) => ((i % n) + n) % n
    : (i) => Math.min(n - 1, Math.max(0, i));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -m; k <= m; k++) sum += arr[idx(i + k)];
    out[i] = sum / (2 * m + 1);
  }
  return out;
}

function validPoint(p) {
  return Array.isArray(p) && (p.length === 2 || p.length === 3) && p.every((v) => Number.isFinite(v));
}

function checkGeometry(r, controlPoints, width, { closed = true, name = "main" } = {}) {
  const spline = buildSpline(controlPoints, closed, CONFIG.track.samples);
  const { samples, length } = spline;
  const halfW = width / 2;

  const N = samples.length;
  const ds = length / N;

  let maxCurv = 0;
  for (const s of samples) maxCurv = Math.max(maxCurv, Math.abs(s.curv));
  const minRadius = 1 / Math.max(maxCurv, 1e-9);
  if (minRadius < halfW)
    // Ships in a built-in track (Canyon Sprint) — the game tolerates the
    // local fold, it just z-fights at the pinch. Visual check, not a gate.
    r.warn(`${name}: min corner radius ${minRadius.toFixed(1)} m < half road width ${halfW} m — inner road edge folds at the pinch, check visually`);
  else if (minRadius < width)
    r.warn(`${name}: min corner radius ${minRadius.toFixed(1)} m < road width ${width} m — very tight hairpin, check the ribbon`);

  // ---- grade vs. what the car can actually climb ----
  // The old check gated on a "real circuits aren't this steep" aesthetic
  // threshold (warn 28%, error 55%) and let Trial Mountain ship with 13% of
  // its lap above the car's hard no-climb ceiling: a warning nobody acted on.
  // Gate on the physics instead, measured over a distance the car has to
  // actually cover rather than a one-sample spike.
  const grade = smoothRing(samples.map((s) => s.t.y), ds, 20, closed);
  let maxClimb = 0, maxDrop = 0, overCeiling = 0, overHalf = 0;
  for (let i = 0; i < N; i++) {
    maxClimb = Math.max(maxClimb, grade[i]);
    maxDrop = Math.min(maxDrop, grade[i]);
    if (grade[i] > CAR.gradeMax) overCeiling++;
    if (Math.abs(grade[i]) > CAR.gradeMax * 0.5) overHalf++;
  }
  const pctCeiling = (overCeiling / N) * 100;
  const ceilPct = (CAR.gradeMax * 100).toFixed(0);
  if (overCeiling > 0)
    r.err(
      `${name}: ${pctCeiling.toFixed(0)}% of the lap climbs steeper than the car can climb at all ` +
      `(peak ${(maxClimb * 100).toFixed(0)}% sustained over 20 m; hard ceiling ${ceilPct}%) — the car stops dead there`
    );
  else if (maxClimb > CAR.gradeMax * 0.55)
    r.warn(
      `${name}: peak sustained climb ${(maxClimb * 100).toFixed(0)}% holds the car to ` +
      `${sustainableOnGrade(maxClimb).toFixed(1)} m/s (${((sustainableOnGrade(maxClimb) / CAR.vTop) * 100).toFixed(0)}% of top speed) — reads as a crawl`
    );
  if (overHalf / N > 0.15 && overCeiling === 0)
    r.warn(`${name}: ${((overHalf / N) * 100).toFixed(0)}% of the lap is steeper than ${(CAR.gradeMax * 50).toFixed(0)}% — sustained gradient dominates the lap over cornering`);
  if (maxDrop < -CAR.gradeMax)
    r.warn(`${name}: peak descent ${(maxDrop * 100).toFixed(0)}% exceeds ${ceilPct}% — gravity outruns the drag limit, the car arrives at the next corner far over its cornering speed`);

  // ---- corner rhythm: is there anything to drive here? ----
  // Only meaningful for the racing line itself; extra splines are scenery.
  if (name === "main" && closed) {
    const curvS = smoothRing(samples.map((s) => s.curv), ds, 4, closed);
    const radii = Array.from(curvS, (c) => 1 / Math.max(1e-6, Math.abs(c)));
    // Cornering-limited speed, then a backward braking sweep — the same
    // construction track.js uses to build its AI target-speed table, so this
    // measures the line the game itself plans, not a theoretical ideal.
    const vt = radii.map((rad) => Math.min(CAR.vTop, CAR.vCorner(rad)));
    for (let pass = 0; pass < 3; pass++)
      for (let i = N - 1; i >= 0; i--) {
        const j = (i + 1) % N;
        vt[i] = Math.min(vt[i], Math.sqrt(vt[j] * vt[j] + 2 * (P.brakeDecel / P.mass) * ds));
      }
    // Fraction of the car's lateral grip in use at that planned speed: this,
    // not corner count or lap length, is what "the track is fun to drive"
    // reduces to — the player wants to be near the limit, not coasting.
    let working = 0, limit = 0, idle = 0, corners = 0, inCorner = false;
    for (let i = 0; i < N; i++) {
      const u = (vt[i] * vt[i]) / radii[i] / CAR.latCap(vt[i]);
      if (u >= 0.5) working++;
      if (u >= 0.7) limit++;
      if (u < 0.25) idle++;
      const c = u >= 0.4;
      if (c && !inCorner) corners++;
      inCorner = c;
    }
    const km = length / 1000;
    r.info(
      `${name}: corner rhythm — ${((working / N) * 100).toFixed(0)}% of the lap at >=50% lateral grip, ` +
      `${((limit / N) * 100).toFixed(0)}% at >=70%, ${((idle / N) * 100).toFixed(0)}% coasting <25%; ` +
      `${(corners / km).toFixed(1)} corners/km; tightest radius ${minRadius.toFixed(0)} m ` +
      `(flat-out above ${CAR.rFlatOut.toFixed(0)} m)`
    );
    if (minRadius > CAR.rFlatOut)
      r.err(
        `${name}: no corner on the lap is tighter than ${CAR.rFlatOut.toFixed(0)} m radius (tightest is ${minRadius.toFixed(0)} m) — ` +
        `the whole track is flat out, the player never lifts or turns near the limit`
      );
    else if (working / N < 0.10)
      r.warn(
        `${name}: only ${((working / N) * 100).toFixed(0)}% of the lap loads the tyres past half grip ` +
        `(Circuito di Roma 20%, Shuto Loop 21%) — mostly straights and gentle sweepers`
      );
    if (corners / km < 8)
      r.warn(`${name}: ${(corners / km).toFixed(1)} corners/km (Roma 24, Shuto 21) — long featureless stretches between events`);
  }

  if (closed) {
    // Self-proximity scan: pairs of samples far apart along the lap but close
    // in XZ. The track query (spline.js) is 2D, so a same-height crossing or
    // squeeze breaks wall collision / checkpoint attribution, not just looks.
    const wallDist = halfW + CONFIG.track.wallMargin;
    let worst = null;
    for (let i = 0; i < N; i++) {
      const a = samples[i];
      for (let j = i + 1; j < N; j++) {
        const along = Math.min(samples[j].arc - a.arc, length - (samples[j].arc - a.arc));
        if (along < width * 4) continue; // neighbours on the same stretch
        const dx = a.p.x - samples[j].p.x, dz = a.p.z - samples[j].p.z;
        const d = Math.hypot(dx, dz);
        if (d < 2 * wallDist && (!worst || d < worst.d))
          worst = { d, dy: Math.abs(a.p.y - samples[j].p.y), i, j };
      }
    }
    if (worst) {
      const at = `samples ${worst.i}/${worst.j}, ${worst.d.toFixed(1)} m apart in XZ`;
      if (worst.d < width && worst.dy < 4)
        r.err(`${name}: track crosses/touches itself at same height (${at}, Δy ${worst.dy.toFixed(1)} m) — 2D track query can't tell the branches apart`);
      else if (worst.dy >= 4)
        r.warn(`${name}: overpass detected (${at}, Δy ${worst.dy.toFixed(1)} m) — renders, but resets/spawns near it may snap to the wrong branch`);
      else
        r.warn(`${name}: two sections run closer than barrier spacing (${at}) — barriers may interleave`);
    }
  }
  return spline;
}

// ---------------------------------------------------------------------
// Scenery depth layers. A track can pass every geometric check and still
// look flat and cheap, and the reason is almost always the same: everything
// is placed in one or two distance bands, one object type per band, at a
// single offset with no size variation — so the eye reads a corridor of
// repeated identical props with bare sky behind it. Trial Mountain's mid
// layer was eight cutoutPine bands ALL at exactly 17 m and nothing at all
// beyond; Circuito di Roma spreads 9 distinct types over 7-12 m behind the
// barrier alone, and carries a horizon out to 79 m.
//
// Distance is measured from the RACING LINE, not from whichever spline a
// band hangs off: an extraSpline's own `offset` is relative to that spline,
// which may itself sit 40 m away, so bucketing on `offset` alone silently
// files far-layer scenery as trackside.
// ---------------------------------------------------------------------
const ZONES = ["on-track", "barrier line", "behind barrier", "mid", "far"];

function checkSceneryLayers(r, def, track) {
  const halfW = def.width / 2;
  const wall = halfW + CONFIG.track.wallMargin;
  const zoneOf = (off) =>
    off <= halfW + 0.5 ? ZONES[0]
    : off <= wall + 1.5 ? ZONES[1]
    : off <= wall + 8 ? ZONES[2]
    : off <= wall + 20 ? ZONES[3] : ZONES[4];

  const buckets = new Map(ZONES.map((z) => [z, []]));
  const add = (type, off, o) => {
    if (!type) return;
    const scaled = [o.scaleX, o.scaleY, o.scaleZ].some((v) => v != null && v !== 1);
    buckets.get(zoneOf(off)).push({ type, off, scaled, jitter: !!o.jitter });
  };
  for (const b of def.trackObjects?.bands ?? []) add(b.type, Math.abs(b.offset ?? wall), b);
  for (const p of def.trackObjects?.points ?? []) add(p.type, Math.abs(p.offset ?? wall), p);

  // Closest approach of each extra spline to the racing line, so its bands
  // land in the zone the player actually sees them in.
  for (const ex of def.extraSplines ?? []) {
    if (!Array.isArray(ex.controlPoints) || ex.controlPoints.length < 2) continue;
    if (!ex.controlPoints.every(validPoint)) continue;
    const xs = buildSpline(ex.controlPoints, !!ex.closed, 120);
    let base = Infinity;
    for (const s of xs.samples)
      for (const m of track.samples) {
        const dx = s.p.x - m.p.x, dz = s.p.z - m.p.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < base) base = d2;
      }
    base = Math.sqrt(base);
    for (const b of ex.trackObjects?.bands ?? []) add(b.type, base + Math.abs(b.offset ?? 0), b);
    for (const p of ex.trackObjects?.points ?? []) add(p.type, base + Math.abs(p.offset ?? 0), p);
  }

  const total = [...buckets.values()].reduce((n, v) => n + v.length, 0);
  const km = track.length / 1000;
  r.info(
    `scenery layers (rules | distinct types | metres spanned): ` +
    ZONES.map((z) => {
      const v = buckets.get(z);
      if (!v.length) return `${z} EMPTY`;
      const lo = Math.min(...v.map((x) => x.off)), hi = Math.max(...v.map((x) => x.off));
      return `${z} ${v.length}|${new Set(v.map((x) => x.type)).size}t|${lo.toFixed(0)}-${hi.toFixed(0)}m`;
    }).join("  ") + `  — ${(total / km).toFixed(0)} rules/km`
  );

  if (!buckets.get("far").length)
    r.warn(`scenery: no FAR layer (nothing beyond ${(wall + 20).toFixed(0)} m from the racing line) — the horizon is bare sky. Place static:true backdrop cutouts on extraSplines set well back`);
  if (buckets.get("behind barrier").length + buckets.get("mid").length < 4)
    r.warn(`scenery: almost nothing between the barrier and the horizon — the track reads as a corridor with a painted backdrop. Legitimate for a walled-in setting (Shuto Loop is an elevated expressway); say so in the hand-off if you keep it`);
  for (const z of ZONES) {
    const v = buckets.get(z);
    if (v.length < 3) continue;
    const types = new Set(v.map((x) => x.type));
    if (types.size < 2)
      r.warn(`scenery: the ${z} layer is ${v.length}x "${[...types][0]}" and nothing else — one repeated object reads as wallpaper; mix types`);
    // Only meaningful outside the structural zones: the road surface and the
    // barrier line ARE at fixed distances by definition (a guardrail runs at
    // one offset — that's what a guardrail is). Past the barrier, everything
    // sharing one offset is the "wall of identical pines" failure.
    if (z !== "on-track" && z !== "barrier line") {
      const lo = Math.min(...v.map((x) => x.off)), hi = Math.max(...v.map((x) => x.off));
      if (hi - lo < 1.5)
        r.warn(`scenery: every ${z} rule sits at ${lo.toFixed(1)} m — a flat wall of props at one distance; stagger the offsets across the zone`);
    }
    if (!v.some((x) => x.scaled) && !v.some((x) => x.jitter) && z !== "on-track")
      r.warn(`scenery: no scale or jitter variation anywhere in the ${z} layer — identical props on a perfect grid`);
  }
  // 30 is the floor, not the aim: Shuto Loop sits at 34 and is deliberately
  // repetitive, so anything under it is thin by any standard. Aim for 40+.
  if (total / km < 30)
    r.warn(`scenery: ${(total / km).toFixed(0)} placement rules/km — thin dressing (Roma 146, Shuto 34, aim for 40+). Bands are cheap; this counts authored variety, not object count`);
}

function checkTrackObjects(r, trackObjects, where, splineLength) {
  for (const [i, band] of (trackObjects?.bands ?? []).entries()) {
    const at = `${where} band[${i}] (${band.type})`;
    if (!KNOWN_TYPES.has(band.type)) { r.err(`${at}: unknown type`); continue; }
    for (const k of ["from", "to"]) {
      const v = band[k];
      // from/to are lap fractions; a closed spline wraps, and the editor
      // exports values slightly past 1 on purpose (Rome does) — only flag
      // clearly-wrong values.
      if (v !== undefined && (typeof v !== "number" || v < -0.5 || v > 1.5)) r.err(`${at}: ${k}=${v} far outside 0..1`);
    }
    if ((band.from ?? 0) > (band.to ?? 1)) r.warn(`${at}: from > to — places nothing`);
    if (band.spacing !== undefined && band.spacing < 0.5) r.warn(`${at}: spacing ${band.spacing} clamps to 0.5`);
    if (band.side !== undefined && !["left", "right", "both"].includes(band.side)) r.err(`${at}: side "${band.side}" not left/right/both`);
    if (band.type === "splineTarmac") {
      const tex = band.tex ?? "asphalt";
      if (!ROAD_TEXTURES.includes(tex))
        r.err(`${at}: tex "${tex}" not in assets/textures/road/ (have: ${ROAD_TEXTURES.join(", ") || "none"})`);
    }
    if (band.type === "splineBarrier" && band.tex !== undefined && !RIBBON_ATLAS_KEYS.includes(band.tex))
      r.err(`${at}: tex "${band.tex}" not in ASSETS.ribbonFolders (have: ${RIBBON_ATLAS_KEYS.join(", ") || "none"})`);
    if (band.type === "splineTunnel" && band.side !== undefined && band.side !== "left")
      r.warn(`${at}: splineTunnel is a single full-width structure — side should be "left" (a "both"/"right" call is a no-op or a duplicate build, not a second wall)`);
    const m = band.type.match(/^cutout(\w)(\w*)$/);
    if (m) {
      const key = m[1].toLowerCase() + m[2];
      const spec = SPRITES.find((s) => s.key === key);
      const dir = spec && path.join(GAME, spec.folder);
      if (dir && (!fs.existsSync(dir) || !fs.readdirSync(dir).some((f) => /\.(png|jpe?g|webp)$/i.test(f))))
        r.warn(`${at}: sprite folder ${spec.folder} has no images — renders the labeled-card placeholder`);
    }
  }
  for (const [i, pt] of (trackObjects?.points ?? []).entries()) {
    const at = `${where} point[${i}] (${pt.type})`;
    if (!KNOWN_TYPES.has(pt.type)) { r.err(`${at}: unknown type`); continue; }
    if (RIBBON_TYPES.has(pt.type)) r.err(`${at}: ribbon types are band-only (need a from/to range)`);
    // point s is arc distance in METERS (unlike band from/to fractions) —
    // see trackObjects.js placePoint: spline.posAt(pt.s ?? 0, ...)
    if (pt.s !== undefined && (typeof pt.s !== "number" || !Number.isFinite(pt.s) || pt.s < 0)) r.err(`${at}: s=${pt.s} — need meters ≥ 0`);
    else if (splineLength && pt.s > splineLength)
      r.warn(`${at}: s=${pt.s.toFixed(0)} m beyond spline length ${splineLength.toFixed(0)} m — wraps on a closed spline, clamps to the end on an open one`);
  }
}

function validate(def, source, allIds) {
  const r = new Report(`${def?.name ?? "?"} (${def?.id ?? "?"}) — ${source}`);
  if (!def) return r;

  // --- shape ---
  if (!def.id) r.err("missing id");
  if (!def.name) r.warn("missing name");
  if (!Number.isInteger(def.laps) || def.laps < 1) r.err(`laps=${def.laps} — need integer ≥ 1`);
  if (typeof def.width !== "number" || def.width < 4 || def.width > 40)
    r.err(`width=${def.width} — expected 4..40 m`);
  const m = def.medalAvgSpeed;
  if (!m) r.warn("missing medalAvgSpeed — results screen has no medals");
  else if (!(m.gold > m.silver && m.silver > m.bronze)) r.err("medalAvgSpeed must order gold > silver > bronze");
  if (!Array.isArray(def.controlPoints) || def.controlPoints.length < 4)
    r.err(`controlPoints: need ≥ 4, got ${def.controlPoints?.length ?? 0}`);
  else if (!def.controlPoints.every(validPoint)) r.err("controlPoints: every point must be [x,y,z] finite numbers");
  if (allIds.filter((x) => x === def.id).length > 1) r.err(`duplicate track id "${def.id}"`);
  if (r.errors.length) return r; // geometry checks need a sane def

  // --- geometry + objects ---
  const track = checkGeometry(r, def.controlPoints, def.width);
  if (def.medalAvgSpeed) {
    const lapAtGold = track.length / def.medalAvgSpeed.gold;
    if (lapAtGold < 15) r.warn(`gold medal pace = ${lapAtGold.toFixed(0)} s/lap — suspiciously short lap or high target`);
    // A medal target above the car's own drag-limited top speed can't be met
    // even flat out for the entire race with zero cornering. Checked here
    // rather than up in the shape block so it can't early-return past the
    // geometry checks. drive-test.js reports the pace actually achievable.
    if (def.medalAvgSpeed.gold > CAR.vTop)
      r.err(`medalAvgSpeed.gold ${def.medalAvgSpeed.gold} m/s exceeds the car's flat-ground top speed ${CAR.vTop.toFixed(1)} m/s — unwinnable at any skill`);
  }
  // theme.ground is the ONE theme color that must be a CSS STRING: it goes
  // straight to canvas ctx.fillStyle in grassTexture/desertTexture
  // (shared/src/placeholders.js), which silently ignores a non-color value and
  // leaves the terrain pure BLACK. Every other theme color goes through
  // THREE.Color and takes a 0xRRGGBB number happily, so this is very easy to
  // get wrong — Trial Mountain shipped with a black world exactly this way,
  // and the schema used to document `ground` as a number.
  if (def.theme?.ground !== undefined && typeof def.theme.ground !== "string")
    r.err(`theme.ground must be a CSS color string (e.g. "#4c7a3f"), got ${typeof def.theme.ground} ${def.theme.ground} — a number is ignored by ctx.fillStyle and renders the ground black`);
  checkTrackObjects(r, def.trackObjects, "main", track.length);
  checkSceneryLayers(r, def, track);

  const exIds = new Set();
  for (const [i, ex] of (def.extraSplines ?? []).entries()) {
    const at = `extraSplines[${i}]`;
    if (!ex.id) r.err(`${at}: missing id`);
    else if (exIds.has(ex.id)) r.err(`${at}: duplicate spline id "${ex.id}"`);
    exIds.add(ex.id);
    if (!Array.isArray(ex.controlPoints) || ex.controlPoints.length < 2)
      r.err(`${at}: need ≥ 2 controlPoints`);
    else if (!ex.controlPoints.every(validPoint)) r.err(`${at}: bad controlPoints`);
    else {
      const exSpline = buildSpline(ex.controlPoints, !!ex.closed, CONFIG.track.samples);
      checkTrackObjects(r, ex.trackObjects, at, exSpline.length);
    }
  }
  return r;
}

// --- CLI ---
const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: validate-track.js <file.json|trackId> [...] | --all");
  process.exit(2);
}
const everything = loadAll();
const allIds = everything.filter((e) => e.def).map((e) => e.def.id);

let targets;
if (args.includes("--all")) targets = everything;
else
  targets = args.map((a) => {
    if (fs.existsSync(a)) {
      try {
        const def = JSON.parse(fs.readFileSync(a, "utf8"));
        def.id ??= path.basename(a).replace(/\.json$/i, "");
        return { def, source: a };
      } catch (e) {
        return { def: null, source: a, parseError: e.message };
      }
    }
    return everything.find((e) => e.def?.id === a) ?? { def: null, source: a, parseError: "no such file or track id" };
  });

let failed = false;
for (const t of targets) {
  if (t.parseError) {
    console.log(`[FAIL] ${t.source}\n   ERROR ${t.parseError}`);
    failed = true;
    continue;
  }
  const r = validate(t.def, t.source, allIds);
  r.print();
  if (r.errors.length) failed = true;
}
process.exit(failed ? 1 : 0);
