// Draco mesh decoder for KHR_draco_mesh_compression (Draco bitstream 2.2, triangular meshes).
// Zero dependencies; works in browsers and Node.
//
// Written from the Draco bitstream specification (google/draco, docs/spec). Where the
// specification is incomplete or differs from the reference decoder (order of the integer
// attribute fields, float arithmetic of dequantization and octahedral normals, the corner
// table that edgebreaker and the attribute traversals use, 64-bit integer arithmetic of the
// texture coordinate and normal predictors), this file is a JavaScript translation of the
// reference decoder's C++ code, modified for this project:
//
//   Draco, https://github.com/google/draco
//   Copyright 2016 The Draco Authors
//   Licensed under the Apache License, Version 2.0 (see THIRD_PARTY_NOTICES.md)
//
// The output (indices and per-point attribute values) is byte-identical to the reference
// decoder's (draco3d) on the test vectors in test/draco-vectors.js and on every Draco model in
// Khronos glTF-Sample-Assets.

/** Thrown for malformed or unsupported Draco data. */
export class DracoError extends Error {
  constructor(message) {
    super(message);
    this.name = "DracoError";
  }
}

function fail(message) {
  throw new DracoError(message);
}

// --- constants ------------------------------------------------------------------------------

const TRIANGULAR_MESH = 1;
const MESH_SEQUENTIAL_ENCODING = 0;
const MESH_EDGEBREAKER_ENCODING = 1;
const METADATA_FLAG_MASK = 0x8000;

const EDGEBREAKER_STANDARD = 0;
const EDGEBREAKER_VALENCE = 2;

const TOPOLOGY_C = 0;
const TOPOLOGY_S = 1;
const TOPOLOGY_L = 3;
const TOPOLOGY_R = 5;
const TOPOLOGY_E = 7;
const TOPOLOGY_INVALID = 9;
const SYMBOL_TO_TOPOLOGY = [TOPOLOGY_C, TOPOLOGY_S, TOPOLOGY_L, TOPOLOGY_R, TOPOLOGY_E];
const RIGHT_FACE_EDGE = 1;

const MESH_VERTEX_ATTRIBUTE = 0;
const TRAVERSAL_DEPTH_FIRST = 0;
const TRAVERSAL_PREDICTION_DEGREE = 1;

const SEQ_GENERIC = 0;
const SEQ_INTEGER = 1;
const SEQ_QUANTIZATION = 2;
const SEQ_NORMALS = 3;

const PREDICTION_NONE = -2;
const PREDICTION_PARALLELOGRAM = 1;
const PREDICTION_MULTI_PARALLELOGRAM = 2;
const PREDICTION_TEX_COORDS_DEPRECATED = 3;
const PREDICTION_CONSTRAINED_MULTI_PARALLELOGRAM = 4;
const PREDICTION_TEX_COORDS_PORTABLE = 5;
const PREDICTION_GEOMETRIC_NORMAL = 6;
const NUM_PREDICTION_SCHEMES = 7;
const TRANSFORM_NONE = -1;
const TRANSFORM_WRAP = 1;
const TRANSFORM_NORMAL_OCTAHEDRON_CANONICALIZED = 3;
const NUM_TRANSFORMS = 4;

/** Draco attribute types (GeometryAttribute::Type). */
export const DRACO_ATTRIBUTE_TYPE = { POSITION: 0, NORMAL: 1, COLOR: 2, TEX_COORD: 3, GENERIC: 4 };
const NUM_ATTRIBUTE_TYPES = 5;

// DataType -> [TypedArray, bytes]; index is the Draco DataType enum (DT_INT8 = 1 ... DT_BOOL = 11).
const DATA_TYPES = [
  null,
  [Int8Array, 1], [Uint8Array, 1], [Int16Array, 2], [Uint16Array, 2], [Int32Array, 4], [Uint32Array, 4],
  [BigInt64Array, 8], [BigUint64Array, 8], [Float32Array, 4], [Float64Array, 8], [Uint8Array, 1],
];
const DT_FLOAT32 = 9;

const f32 = Math.fround;
const INT64_MAX = (1n << 63n) - 1n;
const i64 = (x) => BigInt.asIntN(64, x);
const u64 = (x) => BigInt.asUintN(64, x);
const babs = (x) => (x < 0n ? -x : x);

// --- byte / bit reader ----------------------------------------------------------------------

class Reader {
  constructor(bytes, pos = 0, end = bytes.length) {
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = pos;
    this.end = end;
    this.bitStart = -1;
    this.bitOffset = 0;
  }

  clone() {
    return new Reader(this.bytes, this.pos, this.end);
  }

  remaining() {
    return this.end - this.pos;
  }

  need(n) {
    if (n > this.end - this.pos) fail("Draco data is truncated");
  }

  u8() {
    this.need(1);
    return this.bytes[this.pos++];
  }

  i8() {
    const v = this.u8();
    return v > 127 ? v - 256 : v;
  }

