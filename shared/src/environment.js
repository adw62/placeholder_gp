// =====================================================================
// Environment: theme application (sky/fog/lights) and procedural
// scenery scattered relative to the track spline — so any new track
// automatically gets ground, hills, trees, rocks and billboards without
// hand-placement. Spectators are the "Cutout: Crowd" billboard type
// (trackObjects.js), placed explicitly via bands/points, not ambient here.
// =====================================================================

import * as THREE from "three";
import { grassTexture, desertTexture, buildTree, buildRock, buildBillboard } from "./placeholders.js";

// Ground follows nearby track elevation (blending to flat past FALLOFF
// meters) instead of a flat disc, so raised/dipped road doesn't float or
// dig into terrain. The flush zone must cover the *whole road width*, not
// just the centerline, or the ground dips away from the ribbon on a slope;
// it must also sit a hair below the road (never exactly flush) or the two z-fight.
const GROUND_SIZE = 900;
// Coarse grid on tight corners visibly pokes through the road on one side
// of the bend. Rebuild is a manual "Generate" action (not per-frame), so a dense grid is affordable.
const GROUND_SEGS = 220;
const GROUND_FALLOFF = 60;
const GROUND_FLUSH_MARGIN = 1.5; // beyond the road edge, still held flush before falling off
const GROUND_DROP = 0.08; // sit slightly below the road ribbon, never through it
const HEIGHT_SAMPLE_STRIDE = 2;

function buildGroundGeometry(track, center) {
  const geo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, GROUND_SEGS, GROUND_SEGS);
  const pos = geo.attributes.position;
  const heightSamples = [];
  for (let i = 0; i < track.samples.length; i += HEIGHT_SAMPLE_STRIDE) heightSamples.push(track.samples[i]);
  const flushDist = track.wallDist + GROUND_FLUSH_MARGIN;
  for (let i = 0; i < pos.count; i++) {
    // Plane is rotated -90deg about X to lie flat: local z -> world height, local (x,y) -> world (x,z).
    const wx = pos.getX(i) + center.x, wz = -pos.getY(i) + center.z;
    let bestD2 = Infinity, bestY = 0;
    for (const s of heightSamples) {
      const dx = wx - s.p.x, dz = wz - s.p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; bestY = s.p.y; }
    }
    const d = Math.sqrt(bestD2);
    const t = d <= flushDist ? 1 : THREE.MathUtils.clamp(1 - (d - flushDist) / GROUND_FALLOFF, 0, 1);
    pos.setZ(i, bestY * t - GROUND_DROP * t);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

// Deterministic per-track RNG so scenery doesn't reshuffle every restart.
export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function applyTheme(theme, scene, sun, hemi) {
  scene.background = new THREE.Color(theme.sky);
  scene.fog = new THREE.Fog(theme.fog ?? theme.sky, theme.fogNear ?? 70, theme.fogFar ?? 320);
  sun.color.set(theme.sun ?? 0xfff4e0);
  sun.intensity = theme.sunIntensity ?? 2.2;
  hemi.intensity = theme.hemiIntensity ?? 0.9;
  hemi.groundColor.set(theme.ground);
}

export function buildEnvironment(def, track, rng) {
  const theme = def.theme;
  const group = new THREE.Group();

  const box = new THREE.Box3();
  for (const s of track.samples) box.expandByPoint(s.p);
  const center = box.getCenter(new THREE.Vector3());

  // --- ground (follows nearby track elevation) ---
  const gTex = theme.terrain === "desert" ? desertTexture(theme.ground) : grassTexture(theme.ground);
  gTex.repeat.set(90, 90);
  const ground = new THREE.Mesh(
    buildGroundGeometry(track, center),
    new THREE.MeshStandardMaterial({ map: gTex, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(center.x, 0, center.z);
  ground.receiveShadow = true;
  group.add(ground);

  // --- distant hills ring ---
  // Flat painted-backdrop hills: half-ellipse cards facing the track,
  // unlit (MeshBasic) so they read as distant haze silhouettes rather
  // than shaded geometry — fog still grades them into the sky.
  const hillMat = new THREE.MeshBasicMaterial({ color: theme.hill ?? 0x5e7a55, side: THREE.DoubleSide });
  for (let i = 0; i < 16; i++) {
    const ang = (i / 16) * Math.PI * 2 + rng() * 0.3;
    const r = 300 + rng() * 90;
    const h = 12 + rng() * 20;
    const w = 140 + rng() * 140;
    const shape = new THREE.Shape();
    shape.absellipse(0, 0, w / 2, h, 0, Math.PI);
    const hill = new THREE.Mesh(new THREE.ShapeGeometry(shape, 10), hillMat);
    hill.position.set(center.x + Math.cos(ang) * r, -2, center.z + Math.sin(ang) * r);
    hill.lookAt(center.x, -2, center.z);
    group.add(hill);
  }

  const clearOfTrack = (x, z, need) => {
    const n2 = need * need;
    for (let i = 0; i < track.samples.length; i += 3) {
      const p = track.samples[i].p;
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz < n2) return false;
    }
    return true;
  };

  // --- scattered props, placed relative to the spline ---
  const scatter = (count, builder) => {
    for (let n = 0; n < count; n++) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const s = track.samples[(rng() * track.samples.length) | 0];
        const sign = rng() < 0.5 ? -1 : 1;
        const d = track.wallDist + 3 + rng() * rng() * 90;
        const x = s.p.x + s.side.x * d * sign;
        const z = s.p.z + s.side.z * d * sign;
        if (!clearOfTrack(x, z, track.wallDist + 2)) continue;
        const obj = builder(rng);
        obj.position.set(x, 0, z);
        obj.rotation.y = rng() * Math.PI * 2;
        group.add(obj);
        break;
      }
    }
  };
  scatter(theme.props?.trees ?? 70, buildTree);
  scatter(theme.props?.rocks ?? 15, buildRock);

  // --- billboards facing the road ---
  const nBill = theme.props?.billboards ?? 4;
  for (let k = 0; k < nBill; k++) {
    const i = Math.floor(((k + 0.5) / nBill) * track.samples.length);
    const s = track.samples[i];
    const sign = k % 2 === 0 ? 1 : -1;
    const d = track.wallDist + 4;
    const x = s.p.x + s.side.x * d * sign;
    const z = s.p.z + s.side.z * d * sign;
    if (!clearOfTrack(x, z, track.wallDist + 1.5)) continue;
    const b = buildBillboard(rng);
    b.position.set(x, 0, z);
    b.lookAt(s.p.x, 0, s.p.z);
    group.add(b);
  }

  return group;
}
