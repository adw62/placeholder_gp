// =====================================================================
// carlib — the car-generation core shared by the CLI (tools/build-car.js)
// and Scene Forge (index.html: "🚗 From photo" / "🎨 Auto livery").
//
// One implementation of: silhouette tracing (photo → chains), the kit loft
// (chains → forge project), livery grab-handle wiring, and the JS livery
// painter. The painter follows the SAME pixel conventions as
// tools/paint-car.py (see its header) — side_*: 1024 wide, margin 32,
// side_right nose at LEFT; wrap: 768×1536, y = arc around the silhouette
// loop from top[0]. Keep the three in sync.
//
// Pure ES module: no three.js, no DOM assumptions except paintLivery's
// injected canvas factory (browser: () => document.createElement('canvas')).
// =====================================================================

export const SIDE_W = 1024, SIDE_MARGIN = 32;
export const WRAP_W = 768, WRAP_H = 1536;
export const PANEL_W = 512, PANEL_H = 512; // paintPanel canvas size — see below

// Same vocabulary loftKit already bakes into a generated face's own name
// (KINDNAME below, and stripName's "Floor"/"Nose"/"Tail") — matching against
// it is what lets a hand-sculpted panel (e.g. "Body · Hood 3", added by the
// user long after generation) still get recognized automatically, without
// needing the Right Side ring to reflect that detail at all.
const KIND_PATTERNS = [
  ["rearglass", /rear\s*glass/i],
  ["windshield", /windshield/i],
  ["roof", /roof/i],
  ["hood", /hood/i],
  ["deck", /deck/i],
  ["nose", /nose/i],
  ["tail", /tail/i],
  ["floor", /floor/i],
];

// Face name -> kind ("hood"/"windshield"/.../"floor"), or null if nothing in
// the name matches. Ignores trailing instance numbers ("Hood 3" -> "hood").
export function inferFaceKind(name) {
  for (const [kind, re] of KIND_PATTERNS) if (re.test(name)) return kind;
  return null;
}

// A face's explicit kind (user override, set via the Fill Face panel) always
// wins over whatever its name implies.
export function resolveFaceKind(face) {
  return face.kind ?? inferFaceKind(face.name);
}

// --- WHEEL baseline out of placeholders.js source text (not importable in
// Node or worth importing whole in the page — regex like build-car always did)
export function parseWheel(srcText) {
  const block = srcText.match(/export const WHEEL = \{([\s\S]*?)\}/)?.[1];
  const num = (k) => Number(block?.match(new RegExp(`${k}:\\s*(-?[\\d.]+)`))?.[1]);
  const w = { radius: num("radius"), localX: num("localX"), frontZ: num("frontZ"), rearZ: num("rearZ"), localY: num("localY") };
  if (Object.values(w).some((v) => !Number.isFinite(v))) throw new Error("couldn't parse WHEEL from placeholders.js");
  return w;
}

