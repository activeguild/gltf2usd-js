// glTF → USDA (text) writer.
// References: USD schemas (UsdGeom, UsdShade), UsdPreviewSurface spec.
//
// Output layout:
//   /Root                     (Xform, defaultPrim)
//   /Root/Scene/<Node>/...    (Xform hierarchy; one Mesh prim per glTF primitive)
//   /Root/Meshes/<Mesh>       (class; prototypes of meshes used by several nodes,
//                              referenced from the nodes as instanceable prims)
//   /Root/Materials/<Mat>     (Material + UsdPreviewSurface + UsdUVTexture shaders)

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
]);

/** USD primvar name for glTF TEXCOORD_n: st, st1, st2, ... */
const uvSetName = (n) => (n === 0 ? "st" : `st${n}`);

export function gltfToUsda(asset, options = {}) {
  const texturePrefix = options.texturePrefix ?? "textures/";
  const ctx = {
    asset,
    json: asset.json,
    texturePrefix,
    files: [],            // extra files to package: { name, bytes }
    imageNames: new Map(), // image index -> file name
    usedFileNames: new Set(),
    warn: makeWarn(options.onWarning),
  };
  reportUnsupported(ctx);

  const lines = [];
  lines.push("#usda 1.0");
  lines.push("(");
  lines.push('    defaultPrim = "Root"');
  lines.push("    metersPerUnit = 1");
  lines.push('    upAxis = "Y"');
  lines.push(`    doc = "Converted from glTF${generatorNote(ctx.json)}"`);
  lines.push(")");
  lines.push("");
  lines.push('def Xform "Root"');
  lines.push("{");

  // Scene / node hierarchy
  const scene = ctx.json.scenes?.[ctx.json.scene ?? 0];
  const rootNodes = scene ? scene.nodes || [] : (ctx.json.nodes || []).map((_, i) => i);
  ctx.prototypes = planPrototypes(ctx, rootNodes, options.instancing ?? true);
  lines.push('    def Xform "Scene"');
  lines.push("    {");
  const usedNames = new Set();
  for (const nodeIndex of rootNodes) writeNode(ctx, lines, nodeIndex, 2, usedNames, "/Root/Scene");
  lines.push("    }");

  // Prototypes for meshes shared by several nodes. `class` keeps them out of
  // the rendered scene; nodes reference them as instanceable prims.
  if (ctx.prototypes.size) {
    lines.push("");
    lines.push('    class Xform "Meshes"');
    lines.push("    {");
    for (const [meshIndex, protoName] of ctx.prototypes) {
      lines.push(`        def Xform "${protoName}"`);
      lines.push("        {");
      writeMeshPrims(ctx, lines, meshIndex, 3, new Set());
      lines.push("        }");
    }
    lines.push("    }");
  }

  // Materials
  const materials = ctx.json.materials || [];
  if (materials.length) {
    lines.push("");
    lines.push('    def Scope "Materials"');
    lines.push("    {");
    materials.forEach((mat, i) => writeMaterial(ctx, lines, mat, i, 2));
    lines.push("    }");
  }

  lines.push("}");
  lines.push("");
  return { usda: lines.join("\n"), files: ctx.files };
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
  if (json.animations?.length) warn(`${json.animations.length} animation(s) are not supported yet and were skipped`);
  if (json.skins?.length) warn(`${json.skins.length} skin(s) are not supported yet; meshes are written in bind pose`);
  if (json.cameras?.length) warn(`${json.cameras.length} camera(s) are not supported yet and were skipped`);
  if ((json.meshes || []).some((m) => (m.primitives || []).some((p) => p.targets?.length))) {
    warn("Morph targets are not supported yet; base shapes are written");
  }
}

// ---------- Nodes ----------

