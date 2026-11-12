// Animation and skinning edge cases: what is valid converts (and how), what is invalid
// is refused (GltfValidationError) or skipped with a warning, never silently.
import { glbToUsda, GltfValidationError } from "../src/index.js";
import { makeGlb, packParts, triangleDoc, clone } from "./gltf-builder.js";
import { buildSkinnedGlb } from "./cube-glb.js";

let failures = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); failures++; } };
const run = (glb, options = {}) => {
  const warnings = [];
  const { usda } = glbToUsda(glb, { onWarning: (w) => warnings.push(w), ...options });
  return { usda, warnings };
};
const rejects = (glb, pattern, label) => {
  try { glbToUsda(glb); } catch (e) {
    assert(e instanceof GltfValidationError, `${label}: expected GltfValidationError, got ${e.name}: ${e.message}`);
    assert(pattern.test(e.message), `${label}: "${e.message}" does not match ${pattern}`);
    return;
  }
  assert(false, `${label}: expected an error`);
};
/** The timeSamples block of an attribute, as { time: "value" }. */
function samplesOf(usda, attr) {
  const start = usda.indexOf(`${attr}.timeSamples = {`);
  if (start < 0) return null;
  const body = usda.slice(start, usda.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/^\s*([-\d.e]+): (.*),$/gm)].map((m) => [Number(m[1]), m[2]]));
}

// ---------- Animation ----------

/** Triangle node translated (or `path`) by one sampler (times / VEC3 values), optionally 2 clips. */
function animated(times, values, { interpolation = "LINEAR", second = false, path = "translation", node = {} } = {}) {
  const { json, bin: triBin } = triangleDoc();
  Object.assign(json.nodes[0], node);
  const { bin: animBin, views } = packParts([new Float32Array(times), new Float32Array(values)]);
  const bin = new Uint8Array(triBin.length + animBin.length);
  bin.set(triBin); bin.set(animBin, triBin.length);
  json.buffers[0].byteLength = bin.length;
  for (const v of views) json.bufferViews.push({ ...v, byteOffset: v.byteOffset + triBin.length });
  json.accessors.push(
    { bufferView: 2, componentType: 5126, count: times.length, type: "SCALAR" },
    { bufferView: 3, componentType: 5126, count: values.length / 3, type: "VEC3" },
  );
  const clip = (name) => ({ name, samplers: [{ input: 2, output: 3, interpolation }], channels: [{ sampler: 0, target: { node: 0, path } }] });
  json.animations = second ? [clip("First"), clip("Second")] : [clip("Move")];
  return makeGlb(json, bin);
}
const xform = { animationMode: "xform" };

{
  // Flipbook: a node at rest scale 0 that an animation scales to 1 (skeleton mode). Its rest
  // world matrix is singular, so it cannot be the rigid bind (inverse(bind) · geomBind would
  // collapse every point and the frame would never appear); the bind is the identity instead.
  // Quick Look ignores the whole skeleton when a joint scale is exactly 0, so joint scales are
  // written as at least 1e-4 (rest and samples), with one warning; the frame is still hidden at rest.
  const tiny = "( (0.0001, 0, 0, 0), (0, 0.0001, 0, 0), (0, 0, 0.0001, 0), (0, 0, 0, 1) )";
  const identity = "( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1) )";
  const { usda, warnings } = run(animated([0, 1], [0, 0, 0, 1, 1, 1], { interpolation: "STEP", path: "scale", node: { scale: [0, 0, 0] } }));
  assert(usda.includes(`uniform matrix4d[] bindTransforms = [${identity}]`), `singular rest: identity bind: ${usda.match(/bindTransforms = .*/)?.[0]}`);
  assert(usda.includes(`matrix4d primvars:skel:geomBindTransform = ${identity}`), `singular rest: identity geomBind: ${usda.match(/geomBindTransform = .*/)?.[0]}`);
  assert(usda.includes(`uniform matrix4d[] restTransforms = [${tiny}]`), `singular rest: rest scale 1e-4: ${usda.match(/restTransforms = .*/)?.[0]}`);
  const s = samplesOf(usda, "scales");
  assert(s && Object.values(s).every((v) => !v.includes("(0, 0, 0)")) && Object.values(s).includes("[(0.0001, 0.0001, 0.0001)]"),
    `singular rest: no scale 0 in samples: ${JSON.stringify(s)}`);
  assert(warnings.length === 1 && /Joint scales smaller than 0\.0001/.test(warnings[0]), `singular rest warnings: ${warnings}`);
  // xform mode keeps scale 0 (only UsdSkel output is clamped).
  const x = run(animated([0, 1], [0, 0, 0, 1, 1, 1], { path: "scale", node: { scale: [0, 0, 0] } }), xform);
  assert(samplesOf(x.usda, "xformOp:scale")?.[0] === "(0, 0, 0)" && !x.warnings.length, `xform keeps scale 0: ${x.warnings}`);
}
{
  // A negative tiny scale keeps its sign; normal scales are untouched (no warning).
  const { usda, warnings } = run(animated([0, 1], [-1e-6, 1, 1, 1, 1, 1], { path: "scale" }));
  assert(samplesOf(usda, "scales")?.[0] === "[(-0.0001, 1, 1)]", `negative tiny scale: ${JSON.stringify(samplesOf(usda, "scales"))}`);
  assert(warnings.length === 1, `negative tiny scale warnings: ${warnings}`);
  assert(!run(animated([0, 1], [1, 1, 1, 2, 2, 2], { path: "scale" })).warnings.length, "regular scale: no warning");
}
{
  // glTF skins are clamped too: a skin joint at rest scale 0.
  const glb = buildSkinnedGlb();
  const n = new DataView(glb.buffer, glb.byteOffset).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + n)));
  const bin = glb.subarray(20 + n + 8);
  json.nodes.find((nd) => nd.name === "Upper").scale = [0, 0, 0];
  const { usda, warnings } = run(makeGlb(json, bin));
  const rest = usda.match(/restTransforms = .*/)?.[0] ?? "";
  assert(rest.includes("(0.0001, 0, 0, 0)") && !rest.includes("(0, 0, 0, 0)"), `skin joint scale 0: ${rest}`);
  assert(warnings.some((w) => /Joint scales smaller/.test(w)), `skin joint scale 0 warnings: ${warnings}`);
}
{
  // A regular animated node keeps its rest world matrix as bind and geomBind.
  const { usda } = run(animated([0, 1], [0, 0, 0, 1, 0, 0], { node: { scale: [2, 2, 2] } }));
  const m = "( (2, 0, 0, 0), (0, 2, 0, 0), (0, 0, 2, 0), (0, 0, 0, 1) )";
  assert(usda.includes(`bindTransforms = [${m}]`) && usda.includes(`geomBindTransform = ${m}`), "regular rest: world matrix bind");
}

