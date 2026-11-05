#!/usr/bin/env node
// Generates test/draco-vectors.js: Draco streams encoded by Google's encoder (draco3d) and
// what Google's decoder (draco3d) makes of them, so test/draco.js can check src/draco.js
// without a dependency on draco3d. Run by hand when the vectors need to change:
//
//   npm install --no-save draco3d@1.5.9
//   node test/make-draco-vectors.js              write test/draco-vectors.js
//   node test/make-draco-vectors.js --compare 40 compare src/draco.js with draco3d on random meshes
//
// The cases were picked so that together they reach every part of the decoder that the
// encoder can produce: sequential and edgebreaker connectivity (topology splits, interior
// faces), tagged and raw symbols, every prediction scheme and transform, the depth-first and
// prediction-degree traversals over position and attribute connectivity, integer / quantized /
// normal / generic attribute decoders, and metadata. draco3d's JavaScript encoder cannot write
// valence edgebreaker or compressed sequential indices: valence is covered by the Khronos
// samples in test/integration, and the last case rewrites a stream's indices into the compressed
// form with the small rANS encoder below (draco3d decodes it to the same mesh).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32 } from "../src/usdz.js";
import { decodeDracoMesh } from "../src/draco.js";

let draco3d;
try {
  draco3d = (await import("draco3d")).default;
} catch {
  console.error("draco3d is not installed: npm install --no-save draco3d@1.5.9");
  process.exit(1);
}
const enc = await draco3d.createEncoderModule({});
const dec = await draco3d.createDecoderModule({});

// ---- random test meshes ---------------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Grid patches (or a closed octahedron sphere) with holes, flipped faces and UV seams. */
function makeMesh(seed, opts = {}) {
  const R = rng(seed);
  const W = 3 + Math.floor(R() * (opts.big ? 60 : 12)), H = 3 + Math.floor(R() * (opts.big ? 60 : 10));
  const pos = [];
  const comps = 1 + Math.floor(R() * 3);
  const faces = [];
  for (let k = 0; k < comps; k++) {
    const base = pos.length;
    for (let j = 0; j <= H; j++) for (let i = 0; i <= W; i++) {
      const u = i / W, v = j / H;
      const r = 1 + 0.3 * Math.sin(5 * u + seed) * Math.cos(3 * v) + 0.05 * R();
      pos.push([k * 3 + r * Math.cos(2 * Math.PI * u) * Math.sin(Math.PI * v), r * Math.cos(Math.PI * v), r * Math.sin(2 * Math.PI * u) * Math.sin(Math.PI * v)]);
    }
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const a = base + j * (W + 1) + i, b = a + 1, c = a + W + 1, d = c + 1;
      faces.push([a, c, b], [b, c, d]);
    }
  }
  if (opts.closed) {
    pos.length = 0;
    faces.length = 0;
    const key = new Map();
    const vid = (x, y, z) => {
      const l = Math.hypot(x, y, z);
      const k = [x, y, z].map((c) => Math.round((c / l) * 1e6)).join(",");
      if (!key.has(k)) { key.set(k, pos.length); pos.push([x / l, (y / l) * 0.8, z / l]); }
      return key.get(k);
    };
    const n = 2 + Math.floor(R() * 4);
    for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
      const A = [sx, 0, 0], B = [0, sy, 0], C = [0, 0, sz];
      const P = (i, j) => { const k = n - i - j; return [0, 1, 2].map((c) => (A[c] * i + B[c] * j + C[c] * k) / n); };
      const flip = sx * sy * sz < 0;
      for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
        const a = vid(...P(i, j)), b = vid(...P(i + 1, j)), c = vid(...P(i, j + 1));
        faces.push(flip ? [a, b, c] : [a, c, b]);
        if (i + j < n - 1) { const d = vid(...P(i + 1, j + 1)); faces.push(flip ? [b, d, c] : [b, c, d]); }
      }
    }
  }
  let fs = faces.filter(() => R() > (opts.holes ?? 0.08));
  for (let i = fs.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [fs[i], fs[j]] = [fs[j], fs[i]]; }
  fs = fs.map((f) => (R() < (opts.flips ?? 0.03) ? [f[0], f[2], f[1]] : f));
  if (opts.weld) {
    for (let n = 0; n < 3; n++) {
      const a = Math.floor(R() * pos.length), b = Math.floor(R() * pos.length);
      fs = fs.map((f) => f.map((x) => (x === a ? b : x)));
    }
  }
  const regions = 1 + Math.floor(R() * 3);
  const pointKey = new Map();
  const points = [];
  const indices = [];
  fs.forEach((f, fi) => {
    const region = opts.seams === false ? 0 : Math.floor((fi * regions) / fs.length);
    for (const v of f) {
      const key = v + ":" + region;
      if (!pointKey.has(key)) { pointKey.set(key, points.length); points.push({ v, region }); }
      indices.push(pointKey.get(key));
    }
  });
  const n = points.length;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), T = new Float32Array(n * 2), C = new Uint8Array(n * 4);
  const J = new Uint16Array(n * 4), Wt = new Float32Array(n * 4), G = new Int16Array(n * 2), U32 = new Uint32Array(n);
  points.forEach((p, i) => {
    const [x, y, z] = pos[p.v];
    P.set([x, y, z], i * 3);
    const l = Math.hypot(x, y, z) || 1;
    const nn = [x / l + 0.2 * (R() - 0.5), y / l, z / l + p.region * 0.3];
    const ln = Math.hypot(...nn) || 1;
    N.set(nn.map((c) => c / ln), i * 3);
    T.set([((p.v % 17) / 17 + p.region * 0.37) % 1.3, Math.floor(p.v / 17) / 9 + p.region * 0.1], i * 2);
    C.set([(p.v * 7) & 255, p.region * 80, 200, 255], i * 4);
    J.set([p.v % 5, (p.v + 1) % 7, 3, 0], i * 4);
    const w = [R(), R(), R(), R()];
    const s = w.reduce((a, b) => a + b);
    Wt.set(w.map((x) => x / s), i * 4);
    G.set([p.v - 300, -p.region * 1000], i * 2);
    U32[i] = ((p.v * 2654435761) >>> 0) % 1000003;
  });
  return { numPoints: n, indices: new Uint32Array(indices), P, N, T, C, J, Wt, G, U32 };
}

