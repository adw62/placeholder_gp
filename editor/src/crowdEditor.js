// =====================================================================
// Standalone crowd-part editor + procedural crowd preview.
//
// Author a "kit": source photos, each with freehand-traced parts (head /
// upperBody / lowerBody / armLeft / armRight). Every part carries exactly
// one authored attach point — where it plugs into its parent — plus, for
// arms, a swing range for idle animation.
//
// Only ONE attach point per part: lowerBody.attach and upperBody.attach
// both represent "the hip" and glue to the same spot; head/arm attach
// points glue to a neck/shoulder position *inferred* proportionally from
// upperBody's own bounding box (NECK_*/SHOULDER_* in crowd.js) rather than
// separately authored. Good enough for a placeholder; a tighter crop tracks closer.
//
// Preview is stylized, not photographic: body/limb parts render as flat-
// colour silhouettes; the head is pixelated then recoloured, keeping only
// the photo's luminance (so shading/contours read) and discarding its hue —
// a straight hue-rotate on a real face photo looked wrong.
//
// Each image carries a `scale` calibration (photos traced at different
// zoom/distance don't share a pixel-to-real-world scale) that multiplies
// every part sourced from it; each part also has its own fine-tune `scale` on top.
//
// The actual rigging/rendering math lives in src/crowd.js, shared with the
// race (via placeholders.js's buildCrowdFigure -> trackObjects.js's "crowd"
// type) so a kit previews here exactly as it places trackside.
// =====================================================================

import { invalidatePart, clearAllPartCaches, stepArmAnim, pickFigure, drawFigure, loadCrowdKitFromJSON } from "../../shared/src/crowd.js";

const TYPE_LABELS = {
  head: "Head",
  upperBody: "Upper Body",
  lowerBody: "Lower Body",
  armLeft: "Left Arm",
  armRight: "Right Arm",
};
const TYPE_COLORS = {
  head: "#ff6b6b",
  upperBody: "#4da6ff",
  lowerBody: "#6dfa8f",
  armLeft: "#ffcc33",
  armRight: "#c77dff",
};
const ARM_TYPES = new Set(["armLeft", "armRight"]);

const STORE_KEY = "pgp-crowd-draft";
const isTyping = (e) => e.target && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);

// ---------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------
const stage = document.getElementById("stage");
const stageCtx = stage.getContext("2d");
const previewCanvas = document.getElementById("previewCanvas");
const emptyHint = document.getElementById("emptyHint");
const partInspector = document.getElementById("partInspector");
const armRangeEl = document.getElementById("armRange");
const pType = document.getElementById("pType"), pAX = document.getElementById("pAX"), pAY = document.getElementById("pAY");
const pScale = document.getElementById("pScale");
const pArmMin = document.getElementById("pArmMin"), pArmMax = document.getElementById("pArmMax"), pDelete = document.getElementById("pDelete");
const kName = document.getElementById("kName"), kJson = document.getElementById("kJson");
const figCountEl = document.getElementById("figCount"), primaryChanceEl = document.getElementById("primaryChance");

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
let images = [];        // { id, name, dataUrl, el, w, h }
let parts = [];          // { id, type, imgId, points:[[x,y]...], attach:[x,y], armMin?, armMax? }
let activeImageId = null;
let selectedId = null;
let mode = "select";
let paletteType = "head";
let draftPoints = [];
let dragTarget = null;   // { kind: "attach" } | { kind: "vertex", idx }
let stageScale = 1, stageOffX = 0, stageOffY = 0;

let figCount = 12, primaryChance = 40, playing = true;
let figures = [];

// ---------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------
function pointInPolygon([px, py], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    const hit = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}
function centroid(poly) {
  let x = 0, y = 0;
  for (const [px, py] of poly) { x += px; y += py; }
  return [x / poly.length, y / poly.length];
}

function imageById(id) { return images.find((i) => i.id === id); }
function getPart(id) { return parts.find((p) => p.id === id); }
function activeImage() { return imageById(activeImageId); }

// ---------------------------------------------------------------------
// Stage (authoring canvas): fit the active image to the available area,
// map pointer <-> image-pixel coordinates.
// ---------------------------------------------------------------------
function fitStage() {
  const wrap = document.getElementById("stageWrap");
  const rect = wrap.getBoundingClientRect();
  stage.width = rect.width;
  stage.height = rect.height;
  const img = activeImage();
  if (img) {
    stageScale = Math.min((rect.width - 40) / img.w, (rect.height - 40) / img.h);
    stageOffX = (rect.width - img.w * stageScale) / 2;
    stageOffY = (rect.height - img.h * stageScale) / 2;
  }
  drawStage();
}
window.addEventListener("resize", fitStage);

