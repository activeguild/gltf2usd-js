// glTF → USD IR (src/ir.js).
// References: USD schemas (UsdGeom, UsdShade), UsdPreviewSurface spec.
//
// Output layout:
//   /Root                     (Xform, defaultPrim)
//   /Root/Scene/<Node>/...    (Xform hierarchy; one Mesh prim per glTF primitive)
//   /Root/Meshes/<Mesh>       (class; prototypes of meshes used by several nodes,
//                              referenced from the nodes as instanceable prims)
//   /Root/Materials/<Mat>     (Material + UsdPreviewSurface + UsdUVTexture shaders)

import { Layer, Prim } from "./ir.js";
import { DataUnavailableError } from "./glb.js";
import { sanitize, uniqueName } from "./names.js";
import { composeTRS } from "./math.js";

export { sanitize };
import { evaluateAnimation, TIME_CODES_PER_SECOND } from "./animation.js";
import { planSkins, buildSkeleton, skinningPrimvars, NO_JOINTS } from "./skin.js";
import { addBlendShapes, meshHasTargets, restWeights } from "./morph.js";

const MODE_NAMES = ["POINTS", "LINES", "LINE_LOOP", "LINE_STRIP", "TRIANGLES", "TRIANGLE_STRIP", "TRIANGLE_FAN"];
const MODE_TRIANGLES = 4;
const MODE_TRIANGLE_STRIP = 5;
const MODE_TRIANGLE_FAN = 6;

// glTF sampler wrap modes → UsdUVTexture wrapS / wrapT tokens.
const WRAP_MODES = { 33071: "clamp", 33648: "mirror", 10497: "repeat" };

// glTF extensions whose data the converter uses. Anything else in
// extensionsUsed is reported through options.onWarning.
const SUPPORTED_EXTENSIONS = new Set([
  "KHR_texture_transform",
  "KHR_materials_emissive_strength",
  "KHR_materials_ior",
  "KHR_materials_clearcoat",
  // Quantized attributes are ordinary (normalized) integer accessors plus node transforms;
  // verified against three.js with gltf-transform-quantized DamagedHelmet / CesiumMan.
  "KHR_mesh_quantization",
  "KHR_materials_unlit",
  "KHR_lights_punctual",
]);

/** USD primvar name for glTF TEXCOORD_n: st, st1, st2, ... */
const uvSetName = (n) => (n === 0 ? "st" : `st${n}`);

/**
 * @param {import("./glb.js").GltfAsset} asset
 * @param {object} [options]  see src/index.js
 * @returns {{ layer: Layer, files: {name: string, bytes: Uint8Array}[] }}
 */
export function gltfToStage(asset, options = {}) {
  const ctx = {
    asset,
    json: asset.json,
    texturePrefix: options.texturePrefix ?? "textures/",
    files: [],            // extra files to package: { name, bytes }
    imageNames: new Map(), // image index -> file name
    usedFileNames: new Set(),
    warn: makeWarn(options.onWarning),
  };
  reportUnsupported(ctx);
  ctx.animation = evaluateAnimation(ctx, options.animation ?? 0);

  const layer = new Layer({
    defaultPrim: "Root",
    metersPerUnit: 1,
    upAxis: "Y",
    doc: `Converted from glTF${generatorNote(ctx.json)}`,
  });
  if (ctx.animation) {
    Object.assign(layer.metadata, {
      startTimeCode: ctx.animation.startTimeCode,
      endTimeCode: ctx.animation.endTimeCode,
      timeCodesPerSecond: TIME_CODES_PER_SECOND,
      framesPerSecond: TIME_CODES_PER_SECOND,
    });
  }
  const root = layer.add(new Prim("Xform", "Root", { spaced: true }));

  // Scene / node hierarchy
  const scene = ctx.json.scenes?.[ctx.json.scene ?? 0];
  const rootNodes = scene ? scene.nodes || [] : (ctx.json.nodes || []).map((_, i) => i);
  const sceneNodes = collectSceneNodes(ctx, rootNodes);
  ctx.skinNames = new Set();
  ctx.skins = planSkins(ctx, sceneNodes);
  ctx.skinnedNodes = new Set([...ctx.skins.values()].flatMap((p) => p.users));
  ctx.prototypes = planPrototypes(ctx, sceneNodes, options.instancing ?? true);
  const scenePrim = root.child(new Prim("Xform", "Scene"));
  const usedNames = new Set();
  for (const nodeIndex of rootNodes) buildNode(ctx, scenePrim, nodeIndex, usedNames, "/Root/Scene");

  // Skinned meshes: one SkelRoot per skin, holding the Skeleton, its animation
  // and the meshes (whose node transforms glTF ignores when skinning).
  if (ctx.skins.size) {
    const skins = root.child(new Prim("Scope", "Skins"));
    for (const plan of ctx.skins.values()) {
      const skelRoot = skins.child(new Prim("SkelRoot", plan.name));
      const skelRootPath = `/Root/Skins/${plan.name}`;
      const shapes = [];
      const names = new Set(["Skeleton", "Animation"]);
      for (const nodeIndex of plan.users) {
        buildMeshPrims(ctx, skelRoot, ctx.json.nodes[nodeIndex].mesh, names, { plan, skelRootPath, shapes, node: nodeIndex });
      }
      buildSkeleton(ctx, plan, skelRoot, skelRootPath, shapes, (nd) => restWeights(ctx, nd));
      skelPrimsFirst(skelRoot);
    }
  }

  // Prototypes for meshes shared by several nodes. `class` keeps them out of
  // the rendered scene; nodes reference them as instanceable prims.
  if (ctx.prototypes.size) {
    const meshes = root.child(new Prim("Xform", "Meshes", { specifier: "class" }));
    for (const [meshIndex, protoName] of ctx.prototypes) {
      buildMeshPrims(ctx, meshes.child(new Prim("Xform", protoName)), meshIndex, new Set());
    }
  }

  // Materials
  const materials = ctx.json.materials || [];
  if (materials.length) {
    const scope = root.child(new Prim("Scope", "Materials"));
    materials.forEach((mat, i) => buildMaterial(ctx, scope, mat, i));
  }

  return { layer, files: ctx.files };
}

