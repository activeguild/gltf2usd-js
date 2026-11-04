// COLOR_0 → primvars:displayColor / displayOpacity, and how vertex alpha combines with
// the material (see vertexOpacity() in src/convert.js).
import { glbToUsda, GltfValidationError } from "../src/index.js";
import { makeGlb, packParts } from "./gltf-builder.js";
import { encodePng } from "./png.js";

let failures = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); failures++; } };

/**
 * One triangle with COLOR_0 of the given type / componentType and a material.
 * colors: 3 or 4 numbers per vertex in 0..1 (written as the component type requires).
 */
function colored({ type = "VEC4", componentType = 5126, normalized, colors, material, texture = false, uv = false }) {
  const n = type === "VEC4" ? 4 : 3;
  const raw = componentType === 5121 ? Uint8Array.from(colors, (v) => Math.round(v * 255))
    : componentType === 5123 ? Uint16Array.from(colors, (v) => Math.round(v * 65535))
    : new Float32Array(colors);
  const parts = [new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), raw, new Float32Array([0, 0, 1, 0, 0, 1])];
  if (texture) parts.push(encodePng(2, 2, () => [255, 255, 255, 128]));
  const { bin, views } = packParts(parts);
  const json = {
    asset: { version: "2.0" },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ name: "Tri", primitives: [{ attributes: { POSITION: 0, COLOR_0: 1, ...(uv || texture ? { TEXCOORD_0: 2 } : {}) }, ...(material ? { material: 0 } : {}) }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType, count: 3, type, ...(normalized ?? componentType !== 5126 ? { normalized: normalized ?? true } : {}) },
      { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  if (material) {
    json.materials = [{ name: "M", ...material }];
    if (texture) {
      json.materials[0].pbrMetallicRoughness = { ...(material.pbrMetallicRoughness || {}), baseColorTexture: { index: 0 } };
      json.textures = [{ source: 0 }];
      json.images = [{ bufferView: 3, mimeType: "image/png" }];
    }
  }
  if (n !== colors.length / 3) throw new Error("test setup: colors length");
  return makeGlb(json, bin);
}
const convert = (glb) => {
  const warnings = [];
  const { usda } = glbToUsda(glb, { onWarning: (w) => warnings.push(w) });
  return { usda, warnings };
};
const line = (usda, name) => usda.split("\n").find((l) => l.includes(name)) ?? "";

const RGBA = [1, 0, 0, 1, 0, 1, 0, 0.5, 0, 0, 1, 0];
const RGB = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// VEC3: displayColor only, no material binding (glTF default material keeps vertex colors).
{
  const { usda, warnings } = convert(colored({ type: "VEC3", colors: RGB }));
  assert(line(usda, "primvars:displayColor").includes("[(1, 0, 0), (0, 1, 0), (0, 0, 1)]"), "VEC3 displayColor");
  assert(!usda.includes("displayOpacity") && !usda.includes("material:binding"), "VEC3: no opacity, no binding");
  assert(warnings.length === 0, `VEC3 warnings: ${warnings}`);
}

// VEC4 without a material: the glTF default material is OPAQUE, so alpha is ignored.
{
  const { usda } = convert(colored({ colors: RGBA }));
  assert(line(usda, "primvars:displayColor").includes("[(1, 0, 0), (0, 1, 0), (0, 0, 1)]"), "VEC4 RGB kept");
  assert(!usda.includes("displayOpacity"), "OPAQUE default material: alpha not written");
}

// VEC4 + OPAQUE material: alpha ignored (glTF), material has no opacity.
{
  const { usda } = convert(colored({ colors: RGBA, material: { alphaMode: "OPAQUE" } }));
  assert(!usda.includes("displayOpacity") && !usda.includes("inputs:opacity"), "OPAQUE material ignores vertex alpha");
}

// VEC4 + BLEND: displayOpacity = alpha × factor.a, material opacity reads it (fallback = factor.a).
for (const [factor, label] of [[1, "factor 1"], [0.5, "factor 0.5"]]) {
  const { usda, warnings } = convert(colored({ colors: RGBA, material: { alphaMode: "BLEND", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, factor] } } }));
  const want = [1, 0.5, 0].map((a) => a * factor).join(", ");
  assert(line(usda, "float[] primvars:displayOpacity").includes(`[${want}]`), `BLEND ${label}: displayOpacity ${line(usda, "displayOpacity")}`);
  assert(usda.includes("float inputs:opacity.connect = </Root/Materials/M/displayOpacityReader.outputs:result>"), `BLEND ${label}: opacity connected`);
  assert(usda.includes('uniform token info:id = "UsdPrimvarReader_float"') && usda.includes('string inputs:varname = "displayOpacity"'), `BLEND ${label}: reader`);
  assert(line(usda, "inputs:fallback").includes(`= ${factor}`), `BLEND ${label}: fallback = factor alpha`);
  assert(warnings.length === 0, `BLEND ${label} warnings: ${warnings}`);
}