function toImageCoords(e) {
  const r = stage.getBoundingClientRect();
  return [(e.clientX - r.left - stageOffX) / stageScale, (e.clientY - r.top - stageOffY) / stageScale];
}
function toScreen([x, y]) {
  return [x * stageScale + stageOffX, y * stageScale + stageOffY];
}

function drawStage() {
  stageCtx.clearRect(0, 0, stage.width, stage.height);
  const img = activeImage();
  // img.el is null for a body/limb-only image loaded back from an
  // optimized export (see buildShippableKit) — its pixels were never kept
  // since nothing reads them, so there's nothing to trace against here.
  emptyHint.classList.toggle("hidden", !!(img && img.el));
  if (!img || !img.el) return;
  stageCtx.drawImage(img.el, stageOffX, stageOffY, img.w * stageScale, img.h * stageScale);

  for (const part of parts) {
    if (part.imgId !== activeImageId) continue;
    const isSel = part.id === selectedId;
    stageCtx.beginPath();
    part.points.forEach((p, i) => {
      const [sx, sy] = toScreen(p);
      if (i === 0) stageCtx.moveTo(sx, sy); else stageCtx.lineTo(sx, sy);
    });
    stageCtx.closePath();
    stageCtx.fillStyle = TYPE_COLORS[part.type] + (isSel ? "3d" : "1f");
    stageCtx.fill();
    stageCtx.strokeStyle = TYPE_COLORS[part.type];
    stageCtx.lineWidth = isSel ? 2.5 : 1.5;
    stageCtx.stroke();

    if (isSel) {
      part.points.forEach((p) => {
        const [sx, sy] = toScreen(p);
        stageCtx.beginPath();
        stageCtx.arc(sx, sy, 4, 0, Math.PI * 2);
        stageCtx.fillStyle = "#fff";
        stageCtx.fill();
      });
      const [ax, ay] = toScreen(part.attach);
      stageCtx.beginPath();
      stageCtx.moveTo(ax - 9, ay); stageCtx.lineTo(ax + 9, ay);
      stageCtx.moveTo(ax, ay - 9); stageCtx.lineTo(ax, ay + 9);
      stageCtx.strokeStyle = "#ffcc33"; stageCtx.lineWidth = 2; stageCtx.stroke();
      stageCtx.beginPath(); stageCtx.arc(ax, ay, 3, 0, Math.PI * 2); stageCtx.fillStyle = "#ffcc33"; stageCtx.fill();

      if (ARM_TYPES.has(part.type)) {
        const len = 60;
        stageCtx.setLineDash([4, 3]);
        stageCtx.strokeStyle = "rgba(255,204,51,0.7)";
        stageCtx.lineWidth = 1.5;
        for (const deg of [part.armMin ?? -40, part.armMax ?? 40]) {
          const rad = (deg * Math.PI) / 180;
          stageCtx.beginPath();
          stageCtx.moveTo(ax, ay);
          stageCtx.lineTo(ax + Math.sin(rad) * len, ay + Math.cos(rad) * len);
          stageCtx.stroke();
        }
        stageCtx.setLineDash([]);
      }
    }
  }

  if (draftPoints.length) {
    stageCtx.beginPath();
    draftPoints.forEach((p, i) => {
      const [sx, sy] = toScreen(p);
      if (i === 0) stageCtx.moveTo(sx, sy); else stageCtx.lineTo(sx, sy);
    });
    stageCtx.strokeStyle = TYPE_COLORS[paletteType];
    stageCtx.lineWidth = 2;
    stageCtx.stroke();
    draftPoints.forEach((p) => {
      const [sx, sy] = toScreen(p);
      stageCtx.beginPath();
      stageCtx.arc(sx, sy, 4, 0, Math.PI * 2);
      stageCtx.fillStyle = TYPE_COLORS[paletteType];
      stageCtx.fill();
    });
  }
}