  u16() {
    this.need(2);
    const v = this.dv.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i32() {
    this.need(4);
    const v = this.dv.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32() {
    this.need(4);
    const v = this.dv.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** LEB128; at most 5 bytes for 32-bit values (wrapped like uint32), 10 for 64-bit. */
  varint(is64 = false) {
    const maxBytes = is64 ? 10 : 5;
    let value = 0;
    let scale = 1;
    for (let i = 0; ; i++) {
      if (i >= maxBytes) fail("Draco varint is too long");
      const b = this.u8();
      value += (b & 0x7f) * scale;
      if (!(b & 0x80)) break;
      scale *= 128;
    }
    if (!is64) return value % 4294967296;
    if (value > Number.MAX_SAFE_INTEGER) fail("Draco varint is out of range");
    return value;
  }

  advance(n) {
    this.need(n);
    this.pos += n;
  }

  // Bit reading (least significant bit first), as DecoderBuffer::StartBitDecoding.
  startBits(decodeSize) {
    let size = 0;
    if (decodeSize) size = this.varint(true);
    this.bitStart = this.pos;
    this.bitOffset = 0;
    return size;
  }

  bits(n) {
    if (this.bitStart < 0) fail("Draco bit reader is not active");
    if (n > 32) fail("Draco bit field is too wide");
    let value = 0;
    for (let b = 0; b < n; b++) {
      const off = this.bitOffset;
      const byte = this.bitStart + (off >> 3);
      if (byte < this.end) {
        value |= ((this.bytes[byte] >> (off & 7)) & 1) << b;
        this.bitOffset = off + 1;
      }
    }
    return value >>> 0;
  }

  endBits() {
    this.pos = this.bitStart + Math.ceil(this.bitOffset / 8);
    this.bitStart = -1;
  }
}

// --- entropy coding -------------------------------------------------------------------------

/** rANS symbol decoder (RAnsSymbolDecoder) with 2^precisionBits precision. */
function createSymbolDecoder(r, precisionBits) {
  const numSymbols = r.varint();
  if (Math.floor(numSymbols / 64) > r.remaining()) fail("Draco symbol table is truncated");
  // Each symbol needs a probability byte unless it is in a run of zeros (64 per byte).
  if (numSymbols > 64 * r.remaining() || numSymbols > 2 ** 24) fail("Draco symbol table is too large");
  const probs = new Uint32Array(numSymbols);
  for (let i = 0; i < numSymbols; i++) {
    const data = r.u8();
    const token = data & 3;
    if (token === 3) {
      const offset = data >> 2;
      if (i + offset >= numSymbols) fail("Draco symbol table is malformed");
      i += offset; // probabilities stay 0
    } else {
      let prob = data >> 2;
      for (let b = 0; b < token; b++) prob |= r.u8() << (8 * (b + 1) - 2);
      probs[i] = prob;
    }
  }
  const precision = 2 ** precisionBits;
  if (numSymbols === 0) return { numSymbols };
  const lut = new Uint32Array(precision);
  const cum = new Uint32Array(numSymbols);
  let cumProb = 0;
  for (let i = 0; i < numSymbols; i++) {
    cum[i] = cumProb;
    const next = cumProb + probs[i];
    if (next > precision) fail("Draco symbol probabilities exceed the precision");
    lut.fill(i, cumProb, next);
    cumProb = next;
  }
  if (cumProb !== precision) fail("Draco symbol probabilities do not add up");
  return { numSymbols, precisionBits, probs, cum, lut };
}

/** RAnsDecoder: read_init over the next `size` bytes of r, then rans_read(). */
function startRans(dec, r) {
  const size = r.varint(true);
  if (size > r.remaining()) fail("Draco rANS data is truncated");
  const buf = r.bytes;
  const start = r.pos;
  r.pos += size;
  const lBase = 4 * 2 ** dec.precisionBits;
  if (size < 1) fail("Draco rANS data is empty");
  const last = buf[start + size - 1];
  const x = last >> 6;
  let off;
  let state;
  if (x === 0) {
    off = size - 1;
    state = last & 0x3f;
  } else if (x === 1) {
    if (size < 2) fail("Draco rANS data is malformed");
    off = size - 2;
    state = (buf[start + off] | (last << 8)) & 0x3fff;
  } else if (x === 2) {
    if (size < 3) fail("Draco rANS data is malformed");
    off = size - 3;
    state = (buf[start + off] | (buf[start + off + 1] << 8) | (last << 16)) & 0x3fffff;
  } else {
    if (size < 4) fail("Draco rANS data is malformed");
    off = size - 4;
    state = (buf[start + off] | (buf[start + off + 1] << 8) | (buf[start + off + 2] << 16) | (last << 24)) & 0x3fffffff;
  }
  state += lBase;
  if (state >= lBase * 256) fail("Draco rANS state is out of range");
  const { probs, cum, lut, precisionBits } = dec;
  const mask = 2 ** precisionBits - 1;
  return () => {
    while (state < lBase && off > 0) state = state * 256 + buf[start + --off];
    const quo = Math.floor(state / (mask + 1));
    const rem = state & mask;
    const sym = lut[rem];
    state = quo * probs[sym] + rem - cum[sym];
    return sym;
  };
}

/** DecodeSymbols(): tagged or raw rANS-coded unsigned integers into out (Uint32Array). */
function decodeSymbols(numValues, numComponents, r, out) {
  if (numValues === 0) return;
  const scheme = r.u8();
  if (scheme === 0) {
    const dec = createSymbolDecoder(r, 12); // 5-bit tags: precision clamps to 12 bits
    const read = startRans(dec, r);
    if (dec.numSymbols === 0) fail("Draco symbol table is empty");
    r.startBits(false);
    let id = 0;
    for (let i = 0; i < numValues; i += numComponents) {
      const bitLength = read();
      for (let j = 0; j < numComponents; j++) out[id++] = r.bits(bitLength);
    }
    r.endBits();
  } else if (scheme === 1) {
    const maxBitLength = r.u8();
    if (maxBitLength < 1 || maxBitLength > 18) fail(`Draco raw symbols use ${maxBitLength} bits`);
    const precisionBits = Math.min(20, Math.max(12, Math.floor((3 * maxBitLength) / 2)));
    const dec = createSymbolDecoder(r, precisionBits);
    if (dec.numSymbols === 0) fail("Draco symbol table is empty");
    const read = startRans(dec, r);
    for (let i = 0; i < numValues; i++) out[i] = read();
  } else {
    fail(`Unknown Draco symbol coding ${scheme}`);
  }
}

/** RAnsBitDecoder: binary rANS with an 8-bit probability of zero. */
class BitDecoder {
  constructor(r) {
    this.probZero = r.u8();
    const size = r.varint();
    if (size > r.remaining()) fail("Draco bit data is truncated");
    this.buf = r.bytes;
    this.start = r.pos;
    r.pos += size;
    if (size < 1) fail("Draco bit data is empty");
    const buf = this.buf;
    const start = this.start;
    const last = buf[start + size - 1];
    const x = last >> 6;
    if (x === 0) {
      this.off = size - 1;
      this.state = last & 0x3f;
    } else if (x === 1) {
      if (size < 2) fail("Draco bit data is malformed");
      this.off = size - 2;
      this.state = (buf[start + this.off] | (last << 8)) & 0x3fff;
    } else if (x === 2) {
      if (size < 3) fail("Draco bit data is malformed");
      this.off = size - 3;
      this.state = (buf[start + this.off] | (buf[start + this.off + 1] << 8) | (last << 16)) & 0x3fffff;
    } else {
      fail("Draco bit data is malformed");
    }
    this.state += 4096;
    if (this.state >= 4096 * 256) fail("Draco bit state is out of range");
  }

  /** rabs_desc_read */
  next() {
    const p = (256 - this.probZero) & 255; // AnsP8 is 8 bits wide
    if (this.state < 4096 && this.off > 0) this.state = this.state * 256 + this.buf[this.start + --this.off];
    const x = this.state;
    const quot = x >>> 8;
    const rem = x & 255;
    const xn = quot * p;
    const val = rem < p;
    this.state = (val ? xn + rem : x - xn - p) >>> 0;
    return val;
  }
}

// --- corner tables --------------------------------------------------------------------------

const next = (c) => (c < 0 ? c : c % 3 === 2 ? c - 2 : c + 1);
const prev = (c) => (c < 0 ? c : c % 3 === 0 ? c + 2 : c - 1);

/** CornerTable of the position connectivity. */
class CornerTable {
  constructor(numFaces, maxVertices) {
    this.numCorners = numFaces * 3;
    this.numFaces = numFaces;
    this.c2v = new Int32Array(this.numCorners).fill(-1);
    this.opp = new Int32Array(this.numCorners).fill(-1);
    this.vertexCorners = new Int32Array(Math.max(maxVertices, 0)).fill(-1);
    this.numVertices = 0;
  }

  addVertex() {
    if (this.numVertices >= this.vertexCorners.length) fail("Draco edgebreaker decoded too many vertices");
    return this.numVertices++;
  }

  next(c) { return next(c); }
  prev(c) { return prev(c); }
  opposite(c) { return c < 0 ? -1 : this.opp[c]; }
  vertex(c) { return c < 0 ? -1 : this.c2v[c]; }
  leftMostCorner(v) { return v < 0 || v >= this.numVertices ? -1 : this.vertexCorners[v]; }
  setLeftMostCorner(v, c) { if (v >= 0) this.vertexCorners[v] = c; }
  swingRight(c) { return prev(this.opposite(prev(c))); }
  swingLeft(c) { return next(this.opposite(next(c))); }
  leftCorner(c) { return c < 0 ? -1 : this.opposite(prev(c)); }
  rightCorner(c) { return c < 0 ? -1 : this.opposite(next(c)); }
  isOnBoundary(v) { return this.swingLeft(this.leftMostCorner(v)) < 0; }
}

/** MeshAttributeCornerTable: the position connectivity cut along an attribute's seams. */
class AttributeCornerTable {
  constructor(ct, seamCorners) {
    this.ct = ct;
    this.numCorners = ct.numCorners;
    this.numFaces = ct.numFaces;
    this.edgeSeam = new Uint8Array(ct.numCorners);
    this.vertexSeam = new Uint8Array(ct.numVertices);
    this.c2v = new Int32Array(ct.numCorners).fill(-1);
    this.leftMost = [];
    for (const c of seamCorners) this.addSeamEdge(c);
    this.recomputeVertices();
  }

  addSeamEdge(c) {
    const ct = this.ct;
    this.edgeSeam[c] = 1;
    this.vertexSeam[ct.vertex(next(c))] = 1;
    this.vertexSeam[ct.vertex(prev(c))] = 1;
    const o = ct.opposite(c);
    if (o >= 0) {
      this.edgeSeam[o] = 1;
      this.vertexSeam[ct.vertex(next(o))] = 1;
      this.vertexSeam[ct.vertex(prev(o))] = 1;
    }
  }

  recomputeVertices() {
    const ct = this.ct;
    let numNew = 0;
    const limit = this.numCorners + 1;
    for (let v = 0; v < ct.numVertices; v++) {
      const c = ct.leftMostCorner(v);
      if (c < 0) continue;
      let firstVert = numNew++;
      let firstC = c;
      if (this.vertexSeam[v]) {
        let act = this.swingLeft(firstC);
        for (let n = 0; act >= 0; n++) {
          if (n > limit) fail("Draco attribute connectivity is malformed");
          firstC = act;
          act = this.swingLeft(act);
          if (act === c) fail("Draco attribute connectivity is malformed");
        }
      }
      this.c2v[firstC] = firstVert;
      this.leftMost.push(firstC);
      let act = ct.swingRight(firstC);
      for (let n = 0; act >= 0 && act !== firstC; n++) {
        if (n > limit) fail("Draco attribute connectivity is malformed");
        if (this.edgeSeam[next(act)]) {
          firstVert = numNew++;
          this.leftMost.push(act);
        }
        this.c2v[act] = firstVert;
        act = ct.swingRight(act);
      }
    }
  }

  get numVertices() { return this.leftMost.length; }
  next(c) { return next(c); }
  prev(c) { return prev(c); }
  opposite(c) { return c < 0 || this.edgeSeam[c] ? -1 : this.ct.opposite(c); }
  vertex(c) { return c < 0 ? -1 : this.c2v[c]; }
  isCornerOnSeam(c) { return this.vertexSeam[this.ct.vertex(c)] === 1; }
  leftMostCorner(v) { return v < 0 || v >= this.leftMost.length ? -1 : this.leftMost[v]; }
  swingRight(c) { return prev(this.opposite(prev(c))); }
  swingLeft(c) { return next(this.opposite(next(c))); }
  leftCorner(c) { return c < 0 ? -1 : this.opposite(prev(c)); }
  rightCorner(c) { return c < 0 ? -1 : this.opposite(next(c)); }
  isOnBoundary(v) {
    const c = this.leftMostCorner(v);
    return c < 0 || this.swingLeft(c) < 0;
  }
}

// --- connectivity ---------------------------------------------------------------------------

function decodeSequentialConnectivity(r, maxValues) {
  const numFaces = r.varint();
  const numPoints = r.varint();
  checkSize(numFaces * 3, maxValues, "indices");
  checkSize(numPoints, maxValues, "points");
  if (numFaces > Math.floor(0xffffffff / 3) || numFaces > Math.floor(r.remaining() / 3)) {
    fail("Draco mesh has too many faces for its size");
  }
  const method = r.u8();
  const indices = new Uint32Array(numFaces * 3);
  if (method === 0) {
    const symbols = new Uint32Array(numFaces * 3);
    decodeSymbols(numFaces * 3, 1, r, symbols);
    let last = 0;
    for (let i = 0; i < symbols.length; i++) {
      const encoded = symbols[i];
      let diff = encoded >>> 1;
      if (encoded & 1) {
        if (diff > last) fail("Draco index is out of range");
        diff = -diff;
      } else if (diff > 0x7fffffff - last) {
        fail("Draco index is out of range");
      }
      const value = diff + last;
      if (value < 0 || value >= numPoints) fail("Draco index is out of range");
      indices[i] = value;
      last = value;
    }
  } else {
    let read;
    if (numPoints < 256) read = () => r.u8();
    else if (numPoints < 1 << 16) read = () => r.u16();
    else if (numPoints < 1 << 21) read = () => r.varint();
    else read = () => r.i32() >>> 0;
    for (let i = 0; i < indices.length; i++) {
      const value = read();
      if (value >= numPoints) fail("Draco index is out of range");
      indices[i] = value;
    }
  }
  return { method: MESH_SEQUENTIAL_ENCODING, numPoints, numFaces, cornerToPoint: indices };
}

/** Edgebreaker connectivity (MeshEdgebreakerDecoderImpl::DecodeConnectivity). */
function decodeEdgebreakerConnectivity(r, maxValues) {
  const traversalType = r.u8();
  if (traversalType !== EDGEBREAKER_STANDARD && traversalType !== EDGEBREAKER_VALENCE) {
    fail(`Unsupported Draco edgebreaker traversal ${traversalType}`);
  }
  const numEncodedVertices = r.varint();
  const numFaces = r.varint();
  if (numFaces > Math.floor(0xffffffff / 3)) fail("Draco mesh has too many faces");
  checkSize(numFaces * 3, maxValues, "indices");
  if (numEncodedVertices > numFaces * 3) fail("Draco mesh has more vertices than corners");
  if ((numEncodedVertices * (numEncodedVertices - 1)) / 2 < Math.floor((3 * numFaces) / 2)) {
    fail("Draco mesh has too few vertices for its faces");
  }
  const numAttributeData = r.u8();
  const numSymbols = r.varint();
  if (numFaces < numSymbols) fail("Draco mesh has more symbols than faces");
  if (numFaces > numSymbols + Math.floor(numSymbols / 3)) fail("Draco mesh has too many faces for its symbols");
  const numSplitSymbols = r.varint();
  if (numSplitSymbols > numSymbols) fail("Draco mesh has too many split symbols");

  const maxVertices = numEncodedVertices + numSplitSymbols;
  const ct = new CornerTable(numFaces, maxVertices);
  const isVertHole = new Uint8Array(maxVertices).fill(1);

  // Topology split events.
  const splits = [];
  const numSplits = r.varint();
  if (numSplits > 0) {
    if (numSplits > numFaces) fail("Draco mesh has too many topology splits");
    let lastSource = 0;
    for (let i = 0; i < numSplits; i++) {
      const source = r.varint() + lastSource;
      const delta = r.varint();
      if (delta > source) fail("Draco topology split is malformed");
      splits.push({ source, split: source - delta, edge: 0 });
      lastSource = source;
    }
    r.startBits(false);
    for (const s of splits) s.edge = r.bits(1) & 1;
    r.endBits();
  }

  // Traversal data.
  let symbolReader = null;
  let buffer = r.clone();
  if (traversalType === EDGEBREAKER_STANDARD) {
    symbolReader = buffer.clone();
    const size = symbolReader.startBits(true);
    buffer = new Reader(symbolReader.bytes, symbolReader.pos, symbolReader.end);
    if (size > buffer.remaining()) fail("Draco edgebreaker symbols are truncated");
    buffer.advance(size);
  }
  const startFaces = new BitDecoder(buffer);
  const seamDecoders = [];
  for (let i = 0; i < numAttributeData; i++) seamDecoders.push(new BitDecoder(buffer));
  const endBuffer = buffer;

  let decodeSymbol;
  let onActiveCorner = () => {};
  let mergeVertices = () => {};
  if (traversalType === EDGEBREAKER_STANDARD) {
    decodeSymbol = () => {
      const symbol = symbolReader.bits(1);
      if (symbol === TOPOLOGY_C) return symbol;
      return symbol | (symbolReader.bits(2) << 1);
    };
  } else {
    const valences = new Int32Array(maxVertices);
    const contextSymbols = [];
    const counters = [];
    for (let i = 0; i < 6; i++) {
      const n = endBuffer.varint();
      if (n > numFaces) fail("Draco valence context is too large");
      const symbols = new Uint32Array(n);
      if (n > 0) decodeSymbols(n, 1, endBuffer, symbols);
      contextSymbols.push(symbols);
      counters.push(n);
    }
    let activeContext = -1;
    let lastSymbol = -1;
    decodeSymbol = () => {
      if (activeContext !== -1) {
        const counter = --counters[activeContext];
        if (counter < 0) return TOPOLOGY_INVALID;
        const id = contextSymbols[activeContext][counter];
        if (id > 4) return TOPOLOGY_INVALID;
        lastSymbol = SYMBOL_TO_TOPOLOGY[id];
      } else {
        lastSymbol = TOPOLOGY_E;
      }
      return lastSymbol;
    };
    const bump = (c, n) => {
      const v = ct.vertex(c);
      if (v >= 0 && v < maxVertices) valences[v] += n;
    };
    onActiveCorner = (corner) => {
      const n = next(corner);
      const p = prev(corner);
      switch (lastSymbol) {
        case TOPOLOGY_C:
        case TOPOLOGY_S: bump(n, 1); bump(p, 1); break;
        case TOPOLOGY_R: bump(corner, 1); bump(n, 1); bump(p, 2); break;
        case TOPOLOGY_L: bump(corner, 1); bump(n, 2); bump(p, 1); break;
        case TOPOLOGY_E: bump(corner, 2); bump(n, 2); bump(p, 2); break;
        default: break;
      }
      const active = valences[ct.vertex(n)] ?? 0;
      activeContext = Math.min(7, Math.max(2, active)) - 2;
    };
    mergeVertices = (dest, source) => {
      valences[dest] += valences[source];
    };
  }

  const setOpposite = (a, b) => {
    ct.opp[a] = b;
    ct.opp[b] = a;
  };
  const vertexOf = (c) => {
    const v = ct.vertex(c);
    if (v < 0) fail("Draco edgebreaker connectivity is malformed");
    return v;
  };

  // Symbols.
  const removeInvalidVertices = numAttributeData === 0;
  const invalidVertices = [];
  const stack = [];
  const splitCorners = new Map();
  let faces = 0;
  for (let symbolId = 0; symbolId < numSymbols; symbolId++) {
    const corner = 3 * faces++;
    let checkSplit = false;
    const symbol = decodeSymbol();
    if (symbol === TOPOLOGY_C) {
      if (!stack.length) fail("Draco edgebreaker connectivity is malformed");
      const a = stack[stack.length - 1];
      const x = vertexOf(next(a));
      const b = next(ct.leftMostCorner(x));
      if (a === b) fail("Draco edgebreaker connectivity is malformed");
      if (ct.opposite(a) >= 0 || b < 0 || ct.opposite(b) >= 0) fail("Draco edgebreaker connectivity is malformed");
      setOpposite(a, corner + 1);
      setOpposite(b, corner + 2);
      const aPrev = vertexOf(prev(a));
      const bNext = vertexOf(next(b));
      if (x === aPrev || x === bNext) fail("Draco edgebreaker connectivity is malformed");
      ct.c2v[corner] = x;
      ct.c2v[corner + 1] = bNext;
      ct.c2v[corner + 2] = aPrev;
      ct.setLeftMostCorner(aPrev, corner + 2);
      isVertHole[x] = 0;
      stack[stack.length - 1] = corner;
    } else if (symbol === TOPOLOGY_R || symbol === TOPOLOGY_L) {
      if (!stack.length) fail("Draco edgebreaker connectivity is malformed");
      const a = stack[stack.length - 1];
      if (ct.opposite(a) >= 0) fail("Draco edgebreaker connectivity is malformed");
      let oppCorner, cornerL, cornerR;
      if (symbol === TOPOLOGY_R) {
        oppCorner = corner + 2;
        cornerL = corner + 1;
        cornerR = corner;
      } else {
        oppCorner = corner + 1;
        cornerL = corner;
        cornerR = corner + 2;
      }
      setOpposite(oppCorner, a);
      const v = ct.addVertex();
      ct.c2v[oppCorner] = v;
      ct.setLeftMostCorner(v, oppCorner);
      const vr = ct.vertex(prev(a));
      ct.c2v[cornerR] = vr;
      ct.setLeftMostCorner(vr, cornerR);
      ct.c2v[cornerL] = ct.vertex(next(a));
      stack[stack.length - 1] = corner;
      checkSplit = true;
    } else if (symbol === TOPOLOGY_S) {
      if (!stack.length) fail("Draco edgebreaker connectivity is malformed");
      const b = stack.pop();
      if (splitCorners.has(symbolId)) stack.push(splitCorners.get(symbolId));
      if (!stack.length) fail("Draco edgebreaker connectivity is malformed");
      const a = stack[stack.length - 1];
      if (a === b) fail("Draco edgebreaker connectivity is malformed");
      if (ct.opposite(a) >= 0 || ct.opposite(b) >= 0) fail("Draco edgebreaker connectivity is malformed");
      setOpposite(a, corner + 2);
      setOpposite(b, corner + 1);
      const vp = vertexOf(prev(a));
      ct.c2v[corner] = vp;
      ct.c2v[corner + 1] = ct.vertex(next(a));
      const bPrev = ct.vertex(prev(b));
      ct.c2v[corner + 2] = bPrev;
      ct.setLeftMostCorner(bPrev, corner + 2);
      let cn = next(b);
      const vn = vertexOf(cn);
      mergeVertices(vp, vn);
      ct.setLeftMostCorner(vp, ct.leftMostCorner(vn));
      const first = cn;
      while (cn >= 0) {
        ct.c2v[cn] = vp;
        cn = ct.swingLeft(cn);
        if (cn === first) fail("Draco edgebreaker connectivity is malformed");
      }
      ct.vertexCorners[vn] = -1;
      if (removeInvalidVertices) invalidVertices.push(vn);
      stack[stack.length - 1] = corner;
    } else if (symbol === TOPOLOGY_E) {
      const v = ct.addVertex();
      ct.c2v[corner] = v;
      ct.c2v[corner + 1] = ct.addVertex();
      ct.c2v[corner + 2] = ct.addVertex();
      ct.setLeftMostCorner(v, corner);
      ct.setLeftMostCorner(v + 1, corner + 1);
      ct.setLeftMostCorner(v + 2, corner + 2);
      stack.push(corner);
      checkSplit = true;
    } else {
      fail("Draco edgebreaker symbol is invalid");
    }
    onActiveCorner(stack[stack.length - 1]);
    if (checkSplit) {
      const encoderSymbolId = numSymbols - symbolId - 1;
      while (splits.length) {
        const last = splits[splits.length - 1];
        if (last.source > encoderSymbolId) fail("Draco topology split is malformed");
        if (last.source !== encoderSymbolId) break;
        splits.pop();
        const top = stack[stack.length - 1];
        const newActive = last.edge === RIGHT_FACE_EDGE ? next(top) : prev(top);
        splitCorners.set(numSymbols - last.split - 1, newActive);
      }
    }
  }

  // Interior faces that close holes between the start faces.
  const initCorners = [];
  while (stack.length) {
    const corner = stack.pop();
    if (startFaces.next()) {
      if (faces >= numFaces) fail("Draco edgebreaker decoded too many faces");
      const vn = vertexOf(next(corner));
      const b = next(ct.leftMostCorner(vn));
      const vx = vertexOf(next(b));
      const c = next(ct.leftMostCorner(vx));
      if (corner === b || corner === c || b === c || b < 0 || c < 0) fail("Draco edgebreaker connectivity is malformed");
      if (ct.opposite(corner) >= 0 || ct.opposite(b) >= 0 || ct.opposite(c) >= 0) {
        fail("Draco edgebreaker connectivity is malformed");
      }
      const vp = ct.vertex(next(c));
      const nc = 3 * faces++;
      setOpposite(nc, corner);
      setOpposite(nc + 1, b);
      setOpposite(nc + 2, c);
      ct.c2v[nc] = vx;
      ct.c2v[nc + 1] = vp;
      ct.c2v[nc + 2] = vn;
      for (let i = 0; i < 3; i++) isVertHole[ct.c2v[nc + i]] = 0;
      initCorners.push(nc);
    } else {
      initCorners.push(corner);
    }
  }
  if (faces !== numFaces) fail("Draco edgebreaker decoded an unexpected number of faces");

  // Fill the vertices left by S symbols with the last vertices (only without attribute data).
  let numVertices = ct.numVertices;
  for (const invalid of invalidVertices) {
    let src = numVertices - 1;
    while (src >= 0 && ct.leftMostCorner(src) < 0) src = --numVertices - 1;
    if (src < 0) fail("Draco edgebreaker connectivity is malformed");
    if (src < invalid) continue;
    for (const c of vertexCorners(ct, ct.leftMostCorner(src))) {
      if (ct.c2v[c] !== src) fail("Draco edgebreaker connectivity is malformed");
      ct.c2v[c] = invalid;
    }
    ct.setLeftMostCorner(invalid, ct.leftMostCorner(src));
    ct.vertexCorners[src] = -1;
    isVertHole[invalid] = isVertHole[src];
    isVertHole[src] = 0;
    numVertices--;
  }

  // Attribute seams.
  const seams = Array.from({ length: numAttributeData }, () => []);
  if (numAttributeData > 0) {
    for (let f = 0; f < numFaces; f++) {
      for (let k = 0; k < 3; k++) {
        const c = 3 * f + k;
        const o = ct.opposite(c);
        if (o < 0) {
          for (const s of seams) s.push(c);
          continue;
        }
        if (Math.floor(o / 3) < f) continue;
        for (let i = 0; i < numAttributeData; i++) {
          if (seamDecoders[i].next()) seams[i].push(c);
        }
      }
    }
  }
  const attributeData = seams.map((s) => ({
    table: new AttributeCornerTable(ct, s),
    decoderId: -1,
    isConnectivityUsed: true,
    encoding: null,
  }));
  for (const d of attributeData) d.encoding = encodingData(Math.max(d.table.numVertices, ct.numVertices));
  const posEncoding = encodingData(ct.numVertices);

  const cornerToPoint = assignPointsToCorners(ct, attributeData, isVertHole);
  const numPoints = attributeData.length ? cornerToPoint.numPoints : numVertices;
  r.pos = endBuffer.pos;
  return {
    method: MESH_EDGEBREAKER_ENCODING,
    numFaces,
    numPoints,
    cornerToPoint: cornerToPoint.map,
    ct,
    attributeData,
    posEncoding,
    posDecoderId: -1,
  };
}

function checkSize(n, max, what) {
  if (n > max) fail(`Draco mesh has ${n} ${what}, more than the limit (${max})`);
}

function encodingData(numVertices) {
  return { v2e: new Int32Array(numVertices), corners: [] };
}

/** Corners around a vertex: VertexCornersIterator from a starting corner. */
function* vertexCorners(table, start) {
  let c = start;
  let left = true;
  for (let n = 0; c >= 0; n++) {
    if (n > table.numCorners) fail("Draco connectivity is malformed");
    yield c;
    if (left) {
      c = table.swingLeft(c);
      if (c < 0) {
        c = table.swingRight(start);
        left = false;
      } else if (c === start) {
        c = -1;
      }
    } else {
      c = table.swingRight(c);
    }
  }
}

/** AssignPointsToCorners: one point per corner fan, split where any attribute has a seam. */
function assignPointsToCorners(ct, attributeData, isVertHole) {
  const map = new Uint32Array(ct.numCorners);
  if (!attributeData.length) {
    for (let c = 0; c < ct.numCorners; c++) map[c] = ct.c2v[c];
    return { map, numPoints: 0 };
  }
  let numPoints = 0;
  const limit = ct.numCorners + 1;
  for (let v = 0; v < ct.numVertices; v++) {
    let c = ct.leftMostCorner(v);
    if (c < 0) continue;
    let first = c;
    if (!isVertHole[v]) {
      for (const d of attributeData) {
        if (!d.table.isCornerOnSeam(c)) continue;
        const vert = d.table.vertex(c);
        let act = ct.swingRight(c);
        let found = false;
        for (let n = 0; act !== c; n++) {
          if (act < 0 || n > limit) fail("Draco attribute connectivity is malformed");
          if (d.table.vertex(act) !== vert) {
            first = act;
            found = true;
            break;
          }
          act = ct.swingRight(act);
        }
        if (found) break;
      }
    }
    c = first;
    map[c] = numPoints++;
    let prevC = c;
    c = ct.swingRight(c);
    for (let n = 0; c >= 0 && c !== first; n++) {
      if (n > limit) fail("Draco attribute connectivity is malformed");
      let seam = false;
      for (const d of attributeData) {
        if (d.table.vertex(c) !== d.table.vertex(prevC)) {
          seam = true;
          break;
        }
      }
      map[c] = seam ? numPoints++ : map[prevC];
      prevC = c;
      c = ct.swingRight(c);
    }
  }
  return { map, numPoints };
}

// --- traversal (attribute value order) ------------------------------------------------------

/** DepthFirstTraverser over `table`, reporting newly visited vertices to visit(vertex, corner). */
function traverseDepthFirst(table, visit) {
  const faceVisited = new Uint8Array(table.numFaces);
  const vertexVisited = new Uint8Array(table.numVertices);
  const isFaceVisited = (c) => c < 0 || faceVisited[Math.floor(c / 3)] === 1;
  const stack = [];
  for (let f = 0; f < table.numFaces; f++) {
    let corner = 3 * f;
    if (isFaceVisited(corner)) continue;
    stack.length = 0;
    stack.push(corner);
    const nv = table.vertex(next(corner));
    const pv = table.vertex(prev(corner));
    if (nv < 0 || pv < 0) fail("Draco traversal reached an invalid vertex");
    if (!vertexVisited[nv]) {
      vertexVisited[nv] = 1;
      visit(nv, next(corner));
    }
    if (!vertexVisited[pv]) {
      vertexVisited[pv] = 1;
      visit(pv, prev(corner));
    }
    while (stack.length) {
      corner = stack[stack.length - 1];
      if (corner < 0 || isFaceVisited(corner)) {
        stack.pop();
        continue;
      }
      for (;;) {
        faceVisited[Math.floor(corner / 3)] = 1;
        const v = table.vertex(corner);
        if (v < 0) fail("Draco traversal reached an invalid vertex");
        if (!vertexVisited[v]) {
          const onBoundary = table.isOnBoundary(v);
          vertexVisited[v] = 1;
          visit(v, corner);
          if (!onBoundary) {
            corner = table.rightCorner(corner);
            continue;
          }
        }
        const right = table.rightCorner(corner);
        const left = table.leftCorner(corner);
        if (isFaceVisited(right)) {
          if (isFaceVisited(left)) {
            stack.pop();
            break;
          }
          corner = left;
        } else if (isFaceVisited(left)) {
          corner = right;
        } else {
          stack[stack.length - 1] = left;
          stack.push(right);
          break;
        }
      }
    }
  }
}

/** MaxPredictionDegreeTraverser. */
function traversePredictionDegree(table, visit) {
  if (table.numVertices === 0) return;
  const faceVisited = new Uint8Array(table.numFaces);
  const vertexVisited = new Uint8Array(table.numVertices);
  const degree = new Int32Array(table.numVertices);
  const isFaceVisited = (c) => c < 0 || faceVisited[Math.floor(c / 3)] === 1;
  const stacks = [[], [], []];
  let best = 0;
  const priorityOf = (c) => {
    const tip = table.vertex(c);
    let priority = 0;
    if (!vertexVisited[tip]) priority = ++degree[tip] > 1 ? 1 : 2;
    return Math.min(priority, 2);
  };
  const pop = () => {
    for (let i = best; i < 3; i++) {
      if (stacks[i].length) {
        best = i;
        return stacks[i].pop();
      }
    }
    return -1;
  };
  const mark = (v, c) => {
    if (!vertexVisited[v]) {
      vertexVisited[v] = 1;
      visit(v, c);
    }
  };
  for (let f = 0; f < table.numFaces; f++) {
    let corner = 3 * f;
    stacks[0].push(corner);
    best = 0;
    const nv = table.vertex(next(corner));
    const pv = table.vertex(prev(corner));
    const tv = table.vertex(corner);
    if (nv < 0 || pv < 0 || tv < 0) fail("Draco traversal reached an invalid vertex");
    mark(nv, next(corner));
    mark(pv, prev(corner));
    mark(tv, corner);
    while ((corner = pop()) >= 0) {
      if (isFaceVisited(corner)) continue;
      for (;;) {
        faceVisited[Math.floor(corner / 3)] = 1;
        const v = table.vertex(corner);
        if (v < 0) fail("Draco traversal reached an invalid vertex");
        mark(v, corner);
        const right = table.rightCorner(corner);
        const left = table.leftCorner(corner);
        const rightVisited = isFaceVisited(right);
        const leftVisited = isFaceVisited(left);
        if (!leftVisited) {
          const priority = priorityOf(left);
          if (rightVisited && priority <= best) {
            corner = left;
            continue;
          }
          stacks[priority].push(left);
          if (priority < best) best = priority;
        }
        if (!rightVisited) {
          const priority = priorityOf(right);
          if (priority <= best) {
            corner = right;
            continue;
          }
          stacks[priority].push(right);
          if (priority < best) best = priority;
        }
        break;
      }
    }
  }
}

// --- octahedral normals ---------------------------------------------------------------------

const mostSignificantBit = (n) => 31 - Math.clz32(n);

class OctahedronToolBox {
  constructor(bits) {
    if (!(bits >= 2 && bits <= 30)) fail(`Draco normal quantization of ${bits} bits is not supported`);
    this.bits = bits;
    this.maxQuantized = 2 ** bits - 1;
    this.maxValue = this.maxQuantized - 1;
    this.center = Math.floor(this.maxValue / 2);
    this.scale = f32(2 / f32(this.maxValue));
  }

  canonicalizeOctahedralCoords(s, t) {
    const max = this.maxValue;
    const center = this.center;
    if ((s === 0 && t === 0) || (s === 0 && t === max) || (s === max && t === 0)) {
      s = max;
      t = max;
    } else if (s === 0 && t > center) {
      t = center - (t - center);
    } else if (s === max && t < center) {
      t = center + (center - t);
    } else if (t === max && s < center) {
      s = center + (center - s);
    } else if (t === 0 && s > center) {
      s = center - (s - center);
    }
    return [s, t];
  }

  integerVectorToOctahedral(v) {
    let s, t;
    if (v[0] >= 0) {
      s = v[1] + this.center;
      t = v[2] + this.center;
    } else {
      s = v[1] < 0 ? Math.abs(v[2]) : this.maxValue - Math.abs(v[2]);
      t = v[2] < 0 ? Math.abs(v[1]) : this.maxValue - Math.abs(v[1]);
    }
    return this.canonicalizeOctahedralCoords(s, t);
  }

  /** CanonicalizeIntegerVector (int64 arithmetic) for an int32 vector, in place. */
  canonicalizeIntegerVector(v) {
    const absSum = Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2]);
    if (absSum === 0) {
      v[0] = this.center;
      return;
    }
    v[0] = mulDivTrunc(v[0], this.center, absSum) | 0;
    v[1] = mulDivTrunc(v[1], this.center, absSum) | 0;
    const rest = this.center - Math.abs(v[0]) - Math.abs(v[1]);
    v[2] = v[2] >= 0 ? rest : -rest;
  }

  /** QuantizedOctahedralCoordsToUnitVector, in float32 like the reference decoder. */
  toUnitVector(s, t, out, o) {
    let y = f32(f32(f32(s) * this.scale) - 1);
    let z = f32(f32(f32(t) * this.scale) - 1);
    const x = f32(f32(1 - Math.abs(y)) - Math.abs(z));
    let xOffset = -x;
    if (xOffset < 0) xOffset = 0;
    y = f32(y + (y < 0 ? xOffset : -xOffset));
    z = f32(z + (z < 0 ? xOffset : -xOffset));
    const normSquared = f32(f32(f32(x * x) + f32(y * y)) + f32(z * z));
    if (normSquared < 1e-6) {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
    } else {
      const d = f32(1 / f32(Math.sqrt(normSquared)));
      out[o] = f32(x * d);
      out[o + 1] = f32(y * d);
      out[o + 2] = f32(z * d);
    }
  }

  isInDiamond(s, t) {
    return Math.abs(s) + Math.abs(t) <= this.center;
  }

  invertDiamond(p) {
    const s = p[0];
    const t = p[1];
    let signS, signT;
    if (s >= 0 && t >= 0) {
      signS = 1;
      signT = 1;
    } else if (s <= 0 && t <= 0) {
      signS = -1;
      signT = -1;
    } else {
      signS = s > 0 ? 1 : -1;
      signT = t > 0 ? 1 : -1;
    }
    const cs = (signS * this.center) >>> 0;
    const ctv = (signT * this.center) >>> 0;
    let us = (((s >>> 0) + (s >>> 0)) - cs) >>> 0;
    let ut = (((t >>> 0) + (t >>> 0)) - ctv) >>> 0;
    if (signS * signT >= 0) {
      const tmp = us;
      us = -ut >>> 0;
      ut = -tmp >>> 0;
    } else {
      const tmp = us;
      us = ut;
      ut = tmp;
    }
    us = (us + cs) >>> 0;
    ut = (ut + ctv) >>> 0;
    p[0] = ((us | 0) / 2) | 0;
    p[1] = ((ut | 0) / 2) | 0;
  }

  modMax(x) {
    if (x > this.center) return x - this.maxQuantized;
    if (x < -this.center) return x + this.maxQuantized;
    return x;
  }
}

/** trunc(a * b / c) with int64 semantics, exact for int32 a, b, c. */
function mulDivTrunc(a, b, c) {
  const product = a * b;
  if (Math.abs(product) < 2 ** 53) return Math.trunc(product / c);
  return Number((BigInt(a) * BigInt(b)) / BigInt(c));
}

// --- prediction transforms ------------------------------------------------------------------

class WrapTransform {
  constructor() {
    this.correctionsPositive = false;
    this.numComponents = 0;
  }

