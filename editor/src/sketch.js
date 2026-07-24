// =====================================================================
// TRACK SKETCH — a flat 2D drawing page that hands off a rough track
// layout to editor.html for refinement. Click to draw the closed loop,
// drag boxes to block out trees/buildings/crowd zones, hit Generate.
//
// The handoff needs no coordination with editor.js: it boots from
// `loadDef(loadDraft() ?? freshDef())`, reading the same localStorage draft
// key this page writes; normalizeDef() fills in anything unset.
//
// Deliberately favors cheap, non-3D-instance object types (Cutout billboard
// sprites, one continuous Spline Barrier ribbon) over hundreds of discrete
// 3D props, since a rough draft benefits more from being fast to look at
// than high-fidelity. The main track explicitly sets its barrier band to
// "splineBarrier" rather than leaving `trackObjects` unset — that would let
// editor.js's defaultBands() fallback fire, which always uses the discrete/3D "barrier" type.
//
// Zones become extra splines (a 2-point open line across the drawn zone),
// each carrying one band of the zone's type — the same "extra splines"
// mechanism the editor already uses for free-standing scenery. A generated
// zone refines afterward exactly like any hand-drawn extra spline — no
// special-cased code path for anything this page produces.
// =====================================================================

const STORE_KEY = "pgp-editor-draft";

const ZONE_META = {
  zoneTree: { type: "cutoutTree", label: "Trees", fill: "rgba(70,170,90,0.30)", border: "#4ea35c" },
  zoneBuilding: { type: "cutoutBuilding", label: "Buildings", fill: "rgba(150,140,210,0.30)", border: "#a79bd6" },
  zoneCrowd: { type: "crowd", label: "Crowd", fill: "rgba(224,90,90,0.30)", border: "#e05a5a" },
};

// Rough starting points, not meant to be final — every one of these is a
// plain band field, tunable in the real editor's Bands panel afterward.
const ZONE_BAND_DEFAULTS = {
  cutoutTree: { spacing: 4, offset: 1.5 },
  cutoutBuilding: { spacing: 18, offset: 0 },
  crowd: { spacing: 1.2, offset: 0.4, rows: 2, rowSpacing: 1.2 },
};

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const msgEl = document.getElementById("msg");

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  render();
}
window.addEventListener("resize", resize);

// ---------------------------------------------------------------------
// View transform (world meters <-> screen px)
// ---------------------------------------------------------------------
const view = { scale: 4, cx: 0, cz: 0 }; // scale = px/meter; cx/cz = world point at canvas center

function worldToScreen(x, z) {
  return [canvas.width / 2 + (x - view.cx) * view.scale, canvas.height / 2 + (z - view.cz) * view.scale];
}
function screenToWorld(sx, sy) {
  return [(sx - canvas.width / 2) / view.scale + view.cx, (sy - canvas.height / 2) / view.scale + view.cz];
}

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
let mode = "track";
let trackPoints = []; // [{x, z}, ...] world meters
let zones = []; // [{type, label, fill, border, x0, z0, x1, z1}, ...]
// Reference image to trace a real track over — purely a tracing aid, never
// part of the generated def. scale is world meters per original image
// pixel (so resizing doesn't depend on the current view zoom); x/z is the
// image's *center* in world meters, so wheel-resize (Image mode) grows/
// shrinks it symmetrically instead of drifting.
let refImage = null; // { img, x, z, scale, opacity }

let panState = null; // { startSX, startSY, startCx, startCz }
let zoneDragState = null; // { type, label, fill, border, x0, z0 } — x1/z1 tracked live via mousemove
let imageDragState = null; // { startSX, startSY, startX, startZ }
let nodeDragState = null; // { index, startSX, startSY } — Select mode, dragging an existing track point
let nodeInteractionHandled = false; // set by mouseup when nodeDragState was active, so the click right after it doesn't also insert a point

