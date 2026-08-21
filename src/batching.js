// =====================================================================
// Race-time static-scenery batching. The editor needs every prop as its
// own selectable mesh; the race needs draw calls down — cresting a hill
// can bring the whole map into the frustum at once (500 -> 3000 draws).
// mergeStaticGroup() pulls every opaque MeshStandardMaterial mesh out of
// a built group, bakes world transform + material color into geometry
// (vertex colors; flat shading baked into facet normals), and merges per
// (spatial cell x material family). One draw per chunk, chunks still
// frustum-cull individually, and the caller can distance-cull whole
// chunks — PS1 draw-distance pop-in, but per 70 m block, not per tree.
//
// Left untouched: excluded subtrees (billboards/crowd — they rotate or
// swap materials every frame), transparent or non-Standard materials,
// and any mesh wider than a cell (spline ribbons — merging those into a
// chunk would balloon its bounds and defeat culling).
// =====================================================================

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const CELL = 70; // meters of scenery per chunk (per material family)

export function mergeStaticGroup(root, exclude) {
  root.updateMatrixWorld(true);

  // --- collect qualifying meshes, skipping excluded subtrees whole ---
  const candidates = [];
  (function walk(o) {
    if (exclude.has(o)) return;
    if (
      o.isMesh && !Array.isArray(o.material) && o.material.isMeshStandardMaterial &&
      !o.material.transparent && o.geometry.getAttribute("position")
    ) candidates.push(o);
    for (const c of o.children) walk(c);
  })(root);

  // --- bucket by (cell x family) on the world-space bounding sphere ---
  const sphere = new THREE.Sphere();
  const buckets = new Map();
  for (const m of candidates) {
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    sphere.copy(m.geometry.boundingSphere).applyMatrix4(m.matrixWorld);
    if (sphere.radius > CELL * 0.75) continue; // ribbon-scale: leave individual
    const mat = m.material;
    const key = [
      Math.floor(sphere.center.x / CELL), Math.floor(sphere.center.z / CELL),
      mat.map ? mat.map.uuid : "x", m.castShadow ? 1 : 0, m.receiveShadow ? 1 : 0,
      mat.side, mat.roughness.toFixed(1), mat.metalness.toFixed(1),
    ].join("|");
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(m);
  }

  // --- merge each bucket into one mesh ---
  const out = [];
  for (const bucket of buckets.values()) {
    const geos = [];
    for (const m of bucket) {
      // non-indexed everywhere: buckets can mix indexed/non-indexed
      // geometry, and it's also what bakes flatShading into real normals
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      if (m.material.flatShading || !g.getAttribute("normal")) g.computeVertexNormals();
      const n = g.getAttribute("position").count;
      if (!g.getAttribute("uv")) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
      // material color -> vertex color (both linear, so identical output)
      const col = new Float32Array(n * 3);
      const c = m.material.color;
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      g.applyMatrix4(m.matrixWorld);
      for (const name of Object.keys(g.attributes)) {
        if (name !== "position" && name !== "normal" && name !== "uv" && name !== "color") g.deleteAttribute(name);
      }
      geos.push(g);
    }
    const merged = mergeGeometries(geos, false);
    if (!merged) continue; // mismatched attributes somehow — leave originals be

    const tpl = bucket[0].material;
    const mesh = new THREE.Mesh(
      merged,
      new THREE.MeshStandardMaterial({
        color: 0xffffff, vertexColors: true, map: tpl.map ?? null,
        roughness: tpl.roughness, metalness: tpl.metalness, side: tpl.side,
      })
    );
    mesh.castShadow = bucket[0].castShadow;
    mesh.receiveShadow = bucket[0].receiveShadow;
    mesh.matrixAutoUpdate = false;
    merged.computeBoundingSphere();
    mesh.userData.cullCenter = merged.boundingSphere.center.clone();
    mesh.userData.cullRadius = merged.boundingSphere.radius;
    out.push(mesh);

    for (const m of bucket) {
      m.parent?.remove(m);
      // originals were never rendered, so no GPU buffers exist yet — but
      // free the CPU-side arrays (respecting shared singletons)
      if (!m.geometry.userData?.shared) m.geometry.dispose();
      if (!m.material.userData?.shared) m.material.dispose(); // NOT its map — maps are shared
    }
  }
  return out;
}
