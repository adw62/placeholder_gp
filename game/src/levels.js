// =====================================================================
// User-generated levels — auto-discovered from levels/ at boot via
// levels/manifest.json (same manifest trick used for crowd kits —
// discoverCrowdKitUrls in crowd.js — and texture-variety folders —
// placeholders.js): a plain JSON file listing the folder's filenames, so
// this works on any static host (GitHub Pages included), unlike parsing a
// directory-listing page (only Python's http.server returns one of those).
// Drop a file in, then regenerate the manifest — `node
// game/tools/build-manifests.mjs` — and it's live next reload/deploy.
//
// Each file is a whole track-definition JSON — the exact shape TRACKS
// entries in tracks.js have, and exactly what the editor's Export/Copy/
// Download button already writes. Drop an exported file straight in.
// =====================================================================

export async function discoverLevelUrls(folderUrl) {
  try {
    const base = new URL(folderUrl, location.href);
    const res = await fetch(new URL("manifest.json", base));
    if (!res.ok) return [];
    const files = await res.json();
    return [...new Set(files)].map((f) => new URL(f, base).href);
  } catch {
    return [];
  }
}

// Same minimum shape editor.js's validateDef checks, kept independent
// (rather than importing editor.js, which pulls in the whole standalone
// editor) since this only needs the one guard: don't hand a broken def to
// buildTrack() and crash the menu.
function isValidLevel(d) {
  return !!d && typeof d === "object"
    && Array.isArray(d.controlPoints) && d.controlPoints.length >= 3
    && typeof d.width === "number" && d.width > 0;
}

// Resolved against this module's own file, not the document that imported
// it — main.js (game/index.html) and preview.html (editor/) sit at
// different depths but both need game/levels/.
const DEFAULT_LEVELS_URL = new URL("../levels/", import.meta.url).href;

export async function loadLevels(folderUrl = DEFAULT_LEVELS_URL) {
  const urls = await discoverLevelUrls(folderUrl);
  const levels = await Promise.all(urls.map(async (url) => {
    try {
      const d = await (await fetch(url)).json();
      if (!isValidLevel(d)) {
        console.warn(`levels/: skipping ${url} — not a valid level (needs controlPoints + width).`);
        return null;
      }
      d.id ??= url.split("/").pop().replace(/\.json$/i, ""); // filename sans extension, if the JSON didn't set its own
      return d;
    } catch (err) {
      console.warn(`levels/: skipping ${url} —`, err);
      return null;
    }
  }));
  return levels.filter(Boolean);
}
