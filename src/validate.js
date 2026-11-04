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
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// Set index of TEXCOORD_n / COLOR_n / JOINTS_n / WEIGHTS_n: 0, or 1..999999999 without
// leading zeros (at most 9 digits).
const SET_INDEX = /^(0|[1-9]\d{0,8})$/;
const INDEX_TYPES = new Set([5121, 5123, 5125]);

// Accessor type and component types per attribute semantic (glTF 2.0 § 3.7.2.1).
// "n" = normalized integer, "i" = integer without normalized; FLOAT is always "f".
// KHR_mesh_quantization (when the file declares it) adds the `quantized` forms.
const BYTE = 5120, UBYTE = 5121, SHORT = 5122, USHORT = 5123, FLOAT = 5126;
const ANY_INT = [[BYTE, "n"], [BYTE, "i"], [UBYTE, "n"], [UBYTE, "i"], [SHORT, "n"], [SHORT, "i"], [USHORT, "n"], [USHORT, "i"]];
const ATTRIBUTE_RULES = [
  { re: /^POSITION$/, types: ["VEC3"], core: [[FLOAT, "f"]], quantized: ANY_INT },
  { re: /^NORMAL$/, types: ["VEC3"], core: [[FLOAT, "f"]], quantized: [[BYTE, "n"], [SHORT, "n"]] },
  { re: /^TANGENT$/, types: ["VEC4"], core: [[FLOAT, "f"]], quantized: [[BYTE, "n"], [SHORT, "n"]] },
  { re: /^TEXCOORD_\d+$/, types: ["VEC2"], core: [[FLOAT, "f"], [UBYTE, "n"], [USHORT, "n"]], quantized: ANY_INT },
  { re: /^COLOR_\d+$/, types: ["VEC3", "VEC4"], core: [[FLOAT, "f"], [UBYTE, "n"], [USHORT, "n"]], quantized: [] },
  { re: /^JOINTS_\d+$/, types: ["VEC4"], core: [[UBYTE, "i"], [USHORT, "i"]], quantized: [] },
  { re: /^WEIGHTS_\d+$/, types: ["VEC4"], core: [[FLOAT, "f"], [UBYTE, "n"], [USHORT, "n"]], quantized: [] },
];
// Morph target attributes are displacements (§ 3.7.2.2); TANGENT deltas are VEC3.
const TARGET_RULES = [
  { re: /^POSITION$/, types: ["VEC3"], core: [[FLOAT, "f"]], quantized: [[BYTE, "n"], [BYTE, "i"], [SHORT, "n"], [SHORT, "i"]] },
  { re: /^NORMAL$/, types: ["VEC3"], core: [[FLOAT, "f"]], quantized: [[BYTE, "n"], [SHORT, "n"]] },
  { re: /^TANGENT$/, types: ["VEC3"], core: [[FLOAT, "f"]], quantized: [[BYTE, "n"], [SHORT, "n"]] },
  { re: /^TEXCOORD_\d+$/, types: ["VEC2"], core: [[FLOAT, "f"]], quantized: [[BYTE, "n"], [BYTE, "i"], [UBYTE, "n"], [UBYTE, "i"], [SHORT, "n"], [SHORT, "i"], [USHORT, "n"], [USHORT, "i"]] },
  { re: /^COLOR_\d+$/, types: ["VEC3", "VEC4"], core: [[FLOAT, "f"]], quantized: [[BYTE, "n"], [BYTE, "i"], [UBYTE, "n"], [UBYTE, "i"], [SHORT, "n"], [SHORT, "i"], [USHORT, "n"], [USHORT, "i"]] },
];
// EXT_mesh_gpu_instancing per-instance attributes (the extension's table): TRANSLATION and
// SCALE are FLOAT only, ROTATION FLOAT or normalized BYTE / SHORT. KHR_mesh_quantization
// does not extend these.
const INSTANCE_RULES = [
  { re: /^TRANSLATION$/, types: ["VEC3"], core: [[FLOAT, "f"]], quantized: [] },
  { re: /^ROTATION$/, types: ["VEC4"], core: [[FLOAT, "f"], [BYTE, "n"], [SHORT, "n"]], quantized: [] },
  { re: /^SCALE$/, types: ["VEC3"], core: [[FLOAT, "f"]], quantized: [] },
];
const COMPONENT_NAME = { [BYTE]: "BYTE", [UBYTE]: "UNSIGNED_BYTE", [SHORT]: "SHORT", [USHORT]: "UNSIGNED_SHORT", 5125: "UNSIGNED_INT", [FLOAT]: "FLOAT" };
const formName = ([ct, kind]) => `${kind === "n" ? "normalized " : ""}${COMPONENT_NAME[ct]}`;