// ---------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------
for (const btn of document.querySelectorAll("#modes button")) {
  btn.addEventListener("click", () => {
    mode = btn.dataset.mode;
    for (const b of document.querySelectorAll("#modes button")) b.classList.toggle("active", b === btn);
    canvas.style.cursor = mode === "image" ? "move" : "crosshair";
  });
}
document.getElementById("undoBtn").onclick = () => {
  trackPoints.pop();
  render();
};
document.getElementById("clearBtn").onclick = () => {
  if (!trackPoints.length && !zones.length) return;
  if (!confirm("Clear the whole sketch?")) return;
  trackPoints = [];
  zones = [];
  render();
};
document.getElementById("genBtn").onclick = generate;

// ---------------------------------------------------------------------
// Reference image — load, drag-to-move (Image mode), wheel-to-resize
// (Image mode), opacity slider. Purely a tracing aid: never touched by
// generate(), never serialized into the track def.
// ---------------------------------------------------------------------
const loadImageBtn = document.getElementById("loadImageBtn");
const imageFileInput = document.getElementById("imageFile");
const opacitySlider = document.getElementById("opacitySlider");
const opacityVal = document.getElementById("opacityVal");
const clearImageBtn = document.getElementById("clearImageBtn");

function loadImageFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    // Starts centered on the current view at roughly half its width —
    // wheel-resize + drag from there to match it against the grid/track.
    const targetWorldWidth = canvas.width / 2 / view.scale;
    refImage = { img, x: view.cx, z: view.cz, scale: targetWorldWidth / img.width, opacity: opacitySlider.value / 100 };
    URL.revokeObjectURL(url);
    render();
  };
  img.src = url;
}

loadImageBtn.onclick = () => imageFileInput.click();
imageFileInput.onchange = () => {
  const file = imageFileInput.files[0];
  if (file) loadImageFile(file);
  imageFileInput.value = ""; // allow re-selecting the same file later
};
canvas.addEventListener("dragover", (e) => e.preventDefault());
canvas.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith("image/")) loadImageFile(file);
});