  decodeData(r) {
    const min = r.i32();
    const max = r.i32();
    if (min > max) fail("Draco wrap transform is malformed");
    const dif = max - min;
    if (dif < 0 || dif >= 0x7fffffff) fail("Draco wrap transform is malformed");
    this.min = min;
    this.max = max;
    this.maxDif = 1 + dif;
  }

  init(numComponents) {
    this.numComponents = numComponents;
  }

  /** out[o..] = wrap(clamp(pred[p..]) + corr[c..]) */
  apply(pred, p, corr, c, out, o) {
    const { min, max, maxDif } = this;
    for (let i = 0; i < this.numComponents; i++) {
      let pv = pred[p + i];
      if (pv > max) pv = max;
      else if (pv < min) pv = min;
      let value = pv + corr[c + i];
      if (value > max) value -= maxDif;
      else if (value < min) value += maxDif;
      out[o + i] = value;
    }
  }
}

class NormalOctahedronCanonicalizedTransform {
  constructor() {
    this.correctionsPositive = true;
  }

  decodeData(r) {
    const maxQuantized = r.i32();
    r.i32(); // center value (unused)
    if (maxQuantized % 2 === 0) fail("Draco normal transform is malformed");
    const bits = mostSignificantBit(maxQuantized >>> 0) + 1;
    this.tool = new OctahedronToolBox(bits);
  }

