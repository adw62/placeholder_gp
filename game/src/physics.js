// =====================================================================
// Dynamic bicycle model: Pacejka tire curve + load transfer + per-axle
// friction ellipse. One physical model, all behaviors emergent, not scripted:
//   understeer  — front tire force saturates
//   snap/drift  — rear curve peaks earlier and FALLS past it -> positive-
//                 feedback slide until countersteer cuts its slip angle
//   trail-brake — braking loads the front axle, lightening the rear
//   power ovr.  — RWD drive force eats the rear ellipse
//   heaviness   — mass divides accel; yaw inertia (m·k²) persists rotation
//   scrub       — tire forces act perpendicular to the wheel -> sliding sheds speed
// Below vBlend the slip-angle math degenerates (every game using this model
// hits this) so it blends to kinematic steering instead.
//
// On top sits a GT1/2-style assist layer (all 0..1, all zero = raw sim):
//   steerAssist     — clamps commanded steer to the grip-optimal front slip
//   stabilityAssist — fills the rear tire's post-peak falloff (no snap spins)
//   downforce       — v² axle load, split front/rear by aeroBalance
// =====================================================================

import * as THREE from "three";
import { CONFIG } from "../../shared/src/config.js";

const clamp = THREE.MathUtils.clamp;
const G = 9.81;

function tireForce(cap, tire, alpha) {
  return -cap * Math.sin(tire.C * Math.atan(tire.B * alpha));
}

// Wheelspin state: rises while torque demand exceeds the (slightly lower
// once already spinning) traction threshold, recovers otherwise.
function updateSpin(spin, demand, traction, dt, P) {
  const threshold = traction * (1 - 0.3 * spin); // kinetic < static
  const excess = demand - threshold;
  if (excess > 0) spin += excess * P.spinRise * dt;
  else spin -= P.spinDecay * dt;
  return clamp(spin, 0, 1);
}

export class CarPhysics {
  constructor() {
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.heading = 0;
    this.steer = 0;
    this.yawRate = 0;
    this.vLong = 0;
    this.vLat = 0;
    this.slip = 0;
    this.aLong = 0;
    this.drifting = false;
    this.spinF = 0;
    this.spinR = 0;
    this.wheelspin = 0;
    this.frontPush = 0;
  }

  reset(pos, heading) {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.heading = heading;
    this.steer = 0;
    this.yawRate = 0;
    this.vLong = this.vLat = this.slip = this.aLong = 0;
    this.drifting = false;
    this.spinF = this.spinR = this.wheelspin = 0;
    this.frontPush = 0;
  }

