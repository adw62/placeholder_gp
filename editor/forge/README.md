# PS1 Scene Forge — V3

A single-file browser tool for making **low-poly, retro (PS1-era) 3D assets** from photos.

It is **scene-based**: you block out a model from multiple objects — primitives, profile
extrusions drawn over a ghosted reference, and/or a decimated high-poly model — and every
face of every object gets a slot in one shared **texture atlas**. You fill those slots by
*grabbing regions out of photos* (perspective-corrected and stylized) or with flat colors,
then export a single-mesh, single-texture `.gltf`.

Everything lives in **`index.html`** — no build step, no dependencies to install
(three.js and meshoptimizer load from a CDN via an import map).

---

## The pipeline

```
  add primitives ─────────────┐
  draw profiles over a ghost ─┼──▶ one scene, one packed atlas ──▶ click a face ──▶ fill
  load an .obj → decimate ────┘      (one cell per face)            (3D or atlas)   from a photo
                                              │                                     or flat color
                                              ▼
                                  one atlas texture ──▶ Export .gltf
```

1. **Block out the scene** — add primitives (Panel/Cube/Prism/Pyramid), draw profile
   extrusions over a ghosted reference, and/or decimate a loaded `.obj` (see below).
2. **The scene owns a net/atlas.** Every face of every object is packed into its own
   rectangular cell of a single texture. The atlas is shown in the right-hand panel.
3. **Select a face** — hover previews it (outlined on the model *and* in the atlas),
   click selects. Works from either side.
4. **Fill the face** — a flat color, or a photo grab: a selector *shaped like that face*
   appears over the photo; drag its handles onto the region you want. The region is
   warped into the face's cell, stylized, and live-updates as you drag.
5. **Export `.gltf`** — one mesh, one atlas texture, one material.

---

## Controls

**Top bar**
| Control | What it does |
|---|---|
| **Add** | Add a Panel / Cube / Prism / Pyramid object to the scene |
| **Sides** | Face count for the next Prism/Pyramid added (3–12) |
| **Reference** | **Load ref…** brings in a high-poly reference — `.obj`, `.gltf`, or `.glb` — as a ghosted + decimated target; **👁 Ghost** toggles the translucent reference |
| **Car** | **🚗 From photo** traces a side-profile photo into a lofted car body; **🎨 Auto livery** paints a GT1-style racing livery onto the current body and wires every face as an editable photo grab — see *Car generation* below |
| **Scale** | X / Y / Z stretch of the whole scene |
| **↶ Undo / ↷ Redo** | Steps through scene edits — `Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`) work anywhere |
| **Export .gltf** | Download the scene + embedded atlas texture (`scene.gltf`) |

Undo covers add/delete object, profile extrude, Draw/Delete region, tri edits, vertex drags and lock
toggles, Add vert, Merge/Delete verts, Subdivide, Subdivide face, Flatten face, Lock all, symmetry
toggles, Fit/Smooth (each run is one step, not one per animation frame), Move/Rotate/Scale,
Decimate, and fill edits (color, photo grabs, stylize sliders, rotate/flip) — a slider drag
collapses into one step, not one per tick. It does **not** cover loading a new reference
`.obj`: the reference is never mutated
by anything undoable, and it's too large to snapshot on every edit.

**Mode toolbar** (top-left of the 3D view — Esc returns to Select)
| Mode | What it does |
|---|---|
| **Select** | Hover/click faces to select for texturing (default) |
| **Move** | Transform gizmo on the selected face's object (Move / Rotate / Scale) |
| **✎ Tris** | Triangle editing for the selected face (add / remove / new face) |
| **● Verts** | Vertex editing for the selected object: drag a vertex to move it, click one to **lock 🔒 / unlock** it; **⬚ Select verts** click- or drag-box-selects a set, then **⛓ Merge** welds it into one or **🗑 Delete** removes it; **⊞ Subdivide** adds a ring along a profile prism's depth (repeatable); **🔒 Lock all** locks/unlocks every current vertex of the object; **▶ Fit to ghost** pulls the free vertices onto the reference surface; **〜 Smooth** relaxes the free vertices toward their neighbours' average — no reference needed |
| **✏ Profile** | Snap to an ortho view, click out a 2D outline over the ghost, close it → it extrudes into a prism whose depth is measured from the reference |
| **🖌 Draw region** | Click out a shape over the model as currently viewed (full perspective, camera frozen for the sketch); close it → paints a new fillable region exactly where you drew, on top of whatever face it landed on — no geometry is cut |