/**
 * Check one attribute accessor against its semantic's rules. A name no rule matches is an
 * application-specific attribute (glTF 2.0 § 3.7.2.1): it must start with "_" and must not
 * use UNSIGNED_INT (`custom` = what the standard names are, for the message). With
 * custom = null (morph targets) unknown names are not checked.
 */
function checkAttribute(rules, name, acc, label, quantization, fail, custom = null) {
  const rule = rules.find((r) => r.re.test(name));
  if (!rule) {
    if (custom === null) return;
    const owner = label.slice(0, label.lastIndexOf(`: ${name} (accessor `)); // "mesh 0 primitive 0" etc.
    if (!name.startsWith("_")) fail(`${owner}: attribute "${name}" is not ${custom}; custom attributes must start with "_"`);
    if (acc.componentType === 5125) fail(`${label} is UNSIGNED_INT, which custom attributes must not use`);
    return;
  }
  if (!rule.types.includes(acc.type)) fail(`${label} must be ${rule.types.join(" or ")}, not ${acc.type}`);
  const kind = acc.componentType === FLOAT ? "f" : acc.normalized ? "n" : "i";
  const allowed = quantization ? [...rule.core, ...rule.quantized] : rule.core;
  if (!allowed.some(([ct, k]) => ct === acc.componentType && k === kind)) {
    const extra = !quantization && rule.quantized.some(([ct, k]) => ct === acc.componentType && k === kind) ? " (allowed only with KHR_mesh_quantization)" : "";
    fail(`${label} is ${formName([acc.componentType, kind])}${extra}; allowed: ${allowed.map(formName).join(", ")}`);
  }
}
const MODE_TRIANGLES = 4;
// Top-level arrays whose elements the converter reads as objects.
const OBJECT_ARRAYS = ["accessors", "animations", "buffers", "bufferViews", "cameras", "images", "materials",
  "meshes", "nodes", "samplers", "scenes", "skins", "textures"];

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
  // Every element of the top-level arrays is an object (so property access cannot throw).
  for (const name of OBJECT_ARRAYS) {
    arr(name).forEach((v, i) => { if (!isObject(v)) fail(`glTF ${name}[${i}] must be an object`); });
  }
  /** An optional array property: [] when absent, GltfValidationError when not an array. */
  const list = (owner, key, where) => {
    const v = owner[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) fail(`${where}: ${key} must be an array`);
    return v;
  };
  /** An optional object property: {} when absent, GltfValidationError when not an object. */
  const object = (owner, key, where) => {
    const v = owner[key];
    if (v === undefined) return {};
    if (!isObject(v)) fail(`${where}: ${key} must be an object`);
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
    // normalized is a boolean, and only integer types other than UNSIGNED_INT can be normalized.
    if (acc.normalized !== undefined && typeof acc.normalized !== "boolean") fail(`${where}: normalized must be a boolean (got ${JSON.stringify(acc.normalized)})`);
    if (acc.normalized && (acc.componentType === FLOAT || acc.componentType === 5125)) {
      fail(`${where}: ${COMPONENT_NAME[acc.componentType]} accessors must not be normalized`);
    }
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
      if (!isObject(s)) fail(`Invalid sparse accessor: ${sw} must be an object`);
      if (!isObject(s.indices)) fail(`Invalid sparse accessor indices: ${sw}.indices must be an object`);
      if (!isObject(s.values)) fail(`Invalid sparse accessor values: ${sw}.values must be an object`);
      if (!Number.isInteger(s.count) || s.count < 1 || s.count > acc.count) fail(`Invalid sparse accessor: ${sw} count ${s.count} must be in 1..${acc.count}`);
      if (!SPARSE_INDEX_TYPES.has(s.indices.componentType)) fail(`Invalid sparse accessor indices: ${sw} componentType ${s.indices.componentType} must be 5121, 5123 or 5125`);
      const ibv = ref(s.indices.bufferView, bufferViews, "indices bufferView", sw);
      const iEnd = nonNegInt(s.indices.byteOffset, "indices byteOffset", sw) + s.count * COMPONENT_SIZE[s.indices.componentType];
      if (iEnd > ibv.byteLength) fail(`Invalid sparse accessor indices: ${sw} needs ${iEnd} bytes, bufferView ${s.indices.bufferView} has ${ibv.byteLength}`);
      const vbv = ref(s.values.bufferView, bufferViews, "values bufferView", sw);
      const vEnd = nonNegInt(s.values.byteOffset, "values byteOffset", sw) + s.count * layout.size;
      if (vEnd > vbv.byteLength) fail(`Invalid sparse accessor values: ${sw} needs ${vEnd} bytes, bufferView ${s.values.bufferView} has ${vbv.byteLength}`);
      // Sparse data is tightly packed and not GPU-bound: no byteStride / target, aligned to the component size.
      const sparseView = (part, bv, viewIndex, componentSize) => {
        const label = `Invalid sparse accessor ${part}: ${sw}.${part} bufferView ${viewIndex}`;
        if (bv.byteStride !== undefined) fail(`${label} must not define byteStride`);
        if (bv.target !== undefined) fail(`${label} must not define target`);
        if ((bv.byteOffset ?? 0) % componentSize) fail(`${label} byteOffset ${bv.byteOffset} is not a multiple of ${componentSize}`);
        const own = s[part].byteOffset ?? 0;
        if (own % componentSize) fail(`Invalid sparse accessor ${part}: ${sw}.${part}.byteOffset ${own} is not a multiple of ${componentSize}`);
      };
      sparseView("indices", ibv, s.indices.bufferView, COMPONENT_SIZE[s.indices.componentType]);
      sparseView("values", vbv, s.values.bufferView, COMPONENT_SIZE[acc.componentType]);
    }
  });

  // Meshes: references, attribute types, vertex counts, skin sets, index accessors, triangle counts.
  const quantization = Array.isArray(json.extensionsUsed) && json.extensionsUsed.includes("KHR_mesh_quantization");
  meshes.forEach((mesh, mi) => {
    if (!Array.isArray(mesh.primitives)) fail(`mesh ${mi}: primitives must be an array`);
    mesh.primitives.forEach((p, pi) => {
      const where = `mesh ${mi} primitive ${pi}`;
      if (!isObject(p)) fail(`${where} must be an object`);
      const attributes = object(p, "attributes", where);
      // Indexed semantics (TEXCOORD_n, COLOR_n, JOINTS_n, WEIGHTS_n): a well-formed index, and
      // sets numbered 0, 1, 2, ... without gaps. JOINTS_n / WEIGHTS_n also come in pairs.
      const setsOf = (semantic) => {
        const out = [];
        for (const name of Object.keys(attributes)) {
          if (!name.startsWith(`${semantic}_`)) continue;
          const index = name.slice(semantic.length + 1);
          if (!SET_INDEX.test(index)) fail(`${where}: attribute "${name}" has an invalid set index (0, or 1..999999999 without leading zeros)`);
          out.push(Number(index));
        }
        return out.sort((a, b) => a - b);
      };
      const requireContiguous = (sets, missing) => sets.forEach((n, k) => {
        if (n !== k) fail(`${where}: ${missing(k)} (sets must be numbered from 0 without gaps; found ${sets.map((x) => `_${x}`).join(", ")})`);
      });
      requireContiguous(setsOf("TEXCOORD"), (k) => `TEXCOORD_${k} is missing`);
      requireContiguous(setsOf("COLOR"), (k) => `COLOR_${k} is missing`);
      const joints = setsOf("JOINTS"), weights = setsOf("WEIGHTS");
      for (const n of joints) if (!weights.includes(n)) fail(`${where}: JOINTS_${n} has no matching WEIGHTS_${n}`);
      for (const n of weights) if (!joints.includes(n)) fail(`${where}: WEIGHTS_${n} has no matching JOINTS_${n}`);
      requireContiguous(joints, (k) => `JOINTS_${k} / WEIGHTS_${k} are missing`);
      for (const [name, a] of Object.entries(attributes)) {
        ref(a, accessors, `${name} accessor`, where);
        checkAttribute(ATTRIBUTE_RULES, name, accessors[a], `${where}: ${name} (accessor ${a})`, quantization, fail, "a glTF attribute semantic");
      }
      // POSITION is what the converter draws; without it there is no geometry to convert.
      if (attributes.POSITION === undefined) fail(`${where}: has no POSITION attribute`);
      const mode = p.mode ?? MODE_TRIANGLES;
      if (!(Number.isInteger(mode) && mode >= 0 && mode <= 6)) fail(`${where}: mode ${JSON.stringify(p.mode)} is not a glTF primitive mode (0..6)`);
      // Every attribute, standard or custom, has one element per vertex (POSITION's count; § 3.7.2.1).
      const position = attributes.POSITION !== undefined ? accessors[attributes.POSITION] : null;
      const vertexCount = position?.count;
      if (position) {
        for (const [name, a] of Object.entries(attributes)) {
          if (accessors[a].count !== vertexCount) {
            fail(`${where}: ${name} (accessor ${a}) has ${accessors[a].count} elements, POSITION (accessor ${attributes.POSITION}) has ${vertexCount}`);
          }
        }
      }
      if (p.indices !== undefined) {
        const idx = ref(p.indices, accessors, "indices accessor", where);
        const label = `${where}: indices (accessor ${p.indices})`;
        if (idx.type !== "SCALAR") fail(`${label} must be SCALAR, not ${idx.type}`);
        if (!INDEX_TYPES.has(idx.componentType)) fail(`${label} componentType ${idx.componentType} must be 5121, 5123 or 5125`);
        if (idx.normalized) fail(`${label} must not be normalized`);
        if (mode === MODE_TRIANGLES && idx.count % 3) fail(`${label} has ${idx.count} indices, not a multiple of 3 (TRIANGLES)`);
      } else if (mode === MODE_TRIANGLES && position && vertexCount % 3) {
        fail(`${where}: ${vertexCount} vertices without indices, not a multiple of 3 (TRIANGLES)`);
      }
      list(p, "targets", where).forEach((t, ti) => {
        if (!isObject(t)) fail(`${where} target ${ti} must be an object`);
        for (const [name, a] of Object.entries(t)) {
          ref(a, accessors, `target ${ti} ${name} accessor`, where);
          checkAttribute(TARGET_RULES, name, accessors[a], `${where} target ${ti}: ${name} (accessor ${a})`, quantization, fail);
          if (position && accessors[a].count !== vertexCount) {
            fail(`${where} target ${ti}: ${name} (accessor ${a}) has ${accessors[a].count} elements, POSITION has ${vertexCount}`);
          }
        }
      });
    });
  });

  // Nodes: references, and a forest (one parent per node, no cycles, bounded depth).
  const instanceUse = new Set(); // EXT_mesh_gpu_instancing accessors (alignment below)
  const parentOf = new Map();
  nodes.forEach((node, i) => {
    const where = `node ${i}`;
    if (!node || typeof node !== "object") fail(`${where} must be an object`);
    if (node.mesh !== undefined) ref(node.mesh, meshes, "mesh", where);
    if (node.skin !== undefined) {
      ref(node.skin, skins, "skin", where);
      if (node.mesh === undefined) fail(`${where}: has a skin but no mesh`);
    }
    for (const c of list(node, "children", where)) {
      ref(c, nodes, "child node", where);
      if (parentOf.has(c)) fail(`${where}: node ${c} already has parent node ${parentOf.get(c)} (glTF nodes form a forest)`);
      if (c === i) fail(`${where} lists itself as a child`);
      parentOf.set(c, i);
    }
    // EXT_mesh_gpu_instancing: objects all the way down, valid accessors of the right type,
    // one count for every attribute (the converter draws exactly that many instances).
    const extensions = object(node, "extensions", where);
    if (extensions.EXT_mesh_gpu_instancing !== undefined) {
      const ext = object(extensions, "EXT_mesh_gpu_instancing", `${where} extensions`);
      const iw = `${where} EXT_mesh_gpu_instancing`;
      // The extension instances the node's mesh, so the node must have one (its index is checked above).
      if (node.mesh === undefined) fail(`${iw}: the node has no mesh to instance`);
      if (ext.attributes === undefined) fail(`${iw}: attributes is required`);
      const attrs = object(ext, "attributes", iw);
      if (!Object.keys(attrs).length) fail(`${iw}: attributes must have at least one attribute`);
      let instances, first;
      for (const [name, a] of Object.entries(attrs)) {
        ref(a, accessors, `${name} accessor`, iw);
        const label = `${iw}: ${name} (accessor ${a})`;
        checkAttribute(INSTANCE_RULES, name, accessors[a], label, quantization, fail, "TRANSLATION / ROTATION / SCALE");
        instanceUse.add(a);
        if (instances === undefined) { instances = accessors[a].count; first = name; }
        if (accessors[a].count !== instances) fail(`${iw}: ${name} (accessor ${a}) has ${accessors[a].count} instances, ${first} has ${instances} (all attributes must have the same count)`);
      }
    }
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
  scenes.forEach((s, si) => list(s, "nodes", `scene ${si}`).forEach((n) => ref(n, nodes, "node", `scene ${si}`)));
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
    const samplers = list(anim, "samplers", where);
    samplers.forEach((s, k) => {
      if (!isObject(s)) fail(`${where} sampler ${k} must be an object`);
      const input = ref(s.input, accessors, "input accessor", `${where} sampler ${k}`);
      ref(s.output, accessors, "output accessor", `${where} sampler ${k}`);
      if (input.type !== "SCALAR" || input.componentType !== 5126) fail(`${where} sampler ${k}: input must be SCALAR FLOAT`);
    });
    list(anim, "channels", where).forEach((c, k) => {
      if (!isObject(c)) fail(`${where} channel ${k} must be an object`);
      ref(c.sampler, samplers, "sampler", `${where} channel ${k}`);
      const target = object(c, "target", `${where} channel ${k}`);
      if (target.node !== undefined) ref(target.node, nodes, "target node", `${where} channel ${k}`);
    });
  });

  // Accessor alignment (glTF 2.0 § 3.6.2.4 / § 3.7.2.1), by what the accessor is used for.
  // Vertex attributes: byteOffset a multiple of 4 (byteStride is already checked above).
  // Non-vertex data (indices, inverse bind matrices, animation samplers): tightly packed,
  // so the bufferView must not define byteStride.
  const vertexUse = new Set();
  const otherUse = new Map();
  for (const mesh of meshes) {
    for (const p of mesh.primitives) {
      for (const a of Object.values(p.attributes || {})) vertexUse.add(a);
      for (const t of p.targets || []) for (const a of Object.values(t)) vertexUse.add(a);
      if (p.indices !== undefined) otherUse.set(p.indices, "indices");
    }
  }
  for (const skin of skins) if (skin.inverseBindMatrices !== undefined) otherUse.set(skin.inverseBindMatrices, "inverseBindMatrices");
  for (const anim of animations) {
    for (const smp of anim.samplers || []) {
      otherUse.set(smp.input, "animation input");
      otherUse.set(smp.output, "animation output");
    }
  }
  accessors.forEach((acc, i) => {
    if (acc.bufferView === undefined) return;
    const bv = bufferViews[acc.bufferView];
    const cs = COMPONENT_SIZE[acc.componentType];
    const own = acc.byteOffset ?? 0;
    const where = `Accessor alignment: accessor ${i}`;
    if (own % cs) fail(`${where} byteOffset ${own} is not a multiple of its component size ${cs}`);
    if (((bv.byteOffset ?? 0) + own) % cs) {
      fail(`${where}: bufferView ${acc.bufferView} byteOffset ${bv.byteOffset ?? 0} + accessor byteOffset ${own} is not a multiple of its component size ${cs}`);
    }
    if (vertexUse.has(i) && own % 4) fail(`${where} is a vertex attribute; its byteOffset ${own} must be a multiple of 4`);
    // Per-instance attributes are attribute-like data (every allowed type is ≥ 4 bytes per
    // element): 4-byte aligned like vertex attributes; a strided bufferView is allowed.
    if (instanceUse.has(i) && own % 4) fail(`${where} is an EXT_mesh_gpu_instancing attribute; its byteOffset ${own} must be a multiple of 4`);
    if (otherUse.has(i) && !vertexUse.has(i) && bv.byteStride !== undefined) {
      fail(`${where} (${otherUse.get(i)}) uses bufferView ${acc.bufferView}, which defines byteStride; only vertex attributes may use a strided bufferView`);
    }
  });

  // Images stored in bufferViews (read directly when packaging textures).
  arr("images").forEach((img, i) => {
    if (img.bufferView !== undefined) ref(img.bufferView, bufferViews, "bufferView", `image ${i}`);
  });
}