opacitySlider.oninput = () => {
  opacityVal.textContent = opacitySlider.value + "%";
  if (refImage) refImage.opacity = opacitySlider.value / 100;
  render();
};
clearImageBtn.onclick = () => {
  refImage = null;
  render();
};

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (mode === "image" && refImage) {
    refImage.scale = Math.min(20, Math.max(0.001, refImage.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  } else {
    view.scale = Math.min(30, Math.max(1, view.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  }
  render();
}, { passive: false });

function nearestTrackPointIndex(sx, sy) {
  let best = -1, bestD2 = 144; // 12px radius
  for (let i = 0; i < trackPoints.length; i++) {
    const [px, py] = worldToScreen(trackPoints[i].x, trackPoints[i].z);
    const d2 = (px - sx) ** 2 + (py - sy) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return best;
}

function distToSegmentSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0;
  const cx = ax + t * dx, cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

// Which track segment (straight-line approximation of the smoothed curve —
// plenty close enough to click on) a screen point landed near, if any.
// Returns the index i such that the point belongs between trackPoints[i]
// and trackPoints[i+1] (wrapping once there are >=3 points, since that's
// when the loop draws closed — see drawTrackLine's own closed check).
function nearestTrackSegment(sx, sy) {
  if (trackPoints.length < 2) return null;
  const screenPts = trackPoints.map((p) => worldToScreen(p.x, p.z));
  const segCount = trackPoints.length >= 3 ? trackPoints.length : 1;
  let best = -1, bestD2 = 100; // 10px radius
  for (let i = 0; i < segCount; i++) {
    const a = screenPts[i], b = screenPts[(i + 1) % screenPts.length];
    const d2 = distToSegmentSq(sx, sy, a[0], a[1], b[0], b[1]);
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return best >= 0 ? best : null;
}

canvas.addEventListener("mousedown", (e) => {
  if (e.button === 1 || e.button === 2) {
    panState = { startSX: e.clientX, startSY: e.clientY, startCx: view.cx, startCz: view.cz };
    return;
  }
  if (e.button !== 0) return;
  if (mode.startsWith("zone")) {
    const [wx, wz] = screenToWorld(e.clientX, e.clientY);
    const meta = ZONE_META[mode];
    zoneDragState = { ...meta, x0: wx, z0: wz, x1: wx, z1: wz };
  } else if (mode === "image" && refImage) {
    imageDragState = { startSX: e.clientX, startSY: e.clientY, startX: refImage.x, startZ: refImage.z };
  } else if (mode === "select") {
    const idx = nearestTrackPointIndex(e.clientX, e.clientY);
    if (idx >= 0) nodeDragState = { index: idx, startSX: e.clientX, startSY: e.clientY };
  }
});

canvas.addEventListener("mousemove", (e) => {
  if (panState) {
    view.cx = panState.startCx - (e.clientX - panState.startSX) / view.scale;
    view.cz = panState.startCz - (e.clientY - panState.startSY) / view.scale;
    render();
    return;
  }
  if (zoneDragState) {
    const [wx, wz] = screenToWorld(e.clientX, e.clientY);
    zoneDragState.x1 = wx;
    zoneDragState.z1 = wz;
    render();
    return;
  }
  if (imageDragState) {
    refImage.x = imageDragState.startX + (e.clientX - imageDragState.startSX) / view.scale;
    refImage.z = imageDragState.startZ + (e.clientY - imageDragState.startSY) / view.scale;
    render();
    return;
  }
  if (nodeDragState) {
    const [wx, wz] = screenToWorld(e.clientX, e.clientY);
    trackPoints[nodeDragState.index].x = wx;
    trackPoints[nodeDragState.index].z = wz;
    render();
  }
});

window.addEventListener("mouseup", (e) => {
  if (panState && (e.button === 1 || e.button === 2)) {
    panState = null;
    return;
  }
  if (zoneDragState && e.button === 0) {
    const z = zoneDragState;
    zoneDragState = null;
    const x0 = Math.min(z.x0, z.x1), x1 = Math.max(z.x0, z.x1);
    const z0 = Math.min(z.z0, z.z1), z1 = Math.max(z.z0, z.z1);
    if (x1 - x0 > 1 && z1 - z0 > 1) zones.push({ ...z, x0, z0, x1, z1 });
    render();
    return;
  }
  if (imageDragState && e.button === 0) {
    imageDragState = null;
    return;
  }
  if (nodeDragState && e.button === 0) {
    // A plain click (barely moved) on a node still deletes it, same as
    // before — dragging it any real distance instead leaves it at the new
    // spot. nodeInteractionHandled stops the click event right after this
    // mouseup from also running the line-click-inserts-a-point logic below.
    const moved = Math.hypot(e.clientX - nodeDragState.startSX, e.clientY - nodeDragState.startSY);
    if (moved < 6) trackPoints.splice(nodeDragState.index, 1);
    nodeDragState = null;
    nodeInteractionHandled = true;
    render();
  }
});

canvas.addEventListener("click", (e) => {
  if (panState || zoneDragState || imageDragState) return; // just finished a pan/drag, not a click-to-place
  if (nodeInteractionHandled) {
    nodeInteractionHandled = false;
    return;
  }
  if (mode === "track") {
    const [wx, wz] = screenToWorld(e.clientX, e.clientY);
    trackPoints.push({ x: wx, z: wz });
    render();
  } else if (mode === "select") {
    trySelectOrInsert(e.clientX, e.clientY);
  }
});

function trySelectOrInsert(sx, sy) {
  // zones first (topmost = last drawn wins) — click a node is handled
  // entirely by the mousedown/mousemove/mouseup drag machine above, so by
  // the time a plain click gets here it was never on a node.
  const [wx, wz] = screenToWorld(sx, sy);
  for (let i = zones.length - 1; i >= 0; i--) {
    const z = zones[i];
    if (wx >= z.x0 && wx <= z.x1 && wz >= z.z0 && wz <= z.z1) {
      zones.splice(i, 1);
      render();
      return;
    }
  }
  // Click landed near the line itself (not a node, not a zone) — insert a
  // new point there, between whichever two points that segment connects.
  const seg = nearestTrackSegment(sx, sy);
  if (seg != null) {
    trackPoints.splice(seg + 1, 0, { x: wx, z: wz });
    render();
  }
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------
function drawGrid() {
  const stepM = view.scale >= 8 ? 5 : view.scale >= 3 ? 10 : 25;
  const stepPx = stepM * view.scale;
  const [wx0] = screenToWorld(0, 0);
  const [wx1] = screenToWorld(canvas.width, 0);
  const startX = Math.floor(wx0 / stepM) * stepM;
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let x = startX; x <= wx1 + stepM; x += stepM) {
    const [sx] = worldToScreen(x, 0);
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, canvas.height); ctx.stroke();
  }
  const [, wz0] = screenToWorld(0, 0);
  const [, wz1] = screenToWorld(0, canvas.height);
  const startZ = Math.floor(wz0 / stepM) * stepM;
  for (let z = startZ; z <= wz1 + stepM; z += stepM) {
    const [, sy] = worldToScreen(0, z);
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(canvas.width, sy); ctx.stroke();
  }
  // origin cross
  const [ox, oy] = worldToScreen(0, 0);
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.beginPath(); ctx.moveTo(ox - 8, oy); ctx.lineTo(ox + 8, oy); ctx.moveTo(ox, oy - 8); ctx.lineTo(ox, oy + 8); ctx.stroke();
}

function drawRefImage() {
  if (!refImage) return;
  const { img, x, z, scale, opacity } = refImage;
  const wPx = img.width * scale * view.scale;
  const hPx = img.height * scale * view.scale;
  const [sx, sy] = worldToScreen(x, z);
  ctx.globalAlpha = opacity;
  ctx.drawImage(img, sx - wPx / 2, sy - hPx / 2, wPx, hPx);
  ctx.globalAlpha = 1;
}

// A Google-Maps-style scale bar: picks a "nice" round meter value whose
// on-screen length lands near targetPx at the current zoom, so tracing an
// image against the grid has an explicit "this many pixels = N meters"
// reference instead of just the grid lines' spacing label.
function updateScaleBar() {
  const targetPx = 120;
  const targetM = targetPx / view.scale;
  const magnitude = 10 ** Math.floor(Math.log10(targetM));
  const residual = targetM / magnitude;
  const niceResidual = residual < 1.5 ? 1 : residual < 3.5 ? 2 : residual < 7.5 ? 5 : 10;
  const meters = niceResidual * magnitude;
  document.getElementById("scaleLabel").textContent = `${meters} m`;
  document.getElementById("scaleBarFill").style.width = `${meters * view.scale}px`;
}

function drawZoneRect(z) {
  const [sx0, sy0] = worldToScreen(z.x0, z.z0);
  const [sx1, sy1] = worldToScreen(z.x1, z.z1);
  ctx.fillStyle = z.fill;
  ctx.strokeStyle = z.border;
  ctx.lineWidth = 2;
  ctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
  ctx.strokeRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
  ctx.fillStyle = z.border;
  ctx.font = "bold 12px system-ui, sans-serif";
  ctx.fillText(z.label, sx0 + 6, sy0 + 16);
}

// Same "quadratic curve through midpoints" technique src/hud.js uses for
// track-card minimap previews, adapted to draw open (not-yet-closed) too.
function drawTrackLine(P, closed) {
  if (P.length < 2) return;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  ctx.beginPath();
  if (closed) {
    const m0 = mid(P[P.length - 1], P[0]);
    ctx.moveTo(m0[0], m0[1]);
    for (let i = 0; i < P.length; i++) {
      const m = mid(P[i], P[(i + 1) % P.length]);
      ctx.quadraticCurveTo(P[i][0], P[i][1], m[0], m[1]);
    }
    ctx.closePath();
  } else {
    ctx.moveTo(P[0][0], P[0][1]);
    for (let i = 0; i < P.length - 1; i++) {
      const m = mid(P[i], P[i + 1]);
      ctx.quadraticCurveTo(P[i][0], P[i][1], m[0], m[1]);
    }
    ctx.lineTo(P[P.length - 1][0], P[P.length - 1][1]);
  }
  ctx.strokeStyle = "#ffcc33";
  ctx.lineWidth = 3;
  ctx.stroke();
}

function render() {
  ctx.fillStyle = "#12151c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawRefImage(); // under the grid/track so gridlines and the traced line stay legible over it
  drawGrid();
  updateScaleBar();

  for (const z of zones) drawZoneRect(z);
  if (zoneDragState) {
    const z = zoneDragState;
    drawZoneRect({ ...z, x0: Math.min(z.x0, z.x1), x1: Math.max(z.x0, z.x1), z0: Math.min(z.z0, z.z1), z1: Math.max(z.z0, z.z1) });
  }

  const screenPts = trackPoints.map((p) => worldToScreen(p.x, p.z));
  drawTrackLine(screenPts, trackPoints.length >= 3);

  trackPoints.forEach((p, i) => {
    const [sx, sy] = worldToScreen(p.x, p.z);
    ctx.beginPath();
    ctx.arc(sx, sy, i === 0 ? 6 : 4.5, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? "#fff" : "#ffcc33";
    ctx.fill();
    ctx.strokeStyle = "#10131a";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#cfd6e4";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText(String(i + 1), sx + 7, sy - 7);
  });
}

// ---------------------------------------------------------------------
// Generate — build a partial track-def, hand it to editor.js's own draft
// storage, and navigate there.
// ---------------------------------------------------------------------
function zoneToExtraSpline(zone, i) {
  const d = ZONE_BAND_DEFAULTS[zone.type];
  const band = { type: zone.type, side: "both", from: 0, to: 1, spacing: d.spacing, offset: d.offset };
  if (d.rows) { band.rows = d.rows; band.rowSpacing = d.rowSpacing; }
  return {
    id: `zone-${i}`,
    name: `${zone.label} zone ${i + 1}`,
    closed: false,
    // Open 2-point line across the drawn zone's diagonal — the minimum an
    // open spline needs (validateDef requires >=2). The band's own offset
    // spreads instances to both sides of it, so this is a rough stand-in
    // for "fill this rectangle", refined afterward by dragging either
    // endpoint or adding more points to the spline in the editor.
    controlPoints: [[zone.x0, 0, zone.z0], [zone.x1, 0, zone.z1]],
    trackObjects: { bands: [band], points: [] },
  };
}

function showMsg(text) {
  msgEl.textContent = text;
  msgEl.classList.add("show");
  clearTimeout(showMsg._t);
  showMsg._t = setTimeout(() => msgEl.classList.remove("show"), 3000);
}

function generate() {
  if (trackPoints.length < 3) {
    showMsg("Draw at least 3 track points first.");
    return;
  }
  const name = document.getElementById("fName").value.trim() || "Sketch Track";
  const width = Number(document.getElementById("fWidth").value) || 9;
  const laps = Number(document.getElementById("fLaps").value) || 3;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sketch-track";

  const def = {
    id, name, desc: "", laps, width,
    medalAvgSpeed: { gold: 12, silver: 10.5, bronze: 9 },
    theme: {
      sky: 0x87ceeb, fog: 0x9cc7de, fogNear: 70, fogFar: 340,
      ground: "#4c7a3f", hill: 0x50694a, terrain: "grass",
      sun: 0xfff4e0, sunIntensity: 2.2, hemiIntensity: 0.9,
      // trees: 0 — ambient scatter's "trees" is 3D buildTree() instances
      // (environment.js), separate from the billboard Cutout: Tree zones
      // below; left at 0 so tree zones are the only source of trees.
      props: { trees: 0, rocks: 12, billboards: 4 },
    },
    controlPoints: trackPoints.map((p) => [Math.round(p.x * 10) / 10, 0, Math.round(p.z * 10) / 10]),
    // Explicit splineBarrier band instead of leaving trackObjects unset —
    // editor.js's defaultBands() fallback (fires when trackObjects is
    // absent) would otherwise generate the discrete/3D "barrier" type.
    // offset is omitted so placeBand() falls back to the built track's own
    // wallDist (see trackObjects.js), same distance defaultBands() would've
    // used. No apex-kerb band — not asked for, add one in the editor if wanted.
    trackObjects: { bands: [{ type: "splineBarrier", side: "both", from: 0, to: 1 }], points: [] },
    extraSplines: zones.map(zoneToExtraSpline),
  };

  localStorage.setItem(STORE_KEY, JSON.stringify(def));
  location.href = "./editor.html";
}

resize();
