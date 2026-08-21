// =====================================================================
// TUNING LAB — panel exposing the key handling parameters as live sliders.
// Changes apply instantly (physics reads CONFIG every step) and persist to
// localStorage per car. Tunes can be named, exported as JSON (copy/download)
// and re-imported.
//
// Lives at editor/tuningLab.html (a standalone sandbox — see that file),
// not in the shipped game. An exported tune tagged with a carId becomes a
// "car profile": drop the downloaded file into game/carProfiles/ and it's
// auto-discovered and layered onto that car's physics at boot in the real
// game too — see game/src/carProfiles.js for the discovery/layering side.
// =====================================================================

import { CONFIG } from "../../shared/src/config.js";

// [path, label, min, max, step, key]  — key=1 marks the params that define
// the character of a car (starred in the UI); the rest are fine-tuning.
// Each group also carries a `tab` (defaults to "Physics" if omitted) —
// groups sharing a tab name are rendered together under that tab button.
// Exported (along with getPath/setPath/applyParamsToConfig below) so
// carProfiles.js can snapshot/apply the exact same param surface without
// pulling in the whole panel UI.
export const PARAMS = [
  { group: "Body", items: [
    ["physics.mass", "Mass", 0.6, 3, 0.05, 1],
    ["physics.gyration", "Yaw gyration", 0.25, 1.2, 0.05, 1],
    ["physics.cgToFront", "CG → front axle", 0.3, 0.7, 0.01, 1],
    ["physics.cgHeight", "CG height", 0.05, 0.5, 0.01, 1],
  ]},
  { group: "Engine / Brakes", items: [
    ["physics.maxSpeed", "Top speed (m/s)", 10, 60, 1],
    ["physics.engineAccel", "Engine force", 1, 15, 0.25, 1],
    ["physics.brakeDecel", "Brake force", 2, 25, 0.25, 1],
    ["physics.brakeBias", "Brake bias front", 0.3, 0.9, 0.01],
    ["physics.dragK", "Aero drag", 0, 0.03, 0.0005],
    ["physics.rollingResist", "Rolling resist", 0, 3, 0.05],
    ["physics.slopeGravity", "Hill grade effect", 0, 2, 0.05],
  ]},
  { group: "Drivetrain", items: [
    ["physics.drivetrain", "Type", ["rwd", "fwd", "awd"], 0, 0, 1],
    ["physics.awdFrontShare", "AWD front share", 0.2, 0.8, 0.05],
    ["physics.launchTorque", "Launch torque", 0, 3, 0.05, 1],
    ["physics.launchFade", "Launch fades by", 2, 15, 0.5],
    ["physics.wheelspinLatLoss", "Spin: lat grip loss", 0, 1, 0.05, 1],
    ["physics.wheelspinLongLoss", "Spin: push loss", 0, 0.8, 0.05],
    ["physics.spinRise", "Spin-up rate", 0.2, 4, 0.1],
    ["physics.spinDecay", "Spin recovery", 0.5, 8, 0.1],
  ]},
  { group: "Steering", items: [
    ["physics.maxSteer", "Angle @ standstill", 0.2, 0.9, 0.01],
    ["physics.maxSteerHigh", "Angle @ top speed", 0.02, 0.5, 0.01, 1],
    ["physics.steerShape", "Falloff shape", 0.2, 3, 0.05],
    ["physics.steerSpeed", "Steer rate", 0.5, 8, 0.1],
    ["physics.steerReturnSpeed", "Return rate", 0.5, 10, 0.1],
  ]},
  { group: "Assists & Aero", items: [
    ["physics.steerAssist", "Steering assist", 0, 1, 0.05, 1],
    ["physics.stabilityAssist", "Stability assist", 0, 1, 0.05, 1],
    ["physics.downforce", "Downforce", 0, 0.08, 0.002, 1],
    ["physics.aeroBalance", "Aero balance front", 0.2, 0.8, 0.05],
  ]},
  { group: "Tires", items: [
    ["physics.mu", "Grip μ", 0.5, 2.5, 0.05, 1],
    ["physics.tireFront.B", "Front stiffness B", 4, 25, 0.5],
    ["physics.tireFront.C", "Front shape C", 1, 2, 0.05],
    ["physics.tireRear.B", "Rear stiffness B", 4, 25, 0.5, 1],
    ["physics.tireRear.C", "Rear shape C", 1, 2, 0.05, 1],
    ["physics.lowSpeedGripBoost", "Low-speed grip +", 0, 1.5, 0.05],
    ["physics.lowSpeedGripFade", "…fades by (m/s)", 4, 30, 0.5],
    ["physics.vBlend", "Kinematic below", 1, 6, 0.25],
    ["physics.handbrakeLatFactor", "Handbrake grip", 0, 0.6, 0.01],
  ]},
  { group: "Surface", items: [
    ["physics.offroad.grip", "Offroad grip", 0.2, 1, 0.02],
    ["physics.offroad.drag", "Offroad drag", 0, 8, 0.2],
  ]},
  // Additive-harmonic engine synth (config.js/audio.js). "Growl" (firing-
  // order harmonic) most defines a cylinder count's character; "Pitch
  // glide" controls how sharp vs. smooth a gearshift's rpm drop sounds.
  { tab: "Engine Audio", group: "Crank & Firing", items: [
    ["audio.engine.idleRpm", "Idle RPM", 500, 2000, 25],
    ["audio.engine.maxRpm", "Redline RPM", 4000, 10000, 100, 1],
    ["audio.engine.cylinders", "Cylinders", 2, 12, 1, 1],
  ]},
  // CONFIG.gearSpeeds: road-speed each gear tops out at (index 0 fixed at
  // 0 — 1st/neutral). main.js's gearAndRpm() remaps rpm across the span
  // between entries each shift — a gap wide relative to remaining accel
  // reads as "shifts up and goes quiet for a while"; narrow gear 6's gap to reduce that.
  { tab: "Engine Audio", group: "Gearbox", items: [
    ["gearSpeeds.1", "Gear 1 max (m/s)", 2, 10, 0.5],
    ["gearSpeeds.2", "Gear 2 max (m/s)", 5, 14, 0.5],
    ["gearSpeeds.3", "Gear 3 max (m/s)", 8, 18, 0.5],
    ["gearSpeeds.4", "Gear 4 max (m/s)", 11, 22, 0.5],
    ["gearSpeeds.5", "Gear 5 max (m/s)", 14, 26, 0.5],
    ["gearSpeeds.6", "Gear 6 max (m/s)", 17, 32, 0.5, 1],
  ]},
  { tab: "Engine Audio", group: "Harmonics", items: [
    ["audio.engine.rumbleGain", "Rumble (1x)", 0, 1.5, 0.05],
    ["audio.engine.growlGain", "Growl (firing order)", 0, 1.5, 0.05, 1],
    ["audio.engine.bodyGain", "Body (2x)", 0, 1.5, 0.05],
    ["audio.engine.raspGain", "Rasp (cylinders x)", 0, 1.5, 0.05],
    ["audio.engine.chugDepth", "Chug depth", 0, 1, 0.05, 1],
  ]},
  { tab: "Engine Audio", group: "Tone & Volume", items: [
    ["audio.engine.toneCutoffBase", "Tone cutoff (idle)", 100, 1000, 10],
    ["audio.engine.toneCutoffRpmGain", "…brighten by (redline)", 0, 5000, 50],
    ["audio.engine.gainBase", "Volume (idle)", 0, 0.15, 0.005],
    ["audio.engine.gainLoad", "Volume (+throttle)", 0, 0.3, 0.005],
    ["audio.engine.pitchGlide", "Pitch glide (s)", 0.005, 0.15, 0.005, 1],
  ]},
  { tab: "SFX", group: "Tire Squeal", items: [
    ["audio.squeal.toneGain", "Squeal volume", 0, 0.4, 0.01, 1],
    ["audio.squeal.noiseGain", "Rasp volume", 0, 0.6, 0.01],
    ["audio.squeal.freqBase", "Pitch (Hz)", 800, 4000, 50, 1],
    ["audio.squeal.freqRise", "Pitch rise w/ slip", 0, 2000, 50],
    ["audio.squeal.detune", "Detune (cents)", 0, 60, 1],
    ["audio.squeal.formantQ", "Resonance", 0.5, 8, 0.1],
    ["audio.squeal.vibratoRate", "Wobble rate (Hz)", 2, 16, 0.5],
    ["audio.squeal.vibratoDepth", "Wobble depth (Hz)", 0, 600, 10],
    ["audio.squeal.flutterDepth", "Stick-slip flutter", 0, 1, 0.05, 1],
    ["audio.squeal.threshold", "Starts at slip", 0, 0.5, 0.01],
    ["audio.squeal.range", "Full by +slip", 0.2, 1, 0.05],
  ]},
  { tab: "SFX", group: "Slide Rumble", items: [
    ["audio.skid.gain", "Rumble volume", 0, 0.5, 0.01, 1],
    ["audio.skid.freqBase", "Rumble freq (Hz)", 200, 1200, 10],
    ["audio.skid.freqRise", "Freq rise w/ slip", 0, 1500, 10],
  ]},
];

