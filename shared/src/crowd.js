// =====================================================================
// Shared crowd-figure rigging/rendering — single build path for both the
// crowd editor's preview (crowdEditor.js) and the race (placeholders.js ->
// trackObjects.js), so a kit previews exactly as it places trackside.
//
// A "kit" is { name, images: [{id,el,w,h,scale}], parts: [...] } — parts as
// authored in crowdEditor.js: { id, type, imgId, points, attach, scale,
// armMin?, armMax? }. Rigging design is explained in crowdEditor.js's own
// header; this file is just where that math lives.
//
// Part selection/colour pick through an injected `rng` (() => [0,1)) so
// in-game placement stays reproducible from a track's seed (mulberry32) —
// the editor's own preview just passes Math.random. Arm swing *timing*
// deliberately bypasses rng: it's live real-time animation, not layout.
// =====================================================================

export function bbox(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  return { minX, minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

// ---------------------------------------------------------------------
// Part render caches, keyed by part id. cutout (raw photo clipped to the
// polygon) only ever feeds the head's pixelation — body/limb parts never
// show real pixels, only their silhouette. See invalidatePart: callers
// that mutate a part's points (the crowd editor, while tracing) must call
// it; in-game kits are loaded once and never edited, so they never need to.
// ---------------------------------------------------------------------
const cutoutCache = new Map();
const silhouetteCache = new Map();
const pixelHeadCache = new Map();
export function invalidatePart(id) {
  cutoutCache.delete(id);
  silhouetteCache.delete(id);
  pixelHeadCache.delete(id);
}
export function clearAllPartCaches() {
  cutoutCache.clear();
  silhouetteCache.clear();
  pixelHeadCache.clear();
}

// imgEl is the actual <img> the part was traced from — callers resolve
// part.imgId -> element themselves (see imageById below) since this file
// doesn't own any particular kit's image list.
export function getCutout(part, imgEl) {
  let c = cutoutCache.get(part.id);
  if (c) return c;
  if (!imgEl) return null;
  const b = bbox(part.points);
  const w = Math.max(1, Math.round(b.w)), h = Math.max(1, Math.round(b.h));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const cx = cv.getContext("2d");
  cx.save();
  cx.beginPath();
  part.points.forEach(([x, y], i) => {
    const lx = x - b.minX, ly = y - b.minY;
    if (i === 0) cx.moveTo(lx, ly); else cx.lineTo(lx, ly);
  });
  cx.closePath();
  cx.clip();
  cx.drawImage(imgEl, -b.minX, -b.minY);
  cx.restore();
  c = { canvas: cv, minX: b.minX, minY: b.minY, w, h };
  cutoutCache.set(part.id, c);
  return c;
}

// Flat-colour silhouette base (no photo pixels) — what body/limb parts
// render as; coloredSilhouette() below tints a copy of it per figure.
export function getSilhouette(part) {
  let m = silhouetteCache.get(part.id);
  if (m) return m;
  const b = bbox(part.points);
  const w = Math.max(1, Math.round(b.w)), h = Math.max(1, Math.round(b.h));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const cx = cv.getContext("2d");
  cx.beginPath();
  part.points.forEach(([x, y], i) => {
    const lx = x - b.minX, ly = y - b.minY;
    if (i === 0) cx.moveTo(lx, ly); else cx.lineTo(lx, ly);
  });
  cx.closePath();
  cx.fillStyle = "#fff";
  cx.fill();
  m = { canvas: cv, minX: b.minX, minY: b.minY, w, h };
  silhouetteCache.set(part.id, m);
  return m;
}

// Coarse mosaic of the real face — downsample to a handful of blocks, then
// scale back up with smoothing off so each block stays a hard-edged square.
const HEAD_BLOCK = 6; // source px per mosaic block — bigger = chunkier
export function getPixelatedHead(part, imgEl) {
  let p = pixelHeadCache.get(part.id);
  if (p) return p;
  const raw = getCutout(part, imgEl);
  if (!raw) return null;
  const cols = Math.max(1, Math.round(raw.w / HEAD_BLOCK)), rows = Math.max(1, Math.round(raw.h / HEAD_BLOCK));
  const small = document.createElement("canvas");
  small.width = cols; small.height = rows;
  small.getContext("2d").drawImage(raw.canvas, 0, 0, cols, rows);
  const big = document.createElement("canvas");
  big.width = raw.w; big.height = raw.h;
  const bctx = big.getContext("2d");
  bctx.imageSmoothingEnabled = false;
  bctx.drawImage(small, 0, 0, cols, rows, 0, 0, raw.w, raw.h);
  p = { canvas: big, minX: raw.minX, minY: raw.minY, w: raw.w, h: raw.h };
  pixelHeadCache.set(part.id, p);
  return p;
}

// Realistic skin-tone anchors (warm hues, lightness spanning fair to deep)
// — a curated set rather than a free random hue roll, so jittering around
// one still reads as a plausible skin tone instead of drifting orange/grey.
const SKIN_TONES = [
  { h: 30, s: 55, l: 82 }, // very fair
  { h: 28, s: 58, l: 68 }, // light
  { h: 30, s: 50, l: 55 }, // medium
  { h: 28, s: 55, l: 42 }, // tan
  { h: 25, s: 45, l: 30 }, // deep
  { h: 20, s: 35, l: 18 }, // very deep
];
export function skinTone(rng) {
  const base = SKIN_TONES[(rng() * SKIN_TONES.length) | 0];
  return {
    h: base.h + (rng() - 0.5) * 8,
    s: Math.min(80, Math.max(15, base.s + (rng() - 0.5) * 10)),
    l: Math.min(92, Math.max(6, base.l + (rng() - 0.5) * 6)),
  };
}

// Recolours a pixelated head into a given skin tone: extracts each block's
// luminance (keeps real shading/contours) and remaps into a duotone
// spanning tone.l ± SPREAD, discarding the photo's hue entirely —
// deliberately not a hue-rotate, which would shift hair/background along
// with skin. Not cached (tone is rolled per figure, like clothing colour).
//
// Luminance is contrast-stretched to this head's own min/max first —
// otherwise a bright/pale source photo pushes every pixel toward the
// lightest end of whatever tone got picked, regardless of the tone itself.
const SKIN_SPREAD = 20; // lightness swing (percentage points) from shadow to highlight
export function tintedHead(part, imgEl, tone) {
  const mosaic = getPixelatedHead(part, imgEl);
  if (!mosaic) return null;
  const cv = document.createElement("canvas");
  cv.width = mosaic.w; cv.height = mosaic.h;
  const cx = cv.getContext("2d");
  cx.drawImage(mosaic.canvas, 0, 0);
  const img = cx.getImageData(0, 0, mosaic.w, mosaic.h);
  const { data } = img;

  let minLum = 1, maxLum = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;
  }
  const lumRange = Math.max(0.05, maxLum - minLum); // guard near-flat mosaics (tiny/degenerate traces)

  const darkL = Math.max(3, tone.l - SKIN_SPREAD), lightL = Math.min(97, tone.l + SKIN_SPREAD);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue; // outside the traced silhouette
    const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    const lumNorm = Math.min(1, Math.max(0, (lum - minLum) / lumRange));
    const [r, g, b] = hslToRgb(tone.h, tone.s, darkL + (lightL - darkL) * lumNorm);
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
  cx.putImageData(img, 0, 0);
  return { canvas: cv, minX: mosaic.minX, minY: mosaic.minY, w: mosaic.w, h: mosaic.h };
}

// ---------------------------------------------------------------------
// Ordered (Bayer) dither instead of a perfectly flat fill — alternates
// each pixel between a slightly darker/lighter shade of the same colour
// in a 4x4 dot pattern, exactly 50/50 so the average still reads as the
// target colour but with a mottled, less vector-flat texture.
// ---------------------------------------------------------------------
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
const DITHER_DELTA_L = 9; // lightness swing (percentage points) between the two shades
function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
function parseHsl(str) {
  const m = str.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/);
  return m ? [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])] : [0, 0, 50];
}