// ---------- Warnings ----------

/** Deduplicated warning sink; a no-op when the caller passes no onWarning. */
function makeWarn(onWarning) {
  const seen = new Set();
  return (msg) => {
    if (typeof onWarning !== "function" || seen.has(msg)) return;
    seen.add(msg);
    onWarning(msg);
  };
}

/** Report document-level features that the converter drops. */
function reportUnsupported(ctx) {
  const { json, warn } = ctx;
  for (const ext of json.extensionsUsed || []) {
    if (SUPPORTED_EXTENSIONS.has(ext)) continue;
    const required = (json.extensionsRequired || []).includes(ext);
    warn(`Extension ${ext}${required ? " (required)" : ""} is not supported; its data is ignored`);
  }
  if ((json.scenes?.length ?? 0) > 1) warn(`glTF has ${json.scenes.length} scenes; only scene ${json.scene ?? 0} is converted`);
  if (json.cameras?.length) warn(`${json.cameras.length} camera(s) are not supported yet and were skipped`);
}

// ---------- Nodes ----------

function buildNode(ctx, parent, nodeIndex, siblingNames, parentPath) {
  const node = ctx.json.nodes[nodeIndex];
  const name = uniqueName(sanitize(node.name, `Node_${nodeIndex}`), siblingNames);
  const path = `${parentPath}/${name}`;
  const xform = parent.child(new Prim("Xform", name));
  const channels = ctx.animation?.nodes.get(nodeIndex);
  if (channels) {
    writeAnimatedTRS(xform, node, channels);
  } else {
    const m = nodeMatrix(node);
    if (m) {
      xform.attr("matrix4d", "xformOp:transform", m);
      xform.attr("token[]", "xformOpOrder", ["xformOp:transform"], { uniform: true });
    }
  }

  // Mesh prims and child nodes share one namespace under this Xform.
  const names = new Set();
  if (node.mesh !== undefined && !ctx.skinnedNodes.has(nodeIndex)) {
    const protoName = ctx.prototypes.get(node.mesh);
    if (meshHasTargets(ctx.json.meshes[node.mesh])) {
      // Blend shapes need a SkelRoot + Skeleton (without joints) + SkelAnimation for the weights.
      const mesh = ctx.json.meshes[node.mesh];
      const rootName = uniqueName(sanitize(mesh.name, `Mesh_${node.mesh}`), names);
      const skelRootPath = `${path}/${rootName}`;
      const skelRoot = xform.child(new Prim("SkelRoot", rootName));
      const shapes = [];
      buildMeshPrims(ctx, skelRoot, node.mesh, new Set(["Skeleton", "Animation"]), { plan: null, skelRootPath, shapes, node: nodeIndex });
      buildSkeleton(ctx, NO_JOINTS, skelRoot, skelRootPath, shapes, (nd) => restWeights(ctx, nd));
      skelPrimsFirst(skelRoot);
    } else if (protoName) {
      const mesh = ctx.json.meshes[node.mesh];
      const instName = uniqueName(sanitize(mesh.name, `Mesh_${node.mesh}`), names);
      xform.child(new Prim("Xform", instName, {
        metadata: { instanceable: true, "prepend references": { path: `/Root/Meshes/${protoName}` } },
      }));
    } else {
      buildMeshPrims(ctx, xform, node.mesh, names);
    }
  }

  const lightIndex = node.extensions?.KHR_lights_punctual?.light;
  if (lightIndex !== undefined) buildLight(ctx, xform, lightIndex, names);

  for (const child of node.children || []) buildNode(ctx, xform, child, names, path);
}

