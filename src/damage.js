// =====================================================================
// Crash damage: permanent vertex-level crumpling of the player car body
// on hard impacts (wall or AI bump). Applied only on the impact events
// main.js already gates (wall impact-speed threshold, AI bump cooldown)
// — never per-frame, so the cost of walking every vertex is negligible.
// =====================================================================
import * as THREE from "three";
import { contactPoint } from "./physics.js";

const TANGENT_BIAS = 2.5; // in-plane (crumple/bunch) push vs. straight-in dent

// Per-vertex cumulative displacement cap, in the model's own units (x
// CONFIG.carScale for meters), ramped by distance from the body's central axis:
// extremities crumple, panels near the middle barely move — crush structure at
// the ends, stiff cell in between.
const LIMIT_EDGE = 0.18;
const LIMIT_CENTER = 0.035;
const LIMIT_SHAPE = 1.6;  // >1 keeps the middle stiff, concentrating give at the ends
// How much being out at the SIDE counts as "extremity" vs being at the
// nose/tail. Length-dominant on purpose: a body is a hollow shell, so a purely
// radial measure scores nearly every vertex as an edge and the ramp does nothing.
const WIDTH_WEIGHT = 0.5;

const _inv = new THREE.Matrix4();
const _localPoint = new THREE.Vector3();
const _localNormal = new THREE.Vector3();
const _worldNormal = new THREE.Vector3();
const _v = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _dmg = new THREE.Vector3();

// Preps a car body for damage. cachedClone() (placeholders.js) shares GLTF
// geometry across every rig built from the same model, so deforming it in
// place would dent every car using that model, including future clones —
// clone each mesh's geometry per rig instance and stash its undamaged rest
// position so hits accumulate relative to that, never to an already-warped
// buffer (which would let repeated small hits stretch a vertex arbitrarily
// far instead of settling toward its cap).
//
// Also precomputes each vertex's own displacement cap here rather than per
// impact: it depends only on where the vertex sits in the body, which never
// changes, so an impact stays a single walk with no extra transforms.
export function makeDamageable(body) {
  const meshes = [];
  // Box3/matrix reads below need fresh ancestors, and three.js won't refresh
  // them for us (setFromObject only updates downward).
  body.updateMatrixWorld(true);
  const toBody = new THREE.Matrix4().copy(body.matrixWorld).invert();

  body.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry = o.geometry.clone();
    // BufferGeometry.copy() (what clone() uses internally) assigns userData
    // BY REFERENCE, not by value — every clone of the same cached master
    // mesh (i.e. every car using the same model) would otherwise share one
    // userData object, so writing restPosition/damage here would silently
    // alias every other instance's damage state to this one. Give the clone
    // its own object first.
    o.geometry.userData = {};
    const pos = o.geometry.attributes.position;
    o.geometry.userData.restPosition = pos.array.slice();
    o.geometry.userData.damage = new Float32Array(pos.array.length);
    // mesh-local -> body-local; cancels the (possibly stale) parent chain on
    // both sides, so it's the true relative transform either way.
    o.geometry.userData.toBody = new THREE.Matrix4().multiplyMatrices(toBody, o.matrixWorld);
    meshes.push(o);
  });

  // Bounds across every mesh in one shared frame, so a multi-mesh body (the
  // chassis/cabin/nose fallback) measures distance from the CAR's centre rather
  // than from each piece's own.
  const box = new THREE.Box3();
  for (const o of meshes) {
    const pos = o.geometry.attributes.position;
    const m = o.geometry.userData.toBody;
    for (let i = 0; i < pos.count; i++) box.expandByPoint(_v.fromBufferAttribute(pos, i).applyMatrix4(m));
  }
  const c = box.getCenter(new THREE.Vector3());
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const hx = Math.max(1e-4, half.x), hz = Math.max(1e-4, half.z);

  for (const o of meshes) {
    const pos = o.geometry.attributes.position;
    const m = o.geometry.userData.toBody;
    // Body-space lengths, converted to this mesh's own units in case a
    // sub-mesh carries a scale of its own (the damage vector is mesh-local).
    const s = new THREE.Vector3().setFromMatrixScale(m);
    const k = Math.max(1e-4, (s.x + s.y + s.z) / 3);
    const limit = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(m);
      // Horizontal plane only — being high up doesn't make a vertex crushable.
      // Nose/tail reach 1, outer flanks reach WIDTH_WEIGHT, the cell sits near 0.
      const u = ((_v.x - c.x) / hx) * WIDTH_WEIGHT, w = (_v.z - c.z) / hz;
      const e = Math.min(1, Math.hypot(u, w));
      limit[i] = (LIMIT_CENTER + (LIMIT_EDGE - LIMIT_CENTER) * Math.pow(e, LIMIT_SHAPE)) / k;
    }
    o.geometry.userData.limit = limit;
  }
  return meshes;
}

