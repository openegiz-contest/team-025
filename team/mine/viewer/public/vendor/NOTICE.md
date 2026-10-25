# Vendored third-party code

Vendored (not CDN-loaded) so the viewer works on any machine without
outbound internet access during evaluation — same reasoning as this repo's
vendored Grafana plugins (see ../../../../NOTICE).

- **three.module.js** — [Three.js](https://threejs.org) r169, MIT License, Copyright 2010-2024 Three.js Authors.
- **OrbitControls.js**, **Sky.js** — part of the Three.js examples (`examples/jsm/`), same license and copyright.
- **EffectComposer.js**, **Pass.js**, **RenderPass.js**, **ShaderPass.js**, **MaskPass.js**,
  **UnrealBloomPass.js**, **OutputPass.js**, **CopyShader.js**, **LuminosityHighPassShader.js**,
  **OutputShader.js** — the Three.js post-processing stack (`examples/jsm/postprocessing/` and
  `examples/jsm/shaders/`), same license and copyright. Used for the scene's bloom pass.
- **BufferGeometryUtils.js** — `examples/jsm/utils/`, same license and copyright. Used to merge the
  static scenery into one mesh per material, which cuts the scene's draw calls.

All files are fetched directly from the pinned r169 release. The only modification is to the
post-processing files' own `import` paths: upstream they live in two directories and refer to each
other as `../shaders/X.js`, here they sit side by side, so those paths read `./X.js`.