/**
 * One Mesh prim per glTF primitive.
 * `skel` binds the meshes to a Skeleton in a SkelRoot:
 *   { plan: SkinPlan | null, skelRootPath, shapes: collected blend shapes, node: glTF node (for weights) }
 */
function buildMeshPrims(ctx, parent, meshIndex, names, skel = null) {
  const mesh = ctx.json.meshes[meshIndex];
  const base = sanitize(mesh.name, `Mesh_${meshIndex}`);
  (mesh.primitives || []).forEach((prim, pi) => {
    const primName = uniqueName(mesh.primitives.length > 1 ? `${base}_${pi}` : base, names);
    buildMeshPrim(ctx, parent, prim, primName, skel, mesh);
  });
}

/**
 * KHR_lights_punctual → UsdLux. Both shine along the node's -Z axis.
 * UsdLux does not pin intensity to photometric units; DistantLight's fallback of
 * 50000 "approximates sunlight", so glTF lux (directional) and candela (point /
 * spot) are copied as-is. Spot cones use ShapingAPI: angle = outer cone,
 * softness = (outer - inner) / outer.
 */
function buildLight(ctx, xform, index, names) {
  const light = ctx.json.extensions?.KHR_lights_punctual?.lights?.[index];
  if (!light) {
    ctx.warn(`KHR_lights_punctual: light ${index} does not exist; ignored`);
    return;
  }
  const name = uniqueName(sanitize(light.name, `Light_${index}`), names);
  const color = light.color ?? [1, 1, 1];
  const intensity = light.intensity ?? 1;
  if (light.range !== undefined) ctx.warn(`Light "${name}": range has no UsdLux equivalent; ignored`);
  let prim;
  if (light.type === "directional") {
    prim = xform.child(new Prim("DistantLight", name));
  } else if (light.type === "point" || light.type === "spot") {
    const spot = light.type === "spot";
    prim = xform.child(new Prim("SphereLight", name, { metadata: spot ? { "prepend apiSchemas": ["ShapingAPI"] } : {} }));
    prim.attr("bool", "treatAsPoint", true);
    prim.attr("float", "inputs:radius", 0);
    if (spot) {
      const outer = light.spot?.outerConeAngle ?? Math.PI / 4;
      const inner = light.spot?.innerConeAngle ?? 0;
      prim.attr("float", "inputs:shaping:cone:angle", (outer * 180) / Math.PI);
      prim.attr("float", "inputs:shaping:cone:softness", outer > 0 ? Math.min(1, Math.max(0, (outer - inner) / outer)) : 0);
    }
  } else {
    ctx.warn(`Light "${name}": unknown type ${light.type}; ignored`);
    return;
  }
  prim.attr("color3f", "inputs:color", color);
  prim.attr("float", "inputs:intensity", intensity);
}

/** Skeleton and SkelAnimation first in a SkelRoot (readability only). */
function skelPrimsFirst(skelRoot) {
  const rank = (p) => ({ Skeleton: 0, SkelAnimation: 1 })[p.type] ?? 2;
  skelRoot.children.sort((a, b) => rank(a) - rank(b));
}

/** Every node reachable from the scene roots, each once (guards against cycles). */
function collectSceneNodes(ctx, rootNodes) {
  const out = [];
  const visited = new Set();
  const visit = (i) => {
    if (visited.has(i) || !ctx.json.nodes?.[i]) return;
    visited.add(i);
    out.push(i);
    for (const c of ctx.json.nodes[i].children || []) visit(c);
  };
  rootNodes.forEach(visit);
  return out;
}

/**
 * Meshes referenced by more than one node in the scene get a prototype under
 * /Root/Meshes. Returns Map<meshIndex, prototypeName> in mesh index order.
 */
function planPrototypes(ctx, sceneNodes, enabled) {
  const prototypes = new Map();
  if (!enabled) return prototypes;
  const uses = new Map();
  for (const i of sceneNodes) {
    const node = ctx.json.nodes[i];
    // Skinned and morphed meshes are bound per node, so they are not instanced.
    if (node.mesh === undefined || ctx.skinnedNodes.has(i) || meshHasTargets(ctx.json.meshes[node.mesh])) continue;
    uses.set(node.mesh, (uses.get(node.mesh) ?? 0) + 1);
  }
  const used = new Set();
  [...uses.keys()].sort((a, b) => a - b).forEach((meshIndex) => {
    if (uses.get(meshIndex) < 2) return;
    const mesh = ctx.json.meshes[meshIndex];
    prototypes.set(meshIndex, uniqueName(sanitize(mesh.name, `Mesh_${meshIndex}`), used));
  });
  return prototypes;
}

