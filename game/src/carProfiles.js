// =====================================================================
// Car physics baseline + file-based tuning profiles.
//
// A car's live physics is layered:
//   1. CODE_DEFAULTS — every path the tuning lab exposes, snapshotted at
//      import time (the raw engine baseline).
//   2. ASSETS.carModels[carId].physics — the hand-authored per-car identity
//      override (only CAR_PHYSICS_KEYS; usually just `drivetrain` these
//      days, see below).
//   3. A carProfiles/*.json file, if one exists for THIS EXACT carId.
//   4. Otherwise, the drivetrain DEFAULT profile — carId "fwd" or "rwd" —
//      if one exists. A car that declares no `physics` at all defaults to
//      "rwd" per CODE_DEFAULTS; one that sets `physics: { drivetrain: "fwd" }`
//      and nothing else gets the full fwd-default tune for everything else.
// This is what lets a future car ship with just a drivetrain declaration
// and inherit a complete, already-tuned handling identity — see
// carProfiles/fwd-default.tune.json / rwd-default.tune.json (authored via
// editor/tuningLab.html, same as any other profile — Red #11 and White #7
// respectively, generalized).
//
// Profiles are auto-discovered from carProfiles/ the same manifest.json
// trick game/src/levels.js uses for track levels (works on any static host,
// GitHub Pages included) — drop an exported tune in, regenerate the
// manifest (`node game/tools/build-manifests.mjs`), it's live next
// reload/deploy. Each file needs a `carId` (which car — or which drivetrain
// default — it tunes) and `params` (path -> value, the exact shape
// TuningLab.toJSON() writes). If more than one file targets the same
// carId, the last one discovered wins — no in-game picker, one active
// profile per car (or per drivetrain default).
//
// Resolved against THIS module's own file (import.meta.url), not the
// importing document, since game/src/main.js and editor/tuningLab.html sit
// at different depths but both need the same carProfiles/ folder.
// =====================================================================

import { CONFIG } from "../../shared/src/config.js";
import { ASSETS } from "../../shared/src/placeholders.js";
import { PARAMS, getPath, setPath, applyParamsToConfig } from "./tuninglab.js";

const ALL_PATHS = PARAMS.flatMap((g) => g.items.map(([p]) => p)).filter((p) => !p.startsWith("render."));
// Snapshot every tunable path's code-default at import time, before any car
// physics or profile has touched CONFIG — lets applyCarPhysics() fully reset
// between cars instead of only rolling back the CAR_PHYSICS_KEYS subset (a
// car switch used to be able to leave a prior car's tuned-but-unlisted
// fields, e.g. tireRear, stuck on the next car).
const CODE_DEFAULTS = Object.fromEntries(ALL_PATHS.map((p) => [p, getPath(CONFIG, p)]));

// Drivetrain-identity fields a car's ASSETS.carModels[].physics is allowed
// to override — picking a car never stomps unrelated live-tuned fields
// (downforce, tireRear, audio, ...) that aren't part of a car's identity.
export const CAR_PHYSICS_KEYS = [
  "drivetrain", "awdFrontShare", "cgToFront", "brakeBias", "launchTorque", "launchFade",
  "stabilityAssist", "steerAssist", "tireFront", "engineAccel", "wheelspinLatLoss", "dragK",
  "rollingResist", "mu",
];
const DEFAULT_CAR_PHYSICS = Object.fromEntries(CAR_PHYSICS_KEYS.map((k) => [k, CONFIG.physics[k]]));

// Object.assign-alike, but clones object-valued properties (tireFront's
// {B, C}) instead of aliasing them in. `car?.physics.tireFront` is a plain
// object literal living inside ASSETS.carModels itself, never cloned there —
// aliasing it straight into CONFIG.physics would let the leaf-path reset
// below (setPath, which mutates whatever object is CURRENTLY referenced)
// corrupt that car's own definition in place the next time ANY car is
// selected. Cloning here means every assignment target is a fresh,
// disposable object, so mutating it later can never reach back into
// ASSETS/DEFAULT_CAR_PHYSICS's own source objects.
function assignPhysics(...sources) {
  for (const src of sources) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) CONFIG.physics[k] = v && typeof v === "object" ? { ...v } : v;
  }
}

// profiles: Map<carId, {carId, params}> from loadCarProfiles(), or omitted.
// Keys are either a real ASSETS.carModels id (a car-specific profile) or a
// drivetrain name ("fwd"/"rwd"/"awd", a default profile) — same map, same
// lookup, just two different kinds of key.
export function applyCarPhysics(carId, profiles) {
  for (const [path, v] of Object.entries(CODE_DEFAULTS)) setPath(CONFIG, path, v);
  const car = ASSETS.carModels.find((c) => c.id === carId);
  assignPhysics(DEFAULT_CAR_PHYSICS, car?.physics);
  // Car-specific profile wins if one exists; otherwise fall back to this
  // car's drivetrain default (CONFIG.physics.drivetrain is already correct
  // at this point — set by step 1 or overridden by step 2 above).
  const profile = profiles?.get(carId) ?? profiles?.get(CONFIG.physics.drivetrain);
  if (profile) applyParamsToConfig(profile.params);
}

export async function discoverProfileUrls(folderUrl) {
  try {
    const base = new URL(folderUrl, location.href);
    const res = await fetch(new URL("manifest.json", base));
    if (!res.ok) return [];
    const files = await res.json();
    return [...new Set(files)].map((f) => new URL(f, base).href);
  } catch {
    return [];
  }
}

function isValidProfile(d) {
  return !!d && typeof d === "object" && typeof d.carId === "string" && !!d.params && typeof d.params === "object";
}

const DEFAULT_PROFILES_URL = new URL("../carProfiles/", import.meta.url).href;

export async function loadCarProfiles(folderUrl = DEFAULT_PROFILES_URL) {
  const urls = await discoverProfileUrls(folderUrl);
  const byCarId = new Map();
  for (const url of urls) {
    try {
      const d = await (await fetch(url)).json();
      if (!isValidProfile(d)) {
        console.warn(`carProfiles/: skipping ${url} — needs a carId string and a params object.`);
        continue;
      }
      byCarId.set(d.carId, d); // last discovered wins
    } catch (err) {
      console.warn(`carProfiles/: skipping ${url} —`, err);
    }
  }
  return byCarId;
}
