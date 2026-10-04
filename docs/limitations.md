# Limits and compatibility

This is a code-review-based boundary inventory, not a record of passing runtime checks. Developed against Blockbench 5.2.1. One initial trapezoidal-leg case has author feedback; broader acceptance is pending.

| Situation | Intended behavior / remaining issue |
| --- | --- |
| Convex, planar Mesh quad + rectangular UV | Four-corner mapping; preserves even edge parameter spacing and removes the native triangle mapping kink. Pixel cells still change size as the trapezoid changes width. |
| Mirrored/rotated UV | Corner correspondence is retained. Rectangular islands with arbitrary rotation may use sampled grid curves rather than the axis-aligned fast path. |
| General convex UV island | Four-corner mapping is used; diagonal motifs can curve. Helper curves use 12 samples, so complex shapes are approximate. |
| Triangle, concave/bow-tie/degenerate quad | Skipped when validation fails; native mapping remains. |
| Non-planar quad | Inversion uses a dominant-plane projection, and grid/brush positions are lifted back to the original triangles. This cannot remove a real geometry fold. Invalid projected quads are skipped; severe twists may give undesirable results even when projection passes. |
| Near-degenerate, extremely narrow or huge-coordinate face | CPU/GPU tolerances and Float32 precision can differ. Root selection is stabilized, but no guarantee for all numerical extremes. |
| Large brush cursor | Local matrix approximation; the whole cursor outline is not an exact nonlinear boundary. Painting hits use their own inverse mapping. |
| Shared UVs / mirrored painting | Existing texture-sharing rules still apply: painting one shared region can affect another face. Does not resolve UV overlaps or automatically stitch seams. |
| Adjacent faces | Corrected independently. Continuous-looking pixels across seams are not guaranteed; neighboring maps may have different derivatives. |
| Animated textures, mesh deformation, undo/redo, multiple projects | Adapter hooks exist; these combinations await user acceptance. |
| Screen Space Brush | GPU UV picking is adapted in the 5.2 implementation; brush-specific modes still need acceptance. This plugin's basic workflow does not depend on using this brush. |
| PBR/Material, normals, wireframe or custom shader | Native behavior outside Textured/UV views; incompatible textured materials fall back. Other plugins that alter a compatible shader may still conflict. |
| Other plugins wrapping the same APIs | Wrappers chain and restore only when owned. Load order and later replacements can still prevent a hook from running. No universal inter-plugin compatibility guarantee. |
| High-resolution textures | More grid-generation and fragment work. An axis with over 4096 grid intervals is omitted from helper generation, but texture mapping remains. Large models with many enabled quads can still be expensive. |
| Repeated project/material changes | Material clones remain cached until unload; unusually long sessions may retain unused clones. Disable/unload releases plugin resources. |
| Geometry cloning / third-party tools | Plugin-only attributes are stripped from geometry clones to support standard exporters. A third-party plugin that relies on cloning corrected preview geometry needs explicit integration. |
| Direct source OBJ/FBX/glTF export | Original standard UVs are exported, so the preview correction is not encoded. Use the baked copy for ordinary-material approximation. Export execution is not accepted yet. |
| Plugin absent when saving bbmodel | Unknown custom face flags may be dropped. Standard vertices, faces and UVs are independent of those flags. |
| Blockbench updates / web browser GPU | Internal adapters may need updates; declared minimum 5.2.0 is not proof every future version or web GPU works. Additional vertex attributes/varyings increase GPU requirements. |

## Why this is not a standard UV-unwrapping fix

The four-corner mapping describes interior coordinates, while ordinary exported UVs store corner coordinates and native rasterization interpolates over triangles. Rearranging a UV island alone cannot encode an arbitrary bilinear interior mapping. This is why export behavior is a central design constraint.

## Baking limits (0.3.0)

- Baking remaps colors into new PNGs using nearest source-texel sampling, with optional edge coverage antialiasing. It does not encode an exact continuous bilinear map at arbitrary finite resolution.
- Automatic selection is the first passing candidate from every integer scale 1x through 64x, per texture. A center/four-corner sample estimate is checked where colors differ. Narrow islands and complex near-degenerate mapping can evade this estimate; actual appearance still needs acceptance.
- Fixed scale exports even when the estimated tolerance is not met; the report explicitly marks this. Auto aborts if no candidate fits both tolerance and size limits.
- Sampling settings matter: texture compression, mipmaps, resizing and filtering can change pixel edges. Point/Nearest is the intended crisp-pixel workflow. Smaller textures naturally limit zoomed-in fidelity.
- UV overlap is checked at output texel centers. Equal sampled colors may share a region; different required colors relocate the conflicting face to a cropped padded patch in the same atlas. Identical full patch buffers are reused. This is not a continuous-domain overlap proof. Uncorrected Mesh/Cube regions are protected at the same resolution.
- Static textures, loaded readable canvases and in-bounds UVs are required. Animated texture atlases and tiled UVs on affected textures are rejected. Layers within an affected texture are flattened only in the copy. Multi-texture layered render mode is rejected.
- Baking uses rest-pose authored geometry. Rigid group animation is preserved as source animation data; arbitrary per-vertex deformation may change the desired mapping and is not dynamically rebaked.
- Corrected quads become two explicit triangles using existing vertex keys. Copy UVs may be scaled/translated for atlases. Position-vertex and rendered-triangle counts are retained; authoring face count changes. Exporters may split rendering vertices at UV/normal boundaries, and non-planar face normals can change. All of this needs visual acceptance.
- The output is a portable bbmodel + PNG package, not a replacement implementation of every engine's model importer. Open the copy and use Blockbench's native export workflow. Engine/custom-exporter compatibility is not accepted yet.
- Originals are captured before asynchronous processing. Cancel/unload stops the job before the final save; original model/UV/texture data is not rewritten. Native project-serialization hooks from other plugins still run when taking the snapshot.
- Per-texture output budget: 16 million pixels, edge at most 4096; combined affected output budget: 64 million pixels.

