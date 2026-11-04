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
  rejects(s(() => {}, swapped), /Invalid sparse accessor indices: accessor 0 sparse index 1 is 1 \(smaller than the previous index 2\)/, "sparse indices descending");
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

// ---- Mesh / accessor consistency ----
{
  // Extra zero accessors (no bufferView) with a chosen count / type.
  const withAccessor = (acc, fn) => withJson((j) => { j.accessors.push(acc); fn(j, j.accessors.length - 1); });
  const attr = (name, acc) => withAccessor(acc, (j, a) => { j.meshes[0].primitives[0].attributes[name] = a; });
  rejects(attr("NORMAL", { componentType: 5126, count: 4, type: "VEC3" }), /mesh 0 primitive 0: NORMAL \(accessor 2\) has 4 elements, POSITION \(accessor 0\) has 3/, "POSITION / NORMAL count mismatch");
  rejects(attr("TEXCOORD_0", { componentType: 5126, count: 2, type: "VEC2" }), /TEXCOORD_0 \(accessor 2\) has 2 elements, POSITION \(accessor 0\) has 3/, "POSITION / TEXCOORD_0 count mismatch");
  rejects(attr("COLOR_0", { componentType: 5126, count: 5, type: "VEC4" }), /COLOR_0 \(accessor 2\) has 5 elements/, "POSITION / COLOR_0 count mismatch");
  rejects(attr("TANGENT", { componentType: 5126, count: 1, type: "VEC4" }), /TANGENT \(accessor 2\) has 1 elements/, "POSITION / TANGENT count mismatch");
  rejects(withJson((j) => {
    j.accessors.push({ componentType: 5121, count: 3, type: "VEC4" }, { componentType: 5126, count: 6, type: "VEC4" });
    Object.assign(j.meshes[0].primitives[0].attributes, { JOINTS_0: 2, WEIGHTS_0: 3 });
  }), /WEIGHTS_0 \(accessor 3\) has 6 elements/, "POSITION / WEIGHTS_0 count mismatch");
  // Custom attributes ("_NAME") are not vertex-count checked.
  assert(accepts(attr("_TEMPERATURE", { componentType: 5126, count: 1, type: "SCALAR" }), "custom attribute").includes("def Mesh"), "custom attribute with another count is accepted");
  rejects(withAccessor({ componentType: 5126, count: 2, type: "VEC3" }, (j, a) => { j.meshes[0].primitives[0].targets = [{ POSITION: a }]; }),
    /mesh 0 primitive 0 target 0: POSITION \(accessor 2\) has 2 elements, POSITION has 3/, "morph target count mismatch");
  // Index accessors.
  rejects(withJson((j) => { j.accessors[1].type = "VEC3"; j.accessors[1].count = 1; }), /indices \(accessor 1\) must be SCALAR, not VEC3/, "indices VEC3");
  rejects(withJson((j) => { j.accessors[1] = { componentType: 5126, count: 3, type: "SCALAR" }; }), /indices \(accessor 1\) componentType 5126 must be 5121, 5123 or 5125/, "indices FLOAT");
  rejects(withJson((j) => { j.accessors[1].normalized = true; }), /indices \(accessor 1\) must not be normalized/, "normalized indices");
  {
    const b = bin.slice();
    new DataView(b.buffer).setUint16(40, 3, true); // third index (bufferView 1 starts at 36) = 3
    rejects(makeGlb(json, b), /mesh 0 primitive 0: indices \(accessor 1\) value 2 is 3, but POSITION has 3 vertices/, "index value >= vertex count");
    new DataView(b.buffer).setUint16(40, 65535, true);
    rejects(makeGlb(json, b), /value 2 is 65535/, "primitive-restart-like index");
  }
  rejects(withJson((j) => { j.accessors[1].count = 2; }), /indices \(accessor 1\) has 2 indices, not a multiple of 3 \(TRIANGLES\)/, "TRIANGLES index count not a multiple of 3");
  rejects(withJson((j) => { delete j.meshes[0].primitives[0].indices; j.accessors[0].count = 2; }), /2 vertices without indices, not a multiple of 3/, "TRIANGLES vertex count not a multiple of 3");
  // Strips / fans have no multiple-of-3 rule.
  assert(accepts(withJson((j) => { j.meshes[0].primitives[0].mode = 5; }), "strip").includes("def Mesh"), "TRIANGLE_STRIP with 3 indices");
  rejects(withJson((j) => { j.meshes[0].primitives[0].mode = 9; }), /mode 9 is not a glTF primitive mode/, "unknown primitive mode");
}

// ---- JSON structure types ----
rejects(withJson((j) => { j.nodes[0].children = 1; }), /node 0: children must be an array/, "children is a number");
rejects(withJson((j) => { j.nodes[0].children = "1"; }), /node 0: children must be an array/, "children is a string");
rejects(withJson((j) => { j.scenes[0].nodes = { 0: 0 }; }), /scene 0: nodes must be an array/, "scene.nodes is an object");
rejects(withJson((j) => { j.animations = [{ samplers: {}, channels: [] }]; }), /animation 0: samplers must be an array/, "animation.samplers not an array");
rejects(withJson((j) => { j.animations = [{ samplers: [], channels: 3 }]; }), /animation 0: channels must be an array/, "animation.channels not an array");
rejects(withJson((j) => { j.animations = [{ samplers: [null], channels: [] }]; }), /animation 0 sampler 0 must be an object/, "sampler is null");
rejects(withJson((j) => { j.animations = [{ samplers: [], channels: ["x"] }]; }), /animation 0 channel 0 must be an object/, "channel is a string");
rejects(withJson((j) => { j.meshes[0].primitives = {}; }), /mesh 0: primitives must be an array/, "primitives is an object");
rejects(withJson((j) => { j.meshes[0].primitives[0] = 7; }), /mesh 0 primitive 0 must be an object/, "primitive is a number");
rejects(withJson((j) => { j.meshes[0].primitives[0].attributes = [0]; }), /attributes must be an object/, "attributes is an array");
rejects(withJson((j) => { j.meshes[0].primitives[0].targets = {}; }), /mesh 0 primitive 0: targets must be an array/, "targets is an object");
rejects(withJson((j) => { j.meshes[0].primitives[0].targets = [null]; }), /target 0 must be an object/, "target is null");
rejects(withJson((j) => { j.materials = [null]; }), /glTF materials\[0\] must be an object/, "material is null");
rejects(withJson((j) => { j.nodes.push([]); }), /glTF nodes\[1\] must be an object/, "node is an array");
rejects(withJson((j) => { j.textures = ["t"]; }), /glTF textures\[0\] must be an object/, "texture is a string");

