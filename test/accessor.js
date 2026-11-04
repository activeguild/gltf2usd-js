// Accessor decoding: matrix column padding (MAT2 / MAT3 with 1- and 2-byte components),
// byteStride and sparse values. Padding bytes are filled with a sentinel that must never
// show up in the decoded data.
import { GltfAsset } from "../src/glb.js";
import { elementLayout } from "../src/validate.js";

let failures = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); failures++; } };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const BYTE = 5120, UBYTE = 5121, SHORT = 5122, USHORT = 5123, FLOAT = 5126;
const SIZE = { [BYTE]: 1, [UBYTE]: 1, [SHORT]: 2, [USHORT]: 2, [FLOAT]: 4 };
const SENTINEL = { [BYTE]: 0x55, [UBYTE]: 0xaa, [SHORT]: 0x5555, [USHORT]: 0xaaaa, [FLOAT]: 999 };
const ROWS = { MAT2: 2, MAT3: 3, MAT4: 4 };

// Element sizes from the glTF spec's data alignment rules.
const EXPECTED_SIZE = [
  ["MAT2", BYTE, 8], ["MAT2", UBYTE, 8], ["MAT2", SHORT, 8], ["MAT2", USHORT, 8],
  ["MAT3", BYTE, 12], ["MAT3", UBYTE, 12], ["MAT3", SHORT, 24], ["MAT3", USHORT, 24],
  ["MAT4", BYTE, 16], ["MAT4", SHORT, 32], ["MAT4", FLOAT, 64], ["MAT2", FLOAT, 16], ["MAT3", FLOAT, 36],
  ["VEC3", UBYTE, 3], ["VEC3", FLOAT, 12], ["SCALAR", USHORT, 2],
];
for (const [type, ct, size] of EXPECTED_SIZE) {
  assert(elementLayout(ct, type).size === size, `${type} ${ct}: element size ${elementLayout(ct, type).size}, expected ${size}`);
}

/**
 * Write `count` matrices (column-major values) into a buffer with glTF column alignment
 * (or a larger stride), padding filled with the sentinel. Returns the raw bytes.
 */
function writeMatrices(type, ct, values, stride) {
  const rows = ROWS[type];
  const cs = SIZE[ct];
  const column = Math.ceil((rows * cs) / 4) * 4;
  const count = values.length / (rows * rows);
  const bytes = new Uint8Array(stride * count);
  const dv = new DataView(bytes.buffer);
  const put = (o, v) => {
    if (ct === BYTE) dv.setInt8(o, v); else if (ct === UBYTE) dv.setUint8(o, v);
    else if (ct === SHORT) dv.setInt16(o, v, true); else if (ct === USHORT) dv.setUint16(o, v, true);
    else dv.setFloat32(o, v, true);
  };
  // Sentinel everywhere first (component-sized, so padding decodes to the sentinel).
  for (let o = 0; o + cs <= bytes.length; o += cs) put(o, SENTINEL[ct]);
  for (let i = 0; i < count; i++) {
    for (let col = 0; col < rows; col++) for (let r = 0; r < rows; r++) {
      put(i * stride + col * column + r * cs, values[i * rows * rows + col * rows + r]);
    }
  }
  return bytes;
}

function assetFor(bytes, accessor, bufferView = {}) {
  const json = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: bytes.length }],
    bufferViews: [{ buffer: 0, byteLength: bytes.length, ...bufferView }],
    accessors: [{ bufferView: 0, ...accessor }],
  };
  return new GltfAsset({ json, bin: bytes });
}

// Distinct small values (fit every component type, never the sentinel).
const valuesFor = (type, count) => Array.from({ length: count * ROWS[type] ** 2 }, (_, i) => (i % 50) + 1);

const CASES = [["MAT2", BYTE], ["MAT2", UBYTE], ["MAT2", SHORT], ["MAT2", USHORT],
  ["MAT3", BYTE], ["MAT3", UBYTE], ["MAT3", SHORT], ["MAT3", USHORT], ["MAT4", FLOAT], ["MAT4", UBYTE]];
