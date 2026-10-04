# Quad UV Fix / 四边形 UV 修复

**Author: BenzWood · MIT · 0.3.0 beta · Blockbench 5.2+**

Fix the diagonal kink in rectangular texture pixels on trapezoidal Mesh quads inside Blockbench, without subdividing your model. Quad UV Fix uses inverse bilinear mapping and synchronizes the texture preview, pixel grid, and painting coordinates.

The editor uses inverse bilinear mapping. **Native whole-project glTF/GLB, FBX and OBJ exports now auto-bake by default** when corrected textured faces exist. A temporary copy is compiled and closed before saving; the source project is restored. Baking encodes a finite-resolution approximation in regular PNG textures. Turning off Auto-bake Native Model Exports restores native source export, which does not carry the preview correction.

[中文说明](README.zh-CN.md) · [Limits & compatibility](docs/limitations.md) · [Manual checklist](docs/manual-checklist.md) · [Short-video script / 视频脚本](docs/video-script.zh-CN.md)

## Install

1. Download [benz_quad_uv.js](https://raw.githubusercontent.com/BenzWood/blockbench-quad-uv-fix/main/benz_quad_uv.js). Save it as a `.js` file.
2. In Blockbench, open **File → Plugins → Load Plugin from File** and select it. Accept Blockbench's local-plugin prompt.
3. Find **Tools → Quad UV Fix**. Chinese Blockbench interfaces show Chinese action labels; other languages use English.

This is a single-file plugin: no build process, dependencies or account required to use it. It is distributed through this repository; inclusion in the official Blockbench plugin catalog is a separate process and has not been claimed.

## Use

1. Switch to **Textured** view and select a Mesh. To target individual faces, switch to face-selection mode and select them.
2. Choose **Tools → Quad UV Fix → Enable on Selection**. Object mode targets the selected Mesh's valid quad faces; face mode targets only explicitly selected faces. Locked Meshes are skipped.
3. Paint normally. The existing pixel-grid setting still controls grid visibility.
4. Toggle **Preview** to compare with native mapping; use **Disable on Selection** to remove face flags. Enable/disable edits support undo and redo.
5. **Help & Status** reports marked and currently active faces. Invalid quads, incompatible materials or unsupported views can make those counts differ.

Keep your existing rectangular UV island. There is no need to enter a row/column count: the grid uses the texture's pixel spacing. The plugin cannot merge previously subdivided strips into one original quad.

## Bake and export directly

1. Finish painting in the original project; switch to Edit or Paint mode.
2. Use **File → Export → glTF/GLB, FBX or OBJ**. **Tools → Quad UV Fix → Auto-bake Native Model Exports** is on by default. A separate Tools action provides direct GLB/glTF export.
3. Keep texture scale **Auto**, choose **1/16** (default) or **1/32** edge-error target. Auto tries every integer scale from 1x through 64x within image budgets; selected fixed scales are available. These are sampled quality estimates, not error guarantees.
4. Optionally enable **Edge antialiasing**. It uses 4x4 coverage samples on detected color boundaries and mixes boundary colors with premultiplied alpha; uniform interiors keep palette colors. Leave it off for exclusively hard palette pixels. This does not eliminate finite-raster approximation.
5. Choose native scale/animation/encoding settings in the same dialog and save the model. GLB/glTF always embed images in this integrated workflow. Desktop FBX/OBJ write required PNGs beside the model, plus MTL for OBJ and a `.quad-uv-report.json` sidecar. No intermediate bbmodel extraction is required.
6. Use the exported model and textures with ordinary engine materials. Review Point/Nearest sampling, importer maximum size, compression and mipmaps; importer resizing can undo higher bake fidelity.

**ZIP is optional:** Tools → Export Baked Copy ZIP creates the inspectable bbmodel/PNG/report package. Browser GLB/glTF download directly; browser FBX/OBJ still use a ZIP to carry sibling assets. Native collection/partial export contexts and third-party exporters that call `compile()` directly are not intercepted.

Keep editing the original low-resolution texture, and rebake after changes. The original project, texture layers and files are retained. The copy flattens affected textures and removes correction flags to avoid applying the mapping twice.

**Geometry detail:** the copy fixes each corrected quad to its two original triangles, reusing its existing position-vertex keys. UV coordinates in the copy may be remapped for shared-UV conflicts. No new position vertices or rendered triangles are added; authoring face count increases. Rectangular UV islands remain rectangular, but may be scaled or translated in the copy. Exporters/importers can still split rendering vertices at UV or normal boundaries, so identical imported vertex counts across all formats are not promised. Non-planar face normals can differ after explicit triangulation.

Auto scale estimates edge displacement from center/four-corner samples of baked texel footprints, only where source colors differ. Targets are 1/4, 1/8, 1/16 (default), or 1/32 of an original texel. **This is a sampled estimate, not a mathematical error bound or an engine acceptance result.** The first candidate passing this estimate is selected; a minimum among every possible integer size is not claimed. The report lists dimensions, scale and estimated error.

Conflicting shared UVs are automatically assigned independent cropped patches in the same affected texture atlas. Compatible overlaps stay shared; identical padded patches are reused. All faces referencing an expanded atlas have their copy UVs remapped to retain the same pixel positions. Original model UVs stay intact. The report lists relocated faces, patch reuse and atlas dimensions. Packing uses a compact heuristic, not a proof of the smallest possible atlas. Two output-pixel padding is added; filtered/mipmapped sampling still needs inspection. Static textures and in-bounds UVs are supported. Each output texture is limited to 16 million pixels and a 4096-pixel edge; combined affected outputs are limited to 64 million pixels. A Cancel button remains available during processing. See [limits](docs/limitations.md).

## What changes?

- Adds a persistent `benz_bilinear_uv` boolean to enabled Mesh faces.
- Adds temporary rendering attributes and line helpers during editing; does not add source model vertices or faces. The baked copy has explicit triangles and may have repacked UVs.
- Leaves authored UV coordinates, texture layouts, model shape and animation data intact.
- Supports native Textured and UV-checker views. PBR/Material and other views use native behavior.
- Unloading restores this plugin's wrappers and preview resources where they are still owned by the plugin.

Save `.bbmodel` with the plugin loaded to preserve its flags. Reopening and saving without the plugin may discard unknown custom flags; the standard geometry and UVs remain valid.

“Bilinear” here describes the four-corner coordinate mapping, not texture filtering. Existing texture sampling settings are retained.

## Release status

Developed against the installed Blockbench **5.2.1** source interfaces. The author reported the initial preview version works for their trapezoidal leg case. Version 0.3.0 adds direct native export integration, 1/16 and 1/32 targets, optional boundary antialiasing and protection against native glTF power-of-two image resampling. Direct export integration, edge antialiasing, baking, automatic conflict atlasing, 0.1.1 safeguards and broader compatibility await user acceptance. Desktop and web variants are declared; web behavior has not been independently accepted.

No automated or editor acceptance tests were run for this release. See the manual checklist. This is an early community beta, not a promise of compatibility with all Blockbench versions or other plugins.

## Contribute / report a problem

[Open an issue](https://github.com/BenzWood/blockbench-quad-uv-fix/issues) with your Blockbench/plugin version, view and selection mode, reproduction steps, marked/active face counts, and a minimal model you are comfortable sharing. Include whether the texture, grid, painting position or export differs. Contributions should keep mapping math, rendering, grid generation and Blockbench adapters separated within the single-file implementation.

## References

- [Nathan Reed — Quadrilateral Interpolation, Part 2](https://www.reedbeta.com/blog/quadrilateral-interpolation-part-2/): inverse bilinear derivation and mapping tradeoffs.
- [AMD GPUOpen — Bilinear interpolation on a quadrilateral](https://gpuopen.com/learn/bilinear-interpolation-quadrilateral-barycentric-coordinates/).
- [Blockbench source](https://github.com/JannisX11/blockbench).

Implementation and project attribution: **BenzWood**. Mathematical source attribution is preserved above and in the code. Licensed under [MIT](LICENSE).
