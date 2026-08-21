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

// Lane pick (see CONFIG.ai.lanes), tried closest-to-`preferredSign` first:
// a corner entry passes the inside line's sign (see barriers.js's own
// "which face is concave" test, -sign*curv > 0, mirrored by insideSign at
// the call site) so a corner is attacked from the inside if it's free. A
// straight entry instead passes the car's OWN lane sign (Math.sign of its
// baseOffset) — there's no inside/outside worth fighting for on a straight,
// just three lateral slots to not stack cars into, so a car defaults to its
// own habitual line and only steps off it if that line's actually taken.
//
// "Taken" is compared against each AI's own currently-committed line
// (o.lane) rather than its raw position (o.lat) — o.lane is kept current
// through BOTH kinds of transition (see update()), so this never mistakes a
// car still easing onto a line, or just passing through on its way
// somewhere else, for one that's actually claimed this slot. The player has
// no such commitment to read, so it's always compared by its literal
// current line (o.lat) — a human occupies wherever they're driving, period.
function pickLane(self, track, others, preferredSign) {
  const L = CONFIG.ai.lanes;
  const maxOff = track.halfW - 1;
  const laneOffset = maxOff * L.offsetFrac;
  const tol = laneOffset * L.lateralTolFrac;
  const preferred = preferredSign * laneOffset;
  const candidates = [laneOffset, 0, -laneOffset].sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred));
  const half = track.length / 2;
  for (const cand of candidates) {
    const occupied = others.some((o) => {
      if (o.ref === self) return false;
      const dArc = (((o.arc - self.arc + half) % track.length) + track.length) % track.length - half;
      if (dArc < -L.behindDist || dArc > L.aheadDist) return false;
      const theirLine = o.ref !== null ? o.lane : o.lat;
      return Math.abs(theirLine - cand) < tol;
    });
    if (!occupied) return cand;
  }
  return candidates[candidates.length - 1]; // every line's claimed — the farthest from what we wanted is the fallback
}

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

    // Lane choice (see CONFIG.ai.lanes/pickLane): laneTarget is re-picked on
    // every straight<->corner transition (inside-preferred entering a
    // corner, own-line-preferred entering a straight); lineLat is the
    // actually-driven line, eased toward laneTarget so a switch never snaps.
    this.laneTarget = offset * 0.85;
    this.lineLat = offset * 0.85;
    // This car's own last-known arc/lateral/lane (see place()/update()) —
    // what main.js reads into the shared carDescs list so other racers'
    // pickLane can see where this one is sitting and which line it's on.
    this.lateral = 0;
    // wasBlocked: rising-edge tracker for "someone's directly ahead" (see
    // update()) — a fresh blocker triggers an immediate lane re-pick away
    // from it, not just the braking that following distance already does.
    this.wasBlocked = false;
    // bumped/bumpAvoidSign: set by main.js the instant this car's own
    // footprint actually overlaps another (player or AI) — consumed once at
    // the top of the next update() to force a lane change away from
    // whoever it hit, so real contact doesn't just get shrugged off and
    // repeated next frame.
    this.bumped = false;
    this.bumpAvoidSign = 0;

    // Boost (see CONFIG.ai.boostAI): AI runs the same meter/constants as the
    // player's own nitro tank (CONFIG.boost).
    this.boostMeter = CONFIG.boost.startAmount;
    this.boosting = false;
    this.cruiseBoostT = 0;

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

  // `others` is the shared per-frame car list main.js builds once (every AI
  // + the player, self included, each with x/z/heading/speed/arc/lat) — see
  // CONFIG.ai.lanes (pickLane) and CONFIG.ai.awareness (following distance).
  update(dt, rubber = 1, others = []) {
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

    // Corner assist roll + lane pick: both reuse CONFIG.track.kerbMinCurv
    // (the same "this counts as a real corner" threshold apex kerbs use) as
    // the cornering gate. Corner assist only rolls entering a corner (stays
    // consistently assisted or not for the corner's whole duration); lane
    // pick re-runs on BOTH transitions — entering a corner (inside
    // preferred) and entering a straight (own line preferred, see
    // pickLane) — so a car is always driving toward a deliberately chosen,
    // currently-free line rather than just whatever it last committed to.
    const cornering = Math.abs(q.s.curv) > CONFIG.track.kerbMinCurv;
    if (cornering !== this.wasCornering) {
      if (cornering) {
        this.cornerAssistOn = Math.random() < CONFIG.ai.cornerAssist.chance;
        const insideSign = q.s.curv >= 0 ? -1 : 1;
        this.laneTarget = pickLane(this, track, others, insideSign);
      } else {
        this.laneTarget = pickLane(this, track, others, Math.sign(this.baseOffset));
      }
    }
    this.wasCornering = cornering;

    // Actual contact (see main.js's bump blocks) overrides whatever the
    // above just picked — a car that just hit someone needs to be actively
    // moving away from them, not still aimed at the line that led to the
    // hit. preferredSign steers the re-pick toward the side it was pushed.
    if (this.bumped) {
      this.bumped = false;
      this.laneTarget = pickLane(this, track, others, this.bumpAvoidSign || (Math.random() < 0.5 ? -1 : 1));
    }

    // ---------- driver: pure-pursuit steering + vtAI speed target ----------
    let input;
    if (this.reverseTimer > 0) {
      this.reverseTimer = Math.max(0, this.reverseTimer - dt);
      input = { throttle: 0, brake: 1, steer: 0, handbrake: 0, boost: 0 };
      this.boosting = false;
    } else {
      this.wobbleT += dt;
      const maxOff = track.halfW - 1;

      // ---------- following distance: is someone directly ahead in
      // roughly this car's own path, independent of lane? Scanned before
      // the lane-easing below so a fresh blocker (rising edge only, so the
      // reaction commits instead of re-aiming every frame the gap wobbles)
      // can steer this SAME frame's target away from it — actively
      // overtaking into the next lane, rather than just trailing at
      // matched speed forever (the brake cap further down is still the
      // backstop for however long the swing across takes).
      const AW = CONFIG.ai.awareness;
      const fx = Math.sin(this.car.heading), fz = Math.cos(this.car.heading);
      const rx = fz, rz = -fx; // right-hand vector
      const lookDist = AW.lookAhead + this.car.speed * AW.lookAheadSpeedMul;
      let blocked = false, blockerFwd = Infinity, blockerLat = 0, blockerSpeed = Infinity;
      for (const o of others) {
        if (o.ref === this) continue;
        const dx = o.x - this.car.pos.x, dz = o.z - this.car.pos.z;
        const fwd = dx * fx + dz * fz;
        if (fwd <= 0.5 || fwd >= lookDist) continue;
        const lat = dx * rx + dz * rz;
        if (Math.abs(lat) > AW.lateralThreshold) continue;
        if (fwd < blockerFwd) { blockerFwd = fwd; blockerLat = lat; blockerSpeed = o.speed; blocked = true; }
      }
      if (blocked && !this.wasBlocked) {
        const away = Math.abs(blockerLat) < 0.3 ? (Math.random() < 0.5 ? -1 : 1) : (blockerLat > 0 ? -1 : 1);
        this.laneTarget = pickLane(this, track, others, away);
      }
      this.wasBlocked = blocked;

      // Always ease toward the picked lane (see above and the blocker check
      // just above); a little sinusoidal life on top while cruising a
      // straight, none mid-corner where a clean line matters more than
      // looking busy.
      const LANES = CONFIG.ai.lanes;
      this.lineLat += (this.laneTarget - this.lineLat) * clamp(dt * LANES.switchRate, 0, 1);
      const wobble = cornering ? 0 : Math.sin(this.wobbleT * 0.7) * 0.35;
      const targetLat = clamp(this.lineLat + wobble, -maxOff, maxOff);

      const ahead = Math.max(5, this.car.speed * 0.55);
      track.posAt(q.arc + ahead, targetLat, _look);
      const err = wrapAngle(Math.atan2(_look.x - this.car.pos.x, _look.z - this.car.pos.z) - this.car.heading);

      let vt = track.vtAI[q.idx] * this.skill * rubber;
      if (this.finished) vt = Math.min(vt, 12); // cruise after the flag
      // Following distance: too close to swing wide of yet, so match speed
      // instead of driving into the back of it.
      if (blocked && blockerFwd < AW.brakeDist) vt = Math.min(vt, blockerSpeed + AW.brakeMargin);

      // ---------- boost: never mid-corner. Either forcing a pass on a car
      // it's already keeping pace with, or — once the tank's comfortably
      // full — an opportunistic burn on an open straight, latched for a
      // few seconds once triggered so it doesn't flicker on/off frame to
      // frame while the odds are re-rolled (see CONFIG.ai.boostAI).
      const B = CONFIG.boost, AB = CONFIG.ai.boostAI;
      this.cruiseBoostT = Math.max(0, this.cruiseBoostT - dt);
      if (!this.finished && !cornering && this.cruiseBoostT <= 0 &&
          this.boostMeter > AB.cruiseThreshold && Math.random() < AB.cruiseChance * dt) {
        this.cruiseBoostT = AB.duration;
      }
      const overtaking = blocked && this.car.vLong >= blockerSpeed - 1;
      this.boosting = !this.finished && !cornering && this.boostMeter > B.minToStart &&
        (overtaking || this.cruiseBoostT > 0);
      const vtEff = this.boosting ? vt + B.topSpeedBonus : vt;

      input = {
        steer: clamp(err * 2.2, -1, 1),
        throttle: this.boosting || this.car.vLong < vtEff ? 1 : 0,
        brake: this.car.vLong > vtEff * 1.06 ? 1 : 0,
        handbrake: 0,
        boost: this.boosting ? 1 : 0,
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
    this.lateral = q.lateral;
    this.lastImpact = impact;
    this.wallCd = Math.max(0, this.wallCd - dt);

    // ---------- boost meter: same fill/drain rule as the player's own tank
    // (CONFIG.boost), driven by this.car's own drifting/wheelspin signals —
    // the decision to spend it lives up in the driver block above.
    const B = CONFIG.boost;
    if (this.boosting) this.boostMeter = Math.max(0, this.boostMeter - B.drainRate * dt);
    else if (onRoad) {
      const gain = (this.car.drifting ? B.fillDriftRate : 0) + (this.car.wheelspin > 0.3 ? B.fillBurnoutRate * this.car.wheelspin : 0);
      this.boostMeter = Math.min(B.max, this.boostMeter + gain * dt);
    }

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