// ------------------------------------------------------------------ loft
// kit (schemas/carkit.schema.json) → forge project (flat fills; livery is a
// separate pass — wireLivery — so it also works on a hand-tweaked mesh).
export function loftKit(kit, wheel, carScale) {
  if (kit.format !== "carkit@1") throw new Error(`format must be "carkit@1", got "${kit.format}"`);
  if (!kit.id) throw new Error("missing id");
  if (!(kit.length > 0) || !(kit.width > 0)) throw new Error("need length + width in meters");
  const { top, bottom } = kit.sideProfile ?? {};
  const poly = (p, n, what) => {
    if (!Array.isArray(p) || p.length < n || !p.every((q) => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite)))
      throw new Error(`sideProfile.${what}: need ≥ ${n} [zFrac, yMeters] pairs`);
  };
  poly(top, 3, "top");
  poly(bottom, 2, "bottom");
  for (const [name, p] of [["top", top], ["bottom", bottom]])
    for (let i = 1; i < p.length; i++)
      if (p[i][0] <= p[i - 1][0]) throw new Error(`sideProfile.${name}: zFrac must increase nose→tail (index ${i})`);

  const SCALE = carScale;
  const groundY = wheel.localY - wheel.radius;
  const warnings = [];
  {
    const hubGame = wheel.radius * SCALE;
    const floorY = Math.min(...bottom.map(([, y]) => y));
    if (floorY < hubGame * 0.7)
      warnings.push(
        `sideProfile.bottom floor at ${floorY.toFixed(2)} m is below ~wheel-hub height ` +
        `(${hubGame.toFixed(2)} m) — wheels will be mostly hidden inside the body; ` +
        `raise the floor to ~${(hubGame * 0.9).toFixed(2)}–${(hubGame * 1.2).toFixed(2)} m unless you want a full-skirt look`
      );
  }

  // bottom chain is typically a sparse straight rocker: insert a vert under
  // each top station (linear y, silhouette unchanged) so the cap ladder and
  // planTaper have stations to hang onto mid-body
  const EPS_Z = 0.02;
  const botAug = bottom.map((p) => p.slice());
  for (const [zf] of top) {
    if (botAug.some(([z]) => Math.abs(z - zf) < EPS_Z)) continue;
    const i = botAug.findIndex(([z]) => z > zf);
    if (i <= 0) continue;
    const [z0, y0] = botAug[i - 1], [z1, y1] = botAug[i];
    botAug.splice(i, 0, [zf, y0 + ((y1 - y0) * (zf - z0)) / (z1 - z0)]);
  }

  // closed silhouette ring: top nose→tail, then bottom tail→nose
  const sil = [
    ...top.map(([zf, y], i) => ({ zf, y, part: "top", i })),
    ...botAug.map(([zf, y], i) => ({ zf, y, part: "bottom", i })).reverse(),
  ];
  const taperAt = (zf) => {
    const t = kit.planTaper;
    if (!Array.isArray(t) || t.length < 2) return 1;
    if (zf <= t[0][0]) return t[0][1];
    for (let i = 1; i < t.length; i++)
      if (zf <= t[i][0]) {
        const u = (zf - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
        return t[i - 1][1] + (t[i][1] - t[i - 1][1]) * u;
      }
    return t.at(-1)[1];
  };
  const toZ = (zf) => ((0.5 - zf) * kit.length) / SCALE; // zFrac 0 = nose = +Z
  const toY = (y) => y / SCALE + groundY;

  const verts = [];
  const ringR = [], ringL = [];
  for (const s of sil) {
    const hw = ((kit.width / 2) * taperAt(s.zf)) / SCALE;
    ringR.push(verts.push([hw, toY(s.y), toZ(s.zf)]) - 1);
  }
  for (const s of sil) {
    const hw = ((kit.width / 2) * taperAt(s.zf)) / SCALE;
    ringL.push(verts.push([-hw, toY(s.y), toZ(s.zf)]) - 1);
  }
  const centroid = [0, sil.reduce((a, s) => a + toY(s.y), 0) / sil.length, 0];

  // cap triangulation: even ladder between the two z-monotone chains (an ear
  // clip fans from one corner and, the caps being non-planar under planTaper,
  // its long tris cut through the body — visible dents)
  const silPts = sil.map((s) => ({ z: toZ(s.zf), y: toY(s.y) }));
  function ladderTris() {
    const nTop = top.length, nBot = botAug.length;
    const ti = (i) => i, bi = (j) => sil.length - 1 - j;
    const d2 = (a, b) => (silPts[a].z - silPts[b].z) ** 2 + (silPts[a].y - silPts[b].y) ** 2;
    const crossZY = ([a, b, c]) =>
      (silPts[b].z - silPts[a].z) * (silPts[c].y - silPts[a].y) -
      (silPts[b].y - silPts[a].y) * (silPts[c].z - silPts[a].z);
    const tris = [];
    let i = 0, j = 0;
    while (i < nTop - 1 || j < nBot - 1) {
      let stepTop;
      if (j >= nBot - 1) stepTop = true;
      else if (i >= nTop - 1) stepTop = false;
      else if (Math.abs(sil[ti(i + 1)].zf - sil[bi(j + 1)].zf) < 1e-9)
        stepTop = d2(ti(i + 1), bi(j)) <= d2(ti(i), bi(j + 1)); // paired rung: shorter diagonal
      else stepTop = sil[ti(i + 1)].zf < sil[bi(j + 1)].zf;
      const t = stepTop ? [ti(i), ti(i + 1), bi(j)] : [ti(i), bi(j + 1), bi(j)];
      stepTop ? i++ : j++;
      if (Math.abs(crossZY(t)) < 1e-12) continue;
      if (crossZY(t) < 0) [t[1], t[2]] = [t[2], t[1]];
      tris.push(t);
    }
    return tris;
  }
  const capTris = ladderTris();

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  function orientFace(face, outward) {
    let n = [0, 0, 0];
    for (const t of face.tris) {
      const [a, b, c] = t.map((i) => verts[i]);
      n = n.map((v, k) => v + cross3(sub(b, a), sub(c, a))[k]);
    }
    if (dot(n, outward) < 0) {
      face.tris = face.tris.map((t) => [t[0], t[2], t[1]]);
      face.ring = face.ring.slice().reverse();
    }
    return face;
  }

  const objName = "Body";
  const faces = [];
  const fills = {};
  const bodyColor = kit.bodyColor ?? "#b8bec8";
  const glassColor = kit.glassColor ?? "#1c222e";
  const fillFor = (base) =>
    /Windshield|Rear Glass/.test(base) ? glassColor : /Floor/.test(base) ? "#20242c" : bodyColor;
  function addFace(base, ring, tris, outward) {
    const name = `${objName} · ${base}`;
    faces.push(orientFace({ name, ring, tris }, outward));
    fills[name] = { type: "flat", color: fillFor(base) };
  }

  addFace("Right Side", ringR.slice(), capTris.map((t) => t.map((i) => ringR[i])), [1, 0, 0]);
  addFace("Left Side", ringL.slice(), capTris.map((t) => t.map((i) => ringL[i])), [-1, 0, 0]);

  const counts = {};
  const KINDNAME = { nose: "Nose", hood: "Hood", windshield: "Windshield", roof: "Roof", rearglass: "Rear Glass", deck: "Deck", tail: "Tail" };
  const topKinds = chainKinds(top, kit.length);
  for (let i = 0; i < sil.length; i++) {
    const j = (i + 1) % sil.length;
    const base = i < top.length - 1 ? KINDNAME[topKinds[i]] : stripName(sil[i], sil[j], kit.length);
    const n = (counts[base] = (counts[base] ?? 0) + 1);
    const ring = [ringR[i], ringR[j], ringL[j], ringL[i]];
    const tris = [[ring[0], ring[1], ring[2]], [ring[0], ring[2], ring[3]]];
    const midPt = ring.reduce((a, vi) => a.map((v, k) => v + verts[vi][k] / 4), [0, 0, 0]);
    addFace(counts[base] > 1 || base === "Floor" || /Roof|Hood|Deck/.test(base) ? `${base} ${n}` : base, ring, tris, sub(midPt, centroid));
  }

  const objects = [{ name: objName, kind: "profile", faces, rings: [ringR, ringL] }];

  let objCounter = 1;
  for (const box of kit.boxes ?? []) {
    objCounter++;
    const [w, h, l] = box.size.map((v) => v / SCALE / 2);
    const [px, py, pz] = [box.pos[0] / SCALE, toY(box.pos[1]), (box.pos[2] ?? 0) / SCALE];
    const corners = [];
    for (const sy of [-1, 1]) for (const sz of [-1, 1]) for (const sx of [-1, 1])
      corners.push(verts.push([px + sx * w, py + sy * h, pz + sz * l]) - 1);
    const [lbn, rbn, lbf, rbf, ltn, rtn, ltf, rtf] = corners;
    const bf = (base, ring, outward) => {
      const name = `${box.name} · ${base}`;
      const tris = [[ring[0], ring[1], ring[2]], [ring[0], ring[2], ring[3]]];
      const face = orientFace({ name, ring, tris }, outward);
      fills[name] = { type: "flat", color: kit.bodyColor ?? "#b8bec8" };
      return face;
    };
    objects.push({
      name: box.name, kind: "cube",
      faces: [
        bf("Right +X", [rbn, rbf, rtf, rtn], [1, 0, 0]),
        bf("Left −X", [lbn, lbf, ltf, ltn], [-1, 0, 0]),
        bf("Top +Y", [ltn, ltf, rtf, rtn], [0, 1, 0]),
        bf("Bottom −Y", [lbn, lbf, rbf, rbn], [0, -1, 0]),
        bf("Front +Z", [lbf, rbf, rtf, ltf], [0, 0, 1]),
        bf("Back −Z", [lbn, rbn, rtn, ltn], [0, 0, -1]),
      ],
    });
  }

  const project = {
    format: "forge-project@1",
    verts, objects, fills, photos: [], activePhoto: null,
    sym: { x: false, y: false, z: false },
    scale: [1, 1, 1], locked: [], sty: { size: 64, colors: 16, dither: false, ditherAmt: 0.6 },
    objCounter, selFace: null,
    carkit: kit, // carried by Scene Forge save/load so Auto livery can re-run with the kit's colors
  };
  return { project, warnings };
}

// same strip naming as always (build-car's stripName)
export function stripName(a, b, L) {
  if (a.part === "bottom" && b.part === "bottom") return "Floor";
  if (a.part !== b.part) return a.zf + b.zf < 1 ? "Nose" : "Tail";
  const dz = Math.abs(b.zf - a.zf) * L;
  const slope = dz < 1e-6 ? Infinity : Math.abs(b.y - a.y) / dz;
  const mid = (a.zf + b.zf) / 2;
  if (slope > 1.2) return mid < 0.5 ? "Nose" : "Tail";
  if (slope >= 0.35) return mid < 0.5 ? "Windshield" : "Rear Glass";
  return mid < 0.35 ? "Hood" : mid > 0.72 ? "Deck" : "Roof";
}