// ---- maxInputBytes for JSON text and glTF objects ----
{
  const doc = { asset: { version: "2.0" }, scenes: [{ nodes: [0] }], nodes: [{ name: "N" }] };
  const text = JSON.stringify(doc);
  rejects(text, new RegExp(`glTF JSON text is at least ${text.length} bytes \\(UTF-8\\), more than limits.maxInputBytes \\(${text.length - 1}\\)`), "JSON text over the limit", { limits: { maxInputBytes: text.length - 1 } });
  assert(accepts(text, "JSON text at the limit", { limits: { maxInputBytes: text.length } }).includes('def Xform "N"'), "JSON text exactly at the limit");
  // Multi-byte text: few UTF-16 code units, more UTF-8 bytes.
  const wide = JSON.stringify({ ...doc, nodes: [{ name: "ノード".repeat(10) }] });
  const utf8 = new TextEncoder().encode(wide).length;
  assert(utf8 > wide.length, "test setup: UTF-8 longer than the string");
  rejects(wide, new RegExp(`is ${utf8} bytes \\(UTF-8\\)`), "UTF-8 size counted, not string length", { limits: { maxInputBytes: wide.length + 1 } });
  // A glTF object has no byte size: maxInputBytes does not apply, the other limits do.
  assert(accepts(doc, "object input", { limits: { maxInputBytes: 1 } }).includes('def Xform "N"'), "object input ignores maxInputBytes");
  rejects(doc, /more than limits.maxNodes \(0\)/, "object input still has the other limits", { limits: { maxNodes: 0 } });
  // External buffers count against maxInputBytes too.
  const j = clone(json);
  j.buffers[0].uri = "tri.bin";
  rejects(j, /External buffer "tri.bin" is 44 bytes, more than limits.maxInputBytes \(40\)/, "external buffer over the limit", { limits: { maxInputBytes: 40 }, resources: { "tri.bin": bin } });
}

// ---- Attribute accessor types / component types ----
{
  // Replace accessor 0 (POSITION) or add an attribute accessor of the given type.
  const zeros = (type, componentType = 5126, extra = {}) => ({ componentType, count: 3, type, ...extra });
  const attr = (name, acc) => withJson((j) => { j.accessors.push(acc); j.meshes[0].primitives[0].attributes[name] = j.accessors.length - 1; });
  rejects(withJson((j) => { j.accessors[0] = zeros("VEC4"); }), /mesh 0 primitive 0: POSITION \(accessor 0\) must be VEC3, not VEC4/, "POSITION VEC4");
  rejects(attr("NORMAL", zeros("VEC4")), /NORMAL \(accessor 2\) must be VEC3, not VEC4/, "NORMAL VEC4");
  rejects(attr("TANGENT", zeros("VEC3")), /TANGENT \(accessor 2\) must be VEC4, not VEC3/, "TANGENT VEC3");
  rejects(attr("TEXCOORD_0", zeros("VEC3")), /TEXCOORD_0 \(accessor 2\) must be VEC2, not VEC3/, "TEXCOORD_0 VEC3");
  rejects(attr("COLOR_0", zeros("VEC2")), /COLOR_0 \(accessor 2\) must be VEC3 or VEC4, not VEC2/, "COLOR_0 VEC2");
  // Component types: core glTF, and KHR_mesh_quantization only when declared.
  rejects(attr("NORMAL", zeros("VEC3", 5120, { normalized: true })), /NORMAL \(accessor 2\) is normalized BYTE \(allowed only with KHR_mesh_quantization\); allowed: FLOAT/, "quantized NORMAL without the extension");
  const quantized = (fn) => withJson((j) => { j.extensionsUsed = ["KHR_mesh_quantization"]; j.extensionsRequired = ["KHR_mesh_quantization"]; fn(j); });
  assert(accepts(quantized((j) => { j.accessors.push(zeros("VEC3", 5120, { normalized: true })); j.meshes[0].primitives[0].attributes.NORMAL = 2; }), "quantized NORMAL").includes("normals"), "normalized BYTE NORMAL with KHR_mesh_quantization");
  rejects(quantized((j) => { j.accessors.push(zeros("VEC3", 5121, { normalized: true })); j.meshes[0].primitives[0].attributes.NORMAL = 2; }), /NORMAL \(accessor 2\) is normalized UNSIGNED_BYTE; allowed: FLOAT, normalized BYTE, normalized SHORT/, "UNSIGNED_BYTE NORMAL even with quantization");
  assert(accepts(quantized((j) => { j.accessors.push(zeros("VEC2", 5122)); j.meshes[0].primitives[0].attributes.TEXCOORD_0 = 2; }), "quantized UV").includes("primvars:st"), "SHORT TEXCOORD_0 with KHR_mesh_quantization");
  rejects(attr("TEXCOORD_0", zeros("VEC2", 5122)), /TEXCOORD_0 \(accessor 2\) is SHORT \(allowed only with KHR_mesh_quantization\)/, "SHORT TEXCOORD_0 without the extension");
  rejects(attr("COLOR_0", zeros("VEC4", 5125)), /COLOR_0 \(accessor 2\) is UNSIGNED_INT/, "UNSIGNED_INT COLOR_0");
  // Application-specific (custom) mesh attributes: "_" prefix, no UNSIGNED_INT (glTF 2.0 § 3.7.2.1).
  for (const [label, acc] of [["FLOAT", zeros("SCALAR", 5126)], ["UNSIGNED_BYTE", zeros("SCALAR", 5121)], ["UNSIGNED_SHORT", zeros("SCALAR", 5123)], ["normalized UNSIGNED_SHORT VEC4", zeros("VEC4", 5123, { normalized: true })]]) {
    assert(accepts(attr("_ID", acc), `_ID ${label}`).includes("def Mesh"), `custom _ID ${label} accepted`);
  }
  rejects(attr("_ID", zeros("SCALAR", 5125)), /mesh 0 primitive 0: _ID \(accessor 2\) is UNSIGNED_INT, which custom attributes must not use/, "custom _ID UNSIGNED_INT");
  rejects(attr("CUSTOM_ID", zeros("SCALAR")), /mesh 0 primitive 0: attribute "CUSTOM_ID" is not a glTF attribute semantic; custom attributes must start with "_"/, "custom attribute without underscore");
  rejects(attr("BATCHID", zeros("SCALAR")), /attribute "BATCHID" is not a glTF attribute semantic/, "legacy BATCHID without underscore");
  rejects(attr("texcoord_0", zeros("VEC2")), /attribute "texcoord_0" is not a glTF attribute semantic/, "lower-case semantic");
  // Morph targets keep their own rules (unknown target names are not checked here).
}