**Decimation bar** (shown once a reference `.obj` is loaded)
| Control | What it does |
|---|---|
| **Target** | Triangle budget — log slider from 24 tris up to the full source count, so a 500k-tri model can still hit true PS1 budgets |
| **Merge** | Region merge angle — adjacent triangles within this angle become one face (1–80°) |
| **Absorb under** | Regions smaller than this share of the surface area merge into the neighbour they touch most (off–10%, log scale) — kills confetti cells from bolts/greebles |
| **Decimate** | Applies the sliders, regenerating the Model object. Turns **orange** when they differ from what's built; nothing rebuilds until you click (the Model object's fills reset on rebuild) |

**3D view**
- **Hover a face** → outlined on the model *and* in the atlas · **click** → select
- **Drag** → orbit · **Scroll** → zoom
- **Drop an `.obj` or an image anywhere** → loads it (model / photo)

**Fill panel** (acts on the selected face)
- **✎ Tris** (mode toolbar) — triangle editing for the selected face: click triangles on the model —
  outside the face **adds** them, inside **removes** them (a removed triangle returns to
  the face it came from, or to the neighbour it shares the longest boundary with). Pick a
  different edit target via the atlas while editing. Rings, atlas cells, and UVs follow
  each click, and the face's fill re-projects into its refined region — you don't lose
  the texture you already placed. Emptied faces dissolve automatically.
- **＋ New face** — click a triangle to found a brand-new face (named *Custom N*), then
  keep clicking to grow it. Great for carving a sign or window out of a big region.
- **🖌 Draw region** (mode toolbar) — paint a fillable sub-area of an existing face without
  cutting any geometry. Click out a polygon over the model as it's currently framed (click
  the first point or Enter to close, Esc to cancel); whichever real face most of the shape
  landed on becomes its parent, and the polygon is recorded in that face's own surface
  parametrization — the same local coordinate frame the atlas already places the face with
  — so it tracks the face exactly through every atlas repack. Nothing about the mesh
  changes: no triangle is split, there's no topology to keep crack-free, and undo/redo is
  just the region entry appearing or disappearing. The new region (named *Custom N*) shows
  up as a dashed outline inside its parent's atlas cell and paints on top of the parent's
  own fill there; give it a flat color or photo grab exactly like a real face, independent
  of whatever the parent underneath is doing. Click it either on the model (inside the
  drawn outline) or on its dashed patch in the atlas to reselect it later; **🗑 Delete
  region** in the fill panel removes it without touching the face it sits on. Camera
  orbiting is frozen for the sketch (same as Profile) since the drawn points are
  screen-space. Occlusion is automatic — each sketch point raycasts to whatever's actually
  visible there, so anything hidden behind nearer geometry can't become the parent. A shape
  that catches nothing leaves you in the mode to just try again.
- **⊟ Subdivide face**, pattern **Grid / Strip / Wheel** — splits the selected face;
  repeatable, click again to subdivide the finer result again. Works on any face, not just
  profile prisms — a primitive's quad, a many-sided N-gon cap (e.g. the end cap of a
  hand-drawn profile), or a decimated region. It reads the face's real triangle boundary
  rather than its `ring` (which is only a synthetic bounding rect for decimated regions),
  so it can't go by a fake edge.
  - **Grid** (default) — a proper (n+1)×(n+1) vertex grid, quad faces only: every row/col
    edge gets a crack-free midpoint and every existing cell gets one new interior vertex,
    recursively refining each cell into 4 rather than re-fanning the whole boundary from
    scratch. No vertex is ever touched by more than 6 triangles, at any subdivision depth,
    so a long thin quad subdivides evenly instead of into slivers. Falls back to **Strip**
    on a non-4-cornered face, where a grid has no meaning.
  - **Strip** — for an N-gon that isn't a quad, e.g. a hand-drawn profile cap: finds the
    two boundary points farthest apart (the natural "ends" of an elongated outline), splits
    the boundary there into two rails, resamples them to match point-for-point, and lofts
    an ordinary two-rail grid between them (same doubling as Grid, collapsing to a single
    triangle at each end where the rails meet). This is what actually fixes the "fan of
    triangles converging on one point" look at the tip of a profile cap — Grid quietly
    falls back to Strip for exactly that shape, so you don't need to pick it by hand unless
    you want to force it on a face Grid *could* otherwise handle.
  - **Wheel** — every boundary edge gets a midpoint, joined to one new shared center vertex
    (an N-cornered face becomes 2N triangles fanning out from it). Works on any N-gon, but
    every triangle touches that one center, so it reads as a starburst on an elongated
    face — and gets worse each repeat click, since every pass fans a *new* center off the
    last one's (now larger) boundary. Grid/Strip exist specifically to avoid that; Wheel is
    the last-resort fallback, kept around as an explicit option.