// ---------------------------------------------------------------------
// Pointer / keyboard interaction on the stage
// ---------------------------------------------------------------------
stage.addEventListener("pointerdown", (e) => {
  if (!activeImage()) return;
  const pt = toImageCoords(e);
  const r = stage.getBoundingClientRect();
  const cx = e.clientX - r.left, cy = e.clientY - r.top;

  if (mode === "draw") {
    if (draftPoints.length >= 3) {
      const [sx, sy] = toScreen(draftPoints[0]);
      if (Math.hypot(cx - sx, cy - sy) < 10) { finishShape(); return; }
    }
    draftPoints.push(pt);
    drawStage();
    return;
  }

  // select mode: prefer dragging a handle of the already-selected part
  if (selectedId) {
    const part = getPart(selectedId);
    if (part && part.imgId === activeImageId) {
      const [ax, ay] = toScreen(part.attach);
      if (Math.hypot(cx - ax, cy - ay) < 8) { dragTarget = { kind: "attach" }; return; }
      for (let i = 0; i < part.points.length; i++) {
        const [vx, vy] = toScreen(part.points[i]);
        if (Math.hypot(cx - vx, cy - vy) < 8) { dragTarget = { kind: "vertex", idx: i }; return; }
      }
    }
  }
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.imgId !== activeImageId) continue;
    if (pointInPolygon(pt, part.points)) { selectPart(part.id); return; }
  }
  selectPart(null);
});

stage.addEventListener("pointermove", (e) => {
  if (!dragTarget || !selectedId) return;
  const part = getPart(selectedId);
  if (!part) return;
  const pt = toImageCoords(e);
  if (dragTarget.kind === "attach") {
    part.attach = pt;
  } else {
    part.points[dragTarget.idx] = pt;
    invalidatePart(part.id);
  }
  drawStage();
  syncInspector();
});
window.addEventListener("pointerup", () => {
  if (dragTarget) {
    dragTarget = null;
    regenerateFigures();
    saveDraft();
  }
});
stage.addEventListener("dblclick", () => { if (mode === "draw") finishShape(); });

window.addEventListener("keydown", (e) => {
  if (isTyping(e)) return;
  if (e.key === "Enter" && mode === "draw") { e.preventDefault(); finishShape(); }
  else if (e.key === "Escape" && mode === "draw") { draftPoints = []; drawStage(); }
  else if ((e.code === "Delete" || e.code === "Backspace") && selectedId) { e.preventDefault(); deletePart(selectedId); }
});

function finishShape() {
  if (draftPoints.length < 3) { draftPoints = []; drawStage(); return; }
  const id = "part-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const part = {
    id, type: paletteType, imgId: activeImageId,
    points: draftPoints.map((p) => [Math.round(p[0]), Math.round(p[1])]),
    attach: centroid(draftPoints).map((n) => Math.round(n)),
    scale: 1,
  };
  if (ARM_TYPES.has(paletteType)) { part.armMin = -40; part.armMax = 40; }
  parts.push(part);
  draftPoints = [];
  setMode("select");
  selectPart(id);
  refreshPartList();
  regenerateFigures();
  saveDraft();
}

// ---------------------------------------------------------------------
// Selection / inspector
// ---------------------------------------------------------------------
function selectPart(id) {
  selectedId = id;
  const part = getPart(id);
  if (part && part.imgId !== activeImageId) { activeImageId = part.imgId; refreshImageList(); fitStage(); }
  partInspector.classList.toggle("hidden", !part);
  if (part) syncInspector();
  refreshPartList();
  drawStage();
}
function syncInspector() {
  const part = getPart(selectedId);
  if (!part) return;
  pType.value = part.type;
  pAX.value = Math.round(part.attach[0]);
  pAY.value = Math.round(part.attach[1]);
  pScale.value = part.scale ?? 1;
  const isArm = ARM_TYPES.has(part.type);
  armRangeEl.classList.toggle("hidden", !isArm);
  if (isArm) { pArmMin.value = part.armMin ?? -40; pArmMax.value = part.armMax ?? 40; }
}
function wireInspector() {
  pType.innerHTML = Object.keys(TYPE_LABELS).map((t) => `<option value="${t}">${TYPE_LABELS[t]}</option>`).join("");
  pType.addEventListener("change", () => {
    const part = getPart(selectedId); if (!part) return;
    part.type = pType.value;
    if (ARM_TYPES.has(part.type)) { part.armMin ??= -40; part.armMax ??= 40; }
    syncInspector(); refreshPartList(); drawStage(); regenerateFigures(); saveDraft();
  });
  pAX.addEventListener("input", () => { const p = getPart(selectedId); if (!p) return; p.attach[0] = Number(pAX.value) || 0; drawStage(); regenerateFigures(); saveDraft(); });
  pAY.addEventListener("input", () => { const p = getPart(selectedId); if (!p) return; p.attach[1] = Number(pAY.value) || 0; drawStage(); regenerateFigures(); saveDraft(); });
  pScale.addEventListener("input", () => { const p = getPart(selectedId); if (!p) return; p.scale = Number(pScale.value) || 1; regenerateFigures(); saveDraft(); });
  pArmMin.addEventListener("input", () => { const p = getPart(selectedId); if (!p) return; p.armMin = Number(pArmMin.value) || 0; drawStage(); regenerateFigures(); saveDraft(); });
  pArmMax.addEventListener("input", () => { const p = getPart(selectedId); if (!p) return; p.armMax = Number(pArmMax.value) || 0; drawStage(); regenerateFigures(); saveDraft(); });
  pDelete.addEventListener("click", () => deletePart(selectedId));
}
function deletePart(id) {
  parts = parts.filter((p) => p.id !== id);
  invalidatePart(id);
  if (selectedId === id) selectPart(null);
  refreshPartList();
  drawStage();
  regenerateFigures();
  saveDraft();
}

