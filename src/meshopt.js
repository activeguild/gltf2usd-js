// EXT_meshopt_compression / KHR_meshopt_compression decoder: vertex ("ATTRIBUTES"),
// index ("TRIANGLES") and index sequence ("INDICES") codecs, plus the OCTAHEDRAL /
// QUATERNION / EXPONENTIAL filters and (KHR only) the vertex codec v1 and the COLOR
// filter. Written for this library from the bitstream described by the two
// specifications; checked byte-for-byte against the meshoptimizer reference (scalar)
// decoder (see CLAUDE.md, design decision 15).

const EXT = "EXT_meshopt_compression";
const KHR = "KHR_meshopt_compression";

/**
 * Decode one compressed bufferView.
 * @param {Uint8Array} source   the compressed bytes (ext.buffer, byteOffset, byteLength)
 * @param {{count: number, byteStride: number, mode: string, filter?: string}} ext
 * @param {string} [extension]  "EXT_meshopt_compression" (default) or "KHR_meshopt_compression";
 *   KHR adds the vertex codec v1 and the COLOR filter
 * @returns {Uint8Array} count * byteStride decoded bytes
 */
export function decodeMeshopt(source, ext, extension = EXT) {
  const { count, byteStride, mode, filter = "NONE" } = ext;
  const fail = (msg) => { throw new Error(`${extension}: ${msg}`); };
  if (extension !== EXT && extension !== KHR) throw new Error(`unknown meshopt extension ${extension}`);
  const out = new Uint8Array(count * byteStride);
  if (mode === "ATTRIBUTES") {
    decodeVertexBuffer(out, count, byteStride, source, extension === KHR ? 1 : 0, fail);
    applyFilter(out, count, byteStride, filter, extension === KHR, fail);
  } else if (mode === "TRIANGLES") {
    decodeIndexBuffer(out, count, byteStride, source, fail);
  } else if (mode === "INDICES") {
    decodeIndexSequence(out, count, byteStride, source, fail);
  } else {
    fail(`unknown mode ${mode}`);
  }
  return out;
}

// ---------- Vertex codec ----------

const VERTEX_HEADER = 0xa0;
const BYTE_GROUP = 16;
// Delta encoding mode (2 header bits per group) → bits per delta (0 = all zero, 8 = raw).
const BITS_V0 = [0, 2, 4, 8];
const BITS_V1 = [[0, 1, 2, 4], [1, 2, 4, 8]]; // by control mode 0 / 1

/**
 * Version 0 (EXT and KHR): every byte position is a data block of byte deltas.
 * Version 1 (KHR only): each block starts with 2 control bits per byte position
 * (0 / 1 = bit-length table, 2 = all zero, 3 = literal bytes), and each 4-byte channel
 * has a mode in the tail: 0 = byte deltas, 1 = 16-bit deltas, 2 = 32-bit XOR deltas
 * rotated by the high nibble.
 */
