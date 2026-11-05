// KHR_draco_mesh_compression: src/draco.js against draco3d's output (test/draco-vectors.js),
// corrupted streams, and the glTF side (accessors filled from Draco data, type conversion,
// validation). Runs in Node and browsers.
import { decodeDracoMesh, DracoError } from "../src/draco.js";
import { crc32 } from "../src/usdz.js";
import { GltfAsset, parseGltf } from "../src/glb.js";
import { glbToUsda, GltfValidationError } from "../src/index.js";
import { VECTORS } from "./draco-vectors.js";

let failures = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); failures++; } };
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesOf = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const throws = (fn, Type, re) => {
  try {
    fn();
  } catch (e) {
    return e instanceof Type && (!re || re.test(e.message)) ? null : `${e.name}: ${e.message}`;
  }
  return "no error";
};

// ---- byte-identical to draco3d -----------------------------------------------------------
for (const v of VECTORS) {
  const mesh = decodeDracoMesh(fromBase64(v.encoded));
  assert(mesh.numPoints === v.numPoints, `${v.name}: ${mesh.numPoints} points, expected ${v.numPoints}`);
  assert(mesh.indices.length === v.numIndices && crc32(bytesOf(mesh.indices)) === v.indicesCrc32, `${v.name}: indices differ from draco3d`);
  assert(mesh.attributes.length === v.attributes.length, `${v.name}: ${mesh.attributes.length} attributes, expected ${v.attributes.length}`);
  v.attributes.forEach((want, i) => {
    const got = mesh.attributes[i];
    if (!got) return;
    for (const k of ["uniqueId", "type", "dataType", "numComponents", "normalized"]) {
      assert(got[k] === want[k], `${v.name}: attribute ${i} ${k} is ${got[k]}, expected ${want[k]}`);
    }
    const first = Array.from(got.values.subarray(0, 6));
    assert(crc32(bytesOf(got.values)) === want.crc32, `${v.name}: attribute ${i} values differ from draco3d (first ${first} vs ${want.first})`);
  });
}

// ---- corrupted streams fail with DracoError (never another exception, never a hang) -------
{
  let seed = 12345;
  const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const unexpected = new Set();
  const attempt = (bytes) => {
    try {
      decodeDracoMesh(bytes, { maxValues: 1 << 20 });
    } catch (e) {
      if (!(e instanceof DracoError)) unexpected.add(`${e.name}: ${e.message}`);
    }
  };
  for (const v of VECTORS) {
    const bytes = fromBase64(v.encoded);
    for (let cut = 0; cut < bytes.length; cut++) attempt(bytes.subarray(0, cut));
    for (let t = 0; t < 300; t++) {
      const b = bytes.slice();
      for (let k = 0; k < 1 + Math.floor(random() * 3); k++) b[11 + Math.floor(random() * (b.length - 11))] ^= 1 << Math.floor(random() * 8);
      attempt(b);
    }
  }
  assert(unexpected.size === 0, `corrupted Draco data raised non-Draco errors: ${[...unexpected].slice(0, 3).join(" | ")}`);
  const big = fromBase64(VECTORS[1].encoded);
  assert(throws(() => decodeDracoMesh(big, { maxValues: 10 }), DracoError, /limit/) === null, "maxValues bounds the decoded size");
  const header = fromBase64(VECTORS[0].encoded);
  header[6] = 1; // bitstream 2.1
  assert(throws(() => decodeDracoMesh(header), DracoError, /2\.1 is not supported/) === null, "only bitstream 2.2 is accepted");
}

// ---- glTF: accessors filled from Draco data ---------------------------------------------
/** A glTF document whose one primitive is the Draco vector `v` (accessors without bufferViews). */
function dracoDoc(v, semantics, { indices = 5125, fallback = null } = {}) {
  const bytes = fromBase64(v.encoded);
  const dracoAttributes = {};
  const attributes = {};
  const accessors = [];
  for (const [name, { id, componentType, type, normalized }] of Object.entries(semantics)) {
    dracoAttributes[name] = id;
    attributes[name] = accessors.length;
    accessors.push({ componentType, count: v.numPoints, type, ...(normalized ? { normalized } : {}) });
  }
  const primitive = { attributes, extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: dracoAttributes } } };
  if (indices) {
    primitive.indices = accessors.length;
    accessors.push({ componentType: indices, count: v.numIndices, type: "SCALAR" });
  }
  const buffers = [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${v.encoded}` }];
  const bufferViews = [{ buffer: 0, byteLength: bytes.length }];
  if (fallback) {
    buffers.push({ byteLength: fallback.length, uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...fallback))}` });
    bufferViews.push({ buffer: 1, byteLength: fallback.length });
    accessors[0].bufferView = 1;
  }
  return {
    asset: { version: "2.0" },
    extensionsUsed: ["KHR_draco_mesh_compression"],
    ...(fallback ? {} : { extensionsRequired: ["KHR_draco_mesh_compression"] }),
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Draco", mesh: 0 }],
    meshes: [{ name: "Draco", primitives: [primitive] }],
    accessors,
    bufferViews,
    buffers,
  };
}
const assetOf = (json) => new GltfAsset(parseGltf(new TextEncoder().encode(JSON.stringify(json)).buffer));
const attributeOf = (v, type) => v.attributes.find((a) => a.type === type);