const STORE_KEY = "pgp-tune-current"; // per-car key: see TuningLab._storeKey()

export function getPath(obj, path) {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}
export function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((o, k) => o?.[k], obj);
  if (target && last in target) target[last] = value;
}
function decimals(step) {
  const s = String(step);
  return s.includes(".") ? s.split(".")[1].length : 0;
}

// path -> row lookup shared by applyParamsToConfig and TuningLab instances
// (built once from PARAMS, not per-instance) — a plain {path: [min,max,step]|options}
// map would work too, but reusing PARAMS directly keeps this as the one
// source of truth for "what's a valid path and what values are legal".
const ALL_ROWS = new Map();
for (const g of PARAMS) for (const [path, , min] of g.items) ALL_ROWS.set(path, Array.isArray(min) ? min : null);

// Applies a {path: value} map (a tune/profile's `params`) straight to
// CONFIG, skipping unknown paths and out-of-shape values — shared by
// TuningLab.applyTune() (UI-driven) and carProfiles.js (boot-time,
// no UI involved) so both go through identical validation.
export function applyParamsToConfig(params) {
  let applied = 0;
  for (const [path, value] of Object.entries(params ?? {})) {
    // ALL_ROWS only ever holds paths still in PARAMS — stale saves/profiles
    // from before video options moved to the in-game pause menu may still
    // carry old render.* keys; those just fall through here as unknown.
    if (!ALL_ROWS.has(path)) continue;
    const options = ALL_ROWS.get(path);
    const valid = options ? options.includes(value) : typeof value === "number" && isFinite(value);
    if (valid) {
      setPath(CONFIG, path, value);
      applied++;
    }
  }
  return applied;
}

