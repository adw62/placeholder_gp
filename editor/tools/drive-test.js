#!/usr/bin/env node
// =====================================================================
// Headless completability test: laps a track with the game's REAL physics
// (game/src/physics.js CarPhysics + collideWithBarriers, imported directly;
// substepped at 240 Hz exactly like main.js) under a simple pure-pursuit
// driver. Proves a generated track can actually be driven — and reports
// achieved pace vs its medalAvgSpeed targets — before a human ever loads it.
//
//   node tools/drive-test.js <trackId|file.json> [--laps 2] [--aggression 0.85] [--verbose]
//
// The driver is deliberately modest (no trail-braking, no line optimization):
// if IT can lap cleanly, a player can. Speed targets derive from the actual
// physics params (grip / drag / brake force), so retuning config.js retunes
// the test for free. Car-specific physics presets (ASSETS.carModels[].physics)
// are NOT applied — placeholders.js can't import under Node (canvas at module
// scope); baseline CONFIG.physics only until car kits move physics into data.
//
// Exit 0 = finished all laps; 1 = stuck/timeout/spun beyond recovery.
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { buildSpline } from "../../shared/src/spline.js";
import { CONFIG } from "../../shared/src/config.js";
import { TRACKS } from "../../game/src/tracks.js";
import { CarPhysics, collideWithBarriers } from "../../game/src/physics.js";
import { buildBarriers } from "../../shared/src/barriers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- CLI ---
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const LAPS = Number(opt("laps", 2));
const AGGR = Number(opt("aggression", 0.85)); // fraction of theoretical grip the driver plans for
const VERBOSE = args.includes("--verbose");
if (!target) {
  console.error("usage: drive-test.js <trackId|file.json> [--laps 2] [--aggression 0.85] [--verbose]");
  process.exit(2);
}

// --- load def (same sources as the game: tracks.js + levels/) ---
function loadDef(t) {
  if (fs.existsSync(t)) {
    const def = JSON.parse(fs.readFileSync(t, "utf8"));
    def.id ??= path.basename(t).replace(/\.json$/i, "");
    return def;
  }
  const hit = TRACKS.find((d) => d.id === t);
  if (hit) return hit;
  const dir = path.join(ROOT, "..", "game/levels");
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : []) {
    try {
      const def = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      def.id ??= f.replace(/\.json$/i, "");
      if (def.id === t) return def;
    } catch {}
  }
  throw new Error(`no track "${t}" in tracks.js, levels/, or on disk`);
}

const def = loadDef(target);
const N = CONFIG.track.samples;
const ncp = CONFIG.track.checkpoints;
const spline = buildSpline(def.controlPoints, true, N);
const halfW = def.width / 2;
const wallDist = halfW + CONFIG.track.wallMargin;
// Collision is against world-space barrier segments now (shared/src/barriers.js).
// This tool models a uniform margin — no trackObjects/barrier-band profile — so
// every sample reports the same distance.
const barriers = buildBarriers(spline, () => wallDist);
const segScratch = [];
const track = { ...spline, halfW, wallDist };

// --- target-speed table from the live physics params (same structure as
// track.js's vtAI: cornering limit + backward braking pass) ---
const P = CONFIG.physics;
const G = 9.81;
const latA = P.mu * G * AGGR;
const vDragMax = Math.sqrt(Math.max(1, (P.engineAccel / P.mass - P.rollingResist) / P.dragK));
const aBrake = (P.brakeDecel / P.mass) * 0.8;
const ds = spline.length / N;
const vt = new Float32Array(N);
for (let i = 0; i < N; i++)
  vt[i] = Math.min(vDragMax, P.maxSpeed, Math.sqrt(latA / Math.max(1e-4, Math.abs(spline.samples[i].curv))));
for (let pass = 0; pass < 3; pass++)
  for (let i = N - 1; i >= 0; i--) {
    const j = (i + 1) % N;
    vt[i] = Math.min(vt[i], Math.sqrt(vt[j] * vt[j] + 2 * aBrake * ds));
  }

// --- car at the start line, facing down-road ---
const car = new CarPhysics();
const p0 = new THREE.Vector3();
spline.posAt(2, 0, p0);
const t0 = spline.samples[Math.floor((2 / spline.length) * N)].t;
car.reset(p0, Math.atan2(t0.x, t0.z));

// --- sim loop (mirrors main.js step(): surface pick, 240 Hz substeps,
// wall collision per substep) ---
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const look = new THREE.Vector3();
const dt = 1 / 60;
const budget = (LAPS + 1) * (spline.length / 3.5); // generous: fail only if truly stuck
let lastIdx = null, cp = 0, lapsDone = 0, raceT = 0, lapStartT = 0;
const lapTimes = [];
let wallHits = 0, maxImpact = 0, offroadT = 0, topSpeed = 0;
let stuckT = 0, recoveries = 0, reverseUntil = -1;
let failed = null;