- **⊡ Flatten face** — projects every vertex the selected face's triangles touch onto their
  own area-weighted best-fit plane, straightening out any bulge left by Fit to ghost,
  Smooth, or a manual vertex drag. Useful before a photo grab — texture projection assumes
  the face is flat, so a warped surface grabs a subtly skewed capture — or just to square
  off a panel again. Vertices are the same shared pool every other vertex edit in this app
  uses, so one shared with a neighbouring face moves for that face too; flattening a face
  can put a crease in whatever's next to it, the same trade-off Merge/Delete/Smooth/Fit
  already carry.
- **Flat color** — pick a solid color
- **From photo** — load a photo (button or drag-and-drop), then:
  - **Handles** — drag a numbered corner to adjust it individually, for correcting real
    photographic perspective. Dragging *inside* the selector (away from any handle) moves
    the whole thing as one rigid piece instead, and the small blue diamond a little outside
    the shape rotates and uniformly scales it together around its center — both keep every
    corner's relative position exactly intact (proportions and angles unchanged, verified:
    edge-length ratios and interior angles stay identical to floating-point precision through
    either gesture). Useful once the shape already lines up well with an undistorted part of
    the photo: repositioning it with the numbered handles one at a time risks introducing a
    little skew each drag, where the rigid move/rotate/scale can't
  - **Detail** — grab resolution, log slider from 8 px chunks up to native cell
    resolution (2048 px); lower = chunkier PS1 pixels. This governs the *content's* pixel
    chunkiness only — the atlas texture itself always renders at a much higher floor
    resolution (2048px, up from the old 512px) regardless of Detail, so a cell or painted
    region's own boundary has enough texels to stay crisp instead of stair-stepping when
    magnified onto a large surface. The 3D viewport also runs with MSAA on, for the same
    reason: smoothing edges is a rendering-quality fix, not a retro-style one — the chunky
    look lives entirely in the baked texture, not in how cleanly the app draws triangles
  - **Colors** — palette size (median-cut quantization)
  - **Dither** — Bayer ordered dithering + strength
  - **↻ Rotate** — reorient the grab inside the face (90° steps on quad faces; two
    clicks fixes an upside-down capture)
  - **⇋ Flip** — mirror the grab (for faces that come out reversed due to winding)

**Everything about a fill is per-face and persists:**
- the grab handles,
- **which photo it came from** — selecting a face swaps its own photo back into the
  panel, so different faces can source from different photos,
- **its stylize settings** — Detail/Colors/Dither edit the *selected* face only; the
  panel mirrors that face's values on selection, and new fills start from the last-used
  values.

Selecting another face, loading another photo, or tweaking another face's settings never
disturbs a face you already filled. Only editing the face itself, deleting its object, or
re-running Decimate (for the Model object) clears fills.

---

## Car generation (photo → car)

The full car pipeline from `../PIPELINE.md` runs *inside* the editor — same code
(`../tools/lib/carlib.js`) as the `../tools/build-car.js` CLI, so a car generated here and one
built from a kit file are identical.

1. **🚗 From photo** — needs a photo loaded (the button opens the file picker if none is;
   drag-and-drop works too). Best input is a **studio-style side profile: colorful paint
   on a neutral backdrop** — the tracer masks the car by its dominant saturated hue, so a
   grey/white car on a grey background won't trace. A small dialog asks which way the car
   faces and its in-game length (fleet convention: 2.4 m). It then traces the silhouette,
   finds the wheels and ground line, samples the paint color, and lofts the body —
   replacing the scene as **one undo step**. The traced kit is kept with the project
   (`carkit` field in the saved `.forge.json`).
2. **Tweak the mesh** with all the normal tools — verts, symmetry (⇋X pairs the mirrored
   sides), subdivide, profile edits.
3. **🎨 Auto livery** — dialog for body/lower/accent/glass colors, race number, team,
   badge, and sponsors. Paints side + wrap livery photos for the **current** mesh (it
   re-derives the silhouette geometrically, so it works after vert tweaks) and wires
   every body face as a regular, fully editable photo grab. Undoable; **re-run any time**
   with different colors. Loading a `build-car.js` project prefills the dialog with the
   kit's own livery.