{
  // One keyframe: a single time sample, start = end.
  const { usda, warnings } = run(animated([0.5], [1, 2, 3]), xform);
  const s = samplesOf(usda, "xformOp:translate");
  assert(s && Object.keys(s).length === 1 && s[12] === "(1, 2, 3)", `one key: ${JSON.stringify(s)}`);
  assert(usda.includes("startTimeCode = 12") && usda.includes("endTimeCode = 12"), "one key: zero-length range");
  assert(!warnings.length, `one key warnings: ${warnings}`);
}
{
  // Duration 0 with several keys at the same time: the last value is kept, with a warning.
  const { usda, warnings } = run(animated([0, 0, 0], [1, 0, 0, 2, 0, 0, 3, 0, 0]), xform);
  const s = samplesOf(usda, "xformOp:translate");
  assert(s && Object.keys(s).length === 1 && s[0] === "(3, 0, 0)", `zero duration: ${JSON.stringify(s)}`);
  assert(warnings.some((w) => w.includes("repeats key times")), `zero duration warning: ${warnings}`);
}
{
  // Repeated time inside the range (a jump): keys 0, 1, 1, 2 → the second value at 1.
  const { usda } = run(animated([0, 1, 1, 2], [0, 0, 0, 1, 0, 0, 5, 0, 0, 6, 0, 0]), xform);
  const s = samplesOf(usda, "xformOp:translate");
  assert(s && s[24] === "(5, 0, 0)" && Object.keys(s).length === 3, `jump: ${JSON.stringify(s)}`);
}
{
  // Decreasing times: the channel is skipped with a warning (no out-of-order samples).
  const { usda, warnings } = run(animated([0, 2, 1], [0, 0, 0, 1, 0, 0, 2, 0, 0]), xform);
  assert(!samplesOf(usda, "xformOp:translate"), "decreasing times: no samples written");
  assert(warnings.some((w) => /skipped: key times are not increasing \(key 2: 1 after 2\)/.test(w)), `decreasing warning: ${warnings}`);
}
{
  // NaN / Infinity: skipped with a warning.
  const nan = run(animated([0, 1], [0, 0, 0, NaN, 0, 0]), xform);
  assert(!samplesOf(nan.usda, "xformOp:translate") && nan.warnings.some((w) => /output value 3 is NaN/.test(w)), `NaN value: ${nan.warnings}`);
  const inf = run(animated([0, Infinity], [0, 0, 0, 1, 0, 0]), xform);
  assert(inf.warnings.some((w) => /key time 1 is Infinity/.test(w)), `Infinity time: ${inf.warnings}`);
}
{
  // Output count mismatch (CUBICSPLINE needs 3 values per key): skipped with a warning.
  const { warnings } = run(animated([0, 1], [0, 0, 0, 1, 0, 0], { interpolation: "CUBICSPLINE" }), xform);
  assert(warnings.some((w) => /output has 6 values for 2 keys \(CUBICSPLINE\)/.test(w)), `cubic count: ${warnings}`);
}
{
  // STEP: each value is held until just before the next key.
  const { usda } = run(animated([0, 1, 2], [0, 0, 0, 1, 0, 0, 2, 0, 0], { interpolation: "STEP" }), xform);
  const s = samplesOf(usda, "xformOp:translate");
  assert(s[0] === "(0, 0, 0)" && s[23.999] === "(0, 0, 0)" && s[24] === "(1, 0, 0)" && s[47.999] === "(1, 0, 0)" && s[48] === "(2, 0, 0)", `STEP: ${JSON.stringify(s)}`);
  assert(Object.keys(s).length === 5, "STEP: nothing after the last key");
}
{
  // LINEAR: keys as-is.
  const s = samplesOf(run(animated([0, 1], [0, 0, 0, 4, 0, 0]), xform).usda, "xformOp:translate");
  assert(Object.keys(s).length === 2 && s[24] === "(4, 0, 0)", `LINEAR: ${JSON.stringify(s)}`);
}
{
  // CUBICSPLINE with zero tangents: frames baked, value at the last key exact, nothing after it.
  const v = (x) => [0, 0, 0, x, 0, 0, 0, 0, 0]; // in-tangent, value, out-tangent
  const s = samplesOf(run(animated([0, 0.5], [...v(0), ...v(1)], { interpolation: "CUBICSPLINE" }), xform).usda, "xformOp:translate");
  const times = Object.keys(s).map(Number).sort((a, b) => a - b);
  assert(times[0] === 0 && times.at(-1) === 12 && times.length === 13, `CUBICSPLINE frames: ${times}`);
  assert(s[12] === "(1, 0, 0)" && s[6] === "(0.5, 0, 0)", `CUBICSPLINE values: ${s[6]} ${s[12]}`);
  // Last key at a non-frame time (0.51 s = 12.24 frames): frame 12 is baked, then the key itself.
  const s2 = samplesOf(run(animated([0, 0.51], [...v(0), ...v(1)], { interpolation: "CUBICSPLINE" }), xform).usda, "xformOp:translate");
  const t2 = Object.keys(s2).map(Number).sort((a, b) => a - b);
  assert(t2.at(-2) === 12 && t2.at(-1) === 12.24 && s2[12.24] === "(1, 0, 0)", `CUBICSPLINE end: ${t2.slice(-3)}`);
}
{
  // Multiple clips: one is converted (default the first, or options.animation), the rest warned.
  const glb = animated([0, 1], [0, 0, 0, 1, 0, 0], { second: true });
  const first = run(glb, xform);
  assert(first.warnings.some((w) => w.includes('only animation "First" is converted (skipped: Second)')), `two clips: ${first.warnings}`);
  const second = run(glb, { ...xform, animation: "Second" });
  assert(second.warnings.some((w) => w.includes('only animation "Second" is converted (skipped: First)')), "options.animation picks a clip");
  const missing = run(glb, { ...xform, animation: "Nope" });
  assert(missing.warnings.some((w) => w.includes('Animation "Nope" not found; using animation 0')), "unknown clip name warns");
}
{
  // The default (skeleton) mode writes the same animation as a rigid skeleton.
  const { usda } = run(animated([0, 1], [0, 0, 0, 4, 0, 0]));
  assert(usda.includes("def SkelAnimation") && usda.includes("translations.timeSamples"), "skeleton mode");
}