{
  // Positions, normals and texture coordinates (float32): exactly the decoded values.
  const v = VECTORS.find((x) => x.name.includes("portable texture coordinate"));
  const decoded = decodeDracoMesh(fromBase64(v.encoded));
  const id = (type) => attributeOf(v, type).uniqueId;
  const json = dracoDoc(v, {
    POSITION: { id: id(0), componentType: 5126, type: "VEC3" },
    NORMAL: { id: id(1), componentType: 5126, type: "VEC3" },
    TEXCOORD_0: { id: id(3), componentType: 5126, type: "VEC2" },
  });
  const asset = assetOf(json);
  for (const [name, type] of [["POSITION", 0], ["NORMAL", 1], ["TEXCOORD_0", 3]]) {
    const want = decoded.attributes.find((a) => a.type === type).values;
    const got = asset.accessor(json.meshes[0].primitives[0].attributes[name]).data;
    assert(got.length === want.length && got.every((x, i) => x === want[i]), `${name} accessor holds the decoded values`);
  }
  const idx = asset.accessor(json.meshes[0].primitives[0].indices).data;
  assert(idx.length === decoded.indices.length && idx.every((x, i) => x === decoded.indices[i]), "indices accessor holds the decoded indices");

  const warnings = [];
  const usda = glbToUsda(json, { onWarning: (w) => warnings.push(w) }).usda;
  assert(usda.includes("def Mesh") && warnings.length === 0, `Draco primitive converts without warnings: ${warnings}`);
  const faces = usda.match(/int\[\] faceVertexIndices = \[([^\]]*)\]/);
  assert(faces && faces[1].split(",").length === v.numIndices, "every decoded triangle is written");

  // Without an indices accessor the decoded indices are still used (Draco reorders points).
  const noIndices = dracoDoc(v, { POSITION: { id: id(0), componentType: 5126, type: "VEC3" } }, { indices: null });
  const usda2 = glbToUsda(noIndices).usda;
  const faces2 = usda2.match(/int\[\] faceVertexIndices = \[([^\]]*)\]/);
  assert(faces2 && faces2[1] === faces[1], "a Draco primitive without an indices accessor uses the decoded indices");

  // With an uncompressed fallback, the Draco data still wins (the spec says to ignore the
  // accessors' bufferViews); here the fallback holds different positions.
  const fallback = new Uint8Array(new Float32Array(v.numPoints * 3).fill(7).buffer);
  const withFallback = dracoDoc(v, { POSITION: { id: id(0), componentType: 5126, type: "VEC3" } }, { fallback });
  const pos = assetOf(withFallback).accessor(0).data;
  assert(pos[0] === decoded.attributes[0].values[0] && pos[0] !== 7, "Draco data is used even when an uncompressed fallback exists");

  // Validation: counts, ids, attribute names and modes must agree with the Draco data.
  const wrongCount = structuredClone(json);
  wrongCount.accessors[0].count += 1;
  wrongCount.accessors[1].count += 1;
  wrongCount.accessors[2].count += 1;
  assert(throws(() => glbToUsda(wrongCount), GltfValidationError, /KHR_draco_mesh_compression.*values/) === null, "accessor count must match the Draco data");
  const wrongIndexCount = structuredClone(json);
  wrongIndexCount.accessors[3].count -= 3;
  assert(throws(() => glbToUsda(wrongIndexCount), GltfValidationError, /indices/) === null, "indices count must match the Draco data");
  const unknownId = structuredClone(json);
  unknownId.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression.attributes.NORMAL = 99;
  assert(throws(() => glbToUsda(unknownId), GltfValidationError, /no attribute with id 99/) === null, "unknown Draco attribute id");
  const extra = structuredClone(json);
  extra.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression.attributes.COLOR_0 = 0;
  assert(throws(() => glbToUsda(extra), GltfValidationError, /COLOR_0 is not an attribute of the primitive/) === null, "Draco attributes are a subset of the primitive's");
  const lines = structuredClone(json);
  lines.meshes[0].primitives[0].mode = 1;
  lines.accessors[3].count = v.numIndices - (v.numIndices % 2);
  assert(throws(() => glbToUsda(lines), GltfValidationError, /TRIANGLES or TRIANGLE_STRIP/) === null, "Draco primitives are triangles");
  const badView = structuredClone(json);
  badView.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression.bufferView = 5;
  assert(throws(() => glbToUsda(badView), GltfValidationError, /bufferView 5 does not exist/) === null, "Draco bufferView must exist");
  // Decoded indices must fit the accessor's componentType (the vectors are too small to
  // overflow UNSIGNED_BYTE, so a decoded mesh with index 300 stands in).
  const ubyte = { componentType: 5121, count: 3, type: "SCALAR" };
  const fakeMesh = { numPoints: 301, indices: Uint32Array.of(0, 1, 300), attributes: [] };
  assert(throws(() => asset._fillFromDraco(3, ubyte, null, fakeMesh, [0, 0, 0], 1, null), GltfValidationError, /index 300 does not fit/) === null, "decoded indices must fit the accessor componentType");
}