export class TuningLab {
  // carModels: optional [{id, name}, ...] — when given, a car-select
  // dropdown is rendered under the header and onCarChange(carId) fires on
  // selection (used by editor/tuningLab.html; the in-race panel this was
  // originally built for never passed one, and now nothing does — main.js
  // no longer instantiates this class at all, see game/src/carProfiles.js).
  constructor({ carModels = [], onCarChange } = {}) {
    // snapshot code (RWD-baseline) defaults before any saved tune is applied —
    // overwritten per-car by setCar() once a car is actually selected, so
    // Reset/★-modified-highlight compare against THAT car's own baseline
    // instead of always falling back to this generic one.
    this.defaults = {};
    for (const g of PARAMS) for (const [path] of g.items) this.defaults[path] = getPath(CONFIG, path);
    this.carId = null;
    this.carModels = carModels;
    this.onCarChange = onCarChange;

    this._build();
  }

  toggle() {
    this.el.classList.toggle("hidden");
  }

  // Called by main.js's setPlayerCar() right after applyCarPhysics(carId) has
  // merged CONFIG.physics to that car's own preset (or the plain baseline) —
  // re-snapshots `defaults` from that already-correct state, then loads this
  // car's own saved tune (per-car localStorage key) on top if one exists.
  setCar(carId) {
    if (this.carId === carId) return;
    this.carId = carId;
    for (const g of PARAMS) for (const [path] of g.items) this.defaults[path] = getPath(CONFIG, path);
    this._loadSaved();
    this._syncAll();
    const carSel = this.el.querySelector("#tunerCarSel");
    if (carSel) carSel.value = carId;
  }