while (lapsDone < LAPS && raceT < budget) {
  let q = track.queryProjected(car.pos, lastIdx);
  lastIdx = q.idx;
  const arc = spline.samples[q.idx].arc;

  // driver: chase a point down the racing line, speed from the vt table
  const ahead = Math.max(5, car.speed * 0.55);
  spline.posAt(arc + ahead, 0, look);
  const err = wrapAngle(Math.atan2(look.x - car.pos.x, look.z - car.pos.z) - car.heading);
  let input;
  if (raceT < reverseUntil) {
    // unstick: back straight up, then resume
    input = { throttle: 0, brake: 1, steer: 0, handbrake: 0 };
  } else {
    const vTarget = vt[q.idx];
    input = {
      steer: Math.max(-1, Math.min(1, err * 2.2)),
      throttle: car.vLong < vTarget ? 1 : 0,
      brake: car.vLong > vTarget * 1.06 ? 1 : 0,
      handbrake: 0,
    };
  }

  const onRoad = Math.abs(q.lateral) <= halfW + CONFIG.track.kerbWidth;
  if (!onRoad) offroadT += dt;
  const off = P.offroad;
  const surface = onRoad
    ? { grip: 1, drag: 0, power: 1, slope: q.s.t.y }
    : { grip: off.grip, drag: off.drag, power: off.power, slope: q.s.t.y };

  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    car.update(h, input, surface);
    q = track.queryProjected(car.pos, lastIdx);
    lastIdx = q.idx;
    const impact = collideWithBarriers(car, barriers, segScratch);
    if (impact > 2.5) {
      wallHits++;
      maxImpact = Math.max(maxImpact, impact);
    }
  }
  topSpeed = Math.max(topSpeed, car.speed);

  // checkpoints & laps — same region logic as main.js
  const region = Math.floor(q.idx / (N / ncp)) % ncp;
  const expect = (cp + 1) % ncp;
  if (region === expect) {
    cp = expect;
    if (expect === 0) {
      lapTimes.push(raceT - lapStartT);
      lapStartT = raceT;
      lapsDone++;
      if (VERBOSE) console.log(`  lap ${lapsDone}: ${lapTimes.at(-1).toFixed(1)} s`);
    }
  }

  // stuck detection: pointing the wrong way against a wall etc.
  if (car.speed < 0.8 && raceT > 3 && raceT >= reverseUntil) {
    stuckT += dt;
    if (stuckT > 4) {
      recoveries++;
      stuckT = 0;
      if (recoveries > 5) { failed = "stuck beyond recovery (5 reverse attempts)"; break; }
      reverseUntil = raceT + 2.2;
    }
  } else if (car.speed > 2) stuckT = 0;

  raceT += dt;
}
if (!failed && lapsDone < LAPS) failed = `timeout after ${raceT.toFixed(0)} s sim time (${lapsDone}/${LAPS} laps)`;

// --- report ---
console.log(`${def.name ?? def.id} — ${spline.length.toFixed(0)} m, ${LAPS} lap test (aggression ${AGGR})`);
for (const [i, t] of lapTimes.entries())
  console.log(`  lap ${i + 1}: ${t.toFixed(1)} s  (avg ${(spline.length / t).toFixed(1)} m/s)`);
console.log(`  top speed ${topSpeed.toFixed(1)} m/s (drag-limited max ≈ ${vDragMax.toFixed(1)}), wall hits ${wallHits}${wallHits ? ` (max ${maxImpact.toFixed(1)} m/s)` : ""}, offroad ${(offroadT).toFixed(1)} s, recoveries ${recoveries}`);
if (def.medalAvgSpeed && lapTimes.length) {
  const best = spline.length / Math.min(...lapTimes);
  const m = def.medalAvgSpeed;
  const medal = best >= m.gold ? "GOLD" : best >= m.silver ? "SILVER" : best >= m.bronze ? "BRONZE" : "no medal";
  console.log(`  medal pace: bot best ${best.toFixed(1)} m/s vs gold ${m.gold} / silver ${m.silver} / bronze ${m.bronze} → ${medal}`);
  if (best < m.bronze) console.log(`  note: bot under bronze — targets may be too high for this layout (or it needs a better line)`);
  if (best >= m.gold) console.log(`  note: modest bot reaches gold — targets are probably too soft`);
}
if (failed) {
  console.log(`  VERDICT: FAIL — ${failed}`);
  process.exit(1);
}
console.log(`  VERDICT: ${wallHits === 0 && recoveries === 0 ? "clean" : recoveries === 0 ? "completable (some wall contact)" : "completable (needed unstick reversing)"}`);
