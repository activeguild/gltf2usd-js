// Structural validation of glTF input, run before any data is read.
//
// Policy: references and byte ranges that the converter dereferences to read data or
// to walk the scene (buffers, bufferViews, accessors, meshes, nodes, skins, animations)
// must be valid, or GltfValidationError is thrown with the offending index. Nothing is
// silently clamped or zero-filled. References to optional appearance data (materials,
// textures, images, lights, variants) keep the converter's existing behaviour: the
// reference is ignored and reported through options.onWarning.
//
// Spec: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html

/** Thrown for input that is not valid glTF 2.0 (or exceeds options.limits). */
export class GltfValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "GltfValidationError";
  }
}

/**
 * Default resource limits. They only guard against inputs that would exhaust memory or
 * the call stack; every Khronos sample model and typical AR asset is far below them.
 * Override any of them with options.limits (Infinity disables a limit).
 */
export const DEFAULT_LIMITS = Object.freeze({
  // GLB totalLength is a uint32, and browsers cap ArrayBuffers around 2 GiB.
  maxInputBytes: 2 ** 31,
  // Values decoded from one accessor (count × components). Decoded values are JS
  // numbers (8 bytes), so 2^26 is ~512 MiB, e.g. 22M triangles of indices.
  maxAccessorValues: 2 ** 26,
  // Array lengths in the JSON. These only bound pathological files.
  maxBuffers: 65536,
  maxBufferViews: 1_000_000,
  maxAccessors: 1_000_000,
  maxMeshes: 1_000_000,
  maxNodes: 1_000_000,
  // Scene graph depth: the converter walks nodes recursively.
  maxNodeDepth: 1024,
});

export function resolveLimits(limits) {
  const out = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(limits || {})) {
    if (!(k in DEFAULT_LIMITS)) throw new Error(`Unknown limit "${k}"`);
    if (typeof v !== "number" || !(v >= 0)) throw new Error(`Limit "${k}" must be a non-negative number`);
    out[k] = v;
  }
  return out;
}

export const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
export const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const MATRIX_ROWS = { MAT2: 2, MAT3: 3, MAT4: 4 };
const SPARSE_INDEX_TYPES = new Set([5121, 5123, 5125]);

/**
 * Byte layout of one accessor element: total size and the byte offset of each component
 * (column-major for matrices). glTF aligns every matrix column to 4 bytes, so MAT2 /
 * MAT3 with 1- or 2-byte components have padding (e.g. MAT3 SHORT: 3 × 2 bytes per
 * column, padded to 8, element size 24).
 * @returns {{ size: number, offsets: number[] }}
 */
export function elementLayout(componentType, type) {
  const cs = COMPONENT_SIZE[componentType];
  const n = TYPE_COUNT[type];
  const rows = MATRIX_ROWS[type];
  if (!rows) return { size: cs * n, offsets: Array.from({ length: n }, (_, c) => c * cs) };
  const column = Math.ceil((rows * cs) / 4) * 4;
  const offsets = [];
  for (let col = 0; col < rows; col++) for (let r = 0; r < rows; r++) offsets.push(col * column + r * cs);
  return { size: column * rows, offsets };
}

const isIndex = (v) => Number.isInteger(v) && v >= 0;

/**
 * Validate a glTF JSON document (structure, references, byte ranges against the
 * declared buffer sizes). GltfAsset checks the actual buffer data against byteLength.
 */