function decodeVertexBuffer(out, count, stride, src, maxVersion, fail) {
  if (stride <= 0 || stride > 256 || stride % 4) fail(`invalid byteStride ${stride}`);
  if (src.length < 1 || (src[0] & 0xf0) !== VERTEX_HEADER || (src[0] & 0x0f) > maxVersion) {
    fail(`unsupported vertex codec header 0x${(src[0] ?? 0).toString(16)}`);
  }
  const version = src[0] & 0x0f;
  const channels = stride / 4;
  // Tail: baseline vertex (+ channel modes in v1), zero-padded in front to a minimum size.
  const tail = stride + (version === 0 ? 0 : channels);
  const tailPadded = Math.max(tail, version === 0 ? 32 : 24);
  if (src.length - 1 < tailPadded) fail("vertex data too short");
  const tailStart = src.length - tail;
  // The baseline is the vertex that precedes the first one.
  const last = src.slice(tailStart, tailStart + stride);
  const modes = new Uint8Array(channels);
  for (let c = 0; c < channels; c++) {
    const m = version === 0 ? 0 : src[tailStart + stride + c];
    // Spec: channel modes ≥ 3 are invalid, as are modes 0 / 1 with a non-zero high nibble.
    if ((m & 0x0f) > 2 || ((m & 0x0f) < 2 && m >> 4)) fail(`invalid channel mode 0x${m.toString(16)}`);
    modes[c] = m;
  }

  const blockSize = Math.min((8192 / stride) & ~(BYTE_GROUP - 1), 256);
  const planes = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
  const end = src.length - tailPadded; // block data must end exactly here
  let p = 1;
  for (let base = 0; base < count; base += blockSize) {
    const n = Math.min(blockSize, count - base);
    const aligned = (n + BYTE_GROUP - 1) & ~(BYTE_GROUP - 1);
    const control = p;
    if (version === 1) {
      p += channels;
      if (p > end) fail("vertex data truncated");
    }
    for (let c = 0; c < channels; c++) {
      // The four byte planes of this channel: plane j holds byte j of each vertex's delta.
      for (let j = 0; j < 4; j++) {
        const ctrl = version === 0 ? 0 : (src[control + c] >> (j * 2)) & 3;
        if (ctrl === 3) {
          if (p + n > end) fail("vertex data truncated");
          planes[j].set(src.subarray(p, p + n));
          p += n;
        } else if (ctrl === 2) {
          planes[j].fill(0, 0, n);
        } else {
          p = decodeBytes(src, p, end, planes[j], aligned, version === 0 ? BITS_V0 : BITS_V1[ctrl], fail);
        }
      }
      applyDeltas(out, base, n, stride, c * 4, planes, last, modes[c]);
    }
  }
  if (p !== end) fail("vertex data size mismatch");
}

/** Undo one channel's deltas for vertices base..base+n-1 and update the baseline `last`. */
function applyDeltas(out, base, n, stride, k, planes, last, mode) {
  const [p0, p1, p2, p3] = planes;
  const kind = mode & 3;
  if (kind === 0) {
    // Byte deltas: zigzag-encoded difference from the same byte of the previous vertex.
    for (let j = 0; j < 4; j++) {
      const plane = planes[j];
      let prev = last[k + j];
      for (let i = 0; i < n; i++) {
        const v = plane[i];
        prev = (prev + ((v >> 1) ^ -(v & 1))) & 0xff;
        out[(base + i) * stride + k + j] = prev;
      }
      last[k + j] = prev;
    }
  } else if (kind === 1) {
    // 16-bit little-endian deltas (zigzag), two per channel.
    for (let h = 0; h < 2; h++) {
      const lo = planes[h * 2], hi = planes[h * 2 + 1];
      let prev = last[k + h * 2] | (last[k + h * 2 + 1] << 8);
      for (let i = 0; i < n; i++) {
        const v = lo[i] | (hi[i] << 8);
        prev = (prev + ((v >> 1) ^ -(v & 1))) & 0xffff;
        const o = (base + i) * stride + k + h * 2;
        out[o] = prev & 0xff;
        out[o + 1] = prev >> 8;
      }
      last[k + h * 2] = prev & 0xff;
      last[k + h * 2 + 1] = prev >> 8;
    }
  } else {
    // 32-bit XOR deltas, stored rotated left by r: undo with a right rotation.
    const r = mode >> 4;
    let prev = (last[k] | (last[k + 1] << 8) | (last[k + 2] << 16) | (last[k + 3] << 24)) >>> 0;
    for (let i = 0; i < n; i++) {
      const v = (p0[i] | (p1[i] << 8) | (p2[i] << 16) | (p3[i] << 24)) >>> 0;
      prev = (prev ^ ((v >>> r) | (v << ((32 - r) & 31)))) >>> 0;
      const o = (base + i) * stride + k;
      out[o] = prev & 0xff;
      out[o + 1] = (prev >>> 8) & 0xff;
      out[o + 2] = (prev >>> 16) & 0xff;
      out[o + 3] = prev >>> 24;
    }
    last[k] = prev & 0xff;
    last[k + 1] = (prev >>> 8) & 0xff;
    last[k + 2] = (prev >>> 16) & 0xff;
    last[k + 3] = prev >>> 24;
  }
}

