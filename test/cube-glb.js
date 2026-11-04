// Builds a tiny GLB in memory: a textured cube plus a translated child node.
// Pure ESM (no Node APIs) so the browser demo can use it too.
import { encodePng } from "./png.js";

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
 *  - "UV1": baseColor from TEXCOORD_1 (= TEXCOORD_0 * 0.5, i.e. one quadrant)
 *  - "Transformed": KHR_texture_transform (offset / rotation / scale)
 *  - a child node named like its parent's mesh prim (prim name collision)
 *  - "Coated": KHR_materials_emissive_strength / ior / clearcoat (+ transmission, unsupported)
 * The quadrant texture (red / green on top, blue / yellow at the bottom) makes
 * flips and rotations visible in the demo.
 * @returns {Uint8Array} GLB bytes
 */
export function buildFeatureGlb() {
  const uv1 = cubeUvs().map((v) => v * 0.5);
  const { bin, views } = cubeBin([
    new Uint8Array(new Float32Array(uv1).buffer), // bufferView 5
    quadrantPng(), // bufferView 6
  ]);
  return packGlb({
    asset: { version: "2.0", generator: "test-features" },
    extensionsUsed: [
      "KHR_materials_unlit", "KHR_texture_transform", "KHR_materials_emissive_strength",
      "KHR_materials_ior", "KHR_materials_clearcoat", "KHR_materials_transmission",
    ],
    scene: 0,
    scenes: [{ nodes: [0, 1, 2, 3, 5] }],
    nodes: [
      { name: "Clamped", mesh: 0 },
      { name: "Unlit", mesh: 1, translation: [1.5, 0, 0] },
      { name: "UV1", mesh: 2, translation: [3, 0, 0], children: [4] },
      { name: "Transformed", mesh: 3, translation: [4.5, 0, 0] },
      { name: "CubeC" }, // same name as its parent's mesh prim → must be renamed
      { name: "Coated", mesh: 4, translation: [6, 0, 0] },
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
      { name: "CubeC", primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, TEXCOORD_1: 4 }, indices: 3, material: 2 }] },
      { name: "CubeD", primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 3 }] },
      { name: "CubeE", primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 4 }] },
    ],
    accessors: [...CUBE_ACCESSORS, { bufferView: 5, componentType: 5126, count: 24, type: "VEC2" }],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
    images: [
      { bufferView: 4, mimeType: "image/png", name: "tex" },
      { bufferView: 4, mimeType: "image/png", name: "tex" },
      { bufferView: 6, mimeType: "image/png", name: "quadrants" },
    ],
    samplers: [{ wrapS: 33071, wrapT: 33648 }],
    textures: [{ source: 0, sampler: 0 }, { source: 1 }, { source: 2 }],
    materials: [
      { name: "A", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
      { name: "B", pbrMetallicRoughness: { baseColorTexture: { index: 1 } }, extensions: { KHR_materials_unlit: {} } },
      { name: "C", pbrMetallicRoughness: { baseColorTexture: { index: 2, texCoord: 1 }, metallicFactor: 0 } },
      {
        name: "D",
        pbrMetallicRoughness: {
          baseColorTexture: {
            index: 2,
            extensions: { KHR_texture_transform: { offset: [0.25, 0.1], rotation: 0.5, scale: [1.5, 0.75] } },
          },
          metallicFactor: 0,
        },
      },
      {
        name: "E",
        pbrMetallicRoughness: { baseColorFactor: [0.2, 0.3, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.6 },
        emissiveFactor: [0.5, 0.25, 0],
        extensions: {
          KHR_materials_emissive_strength: { emissiveStrength: 2 },
          KHR_materials_ior: { ior: 1.33 },
          KHR_materials_clearcoat: { clearcoatFactor: 0.8, clearcoatRoughnessTexture: { index: 2 }, clearcoatRoughnessFactor: 0.5 },
          KHR_materials_transmission: { transmissionFactor: 0.5 },
        },
      },
    ],
  }, bin);
}

