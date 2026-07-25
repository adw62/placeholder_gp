// =====================================================================
// Collision wireframe overlay (toggle: G). Draws what the PHYSICS thinks is
// there, so it can be compared against what's rendered:
//
//   wall fence   the per-sample collidable plane (track.wallDistAt) on both
//                sides, as a ground rail + top rail + vertical ties. MAGENTA
//                where a barrier band narrows it in, BLUE where nothing does
//                and it's the flat halfW + wallMargin fallback. If a magenta
//                fence doesn't sit on the barrier mesh, the wall and the art
//                disagree; if it goes blue alongside a visible barrier, that
//                barrier isn't collidable there at all.
//   car boxes    the oriented footprint collision actually uses
//                (CONFIG.physics.carHalfLength/carHalfWidth x carScale, the
//                same rectangle obbOverlap and halfExtentAlong measure from)
//                — GREEN for the player, YELLOW for AI. Note it's a box: at
//                an angle its corners reach past the bodywork, which is why
//                a yawed car can touch a wall with visible daylight at its
//                flank.
//
// Drawn with depthTest off so the fence stays visible through the barrier
// mesh it's supposed to line up with — the whole point is seeing both at once.
// That would otherwise paint the whole lap's fence over the sky and hills, so
// each side's fence is one geometry with a FIXED stride per sample, letting
// setFocus() clip it to a window around the car with drawRange.
// =====================================================================

import * as THREE from "three";
import { CONFIG } from "../../shared/src/config.js";
import { SEG_STRIDE } from "../../shared/src/barriers.js";

const WALL_BARRIER = [1, 0.2, 1];   // magenta: a barrier band sets this
const WALL_FALLBACK = [0.3, 0.6, 1]; // blue: uniform margin, no collidable band
const TIE_EVERY = 6;                 // samples between vertical ties
const VERTS_PER_SAMPLE = 6;          // ground rail 2 + top rail 2 + tie 2 (see buildWall)
// How far either side of the car to draw. Kept short (~38 m) because with
// depthTest off, fence far enough ahead to sit above the horizon in screen
// space paints over the sky and scenery — past this it's clutter, not context.
const FOCUS_SAMPLES = 45;