/**
 * Animated nodes use separate translate / orient / scale ops (USD composes
 * xformOpOrder left to right as outer to inner: T · R · S, like glTF).
 * Channels without animation keep the node's static value.
 */
function writeAnimatedTRS(xform, node, channels) {
  const wxyz = ([x, y, z, w]) => [w, x, y, z]; // glTF quaternion → USD quatf
  const op = (typeName, opName, path, staticValue, convert = (v) => v) => {
    const samples = channels[path];
    xform.attr(typeName, opName, samples ? undefined : convert(staticValue), {
      timeSamples: samples?.map(([t, v]) => [t, convert(v)]),
    });
  };
  op("double3", "xformOp:translate", "translation", node.translation ?? [0, 0, 0]);
  op("quatf", "xformOp:orient", "rotation", node.rotation ?? [0, 0, 0, 1], wxyz);
  op("float3", "xformOp:scale", "scale", node.scale ?? [1, 1, 1]);
  xform.attr("token[]", "xformOpOrder", ["xformOp:translate", "xformOp:orient", "xformOp:scale"], { uniform: true });
}

function nodeMatrix(node) {
  if (node.matrix) return identityIfTrivial(node.matrix);
  if (!node.translation && !node.rotation && !node.scale) return null;
  const t = node.translation || [0, 0, 0];
  const q = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  return composeTRS(t, q, s);
}

function identityIfTrivial(m) {
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return m.every((v, i) => v === I[i]) ? null : m;
}

// composeTRS (src/math.js) returns column-major 4x4 (glTF convention), which is also
// USD's row-vector layout when written as four rows of four: translation ends up last.

// ---------- Meshes ----------

/**
 * Build one Mesh prim, or skip it (with a warning) when its data cannot be read:
 * Draco-compressed without an uncompressed fallback, or meshopt-compressed views.
 */
function buildMeshPrim(ctx, parent, prim, name, skel = null, gltfMesh = null) {
  const positionAccessor = ctx.json.accessors?.[prim.attributes?.POSITION];
  if (prim.extensions?.KHR_draco_mesh_compression && positionAccessor && positionAccessor.bufferView === undefined) {
    ctx.warn(`Mesh "${name}" is Draco-compressed (KHR_draco_mesh_compression) with no uncompressed fallback; skipped`);
    return;
  }
  const children = parent.children.length;
  const shapes = skel?.shapes.length;
  try {
    buildMeshPrimData(ctx, parent, prim, name, skel, gltfMesh);
  } catch (e) {
    if (!(e instanceof DataUnavailableError)) throw e;
    parent.children.length = children; // drop the partially built prim
    if (skel) skel.shapes.length = shapes;
    ctx.warn(`Mesh "${name}" skipped: ${e.message}`);
  }
}