/** Attribute sets (Draco types: POSITION 0, NORMAL 1, COLOR 2, TEX_COORD 3, GENERIC 4). */
function attributeSets(m, R) {
  const q = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));
  return [
    [{ type: 0, dataType: 9, nc: 3, values: m.P, q: q(8, 16) }],
    [{ type: 0, dataType: 9, nc: 3, values: m.P, q: q(8, 16) }, { type: 1, dataType: 9, nc: 3, values: m.N, q: q(6, 12) }, { type: 3, dataType: 9, nc: 2, values: m.T, q: q(8, 14) }],
    [{ type: 0, dataType: 9, nc: 3, values: m.P, q: q(10, 14) }, { type: 3, dataType: 9, nc: 2, values: m.T, q: q(10, 12) }, { type: 2, dataType: 2, nc: 4, values: m.C, normalized: true },
      { type: 4, dataType: 4, nc: 4, values: m.J }, { type: 4, dataType: 9, nc: 4, values: m.Wt, q: q(8, 12) }, { type: 4, dataType: 3, nc: 2, values: m.G }],
    [{ type: 0, dataType: 9, nc: 3, values: m.P }, { type: 1, dataType: 9, nc: 3, values: m.N }, { type: 3, dataType: 9, nc: 2, values: m.T }],
    [{ type: 0, dataType: 9, nc: 3, values: m.P, q: q(11, 14) }, { type: 4, dataType: 6, nc: 1, values: m.U32 }, { type: 1, dataType: 9, nc: 3, values: m.N, q: q(8, 10) }],
  ];
}

// ---- draco3d ---------------------------------------------------------------------------

const ADD = { 1: "AddInt8Attribute", 2: "AddUInt8Attribute", 3: "AddInt16Attribute", 4: "AddUInt16Attribute", 5: "AddInt32Attribute", 6: "AddUInt32Attribute", 9: "AddFloatAttribute" };

