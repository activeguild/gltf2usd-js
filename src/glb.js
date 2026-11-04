// GLB (glTF 2.0 binary) parser. Zero dependencies, works in browser and Node.
import { decodeMeshopt } from "./meshopt.js";
import { GltfValidationError, COMPONENT_SIZE, TYPE_COUNT, elementLayout, resolveLimits, validateDocument } from "./validate.js";

export { GltfValidationError };
// Spec: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#glb-file-format-specification

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

const COMPONENT_INFO = {
  5120: { ctor: Int8Array, size: 1, norm: (v) => Math.max(v / 127, -1) },
  5121: { ctor: Uint8Array, size: 1, norm: (v) => v / 255 },
  5122: { ctor: Int16Array, size: 2, norm: (v) => Math.max(v / 32767, -1) },
  5123: { ctor: Uint16Array, size: 2, norm: (v) => v / 65535 },
  5125: { ctor: Uint32Array, size: 4, norm: (v) => v },
  5126: { ctor: Float32Array, size: 4, norm: (v) => v },
};


/**
 * Parse either a GLB or a .gltf (JSON text) ArrayBuffer into { json, bin }.
 * bin is the GLB BIN chunk as a Uint8Array, or null.
 * options.limits.maxInputBytes bounds the input size (see DEFAULT_LIMITS).
 */
export function parseGltf(arrayBuffer, { limits } = {}) {
  checkInputSize(arrayBuffer.byteLength, limits);
  if (arrayBuffer.byteLength >= 4 && new DataView(arrayBuffer).getUint32(0, true) === GLB_MAGIC) {
    return parseGLB(arrayBuffer, { limits });
  }
  let json;
  try {
    json = JSON.parse(new TextDecoder().decode(arrayBuffer));
  } catch (e) {
    throw new GltfValidationError(`Input is neither a GLB nor glTF JSON (${e.message})`);
  }
  return { json, bin: null };
}

function checkInputSize(byteLength, limits) {
  const max = resolveLimits(limits).maxInputBytes;
  if (byteLength > max) throw new GltfValidationError(`Input is ${byteLength} bytes, more than limits.maxInputBytes (${max})`);
}

/**
 * Parse a GLB ArrayBuffer into { json, bin } where bin is a Uint8Array (may be null).
 * The header and chunk layout are checked against the GLB spec: totalLength equals the
 * input size, chunks are 4-byte aligned and inside the input, the first chunk is the
 * only JSON chunk, a BIN chunk (at most one) comes second. Unknown chunks are skipped.
 */
export function parseGLB(arrayBuffer, { limits } = {}) {
  checkInputSize(arrayBuffer.byteLength, limits);
  const fail = (msg) => { throw new GltfValidationError(msg); };
  if (arrayBuffer.byteLength < 12) fail(`GLB is ${arrayBuffer.byteLength} bytes, shorter than its 12-byte header`);
  const dv = new DataView(arrayBuffer);
  if (dv.getUint32(0, true) !== GLB_MAGIC) fail("Invalid GLB magic");
  const version = dv.getUint32(4, true);
  if (version !== 2) fail(`Unsupported GLB version ${version}`);
  const totalLength = dv.getUint32(8, true);
  if (totalLength !== arrayBuffer.byteLength) {
    fail(`GLB totalLength does not match input size (header says ${totalLength} bytes, input is ${arrayBuffer.byteLength})`);
  }
  if (totalLength < 20) fail("GLB has no room for a JSON chunk");

  let offset = 12;
  let json = null;
  let bin = null;
  for (let index = 0; offset < totalLength; index++) {
    if (offset + 8 > totalLength) fail(`GLB chunk ${index} header is truncated at byte ${offset}`);
    const chunkLength = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    if (offset + 8 + chunkLength > totalLength) {
      fail(`GLB chunk exceeds input bounds (chunk ${index} at byte ${offset} is ${chunkLength} bytes, input is ${totalLength})`);
    }
    if (chunkLength % 4 !== 0) fail(`GLB chunk ${index} length ${chunkLength} is not a multiple of 4`);
    const chunkData = new Uint8Array(arrayBuffer, offset + 8, chunkLength);
    if (chunkType === CHUNK_JSON) {
      if (index !== 0) fail(json ? "GLB has more than one JSON chunk" : "GLB JSON chunk must be the first chunk");
      try {
        json = JSON.parse(new TextDecoder().decode(chunkData));
      } catch (e) {
        fail(`GLB JSON chunk is not valid JSON (${e.message})`);
      }
    } else if (index === 0) {
      fail("GLB JSON chunk must be the first chunk");
    } else if (chunkType === CHUNK_BIN) {
      if (bin) fail("GLB has more than one BIN chunk");
      if (index !== 1) fail("GLB BIN chunk must be the second chunk");
      bin = chunkData;
    } // other chunk types: skipped, as the spec requires
    offset += 8 + chunkLength;
  }
  if (!json) fail("GLB has no JSON chunk");
  return { json, bin };
}

