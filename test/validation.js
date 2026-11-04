// GLB / glTF input validation (src/validate.js, parseGLB): invalid input throws
// GltfValidationError with a message naming the problem; valid edge cases still convert.
import { glbToUsda, GltfValidationError, DEFAULT_LIMITS } from "../src/index.js";
import { makeGlb, triangleDoc, clone } from "./gltf-builder.js";

let failures = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); failures++; } };

/** Expect conversion to throw GltfValidationError whose message matches `pattern`. */
function rejects(input, pattern, label, options = {}) {
  try {
    glbToUsda(input, options);
  } catch (e) {
    assert(e instanceof GltfValidationError, `${label}: expected GltfValidationError, got ${e.name}: ${e.message}`);
    assert(pattern.test(e.message), `${label}: message "${e.message}" does not match ${pattern}`);
    return;
  }
  assert(false, `${label}: expected an error`);
}
const accepts = (input, label, options = {}) => {
  try {
    return glbToUsda(input, options).usda;
  } catch (e) {
    assert(false, `${label}: unexpected ${e.name}: ${e.message}`);
    return "";
  }
};

const { json, bin } = triangleDoc();
const good = makeGlb(json, bin);
assert(accepts(good, "valid triangle GLB").includes('def Mesh "Tri"'), "valid triangle converts");

// ---- GLB header ----
const patch = (bytes, fn) => { const b = bytes.slice(); fn(new DataView(b.buffer)); return b; };
rejects(good.slice(0, 8), /shorter than its 12-byte header|neither a GLB/, "truncated header");
rejects(patch(good, (dv) => dv.setUint32(4, 1, true)), /Unsupported GLB version 1/, "GLB version 1");
rejects(patch(good, (dv) => dv.setUint32(8, good.length + 4, true)), /totalLength does not match input size/, "totalLength too large");
rejects(patch(good, (dv) => dv.setUint32(8, good.length - 4, true)), /totalLength does not match input size/, "totalLength too small");
{
  const longer = new Uint8Array(good.length + 4); longer.set(good);
  rejects(longer, /totalLength does not match input size/, "trailing bytes after the GLB");
}
// Magic: a GLB whose magic is wrong is not recognised as GLB, so it is parsed as JSON text.
rejects(patch(good, (dv) => dv.setUint32(0, 0x12345678, true)), /neither a GLB nor glTF JSON/, "bad magic");
{
  // parseGLB itself reports the magic.
  const { parseGLB } = await import("../src/glb.js");
  try { parseGLB(patch(good, (dv) => dv.setUint32(0, 0x12345678, true)).buffer); assert(false, "parseGLB bad magic"); }
  catch (e) { assert(/Invalid GLB magic/.test(e.message), `parseGLB magic message: ${e.message}`); }
}

// ---- Chunks ----
const jsonLen = new DataView(good.buffer).getUint32(12, true);
rejects(patch(good, (dv) => dv.setUint32(12, jsonLen + 4000, true)), /GLB chunk exceeds input bounds/, "JSON chunk longer than input");
rejects(patch(good, (dv) => dv.setUint32(12, jsonLen - 2, true)), /not a multiple of 4|chunk exceeds|header is truncated/, "JSON chunk length not aligned");
rejects(patch(good, (dv) => dv.setUint32(16, 0x004e4942, true)), /JSON chunk must be the first chunk/, "first chunk is BIN");
{
  // Header cut right after the JSON chunk with 4 stray bytes: chunk header truncated.
  const g = makeGlb(json, null);
  const extra = new Uint8Array(g.length + 4); extra.set(g);
  new DataView(extra.buffer).setUint32(8, extra.length, true);
  rejects(extra, /chunk 1 header is truncated/, "truncated chunk header");
}
rejects(makeGlb(json, bin, { extraChunks: [{ type: 0x004e4942, data: bin }] }), /more than one BIN chunk/, "two BIN chunks");
rejects(makeGlb(json, bin, { extraChunks: [{ type: 0x4e4f534a, data: new TextEncoder().encode("{}  ") }] }), /more than one JSON chunk/, "two JSON chunks");
{
  // BIN after an unknown chunk is not the second chunk.
  const g = makeGlb(json, null, { extraChunks: [{ type: 0x12345678, data: new Uint8Array(4) }, { type: 0x004e4942, data: bin }] });
  rejects(g, /BIN chunk must be the second chunk/, "BIN as third chunk");
}
// Unknown chunk types after BIN are skipped.
assert(accepts(makeGlb(json, bin, { extraChunks: [{ type: 0x54534554, data: new Uint8Array(8) }] }), "unknown chunk").includes("def Mesh"), "unknown chunk type is skipped");
{
  const g = patch(good, () => {});
  g[20] = 0x7b; g[21] = 0x7b; // "{{" → not JSON
  rejects(g, /JSON chunk is not valid JSON/, "invalid JSON chunk");
}
rejects(makeGlb(json, bin.slice(0, 20)), /GLB BIN chunk is 20 bytes, but buffer 0 byteLength is 44/, "BIN chunk shorter than buffer.byteLength");