function buildMeshPrimData(ctx, parent, prim, name, skel, gltfMesh) {
  const mode = prim.mode ?? MODE_TRIANGLES;
  if (mode !== MODE_TRIANGLES && mode !== MODE_TRIANGLE_STRIP && mode !== MODE_TRIANGLE_FAN) {
    ctx.warn(`Primitive mode ${MODE_NAMES[mode] ?? mode} is not supported; skipped (mesh "${name}")`);
    return;
  }
  const attrs = prim.attributes || {};
  if (attrs.POSITION === undefined) {
    ctx.warn(`Primitive without POSITION skipped (mesh "${name}")`);
    return;
  }

  const pos = ctx.asset.accessor(attrs.POSITION);
  const indices = buildTriangleIndices(ctx, prim, mode, pos.count);
  const triCount = indices.length / 3;

  const hasMaterial = prim.material !== undefined && ctx.json.materials?.[prim.material];
  const skinning = skel?.plan ? skinningPrimvars(ctx, skel.plan, prim, pos.count, name) : null;
  const hasShapes = !!(skel && prim.targets?.length);
  const skelBound = !!(skinning || hasShapes);
  const apiSchemas = [...(skelBound ? ["SkelBindingAPI"] : []), ...(hasMaterial ? ["MaterialBindingAPI"] : [])];
  const mesh = parent.child(new Prim("Mesh", name, {
    metadata: apiSchemas.length ? { "prepend apiSchemas": apiSchemas } : {},
  }));
  mesh.attr("token", "subdivisionScheme", "none", { uniform: true });
  mesh.attr("int[]", "faceVertexCounts", new Array(triCount).fill(3));
  mesh.attr("int[]", "faceVertexIndices", indices);
  mesh.attr("point3f[]", "points", pos.data);

  const vertex = { interpolation: "vertex" };
  if (attrs.NORMAL !== undefined) {
    mesh.attr("normal3f[]", "normals", ctx.asset.accessor(attrs.NORMAL).data, { metadata: vertex });
  }

  // TEXCOORD_n → primvars:st / st1 / st2 ...
  for (let n = 0; attrs[`TEXCOORD_${n}`] !== undefined; n++) {
    const uv = ctx.asset.accessor(attrs[`TEXCOORD_${n}`]);
    // glTF UV origin is top-left; USD st origin is bottom-left → flip V.
    const flipped = uv.data.slice();
    for (let i = 1; i < flipped.length; i += 2) flipped[i] = 1 - flipped[i];
    mesh.attr("texCoord2f[]", `primvars:${uvSetName(n)}`, flipped, { metadata: vertex });
  }
  if (hasMaterial) {
    for (const n of materialTexCoords(ctx.json.materials[prim.material])) {
      if (attrs[`TEXCOORD_${n}`] === undefined) {
        ctx.warn(`Mesh "${name}" has no TEXCOORD_${n}, which its material's textures use`);
      }
    }
  }

  if (attrs.COLOR_0 !== undefined) {
    const col = ctx.asset.accessor(attrs.COLOR_0);
    const rgb = [];
    for (let i = 0; i < col.count; i++) {
      rgb.push(col.data[i * col.numComponents], col.data[i * col.numComponents + 1], col.data[i * col.numComponents + 2]);
    }
    mesh.attr("color3f[]", "primvars:displayColor", rgb, { metadata: vertex });
  }

  // Extent (bounding box) is required by usdchecker for USDZ.
  mesh.attr("float3[]", "extent", extentOf(pos.data));

  if (skinning) {
    const meta = { elementSize: skinning.elementSize, interpolation: "vertex" };
    mesh.attr("int[]", "primvars:skel:jointIndices", skinning.indices, { metadata: meta });
    mesh.attr("float[]", "primvars:skel:jointWeights", skinning.weights, { metadata: meta });
    mesh.attr("matrix4d", "primvars:skel:geomBindTransform", [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }
  if (hasShapes) {
    const shapes = addBlendShapes(ctx, mesh, `${skel.skelRootPath}/${name}`, gltfMesh, prim, pos.count);
    for (const s of shapes) skel.shapes.push({ ...s, node: skel.node });
  }
  if (skelBound) mesh.rel("skel:skeleton", `${skel.skelRootPath}/Skeleton`);

  if (hasMaterial) {
    mesh.rel("material:binding", `/Root/Materials/${uniqueMaterialName(ctx, prim.material)}`);
    if (ctx.json.materials[prim.material].doubleSided) mesh.attr("bool", "doubleSided", true, { uniform: true });
  }
}

function buildTriangleIndices(ctx, prim, mode, vertexCount) {
  let idx;
  if (prim.indices !== undefined) {
    idx = ctx.asset.accessor(prim.indices).data;
  } else {
    idx = Array.from({ length: vertexCount }, (_, i) => i);
  }
  if (mode === MODE_TRIANGLES) return idx;
  const out = [];
  if (mode === MODE_TRIANGLE_STRIP) {
    for (let i = 0; i + 2 < idx.length; i++) {
      if (i % 2 === 0) out.push(idx[i], idx[i + 1], idx[i + 2]);
      else out.push(idx[i + 1], idx[i], idx[i + 2]);
    }
  } else {
    for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0], idx[i], idx[i + 1]);
  }
  return out;
}

function extentOf(pos) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      if (pos[i + c] < min[c]) min[c] = pos[i + c];
      if (pos[i + c] > max[c]) max[c] = pos[i + c];
    }
  }
  if (!Number.isFinite(min[0])) return [0, 0, 0, 0, 0, 0];
  return [...min, ...max];
}

// ---------- Materials ----------

// Material prim names are assigned before meshes reference them (materials are
// written after the scene), so precompute deterministically.
function uniqueMaterialName(ctx, index) {
  if (!ctx._matNameCache) {
    ctx._matNameCache = [];
    const used = new Set();
    (ctx.json.materials || []).forEach((mat, i) => {
      ctx._matNameCache[i] = uniqueName(sanitize(mat.name, `Material_${i}`), used);
    });
  }
  return ctx._matNameCache[index];
}