// Per-segment slope classification of the top chain, then chain-level
// sanitization: on a curvy traced profile the raw classifier hands out
// extra glass — a steep fender rise reads "windshield", a fastback tail
// kick reads a second "rearglass" — which paints double windows. A car has
// ONE cabin: the roof is the highest contiguous roof-ish run, the
// windshield/rear glass are the glass runs touching it, and every other
// glass-labeled segment is really hood/deck (or nose/tail if near-vertical).
export function chainKinds(top, L) {
  const slopeAt = (i) => {
    const [a, b] = [top[i], top[i + 1]];
    const dz = Math.abs(b[0] - a[0]) * L;
    return dz < 1e-6 ? Infinity : Math.abs(b[1] - a[1]) / dz;
  };
  const segKind = (a, b, i) => {
    const slope = slopeAt(i);
    const mid = (a[0] + b[0]) / 2;
    if (slope > 1.2) return mid < 0.5 ? "nose" : "tail";
    if (slope >= 0.35) return mid < 0.5 ? "windshield" : "rearglass";
    return mid < 0.35 ? "hood" : mid > 0.72 ? "deck" : "roof";
  };
  const steep = (i) => slopeAt(i) > 1.2;
  const kinds = top.slice(0, -1).map((a, i) => segKind(a, top[i + 1], i));
  // primary roof run = the contiguous 'roof' run with the highest mean y
  let best = null, cur = null;
  const midY = (i) => (top[i][1] + top[i + 1][1]) / 2;
  kinds.forEach((k, i) => {
    if (k === "roof") { if (!cur) cur = { a: i, b: i, y: 0 }; cur.b = i; }
    else if (cur) { cur.y = avg(cur); if (!best || cur.y > best.y) best = cur; cur = null; }
  });
  if (cur) { cur.y = avg(cur); if (!best || cur.y > best.y) best = cur; }
  function avg(r) { let s = 0; for (let i = r.a; i <= r.b; i++) s += midY(i); return s / (r.b - r.a + 1); }
  if (!best) {
    // No segment ever dipped under the glass-slope threshold at all — a
    // continuously curved/raked profile (aggressive fastback/coupe) can do
    // this. Previously this just trusted the raw per-segment labels, which
    // for a car shaped like that usually means the WHOLE cabin (hood
    // through deck) reads as one long windshield/rearglass run and never
    // gets body paint — every "top panel" comes out glass-dark. Anchor on
    // the single flattest segment instead, so the touching-glass
    // sanitization below still has a roof pivot to work from.
    let flat = 0;
    for (let i = 1; i < kinds.length; i++) if (slopeAt(i) < slopeAt(flat)) flat = i;
    kinds[flat] = "roof";
    best = { a: flat, b: flat, y: midY(flat) };
  }
  const isGlass = (k) => k === "windshield" || k === "rearglass";
  // glass runs touching the roof ARE the windshield / rear glass, whichever
  // side of mid-car the raw slope classifier thought they were on
  let w0 = best.a; while (w0 > 0 && isGlass(kinds[w0 - 1])) w0--;
  for (let i = w0; i < best.a; i++) kinds[i] = "windshield";
  let g1 = best.b; while (g1 < kinds.length - 1 && isGlass(kinds[g1 + 1])) g1++;
  for (let i = best.b + 1; i <= g1; i++) kinds[i] = "rearglass";
  for (let i = 0; i < w0; i++)
    if (isGlass(kinds[i]) || kinds[i] === "roof") kinds[i] = steep(i) ? "nose" : "hood";
  for (let i = g1 + 1; i < kinds.length; i++)
    if (isGlass(kinds[i]) || kinds[i] === "roof") kinds[i] = steep(i) ? "tail" : "deck";
  return kinds;
}

// ------------------------------------------------------------------ derive
// Current mesh → painter geometry. Works on a hand-tweaked hull: chains are
// reconstructed from the Right Side ring geometrically (split at the z
// extremes; the path with the higher mean y is the top chain), so Auto
// livery doesn't care what happened to the mesh since it was lofted.
export function deriveGeom(verts, bodyObj, wheel, carScale, kit) {
  const side = bodyObj.faces.find((f) => /Right Side/.test(f.name));
  if (!side) throw new Error("Body has no 'Right Side' face — not a lofted car object");
  const ring = side.ring;
  const P = (vi) => verts[vi];
  const zs = ring.map((vi) => P(vi)[2]);
  const zMax = Math.max(...zs), zMin = Math.min(...zs);
  const SCALE = carScale, groundY = wheel.localY - wheel.radius;
  const length = (zMax - zMin) * SCALE;
  const pick = (targetZ) => {
    const cands = ring.map((vi, k) => ({ vi, k })).filter(({ vi }) => Math.abs(P(vi)[2] - targetZ) < (zMax - zMin) * 0.03);
    cands.sort((a, b) => P(b.vi)[1] - P(a.vi)[1]);
    return cands[0].k; // ring position of the topmost vert at that end
  };
  const iN = pick(zMax), iT = pick(zMin);
  const n = ring.length;
  const fwd = [], bwd = [];
  for (let k = iN; ; k = (k + 1) % n) { fwd.push(k); if (k === iT) break; }
  for (let k = iN; ; k = (k - 1 + n) % n) { bwd.push(k); if (k === iT) break; }
  const meanY = (path) => path.reduce((a, k) => a + P(ring[k])[1], 0) / path.length;
  const topPath = meanY(fwd) >= meanY(bwd) ? fwd : bwd;
  const botPath = (topPath === fwd ? bwd : fwd).slice(1, -1); // interior = bottom chain, nose→tail order
  const toKit = (k) => {
    const v = P(ring[k]);
    return [(zMax - v[2]) / (zMax - zMin), (v[1] - groundY) * SCALE];
  };
  const mono = (pts) => { // guard against user-made z overhangs; painter interp needs monotonic zf
    let z = -1;
    return pts.map(([zf, y]) => { z = Math.max(z + 1e-4, zf); return [z, y]; });
  };
  const topChain = mono(topPath.map(toKit));
  const botChain = mono(botPath.map(toKit));
  const width = 2 * Math.max(...ring.map((vi) => Math.abs(P(vi)[0]))) * SCALE;
  const wheels = kit?.wheels ?? { frontZ: wheel.frontZ * SCALE, rearZ: wheel.rearZ * SCALE, x: wheel.localX * SCALE };
  return {
    top: topChain, bottom: botChain, length, width, wheels,
    silRing: ring, topPath, botPath, // ring positions, for wiring
  };
}