export class CollisionDebug {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    const lineMat = () =>
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, transparent: true });

    // One mesh per side so each gets its own drawRange window (see setFocus).
    this.walls = [1, -1].map(() => {
      const m = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat());
      m.frustumCulled = false;
      m.renderOrder = 999;
      this.group.add(m);
      return m;
    });
    this.N = 0;

    this.boxes = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat());
    this.boxes.frustumCulled = false;
    this.boxes.renderOrder = 1000;
    this.group.add(this.boxes);

    this._boxCap = 0; // grown on demand, see update()
  }

  setVisible(on) {
    this.group.visible = on;
  }

  // Static geometry — rebuild once per race (the wall profile is baked at
  // buildTrack time and never changes during a race).
  // Drawn straight from track.barriers — the exact segment list
  // physics.js's collideWithBarriers collides against, so "the wireframe says
  // I'm clear but I got hit" is no longer possible: they are one dataset.
  // Segments come in two runs (one per side); each run gets its own mesh so
  // setFocus can clip it independently.
  buildWall(track) {
    const { segs, count } = track.barriers;
    const N = (this.N = track.samples.length);
    const fallback = track.halfW + CONFIG.track.wallMargin;
    const top = CONFIG.track.wallHeight;
    const half = Math.floor(count / 2); // segments per side (closed loops)
    this.perSide = half;

    // A segment is coloured by whether its own distance is the flat fallback,
    // which needs the sample's wall distance — read it back per side.
    for (let si = 0; si < 2; si++) {
      const sign = si === 0 ? 1 : -1;
      const base = si * half;
      const n = si === 0 ? half : count - half;
      const pos = new Float32Array(n * VERTS_PER_SAMPLE * 3);
      const col = new Float32Array(n * VERTS_PER_SAMPLE * 3);
      let o = 0;
      const push = (x, y, z, c) => {
        pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
        col[o] = c[0]; col[o + 1] = c[1]; col[o + 2] = c[2];
        o += 3;
      };
      for (let k = 0; k < n; k++) {
        const s = (base + k) * SEG_STRIDE;
        const ax = segs[s], az = segs[s + 1], bx = segs[s + 2], bz = segs[s + 3];
        // Ground height under the segment: the road surface at that sample.
        const ay = track.samples[k % N].p.y;
        const d = track.wallDistAt(k % N, sign);
        const c = Math.abs(d - fallback) < 1e-4 ? WALL_FALLBACK : WALL_BARRIER;
        push(ax, ay + 0.02, az, c); // ground rail
        push(bx, ay + 0.02, bz, c);
        push(ax, ay + top, az, c);  // top rail, at the height the art is drawn to
        push(bx, ay + top, bz, c);
        // Vertical tie so the fence reads as a surface. Every segment emits one
        // to keep the stride fixed for setFocus's drawRange; non-tie ones
        // collapse to a zero-length segment, which draws nothing.
        const tie = k % TIE_EVERY === 0;
        push(ax, ay + 0.02, az, c);
        push(ax, ay + (tie ? top : 0.02), az, c);
      }
      const m = this.walls[si];
      m.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      m.geometry = g;
    }
    this.setFocus(0);
  }

  // Clip both fences to a window around the car's current sample. Without this
  // the depthTest-off fence paints the whole lap over the sky. The window is
  // one contiguous drawRange, so it stops short of wrapping past the
  // start/finish line rather than splitting into two draws — the far end just
  // isn't drawn for a moment as you cross the line.
  setFocus(idx) {
    if (!this.perSide) return;
    const lo = Math.max(0, Math.min(this.perSide - 1, idx - FOCUS_SAMPLES));
    const hi = Math.max(0, Math.min(this.perSide - 1, idx + FOCUS_SAMPLES));
    for (const m of this.walls) {
      m.geometry.setDrawRange(lo * VERTS_PER_SAMPLE, (hi - lo + 1) * VERTS_PER_SAMPLE);
    }
  }

  // cars: [{ x, z, y, heading, player }] — called per frame while visible.
  update(cars) {
    if (!this.group.visible) return;
    const hl = CONFIG.physics.carHalfLength * CONFIG.carScale;
    const hw = CONFIG.physics.carHalfWidth * CONFIG.carScale;

    // 4 edges x 2 verts, twice (a footprint outline at wheel height and again
    // a little higher, so the box is legible from the chase camera).
    const vertsPerCar = 16;
    if (this._boxCap < cars.length) {
      this._boxCap = cars.length;
      this.boxes.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(this._boxCap * vertsPerCar * 3), 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(this._boxCap * vertsPerCar * 3), 3));
      this.boxes.geometry = g;
    }
    const P = this.boxes.geometry.attributes.position.array;
    const C = this.boxes.geometry.attributes.color.array;

    let o = 0;
    for (const car of cars) {
      const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
      const sx = fz, sz = -fx;
      // corners in order, so consecutive pairs form the outline
      const cx = [
        [car.x + fx * hl + sx * hw, car.z + fz * hl + sz * hw],
        [car.x + fx * hl - sx * hw, car.z + fz * hl - sz * hw],
        [car.x - fx * hl - sx * hw, car.z - fz * hl - sz * hw],
        [car.x - fx * hl + sx * hw, car.z - fz * hl + sz * hw],
      ];
      const r = car.player ? 0.2 : 1, g2 = 1, b = car.player ? 0.4 : 0.2;
      for (const dy of [0.04, 0.45]) {
        for (let k = 0; k < 4; k++) {
          const p0 = cx[k], p1 = cx[(k + 1) % 4];
          for (const p of [p0, p1]) {
            P[o] = p[0]; P[o + 1] = car.y + dy; P[o + 2] = p[1];
            C[o] = r; C[o + 1] = g2; C[o + 2] = b;
            o += 3;
          }
        }
      }
    }
    // Collapse any unused capacity to a degenerate point so stale cars (a
    // previous race's bigger AI count) don't leave ghost boxes on screen.
    for (; o < P.length; o++) P[o] = 0;

    this.boxes.geometry.attributes.position.needsUpdate = true;
    this.boxes.geometry.attributes.color.needsUpdate = true;
    this.boxes.geometry.setDrawRange(0, cars.length * vertsPerCar);
  }

  dispose() {
    this.scene.remove(this.group);
    for (const m of [...this.walls, this.boxes]) {
      m.geometry.dispose();
      m.material.dispose();
    }
  }
}