function writeNode(ctx, lines, nodeIndex, depth, siblingNames, parentPath) {
  const node = ctx.json.nodes[nodeIndex];
  const name = uniqueName(sanitize(node.name, `Node_${nodeIndex}`), siblingNames);
  const path = `${parentPath}/${name}`;
  const ind = "    ".repeat(depth);

  lines.push(`${ind}def Xform "${name}"`);
  lines.push(`${ind}{`);
  const m = nodeMatrix(node);
  if (m) {
    lines.push(`${ind}    matrix4d xformOp:transform = ${fmtMatrix(m)}`);
    lines.push(`${ind}    uniform token[] xformOpOrder = ["xformOp:transform"]`);
  }

  // Mesh prims and child nodes share one namespace under this Xform.
  const names = new Set();
  if (node.mesh !== undefined) {
    const protoName = ctx.prototypes.get(node.mesh);
    if (protoName) {
      const mesh = ctx.json.meshes[node.mesh];
      const instName = uniqueName(sanitize(mesh.name, `Mesh_${node.mesh}`), names);
      lines.push(`${ind}    def Xform "${instName}" (`);
      lines.push(`${ind}        instanceable = true`);
      lines.push(`${ind}        prepend references = </Root/Meshes/${protoName}>`);
      lines.push(`${ind}    )`);
      lines.push(`${ind}    {`);
      lines.push(`${ind}    }`);
    } else {
      writeMeshPrims(ctx, lines, node.mesh, depth + 1, names);
    }
  }

  for (const child of node.children || []) writeNode(ctx, lines, child, depth + 1, names, path);
  lines.push(`${ind}}`);
}

/** One Mesh prim per glTF primitive. */
function writeMeshPrims(ctx, lines, meshIndex, depth, names) {
  const mesh = ctx.json.meshes[meshIndex];
  const base = sanitize(mesh.name, `Mesh_${meshIndex}`);
  (mesh.primitives || []).forEach((prim, pi) => {
    const primName = uniqueName(mesh.primitives.length > 1 ? `${base}_${pi}` : base, names);
    writeMeshPrim(ctx, lines, prim, primName, depth);
  });
}

/**
 * Meshes referenced by more than one node in the scene get a prototype under
 * /Root/Meshes. Returns Map<meshIndex, prototypeName> in mesh index order.
 */