// ---- normalized on any accessor ----
{
  const unused = (extra) => withJson((j) => { j.accessors.push({ componentType: 5126, count: 1, type: "SCALAR", ...extra }); });
  rejects(unused({ normalized: true }), /accessor 2: FLOAT accessors must not be normalized/, "FLOAT normalized:true");
  rejects(unused({ componentType: 5125, normalized: true }), /accessor 2: UNSIGNED_INT accessors must not be normalized/, "UNSIGNED_INT normalized:true");
  rejects(unused({ normalized: "true" }), /accessor 2: normalized must be a boolean \(got "true"\)/, "normalized as a string");
  rejects(unused({ normalized: 1 }), /normalized must be a boolean \(got 1\)/, "normalized as a number");
  rejects(unused({ normalized: null }), /normalized must be a boolean \(got null\)/, "normalized null");
  assert(accepts(unused({ normalized: false }), "FLOAT normalized:false").includes("def Mesh"), "FLOAT normalized:false accepted");
  assert(accepts(unused({}), "FLOAT without normalized").includes("def Mesh"), "FLOAT without normalized accepted");
  assert(accepts(unused({ componentType: 5125, normalized: false }), "UNSIGNED_INT normalized:false").includes("def Mesh"), "UNSIGNED_INT normalized:false accepted");
  // Also when the accessor is used (POSITION FLOAT normalized).
  rejects(withJson((j) => { j.accessors[0].normalized = true; }), /accessor 0: FLOAT accessors must not be normalized/, "used FLOAT accessor normalized");
}

// ---- JOINTS_n / WEIGHTS_n ----
{
  const j4 = (extra = {}) => ({ componentType: 5121, count: 3, type: "VEC4", ...extra });
  const w4 = (extra = {}) => ({ componentType: 5126, count: 3, type: "VEC4", ...extra });
  /** Primitive with the given skin attributes (name → accessor). */
  const skinAttrs = (attrs) => withJson((j) => {
    for (const [name, acc] of Object.entries(attrs)) { j.accessors.push(acc); j.meshes[0].primitives[0].attributes[name] = j.accessors.length - 1; }
  });
  rejects(skinAttrs({ JOINTS_0: { ...j4(), type: "VEC3" }, WEIGHTS_0: w4() }), /JOINTS_0 \(accessor 2\) must be VEC4, not VEC3/, "JOINTS_0 VEC3");
  rejects(skinAttrs({ JOINTS_0: j4(), WEIGHTS_0: { ...w4(), type: "VEC3" } }), /WEIGHTS_0 \(accessor 3\) must be VEC4, not VEC3/, "WEIGHTS_0 VEC3");
  rejects(skinAttrs({ JOINTS_0: j4() }), /mesh 0 primitive 0: JOINTS_0 has no matching WEIGHTS_0/, "JOINTS_0 only");
  rejects(skinAttrs({ WEIGHTS_0: w4() }), /mesh 0 primitive 0: WEIGHTS_0 has no matching JOINTS_0/, "WEIGHTS_0 only");
  rejects(skinAttrs({ JOINTS_1: j4(), WEIGHTS_1: w4() }), /JOINTS_0 \/ WEIGHTS_0 are missing \(sets must be numbered from 0 without gaps; found _1\)/, "JOINTS_1 / WEIGHTS_1 without set 0");
  rejects(skinAttrs({ JOINTS_1: j4() }), /JOINTS_1 has no matching WEIGHTS_1/, "JOINTS_1 only");
  rejects(skinAttrs({ JOINTS_0: j4(), WEIGHTS_1: w4() }), /JOINTS_0 has no matching WEIGHTS_0/, "JOINTS_0 with WEIGHTS_1");
  rejects(skinAttrs({ JOINTS_0: j4(), WEIGHTS_0: w4(), JOINTS_2: j4(), WEIGHTS_2: w4() }), /JOINTS_1 \/ WEIGHTS_1 are missing/, "gap in the sets");
  rejects(skinAttrs({ JOINTS_0: j4({ componentType: 5126 }), WEIGHTS_0: w4() }), /JOINTS_0 \(accessor 2\) is FLOAT; allowed: UNSIGNED_BYTE, UNSIGNED_SHORT/, "JOINTS FLOAT");
  rejects(skinAttrs({ JOINTS_0: j4({ normalized: true }), WEIGHTS_0: w4() }), /JOINTS_0 \(accessor 2\) is normalized UNSIGNED_BYTE/, "JOINTS normalized");
  rejects(skinAttrs({ JOINTS_0: j4({ componentType: 5125 }), WEIGHTS_0: w4() }), /JOINTS_0 \(accessor 2\) is UNSIGNED_INT/, "JOINTS UNSIGNED_INT");
  rejects(skinAttrs({ JOINTS_0: j4(), WEIGHTS_0: w4({ componentType: 5121 }) }), /WEIGHTS_0 \(accessor 3\) is UNSIGNED_BYTE; allowed: FLOAT, normalized UNSIGNED_BYTE, normalized UNSIGNED_SHORT/, "WEIGHTS unnormalized UNSIGNED_BYTE");
  rejects(skinAttrs({ JOINTS_0: j4(), WEIGHTS_0: w4({ componentType: 5122, normalized: true }) }), /WEIGHTS_0 \(accessor 3\) is normalized SHORT/, "WEIGHTS normalized SHORT");
  rejects(skinAttrs({ JOINTS_0: j4({ count: 2 }), WEIGHTS_0: w4() }), /JOINTS_0 \(accessor 2\) has 2 elements, POSITION \(accessor 0\) has 3/, "JOINTS count mismatch");
  // Valid pairs (two sets, USHORT joints, normalized UBYTE weights) pass validation.
  assert(accepts(skinAttrs({ JOINTS_0: j4(), WEIGHTS_0: w4(), JOINTS_1: j4({ componentType: 5123 }), WEIGHTS_1: w4({ componentType: 5121, normalized: true }) }), "two skin sets").includes("def Mesh"), "valid JOINTS / WEIGHTS sets");
}

