import { readFileSync } from "node:fs";
import { glbToUsda, glbToUsdz, toUsda, toUsdz } from "../src/index.js";
import * as api from "../src/index.js";
import { buildCubeGltf } from "./cube-glb.js";
import { decodeMeshopt } from "../src/meshopt.js";
import { VECTORS, CUBE_VIEWS } from "./meshopt-vectors.js";
import { KHR_VECTORS } from "./meshopt-khr-vectors.js";
import { fmt } from "../src/usda.js";
import { crc32 } from "../src/usdz.js";

const glb = readFileSync(new URL("./cube.glb", import.meta.url));
const { usda, files } = glbToUsda(glb);
const usdz = glbToUsdz(glb);

const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
assert(usda.startsWith("#usda 1.0"), "usda header");
assert(usda.includes('def Mesh "Cube"'), "mesh prim");
assert(usda.includes("rel material:binding = </Root/Materials/Red_Mat>"), "material binding");
assert(usda.includes('def Shader "Texture_baseColor"'), "texture shader");
assert(files.length === 1 && files[0].name === "textures/red.png", "texture file");

// Verify zip alignment: walk local file headers.
const dv = new DataView(usdz.buffer, usdz.byteOffset, usdz.byteLength);
let off = 0, n = 0;
while (dv.getUint32(off, true) === 0x04034b50) {
  const size = dv.getUint32(off + 18, true);
  const nameLen = dv.getUint16(off + 26, true);
  const extraLen = dv.getUint16(off + 28, true);
  const dataStart = off + 30 + nameLen + extraLen;
  assert(dataStart % 64 === 0, `entry ${n} not 64-byte aligned (${dataStart})`);
  off = dataStart + size; n++;
}
assert(n === 2, "two entries");

// ---- Instancing: the cube mesh is used by two nodes ----
const count = (s, sub) => s.split(sub).length - 1;
assert(usda.includes('class Xform "Meshes"'), "prototype scope is a class");
assert(count(usda, 'def Mesh "Cube"') === 1, "shared mesh written once");
assert(count(usda, "instanceable = true") === 2 && count(usda, "prepend references = </Root/Meshes/Cube>") === 2, "two instances");
const flat = glbToUsda(glb, { instancing: false }).usda;
assert(!flat.includes("Meshes") && count(flat, 'def Mesh "Cube"') === 2 && !flat.includes("instanceable"), "instancing: false duplicates");

// ---- Stage 2 features (test/features.glb) ----
const features = readFileSync(new URL("./features.glb", import.meta.url));
const warnings = [];
const f = glbToUsda(features, { onWarning: (msg) => warnings.push(msg) });

// Image name collisions → distinct file names, each referenced once.
assert(f.files.map((x) => x.name).join() === "textures/tex.png,textures/tex_1.png,textures/quadrants.png", `deduped image names: ${f.files.map((x) => x.name)}`);
assert(f.usda.includes("@textures/tex.png@") && f.usda.includes("@textures/tex_1.png@"), "both textures referenced");

// Sampler wrap modes.
const matA = f.usda.slice(f.usda.indexOf('def Material "A"'), f.usda.indexOf('def Material "B"'));
const matB = f.usda.slice(f.usda.indexOf('def Material "B"'), f.usda.indexOf('def Material "C"'));
const matC = f.usda.slice(f.usda.indexOf('def Material "C"'), f.usda.indexOf('def Material "D"'));
const matD = f.usda.slice(f.usda.indexOf('def Material "D"'), f.usda.indexOf('def Material "E"'));
assert(matA.includes('token inputs:wrapS = "clamp"') && matA.includes('token inputs:wrapT = "mirror"'), "CLAMP_TO_EDGE / MIRRORED_REPEAT");
assert(matB.includes('token inputs:wrapS = "repeat"') && matB.includes('token inputs:wrapT = "repeat"'), "default sampler = repeat");

// TEXCOORD_1 → primvars:st1 on the mesh, and a dedicated reader in the material.
const meshC = f.usda.slice(f.usda.indexOf('def Mesh "CubeC"'), f.usda.indexOf('def Xform "Transformed"'));
assert(meshC.includes("texCoord2f[] primvars:st = [") && meshC.includes("texCoord2f[] primvars:st1 = ["), "mesh writes st and st1");
assert(meshC.includes("primvars:st1 = [(0, 1), (0.5, 1), (0.5, 0.5), "), "st1 is V-flipped TEXCOORD_1");
assert(matC.includes('string inputs:varname = "st1"') && !matC.includes('def Shader "uvReader_st"\n'), "material C reads st1 only");
assert(matC.includes("inputs:st.connect = </Root/Materials/C/uvReader_st1.outputs:result>"), "texture C connected to st1");