{
  // Colors (normalized uint8), joints (uint16), weights (quantized float) and int16 values:
  // converted to the accessor's componentType like draco3d's GetAttributeDataArrayForAllPoints.
  const v = VECTORS.find((x) => x.name.includes("colors (normalized uint8)"));
  const decoded = decodeDracoMesh(fromBase64(v.encoded));
  const of = (pred) => decoded.attributes.find(pred);
  const color = of((a) => a.type === 2);
  const joints = of((a) => a.dataType === 4);
  const weights = of((a) => a.type === 4 && a.dataType === 9);
  const json = dracoDoc(v, {
    POSITION: { id: of((a) => a.type === 0).uniqueId, componentType: 5126, type: "VEC3" },
    COLOR_0: { id: color.uniqueId, componentType: 5121, type: "VEC4", normalized: true },
    TEXCOORD_0: { id: of((a) => a.type === 3).uniqueId, componentType: 5126, type: "VEC2" },
    JOINTS_0: { id: joints.uniqueId, componentType: 5123, type: "VEC4" },
    WEIGHTS_0: { id: weights.uniqueId, componentType: 5126, type: "VEC4" },
  });
  const asset = assetOf(json);
  const attrs = json.meshes[0].primitives[0].attributes;
  const c = asset.accessor(attrs.COLOR_0).data;
  assert(c.every((x, i) => x === color.values[i] / 255), "normalized UNSIGNED_BYTE colors: decoded bytes / 255");
  const j = asset.accessor(attrs.JOINTS_0).data;
  assert(j.every((x, i) => x === joints.values[i]), "UNSIGNED_SHORT joints: the decoded integers");
  // A FLOAT accessor for normalized uint8 Draco data gets value / 255 in float32 (Draco's conversion).
  json.accessors[attrs.COLOR_0] = { componentType: 5126, count: v.numPoints, type: "VEC4" };
  const cf = assetOf(json).accessor(attrs.COLOR_0).data;
  assert(cf.every((x, i) => x === Math.fround(color.values[i] / 255)), "FLOAT accessor for normalized uint8 Draco colors");
  // Joints as UNSIGNED_BYTE fit (all < 256). Weights are float Draco data without the
  // normalized flag, so an UNSIGNED_BYTE accessor gets them truncated, as from draco3d (and
  // three.js's DRACOLoader); a file like that breaks "accessors must match the Draco data".
  json.accessors[attrs.JOINTS_0] = { componentType: 5121, count: v.numPoints, type: "VEC4" };
  json.accessors[attrs.WEIGHTS_0] = { componentType: 5121, count: v.numPoints, type: "VEC4", normalized: true };
  json.extensionsUsed.push("KHR_mesh_quantization");
  const q = assetOf(json);
  assert(q.accessor(attrs.JOINTS_0).data.every((x, i) => x === joints.values[i]), "UNSIGNED_BYTE joints from uint16 Draco data");
  const w = q.accessor(attrs.WEIGHTS_0).data;
  assert(w.every((x, i) => x === Math.trunc(weights.values[i]) / 255), "UNSIGNED_BYTE weights from float Draco data are truncated like draco3d's");
  const warnings = [];
  delete json.extensionsRequired;
  json.accessors[attrs.JOINTS_0].componentType = 5123;
  json.accessors[attrs.WEIGHTS_0] = { componentType: 5126, count: v.numPoints, type: "VEC4" };
  assert(glbToUsda(json, { onWarning: (x) => warnings.push(x) }).usda.includes("def Mesh"), "Draco mesh with colors, joints and weights converts");
  assert(!warnings.some((x) => /Draco|KHR_draco/.test(x)), `no Draco warnings: ${warnings}`);
}

if (failures) {
  console.error(`${failures} Draco test(s) failed`);
  if (typeof process !== "undefined") process.exit(1);
} else {
  console.log(`Draco tests passed (${VECTORS.length} vectors)`);
}
