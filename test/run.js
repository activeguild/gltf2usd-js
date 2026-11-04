import { readFileSync } from "node:fs";
import { glbToUsda, glbToUsdz } from "../src/index.js";
import { buildCubeGltf } from "./cube-glb.js";

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
assert(warnings.some((w) => w.includes("KHR_materials_transmission")), "transmission is reported as unsupported");
for (const e of ["emissive_strength", "KHR_materials_ior", "KHR_materials_clearcoat"]) {
  assert(!warnings.some((w) => w.includes(e)), `no warning for supported ${e}`);
}

// Warnings: unsupported extension, skipped LINES primitive; each reported once.
assert(warnings.some((w) => w.includes("KHR_materials_unlit")), "warns about unsupported extension");
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

// Cube has nothing to warn about.
const cubeWarnings = [];
glbToUsda(glb, { onWarning: (m) => cubeWarnings.push(m) });
assert(cubeWarnings.length === 0, `cube has no warnings: ${cubeWarnings}`);

console.log("all tests passed;", usdz.length, "bytes usdz");