// ---- Document ----
const withJson = (fn) => { const j = clone(json); fn(j); return makeGlb(j, bin); };
rejects(withJson((j) => { j.asset.version = "1.0"; }), /Unsupported glTF version "1.0"/, "glTF 1.0");
rejects(withJson((j) => { delete j.asset; }), /asset.version is missing/, "no asset");
rejects('{"asset": {"version": "2.0"}', /not valid JSON/, "broken JSON text");

// ---- Buffers / bufferViews ----
rejects(withJson((j) => { j.bufferViews[0].buffer = 3; }), /bufferView 0: buffer 3 does not exist/, "bufferView.buffer out of range");
rejects(withJson((j) => { j.bufferViews[0].byteOffset = -4; }), /byteOffset must be a non-negative integer/, "negative bufferView.byteOffset");
rejects(withJson((j) => { j.bufferViews[1].byteLength = 100; }), /Invalid bufferView range/, "bufferView past buffer end");
rejects(withJson((j) => { j.bufferViews[0].byteStride = 6; }), /byteStride 6 is not a multiple of 4/, "byteStride not multiple of 4");
rejects(withJson((j) => { j.bufferViews[0].byteStride = 256; }), /byteStride 256/, "byteStride above 252");
rejects(withJson((j) => { j.bufferViews[0].byteStride = 8; }), /byteStride 8 is smaller than the element size 12/, "byteStride smaller than VEC3 FLOAT");
rejects(withJson((j) => { j.buffers[0].byteLength = -1; }), /buffer 0: byteLength/, "negative buffer.byteLength");

// ---- Accessors ----
rejects(withJson((j) => { j.accessors[0].bufferView = 9; }), /accessor 0: bufferView 9 does not exist/, "accessor.bufferView out of range");
rejects(withJson((j) => { j.accessors[0].componentType = 5124; }), /unsupported componentType 5124/, "INT componentType");
rejects(withJson((j) => { j.accessors[0].type = "VEC5"; }), /unsupported type "VEC5"/, "unknown type");
rejects(withJson((j) => { j.accessors[0].count = -1; }), /count must be a non-negative integer/, "negative count");
rejects(withJson((j) => { j.accessors[0].count = 4; }), /Accessor exceeds bufferView bounds: accessor 0 needs 48 bytes, bufferView 0 has 36/, "count past bufferView");
rejects(withJson((j) => { j.accessors[0].byteOffset = 4; }), /Accessor exceeds bufferView bounds/, "byteOffset pushes past bufferView");
rejects(withJson((j) => { j.accessors[0].byteOffset = 1.5; }), /byteOffset must be a non-negative integer/, "fractional accessor.byteOffset");
rejects(withJson((j) => { j.meshes[0].primitives[0].attributes.NORMAL = 7; }), /mesh 0 primitive 0: NORMAL accessor 7 does not exist/, "attribute accessor missing");
rejects(withJson((j) => { j.meshes[0].primitives[0].indices = 2; }), /indices accessor 2 does not exist/, "indices accessor missing");
// Accessors without a bufferView are zeros (valid).
{
  const j = clone(json);
  j.accessors.push({ componentType: 5126, count: 3, type: "VEC3" });
  j.meshes[0].primitives[0].attributes.NORMAL = 2;
  assert(accepts(makeGlb(j, bin), "accessor without bufferView").includes("normal3f[] normals = [(0, 0, 0), (0, 0, 0), (0, 0, 0)]"), "accessor without bufferView decodes to zeros");
}