// Paints `color` into every opaque pixel of a mask canvas, dithered — not
// cached per part since colour is chosen per generated figure, not per
// part; called once per figure at pick time, not per frame.
export function coloredSilhouette(part, color) {
  const mask = getSilhouette(part);
  const cv = document.createElement("canvas");
  cv.width = mask.w; cv.height = mask.h;
  const cx = cv.getContext("2d");
  cx.drawImage(mask.canvas, 0, 0);
  const img = cx.getImageData(0, 0, mask.w, mask.h);
  const [h, s, l] = parseHsl(color);
  const dark = hslToRgb(h, s, Math.max(0, l - DITHER_DELTA_L));
  const light = hslToRgb(h, s, Math.min(100, l + DITHER_DELTA_L));
  const { data, width, height } = img;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue; // outside the traced silhouette
      const c = BAYER4[y & 3][x & 3] < 8 ? light : dark;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
    }
  }
  cx.putImageData(img, 0, 0);
  return { canvas: cv, minX: mask.minX, minY: mask.minY, w: mask.w, h: mask.h };
}

// ---------------------------------------------------------------------
// Clothing palette — skews heavily toward neutral trousers with
// occasional bright shirts, the way real crowds actually look, rather
// than a uniform random hue wheel.
// ---------------------------------------------------------------------
function randRange(a, b, rng) { return a + rng() * (b - a); }