function encode(mesh, { method, speed, expert = false, metadata = false }) {
  const builder = new enc.MeshBuilder();
  const m = new enc.Mesh();
  builder.AddFacesToMesh(m, mesh.indices.length / 3, mesh.indices);
  const ids = mesh.attributes.map((a) => {
    const id = builder[ADD[a.dataType]](m, a.type, mesh.numPoints, a.nc, a.values);
    if (a.normalized) builder.SetNormalizedFlagForAttribute(m, id, true);
    return id;
  });
  if (metadata) {
    const mb = new enc.MetadataBuilder();
    const md = new enc.Metadata();
    mb.AddStringEntry(md, "generator", "gltf2usd-js test");
    mb.AddIntEntryArray(md, "numbers", new Int32Array([1, -2, 3]), 3);
    mb.AddDoubleEntry(md, "scale", 0.5);
    builder.AddMetadata(m, md);
    ids.forEach((id, i) => {
      const am = new enc.Metadata();
      mb.AddStringEntry(am, "name", "attr" + i);
      builder.SetMetadataForAttribute(m, id, am);
    });
  }
  const out = new enc.DracoInt8Array();
  const e = expert ? new enc.ExpertEncoder(m) : new enc.Encoder();
  if (expert) {
    mesh.attributes.forEach((a, i) => { if (a.q) e.SetAttributeQuantization(ids[i], a.q); });
  } else {
    for (const a of mesh.attributes) if (a.q) e.SetAttributeQuantization(a.type, a.q);
  }
  e.SetSpeedOptions(speed, speed);
  e.SetEncodingMethod(method === 1 ? enc.MESH_EDGEBREAKER_ENCODING : enc.MESH_SEQUENTIAL_ENCODING);
  const len = expert ? e.EncodeToDracoBuffer(false, out) : e.EncodeMeshToDracoBuffer(m, out);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = out.GetValue(i) & 255;
  for (const x of [e, out, m, builder]) enc.destroy(x);
  if (!len) throw new Error("draco3d could not encode the mesh");
  return bytes;
}

const ARRAY = { 1: Int8Array, 2: Uint8Array, 3: Int16Array, 4: Uint16Array, 5: Int32Array, 6: Uint32Array, 9: Float32Array };

/** draco3d's decoding: triangle indices and every attribute for all points, in its own type. */
function reference(bytes) {
  const d = new dec.Decoder();
  const m = new dec.Mesh();
  const status = d.DecodeArrayToMesh(bytes, bytes.length, m);
  if (!status.ok()) throw new Error("draco3d: " + status.error_msg());
  const numPoints = m.num_points();
  const ib = m.num_faces() * 12;
  const ip = dec._malloc(ib);
  d.GetTrianglesUInt32Array(m, ib, ip);
  const indices = new Uint32Array(dec.HEAPU8.buffer.slice(ip, ip + ib));
  dec._free(ip);
  const attributes = [];
  for (let i = 0; i < m.num_attributes(); i++) {
    const a = d.GetAttribute(m, i);
    const Ctor = ARRAY[a.data_type()];
    const nb = numPoints * a.num_components() * Ctor.BYTES_PER_ELEMENT;
    const p = dec._malloc(nb);
    d.GetAttributeDataArrayForAllPoints(m, a, a.data_type(), nb, p);
    attributes.push({ uniqueId: a.unique_id(), type: a.attribute_type(), dataType: a.data_type(), numComponents: a.num_components(), normalized: a.normalized(), values: new Ctor(dec.HEAPU8.buffer.slice(p, p + nb)) });
    dec._free(p);
  }
  dec.destroy(m);
  dec.destroy(d);
  return { numPoints, indices, attributes };
}

const bytesOf = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** The expectation stored in the vectors: shapes, CRC32 of the bytes, the first values. */
function summarize(mesh) {
  return {
    numPoints: mesh.numPoints,
    numIndices: mesh.indices.length,
    indicesCrc32: crc32(bytesOf(mesh.indices)),
    attributes: mesh.attributes.map((a) => ({
      uniqueId: a.uniqueId, type: a.type, dataType: a.dataType, numComponents: a.numComponents, normalized: a.normalized,
      crc32: crc32(bytesOf(a.values)), first: Array.from(a.values.subarray(0, 6)),
    })),
  };
}

