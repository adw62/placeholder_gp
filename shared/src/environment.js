// =====================================================================
// Environment: theme application (sky/fog/lights) and procedural
// scenery scattered relative to the track spline — so any new track
// automatically gets ground, hills, trees, rocks and billboards without
// hand-placement. Spectators are the "Cutout: Crowd" billboard type
// (trackObjects.js), placed explicitly via bands/points, not ambient here.
// =====================================================================

import * as THREE from "three";
import { grassTexture, desertTexture, buildTree, buildRock, buildBillboard } from "./placeholders.js";

// Ground follows nearby track elevation (blending to flat past FALLOFF
// meters) instead of a flat disc, so raised/dipped road doesn't float or
// dig into terrain. The flush zone must cover the *whole road width*, not
// just the centerline, or the ground dips away from the ribbon on a slope;
// it must also sit a hair below the road (never exactly flush) or the two z-fight.
const GROUND_SIZE = 900;
// Coarse grid on tight corners visibly pokes through the road on one side
// of the bend. Rebuild is a manual "Generate" action (not per-frame), so a dense grid is affordable.
const GROUND_SEGS = 220;
const GROUND_FALLOFF = 60;
const GROUND_FLUSH_MARGIN = 1.5; // beyond the road edge, still held flush before falling off
const GROUND_DROP = 0.08; // sit slightly below the road ribbon, never through it
const HEIGHT_SAMPLE_STRIDE = 2;

function buildGroundGeometry(track, center) {
  const geo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, GROUND_SEGS, GROUND_SEGS);
  const pos = geo.attributes.position;
  const heightSamples = [];
  for (let i = 0; i < track.samples.length; i += HEIGHT_SAMPLE_STRIDE) heightSamples.push(track.samples[i]);
  const flushDist = track.wallDist + GROUND_FLUSH_MARGIN;
  for (let i = 0; i < pos.count; i++) {
    // Plane is rotated -90deg about X to lie flat: local z -> world height, local (x,y) -> world (x,z).
    const wx = pos.getX(i) + center.x, wz = -pos.getY(i) + center.z;
    let bestD2 = Infinity, bestY = 0;
    for (const s of heightSamples) {
      const dx = wx - s.p.x, dz = wz - s.p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; bestY = s.p.y; }
    }
    const d = Math.sqrt(bestD2);
    const t = d <= flushDist ? 1 : THREE.MathUtils.clamp(1 - (d - flushDist) / GROUND_FALLOFF, 0, 1);
    pos.setZ(i, bestY * t - GROUND_DROP * t);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

// Deterministic per-track RNG so scenery doesn't reshuffle every restart.
export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function applyTheme(theme, scene, sun, hemi) {
  scene.background = new THREE.Color(theme.sky);
  scene.fog = new THREE.Fog(theme.fog ?? theme.sky, theme.fogNear ?? 70, theme.fogFar ?? 320);
  sun.color.set(theme.sun ?? 0xfff4e0);
  sun.intensity = theme.sunIntensity ?? 2.2;
  hemi.intensity = theme.hemiIntensity ?? 0.9;
  hemi.groundColor.set(theme.ground);
}

// Default sun angle reproduces the old hardcoded direction ratio
// (0.52, 0.78, -0.35) that every track used before per-track control existed,
// so tracks without explicit sunAzimuthDeg/sunElevationDeg look unchanged.
export const DEFAULT_SUN_AZIMUTH_DEG = 124;
export const DEFAULT_SUN_ELEVATION_DEG = 51;

