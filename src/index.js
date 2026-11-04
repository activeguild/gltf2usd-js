// Public API: works in browsers and Node (ESM).
import { parseGLB, parseGltf, GltfAsset, resolveResource, DataUnavailableError } from "./glb.js";
import { GltfValidationError, DEFAULT_LIMITS } from "./validate.js";
import { gltfToStage } from "./convert.js";
import { writeUsda } from "./usda.js";
import { packUsdz } from "./usdz.js";
import { Layer, Prim } from "./ir.js";

export {
  parseGLB, parseGltf, GltfAsset, resolveResource, gltfToStage, writeUsda, packUsdz, Layer, Prim,
  GltfValidationError, DataUnavailableError, DEFAULT_LIMITS,
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
  const layerName = options.layerName ?? "model.usda";
  const { usda, files } = glbToUsda(input, options);
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