/**
 * Thrown when an accessor's bytes are not in the file in readable form, e.g. a
 * bufferView compressed with EXT_meshopt_compression whose buffer is only a
 * fallback placeholder. Callers skip the affected primitive / channel and warn.
 */
export class DataUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "DataUnavailableError";
  }
}

/**
 * Thin wrapper giving typed access to glTF buffers / bufferViews / accessors / images.
 */
export class GltfAsset {
  /**
   * @param {{json: object, bin: Uint8Array|null}} parsed
   * @param {object} [options]
   * @param {ResourceSource} [options.resources]  external files referenced by uri (see resolveResource)
   * @param {object} [options.limits]  resource limits (see DEFAULT_LIMITS in validate.js)
   * Throws GltfValidationError when the document is not valid glTF 2.0 (see validate.js).
   */
  constructor({ json, bin }, { resources, limits } = {}) {
    this.json = json;
    this.bin = bin;
    this._resources = resources;
    this.limits = resolveLimits(limits);
    validateDocument(json, this.limits);
    this._buffers = (json.buffers || []).map((b, i) => this._loadBuffer(b, i));
    this._decodedViews = new Map(); // EXT_meshopt_compression results by bufferView index
  }

  _loadBuffer(buffer, index) {
    if (buffer.uri === undefined) {
      // EXT_meshopt_compression: a "fallback" buffer has no data; its views must be decoded.
      // KHR_meshopt_compression (not supported) marks its fallback buffers the same way; their
      // views are then unreadable, so the affected meshes are skipped with a warning.
      const ext = buffer.extensions;
      if (ext?.EXT_meshopt_compression?.fallback || ext?.KHR_meshopt_compression?.fallback) return null;
      if (index !== 0 || !this.bin) throw new GltfValidationError(`Buffer ${index} has no uri and no GLB BIN chunk`);
      return this._checkBufferSize(this.bin, buffer, index, "GLB BIN chunk");
    }
    if (typeof buffer.uri !== "string") throw new GltfValidationError(`buffer ${index}: uri must be a string`);
    if (buffer.uri.startsWith("data:")) return this._checkBufferSize(decodeDataUri(buffer.uri), buffer, index, `Buffer ${index} data URI`);
    const bytes = resolveResource(this._resources, buffer.uri);
    if (!bytes) {
      throw new Error(`External buffer "${buffer.uri}" was not provided (pass it in options.resources)`);
    }
    if (bytes.byteLength > this.limits.maxInputBytes) {
      throw new GltfValidationError(`External buffer "${buffer.uri}" is ${bytes.byteLength} bytes, more than limits.maxInputBytes (${this.limits.maxInputBytes})`);
    }
    return this._checkBufferSize(bytes, buffer, index, `External buffer "${buffer.uri}"`);
  }