  get speed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  // input: { throttle 0..1, brake 0..1, steer -1..1, handbrake 0..1 }
  // surface: { grip, drag, power, slope } — from track query (tarmac vs
  // offroad; slope is the road's own tangent Y at the car's position — see
  // main.js's step(), sourced from spline.js's per-sample 3D tangent, whose
  // Y component is already sinθ of the local grade since tangents are unit
  // vectors)
  update(dt, input, surface) {
    const P = CONFIG.physics;
    // wheelBase/cgHeight/carRadius are BASE (1x) values — CONFIG.carScale is
    // the single "make the car bigger" knob (see config.js), applied here so
    // the dynamics stay physically consistent with the visual rig size.
    const L = CONFIG.wheelBase * CONFIG.carScale;
    const a = P.cgToFront * L, b = L - a; // cgToFront is a fraction of L, not an absolute distance

    // --- decompose world velocity into the car frame ---
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const sx = fz, sz = -fx;
    let vLong = this.vel.x * fx + this.vel.z * fz;
    let vLat = this.vel.x * sx + this.vel.z * sz;

    // --- steering: max angle shrinks with speed (maxSteer -> maxSteerHigh) ---
    const st = clamp(Math.abs(vLong) / P.maxSpeed, 0, 1);
    const authority = P.maxSteer + (P.maxSteerHigh - P.maxSteer) * Math.pow(st, P.steerShape);
    let target = input.steer * authority;
    // GT-style grip-optimal limiter: clamp the commanded angle so front slip
    // can't overshoot the tire's peak by more than ~15% — full stick corners
    // at max front grip instead of plow-scrubbing. When the car is sideways
    // the clamp window recenters on the velocity direction, which reads as
    // subtle auto-countersteer. steerAssist blends it in (0 = raw).
    if (P.steerAssist > 0 && vLong > P.vBlend) {
      const beta = Math.atan2(vLat + a * this.yawRate, Math.max(vLong, 0.8));
      const m = 1.15 * Math.tan(Math.PI / (2 * P.tireFront.C)) / P.tireFront.B;
      const limited = clamp(clamp(target, beta - m, beta + m), -P.maxSteer, P.maxSteer);
      target += (limited - target) * P.steerAssist;
    }
    const rate = input.steer !== 0 ? P.steerSpeed : P.steerReturnSpeed;
    this.steer += clamp(target - this.steer, -rate * dt, rate * dt);

    // --- vertical load per axle (per-mass units), transfer from the
    //     previous step's accel (stable at 240 Hz substeps) ---
    const transfer = clamp((this.aLong * P.cgHeight * CONFIG.carScale) / L, -0.35 * G, 0.35 * G);
    // v² downforce adds axle load (per-mass units, split by aeroBalance) —
    // plants the car at speed without touching low-speed handling
    const df = P.downforce * vLong * vLong;
    const fzF = Math.max(0.15 * G, G * (b / L) - transfer) + df * P.aeroBalance;
    const fzR = Math.max(0.15 * G, G * (a / L) + transfer) + df * (1 - P.aeroBalance);

    // --- longitudinal demands: brakes per axle + drive to the driven axle(s) ---
    const splitF = P.drivetrain === "fwd" ? 1 : P.drivetrain === "awd" ? P.awdFrontShare : 0;
    let aCmd = 0;
    let axF = 0, axR = 0;   // |longitudinal force| in use per axle (for the ellipse)
    let drive = 0, driveSign = 0;
    if (input.throttle > 0) {
      if (vLong < -0.3) {
        const d = P.brakeDecel / P.mass;
        aCmd += d; axF += d * P.brakeBias; axR += d * (1 - P.brakeBias);
      } else if (vLong < P.maxSpeed) {
        // low gearing multiplies torque when slow — enough to break traction
        const launch = 1 + P.launchTorque * Math.max(0, 1 - Math.abs(vLong) / P.launchFade);
        drive = ((P.engineAccel * surface.power) / P.mass) * launch;
        driveSign = 1;
      }
    }
    if (input.brake > 0) {
      if (vLong > 0.3) {
        const d = P.brakeDecel / P.mass;
        aCmd -= d; axF += d * P.brakeBias; axR += d * (1 - P.brakeBias);
      } else if (vLong > -P.maxReverse) {
        drive = (P.reverseAccel * surface.power) / P.mass;
        driveSign = -1;
      }
    }
    if (input.handbrake && Math.abs(vLong) > 0.1) {
      const d = (P.brakeDecel * 0.45) / P.mass;
      aCmd -= Math.sign(vLong) * d; axR += d;
    }

    // --- wheelspin: drive torque beyond the axle's straight-line traction
    //     spins the tire up (wheel RPM outrunning ground speed) — purely a
    //     torque-vs-grip mismatch, not tied to whatever the axle happens to
    //     be doing laterally, so light steering during a launch doesn't
    //     itself provoke spin. A spinning tire still pushes weaker and loses
    //     lateral grip (see latCap below). ---
    const muLong = P.mu * surface.grip;
    const dF = drive * splitF, dR = drive * (1 - splitF);
    const tracF = muLong * fzF;
    const tracR = muLong * fzR;
    this.spinF = updateSpin(this.spinF, dF, tracF, dt, P);
    this.spinR = updateSpin(this.spinR, dR, tracR, dt, P);
    const appF = Math.min(dF, tracF * (1 - P.wheelspinLongLoss * this.spinF));
    const appR = Math.min(dR, tracR * (1 - P.wheelspinLongLoss * this.spinR));
    aCmd += driveSign * (appF + appR);
    axF += appF; axR += appR;
    this.wheelspin = Math.max(this.spinF, this.spinR);

    let aLong = aCmd;
    aLong -= P.dragK * vLong * Math.abs(vLong);
    if (Math.abs(vLong) > 0.1) aLong -= Math.sign(vLong) * (P.rollingResist + surface.drag);
    // Gravity along the road — a body force (mass-independent, a = g·sinθ,
    // like a ball on a ramp), so unlike tire forces it doesn't touch the
    // friction ellipse budget; a heavier car still struggles more on a hill
    // because its drive force buys less accel margin against this same term.
    aLong -= G * P.slopeGravity * (surface.slope ?? 0);

    // --- lateral grip envelope: μ with the low-speed bite (lateral only,
    //     so launches can still light the tires) ---
    const gripLow = 1 + P.lowSpeedGripBoost * Math.max(0, 1 - Math.abs(vLong) / P.lowSpeedGripFade);
    const mu = P.mu * surface.grip * gripLow;

    // --- friction ellipse: longitudinal use eats lateral capacity ---
    const capF = mu * fzF, capR = mu * fzR;
    let latCapF = Math.sqrt(Math.max(0.01, capF * capF - Math.min(axF, capF) ** 2));
    let latCapR = Math.sqrt(Math.max(0.01, capR * capR - Math.min(axR, capR) ** 2));
    latCapF *= 1 - P.wheelspinLatLoss * this.spinF;
    latCapR *= 1 - P.wheelspinLatLoss * this.spinR;
    if (input.handbrake) latCapR *= P.handbrakeLatFactor;

    // --- slip angles per axle and tire forces ---
    const sgn = vLong >= 0 ? 1 : -1;
    const vAbs = Math.max(Math.abs(vLong), 0.8);
    const alphaF = Math.atan2(vLat + a * this.yawRate, vAbs) - this.steer * sgn;
    const alphaR = Math.atan2(vLat - b * this.yawRate, vAbs);
    // How far past its own peak slip angle the front tire is (0 = at/under
    // peak, 1 = fully into the low-grip tail) — an understeer scrub, not
    // wheelspin, so it needs its own feedback signal (see effects.js/audio
    // wiring) rather than piggybacking on `wheelspin`. alphaF includes the
    // raw -steer term, so it jumps the instant the wheel turns, before the
    // car has actually started sliding — with a small peak angle, even a
    // brief tap would otherwise read the same as sustained understeer.
    // Rise/decay-filtered like wheelspin (spinRise/spinDecay above) so only
    // sustained slip ramps it up.
    const peakF = Math.tan(Math.PI / (2 * P.tireFront.C)) / P.tireFront.B;
    const rawPush = clamp((Math.abs(alphaF) - peakF) / (peakF * 4), 0, 1);
    const pushRate = rawPush > this.frontPush ? 2.5 : 5;
    this.frontPush += clamp(rawPush - this.frontPush, -1, 1) * pushRate * dt;
    this.frontPush = clamp(this.frontPush, 0, 1);
    const FyF = tireForce(latCapF, P.tireFront, alphaF);
    let FyR = tireForce(latCapR, P.tireRear, alphaR);
    // GT-style stability assist: past the rear peak the curve falls, which is
    // the positive-feedback slide. The assist fills that fall back toward
    // peak force — slides still start (yaw momentum can exceed capacity) but
    // don't run away into a spin. Off while the handbrake is down so
    // deliberate slides stay loose.
    if (P.stabilityAssist > 0 && !input.handbrake) {
      const peakR = Math.tan(Math.PI / (2 * P.tireRear.C)) / P.tireRear.B;
      if (Math.abs(alphaR) > peakR)
        FyR += (-Math.sign(alphaR) * latCapR - FyR) * P.stabilityAssist;
    }

    // --- rigid-body dynamics ---
    const cosD = Math.cos(this.steer), sinD = Math.sin(this.steer);
    const Iz = P.gyration * P.gyration; // per-mass yaw inertia
    const yawAcc = (a * FyF * cosD - b * FyR) / Iz;
    const vLatDot = FyF * cosD + FyR;
    const vLongDot = aLong - FyF * sinD;

    // low-speed blend: fade the tire dynamics out, kinematic steering in
    const t = clamp(Math.abs(vLong) / P.vBlend, 0, 1);
    this.yawRate += yawAcc * dt * t;
    vLat += vLatDot * dt * t;
    if (t < 1) {
      const wKin = (vLong / L) * Math.tan(this.steer);
      this.yawRate = this.yawRate * t + wKin * (1 - t);
      vLat *= Math.exp(-8 * (1 - t) * dt);
    }
    this.yawRate = clamp(this.yawRate, -P.maxYawRate, P.maxYawRate);

    vLong += vLongDot * dt;
    vLong = clamp(vLong, -P.maxReverse, P.maxSpeed);
    if (!input.throttle && !input.brake && Math.abs(vLong) < 0.15) {
      vLong = 0;
      if (Math.abs(vLat) < 0.2) { vLat = 0; this.yawRate *= 0.8; }
    }

    this.heading += this.yawRate * dt;

    // --- recompose in the pre-yaw frame; the heading change surfaces as
    //     slip (and speed scrub) on the next decomposition ---
    this.vel.set(fx * vLong + sx * vLat, 0, fz * vLong + sz * vLat);
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    this.vLong = vLong;
    this.vLat = vLat;
    this.aLong = vLongDot;
    this.slip = Math.atan2(vLat, Math.abs(vLong) + 0.001);
    this.drifting = Math.abs(this.slip) > CONFIG.drift.minSlip && Math.abs(vLong) > CONFIG.drift.minSpeed;
  }
}