  _storeKey() {
    return `${STORE_KEY}-${this.carId ?? "default"}`;
  }

  // Rebuilds the car dropdown's options — needed because ASSETS.carModels
  // can grow after this panel is already built: it's constructed early (for
  // an instantly-visible panel) but car auto-discovery only finishes inside
  // preloadAssets(), which the caller awaits separately. Call this once that
  // resolves. No-op if this panel was never given carModels in the first
  // place (the in-race case, if anything still does that).
  setCarModels(carModels) {
    this.carModels = carModels;
    const carSel = this.el.querySelector("#tunerCarSel");
    if (!carSel) return;
    const current = carSel.value;
    carSel.innerHTML = carModels.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
    if (carModels.some((c) => c.id === current)) carSel.value = current;
  }

  _build() {
    const el = (this.el = document.createElement("div"));
    el.id = "tuner";
    el.className = "hidden";

    const tabs = [...new Set(PARAMS.map((g) => g.tab ?? "Physics"))];

    let html = `<div class="tHead">TUNING LAB <span><b class="tStar">★</b> key params</span></div>`;
    if (this.carModels.length) {
      html += `<div class="tCarSel"><select id="tunerCarSel">${this.carModels
        .map((c) => `<option value="${c.id}">${c.name}</option>`)
        .join("")}</select></div>`;
    }
    html += `<div class="tTabs">${tabs
      .map((tb, i) => `<button class="tTab${i === 0 ? " active" : ""}" data-tab="${tb}">${tb}</button>`)
      .join("")}</div>`;
    html += `<div class="tBody">`;
    for (const g of PARAMS) {
      const gTab = g.tab ?? "Physics";
      const hide = gTab !== tabs[0] ? ' style="display:none"' : "";
      html += `<div class="tGroup" data-tab="${gTab}"${hide}><div class="tGTitle">${g.group}</div>`;
      for (const [path, label, min, max, step, key] of g.items) {
        const star = key ? '<b class="tStar">★</b> ' : "";
        if (Array.isArray(min)) {
          // enum param -> dropdown
          html += `
            <div class="tRow" data-path="${path}">
              <label>${star}${label}</label>
              <select>${min.map((o) => `<option value="${o}">${o.toUpperCase()}</option>`).join("")}</select>
            </div>`;
        } else {
          html += `
            <div class="tRow" data-path="${path}">
              <label>${star}${label}</label>
              <input type="range" min="${min}" max="${max}" step="${step}">
              <input type="number" min="${min}" max="${max}" step="${step}">
            </div>`;
        }
      }
      html += `</div>`;
    }
    html += `</div>
      <div class="tFoot">
        <input id="tuneName" type="text" placeholder="tune name (e.g. gt-road-car)" spellcheck="false">
        <textarea id="tuneJson" rows="5" spellcheck="false"
          placeholder="Export writes JSON here — copy it and hand it back. Paste a tune and hit Apply to load one."></textarea>
        <div class="tBtns">
          <button data-act="export">Export</button>
          <button data-act="copy">Copy</button>
          <button data-act="download">Download</button>
          <button data-act="apply">Apply</button>
          <button data-act="reset" class="danger">Reset</button>
        </div>
        <div class="tMsg" id="tuneMsg"></div>
      </div>`;
    el.innerHTML = html;
    document.body.appendChild(el);

    // wire rows
    this.rows = new Map();
    for (const row of el.querySelectorAll(".tRow")) {
      const path = row.dataset.path;
      const select = row.querySelector("select");
      if (select) {
        this.rows.set(path, { row, select, options: [...select.options].map((o) => o.value) });
        select.addEventListener("change", () => {
          setPath(CONFIG, path, select.value);
          this._syncRow(path);
          this._saveCurrent();
        });
        continue;
      }
      const [range, num] = row.querySelectorAll("input");
      this.rows.set(path, { row, range, num });
      const onInput = (v) => {
        const val = Number(v);
        if (!isFinite(val)) return;
        setPath(CONFIG, path, val);
        this._syncRow(path);
        this._saveCurrent();
      };
      range.addEventListener("input", () => onInput(range.value));
      num.addEventListener("input", () => onInput(num.value));
    }
    this._syncAll();

    const carSel = el.querySelector("#tunerCarSel");
    if (carSel) carSel.addEventListener("change", () => this.onCarChange?.(carSel.value));

    for (const btn of el.querySelectorAll(".tTab")) {
      btn.addEventListener("click", () => {
        const tb = btn.dataset.tab;
        for (const b of el.querySelectorAll(".tTab")) b.classList.toggle("active", b === btn);
        for (const grp of el.querySelectorAll(".tGroup")) grp.style.display = grp.dataset.tab === tb ? "" : "none";
      });
    }

    el.querySelector('[data-act="export"]').onclick = () => this._export();
    el.querySelector('[data-act="copy"]').onclick = () => this._copy();
    el.querySelector('[data-act="download"]').onclick = () => this._download();
    el.querySelector('[data-act="apply"]').onclick = () => this._applyPasted();
    el.querySelector('[data-act="reset"]').onclick = () => this._reset();
  }

