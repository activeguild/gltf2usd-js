// options.doubleSided: "attribute" (default) writes USD doubleSided; "faces" writes a reversed
// copy of each triangle with negated per-corner normals instead (Quick Look ignores doubleSided).
import { glbToUsda } from "../src/index.js";
import { makeGlb, packParts } from "./gltf-builder.js";

let failures = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); failures++; } };

/**
 * Two triangles sharing an edge (points 0..3), UVs, optional NORMAL / morph target / variants.
 * materials: glTF materials; the primitive uses material 0 unless `material` is given (null: none).
 */
function doc({ normals = true, materials = [{ name: "M", doubleSided: true }], material = 0, target = false, variants = null }) {
  const parts = [
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
    new Uint16Array([0, 1, 2, 2, 1, 3]),
    new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    new Float32Array([0, 0, 1, 0, 0, 1, 0.6, 0, 0.8, 0, 0, 1]),
    new Float32Array([0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    new Float32Array([0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  ];
  const { bin, views } = packParts(parts);
  const attributes = { POSITION: 0, TEXCOORD_0: 2, ...(normals ? { NORMAL: 3 } : {}) };
  const prim = { attributes, indices: 1, ...(material !== null ? { material } : {}) };
  if (target) prim.targets = [{ POSITION: 4, ...(normals ? { NORMAL: 5 } : {}) }];
  if (variants) prim.extensions = { KHR_materials_variants: { mappings: variants.mappings } };
  const json = {
    asset: { version: "2.0" },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ name: "Quad", primitives: [prim] }],
    materials,
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 6, type: "SCALAR" },
      { bufferView: 2, componentType: 5126, count: 4, type: "VEC2" },
      { bufferView: 3, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 4, componentType: 5126, count: 4, type: "VEC3", min: [0, 0, 0], max: [0, 0, 0.5] },
      { bufferView: 5, componentType: 5126, count: 4, type: "VEC3" },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  if (variants) {
    json.extensionsUsed = ["KHR_materials_variants"];
    json.extensions = { KHR_materials_variants: { variants: variants.names.map((name) => ({ name })) } };
  }
  return makeGlb(json, bin);
}

const convert = (glb, options = {}) => {
  const warnings = [];
  const { usda } = glbToUsda(glb, { ...options, onWarning: (w) => warnings.push(w) });
  return { usda, warnings };
};
const line = (usda, name) => usda.split("\n").find((l) => l.includes(name)) ?? "";
/** Numbers of an array attribute: `type name = [...]`. */
const values = (usda, name) => {
  const l = line(usda, ` ${name} = `);
  if (!l) return null;
  const v = l.slice(l.indexOf(" = ") + 3);
  return (v.slice(v.indexOf("[") + 1, v.lastIndexOf("]")).match(/-?[\d.e+-]+/g) ?? []).map(Number);
};
/** The interpolation metadata of an attribute (on the line after its value). */
const interpolation = (usda, name) => {
  const lines = usda.split("\n");
  const i = lines.findIndex((l) => l.includes(` ${name} = `));
  return /interpolation = "(\w+)"/.exec(lines[i + 1] ?? "")?.[1];
};
const QUICK_LOOK = "Quick Look / AR Quick Look ignore";

// Default ("attribute"): unchanged — doubleSided attribute, vertex normals, warning.
{
  const { usda, warnings } = convert(doc({}));
  assert(line(usda, "doubleSided").includes("uniform bool doubleSided = 1"), "attribute: doubleSided written");
  assert(values(usda, "faceVertexCounts").length === 2, "attribute: 2 faces");
  assert(interpolation(usda, "normals") === "vertex", "attribute: vertex normals");
  assert(warnings.some((w) => w.includes(QUICK_LOOK)), `attribute: Quick Look warning: ${warnings}`);
  const explicit = convert(doc({}), { doubleSided: "attribute" });
  assert(explicit.usda === usda, "attribute: same output as the default");
}

// "faces": front faces, then the reversed copies; normals per corner, negated on the back faces.
{
  const { usda, warnings } = convert(doc({}), { doubleSided: "faces" });
  assert(!usda.includes("doubleSided"), "faces: no doubleSided attribute");
  assert(!warnings.some((w) => w.includes(QUICK_LOOK)), `faces: no Quick Look warning: ${warnings}`);
  assert(JSON.stringify(values(usda, "faceVertexCounts")) === "[3,3,3,3]", "faces: 4 faces");
  assert(JSON.stringify(values(usda, "faceVertexIndices")) === "[0,1,2,2,1,3,0,2,1,2,3,1]", `faces: indices ${values(usda, "faceVertexIndices")}`);
  assert(interpolation(usda, "normals") === "faceVarying", "faces: faceVarying normals");
  const n = values(usda, "normals");
  const N = [[0, 0, 1], [0, 0, 1], [0.6, 0, 0.8], [0, 0, 1]];
  const expected = [0, 1, 2, 2, 1, 3].flatMap((v) => N[v])
    .concat([0, 2, 1, 2, 3, 1].flatMap((v) => N[v].map((x) => -x || 0)));
  assert(JSON.stringify(n) === JSON.stringify(expected), `faces: normals ${n}`);
  // Points and per-point primvars are shared, not duplicated.
  assert(values(usda, "points").length === 12 && values(usda, "primvars:st").length === 8, "faces: points and UVs not duplicated");
  assert(interpolation(usda, "primvars:st") === "vertex", "faces: UVs stay per point");
}

// "faces" without NORMAL: flat normals, back half negated.
{
  const { usda } = convert(doc({ normals: false }), { doubleSided: "faces" });
  const n = values(usda, "normals");
  assert(n.length === 4 * 3 * 3, `flat: ${n.length / 3} normals`);
  assert(n.slice(0, 18).every((x, i) => x === [0, 0, 1][i % 3]), "flat: front faces +Z");
  assert(n.slice(18).every((x, i) => x === [0, 0, -1][i % 3]), "flat: back faces -Z");
}

// "faces" leaves single-sided and default-material meshes alone.
{
  const single = convert(doc({ materials: [{ name: "M" }] }), { doubleSided: "faces" });
  assert(single.usda === convert(doc({ materials: [{ name: "M" }] })).usda, "faces: single-sided output unchanged");
  const none = convert(doc({ material: null, materials: [{ name: "M", doubleSided: true }] }), { doubleSided: "faces" });
  assert(values(none.usda, "faceVertexCounts").length === 2, "faces: default material is single-sided");
}

// Morph target NORMAL deltas do not apply to faceVarying normals: warning.
{
  const { usda, warnings } = convert(doc({ target: true }), { doubleSided: "faces" });
  assert(usda.includes("normalOffsets") && values(usda, "faceVertexCounts").length === 4, "morph: back faces and BlendShape");
  assert(warnings.some((w) => w.includes("morph target NORMAL deltas are not applied")), `morph: warning: ${warnings}`);
  const noNormals = convert(doc({ target: true, normals: false }), { doubleSided: "faces" });
  assert(!noNormals.warnings.some((w) => w.includes("morph target NORMAL")), "morph without NORMAL deltas: no warning");
}

// Variants: back faces when any bindable material is double-sided, with a warning when not all are.
{
  const materials = [{ name: "Single" }, { name: "Double", doubleSided: true }];
  const variants = { names: ["a", "b"], mappings: [{ material: 1, variants: [1] }] };
  const { usda, warnings } = convert(doc({ materials, variants }), { doubleSided: "faces" });
  assert(values(usda, "faceVertexCounts").length === 4, "variants: back faces");
  assert(warnings.some((w) => w.includes("only some of its material variants are double-sided")), `variants: warning: ${warnings}`);
  const all = convert(doc({ materials: [{ name: "D1", doubleSided: true }, { name: "D2", doubleSided: true }], variants }), { doubleSided: "faces" });
  assert(!all.warnings.some((w) => w.includes("only some")), "variants all double-sided: no warning");
}

// Unknown values are rejected.
{
  let error = null;
  try { convert(doc({}), { doubleSided: true }); } catch (e) { error = e; }
  assert(error && /Unknown doubleSided/.test(error.message), `invalid option: ${error}`);
}

if (failures) { console.error(`double-sided: ${failures} failure(s)`); process.exit(1); }
console.log("double-sided tests passed");