/**
 * The cube as a .gltf with external files: buffer "cube.bin" and the image at
 * "textures/red%20png.png" (percent-encoded, no mimeType → sniffed).
 * @returns {{ gltf: string, resources: Record<string, Uint8Array> }}
 */
export function buildCubeGltf() {
  const glb = buildCubeGlb();
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
  const bin = glb.subarray(20 + jsonLength + 8);
  const png = base64ToBytes(PNG_BASE64);
  json.buffers[0].uri = "cube.bin";
  json.images[0] = { uri: "textures/red%20png.png", name: "red" };
  return {
    gltf: JSON.stringify(json, null, 2),
    resources: { "cube.bin": bin, "textures/red png.png": png },
  };
}

/**
 * Stage 3: four instanced cubes, each animated with a different sampler:
 *  - "Slide":  translation, LINEAR
 *  - "Spin":   rotation about Y, LINEAR (slerp)
 *  - "Pulse":  scale, STEP
 *  - "Bounce": translation, CUBICSPLINE
 * plus a "weights" channel (unsupported → warning) and a second animation
 * ("Unused", skipped with a warning).
 * @returns {Uint8Array} GLB bytes
 */
export function buildAnimatedGlb() {
  const f32 = (a) => new Uint8Array(new Float32Array(a).buffer);
  const ry = (deg) => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];
  const tracks = [
    // [times, values, type]
    [[0, 1, 2], [0, 0, 0, 0, 0, 1, 0, 0, 0], "VEC3"], // Slide: z 0 → 1 → 0
    [[0, 1, 2], [...ry(0), ...ry(120), ...ry(240)], "VEC4"], // Spin: 0° → 120° → 240° about Y
    [[0, 0.5, 1.5, 2], [1, 1, 1, 1.5, 1.5, 1.5, 0.5, 0.5, 0.5, 1, 1, 1], "VEC3"], // Pulse: held scales
    // CUBICSPLINE: (in-tangent, value, out-tangent) per key
    [[0, 1, 2], [
      0, 0, 0, 4.5, 0, 0, 0, 3, 0,
      0, 0, 0, 4.5, 1, 0, 0, 0, 0,
      0, -3, 0, 4.5, 0, 0, 0, 0, 0,
    ], "VEC3"], // Bounce: y 0 → 1 → 0 at x = 4.5
    [[0, 2], [0, 1], "SCALAR"], // weights (unsupported)
  ];
  const extra = [quadrantPng()]; // bufferView 5
  const accessors = [...CUBE_ACCESSORS];
  for (const [times, values, type] of tracks) {
    extra.push(f32(times), f32(values));
    const v = 5 + extra.length - 2; // bufferView index of `times`
    accessors.push(
      { bufferView: v, componentType: 5126, count: times.length, type: "SCALAR", min: [Math.min(...times)], max: [Math.max(...times)] },
      { bufferView: v + 1, componentType: 5126, count: values.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type], type },
    );
  }
  const { bin, views } = cubeBin(extra);
  const node = (name, x) => ({ name, mesh: 0, translation: [x, 0, 0] });
  return packGlb({
    asset: { version: "2.0", generator: "test-animated" },
    scene: 0,
    scenes: [{ nodes: [0, 1, 2, 3] }],
    nodes: [node("Slide", 0), node("Spin", 1.5), node("Pulse", 3), node("Bounce", 4.5)],
    meshes: [{ name: "Cube", primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
    images: [{ bufferView: 5, mimeType: "image/png", name: "quadrants" }],
    textures: [{ source: 0 }],
    materials: [{ name: "Quadrants", pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } }],
    animations: [
      {
        name: "Main",
        samplers: [
          { input: 4, output: 5 },
          { input: 6, output: 7, interpolation: "LINEAR" },
          { input: 8, output: 9, interpolation: "STEP" },
          { input: 10, output: 11, interpolation: "CUBICSPLINE" },
          { input: 12, output: 13 },
        ],
        channels: [
          { sampler: 0, target: { node: 0, path: "translation" } },
          { sampler: 1, target: { node: 1, path: "rotation" } },
          { sampler: 2, target: { node: 2, path: "scale" } },
          { sampler: 3, target: { node: 3, path: "translation" } },
          { sampler: 4, target: { node: 0, path: "weights" } },
        ],
      },
      { name: "Unused", samplers: [{ input: 4, output: 5 }], channels: [{ sampler: 0, target: { node: 1, path: "translation" } }] },
    ],
  }, bin);
}