function buildMaterial(ctx, scope, mat, index) {
  const name = uniqueMaterialName(ctx, index);
  const path = `/Root/Materials/${name}`;
  const pbr = mat.pbrMetallicRoughness || {};
  const baseColor = pbr.baseColorFactor || [1, 1, 1, 1];
  const metallic = pbr.metallicFactor ?? 1;
  const roughness = pbr.roughnessFactor ?? 1;
  const ext = mat.extensions || {};
  // KHR_materials_emissive_strength scales emissiveFactor (which glTF caps at 1).
  const emissiveStrength = ext.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
  const emissive = (mat.emissiveFactor || [0, 0, 0]).map((v) => v * emissiveStrength);
  const alphaMode = mat.alphaMode || "OPAQUE";

  const material = scope.child(new Prim("Material", name, { spaced: true }));
  material.attr("token", "outputs:surface", undefined, { connect: `${path}/PreviewSurface.outputs:surface` });
  const surface = material.child(new Prim("Shader", "PreviewSurface"));
  surface.attr("token", "info:id", "UsdPreviewSurface", { uniform: true });
  surface.attr("int", "inputs:useSpecularWorkflow", 0);

  const textures = []; // shaders to add after PreviewSurface
  const connect = (shader, output) => ({ connect: `${path}/${shader}.outputs:${output}` });

  // KHR_materials_unlit: UsdPreviewSurface has no unlit mode. The usual approximation is
  // black diffuse + base color as emission; ior = 1 removes the Fresnel reflection that
  // the metallic workflow derives from ior. Other PBR inputs are ignored, as in glTF.
  if (ext.KHR_materials_unlit) {
    const bcTex = textureFile(ctx, pbr.baseColorTexture);
    surface.attr("color3f", "inputs:diffuseColor", [0, 0, 0]);
    if (bcTex) {
      textures.push({ shader: "Texture_baseColor", ...bcTex, colorSpace: "sRGB", scale: baseColor });
      surface.attr("color3f", "inputs:emissiveColor", undefined, connect("Texture_baseColor", "rgb"));
      if (alphaMode !== "OPAQUE") surface.attr("float", "inputs:opacity", undefined, connect("Texture_baseColor", "a"));
    } else {
      surface.attr("color3f", "inputs:emissiveColor", baseColor.slice(0, 3));
      if (alphaMode !== "OPAQUE") surface.attr("float", "inputs:opacity", baseColor[3]);
    }
    if (alphaMode === "MASK") surface.attr("float", "inputs:opacityThreshold", mat.alphaCutoff ?? 0.5);
    surface.attr("float", "inputs:metallic", 0);
    surface.attr("float", "inputs:roughness", 1);
    surface.attr("float", "inputs:ior", 1);
  } else {
    // Base color
    const bcTex = textureFile(ctx, pbr.baseColorTexture);
    if (bcTex) {
      textures.push({ shader: "Texture_baseColor", ...bcTex, colorSpace: "sRGB", scale: baseColor });
      surface.attr("color3f", "inputs:diffuseColor", undefined, connect("Texture_baseColor", "rgb"));
      if (alphaMode !== "OPAQUE") surface.attr("float", "inputs:opacity", undefined, connect("Texture_baseColor", "a"));
    } else {
      surface.attr("color3f", "inputs:diffuseColor", baseColor.slice(0, 3));
      if (alphaMode !== "OPAQUE") surface.attr("float", "inputs:opacity", baseColor[3]);
    }
    if (alphaMode === "MASK") surface.attr("float", "inputs:opacityThreshold", mat.alphaCutoff ?? 0.5);

    // Metallic / roughness (glTF packs: G = roughness, B = metallic)
    const mrTex = textureFile(ctx, pbr.metallicRoughnessTexture);
    if (mrTex) {
      textures.push({ shader: "Texture_metallicRoughness", ...mrTex, colorSpace: "raw", scale: [1, roughness, metallic, 1] });
      surface.attr("float", "inputs:roughness", undefined, connect("Texture_metallicRoughness", "g"));
      surface.attr("float", "inputs:metallic", undefined, connect("Texture_metallicRoughness", "b"));
    } else {
      surface.attr("float", "inputs:metallic", metallic);
      surface.attr("float", "inputs:roughness", roughness);
    }

    // Normal map
    const nTex = textureFile(ctx, mat.normalTexture);
    if (nTex) {
      textures.push({ shader: "Texture_normal", ...nTex, colorSpace: "raw", scale: [2, 2, 2, 1], bias: [-1, -1, -1, 0] });
      surface.attr("normal3f", "inputs:normal", undefined, connect("Texture_normal", "rgb"));
    }

    // Occlusion (R channel)
    const oTex = textureFile(ctx, mat.occlusionTexture);
    if (oTex) {
      textures.push({ shader: "Texture_occlusion", ...oTex, colorSpace: "raw" });
      surface.attr("float", "inputs:occlusion", undefined, connect("Texture_occlusion", "r"));
    }

    // Emissive
    const eTex = textureFile(ctx, mat.emissiveTexture);
    if (eTex) {
      textures.push({ shader: "Texture_emissive", ...eTex, colorSpace: "sRGB", scale: [...emissive, 1] });
      surface.attr("color3f", "inputs:emissiveColor", undefined, connect("Texture_emissive", "rgb"));
    } else if (emissive.some((v) => v !== 0)) {
      surface.attr("color3f", "inputs:emissiveColor", emissive);
    }

    // KHR_materials_ior → inputs:ior (both default to 1.5)
    if (ext.KHR_materials_ior?.ior !== undefined) surface.attr("float", "inputs:ior", ext.KHR_materials_ior.ior);

    // KHR_materials_clearcoat: factor × texture.r → clearcoat, factor × texture.g → clearcoatRoughness
    const cc = ext.KHR_materials_clearcoat;
    if (cc) {
      const ccFactor = cc.clearcoatFactor ?? 0;
      const ccRough = cc.clearcoatRoughnessFactor ?? 0;
      const ccTex = textureFile(ctx, cc.clearcoatTexture);
      if (ccTex) {
        textures.push({ shader: "Texture_clearcoat", ...ccTex, colorSpace: "raw", scale: [ccFactor, ccFactor, ccFactor, 1] });
        surface.attr("float", "inputs:clearcoat", undefined, connect("Texture_clearcoat", "r"));
      } else {
        surface.attr("float", "inputs:clearcoat", ccFactor);
      }
      const ccrTex = textureFile(ctx, cc.clearcoatRoughnessTexture);
      if (ccrTex) {
        textures.push({ shader: "Texture_clearcoatRoughness", ...ccrTex, colorSpace: "raw", scale: [ccRough, ccRough, ccRough, 1] });
        surface.attr("float", "inputs:clearcoatRoughness", undefined, connect("Texture_clearcoatRoughness", "g"));
      } else {
        surface.attr("float", "inputs:clearcoatRoughness", ccRough);
      }
      if (cc.clearcoatNormalTexture) {
        ctx.warn(`Material "${name}": clearcoatNormalTexture has no UsdPreviewSurface input; ignored`);
      }
    }
  }

  surface.attr("token", "outputs:surface");

  // One primvar reader per UV set in use: uvReader_st, uvReader_st1, ...
  for (const n of [...new Set(textures.map((t) => t.texCoord))].sort((a, b) => a - b)) {
    const set = uvSetName(n);
    const reader = material.child(new Prim("Shader", `uvReader_${set}`));
    reader.attr("token", "info:id", "UsdPrimvarReader_float2", { uniform: true });
    reader.attr("string", "inputs:varname", set);
    reader.attr("float2", "outputs:result");
  }
  for (const t of textures) {
    let stSource = `${path}/uvReader_${uvSetName(t.texCoord)}.outputs:result`;
    if (t.transform) {
      // KHR_texture_transform → UsdTransform2d between the reader and the texture.
      const xfName = t.shader.replace(/^Texture_/, "Transform2d_");
      const xf = material.child(new Prim("Shader", xfName));
      xf.attr("token", "info:id", "UsdTransform2d", { uniform: true });
      xf.attr("float2", "inputs:in", undefined, { connect: stSource });
      xf.attr("float", "inputs:rotation", t.transform.rotation);
      xf.attr("float2", "inputs:scale", t.transform.scale);
      xf.attr("float2", "inputs:translation", t.transform.translation);
      xf.attr("float2", "outputs:result");
      stSource = `${path}/${xfName}.outputs:result`;
    }
    const tex = material.child(new Prim("Shader", t.shader));
    tex.attr("token", "info:id", "UsdUVTexture", { uniform: true });
    tex.attr("asset", "inputs:file", t.file);
    tex.attr("float2", "inputs:st", undefined, { connect: stSource });
    tex.attr("token", "inputs:sourceColorSpace", t.colorSpace);
    tex.attr("token", "inputs:wrapS", t.wrapS);
    tex.attr("token", "inputs:wrapT", t.wrapT);
    if (t.scale) tex.attr("float4", "inputs:scale", t.scale);
    if (t.bias) tex.attr("float4", "inputs:bias", t.bias);
    for (const c of ["r", "g", "b", "a"]) tex.attr("float", `outputs:${c}`);
    tex.attr("float3", "outputs:rgb");
  }
}