// Dents `meshes` (from makeDamageable) around a world-space impact point.
// `normal` points from the car's center toward whatever it hit — the same
// convention as collideWithBarriers's q.side*sign. Vertices near the hit get
// pushed two ways: straight in along -normal (a dent) and, more strongly
// (TANGENT_BIAS x), sideways within the plane perpendicular to normal
// (crumple/bunch) — closer to how sheet metal actually folds under a hit
// than a clean radial poke straight through the body would look.
export function applyCrashDamage(meshes, worldPoint, normal, strength) {
  if (!meshes || !meshes.length || strength <= 0) return;
  const radius = THREE.MathUtils.clamp(0.25 + strength * 0.035, 0.25, 0.9);
  // Kept below LIMIT_EDGE so a single hard hit can't slam a vertex straight to
  // its cap — damage still accumulates visibly over several impacts instead of
  // saturating on the first one and then never changing again.
  const maxPush = THREE.MathUtils.clamp(strength * 0.012, 0, 0.12);
  _worldNormal.set(normal.x, 0, normal.z).normalize();

  for (const mesh of meshes) {
    const rest = mesh.geometry.userData.restPosition;
    const damage = mesh.geometry.userData.damage;
    const limit = mesh.geometry.userData.limit;
    if (!rest) continue; // not prepped by makeDamageable

    // Reflects the rig's pose as of the last posePlayerRig() call (up to one
    // frame stale relative to this frame's post-collision position) — fine
    // for a deformation this coarse.
    mesh.updateWorldMatrix(true, false);
    _inv.copy(mesh.matrixWorld).invert();
    _localPoint.copy(worldPoint).applyMatrix4(_inv);
    _localNormal.copy(_worldNormal).transformDirection(_inv).normalize();

    const posAttr = mesh.geometry.attributes.position;
    let touched = false;
    for (let i = 0; i < rest.length; i += 3) {
      _v.set(rest[i], rest[i + 1], rest[i + 2]).sub(_localPoint);
      const dist = _v.length();
      if (dist > radius) continue;
      touched = true;
      const falloff = (1 - dist / radius) ** 2;

      const normalComp = _v.dot(_localNormal);
      _tangent.copy(_v).addScaledVector(_localNormal, -normalComp);
      const tlen = _tangent.length();
      if (tlen > 1e-5) _tangent.multiplyScalar(1 / tlen);
      else _tangent.set(0, 0, 0);

      const nOff = -maxPush * falloff;
      const tOff = maxPush * TANGENT_BIAS * falloff;

      _dmg.set(
        damage[i] + _localNormal.x * nOff + _tangent.x * tOff,
        damage[i + 1] + _localNormal.y * nOff + _tangent.y * tOff,
        damage[i + 2] + _localNormal.z * nOff + _tangent.z * tOff
      );
      // This vertex's own cap (precomputed in makeDamageable): large at the
      // extremities, small near the centre of the body.
      const cap = limit[i / 3];
      if (_dmg.length() > cap) _dmg.setLength(cap);
      damage[i] = _dmg.x;
      damage[i + 1] = _dmg.y;
      damage[i + 2] = _dmg.z;

      posAttr.array[i] = rest[i] + damage[i];
      posAttr.array[i + 1] = rest[i + 1] + damage[i + 1];
      posAttr.array[i + 2] = rest[i + 2] + damage[i + 2];
    }
    if (touched) {
      posAttr.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingSphere();
    }
  }
}

// Convenience wrapper for main.js's call sites (wall hit, both sides of an
// AI bump): derives the world contact point from a car's center + ground
// height + heading + collision normal, so a call site only has to supply
// what actually differs between it and the others — which car, which
// direction, how hard.
//
// The contact point rides the car's OUTLINE along the normal (physics.js's
// contactPoint), not a fixed radius — which put a flank dent ~0.3 m outside the
// bodywork, so light hits deformed almost nothing. main.js's spark/chip emission
// uses the same helper, so dent and burst land together.
export function damageCarAt(meshes, centerPos, groundY, heading, normal, strength) {
  const cp = contactPoint(centerPos, heading, normal.x, normal.z);
  applyCrashDamage(meshes, { x: cp.x, y: groundY + 0.15, z: cp.z }, normal, strength);
}