// KHR_texture_transform → UsdTransform2d between reader and texture.
assert(matD.includes('uniform token info:id = "UsdTransform2d"'), "Transform2d shader");
assert(matD.includes("float2 inputs:in.connect = </Root/Materials/D/uvReader_st.outputs:result>"), "Transform2d input");
assert(matD.includes("inputs:st.connect = </Root/Materials/D/Transform2d_baseColor.outputs:result>"), "texture reads transformed st");
assert(matD.includes("float inputs:rotation = 28.64789"), "rotation in degrees");
assert(matD.includes("float2 inputs:scale = (1.5, 0.75)"), "scale");
// translation = (0.25 + sin(0.5) * 0.75, 1 - 0.1 - cos(0.5) * 0.75)
assert(matD.includes("float2 inputs:translation = (0.6095692, 0.2418131)"), "translation converted to USD st space");
assert(!matA.includes("UsdTransform2d"), "no transform without the extension");

// KHR_materials_* with UsdPreviewSurface inputs.
const matE = f.usda.slice(f.usda.indexOf('def Material "E"'));
assert(matE.includes("color3f inputs:emissiveColor = (1, 0.5, 0)"), "emissive_strength multiplies emissiveFactor");
assert(matE.includes("float inputs:ior = 1.33"), "ior");
assert(matE.includes("float inputs:clearcoat = 0.8"), "clearcoat factor");
assert(matE.includes("float inputs:clearcoatRoughness.connect = </Root/Materials/E/Texture_clearcoatRoughness.outputs:g>"), "clearcoat roughness texture (G)");
assert(matE.includes("float4 inputs:scale = (0.5, 0.5, 0.5, 1)"), "clearcoat roughness factor as texture scale");
assert(!matD.includes("inputs:ior") && !matD.includes("clearcoat"), "no ior / clearcoat without the extensions");
assert(matE.includes("float inputs:opacity = 0.5"), "transmission 0.5 → opacity 0.5 (OPAQUE becomes translucent)");
assert(!matD.includes("inputs:opacity"), "no opacity without transmission");
assert(warnings.some((w) => w.includes("KHR_materials_transmission is approximated as opacity")), "transmission approximation is reported");
for (const e of ["emissive_strength", "KHR_materials_ior", "KHR_materials_clearcoat", "KHR_materials_transmission is not supported"]) {
  assert(!warnings.some((w) => w.includes(e)), `no warning for supported ${e}`);
}

// Warnings: unsupported extension, skipped LINES primitive; each reported once.
assert(warnings.some((w) => w.includes("KHR_materials_sheen is not supported")), "warns about unsupported extension");
// KHR_lights_punctual → UsdLux
const lightBlock = (node) => f.usda.slice(f.usda.indexOf(`def Xform "${node}"`), f.usda.indexOf("}", f.usda.indexOf(`def Xform "${node}"`) + 200));
assert(lightBlock("SunNode").includes('def DistantLight "Sun"') && lightBlock("SunNode").includes("float inputs:intensity = 2"), "directional → DistantLight");
assert(lightBlock("BulbNode").includes('def SphereLight "Bulb"') && lightBlock("BulbNode").includes("bool treatAsPoint = 1"), "point → SphereLight (treatAsPoint)");
assert(lightBlock("ConeNode").includes('prepend apiSchemas = ["ShapingAPI"]') && lightBlock("ConeNode").includes("float inputs:shaping:cone:angle = 28.64789"), "spot → ShapingAPI cone (degrees)");
assert(lightBlock("ConeNode").includes("float inputs:shaping:cone:softness = 0.6"), "spot softness = (outer - inner) / outer");
assert(warnings.some((m) => m.includes('Light "Bulb": range')), "range is reported");
assert(!warnings.some((m) => m.includes("KHR_lights_punctual")), "lights extension is supported");

// KHR_materials_unlit (material B): black diffuse, base color as emission, ior 1.
assert(!warnings.some((w) => w.includes("KHR_materials_unlit")), "unlit is supported");
assert(matB.includes("color3f inputs:diffuseColor = (0, 0, 0)") && matB.includes("color3f inputs:emissiveColor.connect = </Root/Materials/B/Texture_baseColor.outputs:rgb>"), "unlit: emission from base color");
assert(matB.includes("float inputs:ior = 1") && matB.includes("float inputs:roughness = 1"), "unlit: no Fresnel reflection");
assert(!warnings.some((w) => w.includes("KHR_texture_transform") || w.includes("TEXCOORD")), `no warning for supported UV features: ${warnings}`);
assert(warnings.some((w) => w.includes("LINES")), "warns about LINES primitive");
assert(new Set(warnings).size === warnings.length, "warnings are deduplicated");
assert(!f.usda.includes('"CubeB_1"'), "LINES primitive not written");