  init() {}

  apply(pred, p, corr, c, out, o) {
    const tool = this.tool;
    const center = tool.center;
    const q = [(pred[p] - center) | 0, (pred[p + 1] - center) | 0];
    const inDiamond = tool.isInDiamond(q[0], q[1]);
    if (!inDiamond) tool.invertDiamond(q);
    const bottomLeft = (q[0] === 0 && q[1] === 0) || (q[0] < 0 && q[1] <= 0);
    const rotation = rotationCount(q);
    let pr = q;
    if (!bottomLeft) pr = rotatePoint(q, rotation);
    let orig = [tool.modMax((pr[0] + corr[c]) | 0), tool.modMax((pr[1] + corr[c + 1]) | 0)];
    if (!bottomLeft) orig = rotatePoint(orig, (4 - rotation) % 4);
    if (!inDiamond) tool.invertDiamond(orig);
    out[o] = (orig[0] + center) | 0;
    out[o + 1] = (orig[1] + center) | 0;
  }
}

function rotationCount(p) {
  const [x, y] = p;
  if (x === 0) return y === 0 ? 0 : y > 0 ? 3 : 1;
  if (x > 0) return y >= 0 ? 2 : 1;
  return y <= 0 ? 0 : 3;
}

function rotatePoint(p, count) {
  switch (count) {
    case 1: return [p[1], -p[0] | 0];
    case 2: return [-p[0] | 0, -p[1] | 0];
    case 3: return [-p[1] | 0, p[0]];
    default: return [p[0], p[1]];
  }
}

// --- prediction schemes ---------------------------------------------------------------------

/** PredictionSchemeDeltaDecoder */
class DeltaScheme {
  constructor(transform) {
    this.transform = transform;
  }