// VEC4 + MASK: same, plus the cutoff.
{
  const { usda } = convert(colored({ colors: RGBA, material: { alphaMode: "MASK", alphaCutoff: 0.25 } }));
  assert(usda.includes("displayOpacityReader.outputs:result") && line(usda, "opacityThreshold").includes("0.25"), "MASK: reader + threshold");
}

// VEC4 + BLEND + baseColorTexture: texture alpha stays; vertex alpha cannot be multiplied in.
{
  const { usda, warnings } = convert(colored({ colors: RGBA, material: { alphaMode: "BLEND" }, texture: true }));
  assert(usda.includes("float inputs:opacity.connect = </Root/Materials/M/Texture_baseColor.outputs:a>"), "texture alpha connected");
  assert(!usda.includes("displayOpacityReader"), "no reader with a texture");
  assert(warnings.some((w) => w.includes("COLOR_0 alpha is not combined with the baseColorTexture alpha")), `texture + vertex alpha warning: ${warnings}`);
}

// Alpha 1 / 0.5 / 0 all survive (no clamping or dropping).
{
  const { usda } = convert(colored({ colors: [1, 1, 1, 1, 1, 1, 1, 0.5, 1, 1, 1, 0], material: { alphaMode: "BLEND" } }));
  assert(line(usda, "float[] primvars:displayOpacity").includes("[1, 0.5, 0]"), `alpha 1 / 0.5 / 0: ${line(usda, "displayOpacity")}`);
}

// Normalized integer colors.
{
  const u8 = convert(colored({ componentType: 5121, colors: RGBA, material: { alphaMode: "BLEND" } })).usda;
  assert(line(u8, "primvars:displayColor").includes("[(1, 0, 0), (0, 1, 0), (0, 0, 1)]"), "UNSIGNED_BYTE normalized RGB");
  assert(line(u8, "float[] primvars:displayOpacity").includes("[1, 0.5019608, 0]"), `UNSIGNED_BYTE alpha 128/255: ${line(u8, "displayOpacity")}`);
  const u16 = convert(colored({ type: "VEC3", componentType: 5123, colors: RGB })).usda;
  assert(line(u16, "primvars:displayColor").includes("[(1, 0, 0), (0, 1, 0), (0, 0, 1)]"), "UNSIGNED_SHORT normalized");
  // Missing `normalized` on an integer color: normalized anyway, with a warning.
  const { usda, warnings } = convert(colored({ componentType: 5121, normalized: false, colors: RGBA }));
  assert(line(usda, "primvars:displayColor").includes("[(1, 0, 0), (0, 1, 0), (0, 0, 1)]"), "unnormalized UNSIGNED_BYTE normalized");
  assert(warnings.some((w) => w.includes("is not marked normalized")), `unnormalized warning: ${warnings}`);
  // Signed integers without normalized are not valid colors.
  try { convert(colored({ componentType: 5120, normalized: false, colors: RGBA })); assert(false, "unnormalized BYTE COLOR_0 accepted"); }
  catch (e) { assert(e instanceof GltfValidationError && /must be FLOAT, or normalized/.test(e.message), `unnormalized BYTE: ${e.message}`); }
}
{
  // COLOR_0 as VEC2 is invalid.
  const glb = colored({ type: "VEC3", colors: RGB });
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer).getUint32(12, true))));
  json.accessors[1] = { bufferView: 1, componentType: 5126, count: 3, type: "VEC2" };
  const bin = glb.subarray(28 + new DataView(glb.buffer).getUint32(12, true));
  try { glbToUsda(makeGlb(json, bin)); assert(false, "VEC2 COLOR_0 accepted"); }
  catch (e) { assert(e instanceof GltfValidationError && /COLOR_0 .* must be VEC3 or VEC4/.test(e.message), `VEC2 COLOR_0: ${e.message}`); }
}

if (failures) { console.error(`color: ${failures} failure(s)`); process.exit(1); }
console.log("color tests passed");
