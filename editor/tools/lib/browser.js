// Headless Chromium via puppeteer-core + the Playwright-cached
// chrome-headless-shell (no separate browser download). SwiftShader flags
// because there's no GPU in WSL headless — WebGL renders in software.
import { globSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

export function findChrome() {
  const env = process.env.PIPELINE_CHROME;
  if (env) return env;
  const hits = globSync(
    path.join(os.homedir(), ".cache/ms-playwright/chromium*/chrome-*/{chrome-headless-shell,chrome,headless_shell}")
  );
  if (!hits.length)
    throw new Error(
      "No cached Chromium found under ~/.cache/ms-playwright — install one " +
      "(npx playwright install chromium) or set PIPELINE_CHROME=/path/to/chrome"
    );
  hits.sort();
  return hits[hits.length - 1];
}

export async function launch({ width = 1280, height = 720 } = {}) {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    args: ["--no-sandbox", "--disable-gpu", "--enable-unsafe-swiftshader", `--window-size=${width},${height}`],
    defaultViewport: { width, height },
  });
  return browser;
}

// Poll a window flag the pipeline pages set when their first real frame has
// rendered (preview.html / carViewer.html: window.__READY). A plain fixed
// wait either wastes seconds or races asset loading; CLI --screenshot with
// --virtual-time-budget yields blank frames entirely.
export async function awaitReady(page, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await page.evaluate(() => window.__READY ?? false);
    if (v === true) return;
    if (typeof v === "string") throw new Error(`page reported: ${v}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`page never set window.__READY within ${timeoutMs} ms`);
}
