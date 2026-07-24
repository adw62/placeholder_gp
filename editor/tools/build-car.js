#!/usr/bin/env node
// =====================================================================
// Car kit (schemas/carkit.schema.json) → Scene Forge project (.forge.json).
//
//   node tools/build-car.js <kit.json> [--out file.forge.json] [--no-paint]
//
// Thin CLI over tools/lib/carlib.js — the SAME loft/wiring code Scene
// Forge's "🚗 From photo" / "🎨 Auto livery" buttons run, so a car built
// here and one generated in the editor are identical. Geometry is authored
// at gltf scale (game meters / CONFIG.carScale), +Z nose, ground aligned to
// the wheel rig (WHEEL.localY − WHEEL.radius parsed from placeholders.js).
//
// A `livery` block makes this run tools/paint-car.py (PIL) and wire every
// body face as a real photo grab with exact handles — each face stays fully
// hand-editable in Scene Forge (📂 Load / drag-drop / ?project=). Pixel
// conventions live in paint-car.py's header and carlib.js — keep in sync.
//
// Output → Scene Forge polish → Export .gltf → register in ASSETS.carModels
// (the registration snippet, wheelOffset included, is printed here).
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../../shared/src/config.js";
import { parseWheel, loftKit, deriveGeom, wireLivery } from "./lib/carlib.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [, , kitPath, ...rest] = process.argv;
if (!kitPath) {
  console.error("usage: build-car.js <kit.json> [--out file.forge.json] [--no-paint]");
  process.exit(2);
}
const kit = JSON.parse(fs.readFileSync(kitPath, "utf8"));
const WHEEL = parseWheel(fs.readFileSync(path.join(ROOT, "..", "shared/src/placeholders.js"), "utf8"));
const SCALE = CONFIG.carScale;

let project, warnings;
try {
  ({ project, warnings } = loftKit(kit, WHEEL, SCALE));
} catch (e) {
  console.error(`kit error: ${e.message}`);
  process.exit(1);
}
for (const w of warnings) console.warn(`warn: ${w}`);

// --- livery: paint synthetic photos (paint-car.py), wire faces as grabs ---
const lv = kit.livery && !rest.includes("--no-paint") ? kit.livery : null;
if (lv) {
  const res = spawnSync("python3", [path.join(ROOT, "tools/paint-car.py"), path.resolve(kitPath)], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (res.status !== 0) {
    console.error("paint-car.py failed");
    process.exit(1);
  }
  const texDir = path.join(ROOT, "work/cars", `${kit.id}.textures`);
  project.photos = ["side_right.png", "side_left.png", "wrap.png"].map(
    (n) => "data:image/png;base64," + fs.readFileSync(path.join(texDir, n)).toString("base64")
  );
  project.activePhoto = 0;
  const body = project.objects[0];
  const geom = deriveGeom(project.verts, body, WHEEL, SCALE, kit);
  const wires = wireLivery(project.verts, body, geom, WHEEL, SCALE);
  for (const [name, w] of Object.entries(wires))
    project.fills[name] = {
      type: "photo", src: w.src.map(([x, y]) => ({ x, y })), rot: 0, flip: false, photo: w.slot,
      // side caps span the whole car — bigger stylize budget than the strips
      // or their decals blur out (px/m parity with the top)
      sty: { size: w.big ? 512 : 256, colors: 24, dither: true, ditherAmt: 0.5 },
    };
}

// --- emit project ---
const outIdx = rest.indexOf("--out");
const outFile = outIdx >= 0 ? path.resolve(rest[outIdx + 1]) : path.join(ROOT, "work/cars", `${kit.id}.forge.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(project));

// --- report + registration snippet ---
const verts = project.verts;
const nFaces = project.objects.reduce((a, o) => a + o.faces.length, 0);
const allY = verts.map((v) => v[1]), allX = verts.map((v) => v[0]), allZ = verts.map((v) => v[2]);
const span = (a) => Math.max(...a) - Math.min(...a);
console.log(`${outFile}`);
console.log(`  ${verts.length} verts, ${nFaces} faces (${project.objects.length} object${project.objects.length > 1 ? "s" : ""})`);
console.log(`  gltf-scale bounds ${span(allX).toFixed(2)} × ${span(allY).toFixed(2)} × ${span(allZ).toFixed(2)} → in-game ${(span(allX) * SCALE).toFixed(2)} × ${(span(allY) * SCALE).toFixed(2)} × ${(span(allZ) * SCALE).toFixed(2)} m (W×H×L)`);
const wheelOffset = {};
if (kit.wheels) {
  const map = { x: "localX", y: "localY", frontZ: "frontZ", rearZ: "rearZ" };
  for (const [kitKey, wKey] of Object.entries(map))
    if (kit.wheels[kitKey] !== undefined && Math.abs(kit.wheels[kitKey] / SCALE - WHEEL[wKey]) > 0.005)
      wheelOffset[wKey] = +(kit.wheels[kitKey] / SCALE).toFixed(3);
}
console.log(`\n  Next: tweak/texture in Scene Forge → Export .gltf → save as game/assets/models/cars/${kit.id}.gltf`);
console.log(`  then register in placeholders.js ASSETS.carModels:`);
console.log(`    { id: ${JSON.stringify(kit.id)}, name: ${JSON.stringify(kit.name ?? kit.id)}, url: ${JSON.stringify(`assets/models/cars/${kit.id}.gltf`)}${Object.keys(wheelOffset).length ? `, wheelOffset: ${JSON.stringify(wheelOffset)}` : ""} },`);
console.log(`  verify: node tools/screenshot.js forge ${path.relative(ROOT, outFile)}`);