export function validateDocument(json, limits) {
  const fail = (msg) => { throw new GltfValidationError(msg); };
  if (!json || typeof json !== "object" || Array.isArray(json)) fail("glTF JSON must be an object");
  const version = json.asset?.version;
  if (typeof version !== "string") fail("glTF asset.version is missing");
  if (!/^2\.\d+$/.test(version)) fail(`Unsupported glTF version "${version}" (expected 2.x)`);

  const arr = (name, limit) => {
    const v = json[name];
    if (v === undefined) return [];
    if (!Array.isArray(v)) fail(`glTF ${name} must be an array`);
    if (limit !== undefined && v.length > limits[limit]) {
      fail(`glTF has ${v.length} ${name}, more than limits.${limit} (${limits[limit]})`);
    }
    return v;
  };
  const buffers = arr("buffers", "maxBuffers");
  const bufferViews = arr("bufferViews", "maxBufferViews");
  const accessors = arr("accessors", "maxAccessors");
  const meshes = arr("meshes", "maxMeshes");
  const nodes = arr("nodes", "maxNodes");
  const skins = arr("skins");
  const animations = arr("animations");
  const scenes = arr("scenes");

  const ref = (value, list, what, where) => {
    if (!isIndex(value) || value >= list.length) fail(`${where}: ${what} ${JSON.stringify(value)} does not exist`);
    return list[value];
  };
  const nonNegInt = (value, what, where) => {
    if (value !== undefined && !isIndex(value)) fail(`${where}: ${what} must be a non-negative integer (got ${JSON.stringify(value)})`);
    return value ?? 0;
  };

  // Buffers
  buffers.forEach((b, i) => {
    const where = `buffer ${i}`;
    if (!isIndex(b?.byteLength)) fail(`${where}: byteLength must be a non-negative integer`);
  });

  // Buffer views
  bufferViews.forEach((bv, i) => {
    const where = `bufferView ${i}`;
    const buffer = ref(bv?.buffer, buffers, "buffer", where);
    const offset = nonNegInt(bv.byteOffset, "byteOffset", where);
    if (!isIndex(bv.byteLength)) fail(`${where}: byteLength must be a non-negative integer`);
    if (offset + bv.byteLength > buffer.byteLength) {
      fail(`Invalid bufferView range: ${where} spans bytes ${offset}..${offset + bv.byteLength} of buffer ${bv.buffer} (${buffer.byteLength} bytes)`);
    }
    if (bv.byteStride !== undefined && !(Number.isInteger(bv.byteStride) && bv.byteStride >= 4 && bv.byteStride <= 252 && bv.byteStride % 4 === 0)) {
      fail(`${where}: byteStride ${bv.byteStride} is not a multiple of 4 in 4..252`);
    }
    const mo = bv.extensions?.EXT_meshopt_compression;
    if (mo) {
      const src = ref(mo.buffer, buffers, "EXT_meshopt_compression buffer", where);
      const moOffset = nonNegInt(mo.byteOffset, "EXT_meshopt_compression byteOffset", where);
      if (!isIndex(mo.byteLength) || moOffset + mo.byteLength > src.byteLength) {
        fail(`Invalid bufferView range: ${where} EXT_meshopt_compression data exceeds buffer ${mo.buffer}`);
      }
    }
  });

  // Accessors
  accessors.forEach((acc, i) => {
    const where = `accessor ${i}`;
    if (!(acc?.componentType in COMPONENT_SIZE)) fail(`${where}: unsupported componentType ${acc?.componentType}`);
    if (!(acc.type in TYPE_COUNT)) fail(`${where}: unsupported type ${JSON.stringify(acc.type)}`);
    if (!isIndex(acc.count)) fail(`${where}: count must be a non-negative integer`);
    const n = TYPE_COUNT[acc.type];
    if (acc.count * n > limits.maxAccessorValues) {
      fail(`${where}: ${acc.count} × ${n} values exceed limits.maxAccessorValues (${limits.maxAccessorValues})`);
    }
    const layout = elementLayout(acc.componentType, acc.type);
    const offset = nonNegInt(acc.byteOffset, "byteOffset", where);
    if (acc.bufferView !== undefined) {
      const bv = ref(acc.bufferView, bufferViews, "bufferView", where);
      const stride = bv.byteStride ?? layout.size;
      if (stride < layout.size) fail(`${where}: bufferView ${acc.bufferView} byteStride ${stride} is smaller than the element size ${layout.size}`);
      const end = acc.count ? offset + (acc.count - 1) * stride + layout.size : offset;
      if (end > bv.byteLength) {
        fail(`Accessor exceeds bufferView bounds: ${where} needs ${end} bytes, bufferView ${acc.bufferView} has ${bv.byteLength}`);
      }
    } else if (offset) {
      fail(`${where}: byteOffset without a bufferView`);
    }
    if (acc.sparse !== undefined) {
      const s = acc.sparse;
      const sw = `${where} sparse`;
      if (!Number.isInteger(s.count) || s.count < 1 || s.count > acc.count) fail(`Invalid sparse accessor: ${sw} count ${s.count} must be in 1..${acc.count}`);
      if (!SPARSE_INDEX_TYPES.has(s.indices?.componentType)) fail(`Invalid sparse accessor indices: ${sw} componentType ${s.indices?.componentType} must be 5121, 5123 or 5125`);
      const ibv = ref(s.indices.bufferView, bufferViews, "indices bufferView", sw);
      const iEnd = nonNegInt(s.indices.byteOffset, "indices byteOffset", sw) + s.count * COMPONENT_SIZE[s.indices.componentType];
      if (iEnd > ibv.byteLength) fail(`Invalid sparse accessor indices: ${sw} needs ${iEnd} bytes, bufferView ${s.indices.bufferView} has ${ibv.byteLength}`);
      const vbv = ref(s.values?.bufferView, bufferViews, "values bufferView", sw);
      const vEnd = nonNegInt(s.values.byteOffset, "values byteOffset", sw) + s.count * layout.size;
      if (vEnd > vbv.byteLength) fail(`Invalid sparse accessor values: ${sw} needs ${vEnd} bytes, bufferView ${s.values.bufferView} has ${vbv.byteLength}`);
    }
  });

  // Meshes
  meshes.forEach((mesh, mi) => {
    if (!Array.isArray(mesh?.primitives)) fail(`mesh ${mi}: primitives must be an array`);
    mesh.primitives.forEach((p, pi) => {
      const where = `mesh ${mi} primitive ${pi}`;
      for (const [name, a] of Object.entries(p?.attributes || {})) ref(a, accessors, `${name} accessor`, where);
      if (p.indices !== undefined) ref(p.indices, accessors, "indices accessor", where);
      (p.targets || []).forEach((t, ti) => {
        for (const [name, a] of Object.entries(t || {})) ref(a, accessors, `target ${ti} ${name} accessor`, where);
      });
    });
  });

  // Nodes: references, and a forest (one parent per node, no cycles, bounded depth).
  const parentOf = new Map();
  nodes.forEach((node, i) => {
    const where = `node ${i}`;
    if (!node || typeof node !== "object") fail(`${where} must be an object`);
    if (node.mesh !== undefined) ref(node.mesh, meshes, "mesh", where);
    if (node.skin !== undefined) ref(node.skin, skins, "skin", where);
    for (const c of node.children || []) {
      ref(c, nodes, "child node", where);
      if (parentOf.has(c)) fail(`${where}: node ${c} already has parent node ${parentOf.get(c)} (glTF nodes form a forest)`);
      if (c === i) fail(`${where} lists itself as a child`);
      parentOf.set(c, i);
    }
    const inst = node.extensions?.EXT_mesh_gpu_instancing?.attributes;
    for (const [name, a] of Object.entries(inst || {})) ref(a, accessors, `EXT_mesh_gpu_instancing ${name} accessor`, where);
  });
  const depth = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const chain = [];
    let n = i;
    while (n !== undefined && !depth.has(n)) {
      chain.push(n);
      if (chain.length > nodes.length) fail(`node ${i}: the node hierarchy has a cycle`);
      n = parentOf.get(n);
    }
    let d = n === undefined ? 0 : depth.get(n);
    for (let k = chain.length - 1; k >= 0; k--) {
      depth.set(chain[k], ++d);
      if (d > limits.maxNodeDepth) fail(`node ${chain[k]}: hierarchy depth exceeds limits.maxNodeDepth (${limits.maxNodeDepth})`);
    }
  }

  // Scenes
  scenes.forEach((s, si) => (s?.nodes || []).forEach((n) => ref(n, nodes, "node", `scene ${si}`)));
  if (json.scene !== undefined) ref(json.scene, scenes, "scene", "glTF scene");

  // Skins
  skins.forEach((skin, si) => {
    const where = `skin ${si}`;
    if (!Array.isArray(skin?.joints) || !skin.joints.length) fail(`${where}: joints must be a non-empty array`);
    const seen = new Set();
    for (const j of skin.joints) {
      ref(j, nodes, "joint node", where);
      if (seen.has(j)) fail(`${where}: node ${j} is listed twice in joints`);
      seen.add(j);
    }
    if (skin.skeleton !== undefined) ref(skin.skeleton, nodes, "skeleton node", where);
    if (skin.inverseBindMatrices !== undefined) {
      const ibm = ref(skin.inverseBindMatrices, accessors, "inverseBindMatrices accessor", where);
      if (ibm.type !== "MAT4" || ibm.componentType !== 5126) fail(`${where}: inverseBindMatrices must be MAT4 FLOAT`);
      if (ibm.count < skin.joints.length) fail(`${where}: inverseBindMatrices has ${ibm.count} matrices for ${skin.joints.length} joints`);
    }
  });

  // Animations
  animations.forEach((anim, ai) => {
    const where = `animation ${ai}`;
    const samplers = anim?.samplers || [];
    samplers.forEach((s, k) => {
      const input = ref(s?.input, accessors, "input accessor", `${where} sampler ${k}`);
      ref(s.output, accessors, "output accessor", `${where} sampler ${k}`);
      if (input.type !== "SCALAR" || input.componentType !== 5126) fail(`${where} sampler ${k}: input must be SCALAR FLOAT`);
    });
    (anim?.channels || []).forEach((c, k) => {
      ref(c?.sampler, samplers, "sampler", `${where} channel ${k}`);
      if (c.target?.node !== undefined) ref(c.target.node, nodes, "target node", `${where} channel ${k}`);
    });
  });

  // Images stored in bufferViews (read directly when packaging textures).
  arr("images").forEach((img, i) => {
    if (img?.bufferView !== undefined) ref(img.bufferView, bufferViews, "bufferView", `image ${i}`);
  });
}