function refreshPartList() {
  const el = document.getElementById("partList");
  document.getElementById("partCount").textContent = parts.length;
  el.innerHTML = parts.map((p) => {
    const img = imageById(p.imgId);
    return `<div class="item ${p.id === selectedId ? "activeItem" : ""}" data-id="${p.id}">
      <div class="itemHead"><b style="color:${TYPE_COLORS[p.type]}">${TYPE_LABELS[p.type]}</b><button class="small danger" data-act="del">&#10005;</button></div>
      <div class="meta">${img ? img.name : "(missing image)"} &middot; ${p.points.length} pts</div>
    </div>`;
  }).join("");
  el.querySelectorAll(".item").forEach((row) => {
    const id = row.dataset.id;
    row.addEventListener("click", (e) => { if (e.target.dataset.act !== "del") selectPart(id); });
    row.querySelector('[data-act="del"]').addEventListener("click", (e) => { e.stopPropagation(); deletePart(id); });
  });
}

// ---------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function loadImageEl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}
async function addImage(dataUrl, name) {
  const el = await loadImageEl(dataUrl);
  const id = "img-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  images.push({ id, name: name || id, dataUrl, el, w: el.naturalWidth, h: el.naturalHeight, scale: 1 });
  activeImageId = id;
  refreshImageList();
  fitStage();
  saveDraft();
}
document.getElementById("imgLoad").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const dataUrl = await fileToDataUrl(file);
  await addImage(dataUrl, file.name);
  e.target.value = "";
});

function refreshImageList() {
  const el = document.getElementById("imageList");
  el.innerHTML = images.map((img) => `
    <div class="item ${img.id === activeImageId ? "activeItem" : ""}" data-id="${img.id}">
      <div class="itemHead"><b>${img.id === activeImageId ? "● " : ""}${img.name}</b><button class="small danger" data-act="del">&#10005;</button></div>
      <div class="row"><label>Scale</label><input type="number" data-f="scale" value="${img.scale ?? 1}" step="0.05" min="0.05"></div>
      <div class="btnRow"><button class="wide" data-act="select">${img.id === activeImageId ? "Active" : "Select"}</button></div>
    </div>`).join("");
  el.querySelectorAll(".item").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-act="select"]').addEventListener("click", () => { activeImageId = id; refreshImageList(); fitStage(); });
    row.querySelector('[data-act="del"]').addEventListener("click", () => deleteImage(id));
    row.querySelector('[data-f="scale"]').addEventListener("input", (e) => {
      const img = imageById(id);
      img.scale = Number(e.target.value) || 1;
      regenerateFigures();
      saveDraft();
    });
  });
}
function deleteImage(id) {
  if (!confirm("Delete this image and every part traced from it?")) return;
  const removed = parts.filter((p) => p.imgId === id);
  for (const p of removed) invalidatePart(p.id);
  images = images.filter((i) => i.id !== id);
  parts = parts.filter((p) => p.imgId !== id);
  if (activeImageId === id) activeImageId = images[0]?.id ?? null;
  if (selectedId && removed.some((p) => p.id === selectedId)) selectPart(null);
  refreshImageList(); refreshPartList(); fitStage(); regenerateFigures(); saveDraft();
}

