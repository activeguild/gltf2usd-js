// Builds a tiny GLB in memory: a textured cube plus a translated child node.
// Pure ESM (no Node APIs) so the browser demo can use it too.

// 1x1 red PNG
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

/** @returns {Uint8Array} GLB bytes */
export function buildCubeGlb() {
  const { bin, views } = cubeBin();
  return packGlb({
    asset: { version: "2.0", generator: "test" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "Cube Root", mesh: 0, children: [1] },
      { name: "child-1", mesh: 0, translation: [2, 0, 0], rotation: [0, 0.7071068, 0, 0.7071068], scale: [0.5, 0.5, 0.5] },
    ],
    meshes: [{ name: "Cube", primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    accessors: CUBE_ACCESSORS,
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
    images: [{ bufferView: 4, mimeType: "image/png", name: "red" }],
    textures: [{ source: 0 }],
    materials: [{ name: "Red Mat", pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.8 } }],
  }, bin);
}

/**
 * Stage 2 feature cases on top of the cube geometry:
 *  - two images with the same name ("tex") → distinct file names in the USDZ
 *  - a sampler with CLAMP_TO_EDGE / MIRRORED_REPEAT → wrapS / wrapT
 *  - an unsupported extension and a LINES primitive → options.onWarning
 * @returns {Uint8Array} GLB bytes
 */
export function buildFeatureGlb() {
  const { bin, views } = cubeBin();
  return packGlb({
    asset: { version: "2.0", generator: "test-features" },
    extensionsUsed: ["KHR_materials_unlit"],
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      { name: "Clamped", mesh: 0 },
      { name: "Unlit", mesh: 1, translation: [1.5, 0, 0] },
    ],
    meshes: [
      { name: "CubeA", primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] },
      {
        name: "CubeB",
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 1 },
          { attributes: { POSITION: 0 }, mode: 1 },
        ],
      },
    ],
    accessors: CUBE_ACCESSORS,
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
    images: [
      { bufferView: 4, mimeType: "image/png", name: "tex" },
      { bufferView: 4, mimeType: "image/png", name: "tex" },
    ],
    samplers: [{ wrapS: 33071, wrapT: 33648 }],
    textures: [{ source: 0, sampler: 0 }, { source: 1 }],
    materials: [
      { name: "A", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
      { name: "B", pbrMetallicRoughness: { baseColorTexture: { index: 1 } }, extensions: { KHR_materials_unlit: {} } },
    ],
  }, bin);
}

const CUBE_ACCESSORS = [
  { bufferView: 0, componentType: 5126, count: 24, type: "VEC3", min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
  { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
  { bufferView: 2, componentType: 5126, count: 24, type: "VEC2" },
  { bufferView: 3, componentType: 5123, count: 36, type: "SCALAR" },
];

/** Cube positions / normals / uvs / indices + a 1x1 PNG as bufferViews 0..4. */
function cubeBin() {
  const png = base64ToBytes(PNG_BASE64);

  const P = [];
  const N = [];
  const UV = [];
  const I = [];
  const faces = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  ];
  for (const [n, u, v] of faces) {
    const base = P.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let c = 0; c < 3; c++) P.push(n[c] * 0.5 + u[c] * a * 0.5 + v[c] * b * 0.5);
      N.push(...n);
      UV.push((a + 1) / 2, (b + 1) / 2);
    }
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const parts = [
    new Uint8Array(new Float32Array(P).buffer),
    new Uint8Array(new Float32Array(N).buffer),
    new Uint8Array(new Float32Array(UV).buffer),
    pad4(new Uint8Array(new Uint16Array(I).buffer)),
    pad4(png),
  ];
  let off = 0;
  const views = [];
  for (const p of parts) {
    views.push({ buffer: 0, byteOffset: off, byteLength: p.length });
    off += p.length;
  }
  return { bin: concat(parts), views };
}

function packGlb(json, bin) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonChunk = new Uint8Array(jsonBytes.length + ((4 - (jsonBytes.length % 4)) % 4)).fill(0x20);
  jsonChunk.set(jsonBytes);

  const total = 12 + 8 + jsonChunk.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonChunk.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonChunk, 20);
  const binHeader = 20 + jsonChunk.length;
  dv.setUint32(binHeader, bin.length, true);
  dv.setUint32(binHeader + 4, 0x004e4942, true);
  out.set(bin, binHeader + 8);
  return out;
}

function pad4(bytes) {
  const out = new Uint8Array(bytes.length + ((4 - (bytes.length % 4)) % 4));
  out.set(bytes);
  return out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
