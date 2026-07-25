// =====================================================================
// Collidable barriers as WORLD-SPACE geometry — a polyline per side, baked
// once per track from the same per-sample wall distances trackObjects.js
// computes.
//
// Collision used to happen in the curvilinear (arc, lateral) frame: project the
// car onto the spline, compare its lateral against the wall's. That frame is
// degenerate near a tight corner's inside (equal-lateral curves bunch toward
// the centre of curvature) while the car is a rigid ~2 m box in world space, so
// every way of bridging the two was an approximation whose error grew with
// curvature x car length — collision fired with visible daylight on tight
// corners however it was patched. Box-vs-segment in world space (physics.js's
// collideWithBarriers) needs no frame conversion and is exact at any radius.
// game/src/collisionDebug.js draws these very segments, so the debug fence and
// the collision surface cannot disagree.
//
// Layout: one flat Float32Array, SEG_STRIDE floats per segment —
//   ax, az, bx, bz, nx, nz, ex, ez, len
// n = OUTWARD unit normal (the way the car may not pass), e = unit a->b.
// =====================================================================

import * as THREE from "three";

export const SEG_STRIDE = 9;
const CELL = 4;                    // meters per spatial-hash cell
const MIN_BARRIER_RADIUS = 1.5;    // below this the offset curve is a knot, not a wall
const MAX_STEP = 0.2;              // max lateral change per sample (~13 deg taper)

const _p = new THREE.Vector3();
const _side = new THREE.Vector3();

// distAt(sampleIndex, sign) -> wall distance on that side, same contract as
// track.js's wallDistAt.
export function buildBarriers(spline, distAt) {
  const N = spline.samples.length;
  const data = [];

  // Curvature smoothed over +-2 samples for the guards below: the raw value is
  // a second difference over one ~0.85 m step and underestimates radius by
  // 15-20% at a tight apex, which trips them on estimator noise.
  const curv = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let k = -2; k <= 2; k++) sum += spline.samples[(((i + k) % N) + N) % N].curv;
    curv[i] = sum / 5;
  }

  for (const sign of [1, -1]) {
    const dist = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let d = distAt(i, sign);
      // An offset only traces a valid parallel curve while it stays inside the
      // local radius on the CONCAVE face; past that it folds back through the
      // centre of curvature and the segments lie tangled ACROSS the track. Cap
      // at 90% of the radius so the barrier pulls in rather than inverting.
      const concave = -sign * curv[i];
      if (concave > 0) d = Math.min(d, 0.9 / concave);
      dist[i] = d;
    }

    // Slope-limit the profile: a step in distance (a band starting/ending,
    // 3.95 -> 3.26, or the cap above biting at an apex) becomes a segment
    // running RADIALLY across the track, which the car hits edge-on like a
    // kerbstone and stops dead. Real barrier lines taper. Relaxing with min()
    // only pulls the wall IN, so a taper can't open a drivable gap.
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (let k = 0; k < N; k++) {
        const i = pass % 2 === 0 ? k : N - 1 - k; // alternate direction
        const j = (i + 1) % N;
        if (dist[j] > dist[i] + MAX_STEP) { dist[j] = dist[i] + MAX_STEP; changed = true; }
        if (dist[i] > dist[j] + MAX_STEP) { dist[i] = dist[j] + MAX_STEP; changed = true; }
      }
      if (!changed) break;
    }

    // Each point's own outward direction (the spline's side vector: smooth and
    // unambiguous) orients the normals below.
    const pts = [], outx = [], outz = [];
    for (let i = 0; i < N; i++) {
      spline.posAt(spline.samples[i].arc, dist[i] * sign, _p, undefined, _side);
      pts.push(_p.x, _p.z);
      outx.push(_side.x * sign); outz.push(_side.z * sign);
    }
    // closed loop: last point joins the first
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      // Skip where the barrier's OWN radius would be tiny: at an apex this
      // tight the inside barrier is a sub-metre loop almost centred on the
      // corner's centre of curvature — a knot, not a wall, with ill-defined
      // normals. Leaving that stretch uncontained beats fabricating a tangle.
      // Purely geometric, so it applies to any track: a gentle corner never
      // trips it, an impossible offset drops its whole inside face.
      const concave = -sign * curv[i];
      if (concave > 0 && 1 / concave - dist[i] < MIN_BARRIER_RADIUS) continue;

      const ax = pts[i * 2], az = pts[i * 2 + 1];
      const bx = pts[j * 2], bz = pts[j * 2 + 1];
      let ex = bx - ax, ez = bz - az;
      const len = Math.hypot(ex, ez);
      if (len < 1e-6) continue;
      ex /= len; ez /= len;
      // Outward normal: perpendicular to the segment, oriented by the point's
      // side vector. Orienting by the radial offset instead goes degenerate on
      // a compressed inside curve (the segment runs nearly radially, so that
      // test hits zero and the normal becomes a coin flip).
      let nx = ez, nz = -ex;
      if (nx * outx[i] + nz * outz[i] < 0) { nx = -nx; nz = -nz; }
      data.push(ax, az, bx, bz, nx, nz, ex, ez, len);
    }
  }

  const segs = new Float32Array(data);
  const count = segs.length / SEG_STRIDE;

  // Spatial hash so a query only tests nearby segments.
  const grid = new Map();
  const key = (gx, gz) => gx * 73856093 ^ gz * 19349663;
  for (let s = 0; s < count; s++) {
    const o = s * SEG_STRIDE;
    const ax = segs[o], az = segs[o + 1], bx = segs[o + 2], bz = segs[o + 3];
    const gx0 = Math.floor(Math.min(ax, bx) / CELL), gx1 = Math.floor(Math.max(ax, bx) / CELL);
    const gz0 = Math.floor(Math.min(az, bz) / CELL), gz1 = Math.floor(Math.max(az, bz) / CELL);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const k = key(gx, gz);
        let arr = grid.get(k);
        if (!arr) grid.set(k, (arr = []));
        arr.push(s);
      }
    }
  }

  // Segment indices near (x, z) — the 3x3 cell block, which covers any car
  // (CELL is comfortably larger than the car's half-diagonal).
  function near(x, z, out) {
    out.length = 0;
    const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const arr = grid.get(key(gx + a, gz + b));
        if (arr) for (let i = 0; i < arr.length; i++) out.push(arr[i]);
      }
    }
    return out;
  }

  return { segs, count, near, cell: CELL };
}