// ---------------------------------------------------------------------
// Mode toolbar / part-type palette
// ---------------------------------------------------------------------
function setMode(m) {
  mode = m;
  document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  stage.classList.toggle("drawMode", m === "draw");
  if (m !== "draw") draftPoints = [];
  drawStage();
}
document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
document.getElementById("finishShape").addEventListener("click", finishShape);
document.getElementById("cancelShape").addEventListener("click", () => { draftPoints = []; drawStage(); });

function buildTypePalette() {
  const el = document.getElementById("typePalette");
  el.innerHTML = "";
  for (const key of Object.keys(TYPE_LABELS)) {
    const b = document.createElement("button");
    b.textContent = TYPE_LABELS[key];
    b.dataset.type = key;
    b.style.borderBottom = `3px solid ${TYPE_COLORS[key]}`;
    if (key === paletteType) b.classList.add("active");
    b.addEventListener("click", () => {
      paletteType = key;
      [...el.children].forEach((c) => c.classList.toggle("active", c.dataset.type === key));
    });
    el.appendChild(b);
  }
}

// ---------------------------------------------------------------------
// Procedural crowd preview — random part mix, clothing-realistic colour
// picking, and per-arm swing animation all come from src/crowd.js (see
// its header). This editor's own job is just: hand it {images, parts} as
// a "kit" and Math.random as the rng (matches the () => [0,1) shape
// pickFigure expects, same as trackObjects.js's seeded mulberry32).
// ---------------------------------------------------------------------
function regenerateFigures() {
  figures = Array.from({ length: figCount }, () => pickFigure({ images, parts }, Math.random, primaryChance));
}

function tickPreview(now) {
  const ctx = previewCanvas.getContext("2d");
  ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  if (figures.length) {
    const cols = Math.max(1, Math.ceil(Math.sqrt((figures.length * previewCanvas.width) / previewCanvas.height)));
    const rows = Math.ceil(figures.length / cols);
    const cellW = previewCanvas.width / cols, cellH = previewCanvas.height / rows;
    const figH = cellH * 0.84;
    figures.forEach((fig, i) => {
      const cx = (i % cols) * cellW + cellW * 0.5;
      const cy = Math.floor(i / cols) * cellH + cellH * 0.92;
      const angleL = stepArmAnim(fig.animL, fig.armL, now);
      const angleR = stepArmAnim(fig.animR, fig.armR, now);
      drawFigure(ctx, cx, cy, figH, fig, angleL, angleR);
    });
  }
  if (playing) requestAnimationFrame(tickPreview);
}

function wirePreviewControls() {
  figCountEl.addEventListener("input", () => { figCount = Number(figCountEl.value) || 1; regenerateFigures(); });
  primaryChanceEl.addEventListener("input", () => { primaryChance = Number(primaryChanceEl.value) || 0; regenerateFigures(); });
  document.getElementById("regenBtn").addEventListener("click", regenerateFigures);
  const playBtn = document.getElementById("playBtn");
  playBtn.addEventListener("click", () => {
    playing = !playing;
    playBtn.textContent = playing ? "Pause" : "Play";
    if (playing) requestAnimationFrame(tickPreview);
  });
}

// ---------------------------------------------------------------------
// Export / import / localStorage draft
// ---------------------------------------------------------------------
function msg(text) {
  const m = document.getElementById("msg");
  m.textContent = text;
  clearTimeout(msg._t);
  msg._t = setTimeout(() => (m.textContent = ""), 3500);
}
function serializeKit() {
  return {
    name: kName.value || "crowd-kit",
    images: images.map(({ id, name, dataUrl, w, h, scale }) => ({ id, name, dataUrl, w, h, scale })),
    parts: parts.map((p) => ({ ...p, points: p.points.map((pt) => [...pt]), attach: [...p.attach] })),
  };
}

