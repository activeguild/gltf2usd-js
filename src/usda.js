// glTF → USDA (text) writer.
// References: USD schemas (UsdGeom, UsdShade), UsdPreviewSurface spec.
//
// Output layout:
//   /Root                     (Xform, defaultPrim)
//   /Root/Scene/<Node>/...    (Xform hierarchy; one Mesh prim per glTF primitive)
//   /Root/Materials/<Mat>     (Material + UsdPreviewSurface + UsdUVTexture shaders)

const MODE_TRIANGLES = 4;
const MODE_TRIANGLE_STRIP = 5;
const MODE_TRIANGLE_FAN = 6;

export function gltfToUsda(asset, options = {}) {
  const texturePrefix = options.texturePrefix ?? "textures/";
  const ctx = {
    asset,
    json: asset.json,
    texturePrefix,
    files: [],            // extra files to package: { name, bytes }
    imageNames: new Map(), // image index -> file name
  };

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
  lines.push('    def Xform "Scene"');
  lines.push("    {");
  const usedNames = new Set();
  for (const nodeIndex of rootNodes) writeNode(ctx, lines, nodeIndex, 2, usedNames, "/Root/Scene");
  lines.push("    }");

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

  if (node.mesh !== undefined) {
    const mesh = ctx.json.meshes[node.mesh];
    const primNames = new Set();
    (mesh.primitives || []).forEach((prim, pi) => {
      const base = sanitize(mesh.name, `Mesh_${node.mesh}`);
      const primName = uniqueName(mesh.primitives.length > 1 ? `${base}_${pi}` : base, primNames);
      writeMeshPrim(ctx, lines, prim, primName, depth + 1);
    });
  }

  const childNames = new Set();
  for (const child of node.children || []) writeNode(ctx, lines, child, depth + 1, childNames, path);
  lines.push(`${ind}}`);
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
    return; // points/lines not supported in this step
  }
  const ind = "    ".repeat(depth);
  const attrs = prim.attributes || {};
  if (attrs.POSITION === undefined) return;

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

  if (attrs.TEXCOORD_0 !== undefined) {
    const uv = ctx.asset.accessor(attrs.TEXCOORD_0);
    // glTF UV origin is top-left; USD st origin is bottom-left → flip V.
    const flipped = uv.data.slice();
    for (let i = 1; i < flipped.length; i += 2) flipped[i] = 1 - flipped[i];
    lines.push(`${ind}    texCoord2f[] primvars:st = [${fmtVecs(flipped, 2)}] (`);
    lines.push(`${ind}        interpolation = "vertex"`);
    lines.push(`${ind}    )`);
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
  const emissive = mat.emissiveFactor || [0, 0, 0];
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
    textures.push({ shader: "Texture_baseColor", file: bcTex, colorSpace: "sRGB", scale: baseColor });
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
    textures.push({ shader: "Texture_metallicRoughness", file: mrTex, colorSpace: "raw", scale: [1, roughness, metallic, 1] });
    lines.push(`${ind}        float inputs:roughness.connect = <${path}/Texture_metallicRoughness.outputs:g>`);
    lines.push(`${ind}        float inputs:metallic.connect = <${path}/Texture_metallicRoughness.outputs:b>`);
  } else {
    lines.push(`${ind}        float inputs:metallic = ${fmt(metallic)}`);
    lines.push(`${ind}        float inputs:roughness = ${fmt(roughness)}`);
  }

  // Normal map
  const nTex = textureFile(ctx, mat.normalTexture);
  if (nTex) {
    textures.push({ shader: "Texture_normal", file: nTex, colorSpace: "raw", scale: [2, 2, 2, 1], bias: [-1, -1, -1, 0] });
    lines.push(`${ind}        normal3f inputs:normal.connect = <${path}/Texture_normal.outputs:rgb>`);
  }

  // Occlusion (R channel)
  const oTex = textureFile(ctx, mat.occlusionTexture);
  if (oTex) {
    textures.push({ shader: "Texture_occlusion", file: oTex, colorSpace: "raw" });
    lines.push(`${ind}        float inputs:occlusion.connect = <${path}/Texture_occlusion.outputs:r>`);
  }

  // Emissive
  const eTex = textureFile(ctx, mat.emissiveTexture);
  if (eTex) {
    textures.push({ shader: "Texture_emissive", file: eTex, colorSpace: "sRGB", scale: [...emissive, 1] });
    lines.push(`${ind}        color3f inputs:emissiveColor.connect = <${path}/Texture_emissive.outputs:rgb>`);
  } else if (emissive.some((v) => v !== 0)) {
    lines.push(`${ind}        color3f inputs:emissiveColor = ${fmtTuple(emissive)}`);
  }

  lines.push(`${ind}        token outputs:surface`);
  lines.push(`${ind}    }`);

  if (textures.length) {
    lines.push("");
    lines.push(`${ind}    def Shader "uvReader_st"`);
    lines.push(`${ind}    {`);
    lines.push(`${ind}        uniform token info:id = "UsdPrimvarReader_float2"`);
    lines.push(`${ind}        string inputs:varname = "st"`);
    lines.push(`${ind}        float2 outputs:result`);
    lines.push(`${ind}    }`);
    for (const t of textures) {
      lines.push("");
      lines.push(`${ind}    def Shader "${t.shader}"`);
      lines.push(`${ind}    {`);
      lines.push(`${ind}        uniform token info:id = "UsdUVTexture"`);
      lines.push(`${ind}        asset inputs:file = @${t.file}@`);
      lines.push(`${ind}        float2 inputs:st.connect = <${path}/uvReader_st.outputs:result>`);
      lines.push(`${ind}        token inputs:sourceColorSpace = "${t.colorSpace}"`);
      lines.push(`${ind}        token inputs:wrapS = "repeat"`);
      lines.push(`${ind}        token inputs:wrapT = "repeat"`);
      if (t.scale) lines.push(`${ind}        float4 inputs:scale = ${fmtTuple(t.scale)}`);
      if (t.bias) lines.push(`${ind}        float4 inputs:bias = ${fmtTuple(t.bias)}`);
      lines.push(`${ind}        float outputs:r`);
      lines.push(`${ind}        float outputs:g`);
      lines.push(`${ind}        float outputs:b`);
      lines.push(`${ind}        float outputs:a`);
      lines.push(`${ind}        float3 outputs:rgb`);
      lines.push(`${ind}    }`);
    }
  }

  lines.push(`${ind}}`);
}

/** Resolve a glTF textureInfo to a packaged file name, registering the image bytes. */
function textureFile(ctx, texInfo) {
  if (!texInfo) return null;
  const tex = ctx.json.textures?.[texInfo.index];
  if (!tex || tex.source === undefined) return null;
  const imgIndex = tex.source;
  if (ctx.imageNames.has(imgIndex)) return ctx.imageNames.get(imgIndex);
  const img = ctx.asset.imageBytes(imgIndex);
  if (!img) return null;
  const ext = img.mimeType === "image/jpeg" ? "jpg" : img.mimeType === "image/png" ? "png" : "bin";
  const fileName = `${ctx.texturePrefix}${sanitize(ctx.json.images[imgIndex].name, `image_${imgIndex}`)}.${ext}`;
  ctx.imageNames.set(imgIndex, fileName);
  ctx.files.push({ name: fileName, bytes: img.bytes });
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
