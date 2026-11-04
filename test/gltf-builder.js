// Small helpers for building glTF / GLB inputs in tests (Node and browser).

/** Pack glTF JSON and an optional BIN chunk into GLB bytes (both padded to 4 bytes). */
export function makeGlb(json, bin = null, { extraChunks = [] } = {}) {
  const pad = (bytes, fill) => {
    const out = new Uint8Array(Math.ceil(bytes.length / 4) * 4).fill(fill);
    out.set(bytes);
    return out;
  };
  const chunks = [{ type: 0x4e4f534a, data: pad(new TextEncoder().encode(JSON.stringify(json)), 0x20) }];
  if (bin) chunks.push({ type: 0x004e4942, data: pad(bin, 0) });
  for (const c of extraChunks) chunks.push({ type: c.type, data: pad(c.data, 0) });
  const total = 12 + chunks.reduce((n, c) => n + 8 + c.data.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  let o = 12;
  for (const c of chunks) {
    dv.setUint32(o, c.data.length, true);
    dv.setUint32(o + 4, c.type, true);
    out.set(c.data, o + 8);
    o += 8 + c.data.length;
  }
  return out;
}

/** Concatenate typed arrays into one buffer, each part 4-byte aligned. Returns { bin, views }. */
export function packParts(parts) {
  const bytes = parts.map((p) => new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
  const views = [];
  let off = 0;
  for (const b of bytes) {
    views.push({ buffer: 0, byteOffset: off, byteLength: b.length });
    off += Math.ceil(b.length / 4) * 4;
  }
  const bin = new Uint8Array(off);
  bytes.forEach((b, i) => bin.set(b, views[i].byteOffset));
  return { bin, views };
}

/** A valid one-triangle document: { json, bin }. Accessor 0 = POSITION, 1 = indices. */
export function triangleDoc() {
  const { bin, views } = packParts([
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    new Uint16Array([0, 1, 2]),
  ]);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Tri", mesh: 0 }],
    meshes: [{ name: "Tri", primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  return { json, bin };
}

export const clone = (v) => JSON.parse(JSON.stringify(v));