// No onWarning → no throw, same output.
assert(glbToUsda(features).usda === f.usda, "onWarning does not change output");

// No mesh is shared in features.glb → no prototypes.
assert(!f.usda.includes("Meshes"), "no prototypes without shared meshes");
// Mesh prim and child node share a namespace.
assert(f.usda.includes('def Mesh "CubeC"') && f.usda.includes('def Xform "CubeC_1"'), "mesh / child name collision resolved");

// ---- .gltf with external files ----
{
  const { gltf, resources } = buildCubeGltf();
  // Same content as cube.glb, so the output must be identical.
  const fromGltf = glbToUsda(gltf, { resources });
  assert(fromGltf.usda === usda, ".gltf text + resources object == GLB output");
  assert(fromGltf.files.length === 1 && fromGltf.files[0].name === "textures/red.png", "external image packaged (sniffed PNG)");
  assert(glbToUsda(new TextEncoder().encode(gltf), { resources: new Map(Object.entries(resources)) }).usda === usda, ".gltf bytes + Map");
  assert(glbToUsda(JSON.parse(gltf), { resources: (uri) => resources[uri] }).usda === usda, "glTF object + resolver function");
  // Browser drops are flat: bare file names must resolve too.
  const flat = { "cube.bin": resources["cube.bin"], "red png.png": resources["textures/red png.png"] };
  assert(glbToUsda(gltf, { resources: flat }).files.length === 1, "bare file name fallback");

  // Missing buffer → clear error; missing image → warning, no texture.
  let err = null;
  try { glbToUsda(gltf); } catch (e) { err = e; }
  assert(err && err.message.includes('"cube.bin" was not provided'), `missing buffer error: ${err?.message}`);
  const w = [];
  const noImage = glbToUsda(gltf, { resources: { "cube.bin": resources["cube.bin"] }, onWarning: (m) => w.push(m) });
  assert(noImage.files.length === 0 && w.some((m) => m.includes("textures/red%20png.png")), "missing image is a warning");

  let notGltf = null;
  try { glbToUsda(new TextEncoder().encode("hello")); } catch (e) { notGltf = e; }
  assert(notGltf?.message.includes("neither a GLB nor glTF"), "garbage input error");
}

// ---- Stage 3: animation as xformOp timeSamples (animationMode: "xform") ----
{
  const animGlb = readFileSync(new URL("./animated.glb", import.meta.url));
  const w = [];
  const a = glbToUsda(animGlb, { onWarning: (m) => w.push(m), animationMode: "xform" }).usda;
  const block = (name) => a.slice(a.indexOf(`def Xform "${name}"`), a.indexOf("xformOpOrder", a.indexOf(`def Xform "${name}"`)));
  for (const [k, v] of [["startTimeCode", 0], ["endTimeCode", 48], ["timeCodesPerSecond", 24], ["framesPerSecond", 24]]) {
    assert(a.includes(`    ${k} = ${v}\n`), `layer ${k} = ${v}`);
  }
  // LINEAR translation: keys as-is, seconds × 24.
  assert(block("Slide").includes("double3 xformOp:translate.timeSamples = {\n                0: (0, 0, 0),\n                24: (0, 0, 1),\n                48: (0, 0, 0),\n            }"), "LINEAR translate samples");
  assert(block("Slide").includes("quatf xformOp:orient = (1, 0, 0, 0)") && block("Slide").includes("float3 xformOp:scale = (1, 1, 1)"), "static channels keep node TRS");
  // LINEAR rotation: quatf (w, x, y, z), 120° about Y at 1 s.
  assert(block("Spin").includes("24: (0.5, 0, 0.8660254, 0),"), "orient samples are (w, x, y, z)");
  assert(block("Spin").includes("double3 xformOp:translate = (1.5, 0, 0)"), "static translate of an animated node");
  // STEP: each key held until just before the next one.
  assert(block("Pulse").includes("11.999: (1, 1, 1),\n                12: (1.5, 1.5, 1.5),\n                35.999: (1.5, 1.5, 1.5),"), "STEP held keys");
  // CUBICSPLINE: baked per frame; peak 1 at 1 s; Hermite value at frame 12 (0.5 s) = 0.875.
  const bounce = block("Bounce");
  assert(count(bounce, ": (4.5, ") === 49, `CUBICSPLINE baked at 49 frames (got ${count(bounce, ": (4.5, ")})`);
  assert(bounce.includes("12: (4.5, 0.875, 0),") && bounce.includes("24: (4.5, 1, 0),"), "CUBICSPLINE Hermite values");
  // Non-animated documents have no time metadata; animated nodes don't use matrices.
  assert(!usda.includes("TimeCode"), "no time metadata without animation");
  assert(!block("Slide").includes("xformOp:transform"), "animated node uses TRS ops");
  // Warnings: second animation skipped, weights channel skipped.
  assert(w.some((m) => m.includes('only animation "Main"') && m.includes("Unused")), "warns about skipped animations");
  assert(w.some((m) => m.includes("weights")), "warns about weights channel");
  // options.animation selects another clip.
  const unused = glbToUsda(animGlb, { animation: "Unused", animationMode: "xform" }).usda;
  assert(unused.includes('def Xform "Spin"') && !unused.includes("xformOp:orient.timeSamples") && unused.includes("double3 xformOp:translate.timeSamples"), "options.animation by name");
}