// ------------------------------------------------------------------ wiring
// Photo-grab handles for every Body face against the CURRENT mesh: side caps
// map each ring vert through the side-photo linear map; every other face
// (strips, closing edges) maps its verts to the wrap by arc position along
// the current silhouette. slot: 0 side_right, 1 side_left, 2 wrap.
export function wireLivery(verts, bodyObj, geom, wheel, carScale) {
  const SCALE = carScale, groundY = wheel.localY - wheel.radius;
  const L = geom.length;
  const allY = [...geom.top, ...geom.bottom].map(([, y]) => y);
  const kitMaxY = Math.max(...allY);
  const sideScale = (SIDE_W - 2 * SIDE_MARGIN) / L;
  // exterior view of the +X flank has the nose on the screen LEFT (game
  // frame: +Z nose, Y up, right-handed) — same convention as the painter
  const sideXR = (zf) => SIDE_MARGIN + zf * L * sideScale;
  const sideXL = (zf) => SIDE_W - (SIDE_MARGIN + zf * L * sideScale);
  const sideY = (y) => SIDE_MARGIN + (kitMaxY - y) * sideScale;
  const zMaxG = Math.max(...bodyObj.faces.flatMap((f) => f.ring.map((vi) => verts[vi][2])));
  const kitOf = (vi) => {
    const v = verts[vi];
    return { zf: (zMaxG - v[2]) / (L / SCALE), y: (v[1] - groundY) * SCALE };
  };
  // arc along the silhouette loop from top[0] (nose-top), in sil order
  const loop = [...geom.topPath, ...geom.botPath.slice().reverse()]; // ring positions: top nose→tail, bottom tail→nose
  const ring = geom.silRing;
  const arcOf = new Map(); // vert index (right ring) → cumulative arc, kit meters
  let s = 0;
  for (let k = 0; k < loop.length; k++) {
    arcOf.set(ring[loop[k]], s);
    const a = kitOf(ring[loop[k]]), b = kitOf(ring[loop[(k + 1) % loop.length]]);
    s += Math.hypot((b.zf - a.zf) * L, b.y - a.y);
  }
  const total = s;
  // mirror ring (left side) verts get the same arc as their right partners
  const left = bodyObj.faces.find((f) => /Left Side/.test(f.name));
  if (left) {
    const byPos = new Map(); // "y,z" quantized → arc
    for (const [vi, sv] of arcOf) byPos.set(verts[vi][1].toFixed(4) + "," + verts[vi][2].toFixed(4), sv);
    for (const vi of left.ring) {
      const key = verts[vi][1].toFixed(4) + "," + verts[vi][2].toFixed(4);
      if (byPos.has(key)) arcOf.set(vi, byPos.get(key));
    }
  }
  const wrapY = (sv) => (sv / total) * (WRAP_H - 1);
  // Group same-kind faces that share a ring edge — e.g. a hand-split
  // "Hood 1" + "Hood 3" — so they paint as ONE contiguous panel instead of
  // each getting its own independent full copy of the shared kind canvas
  // (which duplicated the roundel/text on every piece). Hand-sculpted faces
  // are authored independently (unwelded), so their seam vertices are only
  // APPROXIMATELY coincident, not equal ids or even equal positions — match
  // by proximity (within a tolerance scaled to the car's own size) instead.
  // A single shared corner alone isn't enough evidence two faces are really
  // one physical panel, hence the >=2 threshold (an actual edge).
  const kindFaces = bodyObj.faces.filter((f) => !/Right Side|Left Side/.test(f.name) && resolveFaceKind(f));
  const parent = kindFaces.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  if (kindFaces.length > 1) {
    const kfPts = kindFaces.flatMap((f) => f.ring.map((vi) => verts[vi]));
    const dim = (a) => Math.max(...kfPts.map((v) => v[a])) - Math.min(...kfPts.map((v) => v[a]));
    const eps = 0.035 * Math.max(dim(0), dim(1), dim(2));
    for (let i = 0; i < kindFaces.length; i++) {
      for (let j = i + 1; j < kindFaces.length; j++) {
        if (resolveFaceKind(kindFaces[i]) !== resolveFaceKind(kindFaces[j])) continue;
        const usedB = new Set();
        let shared = 0;
        for (const vi of kindFaces[i].ring) {
          const va = verts[vi];
          let best = -1, bestD = Infinity;
          kindFaces[j].ring.forEach((vj, bj) => {
            if (usedB.has(bj)) return;
            const vb = verts[vj];
            const d = Math.hypot(va[0] - vb[0], va[1] - vb[1], va[2] - vb[2]);
            if (d < bestD) { bestD = d; best = bj; }
          });
          if (best >= 0 && bestD <= eps) { shared++; usedB.add(best); }
        }
        if (shared >= 2) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
      }
    }
  }
  const groups = new Map(); // root idx -> face idxs[]
  kindFaces.forEach((_, i) => { const r = find(i); (groups.get(r) ?? groups.set(r, []).get(r)).push(i); });
  const groupAxes = new Map(); // face name -> {u:{a,min,max,range}, v:{...}}, shared across the whole group
  for (const idxs of groups.values()) {
    const faces = idxs.map((i) => kindFaces[i]);
    const allVerts = faces.flatMap((f) => f.ring);
    const [u, v] = [0, 1, 2].map((a) => {
      const vals = allVerts.map((vi) => verts[vi][a]);
      return { a, min: Math.min(...vals), max: Math.max(...vals), range: Math.max(...vals) - Math.min(...vals) };
    }).sort((x, y) => y.range - x.range);
    for (const f of faces) groupAxes.set(f.name, { u, v });
  }
  const wires = {};
  for (const f of bodyObj.faces) {
    if (/Right Side/.test(f.name)) {
      wires[f.name] = { slot: 0, big: true, src: f.ring.map((vi) => { const k = kitOf(vi); return [sideXR(k.zf), sideY(k.y)]; }) };
    } else if (/Left Side/.test(f.name)) {
      wires[f.name] = { slot: 1, big: true, src: f.ring.map((vi) => { const k = kitOf(vi); return [sideXL(k.zf), sideY(k.y)]; }) };
    } else {
      // Named/tagged panel (see resolveFaceKind): wire it to its OWN
      // dedicated panel canvas (paintPanel) instead of the shared wrap
      // strip below, so a hand-sculpted panel with no real relation to the
      // Right Side ring still wires correctly. src corners come from each
      // ring vertex's own (x,y,z) position, projected onto whichever TWO
      // axes vary most across the face's GROUP (see groupAxes above — a
      // single ungrouped face is its own group of one, so this reduces to
      // the same "this face's own bbox" mapping as before). Linear (not
      // binary corner) interpolation so faces sharing a group map to
      // CONTIGUOUS regions of the canvas instead of each repeating the
      // whole thing — for a lone 4-corner face only the extremes exist, so
      // it's still exactly the old binary behavior. Not always perfectly
      // oriented on an unusual shape — the existing per-face Rotate/Flip
      // controls fix that by hand.
      const kind = resolveFaceKind(f);
      if (kind) {
        const { u, v } = groupAxes.get(f.name);
        const src = f.ring.map((vi) => {
          const uv = verts[vi][u.a], vv = verts[vi][v.a];
          const x = u.range > 0 ? (PANEL_W * (u.max - uv)) / u.range : PANEL_W / 2;
          const y = v.range > 0 ? (PANEL_H * (v.max - vv)) / v.range : PANEL_H / 2;
          return [x, y];
        });
        wires[f.name] = { slot: 3, big: false, kind, src };
        continue;
      }
      const arcs = f.ring.map((vi) => arcOf.get(vi));
      if (arcs.some((a) => a === undefined)) continue; // face not on the loft ring (user-added, unnamed) — leave its fill alone
      // the closing nose edge spans arc≈total back to 0: keep it at the
      // image bottom instead of wrapping (the painter's "+1 form")
      const hasEnd = arcs.some((a) => a > total * 0.5);
      const src = f.ring.map((vi, i) => {
        let a = arcs[i];
        if (hasEnd && a < total * 0.25) a = total;
        return [verts[vi][0] >= 0 ? 0 : WRAP_W - 1, wrapY(a)];
      });
      wires[f.name] = { slot: 2, big: false, src };
    }
  }
  return wires;
}

