/*
 * Quad UV Fix for Blockbench 5.2.x
 * Copyright (c) 2026 BenzWood. SPDX-License-Identifier: MIT
 * Inverse bilinear derivation: Nathan Reed, Quadrilateral Interpolation, Part 2.
 * https://www.reedbeta.com/blog/quadrilateral-interpolation-part-2/
 * Source geometry and UVs are retained; baking fixes triangles only in a detached copy.
 */
(function () {
    'use strict';

    const ID = 'benz_quad_uv';
    const FLAG = 'benz_bilinear_uv';
    const BAKED_FLAG = 'benz_quad_uv_baked_copy';
    const ATTRS = ['benzQuadPoint', 'benzQuadBasis', 'benzQuadCurve', 'benzQuadUV01', 'benzQuadUV23'];
    const EPS = 1e-10;
    let alive = false;
    let previewToggle, directExportToggle, faceProperty, bakedProperty, gridMaterial;
    const actions = [], disposables = [], patches = [], managed = new Map();
    const materialCache = new Map(), originalMaterials = new WeakMap();
    const faceRecords = new WeakMap(), objectRecords = new WeakMap();
    const refreshGuard = new Set();
    const text = (zh, en) => typeof Language !== 'undefined' && /^zh/i.test(Language.code || '') ? zh : en;
    const hasMarkedFaces = element => Object.values(element.faces).some(face => face[FLAG]);
    const needsRefresh = element => hasMarkedFaces(element) || managed.has(element.mesh);
    const BAKE_VERSION = '0.3.0';
    const BAKE_SCALES = Array.from({length: 64}, (_, i) => i + 1);
    const BAKE_MAX_PIXELS = 16 * 1024 * 1024;
    let bakeJob;

    const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
    const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];
    const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
    const lerp = (a, b, t) => a + (b - a) * t;

    // All four corners are in perimeter order: 00, 10, 11, 01.
    function evaluate(corners, u, v) {
        return corners[0].map((_, axis) => lerp(
            lerp(corners[0][axis], corners[1][axis], u),
            lerp(corners[3][axis], corners[2][axis], u), v));
    }

    function describeQuad(corners) {
        if (corners.some(p => p.some(x => !Number.isFinite(x)))) return null;
        const scale = Math.max(...[0, 1].map(axis =>
            Math.max(...corners.map(p => p[axis])) - Math.min(...corners.map(p => p[axis]))));
        if (scale < EPS) return null;
        const p = corners.map(c => sub2(c, corners[0]).map(x => x / scale));
        let winding;
        for (let i = 0; i < 4; i++) {
            const turn = cross2(sub2(p[(i + 1) % 4], p[i]), sub2(p[(i + 2) % 4], p[(i + 1) % 4]));
            if (Math.abs(turn) < EPS || (winding && turn * winding < 0)) return null;
            winding = turn;
        }
        const b1 = p[1], b2 = p[3];
        const b3 = [p[2][0] - b1[0] - b2[0], p[2][1] - b1[1] - b2[1]];
        return {corners, p, scale, b1, b2, b3};
    }

    function inverse(quad, point) {
        const q = sub2(point, quad.corners[0]).map(x => x / quad.scale);
        const {b1, b2, b3} = quad;
        const a = cross2(b2, b3), b = cross2(b3, q) - cross2(b1, b2), c = cross2(b1, q);
        let roots;
        if (Math.abs(a) < EPS) {
            if (Math.abs(b) < EPS) return null;
            roots = [-c / b];
        } else {
            const d = b * b - 4 * a * c;
            if (d < -EPS) return null;
            const root = Math.sqrt(Math.max(0, d));
            const stable = -0.5 * (b + (b < 0 ? -root : root));
            roots = Math.abs(stable) < EPS ? [-b / (2 * a)] : [stable / a, c / stable];
        }
        let best, bestScore = Infinity;
        for (const v of roots) {
            const axis = [b1[0] + b3[0] * v, b1[1] + b3[1] * v];
            const length = dot2(axis, axis);
            if (length < EPS) continue;
            const u = dot2([q[0] - b2[0] * v, q[1] - b2[1] * v], axis) / length;
            if (!Number.isFinite(u + v)) continue;
            const outside = x => Math.max(0, -x) + Math.max(0, x - 1);
            const calculated = evaluate(quad.p, u, v);
            const residual = sub2(calculated, q);
            const score = outside(u) ** 2 + outside(v) ** 2 + dot2(residual, residual);
            if (score < bestScore) { best = [u, v]; bestScore = score; }
        }
        return best;
    }

    function barycentric(point, a, b, c) {
        const e1 = sub2(b, a), e2 = sub2(c, a), q = sub2(point, a);
        const determinant = cross2(e1, e2);
        if (Math.abs(determinant) < EPS) return null;
        const y = cross2(q, e2) / determinant, z = cross2(e1, q) / determinant;
        return [1 - y - z, y, z];
    }

    // Preserve the original two triangles even for mildly non-planar quads.
    // Only the texture coordinates use the projected four-corner mapping.
    function liftToSurface(record, point) {
        let tri = [0, 1, 2];
        let weights = barycentric(point, ...tri.map(i => record.projected[i]));
        if (!weights || weights.some(x => x < -1e-7)) {
            tri = [0, 2, 3];
            weights = barycentric(point, ...tri.map(i => record.projected[i]));
        }
        if (!weights) return null;
        return new THREE.Vector3(...[0, 1, 2].map(axis =>
            weights.reduce((sum, weight, i) => sum + weight * record.positions[tri[i]][axis], 0)));
    }

    function uvToSurface(record, uv) {
        const st = inverse(record.uvQuad, uv);
        return st && liftToSurface(record, evaluate(record.projected, ...st));
    }

    function surfaceToUV(record, point) {
        const array = point.toArray ? point.toArray() : point;
        const st = inverse(record.positionQuad, record.axes.map(axis => array[axis]));
        return st && evaluate(record.uvs, ...st);
    }

    function textureUV(face, uv) {
        const texture = face.getTexture();
        if (Project.view_mode === 'uv') return [uv[0] / Project.texture_width, 1 - uv[1] / Project.texture_height];
        const width = texture ? texture.getUVWidth() : Project.texture_width;
        const height = texture ? texture.getUVHeight() : Project.texture_height;
        const frames = texture?.frameCount > 1 ? texture.frameCount : 1;
        const frame = frames > 1 ? texture.currentFrame || 0 : 0;
        return [uv[0] / width, 1 - (uv[1] / height + frame) / frames];
    }

    function makeRecord(face, geometry, offset, triangleOffset) {
        if (face.vertices.length !== 4 || !face[FLAG]) return null;
        const index = geometry.index, position = geometry.attributes.position;
        if (!index || index.count < triangleOffset * 3 + 6) return null;
        // Read the actual render order rather than choosing a second diagonal.
        const ring = [0, 1, 2, 5].map(i => index.getX(triangleOffset * 3 + i) - offset);
        if (new Set(ring).size !== 4 || ring.some(i => i < 0 || i > 3)) return null;
        const keys = ring.map(i => face.vertices[i]);
        const uvs = keys.map(k => face.uv[k]?.slice());
        if (uvs.some(uv => !uv || uv.length !== 2)) return null;
        const positions = ring.map(i => [position.getX(offset + i), position.getY(offset + i), position.getZ(offset + i)]);
        const normal = [0, 0, 0];
        for (let i = 0; i < 4; i++) {
            const a = positions[i], b = positions[(i + 1) % 4];
            normal[0] += (a[1] - b[1]) * (a[2] + b[2]);
            normal[1] += (a[2] - b[2]) * (a[0] + b[0]);
            normal[2] += (a[0] - b[0]) * (a[1] + b[1]);
        }
        const drop = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
        const axes = [0, 1, 2].filter(i => i !== drop);
        const projected = positions.map(p => axes.map(i => p[i]));
        const positionQuad = describeQuad(projected), uvQuad = describeQuad(uvs);
        if (!positionQuad || !uvQuad) return null;
        return {face, keys, ring, positions, axes, projected, positionQuad, uvQuad, uvs, offset, triangleOffset};
    }

    const vertexDeclarations = `
attribute vec2 benzQuadPoint;
attribute vec4 benzQuadBasis;
attribute vec3 benzQuadCurve;
attribute vec4 benzQuadUV01;
attribute vec4 benzQuadUV23;
varying vec2 benzPoint;
varying vec4 benzBasis;
varying vec3 benzCurve;
varying vec4 benzUV01;
varying vec4 benzUV23;
`;
    const vertexAssignments = `
benzPoint = benzQuadPoint;
benzBasis = benzQuadBasis;
benzCurve = benzQuadCurve;
benzUV01 = benzQuadUV01;
benzUV23 = benzQuadUV23;
`;
    const fragmentDeclarations = `
varying vec2 benzPoint;
varying vec4 benzBasis;
varying vec3 benzCurve;
varying vec4 benzUV01;
varying vec4 benzUV23;
float benzCross(vec2 a, vec2 b) { return a.x*b.y-a.y*b.x; }
vec2 benzCandidate(float v) {
    vec2 axis = benzBasis.xy + benzCurve.xy * v;
    float u = dot(benzPoint - benzBasis.zw * v, axis) / max(dot(axis, axis), 1e-12);
    return vec2(u, v);
}
float benzScore(vec2 st) {
    vec2 outside = max(-st, vec2(0.0)) + max(st-vec2(1.0), vec2(0.0));
    vec2 error = benzBasis.xy*st.x + benzBasis.zw*st.y + benzCurve.xy*st.x*st.y - benzPoint;
    return dot(outside, outside) + dot(error, error);
}
vec2 benzMappedUV(vec2 fallback) {
    if (benzCurve.z < 0.5) return fallback;
    float a = benzCross(benzBasis.zw, benzCurve.xy);
    float b = benzCross(benzCurve.xy, benzPoint) - benzCross(benzBasis.xy, benzBasis.zw);
    float c = benzCross(benzBasis.xy, benzPoint);
    vec2 st;
    if (abs(a) < 1e-7) {
        if (abs(b) < 1e-9) return fallback;
        st = benzCandidate(-c/b);
    } else {
        float d = b*b - 4.0*a*c;
        if (d < -1e-7) return fallback;
        float root = sqrt(max(0.0, d));
        float stable = -0.5 * (b + (b < 0.0 ? -root : root));
        if (abs(stable) < 1e-9) {
            st = benzCandidate(-b/(2.0*a));
        } else {
            vec2 first = benzCandidate(stable/a);
            vec2 second = benzCandidate(c/stable);
            st = benzScore(first) <= benzScore(second) ? first : second;
        }
    }
    return mix(mix(benzUV01.xy, benzUV01.zw, st.x), mix(benzUV23.zw, benzUV23.xy, st.x), st.y);
}
`;

    function patchShader(material) {
        if (material.vertexShader.includes('attribute vec2 benzQuadPoint;')) return;
        const main = /void\s+main\s*\(\s*(?:void\s*)?\)\s*\{/;
        material.vertexShader = material.vertexShader.replace(main, match => vertexDeclarations + match + vertexAssignments);
        // Defining the alias inside main also covers texture reads in Three.js chunks.
        material.fragmentShader = material.fragmentShader.replace(main, match => fragmentDeclarations + match +
            '\nvec2 benzSampleUV = benzMappedUV(vUv);\n#define vUv benzSampleUV\n');
        material.needsUpdate = true;
    }

    function baseMaterial(material) { return originalMaterials.get(material) || material; }

    function supportsMaterial(material) {
        return material?.isShaderMaterial && /\bvUv\b/.test(material.vertexShader || '') &&
            /\bvUv\b/.test(material.fragmentShader || '') && /void\s+main\s*\(/.test(material.fragmentShader);
    }

    function mappedMaterial(source) {
        source = baseMaterial(source);
        if (!supportsMaterial(source)) return source;
        let clone = materialCache.get(source);
        if (!clone) {
            clone = source.clone();
            // Share live uniforms, including the texture. Never clone texture assets.
            clone.uniforms = source.uniforms;
            patchShader(clone);
            originalMaterials.set(clone, source);
            materialCache.set(source, clone);
        }
        clone.side = source.side;
        clone.map = source.map;
        clone.uniforms = source.uniforms;
        clone.transparent = source.transparent;
        clone.depthTest = source.depthTest;
        clone.depthWrite = source.depthWrite;
        clone.visible = source.visible;
        clone.clippingPlanes = source.clippingPlanes;
        return clone;
    }

    function restoreMaterials(object) {
        if (Array.isArray(object.material)) object.material = object.material.map(baseMaterial);
        else object.material = baseMaterial(object.material);
    }

    function materialForTriangle(object, triangle) {
        if (!Array.isArray(object.material)) return baseMaterial(object.material);
        const group = object.geometry.groups.find(g => triangle * 3 >= g.start && triangle * 3 < g.start + g.count);
        return baseMaterial(object.material[group?.materialIndex || 0]);
    }

    function active() {
        return alive && previewToggle?.value && typeof Project !== 'undefined' && Project &&
            ['textured', 'uv'].includes(Project.view_mode);
    }

    function recordsFor(element) {
        const object = element.mesh, geometry = object?.geometry;
        const records = new Map(), triangles = new Map();
        if (!geometry?.attributes.position || !active()) return {records, triangles};
        let offset = 0, triangle = 0;
        for (const face of Object.values(element.faces)) {
            faceRecords.delete(face);
            const count = face.vertices.length;
            if (count < 3) continue;
            if (offset + count > geometry.attributes.position.count) break;
            const record = makeRecord(face, geometry, offset, triangle);
            // Untextured faces may still show the corrected grid. Unsupported textured
            // materials fall back together, so picking never disagrees with rendering.
            if (record && (!face.getTexture() || supportsMaterial(materialForTriangle(object, triangle)))) {
                records.set(face, record);
                triangles.set(triangle, record);
                triangles.set(triangle + 1, record);
                faceRecords.set(face, record);
            }
            offset += count;
            triangle += count === 4 ? 2 : 1;
        }
        return {records, triangles};
    }

    function updateAttributes(object, records) {
        const geometry = object.geometry, count = geometry.attributes.position.count;
        const sizes = [2, 4, 3, 4, 4];
        const arrays = sizes.map(size => new Float32Array(count * size));
        for (const record of records.values()) {
            const {b1, b2, b3, p} = record.positionQuad;
            const density = Project.view_mode === 'uv'
                ? materialForTriangle(object, record.triangleOffset)?.uniforms?.DENSITY?.value || 1 : 1;
            const uv = record.uvs.map(value => textureUV(record.face, value).map(x => x * density));
            for (let corner = 0; corner < 4; corner++) {
                const index = record.offset + record.ring[corner];
                arrays[0].set(p[corner], index * 2);
                arrays[1].set([...b1, ...b2], index * 4);
                arrays[2].set([...b3, 1], index * 3);
                arrays[3].set([...uv[0], ...uv[1]], index * 4);
                arrays[4].set([...uv[2], ...uv[3]], index * 4);
            }
        }
        ATTRS.forEach((name, i) => geometry.setAttribute(name, new THREE.BufferAttribute(arrays[i], sizes[i])));
    }

    function manageObject(element) {
        const object = element.mesh;
        if (managed.has(object)) return;
        const previous = object.onBeforeRender;
        const wrapper = function (renderer, scene, camera, geometry, material, group) {
            if (previous) previous.call(this, renderer, scene, camera, geometry, material, group);
            // Blockbench 5.2's projected brushes use a separate GPU UV picking pass.
            // Correct that pass too without replacing its IDs or brush implementation.
            if (active() && objectRecords.get(this)?.records.size && material?.uniforms?.uMeshId && supportsMaterial(material)) {
                patchShader(material);
            }
        };
        object.onBeforeRender = wrapper;
        managed.set(object, {element, project: Project, previous, wrapper});
    }

    function releaseObject(object) {
        const state = managed.get(object);
        if (!state) return;
        restoreMaterials(object);
        ATTRS.forEach(name => object.geometry?.deleteAttribute(name));
        if (object.onBeforeRender === state.wrapper) object.onBeforeRender = state.previous;
        objectRecords.delete(object);
        for (const face of Object.values(state.element.faces)) faceRecords.delete(face);
        if (object.grid_box?.material === gridMaterial) {
            object.remove(object.grid_box);
            object.grid_box.geometry.dispose();
            delete object.grid_box;
        }
        managed.delete(object);
    }

    function refresh(element) {
        if (!element?.mesh?.geometry || refreshGuard.has(element)) return;
        if (!needsRefresh(element)) return;
        refreshGuard.add(element);
        try {
            const object = element.mesh;
            for (const face of Object.values(element.faces)) faceRecords.delete(face);
            const data = recordsFor(element);
            objectRecords.set(object, data);
            if (!data.records.size) {
                restoreMaterials(object);
                ATTRS.forEach(name => object.geometry.deleteAttribute(name));
                return;
            }
            manageObject(element);
            updateAttributes(object, data.records);
            object.material = Array.isArray(object.material)
                ? object.material.map(mappedMaterial) : mappedMaterial(object.material);
        } finally { refreshGuard.delete(element); }
    }

    function linePolygonIntersections(uvs, axis, coordinate) {
        const points = [];
        for (let i = 0; i < uvs.length; i++) {
            const a = uvs[i], b = uvs[(i + 1) % uvs.length];
            const delta = b[axis] - a[axis];
            if (Math.abs(delta) < EPS) continue;
            const t = (coordinate - a[axis]) / delta;
            if (t < -EPS || t > 1 + EPS) continue;
            const point = [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
            if (!points.some(p => Math.hypot(p[0] - point[0], p[1] - point[1]) < 1e-7)) points.push(point);
        }
        return points.sort((a, b) => a[1 - axis] - b[1 - axis]);
    }

    function appendSurfaceSegment(positions, record, a, b, offset) {
        const diagonal = sub2(record.projected[2], record.projected[0]);
        const segment = sub2(b, a), denominator = cross2(segment, diagonal);
        const points = [a];
        if (Math.abs(denominator) > EPS) {
            const t = cross2(sub2(record.projected[0], a), diagonal) / denominator;
            if (t > EPS && t < 1 - EPS) points.push(a.map((x, i) => lerp(x, b[i], t)));
        }
        points.push(b);
        for (let i = 1; i < points.length; i++) {
            const first = liftToSurface(record, points[i - 1]), second = liftToSurface(record, points[i]);
            if (first && second) positions.push(...first.add(offset).toArray(), ...second.add(offset).toArray());
        }
    }

    function appendGrid(positions, face, record, originalUVToLocal) {
        const texture = face.getTexture();
        const step = [texture ? texture.getUVWidth() / texture.width : 1,
            texture ? texture.getUVHeight() / texture.display_height : 1];
        const normal = new THREE.Vector3(...face.getNormal(true)).multiplyScalar(0.01);
        const keys = face.getSortedVertices();
        const polygons = record ? [keys] : keys.length === 3 ? [keys] : [keys.slice(0, 3), [keys[0], keys[2], keys[3]]];
        for (const polygon of polygons) {
            const uv = polygon.map(key => face.uv[key]);
            if (uv.some(p => !p)) continue;
            for (let axis = 0; axis < 2; axis++) {
                if (!(step[axis] > 0)) continue;
                const minimum = Math.min(...uv.map(p => p[axis])), maximum = Math.max(...uv.map(p => p[axis]));
                const start = Math.ceil(minimum / step[axis] - 1e-7), end = Math.floor(maximum / step[axis] + 1e-7);
                // Very dense grids should not freeze the editor. Texture rendering and
                // picking remain corrected; only this face's dense helper is omitted.
                if (end - start > 4096) continue;
                for (let i = start; i <= end; i++) {
                    const hits = linePolygonIntersections(uv, axis, i * step[axis]);
                    if (hits.length < 2) continue;
                    const a = hits[0], b = hits[hits.length - 1];
                    if (!record) {
                        positions.push(...originalUVToLocal.call(face, a, polygon).add(normal).toArray(),
                            ...originalUVToLocal.call(face, b, polygon).add(normal).toArray());
                        continue;
                    }
                    // Axis-aligned rectangular islands have straight iso-lines. General
                    // convex islands are sampled; split at the original 3D diagonal.
                    const divisions = Math.hypot(...record.uvQuad.b3) < EPS &&
                        Math.abs(record.uvQuad.b1[0] * record.uvQuad.b1[1]) < EPS ? 1 : 12;
                    let last;
                    for (let n = 0; n <= divisions; n++) {
                        const sample = a.map((value, j) => lerp(value, b[j], n / divisions));
                        const st = inverse(record.uvQuad, sample);
                        const point = st && evaluate(record.projected, ...st);
                        if (last && point) appendSurfaceSegment(positions, record, last, point, normal);
                        last = point;
                    }
                }
            }
        }
    }

    function drawGrid(element, originalGrid, originalUVToLocal) {
        refresh(element);
        const object = element.mesh, data = object && objectRecords.get(object);
        if (!data?.records.size) return originalGrid.call(Mesh.preview_controller, element);
        if (object.grid_box) {
            object.remove(object.grid_box);
            object.grid_box.geometry?.dispose();
            if (object.grid_box.material !== gridMaterial) object.grid_box.material?.dispose();
            delete object.grid_box;
        }
        if (!element.visibility || !((Modes.paint && settings.painting_grid.value) || (Modes.edit && settings.pixel_grid.value))) return;
        const positions = [];
        for (const face of Object.values(element.faces)) {
            if (face.vertices.length >= 3) appendGrid(positions, face, data.records.get(face), originalUVToLocal);
        }
        gridMaterial.color.copy(gizmo_colors.grid);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const grid = new THREE.LineSegments(geometry, gridMaterial);
        grid.no_export = true;
        grid.name = element.uuid + '_grid_box';
        grid.renderOrder = 2;
        grid.frustumCulled = false;
        object.grid_box = grid;
        object.add(grid);
        Mesh.preview_controller.dispatchEvent('update_painting_grid', {element});
    }

    function wrap(target, key, factory) {
        const previous = target[key];
        const wrapper = factory(previous);
        target[key] = wrapper;
        patches.push(() => { if (target[key] === wrapper) target[key] = previous; });
    }

    function refreshAll() {
        if (typeof Project === 'undefined' || !Project) return;
        for (const element of Mesh.all) {
            if (!needsRefresh(element)) continue;
            refresh(element);
            Mesh.preview_controller.updatePixelGrid(element);
        }
    }

    function selectedTargets() {
        const faceMode = BarItems.selection_mode?.value === 'face';
        return Mesh.selected.filter(mesh => !mesh.locked).map(mesh => {
            const selected = faceMode ? mesh.getSelectedFaces() : [];
            return {mesh, faces: faceMode ? selected.map(key => mesh.faces[key]).filter(Boolean) : Object.values(mesh.faces)};
        }).filter(target => target.faces.length);
    }

    function setSelectionEnabled(enabled) {
        const targets = selectedTargets();
        let count = 0, skipped = 0;
        const changed = targets.map(({mesh}) => mesh);
        if (!changed.length) return Blockbench.showQuickMessage(text('请先选中 Mesh；面模式下需要选中目标面。', 'Select a Mesh; in face mode, select the target faces first.'));
        Undo.initEdit({elements: changed});
        for (const {mesh, faces} of targets) {
            for (const face of faces) {
                if (face.vertices.length !== 4) { skipped++; continue; }
                if (enabled) {
                    const geometry = mesh.mesh?.geometry;
                    let offset = 0, triangle = 0, candidate;
                    for (const current of Object.values(mesh.faces)) {
                        if (current.vertices.length < 3) continue;
                        if (current === face) {
                            const wasEnabled = face[FLAG];
                            face[FLAG] = true;
                            candidate = geometry && makeRecord(face, geometry, offset, triangle);
                            face[FLAG] = wasEnabled;
                            break;
                        }
                        offset += current.vertices.length;
                        triangle += current.vertices.length === 4 ? 2 : 1;
                    }
                    if (!candidate) { skipped++; continue; }
                }
                if (!!face[FLAG] !== enabled) { face[FLAG] = enabled; count++; }
            }
        }
        if (count) Undo.finishEdit(enabled ? 'Enable Quad UV Fix' : 'Disable Quad UV Fix');
        else Undo.cancelEdit();
        if (enabled && !previewToggle.value) previewToggle.set(true);
        refreshAll();
        Blockbench.showQuickMessage(text(
            `${enabled ? '已启用' : '已取消'} ${count} 个面${skipped ? `，跳过 ${skipped} 个非有效凸四边形` : ''}。菜单“使用说明与当前状态”可查看实际生效数量。`,
            `${enabled ? 'Enabled' : 'Disabled'} ${count} faces${skipped ? `; skipped ${skipped} invalid/non-quad faces` : ''}. See Help & Status for the active count.`), 5000);
    }

    // Baking is isolated from the preview hooks. All reads are captured up front;
    // only the serialized copy and newly allocated image buffers are rewritten.
    function bakeFailure(zh, en) { throw new Error(text(zh, en)); }

    function safeBakeName(value) {
        return String(value || 'model').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'model';
    }

    function restBakeRecord(face) {
        const keys = face.getSortedVertices();
        const vertices = face.vertices.map(key => face.mesh.vertices[key]);
        const order = [0, 1, 2, 0, 2, 3].map(i => face.vertices.indexOf(keys[i]));
        if (vertices.some(p => !p) || order.some(i => i < 0)) return null;
        return makeRecord(face, {
            index: {count: 6, getX: i => order[i]},
            attributes: {position: {
                getX: i => vertices[i][0], getY: i => vertices[i][1], getZ: i => vertices[i][2]
            }}
        }, 0, 0);
    }

    function bakeTriangleAt(uvs, point) {
        for (let i = 1; i + 1 < uvs.length; i++) {
            const tri = [0, i, i + 1];
            const weights = barycentric(point, ...tri.map(index => uvs[index]));
            if (weights && weights.every(value => value >= -1e-8 && value <= 1 + 1e-8)) return {tri, weights};
        }
        return null;
    }

    function bakeSourceUV(record, point, hit = bakeTriangleAt(record.uvs, point)) {
        if (!hit) return null;
        const projected = [0, 1].map(axis => hit.weights.reduce((sum, weight, i) =>
            sum + weight * record.projected[hit.tri[i]][axis], 0));
        const st = inverse(record.positionQuad, projected);
        return st && evaluate(record.uvs, ...st);
    }

    function bakePixel(data, uv) {
        const x = Math.max(0, Math.min(data.width - 1, Math.floor(uv[0] * data.width / data.uvWidth)));
        const y = Math.max(0, Math.min(data.height - 1, Math.floor(uv[1] * data.height / data.uvHeight)));
        return data.pixels[y * data.width + x];
    }

    function bakeAlive(job) {
        if (!alive || job.cancelled) bakeFailure('烘焙已取消。', 'Baking cancelled.');
    }

    async function bakeYield(job) {
        bakeAlive(job);
        await new Promise(resolve => setTimeout(resolve, 0));
        bakeAlive(job);
    }

    async function rasterBakeUV(job, data, uvs, scale, visit) {
        const width = data.width * scale, height = data.height * scale;
        const sx = width / data.uvWidth, sy = height / data.uvHeight;
        const left = Math.max(0, Math.floor(Math.min(...uvs.map(p => p[0])) * sx));
        const right = Math.min(width, Math.ceil(Math.max(...uvs.map(p => p[0])) * sx));
        const top = Math.max(0, Math.floor(Math.min(...uvs.map(p => p[1])) * sy));
        const bottom = Math.min(height, Math.ceil(Math.max(...uvs.map(p => p[1])) * sy));
        let work = 0;
        for (let y = top; y < bottom; y++) {
            for (let x = left; x < right; x++) {
                const uv = [(x + 0.5) / sx, (y + 0.5) / sy];
                const hit = bakeTriangleAt(uvs, uv);
                if (hit && visit(y * width + x, uv, hit) === false) return false;
                if (++work % 4096 === 0) await bakeYield(job);
            }
        }
        await bakeYield(job);
        return true;
    }

    function snapshotBake() {
        if (Modes.animate) bakeFailure('请切到编辑或绘画模式再烘焙，使用模型休息姿态。', 'Switch to Edit or Paint mode to bake the rest pose.');
        if (typeof JSZip === 'undefined') bakeFailure('未找到 Blockbench 内置 ZIP 接口。', 'The bundled Blockbench ZIP API is unavailable.');
        const targets = [], dataByTexture = new Map();
        const readTexture = texture => {
            if (dataByTexture.has(texture)) return dataByTexture.get(texture);
            if (texture.render_mode === 'layered') bakeFailure(
                '烘焙暂不支持多贴图叠加渲染模式；单张贴图内部的图层可合并烘焙。',
                'Multi-texture layered render mode is unsupported. Layers within one texture can be flattened.');
            if (!texture.width || !texture.height || texture.error) bakeFailure(
                `贴图 ${texture.name} 尚未加载完成。`, `Texture ${texture.name} has not loaded successfully.`);
            if (texture.width * texture.height > BAKE_MAX_PIXELS ||
                !(texture.getUVWidth() > 0 && texture.getUVHeight() > 0)) bakeFailure(
                '原贴图超过单张 1600 万像素上限，或 UV 尺寸无效。', 'The source exceeds the 16-million-pixel limit or has invalid UV dimensions.');
            if (texture.frameCount > 1) bakeFailure('烘焙首版暂不处理动画贴图。', 'This baking version supports static textures only.');
            const image = texture.ctx.getImageData(0, 0, texture.width, texture.height);
            const data = {texture, name: texture.name, uuid: texture.uuid,
                width: texture.width, height: texture.height,
                uvWidth: texture.getUVWidth(), uvHeight: texture.getUVHeight(),
                pixels: new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.byteLength / 4),
                targets: [], protectedUVs: []};
            dataByTexture.set(texture, data);
            return data;
        };
        for (const mesh of Mesh.all) {
            if (mesh.export === false) continue;
            for (const [key, face] of Object.entries(mesh.faces)) {
                if (!face[FLAG] || !face.getTexture()) continue;
                const record = restBakeRecord(face);
                if (!record) bakeFailure(`无法烘焙 ${mesh.name}/${key}：需要有效凸四边形。`,
                    `Cannot bake ${mesh.name}/${key}: a valid convex quad is required.`);
                const data = readTexture(face.getTexture());
                const target = {record, meshUUID: mesh.uuid, key, label: `${mesh.name}/${key}`, data};
                data.targets.push(target);
                targets.push(target);
            }
        }
        if (!targets.length) bakeFailure('没有已启用修复且已分配贴图的面。请先启用目标面的修复。',
            'No enabled textured faces. Enable Quad UV Fix on the intended faces first.');
        const targetFaces = new Set(targets.map(target => target.record.face));
        for (const element of Outliner.elements) {
            if (element.export === false || !element.faces) continue;
            for (const [key, face] of Object.entries(element.faces)) {
                const data = dataByTexture.get(face.getTexture());
                if (!data) continue;
                let uvs;
                if (element instanceof Mesh) {
                    if (face.vertices.length < 3) continue;
                    uvs = face.getSortedVertices().map(vertex => face.uv[vertex]?.slice());
                } else if (Array.isArray(face.uv) && face.uv.length === 4) {
                    const [u0, v0, u1, v1] = face.uv;
                    uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
                } else bakeFailure('共享贴图包含暂不支持的面类型。', 'The shared texture has an unsupported face type.');
                if (uvs.some(uv => !uv || uv.some(value => !Number.isFinite(value)) ||
                    uv[0] < -1e-7 || uv[1] < -1e-7 || uv[0] > data.uvWidth + 1e-7 || uv[1] > data.uvHeight + 1e-7)) {
                    bakeFailure(`贴图 ${data.name} 的 ${element.name}/${key} 有越界或无效 UV，暂不支持平铺/越界烘焙。`,
                        `${data.name}: ${element.name}/${key} has invalid/out-of-bounds UVs. Tiled baking is not supported.`);
                }
                if (!targetFaces.has(face)) data.protectedUVs.push({uvs, label: `${element.name}/${key}`});
            }
        }
        // JSON clone also detaches project fields that native compile may return by reference.
        const model = JSON.parse(JSON.stringify(Codecs.project.compile({raw: true, bitmaps: true, absolute_paths: false})));
        for (const texture of model.textures) {
            delete texture.path;
            delete texture.relative_path;
        }
        return {targets, textures: [...dataByTexture.values()], model,
            name: safeBakeName(Project.name) + '_baked', cancelled: false, report: [],
            animatedTextures: !!Format.animated_textures, optionalBoxUV: !!Format.optional_box_uv,
            sourceProject: Project, format: Format};
    }

    async function measureBakeScale(job, data, scale, tolerance) {
        let maximumError = 0;
        const dx = 0.499 * data.uvWidth / (data.width * scale);
        const dy = 0.499 * data.uvHeight / (data.height * scale);
        for (const target of data.targets) {
            const record = target.record;
            const passed = await rasterBakeUV(job, data, record.uvs, scale, (index, uv, hit) => {
                const source = bakeSourceUV(record, uv, hit);
                if (!source) bakeFailure('四角映射反求失败。', 'Inverse quad mapping failed.');
                const color = bakePixel(data, source);
                for (const x of [-dx, dx]) for (const y of [-dy, dy]) {
                    const sample = bakeSourceUV(record, [uv[0] + x, uv[1] + y]);
                    if (!sample || bakePixel(data, sample) === color) continue;
                    // Estimate nearest-sample edge error in original texels, only
                    // where distinct source colors cross the output texel footprint.
                    const error = Math.max(Math.abs(sample[0] - source[0]) * data.width / data.uvWidth,
                        Math.abs(sample[1] - source[1]) * data.height / data.uvHeight);
                    maximumError = Math.max(maximumError, error);
                    if (maximumError > tolerance) return false;
                }
            });
            if (!passed) return {passed: false, maximumError};
        }
        return {passed: true, maximumError};
    }

    async function chooseBakeScale(job, data, settings) {
        const candidates = settings.scale === 'auto' ? BAKE_SCALES : [Number(settings.scale)];
        for (const scale of candidates) {
            if (data.width * data.height * scale * scale > BAKE_MAX_PIXELS ||
                Math.max(data.width, data.height) * scale > 4096) break;
            const result = await measureBakeScale(job, data, scale, Number(settings.tolerance));
            if (result.passed || settings.scale !== 'auto') return {scale, ...result};
        }
        bakeFailure(`贴图 ${data.name} 在倍率/尺寸上限内未满足边缘精度。可选择固定倍率输出，再手动判断效果。`,
            `${data.name}: no scale meets the edge tolerance within the size limits. A fixed scale can be exported for manual assessment.`);
    }

    function bakeColorAt(data, record, uv, hit) {
        const mapped = bakeSourceUV(record, uv, hit);
        if (!mapped) bakeFailure('四角映射反求失败。', 'Inverse quad mapping failed.');
        const center = bakePixel(data, mapped);
        if (!data.antialias) return center;
        const dx = data.uvWidth / (data.width * data.bakeScale);
        const dy = data.uvHeight / (data.height * data.bakeScale);
        let edge = false;
        for (const x of [-0.499, 0.499]) for (const y of [-0.499, 0.499]) {
            const sample = bakeSourceUV(record, [uv[0] + x * dx, uv[1] + y * dy]);
            if (sample && bakePixel(data, sample) !== center) edge = true;
        }
        if (!edge) return center;
        // Area coverage only on color boundaries. Premultiplied alpha avoids
        // dark halos; uniform interiors retain their original palette colors.
        let red = 0, green = 0, blue = 0, alpha = 0, count = 0;
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
            const sample = bakeSourceUV(record, [uv[0] + ((x + 0.5) / 4 - 0.5) * dx,
                uv[1] + ((y + 0.5) / 4 - 0.5) * dy]);
            if (!sample) continue;
            const color = bakePixel(data, sample), a = color >>> 24;
            red += (color & 255) * a; green += ((color >>> 8) & 255) * a;
            blue += ((color >>> 16) & 255) * a; alpha += a; count++;
        }
        if (!count) return center;
        if (!alpha) return 0;
        return ((Math.round(alpha / count) << 24) | (Math.round(blue / alpha) << 16) |
            (Math.round(green / alpha) << 8) | Math.round(red / alpha)) >>> 0;
    }

    async function makeBakePatch(job, data, target, scale) {
        const sx = data.width * scale / data.uvWidth, sy = data.height * scale / data.uvHeight;
        const pad = 2;
        const minX = Math.floor(Math.min(...target.record.uvs.map(uv => uv[0])) * sx);
        const minY = Math.floor(Math.min(...target.record.uvs.map(uv => uv[1])) * sy);
        const maxX = Math.max(minX + 1, Math.ceil(Math.max(...target.record.uvs.map(uv => uv[0])) * sx));
        const maxY = Math.max(minY + 1, Math.ceil(Math.max(...target.record.uvs.map(uv => uv[1])) * sy));
        const width = maxX - minX + pad * 2, height = maxY - minY + pad * 2;
        if (width > 4096 || height > 4096 || width * height > BAKE_MAX_PIXELS) bakeFailure(
            '冲突面的补偿区域超过尺寸上限。请减小固定倍率或原贴图尺寸。',
            'A conflict patch exceeds the size limit. Reduce the fixed scale or source texture size.');
        const pixels = new Uint32Array(width * height);
        for (let y = 0; y < height; y++) {
            // Extend the cropped rectangle's edge into its independent padding.
            const py = Math.max(minY, Math.min(maxY - 1, minY + y - pad));
            for (let x = 0; x < width; x++) {
                const px = Math.max(minX, Math.min(maxX - 1, minX + x - pad));
                const uv = [(px + 0.5) / sx, (py + 0.5) / sy];
                const hit = bakeTriangleAt(target.record.uvs, uv);
                pixels[y * width + x] = hit ? bakeColorAt(data, target.record, uv, hit) : bakePixel(data, uv);
            }
            if (y % 16 === 0) await bakeYield(job);
        }
        return {width, height, minX, minY, pad, pixels};
    }

    async function sameBakePatch(job, a, b) {
        if (a.width !== b.width || a.height !== b.height) return false;
        for (let i = 0; i < a.pixels.length; i++) {
            if (a.pixels[i] !== b.pixels[i]) return false;
            if (i && i % 65536 === 0) await bakeYield(job);
        }
        return true;
    }

    function packBakeWidth(baseWidth, baseHeight, patches, width) {
        const free = [];
        if (width > baseWidth) free.push({x: baseWidth, y: 0, width: width - baseWidth, height: baseHeight});
        if (baseHeight < 4096) free.push({x: 0, y: baseHeight, width, height: 4096 - baseHeight});
        const positions = new Map();
        let height = baseHeight;
        for (const patch of [...patches].sort((a, b) => b.width * b.height - a.width * a.height)) {
            let best = -1, score = Infinity;
            for (let i = 0; i < free.length; i++) {
                const rect = free[i];
                if (rect.width < patch.width || rect.height < patch.height) continue;
                const fit = Math.min(rect.width - patch.width, rect.height - patch.height);
                const value = fit * 16777216 + rect.width * rect.height - patch.width * patch.height;
                if (value < score) { score = value; best = i; }
            }
            if (best < 0) return null;
            const rect = free.splice(best, 1)[0];
            positions.set(patch, {x: rect.x, y: rect.y});
            height = Math.max(height, rect.y + patch.height);
            const dw = rect.width - patch.width, dh = rect.height - patch.height;
            if (dw > dh) {
                if (dw) free.push({x: rect.x + patch.width, y: rect.y, width: dw, height: rect.height});
                if (dh) free.push({x: rect.x, y: rect.y + patch.height, width: patch.width, height: dh});
            } else {
                if (dh) free.push({x: rect.x, y: rect.y + patch.height, width: rect.width, height: dh});
                if (dw) free.push({x: rect.x + patch.width, y: rect.y, width: dw, height: patch.height});
            }
        }
        return {width, height, positions};
    }

    async function packBakeAtlas(job, data, baseWidth, baseHeight, patches) {
        if (!patches.length) return {width: baseWidth, height: baseHeight, positions: new Map()};
        const area = baseWidth * baseHeight + patches.reduce((sum, patch) => sum + patch.width * patch.height, 0);
        if (area > BAKE_MAX_PIXELS) bakeFailure('共享 UV 的独立补偿区域超过单张图集预算。请减小固定倍率或原贴图尺寸。',
            'The independent UV patches exceed the atlas pixel budget. Reduce the fixed scale or source texture size.');
        const minimum = Math.max(baseWidth, ...patches.map(patch => patch.width));
        const maximum = Math.min(4096, baseWidth + patches.reduce((sum, patch) => sum + patch.width, 0));
        const widths = new Set([minimum, maximum, Math.max(minimum, Math.min(maximum, Math.ceil(Math.sqrt(area))))]);
        // Include useful strip widths, and bounded samples; never force power-of-two sizing.
        let strip = baseWidth;
        for (const patch of patches) {
            strip += patch.width;
            if (strip <= maximum) widths.add(strip);
            if (baseWidth + patch.width <= maximum) widths.add(baseWidth + patch.width);
        }
        for (let i = 0; i <= 32; i++) widths.add(Math.round(minimum + (maximum - minimum) * i / 32));
        let best;
        for (const width of [...widths].sort((a, b) => a - b)) {
            const layout = packBakeWidth(baseWidth, baseHeight, patches, width);
            // Native Blockbench interprets tall images relative to their UV
            // aspect ratio as flipbooks. Keep a static atlas from becoming one.
            if (layout && job.animatedTextures) layout.width = Math.max(layout.width,
                Math.ceil(layout.height * data.uvWidth / data.uvHeight));
            if (layout && layout.width <= 4096 && layout.width * layout.height <= BAKE_MAX_PIXELS &&
                (!best || layout.width * layout.height < best.width * best.height ||
                    (layout.width * layout.height === best.width * best.height &&
                     Math.max(layout.width, layout.height) < Math.max(best.width, best.height)))) best = layout;
            await bakeYield(job);
        }
        if (!best) bakeFailure('共享 UV 的补偿区域在图集尺寸上限内排不下。请减小固定倍率或原贴图尺寸。',
            'The UV patches do not fit within atlas size limits. Reduce the fixed scale or source texture size.');
        return best;
    }

    function applyBakedAtlasUVs(job, data, output) {
        const textureIndex = job.model.textures.findIndex(texture => texture.uuid === data.uuid);
        const relocations = new Map(output.relocations.map(item => [`${item.target.meshUUID}/${item.target.key}`, item]));
        const baseWidth = data.width * output.scale, baseHeight = data.height * output.scale;
        if (!output.relocations.length) return;
        for (const element of job.model.elements) {
            for (const [key, face] of Object.entries(element.faces || {})) {
                if (face.texture !== textureIndex && face.texture !== data.uuid) continue;
                if (element.box_uv) {
                    if (!job.optionalBoxUV) bakeFailure('共享图集中的 Box UV 方块需要支持逐面 UV 的格式。',
                        'A Box UV cube sharing the atlas requires a format with per-face UV support.');
                    element.box_uv = false;
                }
                const relocation = relocations.get(`${element.uuid}/${key}`);
                const dx = relocation?.dx || 0, dy = relocation?.dy || 0;
                // Keep the original UV canvas dimensions (also supports formats
                // using a shared project UV resolution). Remap only the copy.
                const mapUV = uv => [
                    (uv[0] * baseWidth / data.uvWidth + dx) * data.uvWidth / output.width,
                    (uv[1] * baseHeight / data.uvHeight + dy) * data.uvHeight / output.height
                ];
                if (Array.isArray(face.uv)) {
                    const a = mapUV(face.uv.slice(0, 2)), b = mapUV(face.uv.slice(2, 4));
                    face.uv = [...a, ...b];
                } else {
                    face.uv = Object.fromEntries(Object.entries(face.uv).map(([vertex, uv]) => [vertex, mapUV(uv)]));
                }
            }
        }
    }

    async function bakeTextureCopy(job, data, chosen) {
        const {scale} = chosen, width = data.width * scale, height = data.height * scale;
        data.bakeScale = scale;
        const image = new ImageData(width, height);
        const pixels = new Uint32Array(image.data.buffer), owners = new Int32Array(width * height);
        for (let y = 0; y < height; y++) {
            const sourceRow = Math.floor(y / scale) * data.width;
            for (let x = 0; x < width; x++) pixels[y * width + x] = data.pixels[sourceRow + Math.floor(x / scale)];
            if (y % 32 === 0) await bakeYield(job);
        }
        for (const face of data.protectedUVs) {
            await rasterBakeUV(job, data, face.uvs, scale, index => { owners[index] = -1; });
        }
        const patches = [], relocations = [];
        let reservedArea = width * height;
        for (let i = 0; i < data.targets.length; i++) {
            const target = data.targets[i];
            let conflict;
            // Inspect the entire face before writing anything, so moving a face
            // cannot leave half of its compensation behind in a shared region.
            await rasterBakeUV(job, data, target.record.uvs, scale, (index, uv, hit) => {
                const color = bakeColorAt(data, target.record, uv, hit), owner = owners[index];
                if (owner !== 0 && pixels[index] !== color) {
                    conflict = owner < 0 ? 'uncorrected face' : data.targets[owner - 1].label;
                    return false;
                }
            });
            if (conflict) {
                const patch = await makeBakePatch(job, data, target, scale);
                let shared;
                for (const previous of patches) {
                    if (await sameBakePatch(job, patch, previous)) { shared = previous; break; }
                }
                if (!shared) {
                    reservedArea += patch.width * patch.height;
                    if (reservedArea > BAKE_MAX_PIXELS) bakeFailure('共享 UV 的补偿图集超过单张像素预算。请减小固定倍率或原贴图尺寸。',
                        'The shared-UV atlas exceeds the pixel budget. Reduce the fixed scale or source texture size.');
                    patches.push(patch);
                }
                relocations.push({target, patch: shared || patch, minX: patch.minX, minY: patch.minY,
                    conflict, reused: !!shared});
                continue;
            }
            await rasterBakeUV(job, data, target.record.uvs, scale, (index, uv, hit) => {
                const owner = owners[index];
                const color = bakeColorAt(data, target.record, uv, hit);
                pixels[index] = color;
                if (owner === 0) owners[index] = i + 1;
            });
        }
        const layout = await packBakeAtlas(job, data, width, height, patches);
        let result = image;
        if (relocations.length) {
            result = new ImageData(layout.width, layout.height);
            const atlasPixels = new Uint32Array(result.data.buffer);
            for (let y = 0; y < height; y++) {
                atlasPixels.set(pixels.subarray(y * width, (y + 1) * width), y * layout.width);
                if (y % 32 === 0) await bakeYield(job);
            }
            for (const patch of patches) {
                const position = layout.positions.get(patch);
                for (let y = 0; y < patch.height; y++) {
                    atlasPixels.set(patch.pixels.subarray(y * patch.width, (y + 1) * patch.width),
                        (position.y + y) * layout.width + position.x);
                    if (y % 32 === 0) await bakeYield(job);
                }
            }
            for (const item of relocations) {
                const position = layout.positions.get(item.patch);
                item.dx = position.x + item.patch.pad - item.minX;
                item.dy = position.y + item.patch.pad - item.minY;
                item.region = [position.x, position.y, item.patch.width, item.patch.height];
            }
        }
        const canvas = document.createElement('canvas');
        canvas.width = layout.width; canvas.height = layout.height;
        canvas.getContext('2d').putImageData(result, 0, 0);
        const source = canvas.toDataURL('image/png');
        canvas.width = canvas.height = 1;
        return {source, width: layout.width, height: layout.height, scale, relocations,
            uniquePatches: patches.length};
    }

    function prepareBakedModel(job) {
        const elements = new Map(job.model.elements.map(element => [element.uuid, element]));
        for (const target of job.targets) {
            const mesh = elements.get(target.meshUUID), original = mesh?.faces?.[target.key];
            if (!original) bakeFailure('模型副本与面记录不一致。', 'The model copy does not match the captured face records.');
            const keys = target.record.keys;
            for (let i = 0; i < 2; i++) {
                const vertices = i === 0 ? [keys[0], keys[1], keys[2]] : [keys[0], keys[2], keys[3]];
                const copy = JSON.parse(JSON.stringify(original));
                copy.vertices = vertices;
                copy.uv = Object.fromEntries(vertices.map(key => [key, original.uv[key].slice()]));
                delete copy[FLAG];
                let faceKey = target.key;
                if (i) { faceKey += '_baked'; while (mesh.faces[faceKey]) faceKey += '_'; }
                mesh.faces[faceKey] = copy;
            }
        }
        for (const element of job.model.elements) {
            for (const face of Object.values(element.faces || {})) delete face[FLAG];
        }
        delete job.model.editor_state;
        job.model.name = job.name;
        job.model[BAKED_FLAG] = true;
        job.model.meta.quad_uv_bake = {version: BAKE_VERSION, textures: job.report};
        // Fixing the existing diagonal changes authoring face count, not vertices
        // or rendered triangle count. Importers cannot select a different diagonal.
    }

    async function compileBakedExport(job, codecID, options) {
        const codec = Codecs[codecID], sourceProject = job.sourceProject;
        if (!codec || !ModelProject.all.includes(sourceProject) || sourceProject.locked) bakeFailure(
            '原工程已关闭或被锁定，导出已停止。', 'The source project was closed or locked; export stopped.');
        let temporary;
        const originalLock = sourceProject.locked;
        try {
            if (Project !== sourceProject && !sourceProject.select()) throw new Error('Cannot select source project');
            const projectsBefore = new Set(ModelProject.all);
            try { setupProject(job.format); }
            finally { temporary = ModelProject.all.find(project => !projectsBefore.has(project)); }
            if (!temporary || Project !== temporary) throw new Error('Cannot create isolated export project');
            job.exportProject = temporary;
            // All image names are unique in this export copy, including unchanged
            // source images. Native FBX/OBJ material references use these names.
            for (let i = 0; i < job.model.textures.length; i++) {
                const texture = job.model.textures[i];
                texture.name = `${i}_${safeBakeName(texture.name).replace(/^\d+_/, '').replace(/\.\w+$/, '')}.png`;
                texture.keep_size = true;
                const affectedIndex = job.textures.findIndex(data => data.uuid === texture.uuid);
                if (affectedIndex >= 0) job.report[affectedIndex].output = codecID === 'gltf'
                    ? 'embedded:' + texture.name : texture.name;
            }
            Codecs.project.parse(job.model);
            Project.name = job.name;
            Project.save_path = '';
            Project.export_path = '';
            Project.view_mode = 'textured';
            temporary.locked = true;
            sourceProject.locked = true;
            await bakeYield(job);
            const deadline = Date.now() + 30000;
            while (Texture.all.some(texture => !texture.img.complete || !texture.img.naturalWidth ||
                texture.canvas.width !== texture.width || texture.canvas.height !== texture.height)) {
                bakeAlive(job);
                if (Texture.all.some(texture => texture.error) || Date.now() > deadline) bakeFailure(
                    '副本贴图未能加载，未写入导出文件。', 'Copy textures did not load; no export file was written.');
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            if (Texture.all.some(texture => texture.error)) throw new Error('Export copy has an unreadable texture');
            bakeAlive(job);
            Canvas.updateAll();
            const images = Texture.all.map(texture => ({name: texture.name,
                content: texture.getDataURL(), savetype: 'image'}));
            if (codecID === 'obj') {
                const result = await codec.compile({all_files: true, mtl_name: job.name + '.mtl'});
                return {extension: 'obj', content: result.obj, mtl: result.mtl, images};
            }
            if (codecID === 'gltf') {
                const content = await codec.compile({...options, embed_textures: true});
                return {extension: options.encoding === 'binary' ? 'glb' : 'gltf', content, images: []};
            }
            return {extension: codec.extension, content: await codec.compile(options), images};
        } finally {
            sourceProject.locked = originalLock;
            if (temporary) {
                temporary.locked = false;
                try { await temporary.close(true); }
                finally {
                    if (ModelProject.all.includes(sourceProject)) sourceProject.select();
                }
            }
            job.exportProject = null;
        }
    }

    async function saveBakedExport(job, codecID, output) {
        bakeAlive(job);
        const report = JSON.stringify({plugin: 'Quad UV Fix', author: 'BenzWood', version: BAKE_VERSION,
            facesBaked: job.targets.length, textureReports: job.report, antialias: job.antialias,
            qualityMethod: 'Sampled original-texel edge displacement; finite raster approximation, not engine validation.'}, null, 2);
        const message = () => job.report.map(item => `${item.texture}: ${item.scale}x → ${item.bakedSize.join(' × ')}`).join('\n');
        // The temporary project is already closed. Saving uses only captured
        // contents, so native save callbacks never read or modify the source.
        if (isApp) {
            Blockbench.export({type: Codecs[codecID].name, extensions: [output.extension],
                resource_id: 'benz_quad_uv_' + codecID, name: job.name, content: output.content,
                custom_writer: (content, path, done) => {
                    const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
                    const directory = path.slice(0, separator + 1);
                    const filename = path.slice(separator + 1);
                    const stem = filename.replace(/\.[^.]+$/, '');
                    if (output.mtl !== undefined) {
                        content = content.replace(/^mtllib .*$/m, 'mtllib ' + stem + '.mtl');
                        Blockbench.writeFile(directory + stem + '.mtl', {content: output.mtl});
                    }
                    for (const image of output.images) Blockbench.writeFile(directory + image.name, image);
                    Blockbench.writeFile(directory + stem + '.quad-uv-report.json', {content: report});
                    Blockbench.writeFile(path, {content}, done);
                }}, () => Blockbench.showMessageBox({title: text('烘焙模型已导出', 'Baked Model Exported'),
                    message: message() + '\n\n' + text('模型和需要的贴图已保存；原工程恢复，可继续绘画。',
                        'The model and required textures were saved. Continue painting in the restored source project.')}));
        } else if (!output.images.length) {
            Blockbench.export({type: Codecs[codecID].name, extensions: [output.extension],
                name: job.name, content: output.content, savetype: output.extension === 'glb' ? 'buffer' : 'text'});
        } else {
            // Browsers cannot write multiple arbitrary sibling files in one save.
            const archive = new JSZip();
            archive.file(job.name + '.' + output.extension, output.content);
            if (output.mtl !== undefined) archive.file(job.name + '.mtl', output.mtl);
            for (const image of output.images) archive.file(image.name, image.content.split(',')[1], {base64: true});
            archive.file(job.name + '.quad-uv-report.json', report);
            const bytes = await archive.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
            bakeAlive(job);
            Blockbench.export({type: 'Baked Model Assets', extensions: ['zip'], name: job.name, content: bytes, savetype: 'buffer'});
        }
    }

    async function runBake(settings) {
        if (bakeJob) return;
        let progress;
        const closeProgress = () => { if (progress) { progress.hide(); progress.delete(); progress = null; } };
        try {
            const job = snapshotBake();
            job.antialias = !!settings.antialias;
            bakeJob = job;
            progress = new Dialog({id: ID + '_baking', title: text('正在烘焙游戏副本', 'Baking Game Copy'),
                lines: [text('正在评估最小倍率并生成补偿贴图。原工程保留。', 'Evaluating the smallest scale and baking textures. The source project is retained.')],
                buttons: [text('取消', 'Cancel')], confirmIndex: -1, cancelIndex: 0,
                onCancel: () => { job.cancelled = true; return false; }}).show();
            await bakeYield(job);
            const archive = new JSZip();
            let totalPixels = 0;
            for (let i = 0; i < job.textures.length; i++) {
                const data = job.textures[i], chosen = await chooseBakeScale(job, data, settings);
                data.antialias = job.antialias;
                const output = await bakeTextureCopy(job, data, chosen);
                totalPixels += output.width * output.height;
                if (totalPixels > BAKE_MAX_PIXELS * 4) bakeFailure('本次总输出超过 6400 万像素上限。', 'The combined bake exceeds the 64-million-pixel limit.');
                applyBakedAtlasUVs(job, data, output);
                const textureCopy = job.model.textures.find(texture => texture.uuid === data.uuid);
                if (!textureCopy) bakeFailure('找不到模型副本中的贴图。', 'A texture is missing from the model copy.');
                const file = `${i}_${safeBakeName(data.name).replace(/\.\w+$/, '')}_baked.png`;
                Object.assign(textureCopy, {source: output.source, internal: true, saved: false,
                    name: file, width: output.width, height: output.height,
                    uv_width: data.uvWidth, uv_height: data.uvHeight, layers_enabled: false, keep_size: true});
                delete textureCopy.layers;
                delete textureCopy.path;
                delete textureCopy.relative_path;
                archive.file('textures/' + file, output.source.split(',')[1], {base64: true});
                job.report.push({texture: data.name, output: 'textures/' + file, scale: chosen.scale,
                    originalSize: [data.width, data.height], bakedSize: [output.width, output.height],
                    estimatedEdgeErrorTexels: chosen.maximumError, tolerance: Number(settings.tolerance),
                    withinEstimatedTolerance: chosen.passed, uniqueConflictPatches: output.uniquePatches,
                    relocatedFaces: output.relocations.map(item => ({face: item.target.label,
                        conflictsWith: item.conflict, atlasRegionPixels: item.region,
                        uvTranslationPixels: [item.dx, item.dy], reusedPatch: item.reused})),
                    copyUVsRescaledForAtlas: output.relocations.length > 0, edgeAntialias: job.antialias});
                Blockbench.setProgress((i + 1) / job.textures.length);
            }
            prepareBakedModel(job);
            if (settings.codec && settings.codec !== 'zip') {
                closeProgress();
                progress = new Dialog({id: ID + '_compile_baked', title: text('正在编译烘焙模型', 'Compiling Baked Model'),
                    lines: [text('使用临时副本编译，完成后恢复原工程。', 'Compiling an isolated copy; the source project is restored afterward.')],
                    buttons: [text('取消', 'Cancel')], confirmIndex: -1, cancelIndex: 0,
                    onCancel: () => { job.cancelled = true; return false; }}).show();
                // Close progress before save: native save/export UI owns its own
                // dialog state. Compilation remains protected by this modal.
                const output = await compileBakedExport(job, settings.codec, settings.native || {});
                bakeAlive(job);
                closeProgress();
                await saveBakedExport(job, settings.codec, output);
                return;
            }
            archive.file(job.name + '.bbmodel', JSON.stringify(job.model));
            archive.file('bake-report.json', JSON.stringify({plugin: 'Quad UV Fix', author: 'BenzWood', version: BAKE_VERSION,
                facesBaked: job.targets.length, textureReports: job.report,
                qualityMethod: 'Center and four footprint-corner samples; estimated original-texel edge displacement, not engine validation.'}, null, 2));
            archive.file('READ_ME.txt', text(
                '打开 *_baked.bbmodel，再按 Blockbench 原生流程导出 GLB/FBX/OBJ。使用副本中的补偿贴图。原工程用于继续绘画，每次修改后重新烘焙。\n共享 UV 需要不同颜色时，副本自动分配独立补偿区域；相同补偿区域可复用。图集扩展会同步换算副本 UV，原工程 UV 保留。\n副本将目标四边形固定为原来的两个三角面，不增加位置顶点或渲染三角形。矩形 UV 岛仍为矩形，但可能缩放和平移。\n引擎材质使用普通 UV；像素贴图使用 Point/Nearest 过滤，检查压缩、Mipmaps 和最大纹理尺寸。\n倍率是基于采样的误差估计，不是 Unity/Godot 已验收结果。详见 bake-report.json。',
                'Open *_baked.bbmodel, then export GLB/FBX/OBJ using Blockbench. Use the baked textures from the copy. Keep painting in the source project and rebake after edits.\nConflicting shared UVs are automatically assigned independent atlas patches; identical patches can be reused. Copy UVs are remapped for the expanded atlas. Source UVs are retained.\nCorrected quads use their two existing triangles without adding position vertices or rendered triangles. Rectangular islands remain rectangular, but may be scaled and translated.\nUse ordinary UV materials. For crisp pixels, use Point/Nearest sampling and review compression, mipmaps and texture size limits.\nScale is based on sampled error estimates, not Unity/Godot acceptance. See bake-report.json.'));
            const bytes = await archive.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
            bakeAlive(job);
            closeProgress();
            Blockbench.export({type: 'Quad UV Baked Game Copy', extensions: ['zip'], name: job.name,
                content: bytes, savetype: 'buffer'}, () => {
                Blockbench.showMessageBox({title: text('烘焙副本已导出', 'Baked Copy Exported'), icon: 'inventory_2',
                    message: job.report.map(item => `${item.texture}: ${item.scale}x → ${item.bakedSize.join(' × ')}; ` +
                        text(`自动分配 ${item.relocatedFaces.length} 个冲突面`, `${item.relocatedFaces.length} conflicting faces relocated`)).join('\n') + '\n\n' +
                    text('解压并打开 *_baked.bbmodel，检查普通预览后按原流程导出。原工程和贴图保留；游戏副本使用补偿图，目标面固定为原三角化。',
                        'Extract and open *_baked.bbmodel, inspect its native preview, then export normally. The source is retained; the game copy uses baked textures and fixed triangles.')});
            });
        } catch (error) {
            closeProgress();
            Blockbench.showMessageBox({title: text('烘焙未导出', 'Bake Not Exported'), icon: 'info', message: String(error.message || error)});
        } finally {
            closeProgress();
            Blockbench.setProgress(0);
            bakeJob = null;
        }
    }

    function showBakeDialog(codecID = 'zip') {
        if (bakeJob) return;
        const sourceProject = Project, codec = Codecs[codecID];
        let complete;
        const completion = new Promise(resolve => { complete = resolve; });
        const form = {
                scale: {label: text('贴图倍率', 'Texture Scale'), type: 'select', default: 'auto', options: {
                    auto: text('自动：优先最小倍率', 'Auto: smallest acceptable scale'),
                    ...Object.fromEntries([...BAKE_SCALES.slice(0, 16), 24, 32, 48, 64].map(scale => [scale, `${scale}x`]))}},
                tolerance: {label: text('边缘误差目标', 'Edge Error Target'), type: 'select', default: '0.0625', options: {
                    '0.25': text('均衡：约 1/4 原像素', 'Balanced: about 1/4 original texel'),
                    '0.125': text('精细：约 1/8 原像素', 'Fine: about 1/8 original texel'),
                    '0.0625': text('更精细：约 1/16 原像素（推荐）', 'Finer: about 1/16 original texel (recommended)'),
                    '0.03125': text('超精细：约 1/32 原像素', 'Finest: about 1/32 original texel')}},
                antialias: {label: text('边缘抗锯齿（仅边缘像素混色）', 'Edge antialiasing (mixed boundary pixels only)'),
                    type: 'checkbox', value: false}
        };
        if (codec) {
            const defaults = codec.getExportOptions();
            for (const [key, field] of Object.entries(codec.export_options || {})) {
                if (codecID === 'gltf' && key === 'embed_textures') continue;
                form['native_' + key] = {...field, value: defaults[key] ?? field.value};
                if (codecID === 'gltf' && key === 'encoding') form['native_' + key].value = defaults[key] || 'binary';
            }
        }
        const dialog = new Dialog({id: ID + '_bake_options',
            title: codec ? text('烘焙并导出：', 'Bake & Export: ') + codec.name : text('导出烘焙副本 ZIP', 'Export Baked Copy ZIP'),
            form,
            lines: [codec ? text('直接保存模型，原工程恢复。GLB/glTF 内嵌贴图；桌面 FBX/OBJ 自动保存伴随贴图。',
                'Save the model directly; the source is restored. GLB/glTF embed textures; desktop FBX/OBJ save sibling textures.') :
                text('导出 ZIP 副本供检查或备份。', 'Export a ZIP copy for inspection or backup.'),
                text('共享 UV 冲突自动分配补偿区域，仅调整副本。1/16、1/32 是采样误差目标，不是零误差保证；抗锯齿会混合边缘颜色。',
                    'Shared UV conflicts are resolved only in the copy. 1/16 and 1/32 are sampled targets, not zero-error guarantees. Antialiasing blends boundary colors.')],
            onConfirm: settings => {
                dialog.hide();
                if (Project !== sourceProject) { complete(); return false; }
                const native = {};
                for (const [key, value] of Object.entries(settings)) if (key.startsWith('native_')) native[key.slice(7)] = value;
                runBake({...settings, codec: codecID, native}).then(complete, complete);
                return false;
            }, onCancel: () => { complete(); }});
        dialog.show();
        return completion;
    }

    function showHelp() {
        let flagged = 0, corrected = 0;
        for (const element of Mesh.all) {
            flagged += Object.values(element.faces).filter(face => face[FLAG]).length;
            corrected += objectRecords.get(element.mesh)?.records.size || 0;
        }
        Blockbench.showMessageBox({title: text('四边形 UV 修复', 'Quad UV Fix'), icon: 'grid_on', message: text(
            `已标记 ${flagged} 个面，当前修复 ${corrected} 个面。\n\n` +
            '用法：选中 Mesh，或在面选择模式选中目标面，然后点击“启用选中面的修复”。\n' +
            '支持：普通纹理视图与 UV 棋盘视图；同步贴图、像素格线、画笔/吸管定位。原顶点数和 UV 坐标保持。\n' +
            '三角形、凹面、退化面以及不兼容材质自动沿用原效果。略不共面的四边形沿原三角面显示格线。\n' +
            '“修复预览”开关可以对比原效果，标记会随 bbmodel 保存。\n\n' +
            '原生模型导出自动烘焙默认启用：直接用文件菜单导出 glTF/GLB、FBX 或 OBJ。副本编译后恢复原工程；普通材质显示有限分辨率近似。关闭此开关则沿用原生导出，不携带修复映射。ZIP 副本用于检查或备份。',
            `Marked: ${flagged} faces. Active: ${corrected} faces.\n\n` +
            'Select a Mesh, or select target faces in face mode; choose Enable on Selection.\n' +
            'Supports Textured and UV views. Synchronizes texture preview, pixel grid and brush/picker coordinates without adding model vertices or changing authored UVs.\n' +
            'Invalid/concave/degenerate quads and incompatible materials use native behavior. Slightly non-planar quads follow the original triangles.\n' +
            'Toggle Preview to compare. Face flags are saved in bbmodel when the plugin is loaded.\n\n' +
            'Auto-bake Native Model Exports is enabled by default: use the File menu to export glTF/GLB, FBX or OBJ. An isolated copy is compiled, then the source restored. Ordinary materials display the finite raster approximation. Turn it off for native uncorrected export; ZIP copies are for inspection/backup.')});
    }

    function load() {
        alive = true;
        faceProperty = new Property(MeshFace, 'boolean', FLAG, {default: false, exposed: false});
        bakedProperty = new Property(ModelProject, 'boolean', BAKED_FLAG, {default: false, exposed: false});
        gridMaterial = new THREE.LineBasicMaterial({color: gizmo_colors.grid});
        previewToggle = new Toggle(ID + '_preview', {name: text('修复预览（关闭可对比原效果）', 'Preview (toggle to compare)'), icon: 'visibility',
            default: true, onChange: refreshAll});
        directExportToggle = new Toggle(ID + '_direct_export', {name: text('原生模型导出自动烘焙', 'Auto-bake Native Model Exports'),
            icon: 'file_download', default: true});
        actions.push(previewToggle,
            new Action(ID + '_enable', {name: text('启用选中面的修复', 'Enable on Selection'), icon: 'grid_on', condition: () => Mesh.selected.length > 0,
                click: () => setSelectionEnabled(true)}),
            new Action(ID + '_disable', {name: text('取消选中面的修复', 'Disable on Selection'), icon: 'grid_off', condition: () => Mesh.selected.length > 0,
                click: () => setSelectionEnabled(false)}),
            new Action(ID + '_help', {name: text('使用说明与当前状态', 'Help & Status'), icon: 'help_outline', click: showHelp}),
            new Action(ID + '_bake', {name: text('导出烘焙副本 ZIP（检查/备份）', 'Export Baked Copy ZIP (inspect/backup)'), icon: 'inventory_2',
                condition: () => !bakeJob && Mesh.all.some(hasMarkedFaces), click: () => showBakeDialog('zip')}),
            directExportToggle,
            new Action(ID + '_direct_glb', {name: text('烘焙并直接导出 GLB/glTF', 'Bake & Export GLB/glTF'), icon: 'file_download',
                condition: () => !bakeJob && Mesh.all.some(hasMarkedFaces), click: () => showBakeDialog('gltf')}));
        MenuBar.addAction({id: ID, name: text('四边形 UV 修复', 'Quad UV Fix'), icon: 'grid_on',
            children: [actions[1], actions[2], '_', previewToggle, directExportToggle, actions[6], actions[4], actions[3]]}, 'tools');

        for (const codecID of ['gltf', 'fbx', 'obj']) {
            const codec = Codecs[codecID];
            if (!codec || typeof codec.export !== 'function') continue;
            wrap(codec, 'export', previous => function (...args) {
                if (!alive || this.context || !directExportToggle.value || !Mesh.all.some(mesh => mesh.export !== false &&
                    Object.values(mesh.faces).some(face => face[FLAG] && face.getTexture()))) return previous.apply(this, args);
                if (bakeJob) return;
                return showBakeDialog(codecID);
            });
        }
        if (THREE.GLTFExporter?.prototype?.parse) wrap(THREE.GLTFExporter.prototype, 'parse', previous => function (input, done, options) {
            if (Project?.[BAKED_FLAG] || bakeJob?.exportProject === Project) options = {...options, forcePowerOfTwoTextures: false, maxTextureSize: Infinity};
            return previous.call(this, input, done, options);
        });
        wrap(Codecs.project, 'parse', previous => function (model, ...args) {
            const result = previous.call(this, model, ...args);
            if (model?.meta?.quad_uv_bake && Project) Project[BAKED_FLAG] = true;
            return result;
        });

        const originalUVToLocal = MeshFace.prototype.UVToLocal;
        wrap(MeshFace.prototype, 'UVToLocal', previous => function (uv, vertices) {
            const record = active() && faceRecords.get(this);
            // Explicit three-vertex calls belong to native triangle/grid algorithms.
            return record && (!vertices || vertices.length === 4) ? uvToSurface(record, uv) || previous.call(this, uv, vertices)
                : previous.call(this, uv, vertices);
        });
        wrap(MeshFace.prototype, 'localToUV', previous => function (point, vertices) {
            const record = active() && faceRecords.get(this);
            return record && (!vertices || vertices.length === 4) ? surfaceToUV(record, point) || previous.call(this, point, vertices)
                : previous.call(this, point, vertices);
        });
        wrap(MeshFace.prototype, 'texelToLocalMatrix', previous => function (uv, factor = [1, 1], truncated, vertices) {
            const record = active() && faceRecords.get(this);
            if (!record || (vertices && vertices.length !== 4)) return previous.call(this, uv, factor, truncated, vertices);
            const sample = truncated && truncated.every(Number.isFinite) ? truncated : uv;
            const origin = uvToSurface(record, sample);
            const x = uvToSurface(record, [sample[0] + factor[0], sample[1]]);
            const y = uvToSurface(record, [sample[0], sample[1] + factor[1]]);
            if (!origin || !x || !y) return previous.call(this, uv, factor, truncated, vertices);
            return new THREE.Matrix4().makeBasis(x.sub(origin), y.sub(origin), new THREE.Vector3(0, 0, 1)).setPosition(origin);
        });
        wrap(Mesh.preview_controller, 'updatePixelGrid', previous => function (element) {
            if (!alive) return previous.call(this, element);
            return drawGrid(element, previous, originalUVToLocal);
        });
        wrap(THREE.Mesh.prototype, 'raycast', previous => function (raycaster, intersects) {
            const start = intersects.length;
            const result = previous.call(this, raycaster, intersects);
            const data = active() && objectRecords.get(this);
            if (!data?.records.size) return result;
            for (let i = start; i < intersects.length; i++) {
                const hit = intersects[i], record = data.triangles.get(hit.faceIndex);
                if (!record || !hit.uv) continue;
                const uv = surfaceToUV(record, this.worldToLocal(hit.point.clone()));
                if (uv) hit.uv.fromArray(textureUV(record.face, uv));
            }
            return result;
        });
        // Native glTF exporters clone preview geometry, sometimes merging flagged
        // and ordinary meshes. Strip plugin-only attributes from those copies so
        // they have the same layout and retain the original standard UV export.
        wrap(THREE.BufferGeometry.prototype, 'clone', previous => function (...args) {
            const copy = previous.apply(this, args);
            if (alive && this.getAttribute(ATTRS[0])) ATTRS.forEach(name => copy.deleteAttribute(name));
            return copy;
        });
        wrap(Mesh.preview_controller, 'displayDeformation', previous => function (...args) {
            const result = previous.apply(this, args);
            if (alive && args[0] && needsRefresh(args[0])) { refresh(args[0]); this.updatePixelGrid(args[0]); }
            return result;
        });
        disposables.push(Mesh.preview_controller.on('setup update_geometry update_faces update_uv', ({element}) => refresh(element)));
        disposables.push(Mesh.preview_controller.on('remove', ({element}) => {
            for (const [object, state] of managed) if (state.element === element) releaseObject(object);
        }));
        const closeProject = ({project}) => {
            for (const [object, state] of managed) if (state.project === project) releaseObject(object);
        };
        Blockbench.on('close_project', closeProject);
        disposables.push({delete: () => Blockbench.removeListener('close_project', closeProject)});
        for (const event of ['select_project', 'load_project', 'change_view_mode', 'undo', 'redo', 'finish_edit', 'update_scene_shading']) {
            const callback = () => { if (alive) refreshAll(); };
            Blockbench.on(event, callback);
            disposables.push({delete: () => Blockbench.removeListener(event, callback)});
        }
        refreshAll();
    }

    function unload() {
        if (bakeJob) bakeJob.cancelled = true;
        alive = false;
        disposables.splice(0).forEach(item => item.delete());
        patches.splice(0).reverse().forEach(restore => restore());
        for (const object of managed.keys()) releaseObject(object);
        managed.clear();
        materialCache.forEach(material => material.dispose());
        materialCache.clear();
        gridMaterial?.dispose();
        faceProperty?.delete();
        bakedProperty?.delete();
        MenuBar.removeAction('tools.' + ID);
        actions.splice(0).forEach(action => action.delete());
        if (typeof Project !== 'undefined' && Project) Canvas.updatePixelGrid();
    }

    Plugin.register(ID, {title: 'Quad UV Fix / 四边形 UV 修复', author: 'BenzWood',
        description: 'Bilinear quad UV preview, painting and texture baking for ordinary game materials, without subdivision.',
        icon: 'grid_on', version: BAKE_VERSION, min_version: '5.2.0', variant: 'both',
        repository: 'https://github.com/BenzWood/blockbench-quad-uv-fix',
        bug_tracker: 'https://github.com/BenzWood/blockbench-quad-uv-fix/issues',
        tags: ['UV', 'Mesh', 'Painting'], onload: load, onunload: unload});
})();
