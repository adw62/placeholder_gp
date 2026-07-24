# ingest/ — raw inputs

Drop source material here; nothing in this tree is ever loaded by the game.

- `photos/` — source photography: texture material, car liveries, building facades,
  anything Scene Forge will grab regions from.
- `refs/` — references: blueprints, style images, high-poly `.obj`/`.gltf` models to
  decimate against in Scene Forge. A studio-style car side profile (colorful paint,
  neutral backdrop) here can be traced straight into a car body — Scene Forge's
  **🚗 From photo** button, or read off by hand into a `work/cars/*.carkit.json`.

Pipeline flow: `ingest/` → (generate/stylize in `work/`) → finished files into
`../game/assets/...`. See `../PIPELINE.md`.
