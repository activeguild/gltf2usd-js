// Converting texture images that USDZ cannot hold (USDZ allows PNG and JPEG only), e.g.
// EXT_texture_webp. Decoding WebP needs the platform: the async API (glbToUsdzAsync)
// converts with options.convertImage, which defaults to browserImageConverter where the
// browser provides createImageBitmap + OffscreenCanvas. The synchronous API and Node
// without a convertImage keep the previous behaviour (texture dropped, with a warning).

const USDZ_TYPES = new Set(["image/png", "image/jpeg"]);

/**
 * Image indices whose textures would be lost: the image a texture uses (its source, or
 * EXT_texture_webp's source when it has no PNG / JPEG source) is not PNG / JPEG.
 * @param {import("./glb.js").GltfAsset} asset
 * @returns {number[]}
 */
export function imagesToConvert(asset) {
  const out = new Set();
  for (const tex of asset.json.textures || []) {
    const index = tex.source ?? tex.extensions?.EXT_texture_webp?.source;
    if (index === undefined || out.has(index) || !asset.json.images?.[index]) continue;
    const img = asset.imageBytes(index);
    if (img && !USDZ_TYPES.has(img.mimeType)) out.add(index);
  }
  return [...out];
}

/**
 * Decode with the browser and re-encode: PNG when the image has any transparency,
 * otherwise JPEG (quality 0.95; the sources this is used for, like WebP, are usually
 * lossy already, and PNG would be many times larger). Returns null where the browser
 * APIs are missing (e.g. Node) or cannot decode the format (e.g. KTX2).
 * @param {Uint8Array} bytes
 * @param {string} mimeType
 * @returns {Promise<{bytes: Uint8Array, mimeType: string} | null>}
 */
export async function browserImageConverter(bytes, mimeType) {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  } catch {
    return null; // a format this browser cannot decode
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = canvas.getContext("2d");
  g.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const pixels = g.getImageData(0, 0, canvas.width, canvas.height).data;
  let opaque = true;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) { opaque = false; break; }
  const type = opaque ? "image/jpeg" : "image/png";
  const blob = await canvas.convertToBlob(opaque ? { type, quality: 0.95 } : { type });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: type };
}

/** True for a converter result that USDZ can package. */
export function isUsdzImage(result) {
  return !!result && result.bytes instanceof Uint8Array && USDZ_TYPES.has(result.mimeType);
}