// ---- POSITION is required ----
rejects(withJson((j) => { delete j.meshes[0].primitives[0].attributes.POSITION; j.meshes[0].primitives[0].attributes.NORMAL = 0; }), /mesh 0 primitive 0: has no POSITION attribute/, "primitive without POSITION");
rejects(withJson((j) => { j.meshes[0].primitives.push({ attributes: {} }); }), /mesh 0 primitive 1: has no POSITION attribute/, "second primitive without attributes");

// ---- Sparse structure ----
{
  const sparse = (value) => withJson((j) => { j.accessors[0].sparse = value; });
  rejects(sparse(null), /Invalid sparse accessor: accessor 0 sparse must be an object/, "sparse null");
  rejects(sparse([1]), /accessor 0 sparse must be an object/, "sparse array");
  rejects(sparse({ count: 1, indices: null, values: { bufferView: 0 } }), /accessor 0 sparse.indices must be an object/, "sparse.indices null");
  rejects(sparse({ count: 1, indices: { bufferView: 1, componentType: 5123 }, values: null }), /accessor 0 sparse.values must be an object/, "sparse.values null");
  rejects(sparse({ count: 1.5, indices: { bufferView: 1, componentType: 5123 }, values: { bufferView: 0 } }), /sparse count 1.5 must be in 1..3/, "fractional sparse.count");
  rejects(sparse({ count: 1, indices: { bufferView: 9, componentType: 5123 }, values: { bufferView: 0 } }), /indices bufferView 9 does not exist/, "sparse.indices.bufferView missing");
  rejects(sparse({ count: 1, indices: { bufferView: 1, componentType: 5123 }, values: {} }), /values bufferView undefined does not exist/, "sparse.values.bufferView missing");
  // Duplicate indices (the triangle's index buffer is [0, 1, 2] → make it [1, 1, 2]), checked
  // before conversion even for an accessor nothing reads.
  const b = bin.slice();
  new DataView(b.buffer).setUint16(36, 1, true);
  const j = clone(json);
  j.accessors.push({ componentType: 5126, count: 3, type: "SCALAR", sparse: { count: 2, indices: { bufferView: 1, componentType: 5123 }, values: { bufferView: 0 } } });
  rejects(makeGlb(j, b), /accessor 2 sparse index 1 is 1 \(a duplicate\); indices must be strictly increasing/, "duplicate sparse indices in an unused accessor");
}

// ---- Sparse bufferView constraints and alignment ----
{
  // Accessor 0 (POSITION) = zeros + sparse: indices in bufferView 1 (USHORT), values in bufferView 0.
  const sparseDoc = (fn) => withJson((j) => {
    j.accessors[0] = { componentType: 5126, count: 3, type: "VEC3", sparse: { count: 2, indices: { bufferView: 1, componentType: 5123 }, values: { bufferView: 0 } } };
    fn(j, j.accessors[0].sparse);
  });
  rejects(sparseDoc((j) => { j.bufferViews[1].byteStride = 4; }), /Invalid sparse accessor indices: accessor 0 sparse.indices bufferView 1 must not define byteStride/, "sparse indices view with byteStride");
  rejects(sparseDoc((j) => { j.bufferViews[1].target = 34963; }), /sparse.indices bufferView 1 must not define target/, "sparse indices view with target");
  rejects(sparseDoc((j) => { j.bufferViews[0].byteStride = 12; }), /Invalid sparse accessor values: accessor 0 sparse.values bufferView 0 must not define byteStride/, "sparse values view with byteStride");
  rejects(sparseDoc((j) => { j.bufferViews[0].target = 34962; }), /sparse.values bufferView 0 must not define target/, "sparse values view with target");
  rejects(sparseDoc((j, sp) => { sp.indices.byteOffset = 1; }), /sparse.indices.byteOffset 1 is not a multiple of 2/, "misaligned sparse indices.byteOffset");
  rejects(sparseDoc((j, sp) => { sp.values.byteOffset = 2; }), /sparse.values.byteOffset 2 is not a multiple of 4/, "misaligned sparse values.byteOffset");
  rejects(sparseDoc((j, sp) => { j.bufferViews.push({ buffer: 0, byteOffset: 37, byteLength: 4 }); sp.indices.bufferView = 2; }),
    /sparse.indices bufferView 2 byteOffset 37 is not a multiple of 2/, "sparse indices bufferView.byteOffset misaligned");
  rejects(sparseDoc((j, sp) => { j.bufferViews.push({ buffer: 0, byteOffset: 2, byteLength: 24 }); sp.values.bufferView = 2; }),
    /sparse.values bufferView 2 byteOffset 2 is not a multiple of 4/, "sparse values bufferView.byteOffset misaligned");
}