export function neutralColor(rng) {
  const roll = rng();
  if (roll < 0.4) return `hsl(0, 0%, ${randRange(8, 22, rng).toFixed(0)}%)`; // black-ish
  if (roll < 0.7) return `hsl(0, ${randRange(0, 8, rng).toFixed(0)}%, ${randRange(30, 60, rng).toFixed(0)}%)`; // grey
  return `hsl(${randRange(20, 35, rng).toFixed(0)}, ${randRange(25, 50, rng).toFixed(0)}%, ${randRange(20, 42, rng).toFixed(0)}%)`; // brown
}
const PRIMARY_HUES = [355, 25, 48, 130, 205, 235, 275, 330]; // red, orange, yellow, green, sky, blue, purple, pink
export function primaryColor(rng) {
  const base = PRIMARY_HUES[(rng() * PRIMARY_HUES.length) | 0];
  const h = (((base + randRange(-10, 10, rng)) % 360) + 360) % 360;
  return `hsl(${h.toFixed(0)}, ${randRange(55, 85, rng).toFixed(0)}%, ${randRange(38, 55, rng).toFixed(0)}%)`;
}
// Sleeves usually match the shirt (same garment); rarely a different top
// layer/rolled sleeve shows through, so an arm occasionally rolls its own.
const ARM_OWN_COLOR_CHANCE = 0.15;
export function trouserColor(rng) { return neutralColor(rng); }
export function shirtColor(rng, primaryChancePct = 40) { return rng() * 100 < primaryChancePct ? primaryColor(rng) : neutralColor(rng); }
export function armColor(rng, shirt, primaryChancePct = 40) { return rng() < ARM_OWN_COLOR_CHANCE ? shirtColor(rng, primaryChancePct) : shirt; }

// scale is a calibration multiplier (different source photos have
// different pixels-per-real-metre), not an artistic stretch. Layered: a
// per-image default times a per-part fine-tune.
export function effectiveScale(part, imgScale) {
  if (!part) return 1;
  return (part.scale ?? 1) * (imgScale ?? 1);
}

// ---------------------------------------------------------------------
// Arm swing animation — idle -> swing out -> hold -> swing back -> idle,
// at random intervals, to a random angle within the part's authored
// min/max. Always real-time (Math.random/performance.now), independent
// of the rng passed to pickFigure.
// ---------------------------------------------------------------------
export function makeArmAnim() {
  return { angle: 0, phase: "idle", t0: performance.now() + Math.random() * 2700 + 300, from: 0, to: 0, dur: 400 };
}
function ease(k) { return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; }
// Advances one arm's state machine and returns its current angle (deg).
// `moving` on the returned info lets callers skip redraw work while idle.
export function stepArmAnim(a, part, now) {
  const min = part?.armMin ?? -40, max = part?.armMax ?? 40;
  if (a.phase === "idle") {
    if (now >= a.t0) { a.from = a.angle; a.to = min + Math.random() * (max - min); a.dur = 280 + Math.random() * 240; a.t0 = now; a.phase = "swing"; }
  } else if (a.phase === "swing") {
    const k = Math.min(1, (now - a.t0) / a.dur);
    a.angle = a.from + (a.to - a.from) * ease(k);
    if (k >= 1) { a.t0 = now + 200 + Math.random() * 400; a.phase = "hold"; }
  } else if (a.phase === "hold") {
    if (now >= a.t0) { a.from = a.angle; a.to = 0; a.dur = 280 + Math.random() * 240; a.t0 = now; a.phase = "back"; }
  } else if (a.phase === "back") {
    const k = Math.min(1, (now - a.t0) / a.dur);
    a.angle = a.from + (a.to - a.from) * ease(k);
    if (k >= 1) { a.angle = 0; a.t0 = now + 800 + Math.random() * 3200; a.phase = "idle"; }
  }
  return a.angle;
}

