// COLOR_0 → primvars:displayColor / displayOpacity, and how vertex alpha combines with
// the material (see vertexOpacity() in src/convert.js).
import { glbToUsda, GltfValidationError } from "../src/index.js";
import { makeGlb, packParts } from "./gltf-builder.js";
import { encodePng } from "./png.js";
import { imageHasAlpha } from "../src/images.js";

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
  // texture: true (RGBA PNG) or { bytes, mimeType }.
  const image = texture === true ? { bytes: encodePng(2, 2, () => [255, 255, 255, 128]), mimeType: "image/png" } : texture;
  if (image) parts.push(image.bytes);
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
      json.images = [{ bufferView: 3, mimeType: image.mimeType }];
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

// u of the ramp texel center for alpha a (see rampU in src/convert.js), as USDA prints it.
const u = (a) => Number(((0.5 + a * 255) / 256).toPrecision(7));
const uvLine = (alphas) => `[${alphas.map((a) => `(${u(a)}, 0.5)`).join(", ")}]`;

// VEC4 + BLEND: displayOpacity = alpha × factor.a; the material's opacity comes from the
// alpha ramp texture (× factor.a), read through primvars:vertexAlphaUV (u = alpha).
for (const [factor, label] of [[1, "factor 1"], [0.5, "factor 0.5"]]) {
  const { usda, files, warnings } = (() => {
    const w = [];
    const r = glbToUsda(colored({ colors: RGBA, material: { alphaMode: "BLEND", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, factor] } } }), { onWarning: (x) => w.push(x) });
    return { ...r, warnings: w };
  })();
  const want = [1, 0.5, 0].map((a) => a * factor).join(", ");
  assert(line(usda, "float[] primvars:displayOpacity").includes(`[${want}]`), `BLEND ${label}: displayOpacity ${line(usda, "displayOpacity")}`);
  assert(line(usda, "primvars:vertexAlphaUV").includes(uvLine([1, 0.5, 0])), `BLEND ${label}: vertexAlphaUV ${line(usda, "vertexAlphaUV")}`);
  assert(usda.includes("float inputs:opacity.connect = </Root/Materials/M/Texture_vertexAlpha.outputs:a>"), `BLEND ${label}: opacity from the ramp`);
  assert(usda.includes('string inputs:varname = "vertexAlphaUV"'), `BLEND ${label}: UV reader`);
  const ramp = usda.slice(usda.indexOf('def Shader "Texture_vertexAlpha"'));
  assert(ramp.includes("@textures/vertex_alpha_ramp.png@") && ramp.includes(`float4 inputs:scale = (1, 1, 1, ${factor})`) && ramp.includes('inputs:wrapS = "clamp"'), `BLEND ${label}: ramp texture`);
  assert(files.some((f) => f.name === "textures/vertex_alpha_ramp.png"), `BLEND ${label}: ramp packaged`);
  assert(!usda.includes("UsdPrimvarReader_float\""), `BLEND ${label}: no float primvar reader (Quick Look draws it transparent)`);
  assert(warnings.length === 0, `BLEND ${label} warnings: ${warnings}`);
}

// The ramp is a 256 × 1 gray + alpha PNG with alpha = x.
{
  const { files } = glbToUsda(colored({ colors: RGBA, material: { alphaMode: "BLEND" } }));
  const png = files.find((f) => f.name.endsWith("vertex_alpha_ramp.png")).bytes;
  const dv = new DataView(png.buffer, png.byteOffset);
  assert(dv.getUint32(16) === 256 && dv.getUint32(20) === 1 && png[24] === 8 && png[25] === 4, "ramp is 256 × 1, 8-bit gray + alpha");
  const idat = png.indexOf(0x49, 33); // "IDAT" type follows its length
  const raw = png.subarray(idat + 4 + 2 + 5, idat + 4 + 2 + 5 + 513); // zlib header + stored block header
  assert(raw[0] === 0 && raw[1 + 2 * 128] === 128 && raw[2 + 2 * 128] === 128 && raw[2 + 2 * 255] === 255, "ramp pixels: gray = alpha = x");
}

