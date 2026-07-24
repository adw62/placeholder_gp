#!/usr/bin/env node
// =====================================================================
// Headless Scene Forge export: opens a .forge.json project in the real
// Scene Forge page and clicks Export .gltf — so the atlas/UV/export logic
// has exactly one implementation (index.html's), and a generated car can
// reach the game with zero clicks when no hand-polish pass is needed.
//
//   node tools/forge-export.js <project.forge.json> [--out file.gltf]
//
// Default out: game/assets/models/cars/<name>.gltf (the game-facing
// destination; registration in ASSETS.carModels stays a deliberate,
// separate step — see build-car.js's printed snippet).
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./lib/serve.js";
import { launch, awaitReady } from "./lib/browser.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.join(ROOT, "..");
const [, , projPath, ...rest] = process.argv;
if (!projPath) {
  console.error("usage: forge-export.js <project.forge.json> [--out file.gltf]");
  process.exit(2);
}
const rel = path.relative(REPO, path.resolve(projPath)).replaceAll(path.sep, "/");
if (rel.startsWith("..")) throw new Error(`project must live inside the repo: ${projPath}`);
const outIdx = rest.indexOf("--out");
const outFile =
  outIdx >= 0
    ? path.resolve(rest[outIdx + 1])
    : path.join(REPO, "game/assets/models/cars", path.basename(rel).replace(/\.forge\.json$/, "") + ".gltf");

const dlDir = fs.mkdtempSync(path.join(ROOT, "work", ".export-"));
const { url, stop } = await serve(REPO);
const browser = await launch();
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("[page]", e.message));
  page.on("dialog", async (d) => { console.error("[page dialog]", d.message()); await d.dismiss(); });
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir });
  await page.goto(`${url}/editor/forge/index.html?project=${encodeURIComponent("/" + rel)}`, { waitUntil: "load" });
  await awaitReady(page);
  await page.click("#export");
  const t0 = Date.now();
  let file;
  while (Date.now() - t0 < 30000) {
    file = fs.readdirSync(dlDir).find((f) => f.endsWith(".gltf"));
    if (file) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!file) throw new Error("export produced no .gltf within 30 s");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.copyFileSync(path.join(dlDir, file), outFile);
  const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
  console.log(`${outFile} (${kb} kB)`);
} finally {
  fs.rmSync(dlDir, { recursive: true, force: true });
  await browser.close();
  stop();
}