// Keeps the car inside the barriers. Returns impact speed (m/s) when a
// wall was hit hard enough to care, else 0.
export function collideWithWall(car, q, wallDist) {
  const P = CONFIG.physics;
  const limit = wallDist - P.carRadius * CONFIG.carScale;
  if (Math.abs(q.lateral) <= limit) return 0;
  const sgn = Math.sign(q.lateral);
  const nx = q.s.side.x * sgn, nz = q.s.side.z * sgn; // outward normal
  const overshoot = Math.abs(q.lateral) - limit;
  car.pos.x -= nx * overshoot;
  car.pos.z -= nz * overshoot;
  const vn = car.vel.x * nx + car.vel.z * nz;
  if (vn > 0) {
    car.vel.x -= nx * vn * (1 + P.wallRestitution);
    car.vel.z -= nz * vn * (1 + P.wallRestitution);
    car.vel.multiplyScalar(0.94); // scrub some speed on contact
    return vn;
  }
  return 0;
}

// Same push-out + restitution response as collideWithWall, but against a
// static circular obstacle (cx, cz, radius) instead of a spline-based wall —
// used by editor/tuningLab.html's open plane, which has no track to query.
// The sign flips vs. collideWithWall throughout: a wall's forbidden zone is
// "beyond a limit distance", an obstacle's is "within a radius", so the
// outward normal and the overshoot/approach tests both invert.
export function collideWithObstacle(car, cx, cz, radius) {
  const P = CONFIG.physics;
  const dx = car.pos.x - cx, dz = car.pos.z - cz;
  const dist = Math.hypot(dx, dz);
  const limit = radius + P.carRadius * CONFIG.carScale;
  if (dist >= limit) return 0;
  const nx = dist > 1e-6 ? dx / dist : 1, nz = dist > 1e-6 ? dz / dist : 0; // outward from obstacle center
  const overshoot = limit - dist;
  car.pos.x += nx * overshoot;
  car.pos.z += nz * overshoot;
  const vn = car.vel.x * nx + car.vel.z * nz;
  if (vn < 0) { // moving toward the obstacle's center
    car.vel.x -= nx * vn * (1 + P.wallRestitution);
    car.vel.z -= nz * vn * (1 + P.wallRestitution);
    car.vel.multiplyScalar(0.94);
    return -vn;
  }
  return 0;
}
