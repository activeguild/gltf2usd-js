// EXT_meshopt_compression decoder: vertex ("ATTRIBUTES"), index ("TRIANGLES") and
// index sequence ("INDICES") codecs, plus the OCTAHEDRAL / QUATERNION / EXPONENTIAL
// filters. Written for this library from the bitstream described by the
// EXT_meshopt_compression specification; checked byte-for-byte against the
// meshoptimizer reference decoder on gltf-transform output (see CLAUDE.md).

/**
 * Decode one compressed bufferView.
 * @param {Uint8Array} source   the compressed bytes (ext.buffer, byteOffset, byteLength)
 * @param {{count: number, byteStride: number, mode: string, filter?: string}} ext
 * @returns {Uint8Array} count * byteStride decoded bytes
 */
export function decodeMeshopt(source, ext) {
  const { count, byteStride, mode, filter = "NONE" } = ext;
  const out = new Uint8Array(count * byteStride);
  if (mode === "ATTRIBUTES") {
    decodeVertexBuffer(out, count, byteStride, source);
    applyFilter(out, count, byteStride, filter);
  } else if (mode === "TRIANGLES") {
    decodeIndexBuffer(out, count, byteStride, source);
  } else if (mode === "INDICES") {
    decodeIndexSequence(out, count, byteStride, source);
  } else {
    throw new Error(`EXT_meshopt_compression: unknown mode ${mode}`);
  }
  return out;
}

const fail = (msg) => { throw new Error(`EXT_meshopt_compression: ${msg}`); };

// ---------- Vertex codec ----------

const VERTEX_HEADER = 0xa0;
const BYTE_GROUP = 16;

function decodeVertexBuffer(out, count, stride, src) {
  if (stride <= 0 || stride > 256 || stride % 4) fail(`invalid byteStride ${stride}`);
  if (src.length < 1 + stride) fail("vertex data too short");
  if ((src[0] & 0xf0) !== VERTEX_HEADER || (src[0] & 0x0f) > 0) fail(`unsupported vertex codec header 0x${src[0].toString(16)}`);

  // The last `stride` bytes hold the vertex that precedes the first one (delta baseline).
  const last = src.slice(src.length - stride);
  const blockSize = Math.min((8192 / stride) & ~(BYTE_GROUP - 1), 256);
  const buffer = new Uint8Array(256);
  let p = 1;
  for (let base = 0; base < count; base += blockSize) {
    const n = Math.min(blockSize, count - base);
    const aligned = (n + BYTE_GROUP - 1) & ~(BYTE_GROUP - 1);
    for (let k = 0; k < stride; k++) {
      p = decodeBytes(src, p, buffer, aligned);
      // Bytes are zigzag-encoded deltas from the same byte of the previous vertex.
      let prev = last[k];
      for (let i = 0; i < n; i++) {
        const v = buffer[i];
        prev = (prev + ((v >> 1) ^ -(v & 1))) & 0xff;
        out[(base + i) * stride + k] = prev;
      }
      last[k] = prev;
    }
  }
  const tail = Math.max(stride, 32);
  if (src.length - p !== tail) fail("vertex data size mismatch");
}

/** Byte groups of 16 values: 0 = zeros, 1 = 2-bit, 2 = 4-bit (with escapes), 3 = raw bytes. */
function decodeBytes(src, p, buffer, size) {
  const groups = size / BYTE_GROUP;
  const headerSize = (groups + 3) >> 2;
  if (p + headerSize > src.length) fail("vertex data truncated");
  const header = p;
  p += headerSize;
  for (let g = 0; g < groups; g++) {
    const mode = (src[header + (g >> 2)] >> ((g & 3) * 2)) & 3;
    const o = g * BYTE_GROUP;
    if (mode === 0) {
      buffer.fill(0, o, o + BYTE_GROUP);
    } else if (mode === 3) {
      buffer.set(src.subarray(p, p + BYTE_GROUP), o);
      p += BYTE_GROUP;
    } else {
      const bits = mode === 1 ? 2 : 4;
      const mask = (1 << bits) - 1;
      const packed = (BYTE_GROUP * bits) / 8;
      let escape = p + packed; // escaped values follow the packed bits
      for (let i = 0; i < BYTE_GROUP; i++) {
        const byte = src[p + ((i * bits) >> 3)];
        const shift = 8 - bits - ((i * bits) & 7); // most significant bits first
        const enc = (byte >> shift) & mask;
        buffer[o + i] = enc === mask ? src[escape++] : enc;
      }
      p = escape;
    }
    if (p > src.length) fail("vertex data truncated");
  }
  return p;
}