  decodeData(r) {
    this.transform.decodeData(r);
  }

  compute(data, size, nc) {
    const t = this.transform;
    t.init(nc);
    t.apply(new Int32Array(nc), 0, data, 0, data, 0);
    for (let i = nc; i < size; i += nc) t.apply(data, i - nc, data, i, data, i);
  }
}

function parallelogramPrediction(entry, ci, table, v2e, data, nc, out) {
  const oci = table.opposite(ci);
  if (oci < 0) return false;
  const vo = v2e[table.vertex(oci)];
  const vn = v2e[table.vertex(next(oci))];
  const vp = v2e[table.vertex(prev(oci))];
  if (vo < entry && vn < entry && vp < entry) {
    for (let c = 0; c < nc; c++) out[c] = (data[vn * nc + c] + data[vp * nc + c] - data[vo * nc + c]) | 0;
    return true;
  }
  return false;
}

class ParallelogramScheme {
  constructor(transform, md) {
    this.transform = transform;
    this.md = md;
  }

  decodeData(r) {
    this.transform.decodeData(r);
  }

  compute(data, size, nc) {
    const { table, v2e, corners } = this.md;
    const t = this.transform;
    t.init(nc);
    const pred = new Int32Array(nc);
    t.apply(pred, 0, data, 0, data, 0);
    if (corners.length * nc > size) fail("Draco prediction data is inconsistent");
    for (let p = 1; p < corners.length; p++) {
      const dst = p * nc;
      if (!parallelogramPrediction(p, corners[p], table, v2e, data, nc, pred)) t.apply(data, dst - nc, data, dst, data, dst);
      else t.apply(pred, 0, data, dst, data, dst);
    }
  }
}

class ConstrainedMultiParallelogramScheme {
  constructor(transform, md) {
    this.transform = transform;
    this.md = md;
    this.creases = [[], [], [], []];
  }

