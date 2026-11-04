// Public API: works in browsers and Node (ESM).
import { parseGLB, GltfAsset } from "./glb.js";
import { gltfToUsda } from "./usda.js";
import { packUsdz } from "./usdz.js";

export { parseGLB, GltfAsset, gltfToUsda, packUsdz };

/**
 * GLB (ArrayBuffer | Uint8Array) → { usda: string, files: {name, bytes}[] }
 * options.onWarning(msg): called once per kind of glTF data that was dropped
 *   (unsupported extensions, primitive modes, animations, unresolvable images, ...).
 * options.texturePrefix: folder for packaged textures (default "textures/").
 * options.instancing: meshes used by several nodes become instanceable references
 *   to a prototype under /Root/Meshes (default true; false duplicates them).
 */
export function glbToUsda(input, options = {}) {
  const asset = new GltfAsset(parseGLB(toArrayBuffer(input)));
  return gltfToUsda(asset, options);
}

/** GLB (ArrayBuffer | Uint8Array) → USDZ bytes (Uint8Array) */
export function glbToUsdz(input, options = {}) {
  const layerName = options.layerName ?? "model.usda";
  const { usda, files } = glbToUsda(input, options);
  return packUsdz([{ name: layerName, bytes: new TextEncoder().encode(usda) }, ...files]);
}

function toArrayBuffer(input) {
  if (input instanceof ArrayBuffer) return input;
  if (ArrayBuffer.isView(input)) {
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  }
  throw new Error("Expected ArrayBuffer or Uint8Array");
}