for (const [type, ct] of CASES) {
  const count = 3;
  const values = valuesFor(type, count);
  const { size } = elementLayout(ct, type);
  // Tightly packed (stride = element size, padding inside columns only).
  const packed = assetFor(writeMatrices(type, ct, values, size), { componentType: ct, type, count });
  const got = packed.accessor(0).data;
  assert(same(got, values), `${type} ${ct} packed: ${got.slice(0, 12)} …`);
  assert(!got.includes(SENTINEL[ct]), `${type} ${ct}: padding was read`);
  // With a byteStride larger than the element (vertex-attribute style).
  const stride = size + 8;
  if (stride <= 252) {
    const strided = assetFor(writeMatrices(type, ct, values, stride), { componentType: ct, type, count }, { byteStride: stride });
    assert(same(strided.accessor(0).data, values), `${type} ${ct} with byteStride ${stride}`);
  }
  // Accessor byteOffset into the view (one element in).
  const shifted = assetFor(writeMatrices(type, ct, [...valuesFor(type, 1).map(() => 7), ...values], size), { componentType: ct, type, count, byteOffset: size });
  assert(same(shifted.accessor(0).data, values), `${type} ${ct} with byteOffset`);
}

// Normalized matrices use the same layout (MAT3 UBYTE normalized → v / 255).
{
  const values = valuesFor("MAT3", 2);
  const a = assetFor(writeMatrices("MAT3", UBYTE, values, 12), { componentType: UBYTE, type: "MAT3", count: 2, normalized: true });
  assert(same(a.accessor(0).data, values.map((v) => v / 255)), "normalized MAT3 UBYTE");
}

// Sparse: zeros + 2 replaced MAT3 SHORT elements; the values view uses the padded layout.
{
  const type = "MAT3", ct = SHORT, count = 4;
  const replaced = valuesFor(type, 2);
  const valueBytes = writeMatrices(type, ct, replaced, 24);
  const indexBytes = new Uint8Array(new Uint16Array([1, 3]).buffer);
  const bytes = new Uint8Array(indexBytes.length + 2 + valueBytes.length); // indices padded to 4
  bytes.set(indexBytes, 0);
  bytes.set(valueBytes, 4);
  const json = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: bytes.length }],
    bufferViews: [{ buffer: 0, byteLength: 4 }, { buffer: 0, byteOffset: 4, byteLength: valueBytes.length }],
    accessors: [{ componentType: ct, type, count, sparse: { count: 2, indices: { bufferView: 0, componentType: USHORT }, values: { bufferView: 1 } } }],
  };
  const got = new GltfAsset({ json, bin: bytes }).accessor(0).data;
  const want = [...new Array(9).fill(0), ...replaced.slice(0, 9), ...new Array(9).fill(0), ...replaced.slice(9)];
  assert(same(got, want), `sparse MAT3 SHORT: ${got}`);
  assert(!got.includes(SENTINEL[ct]), "sparse MAT3 SHORT: padding was read");
}

// Vector / scalar accessors are unchanged by the matrix layout (tightly packed components).
{
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const a = assetFor(bytes, { componentType: UBYTE, type: "VEC3", count: 2 });
  assert(same(a.accessor(0).data, [1, 2, 3, 4, 5, 6]), "VEC3 UBYTE packed");
  const s = assetFor(new Uint8Array([1, 2, 3, 4, 9, 9, 9, 9, 5, 6, 7, 8]), { componentType: UBYTE, type: "VEC4", count: 2 }, { byteStride: 8 });
  assert(same(s.accessor(0).data, [1, 2, 3, 4, 5, 6, 7, 8]), "VEC4 UBYTE with stride 8");
}

if (failures) { console.error(`accessor: ${failures} failure(s)`); process.exit(1); }
console.log("accessor tests passed");