// ---------- Filters ----------

function applyFilter(out, count, stride, filter) {
  if (filter === "NONE") return;
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (filter === "OCTAHEDRAL") {
    // 4 x int8 (stride 4) or 4 x int16 (stride 8): x, y, z = "one", w kept.
    const size = stride === 4 ? 1 : 2;
    const max = size === 1 ? 127 : 32767;
    const get = (o) => (size === 1 ? dv.getInt8(o) : dv.getInt16(o, true));
    const set = (o, v) => (size === 1 ? dv.setInt8(o, v) : dv.setInt16(o, v, true));
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      let x = get(o), y = get(o + size);
      const z = get(o + 2 * size) - Math.abs(x) - Math.abs(y);
      const t = Math.min(z, 0);
      x += x >= 0 ? t : -t;
      y += y >= 0 ? t : -t;
      const s = max / Math.hypot(x, y, z);
      set(o, roundSigned(x * s));
      set(o + size, roundSigned(y * s));
      set(o + 2 * size, roundSigned(z * s));
    }
  } else if (filter === "QUATERNION") {
    // 4 x int16: three smallest components + (scale | index of the largest) in the 4th.
    // Evaluated in float32 (Math.fround after every operation) so the rounding to
    // int16 matches encoders/decoders that use single precision.
    const f = Math.fround;
    const scale = f(Math.SQRT1_2);
    const toInt16 = (v) => Math.trunc(f(f(v * 32767) + (v >= 0 ? 0.5 : -0.5)));
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      const q3 = dv.getInt16(o + 6, true);
      const ss = f(scale / (q3 | 3));
      const x = f(dv.getInt16(o, true) * ss), y = f(dv.getInt16(o + 2, true) * ss), z = f(dv.getInt16(o + 4, true) * ss);
      const ww = f(f(f(1 - f(x * x)) - f(y * y)) - f(z * z));
      const w = f(Math.sqrt(Math.max(0, ww)));
      const qc = q3 & 3;
      dv.setInt16(o + ((qc + 1) & 3) * 2, toInt16(x), true);
      dv.setInt16(o + ((qc + 2) & 3) * 2, toInt16(y), true);
      dv.setInt16(o + ((qc + 3) & 3) * 2, toInt16(z), true);
      dv.setInt16(o + ((qc + 0) & 3) * 2, toInt16(w), true);
    }
  } else if (filter === "EXPONENTIAL") {
    // int32: 24-bit signed mantissa, 8-bit signed exponent → float32.
    for (let o = 0; o < count * stride; o += 4) {
      const v = dv.getInt32(o, true);
      dv.setFloat32(o, ((v << 8) >> 8) * 2 ** (v >> 24), true);
    }
  } else {
    fail(`unknown filter ${filter}`);
  }
}

function roundSigned(v) {
  return Math.trunc(v + (v >= 0 ? 0.5 : -0.5));
}

// ---------- Index codec (triangles) ----------

const INDEX_HEADER = 0xe0;

