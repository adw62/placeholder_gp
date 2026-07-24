#!/usr/bin/env node
// =====================================================================
// Headless capture for the pipeline. Spawns its own dev server (rooted at
// the repo root — placeholder_gp/, so game/, editor/, and shared/ are all
// reachable), drives cached Chromium, writes PNGs under work/shots/.
//
//   node tools/screenshot.js race  <trackId> [--wait 6000]   in-game view (?track= skips the menu)
//   node tools/screenshot.js track <trackId> [--s 0.25 --lat 0 --h 3 --ahead 25 | --cam x,y,z --look x,y,z]
//                                                            preview.html; no --s/--cam = whole-track overhead
//   node tools/screenshot.js sheet <trackId> [--shots 8 --h 3 --lat 0]
//                                                            overhead + N on-track shots spaced around the lap
//   node tools/screenshot.js car   <carId>   [--yaw 35 --pitch 18 --dist 4 --url path.gltf]
//                                                            carViewer.html; --url inspects an unregistered file
//   node tools/screenshot.js forge <work/cars/x.forge.json>  Scene Forge with the project loaded
//   node tools/screenshot.js url   <repo-relative-url>       any page, fixed wait
//
// Common: --out file.png | --outdir dir   --width 1280 --height 720
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./lib/serve.js";
import { launch, awaitReady } from "./lib/browser.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.join(ROOT, "..");
const SHOTS = path.join(ROOT, "work", "shots");

const [, , mode, subject, ...rest] = process.argv;
const opts = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) opts[rest[i].slice(2)] = rest[i + 1]?.startsWith("--") || rest[i + 1] === undefined ? "1" : rest[++i];
}
if (!mode || !subject) {
  console.error("usage: screenshot.js <race|track|sheet|car|url> <trackId|carId|url> [options] (see file header)");
  process.exit(2);
}

const width = Number(opts.width ?? 1280);
const height = Number(opts.height ?? 720);

function outPath(name) {
  if (opts.out) return path.resolve(opts.out);
  const dir = opts.outdir ? path.resolve(opts.outdir) : SHOTS;
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.png`);
}

const qs = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

const { url: base, stop } = await serve(REPO);
const browser = await launch({ width, height });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));

async function capture(url, file, { ready = true, wait = 0 } = {}) {
  await page.goto(base + "/" + url, { waitUntil: "load", timeout: 30000 });
  if (ready) await awaitReady(page);
  if (wait) await new Promise((r) => setTimeout(r, wait));
  await page.screenshot({ path: file });
  console.log(file);
}

try {
  if (mode === "race") {
    await capture(`game/index.html?track=${encodeURIComponent(subject)}`, outPath(`race-${subject}`), {
      ready: false,
      wait: Number(opts.wait ?? 6000),
    });
  } else if (mode === "track") {
    const p = { track: subject, s: opts.s, lat: opts.lat, h: opts.h, ahead: opts.ahead, cam: opts.cam, look: opts.look };
    await capture(`editor/preview.html?${qs(p)}`, outPath(`track-${subject}`));
  } else if (mode === "sheet") {
    const n = Number(opts.shots ?? 8);
    const dir = opts.outdir ? path.resolve(opts.outdir) : path.join(SHOTS, `sheet-${subject}`);
    fs.mkdirSync(dir, { recursive: true });
    await capture(`editor/preview.html?${qs({ track: subject })}`, path.join(dir, "00-overhead.png"));
    for (let k = 0; k < n; k++) {
      const s = (k / n).toFixed(4);
      await capture(
        `editor/preview.html?${qs({ track: subject, s, lat: opts.lat ?? 0, h: opts.h ?? 3, ahead: opts.ahead })}`,
        path.join(dir, `${String(k + 1).padStart(2, "0")}-s${s}.png`)
      );
    }
  } else if (mode === "car") {
    const p = opts.url
      ? { url: opts.url, yaw: opts.yaw, pitch: opts.pitch, dist: opts.dist }
      : { car: subject, yaw: opts.yaw, pitch: opts.pitch, dist: opts.dist };
    await capture(`editor/carViewer.html?${qs(p)}`, outPath(`car-${subject.replace(/[^\w.-]/g, "_")}`));
  } else if (mode === "forge") {
    const rel = path.relative(REPO, path.resolve(subject)).replaceAll(path.sep, "/");
    if (rel.startsWith("..")) throw new Error(`project must live inside the repo: ${subject}`);
    await capture(`editor/forge/index.html?project=${encodeURIComponent("/" + rel)}`, outPath(`forge-${path.basename(rel).replace(/\.forge\.json$/, "")}`));
  } else if (mode === "url") {
    await capture(subject, outPath("page"), { ready: false, wait: Number(opts.wait ?? 4000) });
  } else {
    console.error(`unknown mode "${mode}"`);
    process.exitCode = 2;
  }
} finally {
  await browser.close();
  stop();
}