// ------------------------------------------------------------------ painter
// JS port of tools/paint-car.py — SAME conventions, same layout logic.
// mkCanvas: () => HTMLCanvasElement (or node-canvas equivalent).
// kindRanges (optional): { windshield?, roof?, rearglass?: {z0,z1} } in kit-
// space zf (0..1) — the REAL z-extent of actual kind-classified panel faces
// (see carAutoLivery in forge/index.html), used in place of chainKinds'
// Right-Side-ring-only guess for the side-view cabin glass shape whenever
// it's available. Omit for the old behavior (still used as a fallback below
// when no such faces exist).
export function paintLivery(geom, lv, mkCanvas, kindRanges) {
  const { top, bottom, length: L, width, wheels } = geom;
  const font = (px) => `bold ${Math.round(px)}px "DejaVu Sans Condensed", "Liberation Sans Narrow", "Arial Narrow", sans-serif`;
  // Piecewise-linear height at a given zf, over ANY sorted [zf,y] chain.
  const curveY = (chain, zf) => {
    if (zf <= chain[0][0]) return chain[0][1];
    for (let k = 1; k < chain.length; k++)
      if (zf <= chain[k][0]) {
        const [a, b] = [chain[k - 1], chain[k]];
        return a[1] + ((b[1] - a[1]) * (zf - a[0])) / (b[0] - a[0]);
      }
    return chain.at(-1)[1];
  };
  const topY = (zf) => curveY(top, zf);
  // Real height profile from the actual kind-classified panel faces' own
  // vertices (see kindRanges.topProfile, built by carAutoLivery), when
  // available — the Right Side ring alone (what `top` is built from) can be
  // a plain box with zero height variation on a hand-sculpted car whose
  // real hood/roof/deck shape lives in separately-added faces; falls back
  // to the ordinary topY when there's nothing better.
  const topYReal = kindRanges?.topProfile?.length ? (zf) => curveY(kindRanges.topProfile, zf) : topY;
  const topKinds = chainKinds(top, L); // sanitized: one cabin, no stray glass
  const mulberry = (seed) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const grain = (ctx, w, h, amt, seed) => {
    const rnd = mulberry(seed);
    const im = ctx.getImageData(0, 0, w, h), p = im.data;
    for (let i = 0; i < p.length; i += 4) {
      const d = Math.floor(rnd() * (2 * amt + 1)) - amt;
      p[i] = Math.max(0, Math.min(255, p[i] + d));
      p[i + 1] = Math.max(0, Math.min(255, p[i + 1] + d));
      p[i + 2] = Math.max(0, Math.min(255, p[i + 2] + d));
    }
    ctx.putImageData(im, 0, 0);
  };
  const shade = (hex, f) => {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  };
  const body = lv.bodyColor ?? "#dfe3ea", stripe = lv.stripeColor ?? "#b02030",
    accent = lv.accent ?? "#1a2a6e", glass = lv.windowColor ?? "#141a24";
  const num = String(lv.number ?? 1), team = lv.team ?? "PLACEHOLDER GP";
  const sponsors = lv.sponsors ?? ["TIRE CO.", "HUBWORKS", "PACER BRAKES"];

  const centered = (ctx, x, y, text, f, fill) => {
    ctx.font = f; ctx.fillStyle = fill; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
  };
  const tile = (ctx, x, y, text, f, fill, sx, rot) => {
    ctx.save(); ctx.translate(x, y);
    if (rot) ctx.rotate(Math.PI);
    ctx.scale(sx, 1);
    centered(ctx, 0, 0, text, f, fill);
    ctx.restore();
  };

  // ---- side views
  const paintSide = (mirrored) => {
    // Widen the canvas bounds to cover the REAL panel height data too (see
    // topYReal above) — the Right Side ring alone can be shorter than what
    // was actually sculpted, which would otherwise clip/push the window
    // off-canvas even after the sill/roofline math itself is fixed.
    const ys = [...top, ...bottom, ...(kindRanges?.topProfile ?? [])].map(([, y]) => y);
    const maxY = Math.max(...ys), minY = Math.min(...ys);
    const scale = (SIDE_W - 2 * SIDE_MARGIN) / L;
    const H = Math.ceil(2 * SIDE_MARGIN + (maxY - minY) * scale);
    const cv = mkCanvas(); cv.width = SIDE_W; cv.height = H;
    const d = cv.getContext("2d");
    const X = (zf) => { const x = SIDE_MARGIN + zf * L * scale; return mirrored ? SIDE_W - x : x; }; // nose LEFT on side_right
    const Y = (y) => SIDE_MARGIN + (maxY - y) * scale;
    d.fillStyle = body; d.fillRect(0, 0, SIDE_W, H);

    const floorY = Math.min(...bottom.map(([, y]) => y));
    const seg = top.slice(0, -1).map((a, k) => [a, top[k + 1], topKinds[k]]);
    const cab = seg.filter((s) => ["windshield", "roof", "rearglass"].includes(s[2]));
    const roof = seg.filter((s) => s[2] === "roof");
    // Prefer the real kind-classified faces' own z-extent over chainKinds'
    // silhouette guess (see kindRanges above) — falls back to the old
    // cab/roof-derived values when no such faces exist.
    const glassRange = kindRanges?.windshield || kindRanges?.rearglass
      ? {
          z0: kindRanges.windshield?.z0 ?? kindRanges.roof?.z0 ?? 0.3,
          z1: kindRanges.rearglass?.z1 ?? kindRanges.roof?.z1 ?? 0.7,
          zr0: kindRanges.roof?.z0, zr1: kindRanges.roof?.z1,
          // base of the glass, straight from the real panels' own lowest
          // vertex — more direct/robust than interpolating a curve through
          // z0/z1, which can land somewhere unrelated to the glass itself
          // if the roof/hood/deck vertices sort in between.
          yMin: kindRanges.windshield?.yMin !== undefined && kindRanges.rearglass?.yMin !== undefined
            ? Math.max(kindRanges.windshield.yMin, kindRanges.rearglass.yMin)
            : kindRanges.windshield?.yMin ?? kindRanges.rearglass?.yMin,
        }
      : cab.length
      ? { z0: cab[0][0][0], z1: cab.at(-1)[1][0], zr0: roof.length ? roof[0][0][0] : undefined, zr1: roof.length ? roof.at(-1)[1][0] : undefined }
      : null;
    const beltY = (glassRange ? (glassRange.yMin ?? topYReal(glassRange.z0)) : topY(0.35)) + 0.01;

    // split livery: high at the tail, monotonically down toward the nose
    const span = beltY - floorY;
    const ctrl = [[0, floorY + span * 0.30], [0.35, floorY + span * 0.38], [0.7, floorY + span * 0.48], [1, floorY + span * 0.62]];
    const splitY = (zf) => {
      if (zf <= ctrl[0][0]) return ctrl[0][1];
      for (let k = 1; k < ctrl.length; k++)
        if (zf <= ctrl[k][0]) {
          const [a, b] = [ctrl[k - 1], ctrl[k]];
          return a[1] + ((b[1] - a[1]) * (zf - a[0])) / (b[0] - a[0]);
        }
      return ctrl.at(-1)[1];
    };
    const steps = 48;
    const path = [];
    for (let k = 0; k <= steps; k++) path.push([X(k / steps), Y(splitY(k / steps))]);
    d.fillStyle = stripe; d.beginPath();
    d.moveTo(...path[0]); for (const p of path.slice(1)) d.lineTo(...p);
    d.lineTo(X(1), H); d.lineTo(X(0), H); d.closePath(); d.fill();
    d.fillStyle = shade(stripe, 0.55); d.fillRect(0, Y(floorY + 0.045), SIDE_W, H);
    d.strokeStyle = accent; d.lineWidth = Math.max(3, 0.02 * scale); d.lineJoin = "round";
    d.beginPath(); d.moveTo(...path[0]); for (const p of path.slice(1)) d.lineTo(...p); d.stroke();

    // cabin glass trapezoid under the roof span, raked pillars, B-pillar
    if (glassRange) {
      const { z0, z1 } = glassRange;
      const [zr0, zr1] = glassRange.zr0 !== undefined ? [glassRange.zr0, glassRange.zr1] : [z0 + 0.3 * (z1 - z0), z1 - 0.3 * (z1 - z0)];
      // sill = the HIGHER of the two glass bases — side windows must not
      // reach below the bottom of the windshield or the rear window
      const sill = (glassRange.yMin ?? Math.max(topYReal(z0), topYReal(z1))) + 0.01;
      const fr = zr0 - 0.6 * (zr0 - z0), rr = zr1 + 0.6 * (z1 - zr1);
      d.fillStyle = glass; d.beginPath(); d.moveTo(X(fr), Y(sill));
      for (let k = 0; k <= 10; k++) {
        const zf = zr0 + ((zr1 - zr0) * k) / 10;
        d.lineTo(X(zf), Y(topYReal(zf) - 0.04));
      }
      d.lineTo(X(rr), Y(sill)); d.closePath(); d.fill();
      const zb = fr + 0.45 * (rr - fr);
      d.fillStyle = body;
      d.fillRect(Math.min(X(zb - 0.012), X(zb + 0.012)), Y(topYReal(zb) - 0.03),
        Math.abs(X(zb + 0.012) - X(zb - 0.012)), Y(sill) - Y(topYReal(zb) - 0.03));
    }

    // wheel arches
    const archR = 0.19 * scale;
    const zfF = 0.5 - wheels.frontZ / L, zfR = 0.5 - wheels.rearZ / L;
    d.fillStyle = "rgb(16,18,22)";
    for (const zf of [zfF, zfR]) {
      d.beginPath(); d.arc(X(zf), Y(floorY), archR, 0, Math.PI * 2); d.fill();
    }

    // roundel + numbers
    const cx = X((zfF + zfR) / 2);
    const cy = (Y(beltY) + Y(floorY + 0.05)) / 2;
    const r = Math.min(46, (Y(floorY) - Y(beltY)) * 0.46);
    d.fillStyle = "rgb(245,245,242)"; d.strokeStyle = accent; d.lineWidth = 4;
    d.beginPath(); d.arc(cx, cy, r, 0, Math.PI * 2); d.fill(); d.stroke();
    centered(d, cx, cy, num, font(r * 1.3), "rgb(18,18,22)");
    centered(d, X(0.05), Y(beltY - 0.055), num, font(17), "rgb(20,20,24)");

    // sponsors: zone-based, auto-fit
    const highCy = (Y(beltY) + Y(splitY(0.5))) / 2;
    const mid = (zfF + zfR) / 2;
    const rZf = (r / scale + 0.04) / L;
    const archZf = (archR / scale + 0.03) / L;
    const fit = (text, zonePx, start) => {
      let f = start;
      while (f > 12) {
        d.font = font(f);
        if (d.measureText(text).width <= zonePx * 0.9) break;
        f -= 1;
      }
      return font(f);
    };
    const zones = [
      [0.08, mid - rZf, highCy, 24, stripe],
      [mid + rZf, 0.97, highCy, 22, stripe],
      [zfF + archZf, zfR - archZf, Y(floorY + 0.012), 14, "rgb(235,235,235)"],
    ];
    zones.forEach(([za, zb2, ty, fs, col], i) => {
      if (!sponsors[i]) return;
      const wPx = (zb2 - za) * L * scale;
      centered(d, X((za + zb2) / 2), ty, sponsors[i], fit(sponsors[i], wPx, fs), col);
    });

    // panel seams
    if (glassRange) {
      const { z0, z1 } = glassRange;
      d.strokeStyle = shade(body, 0.8); d.lineWidth = 1;
      for (const zf of [z0, (z0 + z1) / 2 - 0.17, z1 + 0.02]) {
        d.beginPath(); d.moveTo(X(zf), Y(beltY - 0.01)); d.lineTo(X(zf), Y(floorY + 0.05)); d.stroke();
      }
    }
    grain(d, SIDE_W, H, 7, mirrored ? 7 : 11);
    return cv;
  };

  // ---- wrap
  const paintWrap = () => {
    const sil = [...top, ...bottom.slice().reverse()];
    const n = sil.length;
    const S = [0];
    for (let k = 0; k < n; k++) {
      const a = sil[k], b = sil[(k + 1) % n];
      S.push(S[k] + Math.hypot((b[0] - a[0]) * L, b[1] - a[1]));
    }
    const total = S[n];
    const Yarc = (s) => (s / total) * (WRAP_H - 1);
    const cv = mkCanvas(); cv.width = WRAP_W; cv.height = WRAP_H;
    const d = cv.getContext("2d");
    d.fillStyle = body; d.fillRect(0, 0, WRAP_W, WRAP_H);

    const kinds = [];
    for (let k = 0; k < n; k++) {
      let kind;
      if (k < top.length - 1) kind = topKinds[k];
      else if (k === top.length - 1) kind = "tail";
      else if (k === n - 1) kind = "nose";
      else kind = "floor";
      kinds.push([kind, Yarc(S[k]), Yarc(S[k + 1])]);
    }
    // contiguous same-kind bands merge FIRST: glass fills+trim per merged run
    // (per-band trim draws a divider mid-window), decals once per panel
    const merged = [];
    for (const [kind, y0, y1] of kinds) {
      if (merged.length && merged.at(-1)[0] === kind) merged.at(-1)[2] = y1;
      else merged.push([kind, y0, y1]);
    }
    for (const [kind, y0, y1] of merged) {
      if (kind === "floor") { d.fillStyle = "rgb(31,36,44)"; d.fillRect(0, y0, WRAP_W, y1 - y0); }
      else if (kind === "windshield" || kind === "rearglass") {
        d.fillStyle = glass; d.fillRect(0, y0, WRAP_W, y1 - y0);
        d.fillStyle = shade(body, 0.6); d.fillRect(0, y0, WRAP_W, 4); d.fillRect(0, y1 - 4, WRAP_W, 4);
      }
    }
    const sw = WRAP_W * 0.09;
    for (const [kind, y0, y1] of kinds)
      if (["hood", "roof", "deck", "nose", "tail"].includes(kind))
        for (const cx of [WRAP_W / 2 - sw * 0.75, WRAP_W / 2 + sw * 0.75]) {
          d.fillStyle = stripe; d.fillRect(cx - sw / 2, y0, sw, y1 - y0);
        }

    const pxmX = (WRAP_W - 1) / width, pxmY = (WRAP_H - 1) / total;
    const sx = pxmX / pxmY;
    const wtext = (x, y, text, hM, fill, rot = false) =>
      tile(d, x, y, text, font(Math.max(10, hM * pxmY)), fill, sx, rot);
    const roundel = (cx, cy, rM) => {
      d.fillStyle = "rgb(245,245,242)"; d.strokeStyle = accent; d.lineWidth = 4;
      d.beginPath(); d.ellipse(cx, cy, rM * pxmX, rM * pxmY, 0, 0, Math.PI * 2); d.fill(); d.stroke();
    };
    for (const [kind, y0, y1] of merged) {
      let cy = (y0 + y1) / 2;
      const bandM = (y1 - y0) / pxmY;
      if (kind === "roof") {
        const rM = Math.min(0.15, bandM * 0.28, width * 0.30);
        if (sponsors[1] && bandM > 0.55) { wtext(WRAP_W / 2, cy - (rM + 0.10) * pxmY, sponsors[1], 0.085, accent); cy += 0.05 * pxmY; }
        roundel(WRAP_W / 2, cy, rM);
        wtext(WRAP_W / 2, cy, num, rM * 1.25, "rgb(18,18,22)");
      } else if (kind === "windshield" && bandM > 0.22) {
        d.fillStyle = "rgb(245,245,242)"; d.fillRect(0, y1 - 0.085 * pxmY, WRAP_W, 0.065 * pxmY);
        wtext(WRAP_W / 2, y1 - 0.052 * pxmY, team, 0.045, accent, true);
      } else if (kind === "hood" && bandM > 0.22) {
        wtext(WRAP_W / 2, y0 + (y1 - y0) * 0.22, team, 0.06, accent, true);
        const rM = Math.min(0.13, bandM * 0.24, width * 0.26);
        const hy = y0 + (y1 - y0) * 0.62;
        roundel(WRAP_W / 2, hy, rM);
        wtext(WRAP_W / 2, hy, num, rM * 1.25, "rgb(18,18,22)", true); // reads from the nose
      } else if (kind === "nose" && y1 - y0 > 24) {
        d.fillStyle = body; d.fillRect(0, y0, WRAP_W, y1 - y0);
        d.fillStyle = stripe; d.fillRect(0, y1 - (y1 - y0) * 0.28, WRAP_W, (y1 - y0) * 0.28);
        if (y1 < WRAP_H - 2) { // headlights on the fascia only — the closing
          // band at the image bottom is the under-nose: plain bumper
          d.fillStyle = "rgb(238,234,205)";
          for (const cx of [WRAP_W * 0.18, WRAP_W * 0.82]) d.fillRect(cx - 55, cy - 14, 110, 24);
          d.fillStyle = "rgb(20,22,26)"; d.fillRect(WRAP_W * 0.38, cy - 12, WRAP_W * 0.24, 22);
        }
      } else if (kind === "tail" && y1 - y0 > 24) {
        d.fillStyle = body; d.fillRect(0, y0, WRAP_W, y1 - y0);
        d.fillStyle = "rgb(25,28,34)"; d.fillRect(0, y1 - (y1 - y0) * 0.22, WRAP_W, (y1 - y0) * 0.22);
        d.fillStyle = "rgb(190,30,35)";
        for (const cx of [WRAP_W * 0.2, WRAP_W * 0.8]) d.fillRect(cx - 70, cy - 11, 140, 22);
        wtext(WRAP_W / 2, cy, lv.badge ?? "PGP", 0.06, accent);
        wtext(WRAP_W * 0.3, cy, num, 0.07, "rgb(20,20,24)");
      }
    }
    grain(d, WRAP_W, WRAP_H, 7, 5);
    return cv;
  };

  return { side_right: paintSide(false), side_left: paintSide(true), wrap: paintWrap() };
}