// ---- compressed sequential indices (test-only rANS encoder) ------------------------------

function varint(n, out) {
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 128;
    out.push(b);
  } while (n);
}

/** DecodeSymbols' RAW scheme for `values` (< 2^8): frequency table + rANS, 12-bit precision. */
function encodeRawSymbols(values) {
  const precision = 4096;
  const numSymbols = Math.max(...values) + 1;
  const counts = new Array(numSymbols).fill(0);
  for (const v of values) counts[v]++;
  // Probabilities proportional to the counts (each used symbol >= 1), summing to 4096.
  const probs = counts.map((c) => (c ? Math.max(1, Math.floor((c * precision) / values.length)) : 0));
  let excess = probs.reduce((a, b) => a + b) - precision;
  while (excess !== 0) {
    const i = probs.indexOf(Math.max(...probs));
    const step = excess > 0 ? Math.min(excess, probs[i] - 1) : excess;
    probs[i] -= step;
    excess -= step;
  }
  const cum = [];
  probs.reduce((a, p, i) => ((cum[i] = a), a + p), 0);
  const out = [1, 8]; // RAW symbols, max bit length 8 -> 12-bit precision
  varint(numSymbols, out);
  for (let i = 0; i < numSymbols; i++) {
    const p = probs[i];
    if (p === 0) {
      let run = 1;
      while (run < 64 && i + run < numSymbols && probs[i + run] === 0) run++;
      out.push(((run - 1) << 2) | 3);
      i += run - 1;
    } else if (p < 64) {
      out.push(p << 2);
    } else {
      out.push(((p & 63) << 2) | 1, p >> 6);
    }
  }
  const lBase = 4 * precision;
  let state = lBase;
  const ans = [];
  for (let i = values.length - 1; i >= 0; i--) {
    const p = probs[values[i]];
    while (state >= (lBase / precision) * 256 * p) {
      ans.push(state % 256);
      state = Math.floor(state / 256);
    }
    state = Math.floor(state / p) * precision + (state % p) + cum[values[i]];
  }
  state -= lBase;
  if (state < 1 << 6) ans.push(state);
  else if (state < 1 << 14) ans.push(state & 255, (1 << 6) | (state >> 8));
  else ans.push(state & 255, (state >> 8) & 255, (2 << 6) | (state >> 16));
  varint(ans.length, out);
  return [...out, ...ans];
}

/** Rewrites a sequential stream with uncompressed indices (< 256 points) to compressed ones. */
function compressSequentialIndices(bytes) {
  let pos = 11;
  const readVarint = () => {
    let v = 0, scale = 1, b;
    do { b = bytes[pos++]; v += (b & 127) * scale; scale *= 128; } while (b & 128);
    return v;
  };
  if (bytes[8] !== 0 || bytes[10] & 0x80) throw new Error("expected a sequential stream without metadata");
  const numFaces = readVarint();
  const numPoints = readVarint();
  if (bytes[pos] !== 1 || numPoints >= 256) throw new Error("expected 8-bit uncompressed indices");
  const head = Array.from(bytes.subarray(0, pos));
  pos++;
  const indices = bytes.subarray(pos, pos + numFaces * 3);
  const symbols = [];
  let last = 0;
  for (const v of indices) {
    const diff = v - last;
    symbols.push(diff < 0 ? (-diff << 1) | 1 : diff << 1);
    last = v;
  }
  return new Uint8Array([...head, 0, ...encodeRawSymbols(symbols), ...bytes.subarray(pos + numFaces * 3)]);
}

// ---- cases -------------------------------------------------------------------------------

