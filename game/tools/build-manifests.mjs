// =====================================================================
// Regenerates the manifest.json files that game/src/levels.js,
// game/src/carProfiles.js, shared/src/crowd.js and shared/src/placeholders.js
// fetch to discover which files live in a given folder — levels/,
// carProfiles/, assets/crowd/, assets/models/cars/, and every
// assets/textures/<name>/ folder.
//
// Static hosts (GitHub Pages included) don't return a directory listing for
// a folder URL, so those modules can't discover files by parsing one (that
// only ever worked against Python's `http.server`, which does). A
// manifest.json is just a plain file at a known path, so it works
// everywhere a static host works — that's the whole fix.
//
// Run this after adding/removing/renaming any file in one of those folders:
//   node game/tools/build-manifests.mjs
// =====================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GAME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeManifest(dir, isMatch) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f !== "manifest.json" && isMatch(f)).sort();
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(files, null, 2) + "\n");
  console.log(`${path.relative(GAME_ROOT, dir)}/manifest.json (${files.length})`);
}

const jsonFile = (f) => f.endsWith(".json");
const crowdKitFile = (f) => f.endsWith(".crowd.json");
const carModelFile = (f) => /\.(gltf|glb)$/i.test(f);
const imageFile = (f) => /\.(png|jpe?g|webp)$/i.test(f);

writeManifest(path.join(GAME_ROOT, "levels"), jsonFile);
writeManifest(path.join(GAME_ROOT, "carProfiles"), jsonFile);
writeManifest(path.join(GAME_ROOT, "assets/crowd"), crowdKitFile);
writeManifest(path.join(GAME_ROOT, "assets/models/cars"), carModelFile);

const texturesDir = path.join(GAME_ROOT, "assets/textures");
if (fs.existsSync(texturesDir)) {
  for (const name of fs.readdirSync(texturesDir)) {
    const dir = path.join(texturesDir, name);
    if (fs.statSync(dir).isDirectory()) writeManifest(dir, imageFile);
  }
}
