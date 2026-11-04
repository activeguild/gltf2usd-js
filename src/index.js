// Public API: works in browsers and Node (ESM).
import { parseGLB, parseGltf, GltfAsset, resolveResource, DataUnavailableError } from "./glb.js";
import { GltfValidationError, DEFAULT_LIMITS } from "./validate.js";
import { gltfToStage } from "./convert.js";
import { writeUsda } from "./usda.js";
import { packUsdz, UsdzLimitError } from "./usdz.js";
import { Layer, Prim } from "./ir.js";
import { imagesToConvert, browserImageConverter, isUsdzImage } from "./images.js";

export {
  parseGLB, parseGltf, GltfAsset, resolveResource, gltfToStage, writeUsda, packUsdz, Layer, Prim,
  GltfValidationError, DataUnavailableError, DEFAULT_LIMITS, UsdzLimitError, browserImageConverter,
};

/** GltfAsset → { usda, files }: gltfToStage (glTF → USD IR) followed by writeUsda (IR → text). */
export function gltfToUsda(asset, options = {}) {
  const { layer, files } = gltfToStage(asset, options);
  return { usda: writeUsda(layer), files };
}

/**
 * glTF → { usda: string, files: {name, bytes}[] }
 *
 * input: GLB or .gltf bytes (ArrayBuffer | Uint8Array), .gltf JSON text (string),
 *   or an already parsed glTF JSON object.
 * options.resources: files referenced by non-data: uris (external .bin / images),
 *   as a Map or object keyed by uri, or a function (uri) => bytes. Lookup tries the
 *   uri as written, percent-decoded, and its bare file name.
 * options.onWarning(msg): called once per kind of glTF data that was dropped
 *   (unsupported extensions, primitive modes, animations, unresolvable images, ...).
 * options.texturePrefix: folder for packaged textures (default "textures/").
 * options.instancing: meshes used by several nodes become instanceable references
 *   to a prototype under /Root/Meshes (default true; false duplicates them).
 * options.animation: index or name of the glTF animation to convert (default 0).
 *   USD has one timeline, so only one animation is written.
 * options.animationMode: "skeleton" (default) writes node animation as UsdSkel
 *   (animated subtrees become joints, meshes bound rigidly), which AR Quick Look-style
 *   viewers play; "xform" writes time-sampled translate / orient / scale xformOps.
 * options.limits: resource limits, e.g. { maxInputBytes, maxAccessorValues, maxNodeDepth }
 *   (defaults in DEFAULT_LIMITS; Infinity disables one).
 *
 * Invalid input (not glTF 2.0, references or byte ranges out of bounds, limits exceeded)
 * throws GltfValidationError with the offending index in the message.
 */
export function glbToUsda(input, options = {}) {
  const asset = new GltfAsset(parseInput(input, options), { resources: options.resources, limits: options.limits });
  return gltfToUsda(asset, options);
}

/** Same input and options as glbToUsda → USDZ bytes (Uint8Array). */
export function glbToUsdz(input, options = {}) {
  return packUsda(glbToUsda(input, options), options);
}

/**
 * Like glbToUsda, but first converts texture images that USDZ cannot hold (e.g. WebP from
 * EXT_texture_webp) to PNG / JPEG:
 * options.convertImage(bytes, mimeType) → Promise<{ bytes, mimeType: "image/png" | "image/jpeg" } | null>.
 * The default uses the browser (createImageBitmap + OffscreenCanvas; see images.js); in Node
 * pass your own (e.g. one built on an image library). Images it cannot convert are dropped
 * with a warning, as in glbToUsda.
 */
export async function glbToUsdaAsync(input, options = {}) {
  const asset = new GltfAsset(parseInput(input, options), { resources: options.resources, limits: options.limits });
  const convert = options.convertImage ?? browserImageConverter;
  const imageOverrides = new Map();
  for (const index of imagesToConvert(asset)) {
    const img = asset.imageBytes(index);
    let result = null;
    try {
      result = await convert(img.bytes, img.mimeType);
    } catch (e) {
      options.onWarning?.(`Image ${index} (${img.mimeType}) could not be converted: ${e.message}`);
    }
    if (isUsdzImage(result)) imageOverrides.set(index, result);
  }
  return gltfToUsda(asset, { ...options, imageOverrides });
}

/** Same input and options as glbToUsdaAsync → USDZ bytes (Uint8Array). */
export async function glbToUsdzAsync(input, options = {}) {
  return packUsda(await glbToUsdaAsync(input, options), options);
}

function packUsda({ usda, files }, options) {
  const layerName = options.layerName ?? "model.usda";
  return packUsdz([{ name: layerName, bytes: new TextEncoder().encode(usda) }, ...files]);
}

function parseInput(input, { limits } = {}) {
  if (typeof input === "string") {
    try {
      return { json: JSON.parse(input), bin: null };
    } catch (e) {
      throw new GltfValidationError(`glTF JSON text is not valid JSON (${e.message})`);
    }
  }
  if (input instanceof ArrayBuffer) return parseGltf(input, { limits });
  if (ArrayBuffer.isView(input)) {
    return parseGltf(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength), { limits });
  }
  if (input && typeof input === "object" && input.asset) return { json: input, bin: null };
  throw new Error("Expected GLB / glTF bytes (ArrayBuffer or Uint8Array), glTF JSON text, or a glTF object");
}