  decodeData(r) {
    for (let i = 0; i < 4; i++) {
      const numFlags = r.varint();
      if (numFlags > this.md.table.numCorners) fail("Draco prediction data is malformed");
      if (numFlags > 0) {
        const bits = new BitDecoder(r);
        const flags = new Uint8Array(numFlags);
        for (let j = 0; j < numFlags; j++) flags[j] = bits.next() ? 1 : 0;
        this.creases[i] = flags;
      }
    }
    this.transform.decodeData(r);
  }

  compute(data, size, nc) {
    const { table, v2e, corners } = this.md;
    const t = this.transform;
    t.init(nc);
    const preds = [0, 1, 2, 3].map(() => new Int32Array(nc));
    t.apply(preds[0], 0, data, 0, data, 0);
    const pos = [0, 0, 0, 0];
    const multi = new Int32Array(nc);
    if (corners.length * nc > size) fail("Draco prediction data is inconsistent");
    const limit = table.numCorners + 1;
    for (let p = 1; p < corners.length; p++) {
      const start = corners[p];
      let corner = start;
      let count = 0;
      let firstPass = true;
      for (let n = 0; corner >= 0; n++) {
        if (n > limit) fail("Draco connectivity is malformed");
        if (parallelogramPrediction(p, corner, table, v2e, data, nc, preds[count])) {
          if (++count === 4) break;
        }
        corner = firstPass ? table.swingLeft(corner) : table.swingRight(corner);
        if (corner === start) break;
        if (corner < 0 && firstPass) {
          firstPass = false;
          corner = table.swingRight(start);
        }
      }
      let used = 0;
      if (count > 0) {
        multi.fill(0);
        for (let i = 0; i < count; i++) {
          const context = count - 1;
          const k = pos[context]++;
          if (this.creases[context].length <= k) fail("Draco prediction data is truncated");
          if (!this.creases[context][k]) {
            used++;
            for (let j = 0; j < nc; j++) multi[j] = (multi[j] + preds[i][j]) | 0;
          }
        }
      }
      const dst = p * nc;
      if (used === 0) {
        t.apply(data, dst - nc, data, dst, data, dst);
      } else {
        for (let c = 0; c < nc; c++) multi[c] = (multi[c] / used) | 0;
        t.apply(multi, 0, data, dst, data, dst);
      }
    }
  }
}

/** Position (int64) of an attribute entry, from the portable position attribute. */
function positionLookup(md) {
  const { pos, pointIds } = md;
  return (entry) => {
    const point = pointIds[entry];
    const index = pos.mapping ? pos.mapping[point] : point;
    const o = index * 3;
    const v = pos.portable;
    if (point === undefined || !(o >= 0 && o + 2 < v.length)) fail("Draco prediction refers to a missing position");
    return [v[o], v[o + 1], v[o + 2]];
  };
}

function intSqrt(n) {
  if (n === 0n) return 0n;
  let act = n;
  let root = 1n;
  while (act >= 2n) {
    root *= 2n;
    act /= 4n;
  }
  do {
    root = u64((root + n / root) / 2n);
  } while (u64(root * root) > n);
  return root;
}

class TexCoordsPortableScheme {
  constructor(transform, md) {
    this.transform = transform;
    this.md = md;
    this.maxValues = -1;
  }

  decodeData(r) {
    const num = r.i32();
    if (num < 0 || (this.maxValues !== -1 && num > this.maxValues)) fail("Draco texture coordinate data is malformed");
    const orientations = new Uint8Array(num);
    let last = true;
    const bits = new BitDecoder(r);
    for (let i = 0; i < num; i++) {
      if (!bits.next()) last = !last;
      orientations[i] = last ? 1 : 0;
    }
    this.orientations = orientations;
    this.orientationCount = num;
    this.transform.decodeData(r);
  }

  compute(data, size, nc) {
    if (nc !== 2) fail("Draco texture coordinate prediction needs 2 components");
    const { table, v2e, corners } = this.md;
    const position = positionLookup(this.md);
    const t = this.transform;
    t.init(nc);
    if (corners.length * nc > size) fail("Draco prediction data is inconsistent");
    const predicted = new Int32Array(2);
    for (let p = 0; p < corners.length; p++) {
      this.predict(corners[p], data, p, table, v2e, position, predicted);
      t.apply(predicted, 0, data, p * 2, data, p * 2);
    }
  }

  predict(corner, data, id, table, v2e, position, out) {
    const nd = v2e[table.vertex(next(corner))];
    const pd = v2e[table.vertex(prev(corner))];
    if (nd === undefined || pd === undefined) fail("Draco texture coordinate prediction is malformed");
    if (pd < id && nd < id) {
      const nu = data[nd * 2], nv = data[nd * 2 + 1];
      const pu = data[pd * 2], pv = data[pd * 2 + 1];
      if (pu === nu && pv === nv) {
        out[0] = pu;
        out[1] = pv;
        return;
      }
      const tip = position(id).map(BigInt);
      const nextPos = position(nd).map(BigInt);
      const prevPos = position(pd).map(BigInt);
      const pn = [prevPos[0] - nextPos[0], prevPos[1] - nextPos[1], prevPos[2] - nextPos[2]];
      const pnNorm2 = u64(pn[0] * pn[0] + pn[1] * pn[1] + pn[2] * pn[2]);
      if (pnNorm2 !== 0n) {
        const cn = [tip[0] - nextPos[0], tip[1] - nextPos[1], tip[2] - nextPos[2]];
        const cnDotPn = i64(pn[0] * cn[0] + pn[1] * cn[1] + pn[2] * cn[2]);
        const nUv = [BigInt(nu), BigInt(nv)];
        const pnUv = [BigInt(pu) - nUv[0], BigInt(pv) - nUv[1]];
        const nUvAbsMax = babs(nUv[0]) > babs(nUv[1]) ? babs(nUv[0]) : babs(nUv[1]);
        if (nUvAbsMax > INT64_MAX / pnNorm2) fail("Draco texture coordinate prediction overflows");
        const pnUvAbsMax = babs(pnUv[0]) > babs(pnUv[1]) ? babs(pnUv[0]) : babs(pnUv[1]);
        if (babs(cnDotPn) > INT64_MAX / pnUvAbsMax) fail("Draco texture coordinate prediction overflows");
        const xUv = [0, 1].map((i) => i64(u64(nUv[i]) * pnNorm2 + u64(pnUv[i]) * u64(cnDotPn)));
        let pnAbsMax = babs(pn[0]);
        if (babs(pn[1]) > pnAbsMax) pnAbsMax = babs(pn[1]);
        if (babs(pn[2]) > pnAbsMax) pnAbsMax = babs(pn[2]);
        if (pnAbsMax === 0n || babs(cnDotPn) > INT64_MAX / pnAbsMax) fail("Draco texture coordinate prediction overflows");
        const divisor = i64(pnNorm2);
        const xPos = [0, 1, 2].map((i) => i64(nextPos[i] + i64(i64(cnDotPn * pn[i]) / divisor)));
        const d = [tip[0] - xPos[0], tip[1] - xPos[1], tip[2] - xPos[2]];
        const cxNorm2 = u64(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
        const normSquared = i64(intSqrt(u64(cxNorm2 * pnNorm2)));
        const cxUv = [i64(pnUv[1] * normSquared), i64(-pnUv[0] * normSquared)];
        if (this.orientationCount === 0) fail("Draco texture coordinate orientations are exhausted");
        const orientation = this.orientations[--this.orientationCount];
        for (let i = 0; i < 2; i++) {
          const sum = orientation ? u64(u64(xUv[i]) + u64(cxUv[i])) : u64(u64(xUv[i]) - u64(cxUv[i]));
          out[i] = Number(BigInt.asIntN(32, i64(sum) / divisor));
        }
        return;
      }
    }
    let offset = 0;
    if (pd < id) offset = pd * 2;
    if (nd < id) {
      offset = nd * 2;
    } else if (id > 0) {
      offset = (id - 1) * 2;
    } else {
      out[0] = 0;
      out[1] = 0;
      return;
    }
    out[0] = data[offset];
    out[1] = data[offset + 1];
  }
}

class GeometricNormalScheme {
  constructor(transform, md) {
    this.transform = transform;
    this.md = md;
  }