  _checkBufferSize(bytes, buffer, index, label = `Buffer ${index}`) {
    if (bytes.byteLength < buffer.byteLength) {
      throw new GltfValidationError(`${label} is ${bytes.byteLength} bytes, but buffer ${index} byteLength is ${buffer.byteLength}`);
    }
    return bytes;
  }

  /** Raw bytes of a bufferView (decompressed if it uses EXT_meshopt_compression). */
  bufferViewBytes(index) {
    return this._viewData(index);
  }

  /** A bufferView's bytes, exactly byteLength long, or DataUnavailableError. */
  _viewData(index) {
    if (this._decodedViews.has(index)) return this._decodedViews.get(index);
    const bv = this.json.bufferViews[index];
    const ext = bv.extensions?.EXT_meshopt_compression;
    const src = ext && this._buffers[ext.buffer];
    if (src) {
      let bytes;
      try {
        bytes = decodeMeshopt(new Uint8Array(src.buffer, src.byteOffset + (ext.byteOffset || 0), ext.byteLength), ext);
      } catch (e) {
        throw new DataUnavailableError(`bufferView ${index}: ${e.message}`);
      }
      if (bytes.byteLength !== bv.byteLength) {
        throw new DataUnavailableError(`bufferView ${index}: EXT_meshopt_compression decoded ${bytes.byteLength} bytes, byteLength is ${bv.byteLength}`);
      }
      this._decodedViews.set(index, bytes);
      return bytes;
    }
    const buf = this._buffers[bv.buffer];
    if (!buf) throw new DataUnavailableError(`bufferView ${index} has no readable data`);
    return new Uint8Array(buf.buffer, buf.byteOffset + (bv.byteOffset || 0), bv.byteLength);
  }

  /**
   * Decode an accessor into a flat Float64Array/number array (normalized if requested)
   * Returns { data: Array<number>, count, numComponents }.
   */
  accessor(index) {
    const acc = this.json.accessors?.[index];
    if (!acc) throw new GltfValidationError(`accessor ${JSON.stringify(index)} does not exist`);
    const info = COMPONENT_INFO[acc.componentType];
    const numComponents = TYPE_COUNT[acc.type];
    const count = acc.count;
    const data = new Array(count * numComponents).fill(0);
    // Component byte offsets within an element; matrix columns are 4-byte aligned.
    const layout = elementLayout(acc.componentType, acc.type);

    if (acc.bufferView !== undefined) {
      const bv = this.json.bufferViews[acc.bufferView];
      const view = this._viewData(acc.bufferView);
      const base = view.byteOffset + (acc.byteOffset || 0);
      const stride = bv.byteStride || layout.size;
      const dv = new DataView(view.buffer);
      const reader = componentReader(dv, acc.componentType);
      for (let i = 0; i < count; i++) {
        const elemBase = base + i * stride;
        for (let c = 0; c < numComponents; c++) {
          let v = reader(elemBase + layout.offsets[c]);
          if (acc.normalized) v = info.norm(v);
          data[i * numComponents + c] = v;
        }
      }
    }

    if (acc.sparse) this._applySparse(index, acc, data, numComponents, info, layout);
    return { data, count, numComponents };
  }

  _applySparse(index, acc, data, numComponents, info, layout) {
    const s = acc.sparse;
    const idxView = this._viewData(s.indices.bufferView);
    const idxDv = new DataView(idxView.buffer);
    const idxReader = componentReader(idxDv, s.indices.componentType);
    const idxSize = COMPONENT_SIZE[s.indices.componentType];
    const idxBase = idxView.byteOffset + (s.indices.byteOffset || 0);

    const valView = this._viewData(s.values.bufferView);
    const valDv = new DataView(valView.buffer);
    const valReader = componentReader(valDv, acc.componentType);
    const valBase = valView.byteOffset + (s.values.byteOffset || 0);

    let previous = -1;
    for (let i = 0; i < s.count; i++) {
      const target = idxReader(idxBase + i * idxSize);
      // The spec requires strictly increasing indices below count.
      if (target >= acc.count || target <= previous) {
        throw new GltfValidationError(`Invalid sparse accessor indices: accessor ${index} sparse index ${i} is ${target} (previous ${previous}, count ${acc.count})`);
      }
      previous = target;
      for (let c = 0; c < numComponents; c++) {
        let v = valReader(valBase + i * layout.size + layout.offsets[c]);
        if (acc.normalized) v = info.norm(v);
        data[target * numComponents + c] = v;
      }
    }
  }