// ---- Node animation as skeletal animation (default animationMode: "skeleton") ----
{
  const animGlb = readFileSync(new URL("./animated.glb", import.meta.url));
  const s = glbToUsda(animGlb).usda;
  const skelRoot = s.slice(s.indexOf('def Xform "Animated"'), s.indexOf('def Scope "Materials"'));
  assert(s.includes('kind = "component"'), "root prim is a component model");
  assert(skelRoot && !s.slice(s.indexOf('def Xform "Scene"'), s.indexOf('def Xform "Animated"')).includes("Slide"), "animated nodes leave /Root/Scene");
  assert(skelRoot.includes('uniform token[] joints = ["Slide", "Spin", "Pulse", "Bounce"]'), "one joint per animated node");
  assert(skelRoot.includes("rel skel:animationSource = </Root/Animated/Skeleton/Animation>") && skelRoot.includes("quatf[] rotations.timeSamples"), "SkelAnimation drives the joints");
  assert(skelRoot.includes("primvars:skel:jointIndices = [3, 3, 3,") && skelRoot.includes("primvars:skel:jointWeights = [1, 1, 1,"), "meshes bound rigidly (every point on its node's joint)");
  assert(s.includes('def SkelRoot "Root"') && count(s, "def SkelRoot") === 1, "/Root is the single SkelRoot");
  assert(skelRoot.includes("matrix4d primvars:skel:geomBindTransform = ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (4.5, 0, 0, 1) )"), "geomBind = node rest world");
  assert(!s.includes("xformOp:translate.timeSamples") && !s.includes("instanceable"), "no xformOp animation, no instancing of animated meshes");
}

// ---- glTF defaults: flat normals and the default material ----
{
  const { gltf, resources } = buildCubeGltf();
  const j = JSON.parse(gltf);
  delete j.meshes[0].primitives[0].attributes.NORMAL;
  delete j.meshes[0].primitives[0].material;
  const d = glbToUsda(j, { resources }).usda;
  assert(d.includes('interpolation = "faceVarying"') && d.includes("normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1),"), "flat normals when NORMAL is missing");
  assert(d.includes("rel material:binding = </Root/Materials/DefaultMaterial>") && d.includes('def Material "DefaultMaterial"'), "default material bound");
  const dm = d.slice(d.indexOf('def Material "DefaultMaterial"'));
  assert(dm.includes("color3f inputs:diffuseColor = (1, 1, 1)") && dm.includes("float inputs:metallic = 1") && dm.includes("float inputs:roughness = 1"), "glTF default material values");
  assert(!usda.includes("DefaultMaterial"), "no default material when every primitive has one");
}