// VEC4 + MASK: a 0 / 1 step ramp (4096 texels) whose middle is at COLOR_0.a = cutoff / factor.a,
// threshold 0.5 (Quick Look draws partial opacity inside a MASK cut-out; glTF draws it opaque).
/** Alpha channel of a 1-row gray + alpha PNG written with stored deflate blocks (src/png.js). */
function rampAlphas(png) {
  const dv = new DataView(png.buffer, png.byteOffset);
  const width = dv.getUint32(16);
  const idat = png.indexOf(0x49, 33); // "IDAT" type
  const raw = png.subarray(idat + 4 + 2 + 5, idat + 4 + 2 + 5 + 1 + 2 * width); // zlib + stored-block headers
  return Array.from({ length: width }, (_, x) => raw[2 + 2 * x] / 255);
}
/** Bilinear (1D) sampling with clamp-to-edge at u, as a GPU's linear filter does. */
function sampleLinear(alphas, u) {
  const t = u * alphas.length - 0.5;
  const i = Math.floor(t), f = t - i;
  const at = (k) => alphas[Math.min(alphas.length - 1, Math.max(0, k))];
  return at(i) * (1 - f) + at(i + 1) * f;
}
for (const [cutoff, factor] of [[0.25, 1], [0.25, 0.5], [0.5, 1], [0.7, 0.8], [1, 0.5], [0.3, 0]]) {
  const label = `MASK cutoff ${cutoff} factor ${factor}`;
  const { usda, files } = glbToUsda(colored({ colors: RGBA, material: { alphaMode: "MASK", alphaCutoff: cutoff, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, factor] } } }));
  const ramp = usda.slice(usda.indexOf('def Shader "Texture_vertexAlpha"'));
  const file = ramp.match(/@(textures\/vertex_alpha_step_\d+\.png)@/)?.[1];
  assert(file && ramp.includes("float4 inputs:scale = (1, 1, 1, 1)"), `${label}: step ramp, scale 1: ${ramp.slice(0, 200)}`);
  assert(line(usda, "opacityThreshold").includes("= 0.5"), `${label}: threshold 0.5 (the middle of the step)`);
  const alphas = rampAlphas(files.find((f) => f.name === file).bytes);
  assert(alphas.length === 4096 && alphas.every((a) => a === 0 || a === 1), `${label}: 4096 texels of 0 / 1`);
  // Sample like the renderer at u = vertexAlphaUV(a) for many a: kept (≥ 0.5) must match glTF
  // (a × factor ≥ cutoff) except within one step-ramp texel of the cut; partial values only there.
  const limit = factor > 0 ? cutoff / factor : Infinity;
  const texel = 256 / 4096 / 255; // one MASK-ramp texel in COLOR_0.a
  let wrong = 0, partial = 0;
  for (let k = 0; k <= 100000; k++) {
    const a = k / 100000;
    const v = sampleLinear(alphas, u(a));
    if (v > 0 && v < 1) { partial++; if (Math.abs(a - limit) > texel) wrong++; }
    if ((v >= 0.5) !== (a * factor >= cutoff) && Math.abs(a - limit) > texel / 2 + 1e-9) wrong++;
  }
  assert(!wrong, `${label}: ${wrong} samples disagree with glTF away from the cut`);
  assert(partial <= Math.ceil(2 * texel * 100000) + 1, `${label}: partial-opacity band is ${partial / 100000} of the alpha range`);
}
{
  // BLEND and MASK materials in one file get separate ramps, each packaged once.
  const glb = colored({ colors: RGBA, material: { alphaMode: "MASK" } });
  const dvj = new DataView(glb.buffer);
  const jsonLen = dvj.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  json.materials.push({ name: "B", alphaMode: "BLEND" }, { name: "B2", alphaMode: "BLEND" });
  for (const m of [1, 2]) {
    json.meshes.push({ name: `M${m}`, primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, material: m }] });
    json.nodes.push({ mesh: json.meshes.length - 1 });
    json.scenes[0].nodes.push(json.nodes.length - 1);
  }
  const { files } = glbToUsda(makeGlb(json, glb.subarray(28 + jsonLen)));
  const names = files.map((f) => f.name).sort().join();
  assert(/^textures\/vertex_alpha_ramp\.png,textures\/vertex_alpha_step_\d+\.png$/.test(names), `ramps packaged once each: ${names}`);
}