// ---------------------------------------------------------------------
// Kit-level helpers: pick a random figure's parts + colours, then draw it.
// ---------------------------------------------------------------------
export function imageById(kit, id) { return kit.images.find((i) => i.id === id); }
export function partsByType(kit, type) { return kit.parts.filter((p) => p.type === type); }
function pickRandom(arr, rng) { return arr.length ? arr[(rng() * arr.length) | 0] : null; }

// Returns a figure descriptor: chosen parts, their pre-rendered (coloured/
// pixelated) canvases, resolved scale, and fresh arm-animation state. Call
// once per figure instance, not per frame — only stepArmAnim/drawFigure
// need to run every frame.
export function pickFigure(kit, rng, primaryChancePct = 40) {
  const lower = pickRandom(partsByType(kit, "lowerBody"), rng);
  const upper = pickRandom(partsByType(kit, "upperBody"), rng);
  const head = pickRandom(partsByType(kit, "head"), rng);
  const armL = pickRandom(partsByType(kit, "armLeft"), rng);
  const armR = pickRandom(partsByType(kit, "armRight"), rng);
  const shirt = shirtColor(rng, primaryChancePct);
  const imgOf = (p) => (p ? imageById(kit, p.imgId) : null);
  return {
    lower, upper, head, armL, armR,
    lowerC: lower ? coloredSilhouette(lower, trouserColor(rng)) : null,
    upperC: upper ? coloredSilhouette(upper, shirt) : null,
    armLC: armL ? coloredSilhouette(armL, armColor(rng, shirt, primaryChancePct)) : null,
    armRC: armR ? coloredSilhouette(armR, armColor(rng, shirt, primaryChancePct)) : null,
    headC: head ? tintedHead(head, imgOf(head)?.el, skinTone(rng)) : null,
    lowerScale: effectiveScale(lower, imgOf(lower)?.scale),
    upperScale: effectiveScale(upper, imgOf(upper)?.scale),
    headScale: effectiveScale(head, imgOf(head)?.scale),
    armLScale: effectiveScale(armL, imgOf(armL)?.scale),
    armRScale: effectiveScale(armR, imgOf(armR)?.scale),
    animL: makeArmAnim(), animR: makeArmAnim(),
  };
}

// Torso's neck/shoulder joints are inferred proportionally from its own
// bounding box (see this file's header + crowdEditor.js) rather than
// separately authored, since only one attach point is authored per part.
const NECK_X = 0.5, NECK_Y = 0.06;
const SHOULDER_Y = 0.14, SHOULDER_L_X = 0.16, SHOULDER_R_X = 0.84;