function planPrototypes(ctx, rootNodes, enabled) {
  const prototypes = new Map();
  if (!enabled) return prototypes;
  const uses = new Map();
  const visited = new Set();
  const visit = (i) => {
    if (visited.has(i) || !ctx.json.nodes?.[i]) return; // guard against malformed cyclic graphs
    visited.add(i);
    const node = ctx.json.nodes[i];
    if (node.mesh !== undefined) uses.set(node.mesh, (uses.get(node.mesh) ?? 0) + 1);
    for (const c of node.children || []) visit(c);
  };
  rootNodes.forEach(visit);
  const used = new Set();
  [...uses.keys()].sort((a, b) => a - b).forEach((meshIndex) => {
    if (uses.get(meshIndex) < 2) return;
    const mesh = ctx.json.meshes[meshIndex];
    prototypes.set(meshIndex, uniqueName(sanitize(mesh.name, `Mesh_${meshIndex}`), used));
  });
  return prototypes;
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

// Column-major 4x4 (glTF convention), which is also USD's row-vector layout when
// written as four rows of four: translation ends up in the last row.
function composeTRS([tx, ty, tz], [x, y, z, w], [sx, sy, sz]) {
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * sx, (2 * (xy + wz)) * sx, (2 * (xz - wy)) * sx, 0,
    (2 * (xy - wz)) * sy, (1 - 2 * (xx + zz)) * sy, (2 * (yz + wx)) * sy, 0,
    (2 * (xz + wy)) * sz, (2 * (yz - wx)) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

// ---------- Meshes ----------

function writeMeshPrim(ctx, lines, prim, name, depth) {
  const mode = prim.mode ?? MODE_TRIANGLES;
  if (mode !== MODE_TRIANGLES && mode !== MODE_TRIANGLE_STRIP && mode !== MODE_TRIANGLE_FAN) {
    ctx.warn(`Primitive mode ${MODE_NAMES[mode] ?? mode} is not supported; skipped (mesh "${name}")`);
    return;
  }
  const ind = "    ".repeat(depth);
  const attrs = prim.attributes || {};
  if (attrs.POSITION === undefined) {
    ctx.warn(`Primitive without POSITION skipped (mesh "${name}")`);
    return;
  }

  const pos = ctx.asset.accessor(attrs.POSITION);
  const indices = buildTriangleIndices(ctx, prim, mode, pos.count);
  const triCount = indices.length / 3;

  const hasMaterial = prim.material !== undefined && ctx.json.materials?.[prim.material];
  lines.push(`${ind}def Mesh "${name}"${hasMaterial ? ` (\n${ind}    prepend apiSchemas = ["MaterialBindingAPI"]\n${ind})` : ""}`);
  lines.push(`${ind}{`);
  lines.push(`${ind}    uniform token subdivisionScheme = "none"`);
  lines.push(`${ind}    int[] faceVertexCounts = [${new Array(triCount).fill(3).join(", ")}]`);
  lines.push(`${ind}    int[] faceVertexIndices = [${indices.join(", ")}]`);
  lines.push(`${ind}    point3f[] points = [${fmtVecs(pos.data, 3)}]`);

  if (attrs.NORMAL !== undefined) {
    const n = ctx.asset.accessor(attrs.NORMAL);
    lines.push(`${ind}    normal3f[] normals = [${fmtVecs(n.data, 3)}] (`);
    lines.push(`${ind}        interpolation = "vertex"`);
    lines.push(`${ind}    )`);
  }

  // TEXCOORD_n → primvars:st / st1 / st2 ...
  for (let n = 0; attrs[`TEXCOORD_${n}`] !== undefined; n++) {
    const uv = ctx.asset.accessor(attrs[`TEXCOORD_${n}`]);
    // glTF UV origin is top-left; USD st origin is bottom-left → flip V.
    const flipped = uv.data.slice();
    for (let i = 1; i < flipped.length; i += 2) flipped[i] = 1 - flipped[i];
    lines.push(`${ind}    texCoord2f[] primvars:${uvSetName(n)} = [${fmtVecs(flipped, 2)}] (`);
    lines.push(`${ind}        interpolation = "vertex"`);
    lines.push(`${ind}    )`);
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
    lines.push(`${ind}    color3f[] primvars:displayColor = [${fmtVecs(rgb, 3)}] (`);
    lines.push(`${ind}        interpolation = "vertex"`);
    lines.push(`${ind}    )`);
  }

  // Extent (bounding box) is required by usdchecker for USDZ.
  lines.push(`${ind}    float3[] extent = [${fmtExtent(pos.data)}]`);

  if (hasMaterial) {
    const matName = uniqueMaterialName(ctx, prim.material);
    lines.push(`${ind}    rel material:binding = </Root/Materials/${matName}>`);
    if (ctx.json.materials[prim.material].doubleSided) {
      lines.push(`${ind}    uniform bool doubleSided = 1`);
    }
  }

  lines.push(`${ind}}`);
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

function writeMaterial(ctx, lines, mat, index, depth) {
  const name = uniqueMaterialName(ctx, index);
  const ind = "    ".repeat(depth);
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

  lines.push(`${ind}def Material "${name}"`);
  lines.push(`${ind}{`);
  lines.push(`${ind}    token outputs:surface.connect = <${path}/PreviewSurface.outputs:surface>`);
  lines.push("");
  lines.push(`${ind}    def Shader "PreviewSurface"`);
  lines.push(`${ind}    {`);
  lines.push(`${ind}        uniform token info:id = "UsdPreviewSurface"`);
  lines.push(`${ind}        int inputs:useSpecularWorkflow = 0`);

  const textures = []; // shaders to emit after PreviewSurface

  // Base color
  const bcTex = textureFile(ctx, pbr.baseColorTexture);
  if (bcTex) {
    textures.push({ shader: "Texture_baseColor", ...bcTex, colorSpace: "sRGB", scale: baseColor });
    lines.push(`${ind}        color3f inputs:diffuseColor.connect = <${path}/Texture_baseColor.outputs:rgb>`);
    if (alphaMode !== "OPAQUE") {
      lines.push(`${ind}        float inputs:opacity.connect = <${path}/Texture_baseColor.outputs:a>`);
    }
  } else {
    lines.push(`${ind}        color3f inputs:diffuseColor = ${fmtTuple(baseColor.slice(0, 3))}`);
    if (alphaMode !== "OPAQUE") lines.push(`${ind}        float inputs:opacity = ${fmt(baseColor[3])}`);
  }
  if (alphaMode === "MASK") {
    lines.push(`${ind}        float inputs:opacityThreshold = ${fmt(mat.alphaCutoff ?? 0.5)}`);
  }

  // Metallic / roughness (glTF packs: G = roughness, B = metallic)
  const mrTex = textureFile(ctx, pbr.metallicRoughnessTexture);
  if (mrTex) {
    textures.push({ shader: "Texture_metallicRoughness", ...mrTex, colorSpace: "raw", scale: [1, roughness, metallic, 1] });
    lines.push(`${ind}        float inputs:roughness.connect = <${path}/Texture_metallicRoughness.outputs:g>`);
    lines.push(`${ind}        float inputs:metallic.connect = <${path}/Texture_metallicRoughness.outputs:b>`);
  } else {
    lines.push(`${ind}        float inputs:metallic = ${fmt(metallic)}`);
    lines.push(`${ind}        float inputs:roughness = ${fmt(roughness)}`);
  }

  // Normal map
  const nTex = textureFile(ctx, mat.normalTexture);
  if (nTex) {
    textures.push({ shader: "Texture_normal", ...nTex, colorSpace: "raw", scale: [2, 2, 2, 1], bias: [-1, -1, -1, 0] });
    lines.push(`${ind}        normal3f inputs:normal.connect = <${path}/Texture_normal.outputs:rgb>`);
  }

  // Occlusion (R channel)
  const oTex = textureFile(ctx, mat.occlusionTexture);
  if (oTex) {
    textures.push({ shader: "Texture_occlusion", ...oTex, colorSpace: "raw" });
    lines.push(`${ind}        float inputs:occlusion.connect = <${path}/Texture_occlusion.outputs:r>`);
  }

  // Emissive
  const eTex = textureFile(ctx, mat.emissiveTexture);
  if (eTex) {
    textures.push({ shader: "Texture_emissive", ...eTex, colorSpace: "sRGB", scale: [...emissive, 1] });
    lines.push(`${ind}        color3f inputs:emissiveColor.connect = <${path}/Texture_emissive.outputs:rgb>`);
  } else if (emissive.some((v) => v !== 0)) {
    lines.push(`${ind}        color3f inputs:emissiveColor = ${fmtTuple(emissive)}`);
  }

  // KHR_materials_ior → inputs:ior (both default to 1.5)
  if (ext.KHR_materials_ior?.ior !== undefined) {
    lines.push(`${ind}        float inputs:ior = ${fmt(ext.KHR_materials_ior.ior)}`);
  }

  // KHR_materials_clearcoat: factor × texture.r → clearcoat, factor × texture.g → clearcoatRoughness
  const cc = ext.KHR_materials_clearcoat;
  if (cc) {
    const ccFactor = cc.clearcoatFactor ?? 0;
    const ccRough = cc.clearcoatRoughnessFactor ?? 0;
    const ccTex = textureFile(ctx, cc.clearcoatTexture);
    if (ccTex) {
      textures.push({ shader: "Texture_clearcoat", ...ccTex, colorSpace: "raw", scale: [ccFactor, ccFactor, ccFactor, 1] });
      lines.push(`${ind}        float inputs:clearcoat.connect = <${path}/Texture_clearcoat.outputs:r>`);
    } else {
      lines.push(`${ind}        float inputs:clearcoat = ${fmt(ccFactor)}`);
    }
    const ccrTex = textureFile(ctx, cc.clearcoatRoughnessTexture);
    if (ccrTex) {
      textures.push({ shader: "Texture_clearcoatRoughness", ...ccrTex, colorSpace: "raw", scale: [ccRough, ccRough, ccRough, 1] });
      lines.push(`${ind}        float inputs:clearcoatRoughness.connect = <${path}/Texture_clearcoatRoughness.outputs:g>`);
    } else {
      lines.push(`${ind}        float inputs:clearcoatRoughness = ${fmt(ccRough)}`);
    }
    if (cc.clearcoatNormalTexture) {
      ctx.warn(`Material "${name}": clearcoatNormalTexture has no UsdPreviewSurface input; ignored`);
    }
  }

  lines.push(`${ind}        token outputs:surface`);
  lines.push(`${ind}    }`);

  // One primvar reader per UV set in use: uvReader_st, uvReader_st1, ...
  for (const n of [...new Set(textures.map((t) => t.texCoord))].sort((a, b) => a - b)) {
    const set = uvSetName(n);
    lines.push("");
    lines.push(`${ind}    def Shader "uvReader_${set}"`);
    lines.push(`${ind}    {`);
    lines.push(`${ind}        uniform token info:id = "UsdPrimvarReader_float2"`);
    lines.push(`${ind}        string inputs:varname = "${set}"`);
    lines.push(`${ind}        float2 outputs:result`);
    lines.push(`${ind}    }`);
  }
  for (const t of textures) {
    let stSource = `${path}/uvReader_${uvSetName(t.texCoord)}.outputs:result`;
    if (t.transform) {
      // KHR_texture_transform → UsdTransform2d between the reader and the texture.
      const name = t.shader.replace(/^Texture_/, "Transform2d_");
      const { scale, rotation, translation } = t.transform;
      lines.push("");
      lines.push(`${ind}    def Shader "${name}"`);
      lines.push(`${ind}    {`);
      lines.push(`${ind}        uniform token info:id = "UsdTransform2d"`);
      lines.push(`${ind}        float2 inputs:in.connect = <${stSource}>`);
      lines.push(`${ind}        float inputs:rotation = ${fmt(rotation)}`);
      lines.push(`${ind}        float2 inputs:scale = ${fmtTuple(scale)}`);
      lines.push(`${ind}        float2 inputs:translation = ${fmtTuple(translation)}`);
      lines.push(`${ind}        float2 outputs:result`);
      lines.push(`${ind}    }`);
      stSource = `${path}/${name}.outputs:result`;
    }
    lines.push("");
    lines.push(`${ind}    def Shader "${t.shader}"`);
    lines.push(`${ind}    {`);
    lines.push(`${ind}        uniform token info:id = "UsdUVTexture"`);
    lines.push(`${ind}        asset inputs:file = @${t.file}@`);
    lines.push(`${ind}        float2 inputs:st.connect = <${stSource}>`);
    lines.push(`${ind}        token inputs:sourceColorSpace = "${t.colorSpace}"`);
    lines.push(`${ind}        token inputs:wrapS = "${t.wrapS}"`);
    lines.push(`${ind}        token inputs:wrapT = "${t.wrapT}"`);
    if (t.scale) lines.push(`${ind}        float4 inputs:scale = ${fmtTuple(t.scale)}`);
    if (t.bias) lines.push(`${ind}        float4 inputs:bias = ${fmtTuple(t.bias)}`);
    lines.push(`${ind}        float outputs:r`);
    lines.push(`${ind}        float outputs:g`);
    lines.push(`${ind}        float outputs:b`);
    lines.push(`${ind}        float outputs:a`);
    lines.push(`${ind}        float3 outputs:rgb`);
    lines.push(`${ind}    }`);
  }

  lines.push(`${ind}}`);
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

// ---------- Formatting helpers ----------

function fmt(v) {
  if (!Number.isFinite(v)) return "0";
  const s = Number(v.toPrecision(7)).toString();
  return s;
}

function fmtTuple(arr) {
  return `(${arr.map(fmt).join(", ")})`;
}

function fmtVecs(data, n) {
  const out = [];
  for (let i = 0; i < data.length; i += n) {
    const parts = [];
    for (let c = 0; c < n; c++) parts.push(fmt(data[i + c]));
    out.push(`(${parts.join(", ")})`);
  }
  return out.join(", ");
}

function fmtMatrix(m) {
  const rows = [];
  for (let r = 0; r < 4; r++) rows.push(fmtTuple(m.slice(r * 4, r * 4 + 4)));
  return `( ${rows.join(", ")} )`;
}

function fmtExtent(pos) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      if (pos[i + c] < min[c]) min[c] = pos[i + c];
      if (pos[i + c] > max[c]) max[c] = pos[i + c];
    }
  }
  if (!Number.isFinite(min[0])) return "(0, 0, 0), (0, 0, 0)";
  return `${fmtTuple(min)}, ${fmtTuple(max)}`;
}

function generatorNote(json) {
  const g = json.asset?.generator;
  return g ? ` (${g.replace(/["\\]/g, "")})` : "";
}

/** USD prim names must match [A-Za-z_][A-Za-z0-9_]*. */
export function sanitize(name, fallback) {
  if (!name) return fallback;
  let s = String(name).replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(s)) s = "_" + s;
  return s || fallback;
}

function uniqueName(name, used) {
  let candidate = name;
  let i = 1;
  while (used.has(candidate)) candidate = `${name}_${i++}`;
  used.add(candidate);
  return candidate;
}