  decodeData(r) {
    this.transform.decodeData(r);
    this.flips = new BitDecoder(r);
  }

  compute(data, size, nc) {
    const tool = this.transform.tool;
    if (!tool) fail("Draco geometric normal prediction needs the octahedron transform");
    const { table, v2e, corners } = this.md;
    const position = positionLookup(this.md);
    const positionOfCorner = (c) => {
      const entry = v2e[table.vertex(c)];
      if (entry === undefined) fail("Draco normal prediction is malformed");
      return position(entry);
    };
    if (corners.length * nc > size) fail("Draco prediction data is inconsistent");
    const normal = new Int32Array(3);
    const oct = new Int32Array(2);
    for (let id = 0; id < corners.length; id++) {
      predictNormal(table, corners[id], positionOfCorner, normal);
      tool.canonicalizeIntegerVector(normal);
      if (this.flips.next()) {
        normal[0] = -normal[0];
        normal[1] = -normal[1];
        normal[2] = -normal[2];
      }
      const [s, t] = tool.integerVectorToOctahedral(normal);
      oct[0] = s;
      oct[1] = t;
      this.transform.apply(oct, 0, data, id * 2, data, id * 2);
    }
  }
}

/** MeshPredictionSchemeGeometricNormalPredictorArea: sum of the face normals around a corner. */
function predictNormal(table, corner, positionOfCorner, out) {
  const cent = positionOfCorner(corner);
  // Exact in doubles while every product and sum stays below 2^53; BigInt otherwise.
  let nx = 0, ny = 0, nz = 0;
  let exact = true;
  const corners = [...vertexCorners(table, corner)];
  const deltas = [];
  for (const c of corners) {
    const pn = positionOfCorner(next(c));
    const pp = positionOfCorner(prev(c));
    const dn = [pn[0] - cent[0], pn[1] - cent[1], pn[2] - cent[2]];
    const dp = [pp[0] - cent[0], pp[1] - cent[1], pp[2] - cent[2]];
    deltas.push([dn, dp]);
    if (exact) {
      const big = Math.max(Math.abs(dn[0]), Math.abs(dn[1]), Math.abs(dn[2]), Math.abs(dp[0]), Math.abs(dp[1]), Math.abs(dp[2]));
      if (big >= 2 ** 25) {
        exact = false;
        continue;
      }
      nx += dn[1] * dp[2] - dn[2] * dp[1];
      ny += dn[2] * dp[0] - dn[0] * dp[2];
      nz += dn[0] * dp[1] - dn[1] * dp[0];
      if (Math.abs(nx) >= 2 ** 52 || Math.abs(ny) >= 2 ** 52 || Math.abs(nz) >= 2 ** 52) exact = false;
    }
  }
  const upper = 2 ** 29;
  if (exact) {
    const absSum = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
    if (absSum > upper) {
      const q = Math.floor(absSum / upper);
      nx = Math.trunc(nx / q);
      ny = Math.trunc(ny / q);
      nz = Math.trunc(nz / q);
    }
    out[0] = nx | 0;
    out[1] = ny | 0;
    out[2] = nz | 0;
    return;
  }
  const n = [0n, 0n, 0n];
  for (const [a, b] of deltas) {
    const u = a.map(BigInt);
    const v = b.map(BigInt);
    n[0] = i64(n[0] + i64(u[1] * v[2] - u[2] * v[1]));
    n[1] = i64(n[1] + i64(u[2] * v[0] - u[0] * v[2]));
    n[2] = i64(n[2] + i64(u[0] * v[1] - u[1] * v[0]));
  }
  let absSum = 0n;
  for (const x of n) {
    const next = babs(x);
    if (absSum > INT64_MAX - next) {
      absSum = INT64_MAX;
      break;
    }
    absSum += next;
  }
  const upperBig = BigInt(upper);
  if (absSum > upperBig) {
    const q = absSum / upperBig;
    for (let i = 0; i < 3; i++) n[i] = n[i] / q;
  }
  for (let i = 0; i < 3; i++) out[i] = Number(BigInt.asIntN(32, n[i]));
}

// --- attributes -----------------------------------------------------------------------------

function readAttributeDecoders(r, mesh, maxValues) {
  const numDecoders = r.u8();
  const decoders = [];
  for (let i = 0; i < numDecoders; i++) {
    const dec = { id: i, attributes: [], sequencer: "linear" };
    if (mesh.method === MESH_EDGEBREAKER_ENCODING) {
      const attDataId = r.i8();
      const decoderType = r.u8();
      if (attDataId >= 0) {
        if (attDataId >= mesh.attributeData.length) fail("Draco attribute decoder refers to missing data");
        if (mesh.attributeData[attDataId].decoderId >= 0) fail("Draco attribute data is used twice");
        mesh.attributeData[attDataId].decoderId = i;
      } else {
        if (mesh.posDecoderId >= 0) fail("Draco position data is used twice");
        mesh.posDecoderId = i;
      }
      const traversal = r.u8();
      if (traversal > TRAVERSAL_PREDICTION_DEGREE) fail(`Unknown Draco traversal method ${traversal}`);
      if (decoderType === MESH_VERTEX_ATTRIBUTE) {
        if (attDataId < 0) {
          dec.encoding = mesh.posEncoding;
        } else {
          dec.encoding = mesh.attributeData[attDataId].encoding;
          mesh.attributeData[attDataId].isConnectivityUsed = false;
        }
        dec.table = mesh.ct;
      } else {
        if (traversal !== TRAVERSAL_DEPTH_FIRST) fail("Draco corner attributes need depth-first traversal");
        if (attDataId < 0) fail("Draco corner attribute has no attribute data");
        dec.encoding = mesh.attributeData[attDataId].encoding;
        dec.table = mesh.attributeData[attDataId].table;
      }
      dec.attDataId = attDataId;
      dec.traversal = traversal;
      dec.sequencer = "traversal";
    }
    decoders.push(dec);
  }
  const attributes = [];
  for (const dec of decoders) {
    const num = r.varint();
    if (num === 0 || num > 5 * r.remaining()) fail("Draco attribute decoder has no attributes");
    for (let i = 0; i < num; i++) {
      const type = r.u8();
      const dataType = r.u8();
      const numComponents = r.u8();
      const normalized = r.u8() > 0;
      if (type >= NUM_ATTRIBUTE_TYPES) fail(`Unknown Draco attribute type ${type}`);
      if (dataType === 0 || dataType >= DATA_TYPES.length) fail(`Unknown Draco data type ${dataType}`);
      if (numComponents === 0) fail("Draco attribute has no components");
      const uniqueId = r.varint();
      checkSize(mesh.numPoints * numComponents, maxValues, "attribute values");
      const att = { id: attributes.length, type, dataType, numComponents, normalized, uniqueId, decoder: dec };
      attributes.push(att);
      dec.attributes.push(att);
    }
    for (const att of dec.attributes) {
      att.seqType = r.u8();
      if (att.seqType > SEQ_NORMALS) fail(`Unknown Draco attribute decoder ${att.seqType}`);
      if (att.seqType === SEQ_QUANTIZATION && att.dataType !== DT_FLOAT32) fail("Draco quantized attribute is not float32");
      if (att.seqType === SEQ_NORMALS && (att.numComponents !== 3 || att.dataType !== DT_FLOAT32)) {
        fail("Draco normal attribute is not 3 x float32");
      }
    }
  }
  return { decoders, attributes };
}

/** Mesh data for a prediction scheme of `att` (CreateMeshPredictionScheme), or null. */
function meshPredictionData(mesh, att, pointIds) {
  if (mesh.method !== MESH_EDGEBREAKER_ENCODING) return null;
  const dec = att.decoder;
  let table = mesh.ct;
  let encoding = mesh.posEncoding;
  const data = mesh.attributeData.find((d) => d.decoderId === dec.id);
  if (data) {
    encoding = data.encoding;
    if (data.isConnectivityUsed) table = data.table;
  }
  return { table, v2e: encoding.v2e, corners: encoding.corners, pointIds };
}

function createPredictionScheme(ctx, att, method, transformType, pointIds) {
  let transform;
  if (att.seqType === SEQ_NORMALS) {
    if (transformType !== TRANSFORM_NORMAL_OCTAHEDRON_CANONICALIZED) return null;
    transform = new NormalOctahedronCanonicalizedTransform();
  } else {
    if (transformType !== TRANSFORM_WRAP) return null;
    transform = new WrapTransform();
  }
  if (method === PREDICTION_MULTI_PARALLELOGRAM || method === PREDICTION_TEX_COORDS_DEPRECATED) {
    fail(`Draco prediction scheme ${method} is not part of bitstream 2.2`);
  }
  const md = meshPredictionData(ctx.mesh, att, pointIds);
  let scheme = null;
  if (md) {
    const isNormal = transformType === TRANSFORM_NORMAL_OCTAHEDRON_CANONICALIZED;
    if (method === PREDICTION_GEOMETRIC_NORMAL) scheme = new GeometricNormalScheme(transform, md);
    else if (!isNormal && method === PREDICTION_PARALLELOGRAM) scheme = new ParallelogramScheme(transform, md);
    else if (!isNormal && method === PREDICTION_CONSTRAINED_MULTI_PARALLELOGRAM) scheme = new ConstrainedMultiParallelogramScheme(transform, md);
    else if (!isNormal && method === PREDICTION_TEX_COORDS_PORTABLE) scheme = new TexCoordsPortableScheme(transform, md);
    if (scheme instanceof GeometricNormalScheme || scheme instanceof TexCoordsPortableScheme) {
      // Parent attribute: the first POSITION attribute, in its portable (quantized) form.
      const pos = ctx.attributes.find((a) => a.type === DRACO_ATTRIBUTE_TYPE.POSITION);
      if (!pos || !pos.portable) fail("Draco prediction needs positions that are not decoded yet");
      if (pos.portableComponents !== 3) fail("Draco prediction needs 3-component positions");
      md.pos = pos;
    }
  }
  return scheme ?? new DeltaScheme(transform);
}

function decodeAttributeValues(ctx, att, pointIds, r) {
  const numEntries = pointIds.length;
  if (att.seqType === SEQ_GENERIC) {
    const [Ctor, size] = DATA_TYPES[att.dataType];
    const byteLength = numEntries * size * att.numComponents;
    r.need(byteLength);
    const copy = r.bytes.slice(r.pos, r.pos + byteLength);
    r.pos += byteLength;
    att.values = new Ctor(copy.buffer, 0, numEntries * att.numComponents);
    return;
  }
  const method = r.i8();
  if (method < PREDICTION_NONE || method >= NUM_PREDICTION_SCHEMES) fail(`Unknown Draco prediction scheme ${method}`);
  let scheme = null;
  if (method !== PREDICTION_NONE) {
    const transformType = r.i8();
    if (transformType < TRANSFORM_NONE || transformType >= NUM_TRANSFORMS) fail(`Unknown Draco prediction transform ${transformType}`);
    scheme = createPredictionScheme(ctx, att, method, transformType, pointIds);
  }
  const nc = att.seqType === SEQ_NORMALS ? 2 : att.numComponents;
  const numValues = numEntries * nc;
  const portable = new Int32Array(numValues);
  const asUint = new Uint32Array(portable.buffer);
  const compressed = r.u8();
  if (compressed > 0) {
    decodeSymbols(numValues, nc, r, asUint);
  } else {
    const numBytes = r.u8();
    if (numBytes > 4) fail("Draco integer values are too wide");
    r.need(numBytes * numValues);
    for (let i = 0; i < numValues; i++) {
      let v = 0;
      for (let b = 0; b < numBytes; b++) v += r.bytes[r.pos++] * 2 ** (8 * b);
      asUint[i] = v;
    }
  }
  if (numValues > 0 && !(scheme && scheme.transform.correctionsPositive)) {
    for (let i = 0; i < numValues; i++) {
      const v = asUint[i];
      portable[i] = v & 1 ? -(v >>> 1) - 1 : v >>> 1;
    }
  }
  if (scheme) {
    if (scheme instanceof TexCoordsPortableScheme) scheme.maxValues = numValues;
    scheme.decodeData(r);
    if (numValues > 0) scheme.compute(portable, numValues, nc);
  }
  att.portable = portable;
  att.portableComponents = nc;
}

function decodeTransformParameters(att, r) {
  if (att.seqType === SEQ_QUANTIZATION) {
    const min = [];
    for (let i = 0; i < att.numComponents; i++) min.push(r.f32());
    const range = r.f32();
    const bits = r.u8();
    if (bits < 1 || bits > 30) fail(`Draco quantization of ${bits} bits is not supported`);
    att.quantization = { min, range, bits };
  } else if (att.seqType === SEQ_NORMALS) {
    att.normalBits = r.u8();
  }
}

function transformToOriginal(att) {
  const { seqType, portable } = att;
  if (seqType === SEQ_INTEGER) {
    if (att.dataType > 6) fail("Draco integer attribute has a non-integer data type");
    const [Ctor] = DATA_TYPES[att.dataType];
    att.values = new Ctor(portable); // static_cast to the attribute's integer type
  } else if (seqType === SEQ_QUANTIZATION) {
    const { min, range, bits } = att.quantization;
    const delta = f32(range / f32(2 ** bits - 1));
    const nc = att.numComponents;
    const out = new Float32Array(portable.length);
    for (let i = 0; i < portable.length; i++) out[i] = f32(f32(f32(portable[i]) * delta) + min[i % nc]);
    att.values = out;
  } else if (seqType === SEQ_NORMALS) {
    const tool = new OctahedronToolBox(att.normalBits);
    const n = portable.length / 2;
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) tool.toUnitVector(portable[2 * i], portable[2 * i + 1], out, 3 * i);
    att.values = out;
  }
}

/** Point ids in attribute value order, filling the encoding data (MeshTraversalSequencer). */
function generateSequence(mesh, dec) {
  if (dec.sequencer === "linear") {
    const ids = new Uint32Array(mesh.numPoints);
    for (let i = 0; i < ids.length; i++) ids[i] = i;
    return ids;
  }
  const ids = [];
  const enc = dec.encoding;
  const visit = (vertex, corner) => {
    ids.push(mesh.cornerToPoint[corner]);
    enc.corners.push(corner);
    enc.v2e[vertex] = enc.corners.length - 1;
  };
  if (dec.traversal === TRAVERSAL_PREDICTION_DEGREE) traversePredictionDegree(dec.table, visit);
  else traverseDepthFirst(dec.table, visit);
  return ids;
}

/** Point -> attribute value index (UpdatePointToAttributeIndexMapping); null for identity. */
function pointMapping(mesh, dec) {
  if (dec.sequencer === "linear") return null;
  const map = new Int32Array(mesh.numPoints).fill(-1);
  const { v2e } = dec.encoding;
  for (let c = 0; c < mesh.numFaces * 3; c++) {
    const point = mesh.cornerToPoint[c];
    const vert = dec.table.vertex(c);
    if (vert < 0) fail("Draco attribute connectivity is malformed");
    const entry = v2e[vert];
    if (point >= mesh.numPoints || entry >= mesh.numPoints) fail("Draco attribute mapping is out of range");
    map[point] = entry;
  }
  return map;
}

function skipMetadata(r) {
  const numAttributeMetadata = r.varint();
  for (let i = 0; i < numAttributeMetadata; i++) {
    r.varint(); // attribute unique id
    skipMetadataElement(r, 0);
  }
  skipMetadataElement(r, 0);
}

function skipMetadataElement(r, level) {
  if (level > 1000) fail("Draco metadata is nested too deeply");
  const numEntries = r.varint();
  for (let i = 0; i < numEntries; i++) {
    r.advance(r.u8()); // name
    const size = r.varint();
    if (size === 0) fail("Draco metadata entry is empty");
    r.advance(size);
  }
  const numSub = r.varint();
  if (numSub > r.remaining()) fail("Draco metadata is truncated");
  for (let i = 0; i < numSub; i++) {
    r.advance(r.u8()); // name
    skipMetadataElement(r, level + 1);
  }
}

// --- entry point ----------------------------------------------------------------------------

/**
 * Decode a Draco-compressed triangle mesh (bitstream 2.2).
 * @param {Uint8Array} bytes
 * @returns {{numPoints: number, indices: Uint32Array, attributes: Array<{uniqueId: number, type: number,
 *   dataType: number, numComponents: number, normalized: boolean, values: ArrayLike<number>}>}}
 *   `values` holds numPoints * numComponents values (one entry per point, like draco3d's
 *   GetAttributeDataArrayForAllPoints), typed by the attribute's Draco data type.
 * `maxValues` bounds the number of indices and of values per attribute (and so the memory used).
 * Throws DracoError for malformed or unsupported data.
 */
export function decodeDracoMesh(bytes, { maxValues = 2 ** 26 } = {}) {
  const r = new Reader(bytes);
  r.need(11);
  const magic = String.fromCharCode(...bytes.subarray(0, 5));
  if (magic !== "DRACO") fail("Not Draco data");
  r.pos = 5;
  const major = r.u8();
  const minor = r.u8();
  const encoderType = r.u8();
  const method = r.u8();
  const flags = r.u16();
  if (encoderType !== TRIANGULAR_MESH) fail("Draco data is not a triangle mesh");
  if (major !== 2 || minor !== 2) fail(`Draco bitstream ${major}.${minor} is not supported (only 2.2)`);
  if (flags & METADATA_FLAG_MASK) skipMetadata(r);
  let mesh;
  if (method === MESH_SEQUENTIAL_ENCODING) mesh = decodeSequentialConnectivity(r, maxValues);
  else if (method === MESH_EDGEBREAKER_ENCODING) mesh = decodeEdgebreakerConnectivity(r, maxValues);
  else fail(`Unknown Draco encoding method ${method}`);

  const { decoders, attributes } = readAttributeDecoders(r, mesh, maxValues);
  const ctx = { mesh, attributes };
  for (const dec of decoders) {
    const pointIds = generateSequence(mesh, dec);
    const mapping = pointMapping(mesh, dec);
    for (const att of dec.attributes) att.mapping = mapping;
    for (const att of dec.attributes) decodeAttributeValues(ctx, att, pointIds, r);
    for (const att of dec.attributes) decodeTransformParameters(att, r);
    for (const att of dec.attributes) transformToOriginal(att);
  }

  const numPoints = mesh.numPoints;
  const indices = Uint32Array.from(mesh.cornerToPoint.subarray(0, mesh.numFaces * 3));
  return {
    numPoints,
    indices,
    attributes: attributes.map((att) => {
      const nc = att.numComponents;
      let values = att.values;
      if (att.mapping) {
        const out = new values.constructor(numPoints * nc);
        for (let p = 0; p < numPoints; p++) {
          const e = att.mapping[p];
          if (e < 0 || (e + 1) * nc > values.length) fail("Draco attribute has no value for a point");
          for (let c = 0; c < nc; c++) out[p * nc + c] = values[e * nc + c];
        }
        values = out;
      } else if (values.length < numPoints * nc) {
        fail("Draco attribute has fewer values than points");
      } else if (values.length > numPoints * nc) {
        values = values.subarray(0, numPoints * nc);
      }
      return { uniqueId: att.uniqueId, type: att.type, dataType: att.dataType, numComponents: nc, normalized: att.normalized, values };
    }),
  };
}
