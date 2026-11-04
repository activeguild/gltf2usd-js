// Images USDZ cannot hold (EXT_texture_webp): the sync API drops them with a warning; the
// async API converts them with options.convertImage (browserImageConverter by default,
// which is unavailable in Node and returns null there).
import { glbToUsda, glbToUsdaAsync, glbToUsdzAsync, browserImageConverter } from "../src/index.js";
import { makeGlb, packParts } from "./gltf-builder.js";
import { encodePng } from "./png.js";

let failures = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); failures++; } };

// A quad textured with a "WebP" image (the bytes only need to look like WebP here).
const fakeWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
function webpGlb({ pngFallback = false } = {}) {
  const png = encodePng(1, 1, () => [255, 0, 0, 255]);
  const { bin, views } = packParts([
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 0, 1]), fakeWebp, png,
  ]);
  const json = {
    asset: { version: "2.0" },
    extensionsUsed: ["EXT_texture_webp"],
    ...(pngFallback ? {} : { extensionsRequired: ["EXT_texture_webp"] }),
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ name: "M", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ ...(pngFallback ? { source: 1 } : {}), extensions: { EXT_texture_webp: { source: 0 } } }],
    images: [{ name: "skin", mimeType: "image/webp", bufferView: 2 }, { name: "fallback", mimeType: "image/png", bufferView: 3 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC2" },
    ],
    bufferViews: views, buffers: [{ byteLength: bin.length }],
  };
  return makeGlb(json, bin);
}
const glb = webpGlb();
const converted = encodePng(2, 2, () => [0, 255, 0, 255]);

{
  // Sync API: no conversion; the texture is dropped with warnings.
  const warnings = [];
  const { usda, files } = glbToUsda(glb, { onWarning: (w) => warnings.push(w) });
  assert(!files.length && !usda.includes("UsdUVTexture"), "sync: WebP texture dropped");
  assert(warnings.some((w) => /EXT_texture_webp \(required\) is not supported/.test(w)), `sync: extension warning: ${warnings}`);
  assert(warnings.some((w) => /Image 0 has unsupported type image\/webp.*glbToUsdzAsync/.test(w)), `sync: image warning: ${warnings}`);
}
{
  // Async API with a converter: the WebP image is packaged as the converter's PNG.
  const warnings = [];
  const calls = [];
  const { usda, files } = await glbToUsdaAsync(glb, {
    onWarning: (w) => warnings.push(w),
    convertImage: async (bytes, mimeType) => { calls.push([bytes.length, mimeType]); return { bytes: converted, mimeType: "image/png" }; },
  });
  assert(calls.length === 1 && calls[0][0] === fakeWebp.length && calls[0][1] === "image/webp", `converter called once with the WebP bytes: ${JSON.stringify(calls)}`);
  assert(files.length === 1 && files[0].name === "textures/skin.png" && files[0].bytes === converted, `converted texture packaged: ${files.map((f) => f.name)}`);
  assert(usda.includes("@textures/skin.png@") && usda.includes("inputs:diffuseColor.connect"), "texture connected");
  assert(!warnings.length, `async: no warnings once converted: ${warnings}`);
  // JPEG results are accepted too, and USDZ packaging works.
  const usdz = await glbToUsdzAsync(glb, { convertImage: async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), mimeType: "image/jpeg" }) });
  assert(new TextDecoder().decode(usdz).includes("textures/skin.jpg"), "JPEG result packaged as .jpg");
}
{
  // Converter returns null, an unusable type, or throws: the texture is dropped with warnings.
  for (const [label, convertImage, pattern] of [
    ["null", async () => null, /unsupported type image\/webp/],
    ["gif", async () => ({ bytes: new Uint8Array(4), mimeType: "image/gif" }), /unsupported type image\/webp/],
    ["throws", async () => { throw new Error("decoder exploded"); }, /could not be converted: decoder exploded/],
  ]) {
    const warnings = [];
    const { files } = await glbToUsdaAsync(glb, { convertImage, onWarning: (w) => warnings.push(w) });
    assert(!files.length, `${label}: nothing packaged`);
    assert(warnings.some((w) => pattern.test(w)) && warnings.some((w) => /EXT_texture_webp/.test(w)), `${label}: warnings ${warnings}`);
  }
}
{
  // A PNG fallback source is used as before; the converter is not called.
  let called = false;
  const { files } = await glbToUsdaAsync(webpGlb({ pngFallback: true }), { convertImage: async () => { called = true; return null; } });
  assert(!called && files.length === 1 && files[0].name === "textures/fallback.png", `PNG fallback used: ${files.map((f) => f.name)}`);
}
{
  // The default (browser) converter is unavailable in Node: same result as the sync API.
  if (typeof OffscreenCanvas !== "function") {
    assert((await browserImageConverter(fakeWebp, "image/webp")) === null, "browserImageConverter returns null without browser APIs");
    const { files } = await glbToUsdaAsync(glb);
    assert(!files.length, "async without a converter in Node: dropped");
  }
}

if (failures) { console.error(`images: ${failures} failure(s)`); process.exit(1); }
console.log("image tests passed");