/** The TEXCOORD sets a material's textures read from. */
function materialTexCoords(mat) {
  const pbr = mat.pbrMetallicRoughness || {};
  const cc = mat.extensions?.KHR_materials_clearcoat || {};
  const infos = [
    pbr.baseColorTexture, pbr.metallicRoughnessTexture, mat.normalTexture, mat.occlusionTexture, mat.emissiveTexture,
    cc.clearcoatTexture, cc.clearcoatRoughnessTexture,
  ];
  return new Set(infos.filter(Boolean).map(texCoordOf));
}

function texCoordOf(texInfo) {
  return texInfo.extensions?.KHR_texture_transform?.texCoord ?? texInfo.texCoord ?? 0;
}

/**
 * KHR_texture_transform → UsdTransform2d inputs, or null for identity.
 *
 * glTF applies uv' = T · R · S · uv in its V-down UV space, with
 * R = [[cos, sin], [-sin, cos]]. Rewriting that for USD's st = (u, 1 - v)
 * gives st' = Rccw(rotation) · diag(scale) · st + t, which is exactly
 * UsdTransform2d (scale, then counter-clockwise rotation in degrees, then
 * translation) with t = (offset.x + sin·scale.y, 1 - offset.y - cos·scale.y).
 */
function textureTransform(texInfo) {
  const ext = texInfo.extensions?.KHR_texture_transform;
  if (!ext) return null;
  const [ox, oy] = ext.offset ?? [0, 0];
  const [sx, sy] = ext.scale ?? [1, 1];
  const r = ext.rotation ?? 0;
  if (ox === 0 && oy === 0 && sx === 1 && sy === 1 && r === 0) return null;
  const c = Math.cos(r), s = Math.sin(r);
  return {
    scale: [sx, sy],
    rotation: (r * 180) / Math.PI,
    translation: [ox + s * sy, 1 - oy - c * sy],
  };
}