function decodeIndexBuffer(out, count, indexSize, src) {
  if (count % 3) fail("triangle index count is not a multiple of 3");
  if (src.length < 1 + count / 3 + 16) fail("index data too short");
  if ((src[0] & 0xf0) !== INDEX_HEADER) fail(`unsupported index codec header 0x${src[0].toString(16)}`);
  const version = src[0] & 0x0f;
  if (version > 1) fail(`unsupported index codec version ${version}`);

  const edgeA = new Int32Array(16).fill(-1), edgeB = new Int32Array(16).fill(-1);
  const vfifo = new Int32Array(16).fill(-1);
  let eo = 0, vo = 0, next = 0, last = 0;
  const fecmax = version >= 1 ? 13 : 15;
  let code = 1;
  let data = 1 + count / 3;
  const safeEnd = src.length - 16;
  const aux = safeEnd; // 16-byte table at the end

  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const write = (i, a, b, c) => {
    if (indexSize === 2) { dv.setUint16(i * 2, a, true); dv.setUint16(i * 2 + 2, b, true); dv.setUint16(i * 2 + 4, c, true); }
    else { dv.setUint32(i * 4, a, true); dv.setUint32(i * 4 + 4, b, true); dv.setUint32(i * 4 + 8, c, true); }
  };
  const pushEdge = (a, b) => { edgeA[eo] = a; edgeB[eo] = b; eo = (eo + 1) & 15; };
  const pushVertex = (v, cond = true) => { vfifo[vo] = v; if (cond) vo = (vo + 1) & 15; };
  const readIndex = () => {
    const [v, p] = readVByte(src, data);
    data = p;
    last = (last + ((v >>> 1) ^ -(v & 1))) >>> 0;
    return last;
  };

  for (let i = 0; i < count; i += 3) {
    if (data > safeEnd) fail("index data truncated");
    const codetri = src[code++];
    if (codetri < 0xf0) {
      const fe = codetri >> 4;
      const a = edgeA[(eo - 1 - fe) & 15], b = edgeB[(eo - 1 - fe) & 15];
      const fec = codetri & 15;
      let c;
      if (fec < fecmax) {
        c = fec === 0 ? next++ : vfifo[(vo - 1 - fec) & 15];
        write(i, a, b, c);
        pushVertex(c, fec === 0);
      } else {
        // 13 / 14 → last - 1 / last + 1 (version 1); 15 → explicit delta
        c = fec !== 15 ? (last = (last + (fec - (fec ^ 3))) >>> 0) : readIndex();
        write(i, a, b, c);
        pushVertex(c);
      }
      pushEdge(c, b);
      pushEdge(a, c);
    } else {
      let a, b, c, feb, fec, bNew, cNew;
      if (codetri < 0xfe) {
        const codeaux = src[aux + (codetri & 15)];
        feb = codeaux >> 4;
        fec = codeaux & 15;
        a = next++;
        b = feb === 0 ? next++ : vfifo[(vo - feb) & 15];
        c = fec === 0 ? next++ : vfifo[(vo - fec) & 15];
        bNew = feb === 0;
        cNew = fec === 0;
      } else {
        const codeaux = src[data++];
        const fea = codetri === 0xfe ? 0 : 15;
        feb = codeaux >> 4;
        fec = codeaux & 15;
        if (codeaux === 0) next = 0; // reset
        a = fea === 0 ? next++ : 0;
        b = feb === 0 ? next++ : vfifo[(vo - feb) & 15];
        c = fec === 0 ? next++ : vfifo[(vo - fec) & 15];
        if (fea === 15) a = readIndex();
        if (feb === 15) b = readIndex();
        if (fec === 15) c = readIndex();
        bNew = feb === 0 || feb === 15;
        cNew = fec === 0 || fec === 15;
      }
      write(i, a, b, c);
      pushVertex(a);
      pushVertex(b, bNew);
      pushVertex(c, cNew);
      pushEdge(b, a);
      pushEdge(c, b);
      pushEdge(a, c);
    }
  }
  if (data !== safeEnd) fail("index data size mismatch");
}

// ---------- Index sequence codec ----------

const SEQUENCE_HEADER = 0xd0;

function decodeIndexSequence(out, count, indexSize, src) {
  if (src.length < 1 + count + 4) fail("index sequence too short");
  if ((src[0] & 0xf0) !== SEQUENCE_HEADER || (src[0] & 0x0f) > 1) fail(`unsupported sequence header 0x${src[0].toString(16)}`);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const safeEnd = src.length - 4;
  const last = [0, 0];
  let p = 1;
  for (let i = 0; i < count; i++) {
    if (p >= safeEnd) fail("index sequence truncated");
    let v;
    [v, p] = readVByte(src, p);
    const baseline = v & 1; // which of the two previous indices the delta is from
    v >>>= 1;
    const index = (last[baseline] + ((v >>> 1) ^ -(v & 1))) >>> 0;
    last[baseline] = index;
    if (indexSize === 2) dv.setUint16(i * 2, index, true);
    else dv.setUint32(i * 4, index, true);
  }
  if (p !== safeEnd) fail("index sequence size mismatch");
}

/** LEB128-style varint (up to 5 bytes). Returns [value, next offset]. */
function readVByte(src, p) {
  const lead = src[p++];
  if (lead < 128) return [lead, p];
  let result = lead & 127;
  let shift = 7;
  for (let i = 0; i < 4; i++) {
    const group = src[p++];
    result |= (group & 127) << shift;
    shift += 7;
    if (group < 128) break;
  }
  return [result >>> 0, p];
}