// ------------------------------------------------------------------ panel
// Paints one small, self-contained canvas for a single kind ("hood",
// "windshield", "roof", "rearglass", "deck", "nose", "tail", "floor") — used
// by wireLivery's per-face routing (see resolveFaceKind) so a hand-sculpted
// panel gets its OWN dedicated, correctly-labeled texture instead of being
// sliced from the shared wrap/side canvases above, which only ever reflect
// the Right Side ring's own silhouette and are blind to detail added
// elsewhere on the body. Same visual language as paintWrap's per-kind
// decals (roundel/stripe/team/sponsor/badge), just centered in its own box
// instead of placed at an arc position on a shared strip. Deliberately
// self-contained (small local copies of font/shade/grain/centered) rather
// than sharing paintLivery's closure — this needs to be callable on its own.
export function paintPanel(kind, lv, mkCanvas, w = PANEL_W, h = PANEL_H) {
  const font = (px) => `bold ${Math.round(px)}px "DejaVu Sans Condensed", "Liberation Sans Narrow", "Arial Narrow", sans-serif`;
  const shade = (hex, f) => {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  };
  const mulberry = (seed) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const grain = (ctx, gw, gh, amt, seed) => {
    const rnd = mulberry(seed);
    const im = ctx.getImageData(0, 0, gw, gh), p = im.data;
    for (let i = 0; i < p.length; i += 4) {
      const dd = Math.floor(rnd() * (2 * amt + 1)) - amt;
      p[i] = Math.max(0, Math.min(255, p[i] + dd));
      p[i + 1] = Math.max(0, Math.min(255, p[i + 1] + dd));
      p[i + 2] = Math.max(0, Math.min(255, p[i + 2] + dd));
    }
    ctx.putImageData(im, 0, 0);
  };
  const centered = (ctx, x, y, text, f, fill) => {
    ctx.font = f; ctx.fillStyle = fill; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
  };

  const body = lv.bodyColor ?? "#dfe3ea", stripe = lv.stripeColor ?? "#b02030",
    accent = lv.accent ?? "#1a2a6e", glass = lv.windowColor ?? "#141a24";
  const num = String(lv.number ?? 1), team = lv.team ?? "PLACEHOLDER GP";
  const sponsors = lv.sponsors ?? ["TIRE CO.", "HUBWORKS", "PACER BRAKES"];

  const cv = mkCanvas(); cv.width = w; cv.height = h;
  const d = cv.getContext("2d");

  if (kind === "floor") {
    d.fillStyle = "rgb(31,36,44)"; d.fillRect(0, 0, w, h); // underside, never actually seen
    return cv;
  }
  if (kind === "windshield" || kind === "rearglass") {
    d.fillStyle = glass; d.fillRect(0, 0, w, h);
    d.fillStyle = shade(body, 0.6); d.fillRect(0, 0, w, 4); d.fillRect(0, h - 4, w, 4);
    if (kind === "windshield") {
      d.fillStyle = "rgb(245,245,242)"; d.fillRect(0, h * 0.8, w, h * 0.12);
      centered(d, w / 2, h * 0.86, team, font(Math.max(10, h * 0.06)), accent);
    }
    grain(d, w, h, 7, kind === "windshield" ? 3 : 4);
    return cv;
  }

  d.fillStyle = body; d.fillRect(0, 0, w, h);
  if (["hood", "roof", "deck", "nose", "tail"].includes(kind)) {
    const sw = w * 0.16;
    d.fillStyle = stripe;
    for (const cx of [w / 2 - sw * 0.75, w / 2 + sw * 0.75]) d.fillRect(cx - sw / 2, 0, sw, h);
  }
  if (kind === "roof") {
    const r = Math.min(w, h) * 0.26;
    if (sponsors[1]) centered(d, w / 2, h * 0.2, sponsors[1], font(Math.max(10, h * 0.07)), accent);
    d.fillStyle = "rgb(245,245,242)"; d.strokeStyle = accent; d.lineWidth = 4;
    d.beginPath(); d.arc(w / 2, h * 0.55, r, 0, Math.PI * 2); d.fill(); d.stroke();
    centered(d, w / 2, h * 0.55, num, font(r * 1.25), "rgb(18,18,22)");
  } else if (kind === "hood") {
    centered(d, w / 2, h * 0.22, team, font(Math.max(10, h * 0.055)), accent);
    const r = Math.min(w, h) * 0.24;
    d.fillStyle = "rgb(245,245,242)"; d.strokeStyle = accent; d.lineWidth = 4;
    d.beginPath(); d.arc(w / 2, h * 0.62, r, 0, Math.PI * 2); d.fill(); d.stroke();
    centered(d, w / 2, h * 0.62, num, font(r * 1.25), "rgb(18,18,22)");
  } else if (kind === "nose") {
    d.fillStyle = stripe; d.fillRect(0, h * 0.72, w, h * 0.28);
    d.fillStyle = "rgb(238,234,205)";
    for (const cx of [w * 0.18, w * 0.82]) d.fillRect(cx - w * 0.07, h * 0.42, w * 0.14, h * 0.14);
    d.fillStyle = "rgb(20,22,26)"; d.fillRect(w * 0.38, h * 0.44, w * 0.24, h * 0.12);
  } else if (kind === "tail") {
    d.fillStyle = "rgb(25,28,34)"; d.fillRect(0, h * 0.78, w, h * 0.22);
    d.fillStyle = "rgb(190,30,35)";
    for (const cx of [w * 0.2, w * 0.8]) d.fillRect(cx - w * 0.09, h * 0.44, w * 0.18, h * 0.12);
    centered(d, w / 2, h * 0.6, lv.badge ?? "PGP", font(Math.max(10, h * 0.06)), accent);
    centered(d, w * 0.3, h * 0.6, num, font(Math.max(10, h * 0.07)), "rgb(20,20,24)");
  }
  grain(d, w, h, 7, kind.length);
  return cv;
}