/**
 * One data block: 2 header bits per group of 16 values select the bit length from `bits`
 * (0 = zeros, 8 = raw bytes, otherwise packed with the all-ones value escaping to a byte
 * after the packed bits). 2- and 4-bit values are packed most significant first, 1-bit
 * values least significant first.
 */
function decodeBytes(src, p, end, buffer, size, bits, fail) {
  const groups = size / BYTE_GROUP;
  const headerSize = (groups + 3) >> 2;
  if (p + headerSize > end) fail("vertex data truncated");
  const header = p;
  p += headerSize;
  for (let g = 0; g < groups; g++) {
    const b = bits[(src[header + (g >> 2)] >> ((g & 3) * 2)) & 3];
    const o = g * BYTE_GROUP;
    if (b === 0) {
      buffer.fill(0, o, o + BYTE_GROUP);
    } else if (b === 8) {
      if (p + BYTE_GROUP > end) fail("vertex data truncated");
      buffer.set(src.subarray(p, p + BYTE_GROUP), o);
      p += BYTE_GROUP;
    } else {
      const mask = (1 << b) - 1;
      const packed = (BYTE_GROUP * b) / 8;
      if (p + packed > end) fail("vertex data truncated");
      let escape = p + packed; // escaped values follow the packed bits
      for (let i = 0; i < BYTE_GROUP; i++) {
        const byte = src[p + ((i * b) >> 3)];
        const shift = b === 1 ? i & 7 : 8 - b - ((i * b) & 7);
        const enc = (byte >> shift) & mask;
        buffer[o + i] = enc === mask ? src[escape++] : enc;
      }
      p = escape;
      if (p > end) fail("vertex data truncated");
    }
  }
  return p;
}

// ---------- Filters ----------

function applyFilter(out, count, stride, filter, khr, fail) {
  if (filter === "NONE") return;
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (filter === "COLOR" && khr) {
    // YCoCg (+ alpha whose most significant set bit gives the bit depth K) → RGBA,
    // 4 x uint8 (stride 4) or 4 x uint16 (stride 8). Float32 as in the reference decoder;
    // valid input never makes a component negative, so rounding is (x + 0.5) truncated.
    if (stride !== 4 && stride !== 8) fail(`COLOR filter needs byteStride 4 or 8, got ${stride}`);
    const f = Math.fround;
    const wide = stride === 8;
    const max = wide ? 65535 : 255;
    const get = (o) => (wide ? dv.getUint16(o, true) : dv.getUint8(o));
    const getSigned = (o) => (wide ? dv.getInt16(o, true) : dv.getInt8(o));
    const set = (o, v) => (wide ? dv.setUint16(o, v, true) : dv.setUint8(o, v));
    const size = wide ? 2 : 1;
    const round = (v, ss) => Math.trunc(f(f(v * ss) + 0.5));
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      let a = get(o + 3 * size);
      let as = a;
      as |= as >> 1;
      as |= as >> 2;
      as |= as >> 4;
      as |= as >> 8;
      const y = get(o), co = getSigned(o + size), cg = getSigned(o + 2 * size);
      const r = y + co - cg, g = y + cg, b = y - co - cg;
      a = ((a << 1) & as) | (a & 1); // expand alpha by one bit (K-1 → K)
      const ss = f(max / as);
      set(o, round(r, ss));
      set(o + size, round(g, ss));
      set(o + 2 * size, round(b, ss));
      set(o + 3 * size, round(a, ss));
    }
  } else if (filter === "OCTAHEDRAL") {
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

function decodeIndexBuffer(out, count, indexSize, src, fail) {
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

function decodeIndexSequence(out, count, indexSize, src, fail) {
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