// ---- Sparse ----
{
  // POSITION = zeros + sparse: vertex 2 → (0, 1, 0), vertex 1 → (1, 0, 0).
  const base = clone(json);
  base.accessors[0] = {
    componentType: 5126, count: 3, type: "VEC3",
    sparse: { count: 2, indices: { bufferView: 1, componentType: 5123 }, values: { bufferView: 0, byteOffset: 12 } },
  };
  // bufferView 1 holds indices [0, 1, 2]: use the first two as sparse indices → rewrite them.
  const b = bin.slice();
  new DataView(b.buffer).setUint16(36, 1, true);
  new DataView(b.buffer).setUint16(38, 2, true);
  const usda = accepts(makeGlb(base, b), "sparse accessor");
  assert(usda.includes("point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]"), `sparse values applied: ${usda.match(/points = .*/)?.[0]}`);
  const s = (fn, bytes = b) => { const j = clone(base); fn(j.accessors[0].sparse, j); return makeGlb(j, bytes); };
  rejects(s((sp) => { sp.count = 4; }), /sparse count 4 must be in 1..3/, "sparse.count > count");
  rejects(s((sp) => { sp.indices.componentType = 5126; }), /Invalid sparse accessor indices: .* componentType 5126/, "sparse float indices");
  rejects(s((sp) => { sp.indices.byteOffset = 4; }), /Invalid sparse accessor indices: .* needs 8 bytes/, "sparse indices past bufferView");
  rejects(s((sp) => { sp.values.byteOffset = 20; }), /Invalid sparse accessor values: .* needs 44 bytes/, "sparse values past bufferView");
  rejects(s((sp) => { sp.indices.bufferView = 5; }), /indices bufferView 5 does not exist/, "sparse indices bufferView missing");
  const swapped = b.slice();
  new DataView(swapped.buffer).setUint16(36, 2, true);
  new DataView(swapped.buffer).setUint16(38, 1, true);
  rejects(s(() => {}, swapped), /Invalid sparse accessor indices: accessor 0 sparse index 1 is 1 \(previous 2/, "sparse indices not increasing");
  const outOfRange = b.slice();
  new DataView(outOfRange.buffer).setUint16(38, 3, true);
  rejects(s(() => {}, outOfRange), /Invalid sparse accessor indices: accessor 0 sparse index 1 is 3/, "sparse index >= count");
}

// ---- Nodes / scenes ----
rejects(withJson((j) => { j.nodes[0].mesh = 4; }), /node 0: mesh 4 does not exist/, "node.mesh out of range");
rejects(withJson((j) => { j.nodes[0].children = [5]; }), /node 0: child node 5 does not exist/, "child out of range");
rejects(withJson((j) => { j.nodes[0].children = [0]; }), /lists itself as a child/, "self child");
rejects(withJson((j) => { j.nodes.push({ children: [2] }, { children: [1] }); }), /cycle|already has parent/, "two-node cycle");
rejects(withJson((j) => { j.nodes.push({ children: [2] }, {}); j.nodes[0].children = [2]; }), /node 2 already has parent node 0/, "node with two parents");
rejects(withJson((j) => { j.scenes[0].nodes = [3]; }), /scene 0: node 3 does not exist/, "scene node out of range");
rejects(withJson((j) => { j.scene = 2; }), /scene 2 does not exist/, "scene index out of range");
{
  const j = clone(json);
  for (let i = 1; i <= 40; i++) { j.nodes.push({ name: `N${i}` }); j.nodes[i - 1].children = [i]; }
  rejects(makeGlb(j, bin), /depth exceeds limits.maxNodeDepth \(32\)/, "node depth limit", { limits: { maxNodeDepth: 32 } });
  assert(accepts(makeGlb(j, bin), "40-deep hierarchy with default limits").includes('def Xform "N40"'), "default depth limit allows 40 levels");
}

// ---- Limits ----
rejects(good, /more than limits.maxInputBytes \(100\)/, "input size limit", { limits: { maxInputBytes: 100 } });
rejects(good, /exceed limits.maxAccessorValues \(8\)/, "accessor values limit", { limits: { maxAccessorValues: 8 } });
rejects(good, /more than limits.maxNodes \(0\)/, "node count limit", { limits: { maxNodes: 0 } });
{
  // A bufferView-less accessor with a huge count is refused before any allocation.
  const j = clone(json);
  j.accessors.push({ componentType: 5126, count: 1e9, type: "VEC3" });
  rejects(makeGlb(j, bin), /accessor 2: 1000000000 × 3 values exceed limits.maxAccessorValues/, "huge zero accessor");
}
try { glbToUsda(good, { limits: { maxWidgets: 1 } }); assert(false, "unknown limit accepted"); }
catch (e) { assert(/Unknown limit "maxWidgets"/.test(e.message), `unknown limit message: ${e.message}`); }
assert(DEFAULT_LIMITS.maxNodeDepth === 1024 && Object.isFrozen(DEFAULT_LIMITS), "DEFAULT_LIMITS exported and frozen");

// ---- Skins / animations (structure) ----
{
  const j = clone(json);
  j.skins = [{ joints: [0] }];
  j.nodes[0].skin = 0;
  const skinned = (fn) => { const k = clone(j); fn(k); return makeGlb(k, bin); };
  rejects(skinned((k) => { k.skins[0].joints = [0, 9]; }), /skin 0: joint node 9 does not exist/, "joint out of range");
  rejects(skinned((k) => { k.skins[0].joints = []; }), /joints must be a non-empty array/, "empty joints");
  rejects(skinned((k) => { k.skins[0].joints = [0, 0]; }), /listed twice/, "duplicate joint");
  rejects(skinned((k) => { k.nodes[0].skin = 3; }), /node 0: skin 3 does not exist/, "node.skin out of range");
  rejects(skinned((k) => { k.skins[0].inverseBindMatrices = 0; }), /inverseBindMatrices must be MAT4 FLOAT/, "IBM wrong type");
  const a = clone(json);
  a.animations = [{ samplers: [{ input: 1, output: 0 }], channels: [{ sampler: 0, target: { node: 0, path: "translation" } }] }];
  const anim = (fn) => { const k = clone(a); fn(k.animations[0]); return makeGlb(k, bin); };
  rejects(anim(() => {}), /animation 0 sampler 0: input must be SCALAR FLOAT/, "animation input type");
  rejects(anim((x) => { x.samplers[0].input = 8; }), /input accessor 8 does not exist/, "animation input missing");
  // A well-formed sampler (input = zeros SCALAR FLOAT) for the channel checks.
  a.accessors.push({ componentType: 5126, count: 1, type: "SCALAR" }, { componentType: 5126, count: 1, type: "VEC3" });
  a.animations[0].samplers[0] = { input: 2, output: 3 };
  assert(accepts(anim(() => {}), "one-key animation").includes("def Xform"), "one-key animation converts");
  rejects(anim((x) => { x.channels[0].sampler = 2; }), /channel 0: sampler 2 does not exist/, "channel sampler missing");
  rejects(anim((x) => { x.channels[0].target.node = 6; }), /channel 0: target node 6 does not exist/, "channel node missing");
}

// No internal TypedArray / DataView errors escape for any single-byte corruption of the
// header and JSON-chunk header: every failure is a GltfValidationError.
for (let i = 0; i < 20; i++) {
  for (const v of [0x00, 0xff, 0x7f]) {
    const b = good.slice(); b[i] = v;
    try { glbToUsda(b); } catch (e) {
      assert(e instanceof GltfValidationError, `byte ${i} = ${v}: ${e.name}: ${e.message}`);
    }
  }
}

if (failures) { console.error(`validation: ${failures} failure(s)`); process.exit(1); }
console.log("validation tests passed");