// ---- Accessor alignment and byteStride by use ----
{
  const extra = (fn) => withJson((j) => { fn(j); });
  // Component-size alignment (any accessor, used or not).
  rejects(extra((j) => { j.accessors.push({ bufferView: 0, componentType: 5126, count: 1, type: "SCALAR", byteOffset: 2 }); }),
    /Accessor alignment: accessor 2 byteOffset 2 is not a multiple of its component size 4/, "FLOAT accessor at byteOffset 2");
  rejects(extra((j) => { j.accessors.push({ bufferView: 1, componentType: 5123, count: 1, type: "SCALAR", byteOffset: 1 }); }),
    /accessor 2 byteOffset 1 is not a multiple of its component size 2/, "USHORT accessor at byteOffset 1");
  rejects(extra((j) => { j.bufferViews.push({ buffer: 0, byteOffset: 2, byteLength: 8 }); j.accessors.push({ bufferView: 2, componentType: 5126, count: 2, type: "SCALAR" }); }),
    /accessor 2: bufferView 2 byteOffset 2 \+ accessor byteOffset 0 is not a multiple of its component size 4/, "bufferView + accessor offset misaligned");
  rejects(extra((j) => { j.bufferViews.push({ buffer: 0, byteOffset: 1, byteLength: 8 }); j.accessors.push({ bufferView: 2, componentType: 5123, count: 1, type: "SCALAR", byteOffset: 2 }); }),
    /bufferView 2 byteOffset 1 \+ accessor byteOffset 2 is not a multiple of its component size 2/, "odd sum for USHORT");
  // Vertex attributes: 4-byte boundaries even for 1- / 2-byte components.
  rejects(extra((j) => {
    j.accessors.push({ bufferView: 0, componentType: 5123, normalized: true, count: 3, type: "VEC2", byteOffset: 2 });
    j.meshes[0].primitives[0].attributes.TEXCOORD_0 = 2;
  }), /accessor 2 is a vertex attribute; its byteOffset 2 must be a multiple of 4/, "vertex attribute at byteOffset 2");
  // Non-vertex accessors must not use a strided bufferView.
  rejects(extra((j) => {
    j.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: 12, byteStride: 4 });
    j.accessors[1].bufferView = 2;
  }), /accessor 1 \(indices\) uses bufferView 2, which defines byteStride; only vertex attributes may use a strided bufferView/, "indices in a strided bufferView");
  {
    const j = clone(json);
    j.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: 4, byteStride: 4 });
    j.accessors.push({ bufferView: 2, componentType: 5126, count: 1, type: "SCALAR" }, { componentType: 5126, count: 1, type: "VEC3" });
    j.animations = [{ samplers: [{ input: 2, output: 3 }], channels: [{ sampler: 0, target: { node: 0, path: "translation" } }] }];
    rejects(makeGlb(j, bin), /accessor 2 \(animation input\) uses bufferView 2, which defines byteStride/, "animation input in a strided bufferView");
  }
  // Valid FLOAT, UNSIGNED_BYTE and UNSIGNED_SHORT accessors (with byteOffset, interleaved stride) still pass.
  const ok = extra((j) => {
    j.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: 36, byteStride: 12 });
    j.accessors.push(
      { bufferView: 2, componentType: 5121, normalized: true, count: 3, type: "VEC2", byteOffset: 4 },  // TEXCOORD_0 UBYTE
      { bufferView: 2, componentType: 5123, normalized: true, count: 3, type: "VEC4", byteOffset: 4 },  // COLOR_0 USHORT
      { bufferView: 1, componentType: 5121, count: 4, type: "SCALAR", byteOffset: 1 },                  // unused UBYTE at offset 1
    );
    Object.assign(j.meshes[0].primitives[0].attributes, { TEXCOORD_0: 2, COLOR_0: 3 });
  });
  const usda = accepts(ok, "aligned FLOAT / UNSIGNED_BYTE / UNSIGNED_SHORT accessors");
  assert(usda.includes("primvars:st") && usda.includes("primvars:displayColor"), "aligned accessors convert");
}