// What actually goes in assets/crowd/ — unlike the localStorage draft
// (keeps full photos + real filenames for further tracing), a shipped kit
// drops pixels nothing reads and any trace of the photo's origin. Images
// referenced only by body/limb parts (flat silhouettes, never touch real
// pixels) need no dataUrl at all — just their `scale` calibration. An image
// with head parts keeps only the cropped union of those regions (small
// margin), re-encoded as JPEG (lossy is fine, it's pixelated at render time
// anyway; re-encoding also strips EXIF). `name` becomes a generic label
// either way — the original filename has no business shipping.
function buildShippableKit() {
  const shipImages = [];
  const shipParts = [];
  const CROP_MARGIN = 12;
  let anonIdx = 0;
  for (const img of images) {
    const ownParts = parts.filter((p) => p.imgId === img.id);
    if (!ownParts.length) continue; // nothing traced from this image at all — drop it entirely
    const anonName = `image-${++anonIdx}`;
    const headParts = ownParts.filter((p) => p.type === "head");
    if (!headParts.length) {
      shipImages.push({ id: img.id, name: anonName, w: img.w, h: img.h, scale: img.scale, dataUrl: null });
      shipParts.push(...ownParts.map((p) => ({ ...p, points: p.points.map((pt) => [...pt]), attach: [...p.attach] })));
      continue;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of headParts) for (const [x, y] of p.points) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    minX = Math.max(0, Math.floor(minX - CROP_MARGIN));
    minY = Math.max(0, Math.floor(minY - CROP_MARGIN));
    maxX = Math.min(img.w, Math.ceil(maxX + CROP_MARGIN));
    maxY = Math.min(img.h, Math.ceil(maxY + CROP_MARGIN));
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    cv.getContext("2d").drawImage(img.el, -minX, -minY);

    shipImages.push({ id: img.id, name: anonName, w, h, scale: img.scale, dataUrl: cv.toDataURL("image/jpeg", 0.85) });
    for (const p of ownParts) {
      if (p.type !== "head") { shipParts.push({ ...p, points: p.points.map((pt) => [...pt]), attach: [...p.attach] }); continue; }
      shipParts.push({ ...p, points: p.points.map(([x, y]) => [x - minX, y - minY]), attach: [p.attach[0] - minX, p.attach[1] - minY] });
    }
  }
  return { name: kName.value || "crowd-kit", images: shipImages, parts: shipParts };
}
function saveDraft() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(serializeKit())); }
  catch { /* quota or serialization issue — non-fatal, just skip autosave */ }
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupted draft — ignore */ }
  return null;
}
async function loadKit(kit) {
  const loaded = await loadCrowdKitFromJSON(kit);
  images = loaded.images;
  parts = loaded.parts;
  clearAllPartCaches();
  activeImageId = images[0]?.id ?? null;
  selectedId = null;
  kName.value = kit.name ?? "";
  partInspector.classList.add("hidden");
  refreshImageList();
  refreshPartList();
  fitStage();
  regenerateFigures();
}

document.querySelector('[data-act="export"]').addEventListener("click", () => {
  const before = JSON.stringify(serializeKit()).length, kit = buildShippableKit(), after = JSON.stringify(kit).length;
  kJson.value = JSON.stringify(kit, null, 2);
  msg(`Exported (${(after / 1024).toFixed(0)} KB, was ${(before / 1024).toFixed(0)} KB uncropped) — copy or download.`);
});
document.querySelector('[data-act="copy"]').addEventListener("click", async () => {
  kJson.value = JSON.stringify(buildShippableKit());
  try { await navigator.clipboard.writeText(kJson.value); msg("Copied to clipboard."); }
  catch { msg("Clipboard blocked — select the text box and copy manually."); }
});
document.querySelector('[data-act="download"]').addEventListener("click", () => {
  const json = JSON.stringify(buildShippableKit());
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(kName.value || "crowd").replace(/[^\w-]+/g, "-")}.crowd.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
document.querySelector('[data-act="apply"]').addEventListener("click", async () => {
  let parsed;
  try { parsed = JSON.parse(kJson.value); } catch { msg("Invalid JSON."); return; }
  if (!parsed || !Array.isArray(parsed.parts) || !Array.isArray(parsed.images)) { msg("Not a crowd kit — missing images/parts arrays."); return; }
  await loadKit(parsed);
  saveDraft();
  msg("Loaded.");
});
document.querySelector('[data-act="reset"]').addEventListener("click", async () => {
  if (!confirm("Discard the current kit and start a new one?")) return;
  await loadKit({ name: "", images: [], parts: [] });
  saveDraft();
});

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
async function init() {
  buildTypePalette();
  wireInspector();
  wirePreviewControls();
  await loadKit(loadDraft() ?? { name: "", images: [], parts: [] });
  requestAnimationFrame(tickPreview);
}
init();
