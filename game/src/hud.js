// =====================================================================
// DOM HUD + menus: speedo, lap/position, timers, minimap, countdown,
// drift indicator, track-select cards, results and pause screens.
// =====================================================================

const $ = (id) => document.getElementById(id);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function fmtTime(ms) {
  if (ms == null || !isFinite(ms)) return "--:--.---";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const t = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, "0")}.${String(t).padStart(3, "0")}`;
}

function drawSmoothLoop(ctx, P) {
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  ctx.beginPath();
  const m0 = mid(P[P.length - 1], P[0]);
  ctx.moveTo(m0[0], m0[1]);
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    const m = mid(p, P[(i + 1) % P.length]);
    ctx.quadraticCurveTo(p[0], p[1], m[0], m[1]);
  }
  ctx.closePath();
}

function fitTransform(pts, w, h, pad) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const scale = Math.min((w - pad * 2) / (maxX - minX || 1), (h - pad * 2) / (maxZ - minZ || 1));
  const ox = (w - (maxX - minX) * scale) / 2 - minX * scale;
  const oz = (h - (maxZ - minZ) * scale) / 2 - minZ * scale;
  return (x, z) => [x * scale + ox, z * scale + oz];
}

export class HUD {
  constructor() {
    this.el = {
      loading: $("loading"), menu: $("menu"), trackList: $("trackList"), carList: $("carList"),
      hud: $("hud"), racePos: $("racePos"), lapInfo: $("lapInfo"),
      curLap: $("curLap"), lastLap: $("lastLap"), bestLap: $("bestLap"),
      minimap: $("minimap"), speedVal: $("speedVal"), gearVal: $("gearVal"),
      driftBox: $("driftBox"), driftScore: $("driftScore"),
      boostPanel: $("boostPanel"), boostFill: $("boostFill"),
      centerMsg: $("centerMsg"), hint: $("hint"),
      results: $("results"), resultTitle: $("resultTitle"), medal: $("medal"),
      resultSub: $("resultSub"), lapTable: $("lapTable"),
      pauseOverlay: $("pauseOverlay"),
      videoOverlay: $("videoOverlay"),
      vidDrawDist: $("vidDrawDist"), vidDrawDistVal: $("vidDrawDistVal"),
      vidRes: $("vidRes"), vidResVal: $("vidResVal"),
      vidPs1Toggle: $("vidPs1Toggle"),
    };
    // Callbacks assigned by main.js.
    this.onRestart = null;
    this.onResume = null;
    this.onQuitToMenu = null;
    this.onVideoOpen = null;
    this.onVideoBack = null;
    $("btnRestart").onclick = () => this.onRestart?.();
    $("btnMenu").onclick = () => this.onQuitToMenu?.();
    $("btnResume").onclick = () => this.onResume?.();
    $("btnPauseRestart").onclick = () => this.onRestart?.();
    $("btnPauseMenu").onclick = () => this.onQuitToMenu?.();
    $("btnVideo").onclick = () => this.onVideoOpen?.();
    $("btnVideoBack").onclick = () => this.onVideoBack?.();

    this._centerTimer = null;
    this._sticky = false;
    this._wrongWay = false;
    this._mapBase = null;
    this._mapTf = null;
    this._hintTimer = null;
    // update()/minimapDraw() run every frame — cache the last-written values
    // so an unchanged frame (the common case; position/lap rarely change
    // frame-to-frame) skips the innerHTML reparse/DOM-node churn instead of
    // redoing it 60x/sec regardless.
    this._last = {};
  }

  // Floating "+N DRIFT!" pop near the drift box when a chain ends — CSS
  // (driftPop keyframes) drives the whole rise/fade, this just spawns and
  // reaps the element.
  popDrift(amount) {
    const el = document.createElement("div");
    el.className = "driftPop";
    el.textContent = `+${amount} DRIFT!`;
    this.el.hud.appendChild(el);
    setTimeout(() => el.remove(), 1100);
  }

  setLoading(show, text) {
    this.el.loading.classList.toggle("hidden", !show);
    if (text) this.el.loading.innerHTML = text;
  }

  // ---------- menu ----------
  showMenu(tracks, getBestLap, onSelect) {
    this.el.menu.classList.remove("hidden");
    const list = this.el.trackList;
    list.innerHTML = "";
    for (const def of tracks) {
      const card = document.createElement("div");
      card.className = "trackCard";
      const best = getBestLap(def.id);
      card.innerHTML = `
        <div class="tName">${def.name}</div>
        <div class="tDesc">${def.desc}</div>
        <canvas width="180" height="110"></canvas>
        <div class="tMeta">${def.laps} laps &nbsp;&middot;&nbsp; best lap <b>${fmtTime(best)}</b></div>`;
      this._drawPreview(card.querySelector("canvas"), def.controlPoints);
      card.onclick = () => onSelect(def);
      list.appendChild(card);
    }
  }

  hideMenu() { this.el.menu.classList.add("hidden"); }

  // onSelect fires on every click (including re-picking the current car);
  // the caller decides whether that's a no-op. Re-rendered each showMenu()
  // call so the highlighted card always reflects the live selection.
  showCarPicker(cars, selectedId, onSelect) {
    const list = this.el.carList;
    list.innerHTML = "";
    for (const car of cars) {
      const card = document.createElement("div");
      card.className = "carCard" + (car.id === selectedId ? " selected" : "");
      card.innerHTML = `<div class="cName">${car.name}</div>`;
      card.onclick = () => {
        if (card.classList.contains("selected")) return;
        for (const el of list.children) el.classList.remove("selected");
        card.classList.add("selected");
        onSelect(car);
      };
      list.appendChild(card);
    }
  }

  _drawPreview(canvas, controlPoints) {
    const ctx = canvas.getContext("2d");
    const pts = controlPoints.map((p) => ({ x: p[0], z: p[2] }));
    const tf = fitTransform(pts, canvas.width, canvas.height, 12);
    const P = pts.map((p) => tf(p.x, p.z));
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255,204,51,0.9)";
    ctx.lineWidth = 4;
    drawSmoothLoop(ctx, P);
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(P[0][0], P[0][1], 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---------- race HUD ----------
  showRaceUI() {
    this.el.hud.classList.remove("hidden");
    this.el.hint.classList.remove("faded");
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => this.el.hint.classList.add("faded"), 9000);
  }

  hideRaceUI() {
    this.el.hud.classList.add("hidden");
    this.centerClear();
  }

  update(d) {
    const last = this._last;
    this.el.speedVal.textContent = d.speed;
    this.el.gearVal.textContent = d.gear;
    // pos/lap change rarely (an overtake, a lap boundary) — innerHTML
    // reparses into new DOM nodes every call, so skip it on the (vast
    // majority of) frames where nothing actually changed.
    if (d.pos !== last.pos || d.total !== last.total) {
      this.el.racePos.innerHTML = `${d.pos}<span>/${d.total}</span>`;
      last.pos = d.pos; last.total = d.total;
    }
    if (d.lap !== last.lap || d.totalLaps !== last.totalLaps) {
      this.el.lapInfo.innerHTML = `LAP ${d.lap}<span>/${d.totalLaps}</span>`;
      last.lap = d.lap; last.totalLaps = d.totalLaps;
    }
    this.el.curLap.textContent = fmtTime(d.cur);
    this.el.lastLap.textContent = fmtTime(d.last);
    this.el.bestLap.textContent = fmtTime(d.best);
    const drifting = d.driftChain > 1;
    this.el.driftBox.classList.toggle("hidden", !drifting);
    if (drifting) this.el.driftScore.textContent = Math.round(d.driftChain);

    if (d.boostMax) {
      const frac = clamp01(d.boostMeter / d.boostMax);
      this.el.boostFill.style.width = (frac * 100).toFixed(1) + "%";
      this.el.boostPanel.classList.toggle("full", frac >= 1);
      this.el.boostPanel.classList.toggle("active", !!d.boosting);
    }
  }

  // ---------- center messages ----------
  center(text, cls = "", holdMs = 0, sticky = false) {
    clearTimeout(this._centerTimer);
    const el = this.el.centerMsg;
    el.textContent = text;
    el.className = cls;
    el.classList.remove("hidden");
    // retrigger the pop animation
    el.style.animation = "none";
    void el.offsetWidth;
    el.style.animation = "";
    this._sticky = sticky;
    if (holdMs > 0) this._centerTimer = setTimeout(() => this.centerClear(), holdMs);
  }

  centerClear() {
    this.el.centerMsg.classList.add("hidden");
    this._sticky = false;
  }

  setWrongWay(on) {
    if (on === this._wrongWay) return;
    this._wrongWay = on;
    if (on) this.center("WRONG WAY", "warn", 0, true);
    else if (this._sticky) this.centerClear();
  }

  // ---------- minimap ----------
  minimapInit(pts) {
    const c = this.el.minimap;
    this._mapTf = fitTransform(pts, c.width, c.height, 16);
    const base = document.createElement("canvas");
    base.width = c.width;
    base.height = c.height;
    const ctx = base.getContext("2d");
    const P = pts.map((p) => this._mapTf(p.x, p.z));
    ctx.lineJoin = "round";
    ctx.beginPath();
    P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.strokeStyle = "rgba(235,238,245,0.9)";
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = "#ffcc33";
    ctx.fillRect(P[0][0] - 3, P[0][1] - 3, 6, 6);
    this._mapBase = base;
  }

  minimapDraw(dots) {
    if (!this._mapBase) return;
    const c = this.el.minimap;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(this._mapBase, 0, 0);
    for (const d of dots) {
      const [x, y] = this._mapTf(d.x, d.z);
      ctx.beginPath();
      ctx.arc(x, y, d.big ? 4.5 : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = d.color;
      ctx.fill();
      if (d.big) {
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  // ---------- results / pause ----------
  showResults(r) {
    this.el.resultTitle.textContent = r.title;
    this.el.medal.textContent = r.medal;
    this.el.resultSub.innerHTML = r.sub;
    const rows = r.laps
      .map((ms, i) => `<tr class="${i === r.bestIdx ? "best" : ""}"><td>LAP ${i + 1}</td><td>${fmtTime(ms)}</td></tr>`)
      .join("");
    this.el.lapTable.innerHTML = rows + `<tr class="total"><td>TOTAL</td><td>${fmtTime(r.total)}</td></tr>`;
    this.el.results.classList.remove("hidden");
  }

  hideResults() { this.el.results.classList.add("hidden"); }

  showPause(on) { this.el.pauseOverlay.classList.toggle("hidden", !on); }
  showVideo(on) { this.el.videoOverlay.classList.toggle("hidden", !on); }

  // Two-way binds the pause -> Video sliders/toggle straight to CONFIG.render
  // (the object reference itself, so this stays live for the process — same
  // "sliders write straight to CONFIG" approach the old in-race tuning lab
  // used). Called once by main.js at boot; no callback needed since there's
  // nothing race-state-specific about draw distance/resolution/PS1 textures.
  wireVideoOptions(render) {
    const { vidDrawDist, vidDrawDistVal, vidRes, vidResVal, vidPs1Toggle } = this.el;
    const syncDrawDist = () => { vidDrawDist.value = render.drawDistance; vidDrawDistVal.textContent = render.drawDistance; };
    const syncRes = () => { vidRes.value = render.internalHeight; vidResVal.textContent = render.internalHeight; };
    const syncPs1 = () => {
      const on = render.ps1Textures >= 0.5;
      vidPs1Toggle.textContent = on ? "ON" : "OFF";
      vidPs1Toggle.classList.toggle("on", on);
    };
    vidDrawDist.oninput = () => { render.drawDistance = Number(vidDrawDist.value); syncDrawDist(); };
    vidRes.oninput = () => { render.internalHeight = Number(vidRes.value); syncRes(); };
    vidPs1Toggle.onclick = () => { render.ps1Textures = render.ps1Textures >= 0.5 ? 0 : 1; syncPs1(); };
    syncDrawDist(); syncRes(); syncPs1();
  }
}
