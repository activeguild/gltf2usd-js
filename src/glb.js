// GLB (glTF 2.0 binary) parser. Zero dependencies, works in browser and Node.
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

const TYPE_COUNT = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

/**
 * Parse either a GLB or a .gltf (JSON text) ArrayBuffer into { json, bin }.
 * bin is the GLB BIN chunk as a Uint8Array, or null.
 */
export function parseGltf(arrayBuffer) {
  if (arrayBuffer.byteLength >= 4 && new DataView(arrayBuffer).getUint32(0, true) === GLB_MAGIC) {
    return parseGLB(arrayBuffer);
  }
  let json;
  try {
    json = JSON.parse(new TextDecoder().decode(arrayBuffer));
  } catch {
    throw new Error("Input is neither a GLB nor glTF JSON");
  }
  return { json, bin: null };
}

/**
 * Parse a GLB ArrayBuffer into { json, bin } where bin is a Uint8Array (may be null).
 */
export function parseGLB(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error("Not a GLB file (bad magic)");
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`Unsupported GLB version ${version}`);
  const totalLength = dv.getUint32(8, true);

  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < totalLength) {
    const chunkLength = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    const chunkData = new Uint8Array(arrayBuffer, offset + 8, chunkLength);
    if (chunkType === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(chunkData));
    } else if (chunkType === CHUNK_BIN && bin === null) {
      bin = chunkData;
    }
    offset += 8 + chunkLength;
  }
  if (!json) throw new Error("GLB has no JSON chunk");
  return { json, bin };
}

/**
 * Thin wrapper giving typed access to glTF buffers / bufferViews / accessors / images.
 */
export class GltfAsset {
  /**
   * @param {{json: object, bin: Uint8Array|null}} parsed
   * @param {object} [options]
   * @param {ResourceSource} [options.resources]  external files referenced by uri (see resolveResource)
   */
  constructor({ json, bin }, { resources } = {}) {
    this.json = json;
    this.bin = bin;
    this._resources = resources;
    this._buffers = (json.buffers || []).map((b, i) => this._loadBuffer(b, i));
  }

  _loadBuffer(buffer, index) {
    if (buffer.uri === undefined) {
      if (index !== 0 || !this.bin) throw new Error(`Buffer ${index} has no uri and no GLB BIN chunk`);
      return this.bin;
    }
    if (buffer.uri.startsWith("data:")) return decodeDataUri(buffer.uri);
    const bytes = resolveResource(this._resources, buffer.uri);
    if (!bytes) {
      throw new Error(`External buffer "${buffer.uri}" was not provided (pass it in options.resources)`);
    }
    if (bytes.byteLength < (buffer.byteLength ?? 0)) {
      throw new Error(`External buffer "${buffer.uri}" is ${bytes.byteLength} bytes, expected ${buffer.byteLength}`);
    }
    return bytes;
  }

  /** Raw bytes of a bufferView. */
  bufferViewBytes(index) {
    const bv = this.json.bufferViews[index];
    const buf = this._buffers[bv.buffer];
    return new Uint8Array(buf.buffer, buf.byteOffset + (bv.byteOffset || 0), bv.byteLength);
  }

  /**
   * Decode an accessor into a flat Float64Array/number array (normalized if requested)
   * Returns { data: Array<number>, count, numComponents }.
   */
  accessor(index) {
    const acc = this.json.accessors[index];
    const info = COMPONENT_INFO[acc.componentType];
    if (!info) throw new Error(`Unknown componentType ${acc.componentType}`);
    const numComponents = TYPE_COUNT[acc.type];
    const count = acc.count;
    const data = new Array(count * numComponents).fill(0);

    if (acc.bufferView !== undefined) {
      const bv = this.json.bufferViews[acc.bufferView];
      const buf = this._buffers[bv.buffer];
      const base = buf.byteOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const elemSize = info.size * numComponents;
      const stride = bv.byteStride || elemSize;
      const dv = new DataView(buf.buffer);
      const reader = componentReader(dv, acc.componentType);
      for (let i = 0; i < count; i++) {
        const elemBase = base + i * stride;
        for (let c = 0; c < numComponents; c++) {
          let v = reader(elemBase + c * info.size);
          if (acc.normalized) v = info.norm(v);
          data[i * numComponents + c] = v;
        }
      }
    }

    if (acc.sparse) this._applySparse(acc, data, numComponents, info);
    return { data, count, numComponents };
  }

  _applySparse(acc, data, numComponents, info) {
    const s = acc.sparse;
    const idxBv = this.json.bufferViews[s.indices.bufferView];
    const idxBuf = this._buffers[idxBv.buffer];
    const idxDv = new DataView(idxBuf.buffer);
    const idxReader = componentReader(idxDv, s.indices.componentType);
    const idxSize = COMPONENT_INFO[s.indices.componentType].size;
    const idxBase = idxBuf.byteOffset + (idxBv.byteOffset || 0) + (s.indices.byteOffset || 0);

    const valBv = this.json.bufferViews[s.values.bufferView];
    const valBuf = this._buffers[valBv.buffer];
    const valDv = new DataView(valBuf.buffer);
    const valReader = componentReader(valDv, acc.componentType);
    const valBase = valBuf.byteOffset + (valBv.byteOffset || 0) + (s.values.byteOffset || 0);

    for (let i = 0; i < s.count; i++) {
      const target = idxReader(idxBase + i * idxSize);
      for (let c = 0; c < numComponents; c++) {
        let v = valReader(valBase + (i * numComponents + c) * info.size);
        if (acc.normalized) v = info.norm(v);
        data[target * numComponents + c] = v;
      }
    }
  }

  /** Returns { bytes, mimeType } for an image, or null if it can't be resolved. */
  imageBytes(index) {
    const img = this.json.images[index];
    if (img.bufferView !== undefined) {
      return { bytes: this.bufferViewBytes(img.bufferView), mimeType: img.mimeType };
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
  const meta = uri.slice(0, comma);
  const payload = uri.slice(comma + 1);
  if (!meta.endsWith(";base64")) throw new Error("Only base64 data URIs are supported");
  return base64ToBytes(payload);
}

// atob is available in browsers and Node >= 16; src/ must not use Node's Buffer.
function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