4. **Layer detail** with the existing tools — per-face Stylize, re-grab a face from a real
   photo, 🖌 Draw region decals on top.
5. **Export .gltf**, save to `../../game/assets/models/cars/`, register in
   `ASSETS.carModels` (see `../PIPELINE.md` for the registration snippet and headless
   verification).

Headless/scripting handles: `window.forgeCarFromPhoto(opts)`, `window.forgeAutoLivery(lv)`,
`window.forgeLoadPhotoUrl(url)`, `window.forgeSerializeProject()`.

---

## The scene

The scene is a list of objects — primitives, profile prisms, and the decimated reference
model — whose faces all share one vertex pool and one atlas. Fills are keyed by
namespaced face names (`Cube 1 · Front +Z`), so adding, moving, or deleting one object
never disturbs another's textures. **🗑 Delete object** removes the selected face's
object. Moving an object bakes the transform into its vertices, so the merged mesh,
atlas, and export stay flat and simple.

### Vertex editing and fit

**● Verts** mode shows the selected object's vertices as handles (green = free, red =
locked). Drag one to move it in the camera plane; click one to toggle its lock.
**＋ Add vert** arms an insertion tool: hover shows a yellow preview point on the nearest
edge (at the position you're pointing at along it), click inserts the vertex there —
every triangle sharing that edge splits (across faces and objects, so no cracks), and
face outlines gain the vertex. Use it to give a profile prism more silhouette detail
before fitting. **▶ Fit to
ghost** relaxes the object onto the reference with a **wrap-from-outside (support) fit**:
each free vertex slides *along its own outward normal* until it reaches the farthest
reference point within a local cylinder around that direction — so the cage stops at the
model's outer extreme in each direction and contains it locally, instead of diving to the
nearest skin and collapsing inside (the failure mode of naive closest-point fitting).
Because verts move only along their normals, a profile prism keeps its drawn plan-form —
Fit inflates/deflates it to hug the surface. The displacement field is smoothed across
neighbours and annealed over ~20 visible iterations. Locked vertices are hard
constraints: pin the edges you've aligned by hand, and Fit negotiates the rest. The
typical turret loop: draw a profile prism, add verts where the silhouette needs detail,
lock the base edge, Fit, nudge, re-Fit.

**〜 Smooth** needs no reference: each free vertex eases toward the average position of its
own mesh neighbours (Laplacian relaxation), annealed over a dozen visible iterations, with
locked vertices as hard anchors exactly like Fit. It's the tool for rounding out geometry
that **⊞ Subdivide** or **⊟ Subdivide face** just added resolution to — Fit only makes
sense with a loaded reference; Smooth works on anything.

**⬚ Select verts** arms a selection tool — the inverse of Add vert. Click vertices one at a
time, or drag a box over empty space to grab every vertex whose screen position falls
inside it (additive — keeps whatever was already selected); selected verts highlight
orange. Once 1+ are selected, **🗑 Delete verts** (or the Delete/Backspace key) appears;
once 2+ are selected, **⛓ Merge** (or Enter) appears too. Esc cancels the selection without
changing anything.
- **Merge** welds the whole selection into one vertex at their average position. Every
  triangle referencing a merged-away vertex is remapped to the survivor; a triangle
  collapsed to two-or-fewer distinct corners (both its ends got merged into each other) is
  dropped, and a face left with no triangles dissolves, same as an emptied ✎ Tris edit. If
  any of the merged vertices was locked, the survivor ends up locked too. Merging two
  vertices that share a real edge (the common case — cleaning up an accidental double
  vertex, or collapsing a sliver) stays a clean, fully-manifold mesh; merging arbitrary,
  unrelated vertices is possible too but is on you to keep sensible — same as any
  general-purpose vertex weld.
- **Delete** drops every triangle touching any selected vertex outright — it cuts a hole
  rather than closing it back up (closing it needs re-triangulating the surrounding
  boundary, which is what Merge is for on the "clean up nearby verts" case this is usually
  paired with). A face or object left with nothing in it dissolves the same way.

Both act within one object only — scoped to whatever's already clickable in Verts mode.
Both are symmetry-aware — see **Symmetry (⇋X / ⇋Y / ⇋Z)** below.

**Lock all:** locks every vertex the selected object currently has. It's a snapshot, not a
mode — vertices you add afterward (via **＋ Add vert** or **⊞ Subdivide**) start unlocked,
so the button drops back to its off state as soon as one exists; press it again to sweep
those up too. Press it while everything is already locked to unlock the whole object.

**Symmetry (⇋X / ⇋Y / ⇋Z):** declare mirror planes (world planes, matching the centered
reference). Enabling one snaps near-mirror vertex pairs symmetric and from then on keeps
them mirrored: dragging a vertex moves its partner, locking one locks both, Add-vert
splits the mirrored edge too, fits preserve the pairing (pairs are fixed at fit start), and
Merge/Delete pull in each selected vertex's partner too — merging two verts on one side
also merges their mirrors into their own (separately-computed) survivor on the other,
rather than collapsing both sides onto each other, and deleting a vertex deletes its mirror
along with it. Vertices on the plane stay pinned to it. Pairing tolerance scales with the
object's mean edge length, so chunky cages pair generously while dense meshes stay
strict.

**⊟ Subdivide face** is symmetry-aware too: if the selected face has a mirror-partner face
(the two end caps of a symmetric profile prism are the usual case — same object, boundary
vertices that mirror each other one-for-one across a declared plane), subdividing one
applies the identical Grid/Strip/Wheel result to the other in the same click, rather than
needing it done twice by hand. It's not just mirrored *positions* — the actual triangle
connectivity is built by feeding the same mirrored starting structure through the same
splitting code, not by independently re-triangulating the partner's geometry, since two
separate computations aren't guaranteed to land on the same tie-break (Strip's
farthest-apart-pair search, for one) even from symmetric input. That mismatch is what
made moving one vertex behave differently on the mirrored side before: the "same" vertex
sat in a structurally different neighbourhood on each cap. Works from either cap and at
any repeat-click depth; clicking through Subdivide face on the two ends of a symmetric
prism now keeps them identical automatically instead of drifting apart.