  /** Returns { bytes, mimeType } for an image, or null if it can't be resolved. */
  imageBytes(index) {
    const img = this.json.images[index];
    if (img.bufferView !== undefined) {
      try {
        return { bytes: this.bufferViewBytes(img.bufferView), mimeType: img.mimeType };
      } catch (e) {
        if (e instanceof DataUnavailableError) return null;
        throw e;
      }
    }
    if (img.uri && img.uri.startsWith("data:")) {
      const mimeType = img.uri.slice(5, img.uri.indexOf(";"));
      return { bytes: decodeDataUri(img.uri), mimeType };
    }
    if (img.uri) {
      const bytes = resolveResource(this._resources, img.uri);
      if (!bytes) return null;
      return { bytes, mimeType: img.mimeType ?? sniffImageType(bytes) };
    }
    return null;
  }
}

/**
 * @typedef {Map<string, ArrayBuffer|Uint8Array> | Record<string, ArrayBuffer|Uint8Array>
 *   | ((uri: string) => ArrayBuffer|Uint8Array|null|undefined)} ResourceSource
 *
 * Look up an external uri. Keys are tried as written, percent-decoded, and as
 * a bare file name (handy for files dropped into a browser without folders).
 * @returns {Uint8Array|null}
 */
export function resolveResource(resources, uri) {
  if (!resources) return null;
  let decoded = uri;
  try { decoded = decodeURIComponent(uri); } catch { /* keep as written */ }
  const candidates = [...new Set([uri, decoded, decoded.split("/").pop()])];
  for (const key of candidates) {
    let v;
    if (typeof resources === "function") v = resources(key);
    else if (resources instanceof Map) v = resources.get(key);
    else v = Object.prototype.hasOwnProperty.call(resources, key) ? resources[key] : undefined;
    if (v) return v instanceof Uint8Array ? v : new Uint8Array(v.buffer ?? v, v.byteOffset ?? 0, v.byteLength);
  }
  return null;
}

/** Identify PNG / JPEG from magic bytes (external images may lack mimeType). */
function sniffImageType(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return undefined;
}

function componentReader(dv, componentType) {
  switch (componentType) {
    case 5120: return (o) => dv.getInt8(o);
    case 5121: return (o) => dv.getUint8(o);
    case 5122: return (o) => dv.getInt16(o, true);
    case 5123: return (o) => dv.getUint16(o, true);
    case 5125: return (o) => dv.getUint32(o, true);
    case 5126: return (o) => dv.getFloat32(o, true);
    default: throw new Error(`Unknown componentType ${componentType}`);
  }
}

function decodeDataUri(uri) {
  const comma = uri.indexOf(",");
  if (comma < 0) throw new GltfValidationError("Malformed data URI (no comma)");
  const meta = uri.slice(0, comma);
  const payload = uri.slice(comma + 1);
  if (!meta.endsWith(";base64")) throw new GltfValidationError("Only base64 data URIs are supported");
  return base64ToBytes(payload);
}

// atob is available in browsers and Node >= 16; src/ must not use Node's Buffer.
function base64ToBytes(b64) {
  let s;
  try {
    s = atob(b64);
  } catch {
    throw new GltfValidationError("Data URI is not valid base64");
  }
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
