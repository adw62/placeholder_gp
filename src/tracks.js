// =====================================================================
// Track definitions — pure data. A track is a closed Catmull-Rom spline
// through controlPoints ([x, y, z] — y is real elevation: road, kerbs,
// walls and the ground terrain all follow it; car physics is still planar
// though, so slopes don't yet affect handling), plus width, laps, medal
// targets and a visual theme.
//
// To add a new level: copy an entry, move the points, done. Everything
// (road mesh, checkpoints, AI racing line, minimap, ambient scenery
// scatter) is generated from this data. Trackside objects (barriers, apex
// kerbs, trees, billboards, ...) are placed by trackObjects.js from an
// optional `trackObjects: { bands, points }` field — see that file's
// header comment for the rule format. Omit it and sensible defaults
// (full-lap barriers + curvature-triggered apex kerbs) are used.
//
// A track can also declare `extraSplines: [{ id, name, closed, controlPoints,
// trackObjects }]` — free-standing paths (open or closed, via `closed`)
// drawn independently of the main spline, each with its own `trackObjects`
// bands/points. No defaults are applied to these (an extraSpline with no
// trackObjects places nothing) — useful for scenery that doesn't want to
// parallel the road at all (a crowd line along a fence, rocks along a
// canyon wall unrelated to the track's own curve).
//
// The standalone track editor (editor.html) generates whole entries of this
// shape directly, including extraSplines. Two ways to make one playable:
//   - Paste it in here, in this array — bundled in permanently, alongside
//     the tracks below.
//   - Download it (or Export/Copy + save the JSON yourself) into levels/ —
//     auto-discovered and added to the menu at boot (see src/levels.js),
//     no code edit needed. This is the easier path for a one-off track you
//     just want to drive; use this file for ones you want to ship as part
//     of the game itself.
//
// medalAvgSpeed = average m/s needed over the whole race for each medal;
// targets self-calibrate to track length so they stay sane when you edit
// the spline.
// =====================================================================

export const TRACKS = [];