[Nathan Reed's explanation](https://www.reedbeta.com/blog/quadrilateral-interpolation-part-2/) describes even spacing on the four edges and the possible curvature of diagonal lines. [AMD GPUOpen](https://gpuopen.com/learn/bilinear-interpolation-quadrilateral-barycentric-coordinates/) discusses quadrilateral interpolation and subdivision tradeoffs.

## Research scope / Chinese answers

2026-10-04：检索 Blockbench 官方插件目录、MTools 作者文档、公开 GitHub 与搜索引擎中的 bilinear/quad/UV distortion/trapezoid 相关结果。没有找到明确同时实现四角双线性映射、像素辅助线及绘画定位的现成 Blockbench 插件。这不构成全网不存在的证明，也不据此宣称全球首创。

“为什么没人做”没有获得开发者的一手解释。可能因素包括：传统 cuboid 工作流较少触发此问题；通用标准 UV 导出不携带这种映射；同步预览、格线、画笔与版本内部接口有维护成本。这些是技术推测。

Blender 可以处理：改变几何做合适的细分网格，或用自定义材质/OSL实现反双线性映射。普通矩形 UV 展开或把三角形合回四边形并不会自动改变内部插值。细分会增加渲染几何；自定义映射有渲染器、绘画工具与导出边界，和这个插件面对同一类取舍。这里没有制作或验收 Blender 实现。

来源：[官方插件目录](https://github.com/JannisX11/blockbench-plugins/blob/master/plugins.json)、[MTools](https://github.com/JannisX11/blockbench-plugins/blob/master/plugins/mesh_tools/about.md)、[Blender UV 操作](https://docs.blender.org/manual/en/4.2/modeling/meshes/editing/uv.html)、[Blender Script Node / OSL](https://docs.blender.org/manual/en/latest/render/shader_nodes/osl.html)。

### Shared-UV atlas details (0.2.1)

- A face is checked before any base-region writes. A conflict moves the whole face, avoiding partial compensation left behind for another face.
- Original texture space stays at the atlas origin. Independent patches are placed outside it; unused holes in the original bitmap are not repacked. Patches retain their sampled pixel phase, receive two output-pixel padding, and reuse exact identical buffers. This keeps existing regions stable at the cost of some unused space.
- Packing compares bounded candidate widths with a rectangle-partition heuristic. It is not a globally optimal packing guarantee and can refuse a layout near the image budget even if a different packing exists. Automatic scale is still selected for image quality, not total atlas area.
- Copy UV coordinates of all faces using the expanded texture are remapped while UV canvas dimensions stay fixed, including uncorrected Mesh/Cube faces. Box UV cubes sharing that texture switch to per-face UV in the copy when the format allows it; a format forcing Box UV stops with an explicit limitation.
- Static atlas dimensions account for Blockbench's aspect-ratio-based flipbook detection, avoiding accidental texture animation. This can add transparent unused space. Animated source textures remain unsupported.
- Padding reduces edge bleed but does not guarantee correctness for all mip levels, anisotropic/bilinear filtering or texture compression. Point/Nearest remains the intended pixel workflow.
- The final atlas size (including patches and padding) counts against image budgets. `relocatedFaces`, `uniqueConflictPatches`, `reusedPatch` and copy UV remapping are recorded in the bake report. Actual export/engine acceptance remains pending.

## Direct export and finer edges (0.3.0)

- Optional 1/16 and 1/32 sampled targets reduce raster steps. No finite PNG generally stores a sharp nonlinear quad map with exactly zero error at every zoom and view under ordinary nearest UV sampling. Coverage AA changes boundary colors; it is an appearance choice, not exact reconstruction.
- Native whole-project glTF/GLB, FBX and OBJ `export()` calls are wrapped while the toggle is enabled and corrected textured faces exist. Collection/partial export contexts and third-party direct `compile()` calls retain their original behavior. Wrappers are restored on unload when still owned.
- Compilation parses the detached baked bbmodel into a temporary native project, waits for embedded image canvases, compiles using native codecs, closes the temporary project and restores the source. No generated copy replaces the editing source. Texture/export settings, animations, selection/view restoration and cancellation require user acceptance.
- Saving uses captured model/texture contents after the temporary project closes. Desktop FBX/OBJ sibling images are saved automatically with unique copy names; OBJ MTL and a report accompany the model. glTF/GLB use embedded images. This is a multi-file write, not an atomic transaction across all files.
- Blockbench's glTF exporter normally forces embedded images to power-of-two sizes. During integrated export, or export of a recognized baked copy with this plugin loaded, the wrapper disables that resize. External exporters/importers or exports without the plugin can still resize images. This is separate from the bake estimate.
- The `benz_quad_uv_baked_copy` project marker persists only with the plugin loaded, similar to face correction flags. It changes neither engine geometry nor shader behavior.
- Web GLB/glTF use direct downloads; web FBX/OBJ retain a multi-file ZIP. Compiling via native glTF remains subject to native animation/skinning/exporter behavior, and cancellation may wait for compilation to return before restoring the source.
- Higher precision and optional coverage sampling increase CPU time and memory. Image budgets are 16 million pixels per affected atlas, a 4096-pixel edge, and 64 million combined affected pixels. These budgets do not account for every native exporter allocation.
