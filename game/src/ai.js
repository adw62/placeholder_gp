// =====================================================================
// AI opponents. They follow the track spline with a per-car lateral
// line + gentle wander, driving at a per-sample target speed derived
// from curvature with braking look-ahead (precomputed in track.js).
// Mild rubber-banding keeps the race close without being obvious.
// =====================================================================

import * as THREE from "three";
import { CONFIG } from "../../shared/src/config.js";
import { buildOpponentCar, WHEEL } from "../../shared/src/placeholders.js";

export class AIRacer {
  constructor(track, { skill, color, offset, startS, startLat, carId }) {
    this.track = track;
    this.skill = skill;
    this.baseOffset = offset;
    this.s = startS;
    this.off = startLat;
    this.v = 0;
    this.lap = 0;
    this.finished = false;
    this.wobbleT = Math.random() * 10;

    const { group, spinPivots } = buildOpponentCar(color, carId);
    this.group = group;
    this.spinPivots = spinPivots;
    this.color = color;
    this.pos = new THREE.Vector3();
    this.tan = new THREE.Vector3();
    this.place();
  }

  // Continuous race progress in laps (for ranking + rubber-band).
  get progress() {
    return this.lap + this.s / this.track.length;
  }

  update(dt, rubber = 1) {
    const A = CONFIG.ai;
    const N = this.track.samples.length;
    const idx = Math.floor((this.s / this.track.length) * N) % N;

    let vt = this.track.vtAI[idx] * this.skill * rubber;
    if (this.finished) vt = Math.min(vt, 12); // cruise after the flag

    if (this.v < vt) this.v = Math.min(vt, this.v + A.accel * dt);
    else this.v = Math.max(vt, this.v - A.brake * dt);

    this.s += this.v * dt;
    if (this.s >= this.track.length) {
      this.s -= this.track.length;
      this.lap++;
    }

    this.wobbleT += dt;
    const maxOff = this.track.halfW - 1;
    const targetOff = THREE.MathUtils.clamp(
      this.baseOffset * 0.85 + Math.sin(this.wobbleT * 0.7) * 0.5,
      -maxOff, maxOff
    );
    this.off += (targetOff - this.off) * Math.min(1, dt * 0.8);

    this.place();
    for (const sp of this.spinPivots) sp.rotation.x += (this.v / WHEEL.radius) * dt;
  }

  place() {
    this.track.posAt(this.s, this.off, this.pos, this.tan);
    this.group.position.copy(this.pos);
    this.group.rotation.y = Math.atan2(this.tan.x, this.tan.z);
  }
}
