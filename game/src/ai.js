// =====================================================================
// AI opponents. Each AI drives a real CarPhysics instance — same tire
// model, wall collision and substep rate the player uses — through a
// pure-pursuit driver targeting the track's precomputed cornering-speed
// table (track.vtAI), ported from editor/tools/drive-test.js's proven
// headless driver (steering + speed control + stuck/reverse recovery).
// Mild rubber-banding keeps the race close without being obvious.
// =====================================================================

import * as THREE from "three";
import { CONFIG } from "../../shared/src/config.js";
import { buildOpponentCar, WHEEL } from "../../shared/src/placeholders.js";
import { CarPhysics, collideWithBarriers, barrierPenetration } from "./physics.js";
import { makeDamageable } from "./damage.js";

const clamp = THREE.MathUtils.clamp;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Module-level scratch (update() is never reentrant per-instance, and
// AIRacer instances aren't updated concurrently with each other).
const _segScratch = []; // reused barrier-query index list (see physics.js)
const _look = new THREE.Vector3();
const _groundPos = new THREE.Vector3();
const _groundTan = new THREE.Vector3();

export class AIRacer {
  constructor(track, { skill, color, offset, startS, startLat, carId }) {
    this.track = track;
    this.skill = skill;
    this.baseOffset = offset;
    this.color = color;
    this.wobbleT = Math.random() * 10;

    this.car = new CarPhysics();
    const spawnPos = new THREE.Vector3(), spawnTan = new THREE.Vector3();
    track.posAt(startS, startLat, spawnPos, spawnTan);
    this.car.reset(spawnPos, Math.atan2(spawnTan.x, spawnTan.z));
    this.pos = this.car.pos; // live reference — minimap/bump code reads a.pos unchanged

    this.lastIdx = null;
    this.cp = 0;
    this.lap = 0;
    this.finished = false;
    this.arc = startS;
    this.groundY = spawnPos.y;
    this.pitch = 0;
    this.lastImpact = 0;
    this.lastImpactNormal = { x: 0, z: 0 };
    this.wallCd = 0;

    // Stuck/recovery (ported from drive-test.js: speed<0.8 sustained past a
    // startup grace -> reverse for a bit -> resume; unlike the headless
    // tool's 5-recovery DNF, a live AI just keeps retrying).
    this.aliveT = 0;
    this.stuckT = 0;
    this.reverseTimer = 0;

    // Corner assist: nudges heading/slip back toward the spline's line on
    // most corners so the raw physics doesn't spin the AI out as often —
    // rolled once per corner (not every frame) so a corner either gets
    // help all the way through it or none, and left off entirely on the
    // rest so real spins still happen sometimes (that part's kept on purpose).
    this.wasCornering = false;
    this.cornerAssistOn = false;

    const { group, body, spinPivots, lift } = buildOpponentCar(color, carId);
    this.group = group;
    this.spinPivots = spinPivots;
    this.lift = lift;
    // Own geometry clones per opponent (see damage.js) — buildOpponentCar's
    // GLTF branch shares cachedClone() geometry same as the player rig does.
    this.damageMeshes = makeDamageable(body);

    this.place();
  }

  // Continuous race progress in laps (for ranking + rubber-band).
  get progress() {
    return this.lap + this.arc / this.track.length;
  }

  update(dt, rubber = 1) {
    this.aliveT += dt;
    const track = this.track;
    const N = track.samples.length, ncp = track.ncp;

    let q = track.queryProjected(this.car.pos, this.lastIdx);
    this.lastIdx = q.idx;
    const onRoad = Math.abs(q.lateral) <= track.halfW + CONFIG.track.kerbWidth;
    const off = CONFIG.physics.offroad;
    const surface = onRoad
      ? { grip: 1, drag: 0, power: 1, slope: q.s.t.y }
      : { grip: off.grip, drag: off.drag, power: off.power, slope: q.s.t.y };

    // Corner assist roll: reuses CONFIG.track.kerbMinCurv (the same "this
    // counts as a real corner" threshold apex kerbs use) as the cornering
    // gate, and only re-rolls on straight->corner transitions so a corner
    // stays consistently assisted or not for its whole duration.
    const cornering = Math.abs(q.s.curv) > CONFIG.track.kerbMinCurv;
    if (cornering && !this.wasCornering) this.cornerAssistOn = Math.random() < CONFIG.ai.cornerAssist.chance;
    this.wasCornering = cornering;

    // ---------- driver: pure-pursuit steering + vtAI speed target ----------
    let input;
    if (this.reverseTimer > 0) {
      this.reverseTimer = Math.max(0, this.reverseTimer - dt);
      input = { throttle: 0, brake: 1, steer: 0, handbrake: 0 };
    } else {
      this.wobbleT += dt;
      const maxOff = track.halfW - 1;
      const targetLat = clamp(this.baseOffset * 0.85 + Math.sin(this.wobbleT * 0.7) * 0.5, -maxOff, maxOff);
      const ahead = Math.max(5, this.car.speed * 0.55);
      track.posAt(q.arc + ahead, targetLat, _look);
      const err = wrapAngle(Math.atan2(_look.x - this.car.pos.x, _look.z - this.car.pos.z) - this.car.heading);

      let vt = track.vtAI[q.idx] * this.skill * rubber;
      if (this.finished) vt = Math.min(vt, 12); // cruise after the flag
      input = {
        steer: clamp(err * 2.2, -1, 1),
        throttle: this.car.vLong < vt ? 1 : 0,
        brake: this.car.vLong > vt * 1.06 ? 1 : 0,
        handbrake: 0,
      };
    }

    // ---------- substepped physics + wall collision ----------
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    let impact = 0;
    for (let i = 0; i < steps; i++) {
      this.car.update(h, input, surface);
      q = track.queryProjected(this.car.pos, this.lastIdx);
      this.lastIdx = q.idx;
      const hit = collideWithBarriers(this.car, track.barriers, _segScratch);
      if (hit > impact) {
        impact = hit;
        // The struck segment's own outward normal (see physics.js) rather than
        // one derived from the centerline — they differ on tight corners.
        const p = barrierPenetration(this.car, track.barriers, _segScratch);
        this.lastImpactNormal.x = p.nx;
        this.lastImpactNormal.z = p.nz;
      }
    }

    // Apply the corner assist once per frame (not per substep — it's a
    // gentle correction, not part of the tire model): blend heading toward
    // the spline tangent, then bleed off the resulting slide component of
    // vel so the correction actually reduces slip instead of just steering
    // a still-sliding car to point a different way. Skipped during a
    // recovery reverse — that maneuver doesn't want to be pulled toward
    // the racing line for the same reason it's reversing in the first place.
    if (cornering && this.cornerAssistOn && this.reverseTimer <= 0) {
      const CA = CONFIG.ai.cornerAssist;
      const idealHeading = Math.atan2(q.s.t.x, q.s.t.z);
      const err = wrapAngle(idealHeading - this.car.heading);
      this.car.heading += err * clamp(dt * CA.headingRate, 0, 1);

      const fx = Math.sin(this.car.heading), fz = Math.cos(this.car.heading);
      const sx = fz, sz = -fx;
      const vLong = this.car.vel.x * fx + this.car.vel.z * fz;
      const vLat = (this.car.vel.x * sx + this.car.vel.z * sz) * Math.max(0, 1 - dt * CA.latDamp);
      this.car.vel.set(fx * vLong + sx * vLat, 0, fz * vLong + sz * vLat);
    }

    this.arc = q.arc;
    this.lastImpact = impact;
    this.wallCd = Math.max(0, this.wallCd - dt);

    // ---------- stuck/recovery ----------
    if (this.car.speed < 0.8 && this.aliveT > 3 && this.reverseTimer <= 0) {
      this.stuckT += dt;
      if (this.stuckT > 4) { this.stuckT = 0; this.reverseTimer = 2.2; }
    } else if (this.car.speed > 2) this.stuckT = 0;

    // ---------- checkpoints & laps (same region/expect pattern as the player) ----------
    if (Math.abs(q.lateral) < track.wallDist + 2) {
      const region = Math.floor(q.idx / (N / ncp)) % ncp;
      const expect = (this.cp + 1) % ncp;
      if (region === expect) {
        this.cp = expect;
        if (expect === 0) this.lap++;
      }
    }

    this.place(dt);
    for (const sp of this.spinPivots) sp.rotation.x += (this.car.vLong / (WHEEL.radius * CONFIG.carScale)) * dt;
  }

  place(dt = 0) {
    this.track.posAt(this.arc, 0, _groundPos, _groundTan);
    this.groundY = _groundPos.y;
    const targetPitch = -Math.asin(clamp(_groundTan.y, -1, 1));
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 8);
    this.group.position.set(this.car.pos.x, this.groundY + this.lift, this.car.pos.z);
    this.group.rotation.set(0, this.car.heading, 0);
    this.group.rotateX(this.pitch);
  }
}
