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

Both `editor/` and `game/` reach across into `shared/` by relative path (e.g.
`game/src/main.js` imports `../../shared/src/config.js`), which a browser
resolves relative to the server root — so **always serve from this
directory** (`python3 -m http.server 8000`), never from `editor/` or `game/`
themselves, or those imports 404. Then open e.g. `/editor/editor.html`,
`/editor/forge/index.html`, or `/game/index.html`.
