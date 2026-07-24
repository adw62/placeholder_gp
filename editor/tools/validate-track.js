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
//   geometry  corner radius vs road width, grade, self-crossing /
//             near-parallel sections (the track query is 2D — see
//             spline.js query() — so same-height crossings break physics)
//   objects   band/point types exist, ranges sane, splineTarmac `tex`
//             names a real file in assets/textures/road/, cutout folders
//             referenced by bands actually contain images
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
  "barrier", "apexKerb", "tireBarrier", "tree", "building", "billboard", "crowd",
  "splineBarrier", "splineApexKerb", "splineTarmac",
];
const RIBBON_TYPES = new Set(["splineBarrier", "splineApexKerb", "splineTarmac"]);
function spriteFolderKeys() {
  const src = fs.readFileSync(path.join(SHARED, "src/placeholders.js"), "utf8");
  const block = src.match(/spriteFolders:\s*\{([\s\S]*?)\n  \}/)?.[1] ?? "";
  return [...block.matchAll(/^\s*(\w+):\s*\{\s*folder:\s*"([^"]+)"/gm)].map((m) => ({ key: m[1], folder: m[2] }));
}
const SPRITES = spriteFolderKeys();
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
  constructor(label) { this.label = label; this.errors = []; this.warns = []; }
  err(msg) { this.errors.push(msg); }
  warn(msg) { this.warns.push(msg); }
  print() {
    const status = this.errors.length ? "FAIL" : this.warns.length ? "warn" : "ok";
    console.log(`[${status}] ${this.label}`);
    for (const e of this.errors) console.log(`   ERROR ${e}`);
    for (const w of this.warns) console.log(`   warn  ${w}`);
  }
}

function validPoint(p) {
  return Array.isArray(p) && (p.length === 2 || p.length === 3) && p.every((v) => Number.isFinite(v));
}

function checkGeometry(r, controlPoints, width, { closed = true, name = "main" } = {}) {
  const spline = buildSpline(controlPoints, closed, CONFIG.track.samples);
  const { samples, length } = spline;
  const halfW = width / 2;

  let maxCurv = 0, maxGrade = 0;
  for (const s of samples) {
    maxCurv = Math.max(maxCurv, Math.abs(s.curv));
    maxGrade = Math.max(maxGrade, Math.abs(s.t.y));
  }
  const minRadius = 1 / Math.max(maxCurv, 1e-9);
  if (minRadius < halfW)
    // Ships in a built-in track (Canyon Sprint) — the game tolerates the
    // local fold, it just z-fights at the pinch. Visual check, not a gate.
    r.warn(`${name}: min corner radius ${minRadius.toFixed(1)} m < half road width ${halfW} m — inner road edge folds at the pinch, check visually`);
  else if (minRadius < width)
    r.warn(`${name}: min corner radius ${minRadius.toFixed(1)} m < road width ${width} m — very tight hairpin, check the ribbon`);
  if (maxGrade > 0.55) r.err(`${name}: max grade ${(maxGrade * 100).toFixed(0)}% — near-vertical road`);
  else if (maxGrade > 0.28) r.warn(`${name}: max grade ${(maxGrade * 100).toFixed(0)}% — steeper than a real circuit ever gets`);

  if (closed) {
    // Self-proximity scan: pairs of samples far apart along the lap but close
    // in XZ. The track query (spline.js) is 2D, so a same-height crossing or
    // squeeze breaks wall collision / checkpoint attribution, not just looks.
    const N = samples.length;
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
  }
  checkTrackObjects(r, def.trackObjects, "main", track.length);

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