// ---------- Skinning ----------

/**
 * Two-joint skin on a triangle: joints = nodes 1 (Root) and 2 (Child, under a non-joint
 * node 3 "Between"); JOINTS_0 / WEIGHTS_0 per vertex as given.
 */
function skinned(joints, weights, { ibmCount = 2, jointsType = 5121, mutate } = {}) {
  const { json, bin: triBin } = triangleDoc();
  const ibm = new Float32Array(16 * ibmCount);
  for (let i = 0; i < ibmCount; i++) ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, i === 1 ? -1 : 0, 0, 1], i * 16);
  const J = jointsType === 5121 ? new Uint8Array(joints) : new Float32Array(joints);
  const { bin: skinBin, views } = packParts([J, new Float32Array(weights), ibm]);
  const bin = new Uint8Array(triBin.length + skinBin.length);
  bin.set(triBin); bin.set(skinBin, triBin.length);
  json.buffers[0].byteLength = bin.length;
  for (const v of views) json.bufferViews.push({ ...v, byteOffset: v.byteOffset + triBin.length });
  json.accessors.push(
    { bufferView: 2, componentType: jointsType, count: 3, type: "VEC4" },
    { bufferView: 3, componentType: 5126, count: 3, type: "VEC4" },
    { bufferView: 4, componentType: 5126, count: ibmCount, type: "MAT4" },
  );
  json.meshes[0].primitives[0].attributes.JOINTS_0 = 2;
  json.meshes[0].primitives[0].attributes.WEIGHTS_0 = 3;
  json.nodes[0].skin = 0;
  json.nodes.push({ name: "Root", children: [3] }, { name: "Child", translation: [0, 1, 0] }, { name: "Between", translation: [0, 0.5, 0], children: [2] });
  json.scenes[0].nodes.push(1);
  json.skins = [{ joints: [1, 2], inverseBindMatrices: 4 }];
  mutate?.(json);
  return makeGlb(json, bin);
}
const J = [0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0];
const W = [0.5, 0.5, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
{
  // Valid; the non-joint node between the joints is folded into the child's rest transform.
  const { usda, warnings } = run(skinned(J, W));
  assert(usda.includes('uniform token[] joints = ["Root", "Root/Child"]'), "joint hierarchy through a non-joint node");
  assert(usda.includes("(0, 1.5, 0, 1) )]"), `child rest includes the in-between node: ${usda.match(/restTransforms = .*/)?.[0]}`);
  assert(!warnings.length, `valid skin warnings: ${warnings}`);
}
rejects(skinned([0, 2, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0], W), /JOINTS_0 of vertex 0 is 2, but the skin has 2 joints/, "JOINTS_0 out of range");
// An out-of-range index with weight 0 is harmless (unused slot).
assert(run(skinned([0, 1, 9, 0, 0, 1, 0, 0, 1, 0, 0, 0], W)).usda.includes("primvars:skel:jointIndices"), "unused slot may hold any index");
rejects(skinned(J, [0.5, 0.5, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0]), /WEIGHTS_0 of vertex 1 is -1/, "negative weight");
rejects(skinned(J, [0.5, NaN, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), /WEIGHTS_0 of vertex 0 is NaN/, "NaN weight");
// FLOAT joints are not allowed at all (UNSIGNED_BYTE / UNSIGNED_SHORT only; validate.js).
rejects(skinned([0, 1.5, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0], W, { jointsType: 5126 }), /JOINTS_0 \(accessor 2\) is FLOAT; allowed: UNSIGNED_BYTE, UNSIGNED_SHORT/, "FLOAT joint indices");
{
  const unweighted = run(skinned(J, [0.5, 0.5, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]));
  assert(unweighted.warnings.some((w) => /1 vertices have no joint weight/.test(w)), `zero weights: ${unweighted.warnings}`);
  const unnormalized = run(skinned(J, [0.5, 0.2, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
  assert(unnormalized.warnings.some((w) => /1 vertices have joint weights not summing to 1/.test(w)), `sum != 1: ${unnormalized.warnings}`);
}
rejects(skinned(J, W, { ibmCount: 1 }), /skin 0: inverseBindMatrices has 1 matrices for 2 joints/, "IBM count < joints");
rejects(skinned(J, W, { mutate: (j) => { j.skins[0].joints = [1, 7]; } }), /skin 0: joint node 7 does not exist/, "joint node missing");
rejects(skinned(J, W, { mutate: (j) => { j.nodes[0].skin = 4; } }), /node 0: skin 4 does not exist/, "skin missing");
rejects(skinned(J, W, { mutate: (j) => { j.nodes.push({ skin: 0 }); } }), /node 4: has a skin but no mesh/, "skin without mesh");
{
  // A deeper hierarchy: a third joint two levels below Child, through the non-joint "Hip".
  const glb = skinned(J, W, { ibmCount: 3, mutate: (j) => {
    j.nodes.push({ name: "Hip", children: [5] }, { name: "Grip", translation: [1, 0, 0] });
    j.nodes[2].children = [4];
    j.skins[0].joints = [5, 1, 2]; // child listed first: the skeleton reorders parent-first
  } });
  const { usda, warnings } = run(glb);
  assert(usda.includes('uniform token[] joints = ["Root", "Root/Child", "Root/Child/Grip"]'), `three-level joints: ${usda.match(/token\[\] joints = .*/)?.[0]}`);
  // Skin joints [Grip, Root, Child] → skeleton [Root, Child, Grip]: 0 → 2, 1 → 0, 2 → 1.
  // Vertex 0 = (Grip 0.5, Root 0.5), vertex 1 = Grip, vertex 2 = Root.
  assert(usda.includes("int[] primvars:skel:jointIndices = [2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]"), `remapped indices: ${usda.match(/jointIndices = .*/)?.[0]}`);
  assert(!warnings.length, `three-level warnings: ${warnings}`);
}

if (failures) { console.error(`edge cases: ${failures} failure(s)`); process.exit(1); }
console.log("edge case tests passed");
