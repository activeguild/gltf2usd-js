// KHR_materials_transmission → opacity = max(1 - transmissionFactor, 0.2) (see transmissionOpacity()
// in src/convert.js). UsdPreviewSurface has no transmission input.
import { toUsda } from "../src/index.js";
import { makeGlb, packParts } from "./gltf-builder.js";
import { encodePng } from "./png.js";

let failures = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); failures++; } };

/** One triangle (with UVs) using material 0; texture: a base color PNG. */
function doc(material, { texture = false, used = ["KHR_materials_transmission"] } = {}) {
  const parts = [new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 0, 1])];
  if (texture) parts.push(encodePng(2, 2, () => [255, 255, 255, 128]));
  const { bin, views } = packParts(parts);
  const json = {
    asset: { version: "2.0" },
    extensionsUsed: used,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC2" },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
    // Dielectric unless the case says otherwise (glTF's default metallicFactor is 1, which transmits nothing).
    materials: [{ name: "Glass", ...material, pbrMetallicRoughness: { metallicFactor: 0, ...(material.pbrMetallicRoughness || {}) } }],
  };
  if (texture) {
    json.materials[0].pbrMetallicRoughness = { ...json.materials[0].pbrMetallicRoughness, baseColorTexture: { index: 0 } };
    json.textures = [{ source: 0 }];
    json.images = [{ bufferView: 2, mimeType: "image/png" }];
  }
  const warnings = [];
  const { usda } = toUsda(makeGlb(json, bin), { onWarning: (w) => warnings.push(w) });
  return { usda, warnings, mat: usda.slice(usda.indexOf('def Material "Glass"')) };
}
const tr = (t, extra = {}) => ({ extensions: { KHR_materials_transmission: { transmissionFactor: t, ...extra } } });

// OPAQUE: transmission makes the material translucent; full transmission keeps the floor (0.2).
{
  const { mat, warnings } = doc(tr(1));
  assert(mat.includes("float inputs:opacity = 0.2"), "transmission 1 → opacity floor 0.2");
  assert(warnings.some((w) => w.includes("approximated as opacity")), "approximation is reported");
  assert(!warnings.some((w) => w.includes("not supported")), "extension is not reported as unsupported");
}
assert(doc(tr(0.3)).mat.includes("float inputs:opacity = 0.7"), "transmission 0.3 → opacity 0.7");
assert(doc(tr(0.9)).mat.includes("float inputs:opacity = 0.2"), "transmission 0.9 → floor 0.2");
{
  const { mat, warnings } = doc(tr(0));
  assert(!mat.includes("inputs:opacity"), "transmission 0 → opaque");
  assert(!warnings.some((w) => w.includes("approximated")), "no approximation warning for 0");
}
assert(!doc({ extensions: { KHR_materials_transmission: {} } }).mat.includes("inputs:opacity"), "default factor 0");
assert(!doc(tr("1")).mat.includes("inputs:opacity"), "non-number factor → default 0");
assert(doc(tr(5)).mat.includes("float inputs:opacity = 0.2"), "factor clamped to 1");

// BLEND: alpha × transmission opacity (constant and through the base color texture's alpha scale).
assert(doc({ alphaMode: "BLEND", pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 0.5] }, ...tr(0.5) })
  .mat.includes("float inputs:opacity = 0.25"), "BLEND: 0.5 alpha × 0.5");
{
  const { mat } = doc({ alphaMode: "BLEND", pbrMetallicRoughness: { baseColorFactor: [1, 0.5, 1, 0.5] }, ...tr(1) }, { texture: true });
  assert(mat.includes("float inputs:opacity.connect = </Root/Materials/Glass/Texture_baseColor.outputs:a>"), "BLEND textured: opacity from texture alpha");
  assert(mat.includes("float4 inputs:scale = (1, 0.5, 1, 0.1)"), "BLEND textured: alpha scale × 0.2, rgb unchanged");
}
{
  // OPAQUE with a base color texture: glTF ignores the texture alpha, so a constant opacity.
  const { mat } = doc(tr(0.5), { texture: true });
  assert(mat.includes("float inputs:opacity = 0.5") && !mat.includes("inputs:opacity.connect"), "OPAQUE textured: constant opacity");
  assert(mat.includes("float4 inputs:scale = (1, 1, 1, 1)"), "OPAQUE textured: scale unchanged");
}