// A mesh without vertex alpha that shares the material gets alpha 1 in its ramp UVs.
{
  const glb = colored({ colors: RGBA, material: { alphaMode: "BLEND" } });
  const dvj = new DataView(glb.buffer);
  const jsonLen = dvj.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  json.meshes.push({ name: "Plain", primitives: [{ attributes: { POSITION: 0 }, material: 0 }] });
  json.nodes.push({ mesh: 1 });
  json.scenes[0].nodes.push(1);
  const { usda } = convert(makeGlb(json, glb.subarray(28 + jsonLen)));
  const plain = usda.slice(usda.indexOf('def Mesh "Plain"'));
  assert(line(plain, "primvars:vertexAlphaUV").includes(uvLine([1, 1, 1])), `shared material, no COLOR_0: ${line(plain, "vertexAlphaUV")}`);
  assert(!plain.slice(0, plain.indexOf("}")).includes("displayOpacity"), "no displayOpacity without COLOR_0");
}

// VEC4 + BLEND + baseColorTexture: texture alpha stays; vertex alpha cannot be multiplied in.
{
  const { usda, warnings } = convert(colored({ colors: RGBA, material: { alphaMode: "BLEND" }, texture: true }));
  assert(usda.includes("float inputs:opacity.connect = </Root/Materials/M/Texture_baseColor.outputs:a>"), "texture alpha connected");
  assert(!usda.includes("Texture_vertexAlpha") && !usda.includes("vertexAlphaUV"), "no ramp with a base color texture");
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
  // Integer colors must be normalized UNSIGNED_BYTE / UNSIGNED_SHORT (glTF 2.0; validate.js).
  for (const [componentType, label] of [[5121, "UNSIGNED_BYTE"], [5120, "BYTE"], [5122, "SHORT"]]) {
    try { convert(colored({ componentType, normalized: false, colors: RGBA })); assert(false, `unnormalized ${label} COLOR_0 accepted`); }
    catch (e) { assert(e instanceof GltfValidationError && new RegExp(`COLOR_0 \\(accessor 1\\) is ${label}; allowed: FLOAT, normalized UNSIGNED_BYTE, normalized UNSIGNED_SHORT`).test(e.message), `unnormalized ${label}: ${e.message}`); }
  }
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

// Base color textures without an alpha channel: glTF reads alpha 1, Quick Look reads the
// UsdUVTexture's `a` as 0, so the opacity comes from the factor (and the vertex alpha ramp).
{
  const white = () => [255, 255, 255, 255];
  const png = (colorType, trns) => ({ bytes: encodePng(2, 2, white, { colorType, trns }), mimeType: "image/png" });
  const jpeg = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]), mimeType: "image/jpeg" };
  const gray = png(0), rgb = png(2), grayAlpha = png(4), rgba = png(6);
  const grayKey = png(0, new Uint8Array([0, 0])), rgbKey = png(2, new Uint8Array(6));

  for (const [label, img, has] of [["gray", gray, false], ["RGB", rgb, false], ["gray + alpha", grayAlpha, true], ["RGBA", rgba, true],
    ["gray + tRNS", grayKey, true], ["RGB + tRNS", rgbKey, true], ["JPEG", jpeg, false]]) {
    assert(imageHasAlpha(img.bytes) === has, `imageHasAlpha ${label}`);
  }
  assert(imageHasAlpha(new Uint8Array([1, 2, 3, 4])), "unknown bytes count as alpha");
  assert(imageHasAlpha(rgb.bytes.subarray(0, 33)), "PNG cut before IDAT counts as alpha");

  const opacity = (usda) => line(usda, "inputs:opacity ").trim() || line(usda, "inputs:opacity.connect").trim();
  for (const [label, img, mode, factor, expect] of [
    ["MASK gray", gray, "MASK", 1, "float inputs:opacity = 1"],
    ["MASK RGB", rgb, "MASK", 0.8, "float inputs:opacity = 0.8"],
    ["BLEND JPEG", jpeg, "BLEND", 0.5, "float inputs:opacity = 0.5"],
    ["BLEND RGBA", rgba, "BLEND", 0.5, "float inputs:opacity.connect = </Root/Materials/M/Texture_baseColor.outputs:a>"],
    ["MASK gray + tRNS", grayKey, "MASK", 1, "float inputs:opacity.connect = </Root/Materials/M/Texture_baseColor.outputs:a>"],
  ]) {
    const material = { alphaMode: mode, alphaCutoff: 0.001, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, factor] } };
    const { usda, warnings } = convert(colored({ type: "VEC3", colors: RGB, material, texture: img }));
    assert(opacity(usda) === expect, `${label}: ${opacity(usda)}`);
    assert(usda.includes("color3f inputs:diffuseColor.connect = </Root/Materials/M/Texture_baseColor.outputs:rgb>"), `${label}: texture still drives the color`);
    if (mode === "MASK") assert(line(usda, "inputs:opacityThreshold").includes("0.001"), `${label}: cutoff`);
    assert(!warnings.length, `${label}: no warnings: ${warnings}`);
  }
  {
    const { usda } = convert(colored({ type: "VEC3", colors: RGB, material: {}, texture: gray }));
    assert(!usda.includes("inputs:opacity"), "OPAQUE gray texture: no opacity");
  }
  {
    // Unlit takes the same path.
    const material = { alphaMode: "MASK", extensions: { KHR_materials_unlit: {} } };
    const { usda } = convert(colored({ type: "VEC3", colors: RGB, material, texture: gray }));
    assert(opacity(usda) === "float inputs:opacity = 1", `unlit MASK gray: ${opacity(usda)}`);
  }
  {
    // Vertex alpha × an alpha-less texture is exact: the ramp gives COLOR_0.a × factor.a.
    const material = { alphaMode: "BLEND", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.5] } };
    const { usda, warnings } = convert(colored({ colors: RGBA, material, texture: rgb }));
    assert(opacity(usda) === "float inputs:opacity.connect = </Root/Materials/M/Texture_vertexAlpha.outputs:a>", `vertex alpha + RGB texture: ${opacity(usda)}`);
    assert(usda.includes("primvars:vertexAlphaUV") && usda.includes("Texture_baseColor"), "vertex alpha + RGB texture: ramp UVs and base color texture");
    assert(!warnings.some((w) => w.includes("COLOR_0 alpha is not combined")), `vertex alpha + RGB texture: no warning: ${warnings}`);
  }
}

// doubleSided is written, with a warning that Quick Look ignores it (once per conversion).
{
  const { usda, warnings } = convert(colored({ type: "VEC3", colors: RGB, material: { doubleSided: true } }));
  assert(line(usda, "doubleSided").includes("uniform bool doubleSided = 1"), "doubleSided written");
  assert(warnings.filter((w) => w.includes("Quick Look / AR Quick Look ignore")).length === 1, `doubleSided warning: ${warnings}`);
  const single = convert(colored({ type: "VEC3", colors: RGB, material: {} }));
  assert(!single.usda.includes("doubleSided") && !single.warnings.length, "single-sided: no attribute, no warning");
}

if (failures) { console.error(`color: ${failures} failure(s)`); process.exit(1); }
console.log("color tests passed");