// Pure draw — takes already-stepped arm angles rather than stepping them
// itself, so callers control exactly when animation advances vs. redraw.
//
// (originX, originY) is the figure's feet/ground-contact point (matching
// this game's "y=0 is ground" convention), not the hip the rigging actually
// composites around — derived here from leg height rather than left for
// callers to guess; getting this wrong previously clipped legs off the canvas.
export function drawFigure(ctx, originX, originY, targetH, fig, angleL, angleR) {
  const { lower, upper, head, armL, armR, lowerC, upperC, headC, armLC, armRC } = fig;
  const sLower = fig.lowerScale, sUpper = fig.upperScale, sHead = fig.headScale, sArmL = fig.armLScale, sArmR = fig.armRScale;

  const rawLower = lowerC ? lowerC.h * sLower : 0;
  const raw = rawLower + (upperC ? upperC.h * sUpper : 0) + (headC ? headC.h * sHead * 0.6 : 0);
  if (raw <= 0) return;
  const norm = targetH / raw;

  ctx.save();
  ctx.translate(originX, originY - rawLower * norm); // shift up from feet to the hip the rigging is built around
  ctx.scale(norm, norm);

  let neckX = 0, neckY = 0, shL = { x: 0, y: 0 }, shR = { x: 0, y: 0 };

  if (lowerC) {
    const ax = (lower.attach[0] - lowerC.minX) * sLower, ay = (lower.attach[1] - lowerC.minY) * sLower;
    ctx.drawImage(lowerC.canvas, -ax, -ay, lowerC.w * sLower, lowerC.h * sLower);
  }
  if (upperC) {
    const ax = (upper.attach[0] - upperC.minX) * sUpper, ay = (upper.attach[1] - upperC.minY) * sUpper;
    const ow = upperC.w * sUpper, oh = upperC.h * sUpper;
    const ox = -ax, oy = -ay;
    ctx.drawImage(upperC.canvas, ox, oy, ow, oh);
    neckX = ox + ow * NECK_X; neckY = oy + oh * NECK_Y;
    shL = { x: ox + ow * SHOULDER_L_X, y: oy + oh * SHOULDER_Y };
    shR = { x: ox + ow * SHOULDER_R_X, y: oy + oh * SHOULDER_Y };
  }
  if (armLC) {
    const ax = (armL.attach[0] - armLC.minX) * sArmL, ay = (armL.attach[1] - armLC.minY) * sArmL;
    ctx.save();
    ctx.translate(shL.x, shL.y);
    ctx.rotate((angleL * Math.PI) / 180);
    ctx.drawImage(armLC.canvas, -ax, -ay, armLC.w * sArmL, armLC.h * sArmL);
    ctx.restore();
  }
  if (armRC) {
    const ax = (armR.attach[0] - armRC.minX) * sArmR, ay = (armR.attach[1] - armRC.minY) * sArmR;
    ctx.save();
    ctx.translate(shR.x, shR.y);
    ctx.rotate((angleR * Math.PI) / 180);
    ctx.drawImage(armRC.canvas, -ax, -ay, armRC.w * sArmR, armRC.h * sArmR);
    ctx.restore();
  }
  if (headC) {
    const ax = (head.attach[0] - headC.minX) * sHead, ay = (head.attach[1] - headC.minY) * sHead;
    ctx.drawImage(headC.canvas, neckX - ax, neckY - ay, headC.w * sHead, headC.h * sHead);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------
// Kit loading — a kit JSON embeds its source images as data URLs (see
// crowdEditor.js's serializeKit), so loading just means decoding those
// back into <img> elements; nothing to fetch separately.
// ---------------------------------------------------------------------
function loadImageEl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

export async function loadCrowdKitFromJSON(kitJson) {
  const images = [];
  for (const img of kitJson.images ?? []) {
    // dataUrl can be intentionally absent — a "shippable" export (see
    // crowdEditor.js's buildShippableKit) drops pixel data entirely for
    // images only referenced by body/limb parts, which never read image
    // pixels at all (see getSilhouette above). The image entry itself is
    // still kept (el: null) since parts still need its `scale`
    // calibration — dropping the whole entry would silently zero that out.
    if (!img.dataUrl) { images.push({ ...img, scale: img.scale ?? 1, el: null }); continue; }
    try { images.push({ ...img, scale: img.scale ?? 1, el: await loadImageEl(img.dataUrl) }); }
    catch { images.push({ ...img, scale: img.scale ?? 1, el: null }); }
  }
  const parts = (kitJson.parts ?? []).map((p) => ({ ...p, scale: p.scale ?? 1 }));
  return { name: kitJson.name ?? "kit", images, parts };
}

export async function loadCrowdKitFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch crowd kit: ${url}`);
  return loadCrowdKitFromJSON(await res.json());
}

// Directory-listing discovery, same trick placeholders.js uses for the
// barrier ribbon/sprite folders (works with Python's http.server; most
// static hosts won't return a listing, so this just yields nothing there).
export async function discoverCrowdKitUrls(folderUrl) {
  try {
    const res = await fetch(folderUrl);
    if (!res.ok) return [];
    const html = await res.text();
    const hrefs = [...html.matchAll(/href="([^"]+\.crowd\.json)"/gi)].map((m) => m[1]);
    const base = new URL(folderUrl, location.href);
    return [...new Set(hrefs)].map((h) => new URL(h, base).href);
  } catch {
    return [];
  }
}
