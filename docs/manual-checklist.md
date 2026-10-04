# Manual acceptance / 用户核对清单

## 0.3.0 direct export and quality additions

No editor or engine acceptance tests were run; user verification is pending.

- [ ] Reload 0.3.0. File → Export → glTF/GLB, FBX and OBJ show combined native/bake options when corrected faces exist. Turning auto-bake off restores native behavior.
- [ ] Auto scale accepts 1/16 and 1/32. Compare the beige pattern edges at the same camera and zoom; higher precision reduces tiny raster steps without claiming exactly zero error.
- [ ] Coverage AA affects detected color boundaries while flat interiors remain unchanged. Compare the mixed boundary colors against hard-palette mode.
- [ ] Desktop GLB/glTF save directly with embedded textures. FBX/OBJ save model, required PNGs, MTL for OBJ and report beside the chosen model path; no bbmodel extraction step.
- [ ] Source tab, mode, selection, animation state, original UVs, original PNG and unsaved editing state are restored after export, cancellation or failure; temporary export tab is closed.
- [ ] GLB contains native-size baked images, including non-power-of-two atlases. Engine importer maximum size/compression/filter settings retain the intended fidelity.
- [ ] Shared-UV relocation, animation export, multi-texture names and existing non-corrected models remain correct.
- [ ] ZIP backup workflow still works. Partial/collection and third-party compile-based exporters retain their original workflows.

Use a model copy for acceptance. The list below is pending unless a user records their result. No automated tests are included or executed.

已知反馈：作者确认 0.1.0 在当前梯形腿案例有效；未据此推断所有操作已通过。0.1.1 的菜单、选择保护和刷新改动需重新确认。

## 0.2.1 baking acceptance / 烘焙核对

- [ ] Reload version 0.2.1; Export Baked Game Copy appears in the Tools submenu.
- [ ] Keep an original model copy; enable intended textured faces and bake with Auto/Balanced in Edit/Paint mode.
- [ ] ZIP contains a self-contained `*_baked.bbmodel`, PNGs and `bake-report.json`; chosen scales and sizes are reasonable, starting from the smallest candidate.
- [ ] Original image dimensions, layers, UV coordinates, model vertices and animation data are retained after baking and cancellation.
- [ ] Open the baked copy; its native preview approximates the original corrected preview without re-enabling the plugin flags.
- [ ] Corrected faces have fixed triangles; no new position vertices or rendered triangles; rectangular UV islands remain rectangular; copy UV placement/size may change. Check non-planar face shading.
- [ ] Export the copy with the actual GLB/FBX/OBJ workflow; inspect ordinary-material results in your engine using the intended Point/Nearest sampling and importer size/compression settings.
- [ ] Compare Auto against a smaller fixed scale if desired; assess whether the estimated tolerance is sufficient at the actual game camera distance. Do not treat the report as engine validation.
- [ ] The previously conflicting Leg_L_Front_Geometry/V0vDD6T1 and ntCeirvU export automatically into one affected atlas, without manually moving source UVs. Inspect both sides and confirm uncorrected faces keep their appearance.
- [ ] Multi-texture, mirrored UV, alpha edges, reload, cancel and plugin unload behave correctly. Animated textures/out-of-bounds UVs show the documented limitation.

The following list covers preview/lifecycle acceptance.

- [ ] Load plugin; Tools menu appears; author is BenzWood; Chinese/English labels match the interface language.
- [ ] Enable a whole planar trapezoid with rectangular UV; compare Preview on/off; actual pixel boundaries and helper lines agree.
- [ ] Authored vertex/face count, UV island position and existing texture content are retained.
- [ ] In face mode, no face selected changes nothing; one selected face does not enable the other faces. Locked Meshes are skipped.
- [ ] Size-1 brush/picker agrees with pixels near the top, middle, bottom and old triangle diagonal.
- [ ] Disable, undo/redo, save/reopen with the plugin loaded restore the expected state.
- [ ] UV mirroring/rotation, moving vertices and multiple textures update as expected.
- [ ] Transparent pixels, texture animation, mirror painting and larger brush modes work for your workflow.
- [ ] Mesh deformation/animation and switching between multiple projects remain usable.
- [ ] Ordinary unmarked Meshes, Cubes and existing plugins retain their expected behavior.
- [ ] UV-checker and native PBR/other-view fallback behave as documented; Help & Status explains active counts.
- [ ] Standard export completes; exported appearance is assessed with the documented mapping limitation.
- [ ] Unloading restores native preview, grid and painting behavior.

If reporting a failure, record Blockbench/plugin version, exact steps, selection/view mode, marked/active count and a minimal shareable model. Distinguish helper-line glitches from actual texture or paint-coordinate errors.

## Shared UV acceptance additions

- [ ] Source overlapping UVs and original PNG dimensions/content remain unchanged after success or cancellation.
- [ ] Different required colors get independent regions; compatible overlaps remain shared and identical relocated patches reuse a region.
- [ ] Report includes final atlas dimensions, relocated faces, patch counts, offsets and reuse. Chosen scale and atlas enlargement are separate concepts.
- [ ] Open the copy without re-enabling correction: formerly conflicting faces, alpha edges, mirrored directions and neighbors look correct.
- [ ] Expanded static atlases are not treated as flipbook animations. Check textured Cubes sharing the texture, including Box UV cubes if present.
- [ ] Texture/memory budgets, cancellation and ordinary native export still work for the actual project.