  _syncRow(path) {
    const r = this.rows.get(path);
    const v = getPath(CONFIG, path);
    if (r.select) {
      r.select.value = v;
      r.row.classList.toggle("modified", v !== this.defaults[path]);
      return;
    }
    const d = decimals(Number(r.range.step));
    r.range.value = v;
    r.num.value = Number(v.toFixed(Math.max(d, 4)));
    r.row.classList.toggle("modified", Math.abs(v - this.defaults[path]) > 1e-9);
  }

  _syncAll() {
    for (const path of this.rows.keys()) this._syncRow(path);
  }

  _msg(text) {
    const m = this.el.querySelector("#tuneMsg");
    m.textContent = text;
    clearTimeout(this._msgT);
    this._msgT = setTimeout(() => (m.textContent = ""), 3000);
  }

  toJSON() {
    const params = {};
    for (const path of this.rows.keys()) params[path] = getPath(CONFIG, path);
    return {
      name: this.el.querySelector("#tuneName").value || "untitled",
      // Which car this tune was captured against — carProfiles.js reads this
      // to match a dropped-in file back to a car (see game/src/carProfiles.js).
      carId: this.carId,
      exported: new Date().toISOString(),
      params,
    };
  }

  applyTune(tune) {
    const applied = applyParamsToConfig(tune.params ?? tune);
    if (tune.name) this.el.querySelector("#tuneName").value = tune.name;
    this._syncAll();
    this._saveCurrent();
    return applied;
  }

  _export() {
    this.el.querySelector("#tuneJson").value = JSON.stringify(this.toJSON(), null, 2);
    this._msg("Exported to the text box.");
  }

  async _copy() {
    this._export();
    try {
      await navigator.clipboard.writeText(this.el.querySelector("#tuneJson").value);
      this._msg("Copied to clipboard.");
    } catch {
      this._msg("Clipboard blocked — select the text box and copy manually.");
    }
  }

  _download() {
    const tune = this.toJSON();
    const blob = new Blob([JSON.stringify(tune, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${tune.name.replace(/[^\w-]+/g, "-")}.tune.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  _applyPasted() {
    try {
      const tune = JSON.parse(this.el.querySelector("#tuneJson").value);
      const n = this.applyTune(tune);
      this._msg(n ? `Applied ${n} params.` : "No matching params found in that JSON.");
    } catch {
      this._msg("Invalid JSON.");
    }
  }

  _reset() {
    for (const [path, v] of Object.entries(this.defaults)) setPath(CONFIG, path, v);
    localStorage.removeItem(this._storeKey());
    this.el.querySelector("#tuneName").value = "";
    this._syncAll();
    this._msg("Reset to this car's default tune.");
  }

  _saveCurrent() {
    localStorage.setItem(this._storeKey(), JSON.stringify(this.toJSON()));
  }

  _loadSaved() {
    try {
      const saved = localStorage.getItem(this._storeKey());
      if (saved) this.applyTune(JSON.parse(saved));
    } catch { /* corrupted save — ignore */ }
  }
}