Support queries run against a spatial hash of the reference's vertex cloud — fast even
on a 500k-vert scan, no extra dependencies. Vertices with no reference within reach
don't move.

### Profile extrusion (draw over the ghost)

In **✏ Profile** mode the camera snaps to an orthographic axis view. Click out a polygon
over the reference's silhouette (click the first point or press Enter to close): the
outline is extruded into a prism whose **depth is measured from the reference** — the
ghost's vertices that project inside your outline set the extrusion span. The result is
an ordinary object: two N-gon caps + N quad sides, every face textureable, tri-editable,
and movable.

A fresh profile prism only has vertex resolution at its two end caps — nothing in
between — so **⊞ Subdivide** (Verts mode) inserts a new ring of vertices at the midpoint
of the extrusion axis, splitting every side face in two along its depth. It's repeatable:
each click halves every current segment again (1 → 2 → 4 → 8 …), exactly like using
**＋ Add vert** on every depth-edge at once. Built on the same edge-split primitive as Add
vert, so it never cracks the mesh and rings/UVs/fills stay in sync. Only objects created
via Profile extrusion carry this axis, so the button is hidden for primitives and
decimated models.

## External models (decimate → regions)

Click **Load ref…** (or drop a `.obj`, `.gltf`, or `.glb` anywhere). `.gltf`/`.glb` go
through three.js's own `GLTFLoader`, so this is also how you'd reload a scene this app
exported earlier — but only as a **reference to decimate/fit against**, not as editable
faces/fills: a `.gltf` is a merged mesh with a baked texture, it doesn't carry this app's
per-face fill/region/symmetry data, so there's no way to reconstruct an editable project
from one. The model becomes a translucent **ghost reference** and a decimated copy joins
the scene as an object:

1. **Weld + normalize** — merged to indexed position-only geometry, centered, scaled to
   fit. Original UVs are intentionally discarded — you're re-texturing it.
2. **Decimate** — meshoptimizer's `simplify()` reduces the mesh to the **Target**
   triangle budget (default 1,500 or the source count, whichever is smaller).
   Zero-area triangles are dropped — each would otherwise become a junk region.
3. **Group into regions** — adjacent, near-coplanar triangles merge (union-find) within
   the **Merge** angle. Then **Absorb** folds any region below the size threshold into
   the neighbour it shares the most boundary with. Absorption works region-by-region
   (not per-triangle), so a chain of slivers can't accidentally fuse two large plates.