// ---- Stage 4: skins and morph targets (test/skinned.glb) ----
{
  const w = [];
  const k = glbToUsda(readFileSync(new URL("./skinned.glb", import.meta.url)), { onWarning: (m) => w.push(m) }).usda;
  // Sections are searched from `base` on (the Blob's own Skeleton comes first in the file).
  const rigAt = k.indexOf('def Xform "Skin_Rig"');
  const section = (from, to, base = rigAt) => {
    const i = k.indexOf(from, base);
    return k.slice(i, to ? k.indexOf(to, i) : undefined);
  };
  const skel = section('def Skeleton "Skeleton"', "def SkelAnimation");
  const bar = section('def Mesh "Bar"', 'def BlendShape "Bulge"');
  assert(k.includes('def Scope "Skins"') && k.includes('def Xform "Skin_Rig"') && k.includes('def SkelRoot "Root"') && count(k, "def SkelRoot") === 1, "skins under the single /Root SkelRoot");
  // Parent-first joint order even though skin.joints lists the child first.
  assert(skel.includes('uniform token[] joints = ["Lower", "Lower/Upper"]'), "joint tokens parent-first");
  // bindTransforms = inverse(IBM); rest of the root joint includes the non-joint Armature translation.
  assert(skel.includes("bindTransforms = [( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0.5, 0, 0, 1) ), ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0.5, 1, 0, 1) )]"), "bindTransforms");
  assert(skel.includes("restTransforms = [( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0.5, 0, 0, 1) ), ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 1, 0, 1) )]"), "restTransforms (root includes Armature)");
  assert(skel.includes("rel skel:animationSource = </Root/Skins/Skin_Rig/Skeleton/Animation>"), "animation source");
  // Joint indices remapped to skeleton order; zero-weight slots point at joint 0.
  assert(bar.includes("primvars:skel:jointIndices = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0,"), "jointIndices remapped");
  assert(bar.includes("elementSize = 4") && bar.includes('prepend apiSchemas = ["SkelBindingAPI", "MaterialBindingAPI"]'), "elementSize / SkelBindingAPI (+ default material)");
  assert(bar.includes("rel skel:skeleton = </Root/Skins/Skin_Rig/Skeleton>"), "mesh bound to skeleton");
  assert(!section('def Xform "BarNode"', 'def Xform "Blob"', 0).includes("def Mesh"), "skinned mesh is not left under its node");
  // Sparse morph target on the skinned mesh, driven by the shared SkelAnimation.
  const bulge = section('def BlendShape "Bulge"', "}");
  assert(bulge.includes("uniform int[] pointIndices = [8, 9, 10, 11]") && bulge.includes("uniform vector3f[] offsets = [(-0.3, 0, -0.3),"), "sparse BlendShape");
  assert(bar.includes('uniform token[] skel:blendShapes = ["Bar_Bulge"]') && bar.includes("rel skel:blendShapeTargets = </Root/Skins/Skin_Rig/Bar/Bulge>"), "mesh blend shape list");
  const anim = section('def SkelAnimation "Animation"', 'def Mesh "Bar"');
  assert(anim.includes('uniform token[] blendShapes = ["Bar_Bulge"]') && anim.includes("24: [1],"), "animated blend shape weights");
  assert(anim.includes('uniform token[] joints = ["Lower", "Lower/Upper"]') && anim.includes("quatf[] rotations.timeSamples"), "joint animation");
  // Morph-only node: its own SkelRoot with a joint-less Skeleton and a static weight.
  const blob = section('def Xform "Blob"', 'def Scope "Skins"', 0);
  assert(blob.includes('def Xform "BlobMesh"') && blob.includes("uniform token[] joints = []"), "morph-only SkelRoot");
  assert(blob.includes("float[] blendShapeWeights = [0.25]") && !blob.includes("timeSamples"), "static blend shape weight");
  assert(w.length === 0, `no warnings for skinned.glb: ${w}`);
}