/**
 * Resolve a glTF textureInfo to { file, wrapS, wrapT, texCoord, transform },
 * registering the image bytes for packaging. Returns null (with a warning)
 * when it can't be used.
 */
function textureFile(ctx, texInfo) {
  if (!texInfo) return null;
  const tex = ctx.json.textures?.[texInfo.index];
  if (!tex) {
    ctx.warn(`Texture ${texInfo.index} does not exist; ignored`);
    return null;
  }
  if (tex.source === undefined) {
    ctx.warn(`Texture ${texInfo.index} has no PNG/JPEG source (image extensions are not supported); ignored`);
    return null;
  }
  const file = imageFile(ctx, tex.source);
  if (!file) return null;
  const sampler = tex.sampler !== undefined ? ctx.json.samplers?.[tex.sampler] ?? {} : {};
  return {
    file,
    wrapS: wrapMode(ctx, sampler.wrapS),
    wrapT: wrapMode(ctx, sampler.wrapT),
    texCoord: texCoordOf(texInfo),
    transform: textureTransform(texInfo),
  };
}

function wrapMode(ctx, glMode) {
  if (glMode === undefined) return "repeat";
  const mode = WRAP_MODES[glMode];
  if (!mode) ctx.warn(`Unknown sampler wrap mode ${glMode}; using repeat`);
  return mode ?? "repeat";
}

/** Package an image once and return its file name inside the USDZ. */
function imageFile(ctx, imgIndex) {
  if (ctx.imageNames.has(imgIndex)) return ctx.imageNames.get(imgIndex);
  const image = ctx.json.images?.[imgIndex];
  const img = image && ctx.asset.imageBytes(imgIndex);
  let fileName = null;
  if (!img) {
    ctx.warn(`Image ${imgIndex} could not be resolved${image?.uri ? ` (uri: ${image.uri.slice(0, 64)})` : ""}; texture ignored`);
  } else if (img.mimeType !== "image/png" && img.mimeType !== "image/jpeg") {
    ctx.warn(`Image ${imgIndex} has unsupported type ${img.mimeType ?? "(unknown)"}; USDZ allows PNG and JPEG only`);
  } else {
    const ext = img.mimeType === "image/jpeg" ? "jpg" : "png";
    const base = sanitize(image.name, `image_${imgIndex}`);
    let candidate = `${ctx.texturePrefix}${base}.${ext}`;
    for (let i = 1; ctx.usedFileNames.has(candidate.toLowerCase()); i++) {
      candidate = `${ctx.texturePrefix}${base}_${i}.${ext}`;
    }
    // Compare case-insensitively: archives are often extracted on case-insensitive file systems.
    ctx.usedFileNames.add(candidate.toLowerCase());
    fileName = candidate;
    ctx.files.push({ name: fileName, bytes: img.bytes });
  }
  ctx.imageNames.set(imgIndex, fileName);
  return fileName;
}

// ---------- Names ----------

function generatorNote(json) {
  const g = json.asset?.generator;
  return g ? ` (${g.replace(/["\\]/g, "")})` : "";
}