/**
 * Stage 4: skinning and morph targets.
 *  - "Bar": a 2-unit tall box (3 rings of 4 vertices) skinned to joints Lower / Upper.
 *    skin.joints lists the child first (Upper, Lower) to test parent-first reordering;
 *    the root joint sits under a non-joint "Armature" node with a translation; the
 *    mesh node has its own translation, which glTF ignores for skinned meshes.
 *    It also has a sparse morph target ("Bulge", top ring only), weight 0.5.
 *  - "Bend": Upper rotates about Z (0° → 45° → 0°) and Bulge goes 0 → 1 → 0.
 *  - "Blob": a morph-only cube (target "Grow" = top face up), static weight 0.25.
 * @returns {Uint8Array} GLB bytes
 */
export function buildSkinnedGlb() {
  const f32 = (a) => new Uint8Array(new Float32Array(a).buffer);
  const P = [], J = [], W = [], I = [], BULGE = [];
  for (let ring = 0; ring < 3; ring++) {
    for (const [x, z] of [[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]]) {
      P.push(0.5 + x, ring, z);
      // skin.joints = [Upper, Lower] → Lower is skin joint 1, Upper is skin joint 0
      J.push(...[[1, 0, 0, 0], [1, 0, 0, 0], [0, 0, 0, 0]][ring]);
      W.push(...[[1, 0, 0, 0], [0.5, 0.5, 0, 0], [1, 0, 0, 0]][ring]);
      BULGE.push(...(ring === 2 ? [x * 1.5, 0, z * 1.5] : [0, 0, 0]));
    }
  }
  for (let ring = 0; ring < 2; ring++) {
    for (let k = 0; k < 4; k++) {
      const a = ring * 4 + k, b = ring * 4 + ((k + 1) % 4), c = a + 4, d = b + 4;
      I.push(a, b, d, a, d, c);
    }
  }
  const grow = cubeGeometry().P.map((v, i) => (i % 3 === 1 && v > 0 ? 0.5 : 0)); // top face up
  const deg = (d) => [0, 0, Math.sin((d * Math.PI) / 360), Math.cos((d * Math.PI) / 360)];
  const extra = [
    f32(P), new Uint8Array(J), f32(W), new Uint8Array(new Uint16Array(I).buffer), f32(BULGE), // views 5..9
    // 10: IBMs in skin.joints order: Upper = inverse(T(0.5, 1, 0)), Lower = inverse(T(0.5, 0, 0))
    f32([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.5, -1, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.5, 0, 0, 1]),
    f32([0, 1, 2]), f32([...deg(0), ...deg(45), ...deg(0)]), f32([0, 1, 0]), // 11..13 animation
    f32(grow), // 14 Grow target
  ];
  const { bin, views } = cubeBin(extra);
  const acc = (bufferView, componentType, count, type, more = {}) => ({ bufferView, componentType, count, type, ...more });
  return packGlb({
    asset: { version: "2.0", generator: "test-skinned" },
    scene: 0,
    scenes: [{ nodes: [0, 3, 4] }],
    nodes: [
      { name: "Armature", translation: [0.5, 0, 0], children: [1] }, // 0 (non-joint ancestor)
      { name: "Lower", children: [2] }, // 1
      { name: "Upper", translation: [0, 1, 0] }, // 2
      { name: "BarNode", mesh: 0, skin: 0, translation: [5, 0, 0] }, // 3 (translation ignored by skinning)
      { name: "Blob", mesh: 1, translation: [3, 0, 0], weights: [0.25] }, // 4
    ],
    meshes: [
      {
        name: "Bar",
        weights: [0.5],
        extras: { targetNames: ["Bulge"] },
        primitives: [{ attributes: { POSITION: 4, JOINTS_0: 5, WEIGHTS_0: 6 }, indices: 7, targets: [{ POSITION: 8 }] }],
      },
      {
        name: "BlobMesh",
        extras: { targetNames: ["Grow"] },
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 3, targets: [{ POSITION: 13 }] }],
      },
    ],
    skins: [{ name: "Rig", joints: [2, 1], inverseBindMatrices: 9, skeleton: 1 }],
    accessors: [
      ...CUBE_ACCESSORS, // 0..3
      acc(5, 5126, 12, "VEC3", { min: [0.3, 0, -0.2], max: [0.7, 2, 0.2] }), // 4 Bar POSITION
      acc(6, 5121, 12, "VEC4"), // 5 JOINTS_0
      acc(7, 5126, 12, "VEC4"), // 6 WEIGHTS_0
      acc(8, 5123, 48, "SCALAR"), // 7 indices
      acc(9, 5126, 12, "VEC3", { min: [-0.3, 0, -0.3], max: [0.3, 0, 0.3] }), // 8 Bulge
      acc(10, 5126, 2, "MAT4"), // 9 IBMs
      acc(11, 5126, 3, "SCALAR", { min: [0], max: [2] }), // 10 times
      acc(12, 5126, 3, "VEC4"), // 11 rotations
      acc(13, 5126, 3, "SCALAR"), // 12 weights
      acc(14, 5126, 24, "VEC3", { min: [0, 0, 0], max: [0, 0.5, 0] }), // 13 Grow
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
    animations: [{
      name: "Bend",
      samplers: [{ input: 10, output: 11 }, { input: 10, output: 12 }],
      channels: [
        { sampler: 0, target: { node: 2, path: "rotation" } },
        { sampler: 1, target: { node: 3, path: "weights" } },
      ],
    }],
  }, bin);
}