// ---- EXT_mesh_gpu_instancing: one prim per instance (instanceable when instancing is on) ----
{
  const { gltf, resources } = buildCubeGltf();
  const j = JSON.parse(gltf);
  const T = new Float32Array([0, 0, 0, 2, 0, 0, 4, 0, 0]);
  const S3 = new Float32Array([1, 1, 1, 0.5, 0.5, 0.5, 1, 2, 1]);
  const bytes = new Uint8Array([...new Uint8Array(T.buffer), ...new Uint8Array(S3.buffer)]);
  j.buffers.push({ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...bytes))}` });
  j.bufferViews.push({ buffer: 1, byteOffset: 0, byteLength: 36 }, { buffer: 1, byteOffset: 36, byteLength: 36 });
  j.accessors.push({ bufferView: j.bufferViews.length - 2, componentType: 5126, count: 3, type: "VEC3" });
  j.accessors.push({ bufferView: j.bufferViews.length - 1, componentType: 5126, count: 3, type: "VEC3" });
  j.extensionsUsed = ["EXT_mesh_gpu_instancing"];
  j.nodes = [{ name: "Grid", mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: j.accessors.length - 2, SCALE: j.accessors.length - 1 } } } }];
  const w = [];
  const g = glbToUsda(j, { resources, onWarning: (m) => w.push(m) }).usda;
  assert(count(g, "prepend references = </Root/Meshes/Cube>") === 3 && count(g, 'def Mesh "Cube"') === 1, "3 instances of one prototype");
  assert(g.includes("matrix4d xformOp:transform = ( (0.5, 0, 0, 0), (0, 0.5, 0, 0), (0, 0, 0.5, 0), (2, 0, 0, 1) )"), "instance T · S");
  assert(g.includes('def Xform "Cube_2"') && w.length === 0, `instance names / no warnings: ${w}`);
  const flatInst = glbToUsda(j, { resources, instancing: false }).usda;
  assert(count(flatInst, 'def Mesh "Cube"') === 3 && !flatInst.includes("instanceable"), "instancing: false copies the mesh per instance");
}

// ---- KHR_materials_variants → variantSet "materialVariant" on /Root ----
{
  const { gltf, resources } = buildCubeGltf();
  const j = JSON.parse(gltf);
  j.extensionsUsed = ["KHR_materials_variants"];
  j.extensions = { KHR_materials_variants: { variants: [{ name: "Red Look" }, { name: "Blue" }] } };
  j.materials.push({ name: "Blue", pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1] } });
  j.meshes[0].primitives[0].extensions = { KHR_materials_variants: { mappings: [{ material: 1, variants: [1] }] } };
  const w = [];
  const v = glbToUsda(j, { resources, onWarning: (m) => w.push(m) }).usda;
  const at = (name) => v.slice(v.indexOf(`"${name}" {`), v.indexOf("\n        }", v.indexOf(`"${name}" {`)));
  assert(v.includes('prepend variantSets = ["materialVariant"]') && v.includes('string materialVariant = "default"'), "variantSet with default selection");
  assert(v.includes('variantSet "materialVariant" = {') && at("default") && at("Red_Look") && at("Blue"), "default + glTF variants");
  // The (instanced) mesh prototype carries no local binding: it would beat every variant.
  const proto = v.slice(v.indexOf('class Xform "Meshes"'), v.indexOf('def Scope "Materials"'));
  assert(proto.includes('prepend apiSchemas = ["MaterialBindingAPI"]') && !proto.includes("material:binding"), "no local binding on mapped mesh");
  assert(at("default").includes('over "Meshes"') && at("default").includes("rel material:binding = </Root/Materials/Red_Mat>"), "default variant binds the default material");
  assert(at("Red_Look").includes("</Root/Materials/Red_Mat>"), "unmapped variant falls back to the default material");
  assert(at("Blue").includes("rel material:binding = </Root/Materials/Blue>"), "mapped variant binds its material");
  assert(w.length === 0, `no warnings: ${w}`);
}

// ---- EXT_meshopt_compression decoder ----
{
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  for (const v of VECTORS) {
    const out = decodeMeshopt(fromB64(v.encoded), v);
    const expected = fromB64(v.expected);
    assert(out.length === expected.length && out.every((x, i) => x === expected[i]), `meshopt ${v.name} matches the reference decoder`);
  }
  // The cube with all four bufferViews meshopt-compressed (fallback buffer has no data)
  // must convert to exactly the same USDA as the uncompressed cube.
  const { resources } = buildCubeGltf();
  const w = [];
  assert(glbToUsda(meshoptCube("EXT_meshopt_compression"), { resources, onWarning: (m) => w.push(m) }).usda === usda && w.length === 0, `meshopt cube converts like the plain cube: ${w}`);
}

/** The cube with its four bufferViews compressed (CUBE_VIEWS, vertex codec v0) under `name`. */
function meshoptCube(name) {
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const j = JSON.parse(buildCubeGltf().gltf);
  const packed = CUBE_VIEWS.map((v) => fromB64(v.encoded));
  const all = new Uint8Array(packed.reduce((n, p) => n + p.length + ((4 - (p.length % 4)) % 4), 0));
  let off = 0;
  CUBE_VIEWS.forEach((v, i) => {
    all.set(packed[i], off);
    j.bufferViews[i] = {
      buffer: 2, byteOffset: j.bufferViews[i].byteOffset, byteLength: j.bufferViews[i].byteLength,
      ...(v.mode === "ATTRIBUTES" ? { byteStride: v.byteStride } : {}),
      extensions: { [name]: { buffer: 1, byteOffset: off, byteLength: packed[i].length, byteStride: v.byteStride, count: v.count, mode: v.mode } },
    };
    off += packed[i].length + ((4 - (packed[i].length % 4)) % 4);
  });
  j.buffers.push({ byteLength: all.length, uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...all))}` });
  j.buffers.push({ byteLength: 1000, extensions: { [name]: { fallback: true } } });
  j.extensionsUsed = j.extensionsRequired = [name];
  return j;
}