// MASK and unlit: ignored with a warning.
{
  const { mat, warnings } = doc({ alphaMode: "MASK", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.8] }, ...tr(1) });
  assert(mat.includes("float inputs:opacity = 0.8") && mat.includes("inputs:opacityThreshold = 0.5"), "MASK unchanged");
  assert(warnings.some((w) => w.includes("ignored with alphaMode MASK")), "MASK warning");
}
{
  const m = tr(1);
  m.extensions.KHR_materials_unlit = {};
  const { mat, warnings } = doc(m, { used: ["KHR_materials_transmission", "KHR_materials_unlit"] });
  assert(!mat.includes("inputs:opacity"), "unlit: transmission ignored");
  assert(warnings.some((w) => w.includes("ignored on an unlit material")), "unlit warning");
}
assert(doc(tr(1, { transmissionTexture: { index: 0 } })).warnings.some((w) => w.includes("transmissionTexture")), "transmissionTexture is reported");

// transmissionTexture is only reported when the approximation is applied (factor 0 / MASK / unlit: irrelevant).
assert(!doc(tr(0, { transmissionTexture: { index: 0 } })).warnings.some((w) => w.includes("transmissionTexture")), "no transmissionTexture warning for factor 0");
{
  const { warnings } = doc({ alphaMode: "MASK", ...tr(1, { transmissionTexture: { index: 0 } }) });
  assert(!warnings.some((w) => w.includes("transmissionTexture")), "no transmissionTexture warning with MASK");
}

// Metallic: glTF transmits through the dielectric part only → transmitted = factor × (1 − metallic).
{
  const { mat, warnings } = doc({ pbrMetallicRoughness: { metallicFactor: 1 }, ...tr(1) });
  assert(!mat.includes("inputs:opacity"), "fully metallic: opaque");
  assert(!warnings.some((w) => w.includes("approximated")), "fully metallic: no approximation warning");
}
{
  // metallicFactor omitted = 1 (glTF default).
  const m = tr(1);
  m.pbrMetallicRoughness = { metallicFactor: undefined };
  assert(!doc(m).mat.includes("inputs:opacity"), "default metallic 1: opaque");
}
assert(doc({ pbrMetallicRoughness: { metallicFactor: 0.5 }, ...tr(0.8) }).mat.includes("float inputs:opacity = 0.6"),
  "metallic 0.5, transmission 0.8 → opacity 1 − 0.4");
assert(doc({ pbrMetallicRoughness: { metallicFactor: 0.01 }, ...tr(1) }).mat.includes("float inputs:opacity = 0.2"),
  "nearly dielectric glass keeps the floor");
assert(doc({ pbrMetallicRoughness: { metallicFactor: 0, metallicRoughnessTexture: { index: 0 } }, ...tr(1) }, { texture: true })
  .warnings.some((w) => w.includes("metallicRoughnessTexture is not taken into account")), "metallic texture is reported");

// BLEND + COLOR_0 alpha: primvars:displayOpacity carries the same transmission factor as the material.
{
  const parts = [new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([1, 1, 1, 1, 1, 1, 1, 0.5, 1, 1, 1, 1])];
  const { bin, views } = packParts(parts);
  const json = {
    asset: { version: "2.0" },
    extensionsUsed: ["KHR_materials_transmission"],
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC4" },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
    materials: [{ name: "Glass", alphaMode: "BLEND", pbrMetallicRoughness: { metallicFactor: 0 }, ...tr(0.5) }],
  };
  const { usda } = toUsda(makeGlb(json, bin));
  assert(usda.includes("float[] primvars:displayOpacity = [0.5, 0.25, 0.5]"), `displayOpacity × transmission: ${usda.match(/primvars:displayOpacity = [^\n]*/)}`);
  assert(usda.includes("float4 inputs:scale = (1, 1, 1, 0.5)"), "vertex alpha ramp scale × transmission");
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("transmission tests passed");