// Unit direction FROM a target TOWARD the sun. azimuth: compass bearing in
// the XZ plane, 0=+Z, 90=+X (matches the atan2(dx,dz) heading convention
// used elsewhere in this codebase). elevation: 0=horizon, 90=overhead.
// Callers scale by their own distance-fit and add to their light's target.
export function sunDirection(theme) {
  const az = THREE.MathUtils.degToRad(theme?.sunAzimuthDeg ?? DEFAULT_SUN_AZIMUTH_DEG);
  const el = THREE.MathUtils.degToRad(theme?.sunElevationDeg ?? DEFAULT_SUN_ELEVATION_DEG);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

// The DirectionalLight that actually lights the scene has no visual
// presence of its own — without this, "the sun" is invisible in both the
// game and the editor no matter where you point it. Built once (shared by
// game and editor so their look can't drift apart) as a soft radial-gradient
// sprite; buildSunVisual() makes the group, applySunVisual() repositions/
// rescales/recolors it per track.
function buildSunTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.3, "rgba(255,255,255,0.85)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

const SUN_CORE_BASE_SIZE = 9;
const SUN_HALO_BASE_SIZE = 26;

// Distance the visual disc sits at, independent of any per-track shadow-fit
// distance (which scales with track size and made the disc look "close" —
// practically in the scenery — on smaller tracks). A real sun reads as
// very far away regardless of track size, so this is one fixed constant
// both game (camera far 900) and editor (camera far 1500) stay well inside.
export const DEFAULT_SUN_VISUAL_DISTANCE = 560;

export function buildSunVisual() {
  const tex = buildSunTexture();
  const spriteMat = () =>
    new THREE.SpriteMaterial({ map: tex, transparent: true, fog: false, depthWrite: false, blending: THREE.AdditiveBlending });
  const halo = new THREE.Sprite(spriteMat());
  const core = new THREE.Sprite(spriteMat());
  const group = new THREE.Group();
  group.add(halo, core);
  group.userData.halo = halo;
  group.userData.core = core;
  return group;
}

// Real setting suns get bigger, redder, and hazier near the horizon
// (atmospheric scattering scales with the much longer path length light
// travels through the atmosphere at low angles). Concentrated in the
// bottom ~35 degrees of sky rather than linear across the whole dome, so a
// noon sun stays a small clean disc and only a genuinely low sun blooms out
// — this is the "varies with height" effect a sunset needs. Shared by the
// sun disc itself and the sky-glow dome below so both warm up in lockstep.
const SUNSET_TINT = 0xffa348;
const SUNSET_ELEVATION_BAND_DEG = 35;

export function sunsetState(theme) {
  const elevation = theme?.sunElevationDeg ?? DEFAULT_SUN_ELEVATION_DEG;
  const horizon = THREE.MathUtils.clamp(1 - elevation / SUNSET_ELEVATION_BAND_DEG, 0, 1);
  const base = new THREE.Color(theme?.sun ?? 0xfff4e0);
  const tinted = base.clone().lerp(new THREE.Color(SUNSET_TINT), horizon * 0.6);
  return { horizon, tinted };
}

export function applySunVisual(group, theme, target, distance) {
  const dir = sunDirection(theme);
  group.position.set(target.x + dir.x * distance, target.y + dir.y * distance, target.z + dir.z * distance);

  const { horizon, tinted } = sunsetState(theme);

  const { halo, core } = group.userData;
  halo.material.color.copy(tinted);
  halo.material.opacity = 0.1 + horizon * 0.16;
  const haloSize = SUN_HALO_BASE_SIZE * (1 + horizon * 1.4);
  halo.scale.set(haloSize, haloSize, 1);

  core.material.color.copy(tinted).lerp(new THREE.Color(0xffffff), 1 - horizon * 0.6);
  core.material.opacity = 0.4 + horizon * 0.15;
  const coreSize = SUN_CORE_BASE_SIZE * (1 + horizon * 0.9);
  core.scale.set(coreSize, coreSize, 1);
}

// Sky dome: a huge inward-facing sphere, always recentered on the camera
// (see callers' render loops), that blends the track's base sky color
// toward the sun's own color in a soft radial glow anchored on the sun's
// actual direction — the "sky reacts to the sun" effect a flat background
// color can't give you. Glow strength follows the same horizon factor as
// the disc, so it's negligible at noon and pronounced at sunset.
const SKY_DOME_RADIUS = 820;
const SKY_VERTEX_SHADER = `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAGMENT_SHADER = `
  uniform vec3 skyColor;
  uniform vec3 glowColor;
  uniform vec3 sunDir;
  uniform float glowStrength;
  varying vec3 vDir;
  void main() {
    // Angle-based falloff, not a power of the dot product: a pow() curve
    // of cos(angle) barely decays within the first 20-30 degrees off axis,
    // which reads as the glow flooding the whole camera frustum whenever
    // the sun is anywhere near forward. Working in actual degrees gives a
    // tight bright core plus a wider soft bloom that both fully fade out
    // by a fixed, predictable angle regardless of FOV.
    float angleDeg = degrees(acos(clamp(dot(normalize(vDir), sunDir), -1.0, 1.0)));
    float halo = 1.0 - smoothstep(0.0, 10.0, angleDeg);
    float spread = 1.0 - smoothstep(0.0, 40.0, angleDeg);
    float glow = clamp((halo * 0.55 + spread * 0.45) * glowStrength * 0.55, 0.0, 1.0);
    gl_FragColor = vec4(mix(skyColor, glowColor, glow), 1.0);
  }
`;

export function buildSkyDome() {
  const geo = new THREE.SphereGeometry(SKY_DOME_RADIUS, 24, 16);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      skyColor: { value: new THREE.Color(0x87ceeb) },
      glowColor: { value: new THREE.Color(SUNSET_TINT) },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      glowStrength: { value: 0 },
    },
    vertexShader: SKY_VERTEX_SHADER,
    fragmentShader: SKY_FRAGMENT_SHADER,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.renderOrder = -1;
  dome.frustumCulled = false;
  return dome;
}

export function applySkyDome(dome, theme) {
  const dir = sunDirection(theme);
  const { horizon, tinted } = sunsetState(theme);
  dome.material.uniforms.skyColor.value.set(theme?.sky ?? 0x87ceeb);
  dome.material.uniforms.glowColor.value.copy(tinted);
  dome.material.uniforms.sunDir.value.set(dir.x, dir.y, dir.z);
  dome.material.uniforms.glowStrength.value = horizon;
}

export function buildEnvironment(def, track, rng) {
  const theme = def.theme;
  const group = new THREE.Group();

  const box = new THREE.Box3();
  for (const s of track.samples) box.expandByPoint(s.p);
  const center = box.getCenter(new THREE.Vector3());

  // --- ground (follows nearby track elevation) ---
  const gTex = theme.terrain === "desert" ? desertTexture(theme.ground) : grassTexture(theme.ground);
  gTex.repeat.set(90, 90);
  const ground = new THREE.Mesh(
    buildGroundGeometry(track, center),
    new THREE.MeshStandardMaterial({ map: gTex, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(center.x, 0, center.z);
  ground.receiveShadow = true;
  group.add(ground);

  // --- distant hills ring ---
  // Flat painted-backdrop hills: half-ellipse cards facing the track,
  // unlit (MeshBasic) so they read as distant haze silhouettes rather
  // than shaded geometry — fog still grades them into the sky.
  const hillMat = new THREE.MeshBasicMaterial({ color: theme.hill ?? 0x5e7a55, side: THREE.DoubleSide });
  for (let i = 0; i < 16; i++) {
    const ang = (i / 16) * Math.PI * 2 + rng() * 0.3;
    const r = 300 + rng() * 90;
    const h = 12 + rng() * 20;
    const w = 140 + rng() * 140;
    const shape = new THREE.Shape();
    shape.absellipse(0, 0, w / 2, h, 0, Math.PI);
    const hill = new THREE.Mesh(new THREE.ShapeGeometry(shape, 10), hillMat);
    hill.position.set(center.x + Math.cos(ang) * r, -2, center.z + Math.sin(ang) * r);
    hill.lookAt(center.x, -2, center.z);
    group.add(hill);
  }

  const clearOfTrack = (x, z, need) => {
    const n2 = need * need;
    for (let i = 0; i < track.samples.length; i += 3) {
      const p = track.samples[i].p;
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz < n2) return false;
    }
    return true;
  };

  // --- scattered props, placed relative to the spline ---
  const scatter = (count, builder) => {
    for (let n = 0; n < count; n++) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const s = track.samples[(rng() * track.samples.length) | 0];
        const sign = rng() < 0.5 ? -1 : 1;
        const d = track.wallDist + 3 + rng() * rng() * 90;
        const x = s.p.x + s.side.x * d * sign;
        const z = s.p.z + s.side.z * d * sign;
        if (!clearOfTrack(x, z, track.wallDist + 2)) continue;
        const obj = builder(rng);
        obj.position.set(x, 0, z);
        obj.rotation.y = rng() * Math.PI * 2;
        group.add(obj);
        break;
      }
    }
  };
  scatter(theme.props?.trees ?? 70, buildTree);
  scatter(theme.props?.rocks ?? 15, buildRock);

  // --- billboards facing the road ---
  const nBill = theme.props?.billboards ?? 4;
  for (let k = 0; k < nBill; k++) {
    const i = Math.floor(((k + 0.5) / nBill) * track.samples.length);
    const s = track.samples[i];
    const sign = k % 2 === 0 ? 1 : -1;
    const d = track.wallDist + 4;
    const x = s.p.x + s.side.x * d * sign;
    const z = s.p.z + s.side.z * d * sign;
    if (!clearOfTrack(x, z, track.wallDist + 1.5)) continue;
    const b = buildBillboard(rng);
    b.position.set(x, 0, z);
    b.lookAt(s.p.x, 0, s.p.z);
    group.add(b);
  }

  return group;
}