const CUBE_ACCESSORS = [
  { bufferView: 0, componentType: 5126, count: 24, type: "VEC3", min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
  { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
  { bufferView: 2, componentType: 5126, count: 24, type: "VEC2" },
  { bufferView: 3, componentType: 5123, count: 36, type: "SCALAR" },
];

/** 16x16: red | green on top, blue | yellow at the bottom. */
function quadrantPng() {
  const colors = [[230, 40, 40, 255], [40, 180, 60, 255], [40, 80, 230, 255], [240, 210, 40, 255]];
  return encodePng(16, 16, (x, y) => colors[(y < 8 ? 0 : 2) + (x < 8 ? 0 : 1)]);
}

function cubeUvs() {
  return cubeGeometry().UV;
}

function cubeGeometry() {
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
  return { P, N, UV, I };
}

/** Cube positions / normals / uvs / indices + a 1x1 PNG as bufferViews 0..4, then `extra`. */
function cubeBin(extra = []) {
  const png = base64ToBytes(PNG_BASE64);
  const { P, N, UV, I } = cubeGeometry();
  const parts = [
    new Uint8Array(new Float32Array(P).buffer),
    new Uint8Array(new Float32Array(N).buffer),
    new Uint8Array(new Float32Array(UV).buffer),
    new Uint8Array(new Uint16Array(I).buffer),
    png,
    ...extra,
  ];
  // Each bufferView has its exact length; padding to 4 bytes sits between views.
  let off = 0;
  const views = [];
  const padded = [];
  for (const p of parts) {
    views.push({ buffer: 0, byteOffset: off, byteLength: p.length });
    padded.push(pad4(p));
    off += padded[padded.length - 1].length;
  }
  return { bin: concat(padded), views };
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