// ------------------------------------------------------------------ tracer
// Studio-style side photo → silhouette chains + wheels + colors.
// Background = median border color; car = pixels far from it. Ground comes
// from the dark run under the wheel arches (tight threshold so the soft
// contact shadow doesn't pull it down).
export function tracePhoto(canvas, { facing = "left" } = {}) {
  const W = canvas.width, H = canvas.height;
  const d = canvas.getContext("2d").getImageData(0, 0, W, H).data;
  const at = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  // The car = pixels near the DOMINANT SATURATED HUE of the frame's center
  // (studio backdrops/floors are near-grey, paint is not). A plain
  // background-distance mask fails here: gradient backdrops make the lit
  // floor read as foreground. Grey/white cars won't trace — pick a photo
  // where the paint carries color.
  const hsv = (c) => {
    const [r, g, b] = c.map((v) => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn;
    let h = 0;
    if (df > 0)
      h = mx === r ? ((g - b) / df + 6) % 6 : mx === g ? (b - r) / df + 2 : (r - g) / df + 4;
    return [h / 6, mx === 0 ? 0 : df / mx, mx];
  };
  const hist = new Array(36).fill(0);
  for (let y = Math.floor(H * 0.15); y < H * 0.85; y += 2)
    for (let x = Math.floor(W * 0.15); x < W * 0.85; x += 2) {
      const [h, s, v] = hsv(at(x, y));
      if (s > 0.3 && v > 0.06) hist[Math.floor(h * 36) % 36]++;
    }
  const domBin = hist.indexOf(Math.max(...hist));
  if (hist[domBin] < 500) throw new Error("no dominant paint color found — tracer needs a colorful car on a neutral backdrop");
  const domHue = (domBin + 0.5) / 36;
  const isCar = (x, y) => {
    const [h, s, v] = hsv(at(x, y));
    if (s < 0.22 || v < 0.05) return false;
    const dh = Math.abs(h - domHue);
    return Math.min(dh, 1 - dh) < 0.09;
  };
  const top = {}, bot = {};
  for (let x = 0; x < W; x++) {
    let t = -1, b = -1, run = 0;
    for (let y = 0; y < H; y++) {
      if (isCar(x, y)) { run++; if (run > 3 && t < 0) t = y - 3; }
      else run = 0;
    }
    for (let y = H - 1; y >= 0; y--) if (isCar(x, y)) { b = y; break; }
    if (t >= 0 && b > t + H * 0.05) { top[x] = t; bot[x] = b; }
  }
  const xs = Object.keys(top).map(Number).sort((a, b) => a - b);
  if (xs.length < W * 0.2) throw new Error("couldn't find a car against the background");
  const noseX = facing === "left" ? xs[0] : xs.at(-1);
  const tailX = facing === "left" ? xs.at(-1) : xs[0];
  const Lpx = Math.abs(tailX - noseX);
  const zfOf = (x) => Math.abs(x - noseX) / Lpx;
  // arches: runs where the belly line jumps well above the rocker
  const midBots = xs.filter((x) => zfOf(x) > 0.3 && zfOf(x) < 0.6).map((x) => bot[x]).sort((a, b) => a - b);
  const rockerPy = midBots[midBots.length >> 1];
  const lift = Math.max(20, H * 0.035);
  const runs = []; let cur = [];
  for (const x of xs) {
    if (bot[x] < rockerPy - lift) cur.push(x);
    else if (cur.length) { runs.push(cur); cur = []; }
  }
  if (cur.length) runs.push(cur);
  const merged = [];
  for (const g of runs) {
    // generous gap: bright alloy spokes can split one arch into two runs
    if (merged.length && g[0] - merged.at(-1).at(-1) < W * 0.08) merged.at(-1).push(...g);
    else merged.push(g.slice());
  }
  const arches = merged.filter((g) => g.at(-1) - g[0] > W * 0.04)
    .map((g) => ({ c: (g[0] + g.at(-1)) / 2, x0: g[0], x1: g.at(-1) }))
    .filter((a) => zfOf(a.c) > 0.08 && zfOf(a.c) < 0.92); // bumper lips/overhangs aren't arches
  if (arches.length < 2) throw new Error(`found ${arches.length} wheel arch(es) — need 2 (is this a side profile?)`);
  arches.sort((a, b) => (a.x1 - a.x0 < b.x1 - b.x0 ? 1 : -1));
  const first = arches[0];
  const second = arches.find((a) => Math.abs(a.c - first.c) > W * 0.15); // not a fragment of the same wheel
  if (!second) throw new Error("couldn't find two distinct wheel arches");
  const two = [first, second].sort((a, b) => zfOf(a.c) - zfOf(b.c));
  // ground: tight-dark run under the arches (soft shadow stays lighter)
  const gvals = [];
  for (const a of two)
    for (let x = a.x0; x <= a.x1; x += 2) {
      let g = -1;
      for (let y = bot[x]; y < Math.min(H, bot[x] + H * 0.2); y++) {
        const c = at(x, y);
        if (Math.max(c[0], c[1], c[2]) < 42) g = y;
      }
      if (g > 0) gvals.push(g);
    }
  gvals.sort((a, b) => a - b);
  const ground = gvals.length ? gvals[Math.floor(gvals.length * 0.9)] : rockerPy + H * 0.08;
  return { top, bot, xs, noseX, tailX, Lpx, ground, rockerPy, wheels: two.map((a) => zfOf(a.c)), zfOf, W, H, at,
    _dbgRuns: merged.map((g) => [g[0], g.at(-1)]) };
}

// trace → carkit. length in game meters (2.4 = the fleet convention).
export function kitFromTrace(trace, { id = "traced-car", name, length = 2.4, width, facing = "left" } = {}) {
  const { top, bot, noseX, Lpx, ground, rockerPy, wheels, at } = trace;
  const dir = facing === "left" ? 1 : -1;
  const mpp = length / Lpx;
  const ym = (py) => Math.round((ground - py) * mpp * 1000) / 1000;
  const colAt = (zf) => noseX + dir * Math.round(zf * Lpx);
  const topAt = (zf) => {
    let x = colAt(zf), best = null, bd = 1e9;
    for (const k of Object.keys(top)) { const dx = Math.abs(k - x); if (dx < bd) { bd = dx; best = +k; } }
    return top[best];
  };
  // top chain at fixed stations, then prune near-collinear points
  const stations = [0, 0.03, 0.08, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.93, 1.0];
  let pts = stations.map((zf) => [zf, ym(topAt(zf))]);
  const pruned = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [pruned.at(-1), pts[i], pts[i + 1]];
    const yl = a[1] + ((c[1] - a[1]) * (b[0] - a[0])) / (c[0] - a[0]);
    if (Math.abs(b[1] - yl) > 0.012) pruned.push(b);
  }
  pruned.push(pts.at(-1));
  // A low/flat profile (or a noisy trace) can prune down to JUST nose+tail —
  // no interior station deviates enough from a straight line to survive the
  // 12mm collinearity filter. loftKit requires >= 3 points (a 2-point "top"
  // is a straight line, not a car), so rather than failing generation
  // outright, keep whichever interior station deviated MOST from flat, even
  // if it's under the normal keep-threshold.
  if (pruned.length < 3 && pts.length > 2) {
    const [a, c] = [pts[0], pts.at(-1)];
    let bi = 1, bd = -1;
    for (let i = 1; i < pts.length - 1; i++) {
      const b = pts[i];
      const yl = a[1] + ((c[1] - a[1]) * (b[0] - a[0])) / (c[0] - a[0]);
      const d = Math.abs(b[1] - yl);
      if (d > bd) { bd = d; bi = i; }
    }
    pruned.splice(1, 0, pts[bi]);
  }
  // a fastback tail between slopes 0.35–1.2 would classify as glass: steepen
  // the final drop by pulling the last interior point toward the tail
  const lastPair = () => [pruned.at(-2), pruned.at(-1)];
  {
    let [a, b] = lastPair();
    let slope = Math.abs(b[1] - a[1]) / (Math.abs(b[0] - a[0]) * length);
    if (slope >= 0.35 && slope <= 1.2) {
      const need = Math.abs(b[1] - a[1]) / (1.3 * length);
      pruned[pruned.length - 2] = [Math.max(a[0], b[0] - need), a[1]];
    }
  }
  const floorM = ym(rockerPy);
  const kitBottom = [
    [0, Math.max(floorM + 0.02, ym(bot[facing === "left" ? trace.xs[0] : trace.xs.at(-1)]))],
    [0.05, floorM], [0.95, floorM],
    [1, Math.max(floorM + 0.02, ym(bot[facing === "left" ? trace.xs.at(-1) : trace.xs[0]]))],
  ];
  // colors sampled off the photo: lit upper body + darker rocker zone
  const hex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
  const sx = colAt(0.55), sy = Math.round(topAt(0.55) + (rockerPy - topAt(0.55)) * 0.45);
  const patch = []; // median of a patch — a single pixel lands on highlights
  for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) patch.push(at(sx + dx, sy + dy));
  const med = (i) => patch.map((c) => c[i]).sort((a, b) => a - b)[patch.length >> 1];
  const paint = [med(0), med(1), med(2)];
  const w = width ?? Math.round(length * 0.3875 * 100) / 100;
  return {
    format: "carkit@1", id, name: name ?? id,
    length, width: w,
    sideProfile: { top: pruned, bottom: kitBottom },
    planTaper: [[0, 0.76], [0.15, 0.93], [0.6, 0.97], [0.82, 1], [1, 0.86]],
    bodyColor: hex(paint), glassColor: "#161c26",
    wheels: {
      frontZ: Math.round((0.5 - wheels[0]) * length * 100) / 100,
      rearZ: Math.round((0.5 - wheels[1]) * length * 100) / 100,
      x: Math.round(w * 0.43 * 100) / 100,
    },
    livery: {
      number: 1 + Math.floor(Math.random() * 98),
      bodyColor: hex(paint),
      stripeColor: hex(paint.map((v) => Math.round(v * 0.45))),
      accent: "#d8d2b8",
      windowColor: "#161c26",
      team: "PLACEHOLDER GP", badge: "PGP",
      sponsors: ["TIRE CO.", "HUBWORKS", "PACER BRAKES"],
    },
  };
}
