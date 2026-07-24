# Placeholder GP — repo layout

Restructured so the game and its authoring tools are separated at the top level:

```
game/      THE SHIPPED GAME — see game/README.md to run it, controls, architecture
editor/    AUTHORING TOOLS — Scene Forge, standalone track/crowd editors, headless
           pipeline CLIs, schemas, and pipeline scratch dirs (work/, ingest/).
           See editor/PIPELINE.md.
shared/    CODE game/ AND editor/ BOTH IMPORT — asset registry, track/environment
           building, spline math. Never duplicated between the two; this is the
           only reason editor.html/crowdEditor.html can preview exactly what the
           game will render.
```

Start here:
- Want to play or ship the game → `game/README.md`
- Want to generate/verify a car or track, or use Scene Forge → `editor/PIPELINE.md`
- Editing shared behavior (physics tuning, trackside object placement, the asset
  registry) → `shared/src/`, changes apply to both sides automatically

Because `editor/` reaches across into `game/` and `shared/` by relative path (and
Scene Forge/the standalone editors need to reach `shared/`), serve pages that live
under `editor/` from **this directory** (`python3 -m http.server 8000`, then open
e.g. `/editor/editor.html` or `/editor/forge/index.html`). `game/` is otherwise
self-contained aside from its one dependency on `../shared/`, and can be served on
its own for interactive play (`cd game && python3 -m http.server 8000`).