4. **Regions become ordinary faces.** Each region gets a synthetic 4-corner ring — its
   planar bounding rectangle — so *everything downstream is the standard face toolkit*:
   hover/click select, flat color, the 4-handle photo grab with exact perspective
   correction, per-face stylize, rotate/flip, and single-texture `.gltf` export.
5. **Refine by hand** — the automatic grouping is a starting point: use **✎ Edit tris**
   to move triangles between regions, or **＋ New face** to carve a new region out of
   clicked triangles. (Clicking **Decimate** again regenerates the regions and discards
   manual edits, like it resets fills.)

The sliders only *preview* (live triangle-count readout + orange pending button); the
model rebuilds when you click **Decimate**, which resets fills — settle on a decimation
level before texturing.

**Atlas sizing:** the atlas texture scales with the region count and the highest Detail
in use (512² up to 4096²), so every cell keeps roughly its texel budget. Still, many
regions = tiny cells and lots of manual assignment — if the stats line warns about the
region count, raise **Merge** or **Absorb**.

Suggested starting point for a big mechanical model: Target ≈ 1,000–2,000 tris,
Merge ≈ 30°, Absorb ≈ 0.5–2%, then nudge until the region count feels hand-textureable.

---

## How it works

The photo grab is a small perspective/affine texture-mapping engine:

- **`computeAtlas(model)`** — packs faces into a grid, projects each face outline to 2D
  (`faceBasis`/`proj2`), places it in its cell (`polyTransform`), and produces the mesh's
  fixed **net UVs** — including UVs for vertices *inside* a region's outline.
- **`externalModel()`** — meshopt decimation → per-triangle normals → union-find
  region growing by angle → small-region absorption by shared-boundary length → each
  region emitted as a face with a synthetic bounding-rect ring.
- **`faceRectRing(verts, tris)`** — the synthetic bounding-rect ring for any triangle
  set, used both when regions are generated and when they're hand-edited; triangle edits
  just move tris between faces, recompute the affected rings, and rebuild — fills are
  keyed by face name, so they survive.
- **`grabFace(name)`** — warps the face's source polygon on its photo into its atlas
  cell: 4-sided faces use an exact **homography** (`solveH` + `warpTriH`) for true
  perspective correction; N-gons use per-triangle **affine** warping (`triangulate` +
  `warpTri`). The result runs through **`stylizeCanvas`** (median-cut quantize — palette
  built from a ~65k-pixel subsample so full-res grabs stay fast — plus Bayer dither),
  using that fill's own settings.
- **Rotation/Flip** permute the correspondence between photo handles and cell corners,
  so reorientation is distortion-free.
- The atlas is one `CanvasTexture` (nearest-filter) on a single `MeshLambertMaterial`,
  so the exported `.gltf` is a clean single-texture asset. Selection/hover outlines are
  stripped before export. (The texture is recreated when the atlas canvas resizes —
  a resized canvas behind a live GPU texture silently shows stale texels otherwise.)

The geometry is built **non-indexed** (each triangle owns its vertices) because a shared
corner — e.g. a cube corner touching three faces — maps to a different atlas cell per
face.

---

## Running it

It's a static page, but it imports three.js/meshoptimizer from a CDN, so it needs an
internet connection and must be served over HTTP (not opened as a `file://` URL):

```bash
cd /home/a/ps2d-main/placeholder_gp
python3 -m http.server 8000
# then open http://localhost:8000/editor/forge/index.html
```

This tool is also the **hand-polish stage of the asset pipeline** (see `../PIPELINE.md`):
generated car geometry gets tweaked and textured here before export into the game.
Serve from the **repo root** (as above), not this subdirectory — the page imports
`../tools/lib/carlib.js` and fetches `../../shared/src/` for the car-generation buttons.

---

## Limitations

- **Built-in shapes are flat-faced.** Curved surfaces are supported via **Model…**
  (decimate + planar regions), but a very curvy region merged under a large Merge angle
  is planar-projected, so its texture stretches on the curved parts — lower Merge (or
  Absorb) to split it up.
- **`.obj` only** for external models (no `.glb`/`.fbx` yet).
- **Packed grid atlas**, not a foldable papercraft net (functionally identical for
  texturing, just not fold-to-assemble).
- Self-intersecting selector polygons aren't supported (convex/concave simple polygons
  are).
- The atlas texture caps at **4096²** — with very many regions, per-cell resolution is
  bounded no matter the Detail setting.

---

## Sample assets

`src.jpg` / `images.jpg` / `vend_face.png` / `guess_vend.png` are example source photos
to grab from.
