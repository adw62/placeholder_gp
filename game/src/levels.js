// =====================================================================
// User-generated levels — auto-discovered from levels/ at boot. Same
// directory-listing trick already used for crowd kits (discoverCrowdKitUrls
// in crowd.js) and texture-variety folders (placeholders.js): the dev
// server's own folder listing (Python's http.server returns one
// automatically) is parsed for matching links, so dropping a file in is
// enough — no manifest to edit, no code change, just a page reload. Same
// portability caveat as those: most static hosts don't return a directory
// listing, so this is a local-dev convenience, not something to rely on in
// production hosting.
//
// Each file is a whole track-definition JSON — the exact shape TRACKS
// entries in tracks.js have, and exactly what the editor's Export/Copy/
// Download button already writes. Drop an exported file straight in.
// =====================================================================

export async function discoverLevelUrls(folderUrl) {
  try {
    const res = await fetch(folderUrl);
    if (!res.ok) return [];
    const html = await res.text();
    const hrefs = [...html.matchAll(/href="([^"]+\.json)"/gi)].map((m) => m[1]);
    const base = new URL(folderUrl, location.href);
    return [...new Set(hrefs)].map((h) => new URL(h, base).href);
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