// ---- KHR_meshopt_compression decoder (vertex codec v1, COLOR filter) ----
{
  const KHR = "KHR_meshopt_compression";
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  for (const v of KHR_VECTORS) {
    assert(same(decodeMeshopt(fromB64(v.encoded), v, KHR), fromB64(v.expected)), `meshopt ${v.name} (KHR) matches the reference decoder`);
  }
  // The EXT bitstreams (vertex codec v0) are valid KHR bitstreams.
  for (const v of VECTORS) assert(same(decodeMeshopt(fromB64(v.encoded), v, KHR), fromB64(v.expected)), `meshopt ${v.name} decodes under KHR`);
  const throws = (f, re, m) => {
    try { f(); } catch (e) { assert(re.test(e.message), `${m}: ${e.message}`); return; }
    assert(false, `${m}: no error`);
  };
  // v1 and COLOR are KHR only.
  const v1 = KHR_VECTORS.find((v) => v.name === "v1 bit fields level 3");
  const color = KHR_VECTORS.find((v) => v.name === "v0 COLOR uint8 K=8");
  throws(() => decodeMeshopt(fromB64(v1.encoded), v1), /^EXT_meshopt_compression: unsupported vertex codec header 0xa1/, "EXT rejects vertex codec v1");
  throws(() => decodeMeshopt(fromB64(color.encoded), color), /^EXT_meshopt_compression: unknown filter COLOR/, "EXT rejects the COLOR filter");
  throws(() => decodeMeshopt(fromB64(color.encoded), { ...color, byteStride: 8, count: color.count / 2 }, KHR), /COLOR filter needs byteStride 4 or 8|size mismatch|truncated/, "COLOR with a wrong layout");
  // Corrupt v1 streams fail with the KHR prefix: invalid channel modes, truncation, extra bytes.
  const bytes = fromB64(v1.encoded);
  const tailChannel = bytes.length - v1.byteStride / 4; // first channel mode byte
  for (const mode of [3, 0x10, 0x11, 0x0f]) {
    const bad = bytes.slice();
    bad[tailChannel] = mode;
    throws(() => decodeMeshopt(bad, v1, KHR), /^KHR_meshopt_compression: invalid channel mode/, `channel mode 0x${mode.toString(16)} rejected`);
  }
  for (const cut of [1, 5, 40, bytes.length - 30]) {
    const bad = new Uint8Array(bytes.length - cut);
    bad.set(bytes.subarray(0, 1 + (bytes.length - cut) - 1 - (v1.byteStride + v1.byteStride / 4)));
    bad.set(bytes.subarray(bytes.length - (v1.byteStride + v1.byteStride / 4)), bad.length - (v1.byteStride + v1.byteStride / 4));
    throws(() => decodeMeshopt(bad, v1, KHR), /^KHR_meshopt_compression: vertex data (truncated|too short|size mismatch)/, `stream cut by ${cut} bytes rejected`);
  }
  const longer = new Uint8Array(bytes.length + 1);
  longer.set(bytes.subarray(0, 1));
  longer.set(bytes.subarray(1), 2);
  throws(() => decodeMeshopt(longer, v1, KHR), /^KHR_meshopt_compression: vertex data (size mismatch|truncated)/, "extra byte rejected");

  // The meshopt cube under KHR_meshopt_compression converts like the plain cube.
  const { resources } = buildCubeGltf();
  const w = [];
  assert(glbToUsda(meshoptCube(KHR), { resources, onWarning: (m) => w.push(m) }).usda === usda && w.length === 0, `KHR meshopt cube converts like the plain cube: ${w}`);
  // Exclusions: a bufferView / buffer must not use both extensions.
  const both = meshoptCube(KHR);
  both.bufferViews[0].extensions.EXT_meshopt_compression = both.bufferViews[0].extensions[KHR];
  throws(() => glbToUsda(both, { resources }), /bufferView 0: KHR_meshopt_compression and EXT_meshopt_compression must not be used together/, "bufferView with both meshopt extensions");
  const bothBuffer = meshoptCube(KHR);
  bothBuffer.buffers[2].extensions.EXT_meshopt_compression = { fallback: true };
  throws(() => glbToUsda(bothBuffer, { resources }), /buffer 2: KHR_meshopt_compression and EXT_meshopt_compression must not be used together/, "buffer with both meshopt extensions");
  // The compressed range is checked like EXT's.
  const range = meshoptCube(KHR);
  range.bufferViews[1].extensions[KHR].byteLength = 1e6;
  throws(() => glbToUsda(range, { resources }), /Invalid bufferView range: bufferView 1 KHR_meshopt_compression data exceeds buffer 1/, "KHR compressed range checked");
}