// ---- EXT_mesh_gpu_instancing ----
{
  const z = (type, count = 2, componentType = 5126, extra = {}) => ({ componentType, count, type, ...extra });
  /** Triangle node instanced with the given attributes (name → accessor JSON, or a raw index). */
  const instanced = (attrs, { quantization = false, mutate } = {}) => withJson((j) => {
    j.extensionsUsed = ["EXT_mesh_gpu_instancing", ...(quantization ? ["KHR_mesh_quantization"] : [])];
    const attributes = {};
    for (const [name, acc] of Object.entries(attrs)) {
      if (typeof acc === "number") { attributes[name] = acc; continue; }
      j.accessors.push(acc);
      attributes[name] = j.accessors.length - 1;
    }
    j.nodes[0].extensions = { EXT_mesh_gpu_instancing: { attributes } };
    mutate?.(j);
  });
  const W = "node 0 EXT_mesh_gpu_instancing";
  // Accessor references.
  rejects(instanced({ TRANSLATION: 9 }), new RegExp(`${W}: TRANSLATION accessor 9 does not exist`), "TRANSLATION accessor out of range");
  rejects(instanced({ ROTATION: 7 }), new RegExp(`${W}: ROTATION accessor 7 does not exist`), "ROTATION accessor out of range");
  rejects(instanced({ SCALE: 5 }), new RegExp(`${W}: SCALE accessor 5 does not exist`), "SCALE accessor out of range");
  rejects(instanced({ SCALE: -1 }), /SCALE accessor -1 does not exist/, "negative accessor index");
  rejects(instanced({ TRANSLATION: 0.5 }), /TRANSLATION accessor 0.5 does not exist/, "fractional accessor index");
  // Types.
  rejects(instanced({ TRANSLATION: z("VEC2") }), new RegExp(`${W}: TRANSLATION \\(accessor 2\\) must be VEC3, not VEC2`), "TRANSLATION VEC2");
  rejects(instanced({ ROTATION: z("VEC3") }), /ROTATION \(accessor 2\) must be VEC4, not VEC3/, "ROTATION VEC3");
  rejects(instanced({ SCALE: z("VEC4") }), /SCALE \(accessor 2\) must be VEC3, not VEC4/, "SCALE VEC4");
  // Component types other than FLOAT (and the extension's normalized ROTATION forms).
  rejects(instanced({ TRANSLATION: z("VEC3", 2, 5122, { normalized: true }) }), /TRANSLATION \(accessor 2\) is normalized SHORT; allowed: FLOAT$/, "normalized SHORT TRANSLATION");
  rejects(instanced({ SCALE: z("VEC3", 2, 5125) }), /SCALE \(accessor 2\) is UNSIGNED_INT; allowed: FLOAT/, "UNSIGNED_INT SCALE");
  rejects(instanced({ ROTATION: z("VEC4", 2, 5121, { normalized: true }) }), /ROTATION \(accessor 2\) is normalized UNSIGNED_BYTE; allowed: FLOAT, normalized BYTE, normalized SHORT/, "normalized UNSIGNED_BYTE ROTATION");
  rejects(instanced({ ROTATION: z("VEC4", 2, 5122) }), /ROTATION \(accessor 2\) is SHORT; allowed: FLOAT, normalized BYTE, normalized SHORT/, "unnormalized SHORT ROTATION");
  // Counts.
  rejects(instanced({ TRANSLATION: z("VEC3", 3), ROTATION: z("VEC4", 2) }), new RegExp(`${W}: ROTATION \\(accessor 3\\) has 2 instances, TRANSLATION has 3`), "TRANSLATION / ROTATION count mismatch");
  rejects(instanced({ TRANSLATION: z("VEC3", 3), SCALE: z("VEC3", 4) }), /SCALE \(accessor 3\) has 4 instances, TRANSLATION has 3/, "TRANSLATION / SCALE count mismatch");
  // Structure.
  rejects(withJson((j) => { j.nodes[0].extensions = { EXT_mesh_gpu_instancing: { attributes: null } }; }), new RegExp(`${W}: attributes must be an object`), "attributes null");
  rejects(withJson((j) => { j.nodes[0].extensions = { EXT_mesh_gpu_instancing: { attributes: [0] } }; }), /attributes must be an object/, "attributes array");
  rejects(withJson((j) => { j.nodes[0].extensions = { EXT_mesh_gpu_instancing: {} }; }), new RegExp(`${W}: attributes is required`), "attributes missing");
  rejects(withJson((j) => { j.nodes[0].extensions = { EXT_mesh_gpu_instancing: 3 }; }), /node 0 extensions: EXT_mesh_gpu_instancing must be an object/, "extension not an object");
  rejects(withJson((j) => { j.nodes[0].extensions = "EXT_mesh_gpu_instancing"; }), /node 0: extensions must be an object/, "extensions a string");
  rejects(withJson((j) => { j.nodes[0].extensions = [{}]; }), /node 0: extensions must be an object/, "extensions an array");
  rejects(withJson((j) => { j.nodes[0].extensions = null; }), /node 0: extensions must be an object/, "extensions null");
  // Alignment: a FLOAT instance attribute at byteOffset 2 (component-size rule) — and the 4-byte rule.
  rejects(instanced({ TRANSLATION: { bufferView: 0, componentType: 5126, count: 2, type: "VEC3", byteOffset: 2 } }), /accessor 2 byteOffset 2 is not a multiple of its component size 4/, "misaligned FLOAT TRANSLATION");
  rejects(instanced({ ROTATION: { bufferView: 0, componentType: 5122, normalized: true, count: 2, type: "VEC4", byteOffset: 2 } }), /accessor 2 is an EXT_mesh_gpu_instancing attribute; its byteOffset 2 must be a multiple of 4/, "normalized SHORT ROTATION at byteOffset 2");

  // Valid cases: the number of instance Xforms equals the count; omitted attributes are identity.
  const instances = (usda) => (usda.match(/def Xform "Tri_\d+"/g) || []).length;
  const tOnly = accepts(instanced({ TRANSLATION: z("VEC3", 3) }), "TRANSLATION only");
  assert(instances(tOnly) === 3, `TRANSLATION only: ${instances(tOnly)} instances`);
  assert(instances(accepts(instanced({ ROTATION: z("VEC4", 2) }), "ROTATION only")) === 2, "ROTATION only: 2 instances");
  assert(instances(accepts(instanced({ SCALE: z("VEC3", 4) }), "SCALE only")) === 4, "SCALE only: 4 instances");
  assert(instances(accepts(instanced({ TRANSLATION: z("VEC3", 5), ROTATION: z("VEC4", 5), SCALE: z("VEC3", 5) }), "all three")) === 5, "all three, same count: 5 instances");
  assert(instances(accepts(instanced({ TRANSLATION: z("VEC3", 2), SCALE: z("VEC3", 2) }), "no ROTATION")) === 2, "ROTATION omitted");
  assert(instances(accepts(instanced({ ROTATION: z("VEC4", 2), SCALE: z("VEC3", 2) }), "no TRANSLATION")) === 2, "TRANSLATION omitted");
  assert(instances(accepts(instanced({ TRANSLATION: z("VEC3", 2), ROTATION: z("VEC4", 2) }), "no SCALE")) === 2, "SCALE omitted");
  assert(instances(accepts(instanced({ ROTATION: z("VEC4", 2, 5120, { normalized: true }) }), "normalized BYTE ROTATION")) === 2, "normalized BYTE ROTATION (extension spec)");
  // KHR_mesh_quantization does not extend TRANSLATION / SCALE (FLOAT only); ROTATION has the extension's own forms.
  rejects(instanced({ TRANSLATION: z("VEC3", 2, 5122) }, { quantization: true }), new RegExp(`${W}: TRANSLATION \\(accessor 2\\) is SHORT; allowed: FLOAT$`), "SHORT TRANSLATION with KHR_mesh_quantization");
  rejects(instanced({ SCALE: z("VEC3", 2, 5122) }, { quantization: true }), /SCALE \(accessor 2\) is SHORT; allowed: FLOAT$/, "SHORT SCALE with KHR_mesh_quantization");
  rejects(instanced({ SCALE: z("VEC3", 2, 5120, { normalized: true }) }, { quantization: true }), /SCALE \(accessor 2\) is normalized BYTE; allowed: FLOAT$/, "normalized BYTE SCALE with KHR_mesh_quantization");
  assert(instances(accepts(instanced({ TRANSLATION: z("VEC3", 2) }), "FLOAT TRANSLATION")) === 2, "FLOAT TRANSLATION");
  assert(instances(accepts(instanced({ SCALE: z("VEC3", 2) }), "FLOAT SCALE")) === 2, "FLOAT SCALE");
  assert(instances(accepts(instanced({ ROTATION: z("VEC4", 2, 5122, { normalized: true }) }), "normalized SHORT ROTATION")) === 2, "normalized SHORT ROTATION");
  assert(instances(accepts(instanced({ ROTATION: z("VEC4", 2, 5120, { normalized: true }) }, { quantization: true }), "normalized BYTE ROTATION + quantization")) === 2, "normalized BYTE ROTATION with KHR_mesh_quantization declared");
  // The extension needs the node's mesh; attributes must not be empty.
  rejects(instanced({ TRANSLATION: z("VEC3") }, { mutate: (j) => { delete j.nodes[0].mesh; } }), new RegExp(`${W}: the node has no mesh to instance`), "instancing without node.mesh");
  rejects(instanced({ TRANSLATION: z("VEC3") }, { mutate: (j) => { j.nodes[0].mesh = 9; } }), /node 0: mesh 9 does not exist/, "instancing with an invalid mesh index");
  rejects(instanced({ TRANSLATION: z("VEC3") }, { mutate: (j) => { j.nodes[0].mesh = "0"; } }), /node 0: mesh "0" does not exist/, "instancing with a string mesh index");
  rejects(withJson((j) => { j.nodes[0].extensions = { EXT_mesh_gpu_instancing: { attributes: {} } }; }), new RegExp(`${W}: attributes must have at least one attribute`), "empty attributes");
  // Custom attributes ("_NAME"): validated like the others, then dropped with one warning per node and attribute.
  {
    const run = (glb) => { const w = []; const { usda } = glbToUsda(glb, { onWarning: (x) => w.push(x) }); return { usda, w }; };
    const custom = (w) => w.filter((x) => x.startsWith("EXT_mesh_gpu_instancing: custom instance attribute"));
    const only = run(instanced({ _ID: z("SCALAR", 3) }));
    assert(instances(only.usda) === 3, `_ID only: ${instances(only.usda)} instances (count comes from the attributes)`);
    assert(custom(only.w).length === 1 && custom(only.w)[0] === 'EXT_mesh_gpu_instancing: custom instance attribute "_ID" (node 0) is not represented in USD and will be ignored', `_ID warning: ${only.w}`);
    const both = run(instanced({ TRANSLATION: z("VEC3", 2), _ID: z("SCALAR", 2), _COLOR: z("VEC4", 2) }));
    assert(instances(both.usda) === 2, "custom attributes do not change the instance count");
    assert(custom(both.w).length === 2 && custom(both.w).some((x) => x.includes('"_COLOR"')) && custom(both.w).some((x) => x.includes('"_ID"')), `one warning per custom attribute: ${custom(both.w)}`);
    // The same output as without the custom attributes (they add nothing to USD).
    assert(both.usda === run(instanced({ TRANSLATION: z("VEC3", 2) })).usda, "custom attributes leave the USD unchanged");
    // Two instanced nodes with the same custom attribute: one warning each.
    const two = run(instanced({ _ID: z("SCALAR", 2) }, { mutate: (j) => { j.nodes.push({ mesh: 0, extensions: j.nodes[0].extensions }); j.scenes[0].nodes.push(1); } }));
    assert(custom(two.w).length === 2 && custom(two.w).some((x) => x.includes("(node 1)")), `per-node warnings: ${custom(two.w)}`);
    // Instanced node under animation (rigid skeleton path): drawn once, custom attribute still reported.
    const animated = run(instanced({ _ID: z("SCALAR", 2) }, { mutate: (j) => {
      j.accessors.push({ componentType: 5126, count: 1, type: "SCALAR" }, { componentType: 5126, count: 1, type: "VEC3" });
      const n = j.accessors.length;
      j.animations = [{ samplers: [{ input: n - 2, output: n - 1 }], channels: [{ sampler: 0, target: { node: 0, path: "translation" } }] }];
    } }));
    assert(animated.w.some((x) => /Node 0: EXT_mesh_gpu_instancing under an animated node is drawn once/.test(x)) && custom(animated.w).length === 1, `animated instanced node: ${animated.w}`);
    // Without custom attributes there is no such warning.
    assert(!custom(run(instanced({ TRANSLATION: z("VEC3", 2), ROTATION: z("VEC4", 2), SCALE: z("VEC3", 2) })).w).length, "no warning for TRS only");
    // Custom attribute names and component types (glTF 2.0 § 3.7.2.1).
    for (const [label, acc] of [
      ["_ID FLOAT SCALAR", z("SCALAR", 2)],
      ["_ID UNSIGNED_BYTE", z("SCALAR", 2, 5121)],
      ["_ID UNSIGNED_SHORT", z("SCALAR", 2, 5123)],
      ["_ID normalized UNSIGNED_SHORT", z("SCALAR", 2, 5123, { normalized: true })],
    ]) {
      const r = run(instanced({ TRANSLATION: z("VEC3", 2), _ID: acc }));
      assert(instances(r.usda) === 2 && custom(r.w).length === 1, `${label}: accepted, 2 instances, 1 warning`);
    }
    {
      const r = run(instanced({ TRANSLATION: z("VEC3", 2), _COLOR: z("VEC3", 2) }));
      assert(instances(r.usda) === 2 && custom(r.w).length === 1 && custom(r.w)[0].includes('"_COLOR"'), "_COLOR FLOAT VEC3 accepted");
      assert(r.usda === run(instanced({ TRANSLATION: z("VEC3", 2) })).usda, "_COLOR leaves the USD unchanged");
    }
    rejects(instanced({ TRANSLATION: z("VEC3", 2), _ID: z("SCALAR", 2, 5125) }), new RegExp(`${W}: _ID \\(accessor 3\\) is UNSIGNED_INT, which custom attributes must not use`), "_ID UNSIGNED_INT");
    rejects(instanced({ _ID: z("SCALAR", 2, 5125) }), /_ID \(accessor 2\) is UNSIGNED_INT/, "_ID UNSIGNED_INT alone");
    rejects(instanced({ TRANSLATION: z("VEC3", 2), ID: z("SCALAR", 2) }), new RegExp(`${W}: attribute "ID" is not TRANSLATION / ROTATION / SCALE; custom attributes must start with "_"`), "custom attribute without underscore");
    rejects(instanced({ translation: z("VEC3", 2) }), /attribute "translation" is not TRANSLATION \/ ROTATION \/ SCALE/, "lower-case standard name");
    rejects(instanced({ COLOR_0: z("VEC4", 2) }), /attribute "COLOR_0" is not TRANSLATION/, "mesh attribute name on instancing");
    // The standard attributes keep their own rules (UNSIGNED_INT SCALE was already rejected as a type error).
    rejects(instanced({ SCALE: z("VEC3", 2, 5125) }), /SCALE \(accessor 2\) is UNSIGNED_INT; allowed: FLOAT/, "standard SCALE rule unchanged");
    // Custom attributes keep the reference / count / alignment checks.
    rejects(instanced({ TRANSLATION: z("VEC3", 2), _ID: 9 }), new RegExp(`${W}: _ID accessor 9 does not exist`), "custom attribute with an invalid accessor");
    rejects(instanced({ TRANSLATION: z("VEC3", 2), _ID: z("SCALAR", 3) }), /_ID \(accessor 3\) has 3 instances, TRANSLATION has 2/, "custom attribute count mismatch");
    rejects(instanced({ _ID: { bufferView: 0, componentType: 5126, count: 2, type: "SCALAR", byteOffset: 2 } }), /accessor 2 byteOffset 2 is not a multiple of its component size 4/, "misaligned custom attribute");
    rejects(instanced({ _ID: { bufferView: 1, componentType: 5123, count: 2, type: "SCALAR", byteOffset: 2 } }), /accessor 2 is an EXT_mesh_gpu_instancing attribute; its byteOffset 2 must be a multiple of 4/, "custom attribute off a 4-byte boundary");
  }
  // The instanced mesh is also used by a plain node: one prototype, referenced by every
  // GPU instance and by the plain node (instancing on), or copies (instancing: false).
  {
    const shared = instanced({ TRANSLATION: z("VEC3", 3) }, { mutate: (j) => { j.nodes.push({ name: "Plain", mesh: 0 }); j.scenes[0].nodes.push(1); } });
    const usda = accepts(shared, "instanced + shared mesh");
    const count = (sub) => usda.split(sub).length - 1;
    assert(count('def Mesh "Tri"') === 1 && count("prepend references = </Root/Meshes/Tri>") === 4 && count("instanceable = true") === 4,
      `GPU instances + plain node share one prototype: ${count('def Mesh "Tri"')} meshes, ${count("prepend references = </Root/Meshes/Tri>")} references`);
    const flat = glbToUsda(shared, { instancing: false }).usda;
    assert(flat.split('def Mesh "Tri"').length - 1 === 4 && !flat.includes("instanceable"), "instancing: false copies the mesh per instance and node");
  }
  // Omitted ROTATION / SCALE give an identity rotation and unit scale (only the translation moves).
  {
    const { bin: tb, views } = (() => {
      const t = new Float32Array([1, 0, 0, 0, 2, 0]);
      const out = new Uint8Array(bin.length + t.byteLength);
      out.set(bin); out.set(new Uint8Array(t.buffer), bin.length);
      return { bin: out, views: { buffer: 0, byteOffset: bin.length, byteLength: t.byteLength } };
    })();
    const j = clone(json);
    j.buffers[0].byteLength = tb.length;
    j.bufferViews.push(views);
    j.accessors.push({ bufferView: 2, componentType: 5126, count: 2, type: "VEC3" });
    j.nodes[0].extensions = { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 2 } } };
    const usda = accepts(makeGlb(j, tb), "translation values");
    const m = usda.match(/xformOp:transform = .*/g) || [];
    assert(m.length === 2 && m[0].endsWith("( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (1, 0, 0, 1) )") && m[1].endsWith("( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 2, 0, 1) )"),
      `instance matrices (identity rotation / unit scale, translated): ${m}`);
  }
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
