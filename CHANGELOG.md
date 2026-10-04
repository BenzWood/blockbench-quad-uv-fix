# Changelog

## 0.3.0 — Direct native exports and finer edges — 2026-10-04

- Add 1/16 (default) and 1/32 sampled edge targets; auto scale searches integer multipliers 1–64 within increased image budgets.
- Add optional 4x4 boundary coverage antialiasing with premultiplied alpha; preserve flat interiors and keep hard-palette mode available.
- Integrate baking into native whole-project glTF/GLB, FBX and OBJ exports through an isolated temporary project and combined options dialog. Close the copy and restore the source before saving captured outputs.
- Save desktop sibling assets automatically; embed images in direct GLB/glTF. Keep ZIP as an inspection/backup option and web FBX/OBJ multi-file carrier.
- Disable native glTF power-of-two resampling for integrated or recognized baked-copy exports. Preserve sampled image dimensions.
- Retain shared-UV atlas handling, author BenzWood, source geometry/textures and engine-independent materials. Do not intercept partial/collection or custom compile-based exporters.

JavaScript syntax inspection only; visual, lifecycle, native exporter and engine acceptance are delegated to the user. Finite raster output and coverage AA are approximate, not zero-error reconstruction.

## 0.2.1 — Automatic shared-UV conflict atlases — 2026-10-04

- Check each face before committing compensation to the shared texture region.
- Automatically relocate conflicting faces to cropped, padded patches in the same affected atlas; preserve compatible overlaps and reuse identical patches.
- Compare compact atlas layouts without forcing power-of-two dimensions. Record relocated faces, reuse and actual atlas size.
- Remap every affected texture reference in the detached model copy; original UVs, PNGs, geometry and engine code stay intact.
- Account for native flipbook aspect detection and Box UV conversion when per-face UV is supported. Charge final atlas dimensions against image budgets.

Syntax inspection only; Blockbench export and engine acceptance are delegated to the user. Atlas UV placement changes only in the baked copy. Packing/quality estimates are not mathematical minimum or fidelity guarantees.

## 0.2.0 — Adaptive texture baking beta — 2026-10-04

- Export a ZIP containing a self-contained baked bbmodel copy, affected PNGs and a per-texture scale/error report.
- Try every integer scale from 1x through 16x in ascending order using a color-boundary footprint error estimate; allow fixed scale and balanced/fine targets.
- Sample the corrected appearance back into ordinary UV texture space. Preserve the editable source and existing position vertices/UV coordinates.
- Fix corrected faces to their existing two triangles in the export copy; remove correction flags to avoid double mapping.
- Detect conflicting sampled colors in shared UV regions, protect uncorrected faces, enforce image-budget limits and support cancellation.
- Keep native preview features and author attribution. No Unity/Godot integration code is introduced.

Baking and ordinary exports await user acceptance. Auto scale is an estimate, not a strict error bound. Explicit triangulation can affect shading normals and exporter vertex splitting.

## 0.1.1 — Community beta — 2026-10-04

- Attribute the plugin and MIT license to BenzWood.
- Add English UI alongside Chinese labels.
- In face mode, require explicit face selection instead of falling back to every face of the Mesh.
- Scope edit/animation refresh to marked or already managed Meshes.
- Add portable installation instructions, compatibility notes, manual acceptance checklist and a Chinese introduction-video script.

The initial author's model feedback applies to 0.1.0. Version 0.1.1 changes await manual acceptance.

## 0.1.0 — Initial local version

- Inverse bilinear mapping for marked convex Mesh quads, without subdivision or authored UV changes.
- Textured/UV-checker preview, corrected pixel-grid helpers and painting/picking coordinates.
- Undoable face flags and preview comparison toggle.
- Native fallback and cleanup hooks for unsupported cases and unload.