const CASES = [
  { name: "edgebreaker: closed mesh, topology splits, interior faces, raw symbols, parallelogram", seed: 1, mesh: { closed: true, flips: 0.02, holes: 0.05 }, set: 0, method: 1, speed: 1 },
  { name: "edgebreaker: metadata, prediction-degree traversal, attribute seams, constrained multi-parallelogram, geometric normals, uint32", seed: 11, mesh: { flips: 0.02, holes: 0.05 }, set: 4, method: 1, speed: 0, metadata: true },
  { name: "sequential: uncompressed indices, difference prediction (wrap and octahedron), integer attribute", seed: 10, mesh: { closed: true, flips: 0.02, holes: 0.3 }, set: 4, method: 0, speed: 0 },
  { name: "edgebreaker: portable texture coordinate prediction, normals, UV seams", seed: 22, mesh: { closed: true, flips: 0.02, holes: 0.05 }, set: 1, method: 1, speed: 0 },
  { name: "edgebreaker: unquantized (generic) float attributes", seed: 22, mesh: { closed: true, flips: 0.02, holes: 0.05 }, set: 3, method: 1, speed: 7 },
  { name: "edgebreaker: colors (normalized uint8), joints (uint16), weights, int16, holes and flipped faces", seed: 4, mesh: { weld: true, flips: 0.1 }, set: 2, method: 1, speed: 3, expert: true },
  { name: "sequential: compressed indices (rewritten from the uncompressed case above)", from: 2 },
];

function caseMesh(c) {
  const m = makeMesh(c.seed, c.mesh);
  const attributes = attributeSets(m, rng(c.seed * 31 + c.set))[c.set];
  return { numPoints: m.numPoints, indices: m.indices, attributes };
}

const sameMesh = (a, b) => JSON.stringify(summarize(a)) === JSON.stringify(summarize(b));

if (process.argv[2] === "--compare") {
  // Random comparison of src/draco.js with draco3d (not written to the vectors).
  const count = Number(process.argv[3] || 40);
  let pass = 0, fail = 0;
  for (let seed = 1; seed <= count; seed++) {
    const R = rng(seed * 7919);
    const m = makeMesh(seed, { big: seed % 10 === 0, closed: seed % 7 === 0, weld: seed % 4 === 0, flips: seed % 3 === 0 ? 0.1 : 0.02, holes: seed % 5 === 0 ? 0.3 : 0.05, seams: seed % 6 !== 0 });
    attributeSets(m, R).forEach((attributes) => {
      for (const method of [0, 1]) for (let speed = 0; speed <= 10; speed++) {
        if (R() < 0.6) continue;
        const bytes = encode({ numPoints: m.numPoints, indices: m.indices, attributes }, { method, speed, expert: R() < 0.4, metadata: R() < 0.1 });
        let ok;
        try { ok = sameMesh(reference(bytes), decodeDracoMesh(bytes)); } catch (e) { ok = false; console.log(e.message); }
        if (ok) pass++;
        else { fail++; console.log(`mismatch: seed ${seed} method ${method} speed ${speed}`); }
      }
    });
  }
  console.log(`${pass} identical, ${fail} different`);
  process.exit(fail ? 1 : 0);
}

const vectors = [];
for (const c of CASES) {
  let bytes;
  if (c.from !== undefined) {
    bytes = compressSequentialIndices(vectors[c.from].bytes);
    if (!sameMesh(reference(bytes), reference(vectors[c.from].bytes))) throw new Error(`${c.name}: draco3d decodes the rewritten stream differently`);
  } else {
    bytes = encode(caseMesh(c), c);
  }
  vectors.push({ name: c.name, bytes, expected: summarize(reference(bytes)) });
}
const toBase64 = (b) => btoa(String.fromCharCode(...b));
const body = vectors.map((v) => JSON.stringify({ name: v.name, encoded: toBase64(v.bytes), ...v.expected }, null, 2)).join(",\n");
const file = join(dirname(new URL(import.meta.url).pathname), "draco-vectors.js");
writeFileSync(file, `// Generated by test/make-draco-vectors.js: Draco streams from draco3d 1.5.9's encoder and
// what draco3d's decoder returns for them (indices and per-point attribute values in each
// attribute's own type, as CRC32 of the bytes plus the first values).
// Used by test/draco.js to check src/draco.js without a dependency on draco3d.
export const VECTORS = [\n${body.replace(/^/gm, "  ")}\n];\n`);
console.log(`wrote ${file} (${vectors.length} vectors, ${vectors.reduce((n, v) => n + v.bytes.length, 0)} bytes of Draco data)`);