// ---- Compressed data that cannot be decoded is skipped, not written as zeros ----
{
  const { gltf, resources } = buildCubeGltf();
  // Draco data that does not decode (the view holds plain floats), without an uncompressed
  // fallback: POSITION accessor has no bufferView.
  const draco = JSON.parse(gltf);
  draco.extensionsUsed = draco.extensionsRequired = ["KHR_draco_mesh_compression"];
  draco.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } };
  delete draco.accessors[0].bufferView;
  const w1 = [];
  const d = glbToUsda(draco, { resources, onWarning: (m) => w1.push(m) }).usda;
  assert(!d.includes("def Mesh") && w1.some((m) => m.includes("KHR_draco_mesh_compression") && m.includes("could not be decoded") && m.includes("skipped")), `undecodable Draco without fallback skipped: ${w1}`);
  // With a fallback (accessors keep their bufferViews) the fallback is used, with a warning.
  const withFallback = JSON.parse(gltf);
  withFallback.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } };
  const w3 = [];
  assert(glbToUsda(withFallback, { resources, onWarning: (m) => w3.push(m) }).usda === usda, "undecodable Draco with uncompressed fallback uses the fallback");
  assert(w3.length === 1 && w3[0].includes("uncompressed fallback is used"), `fallback warning: ${w3}`);
  // EXT_meshopt_compression: the view's buffer is a data-less fallback.
  const mo = JSON.parse(gltf);
  mo.buffers.push({ byteLength: 288, extensions: { EXT_meshopt_compression: { fallback: true } } });
  mo.bufferViews[0] = { ...mo.bufferViews[0], buffer: 1, extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: 10, byteStride: 12, count: 24, mode: "ATTRIBUTES" } } };
  const w2 = [];
  const m = glbToUsda(mo, { resources, onWarning: (x) => w2.push(x) }).usda;
  assert(!m.includes("def Mesh") && w2.some((x) => x.includes("EXT_meshopt_compression") && x.includes("skipped")), `meshopt view skipped: ${w2}`);
  // KHR_meshopt_compression data that does not decode (plain floats, header 0x00) is skipped the same way.
  const khr = JSON.parse(gltf);
  khr.buffers.push({ byteLength: 288, extensions: { KHR_meshopt_compression: { fallback: true } } });
  khr.bufferViews[0] = { ...khr.bufferViews[0], buffer: 1, extensions: { KHR_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: 40, byteStride: 12, count: 24, mode: "ATTRIBUTES" } } };
  const w4 = [];
  const k = glbToUsda(khr, { resources, onWarning: (x) => w4.push(x) }).usda;
  assert(!k.includes("def Mesh") && w4.some((x) => x.includes("KHR_meshopt_compression: unsupported vertex codec header") && x.includes("skipped")), `undecodable KHR meshopt view skipped: ${w4}`);
}

// fmt() takes an integer fast path; it must match the reference toPrecision(7) formatting exactly.
{
  const ref = (v) => (Number.isFinite(v) ? Number(v.toPrecision(7)).toString() : "0");
  const special = [0, -0, NaN, Infinity, -Infinity, 1e-4, 9.9999995e-5, 1e-5, 1e7, 9999999.5, 9999999.4, 1, -1, 0.5, 0.1, 1e6, 999999.95,
    1.0000005, 2.5e-7, 123456789, 1e21, 1e-7, 1e-6, -3.14159265, 0.00012345675, 1234567.5];
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  const values = [...special];
  for (let i = 0; i < 200000; i++) {
    u32[0] = (rnd() * 2 ** 32) >>> 0;
    values.push(f32[0], (rnd() - 0.5) * 10 ** (rnd() * 14 - 6), Math.round(rnd() * 1e6) / 10 ** Math.floor(rnd() * 8));
  }
  for (const v of values) assert(fmt(v) === ref(v), `fmt(${v}) = ${fmt(v)}, expected ${ref(v)}`);
}

// crc32 (slice-by-8) matches the bitwise definition for every length around the 8-byte step.
{
  const slow = (b) => {
    let c = 0xffffffff;
    for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
    return (c ^ 0xffffffff) >>> 0;
  };
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 131 + 7) & 0xff);
  for (let n = 0; n <= bytes.length; n++) assert(crc32(bytes.subarray(1, n)) === slow(bytes.subarray(1, n)), `crc32 of ${n} bytes`);
  assert(crc32(new TextEncoder().encode("123456789")) === 0xcbf43926, "crc32 check value");
}

// Cube has nothing to warn about.
const cubeWarnings = [];
glbToUsda(glb, { onWarning: (m) => cubeWarnings.push(m) });
assert(cubeWarnings.length === 0, `cube has no warnings: ${cubeWarnings}`);

// The glb* names are the same functions as the format-neutral ones (issue #3).
assert(api.glbToUsda === api.toUsda && api.glbToUsdz === api.toUsdz, "glbToUsda / glbToUsdz are aliases");
assert(api.glbToUsdaAsync === api.toUsdaAsync && api.glbToUsdzAsync === api.toUsdzAsync, "glbTo*Async are aliases");
assert(toUsda(glb).usda === usda, "toUsda output");
{
  const z = toUsdz(glb);
  assert(z.length === usdz.length && z.every((b, i) => b === usdz[i]), "toUsdz output (byte-identical)");
}

// src/index.d.ts declares exactly the runtime exports of src/index.js (types: npm run test:types).
{
  const runtime = Object.keys(await import("../src/index.js")).sort();
  const dts = readFileSync(new URL("../src/index.d.ts", import.meta.url), "utf8");
  const declared = [...dts.matchAll(/^export (?:function|class|const) (\w+)/gm)].map((m) => m[1]).sort();
  assert(JSON.stringify(declared) === JSON.stringify(runtime), `index.d.ts exports ${declared} vs index.js ${runtime}`);
}

console.log("all tests passed;", usdz.length, "bytes usdz");
