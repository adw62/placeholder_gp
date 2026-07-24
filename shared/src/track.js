// =====================================================================
// Procedural track generation from a closed Catmull-Rom spline.
// Produces: road ribbon, start line + gantry, checkpoint sectors, AI
// target-speed table, minimap polyline, per-sample curvature, and spatial
// queries (nearest-sample / position-along-track) used by physics, AI and
// race logic. Kerbs, barriers and all other trackside props are placed by
// trackObjects.js (rule-based, editable per track) — this module only
// exposes the curvature/wallDist data those rules key off.
// =====================================================================

import * as THREE from "three";
import { CONFIG } from "./config.js";
import { asphaltTexture, checkerTexture, buildStartGantry } from "./placeholders.js";
import { buildSpline } from "./spline.js";
import { resolveBands, computeWallProfile, wallDistAt } from "./trackObjects.js";

// Flat ribbon between two lateral offsets, following the sample frames.
function stripGeometry(samples, i0, count, offA, offB, yLift, uvMode, uvScale) {
  const N = samples.length;
  const pos = [], uv = [], idx = [];
  let run = 0, prev = null;
  for (let k = 0; k <= count; k++) {
    const s = samples[(i0 + k) % N];
    if (prev) run += s.p.distanceTo(prev);
    prev = s.p;
    const y = s.p.y + yLift;
    pos.push(
      s.p.x + s.side.x * offA, y, s.p.z + s.side.z * offA,
      s.p.x + s.side.x * offB, y, s.p.z + s.side.z * offB
    );
    if (uvMode === "across") uv.push(0, run * uvScale, 1, run * uvScale);
    else uv.push(run * uvScale, 0, run * uvScale, 1);
    if (k < count) {
      const b = k * 2;
      idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildTrack(def) {
  const TC = CONFIG.track;
  const N = TC.samples, ncp = TC.checkpoints;

  const { samples, length, posAt, query } = buildSpline(def.controlPoints, true, N);

  const halfW = def.width / 2;
  const wallDist = halfW + TC.wallMargin;
  const group = new THREE.Group();

  // --- road ---
  const road = new THREE.Mesh(
    stripGeometry(samples, 0, N, halfW, -halfW, 0.02, "across", 1 / (2 * halfW)),
    new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.95 })
  );
  road.receiveShadow = true;
  group.add(road);

  // --- start/finish line + gantry ---
  const s0 = samples[0];
  const startGroup = new THREE.Group();
  startGroup.position.copy(s0.p);
  startGroup.rotation.y = Math.atan2(s0.t.x, s0.t.z);
  const checkTex = checkerTexture();
  checkTex.repeat.set(halfW, 1);
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(2 * halfW, 1.6),
    new THREE.MeshBasicMaterial({ map: checkTex })
  );
  line.rotation.x = -Math.PI / 2;
  line.position.y = 0.04;
  startGroup.add(line, buildStartGantry(2 * wallDist));
  group.add(startGroup);

  // --- checkpoint sectors (sample index where each sector begins) ---
  const checkpoints = [];
  for (let k = 0; k < ncp; k++) checkpoints.push(Math.floor((k * N) / ncp));

  // --- AI target speed per sample: cornering limit + braking look-ahead ---
  const A = CONFIG.ai;
  const ds = length / N;
  const vtAI = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    vtAI[i] = Math.min(A.maxSpeed, Math.sqrt(A.lateralAccel / Math.max(1e-4, Math.abs(samples[i].curv))));
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = N - 1; i >= 0; i--) {
      const j = (i + 1) % N;
      vtAI[i] = Math.min(vtAI[i], Math.sqrt(vtAI[j] * vtAI[j] + 2 * A.brake * ds));
    }
  }

  // --- minimap polyline ---
  const minimapPts = [];
  for (let i = 0; i < N; i += 4) minimapPts.push({ x: samples[i].p.x, z: samples[i].p.z });

  // --- physics wall, narrowed to match wherever this track's own
  // barrier/tire-barrier bands are actually placed (see trackObjects.js's
  // computeWallProfile) — falls back to the flat wallDist above wherever
  // no such band covers a stretch, same as before this existed.
  const wallProfile = computeWallProfile(samples, length, resolveBands(def, { samples, length, wallDist, halfW }), wallDist);

  return {
    def, group, samples, length, halfW, wallDist, checkpoints, ncp, vtAI, query, posAt, minimapPts,
    wallDistAt: (idx, sign) => wallDistAt(wallProfile, idx, sign),
  };
}
