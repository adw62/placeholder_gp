// =====================================================================
// Generic spline sampling — the math behind every path in the game: the
// main race track (always closed) and any number of free-standing extra
// splines (open or closed) used purely for object placement. track.js
// wraps this with road/kerb/checkpoint/AI-speed generation on top;
// trackObjects.js consumes the raw { samples, length, posAt, query } shape
// directly for both the main track and every extra spline.
// =====================================================================

import * as THREE from "three";

// Builds Catmull-Rom sample frames ({p, t, side, arc, curv}) plus posAt/
// query helpers from a list of [x, y, z] control points.
//
// closed=true wraps (the main track): tangents use both neighbors, length
// includes the closing segment back to the first point, posAt/query wrap
// via modulo.
// closed=false is an open path: tangents at the two endpoints are one-
// sided differences (so curvature is 0 right at the ends), there's no
// closing segment, and posAt/query clamp to [0, length] instead of
// wrapping — reaching either end just holds you there.
export function buildSpline(controlPoints, closed, N) {
  const pts = controlPoints.map((p) => new THREE.Vector3(p[0], p[1] ?? 0, p[2]));
  const curve = new THREE.CatmullRomCurve3(pts, closed, "catmullrom", 0.55);
  const spaced = curve.getSpacedPoints(N); // N+1 points; closed: last === first
  const count = closed ? N : N + 1; // closed drops the duplicate last point

  const samples = [];
  let arc = 0;
  for (let i = 0; i < count; i++) {
    if (i > 0) arc += spaced[i].distanceTo(spaced[i - 1]);
    const prev = closed ? spaced[(i - 1 + N) % N] : spaced[Math.max(0, i - 1)];
    const next = closed ? spaced[(i + 1) % N] : spaced[Math.min(count - 1, i + 1)];
    const t = new THREE.Vector3().subVectors(next, prev).normalize();
    const side = new THREE.Vector3(t.z, 0, -t.x).normalize();
    samples.push({ p: spaced[i], t, side, arc, curv: 0 });
  }
  const length = closed ? arc + spaced[N - 1].distanceTo(spaced[0]) : arc;
  const ds = Math.max(length / count, 1e-6);
  for (let i = 0; i < count; i++) {
    const j = closed ? (i + 1) % count : Math.min(count - 1, i + 1);
    const t1 = samples[i].t, t2 = samples[j].t;
    const crossY = t1.x * t2.z - t1.z * t2.x;
    samples[i].curv = Math.asin(THREE.MathUtils.clamp(crossY, -1, 1)) / ds;
  }

  // Nearest sample to a world position. `hint` makes it a cheap local
  // search; falls back to a full scan after resets/teleports/first call.
  function query(pos, hint = null) {
    let best = -1, bestD2 = Infinity;
    const test = (i) => {
      const sp = samples[i].p;
      const dx = pos.x - sp.x, dz = pos.z - sp.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    };
    if (hint != null) {
      if (closed) {
        for (let k = -45; k <= 45; k++) test((hint + k + count * 4) % count);
      } else {
        const lo = Math.max(-45, -hint), hi = Math.min(45, count - 1 - hint);
        for (let k = lo; k <= hi; k++) test(hint + k);
      }
    }
    if (best < 0 || bestD2 > 900) {
      bestD2 = Infinity;
      for (let i = 0; i < count; i++) test(i);
    }
    const s = samples[best];
    const lateral = (pos.x - s.p.x) * s.side.x + (pos.z - s.p.z) * s.side.z;
    return { idx: best, lateral, s };
  }

  // Interpolated position at arc distance sDist with a lateral offset.
  // outTan is the real 3D tangent (includes slope on climbs/descents —
  // callers that only want heading use atan2(tan.x, tan.z), unaffected by
  // tan.y). outSide is the horizontal side/normal-forming vector, for
  // callers that need a full surface-conforming orientation.
  function posAt(sDist, lateral, outPos, outTan = null, outSide = null) {
    let sd;
    if (closed) {
      sd = sDist % length;
      if (sd < 0) sd += length;
    } else {
      sd = THREE.MathUtils.clamp(sDist, 0, length);
    }
    const segs = closed ? count : count - 1;
    const f = (sd / length) * segs;
    let i = Math.floor(f);
    const u = f - i;
    if (closed) i %= count;
    else i = THREE.MathUtils.clamp(i, 0, count - 2);
    const j = closed ? (i + 1) % count : i + 1;
    const a = samples[i], b = samples[j];
    const sx = a.side.x + (b.side.x - a.side.x) * u;
    const sz = a.side.z + (b.side.z - a.side.z) * u;
    outPos.set(
      a.p.x + (b.p.x - a.p.x) * u + sx * lateral,
      a.p.y + (b.p.y - a.p.y) * u,
      a.p.z + (b.p.z - a.p.z) * u + sz * lateral
    );
    if (outTan) outTan.set(a.t.x + (b.t.x - a.t.x) * u, a.t.y + (b.t.y - a.t.y) * u, a.t.z + (b.t.z - a.t.z) * u).normalize();
    if (outSide) outSide.set(sx, 0, sz).normalize();
    return outPos;
  }

  // Continuous closest-point projection onto the polyline, refining query()'s
  // nearest-SAMPLE lookup by projecting onto the two segments flanking it and
  // keeping whichever projection is actually closest (a polyline's closest
  // point is continuous; the nearest vertex isn't — it snaps facet-to-facet).
  // Matters wherever the tangent/side frame rotates a lot between consecutive
  // samples, i.e. tight curvature: query() alone treats the wall/ground as a
  // fan of flat facets meeting at each sample, which reads as felt/visible
  // faceting on sharp corners — see collideWithBarriers (physics.js) and
  // groundHeightAt (main.js), the two places that need the real curve instead.
  // Returns query()'s own shape (idx, s) plus continuous arc/lateral and an
  // interpolated side vector — a drop-in superset, safe wherever query() is used.
  function queryProjected(pos, hint = null) {
    const q = query(pos, hint);
    const idx = q.idx;
    let bestD2 = Infinity, bestArc = q.s.arc, bestLat = q.lateral;
    let bestSide = { x: q.s.side.x, z: q.s.side.z };
    for (let k = -1; k <= 0; k++) {
      const ia = closed ? (idx + k + count) % count : THREE.MathUtils.clamp(idx + k, 0, count - 1);
      const ib = closed ? (ia + 1) % count : Math.min(count - 1, ia + 1);
      if (ia === ib) continue;
      const a = samples[ia], b = samples[ib];
      const ex = b.p.x - a.p.x, ez = b.p.z - a.p.z;
      const len2 = ex * ex + ez * ez;
      if (len2 < 1e-12) continue;
      const u = THREE.MathUtils.clamp(((pos.x - a.p.x) * ex + (pos.z - a.p.z) * ez) / len2, 0, 1);
      const dx = pos.x - (a.p.x + ex * u), dz = pos.z - (a.p.z + ez * u);
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        const len = Math.sqrt(len2);
        bestArc = a.arc + u * len;
        bestLat = (dx * ez - dz * ex) / len; // signed distance, side = (t.z, -t.x)
        // Interpolated side vector, same blend posAt() uses to place an offset
        // point here — keeps the wall/ground normal consistent with wherever
        // the visual ribbon/mesh geometry actually put its own vertices.
        const sx = a.side.x + (b.side.x - a.side.x) * u, sz = a.side.z + (b.side.z - a.side.z) * u;
        const slen = Math.hypot(sx, sz) || 1;
        bestSide = { x: sx / slen, z: sz / slen };
      }
    }
    return { idx, s: q.s, lateral: bestLat, arc: bestArc, side: bestSide };
  }

  return { samples, length, closed, posAt, query, queryProjected };
}
