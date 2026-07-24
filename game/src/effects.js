// =====================================================================
// Visual effects: skid marks (single ribbon mesh, time-faded in the
// shader), a pooled point-particle system (tire smoke / offroad dust /
// impact sparks), and camera shake state.
// =====================================================================

import * as THREE from "three";

// ---------------------------------------------------------------------
// Skid marks: circular buffer of ground quads, fading via a birth-time
// attribute so aging costs nothing on the CPU.
// ---------------------------------------------------------------------
class SkidMarks {
  constructor(scene, maxQuads = 700) {
    this.max = maxQuads;
    this.head = 0;

    const positions = new Float32Array(maxQuads * 4 * 3);
    const birth = new Float32Array(maxQuads * 4).fill(-1e9);
    const index = new Uint16Array(maxQuads * 6);
    for (let q = 0; q < maxQuads; q++) {
      const v = q * 4, i = q * 6;
      index[i] = v; index[i + 1] = v + 1; index[i + 2] = v + 2;
      index[i + 3] = v + 2; index[i + 4] = v + 1; index[i + 5] = v + 3;
    }

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.birthAttr = new THREE.BufferAttribute(birth, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("birth", this.birthAttr);
    geo.setIndex(new THREE.BufferAttribute(index, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        attribute float birth;
        uniform float uTime;
        varying float vA;
        void main() {
          vA = birth < -1e8 ? 0.0 : 0.7 * clamp(1.0 - (uTime - birth) / 16.0, 0.0, 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying float vA;
        void main() {
          if (vA <= 0.002) discard;
          gl_FragColor = vec4(0.03, 0.03, 0.035, vA);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.scene = scene;
  }

  addQuad(aL, aR, bL, bR, time) {
    const o = this.head * 12;
    const p = this.posAttr.array;
    p[o] = aL.x; p[o + 1] = aL.y; p[o + 2] = aL.z;
    p[o + 3] = aR.x; p[o + 4] = aR.y; p[o + 5] = aR.z;
    p[o + 6] = bL.x; p[o + 7] = bL.y; p[o + 8] = bL.z;
    p[o + 9] = bR.x; p[o + 10] = bR.y; p[o + 11] = bR.z;
    const b = this.head * 4;
    const ba = this.birthAttr.array;
    ba[b] = ba[b + 1] = ba[b + 2] = ba[b + 3] = time;
    this.posAttr.needsUpdate = true;
    this.birthAttr.needsUpdate = true;
    this.head = (this.head + 1) % this.max;
  }

  update(time) {
    this.material.uniforms.uTime.value = time;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------
// Pooled point particles.
// ---------------------------------------------------------------------
class Particles {
  constructor(scene, cap = 500) {
    this.cap = cap;
    this.cursor = 0;
    this.pos = new Float32Array(cap * 3).fill(-9999);
    this.vel = new Float32Array(cap * 3);
    this.age = new Float32Array(cap);
    this.life = new Float32Array(cap); // 0 = dead
    this.size0 = new Float32Array(cap);
    this.grow = new Float32Array(cap);
    this.alpha0 = new Float32Array(cap);
    this.grav = new Float32Array(cap);

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("aSize", this.sizeAttr);
    geo.setAttribute("aAlpha", this.alphaAttr);
    geo.setAttribute("aColor", this.colorAttr);

    this.material = new THREE.ShaderMaterial({
      // uPixelScale: gl_PointSize is in FRAMEBUFFER pixels — when the game
      // renders at a low internal resolution (CONFIG.render.internalHeight)
      // the same point would upscale huge, so main.js scales it down to
      // match. 1 = the full-res look the 160 constant was tuned at.
      uniforms: { uPixelScale: { value: 1 } },
      vertexShader: `
        uniform float uPixelScale;
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vAlpha = aAlpha;
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uPixelScale * (160.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = vAlpha * smoothstep(0.5, 0.12, d);
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor, a);
        }`,
      transparent: true,
      depthWrite: false,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
    this.scene = scene;
  }

  spawn(x, y, z, opt) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.cap;
    const sp = opt.spread ?? 0.3;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = (opt.vx ?? 0) + (Math.random() - 0.5) * sp;
    this.vel[i * 3 + 1] = (opt.vy ?? 0.6) + (Math.random() - 0.5) * sp * 0.5;
    this.vel[i * 3 + 2] = (opt.vz ?? 0) + (Math.random() - 0.5) * sp;
    this.age[i] = 0;
    this.life[i] = opt.life ?? 1;
    this.size0[i] = opt.size ?? 0.3;
    this.grow[i] = opt.grow ?? 0.6;
    this.alpha0[i] = opt.alpha ?? 0.3;
    this.grav[i] = opt.grav ?? 0.2;
    const c = opt.color ?? [0.8, 0.8, 0.8];
    this.colorAttr.array[i * 3] = c[0];
    this.colorAttr.array[i * 3 + 1] = c[1];
    this.colorAttr.array[i * 3 + 2] = c[2];
  }

  update(dt) {
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.life[i] = 0;
        this.alphaAttr.array[i] = 0;
        this.pos[i * 3 + 1] = -9999;
        continue;
      }
      const k = i * 3;
      this.vel[k + 1] += this.grav[i] * dt;
      const damp = 1 - Math.min(0.9, dt * 1.5);
      this.vel[k] *= damp;
      this.vel[k + 2] *= damp;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      const u = this.age[i] / this.life[i];
      this.sizeAttr.array[i] = this.size0[i] * (1 + this.grow[i] * u * 3);
      this.alphaAttr.array[i] = this.alpha0[i] * (1 - u);
    }
    this.posAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------
// High-level manager wired into the game loop.
// ---------------------------------------------------------------------
export class Effects {
  constructor(scene) {
    this.skids = new SkidMarks(scene);
    this.particles = new Particles(scene);
    this.shake = 0;
    this.time = 0;
    this.markPrev = [null, null]; // rear-slide track: { c, l, r } last laid points
    this.markPrevDrive = [null, null]; // driven-axle track (only independent of the above for FWD)
    this.markPrevFront = [null, null]; // front lateral-scrub track (understeer, not wheelspin)
    this.smokeAcc = 0;
    this.smokeAccBurnout = 0;
    this.smokeAccFront = 0;
    this.dustAcc = 0;
    this._tmp = new THREE.Vector3();
  }

  // framebufferHeight / the full-res height the particle sizes were tuned
  // at — called by main.js whenever the internal resolution changes
  setPixelScale(s) {
    this.particles.material.uniforms.uPixelScale.value = s;
  }

  // Skid-ribbon bookkeeping for one wheel pair — shared by the rear-slide
  // track and the driven-axle track so FWD gets its own front ribbon
  // instead of sharing (or worse, fighting over) the rear one.
  _layMarks(prevArr, anchors, active, state, sp) {
    if (active && state.onRoad && sp > 0.3) {
      const vx = state.vel.x / sp, vz = state.vel.z / sp;
      const px = -vz, pz = vx; // perpendicular to travel
      for (let w = 0; w < 2; w++) {
        const wp = anchors[w].getWorldPosition(this._tmp);
        // road elevation under this wheel — fixed world heights bury the
        // marks inside any hill (state.groundYAt is main.js's track query)
        const gy = state.groundYAt ? state.groundYAt(wp.x, wp.z) : 0;
        const y = gy + 0.045 + w * 0.003;
        const c = { x: wp.x, y, z: wp.z };
        const l = { x: c.x + px * 0.075, y, z: c.z + pz * 0.075 };
        const r = { x: c.x - px * 0.075, y, z: c.z - pz * 0.075 };
        const prev = prevArr[w];
        if (prev) {
          const dx = c.x - prev.c.x, dz = c.z - prev.c.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > 4) prevArr[w] = { c, l, r }; // teleported: restart ribbon
          else if (d2 > 0.014) {
            this.skids.addQuad(prev.l, prev.r, l, r, this.time);
            prevArr[w] = { c, l, r };
          }
        } else {
          prevArr[w] = { c, l, r };
        }
      }
    } else {
      prevArr[0] = prevArr[1] = null;
    }
  }

  _spawnSmoke(dt, anchors, sp, accKey, extraRate) {
    this[accKey] += dt * (8 + sp * 0.6 + extraRate);
    while (this[accKey] > 1) {
      this[accKey] -= 1;
      const wp = anchors[(Math.random() * 2) | 0].getWorldPosition(this._tmp);
      const gy = this._groundYAt ? this._groundYAt(wp.x, wp.z) : 0;
      const g = 0.75 + Math.random() * 0.2;
      this.particles.spawn(wp.x, gy + 0.12, wp.z, {
        vy: 0.7 + Math.random() * 0.5, spread: 0.9,
        life: 0.8 + Math.random() * 0.5, size: 0.35, grow: 1.3,
        alpha: 0.26, grav: 0.35, color: [g, g, g],
      });
    }
  }

  // state: { rearSlideMark, driveSpinMark, frontSlideMark, drifting, burnout,
  //          frontScrub, onRoad, speed, vel, rearAnchors, driveAnchors,
  //          frontAnchors, groundYAt }
  update(dt, state) {
    this.time += dt;
    this.skids.update(this.time);
    this.particles.update(dt);
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this._groundYAt = state.groundYAt;

    const sp = state.speed;
    // Wheelspin marking rides along with the rear-slide track when the
    // driven axle IS the rear axle (RWD/AWD) — only FWD needs its own
    // independent front track, since front and rear are different physical
    // wheels then. Prevents double-marking the same wheels for RWD.
    const sameAxle = state.driveAnchors === state.rearAnchors;
    const rearActive = state.rearSlideMark || (sameAxle && state.driveSpinMark);
    const driveActive = !sameAxle && state.driveSpinMark;

    this._layMarks(this.markPrev, state.rearAnchors, rearActive, state, sp);
    this._layMarks(this.markPrevDrive, state.driveAnchors, driveActive, state, sp);
    // Front lateral scrub (understeer) is a separate physical cause from
    // wheelspin — always the front axle regardless of drivetrain, so it gets
    // its own track even when driveAnchors already happens to be the front
    // (FWD): the two can be true independently (spinning AND scrubbing, or
    // just one), and overlapping ribbons at the same wheel are harmless.
    this._layMarks(this.markPrevFront, state.frontAnchors, state.frontSlideMark, state, sp);

    // --- tire smoke: drifting is always a rear-slide phenomenon; wheelspin
    //     burnout smoke comes off whichever axle is actually driven; front
    //     scrub smoke is always at the front ---
    if (state.drifting && state.onRoad) this._spawnSmoke(dt, state.rearAnchors, sp, "smokeAcc", 0);
    if (state.burnout && state.onRoad) this._spawnSmoke(dt, state.driveAnchors, sp, "smokeAccBurnout", 10);
    if (state.frontScrub && state.onRoad) this._spawnSmoke(dt, state.frontAnchors, sp, "smokeAccFront", 0);

    // --- dust offroad ---
    if (!state.onRoad && sp > 4) {
      this.dustAcc += dt * sp * 0.7;
      while (this.dustAcc > 1) {
        this.dustAcc -= 1;
        const wp = state.rearAnchors[(Math.random() * 2) | 0].getWorldPosition(this._tmp);
        const gy = state.groundYAt ? state.groundYAt(wp.x, wp.z) : 0;
        this.particles.spawn(wp.x, gy + 0.1, wp.z, {
          vy: 0.5 + Math.random() * 0.4, spread: 1.1,
          life: 1 + Math.random() * 0.6, size: 0.4, grow: 1.1,
          alpha: 0.22, grav: 0.1, color: [0.72, 0.6, 0.42],
        });
      }
    }
  }

  // Wall or car hit: sparks + camera shake.
  impact(x, y, z, nx, nz, strength) {
    this.shake = Math.min(0.5, this.shake + strength * 0.06);
    const n = Math.min(18, 5 + strength * 2) | 0;
    for (let i = 0; i < n; i++) {
      this.particles.spawn(x, y + 0.15, z, {
        vx: -nx * (1 + Math.random() * 2.5),
        vz: -nz * (1 + Math.random() * 2.5),
        vy: 0.8 + Math.random() * 2,
        spread: 2.2,
        life: 0.25 + Math.random() * 0.3,
        size: 0.09, grow: 0.1,
        alpha: 0.9, grav: -9,
        color: [1, 0.72 + Math.random() * 0.2, 0.25],
      });
    }
  }

  dispose() {
    this.skids.dispose();
    this.particles.dispose();
  }
}
