import { readFileSync } from "node:fs";
import { glbToUsda, glbToUsdz } from "../src/index.js";

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

// ---- Stage 2 features (test/features.glb) ----
const features = readFileSync(new URL("./features.glb", import.meta.url));
const warnings = [];
const f = glbToUsda(features, { onWarning: (msg) => warnings.push(msg) });

// Image name collisions → distinct file names, each referenced once.
assert(f.files.map((x) => x.name).join() === "textures/tex.png,textures/tex_1.png", `deduped image names: ${f.files.map((x) => x.name)}`);
assert(f.usda.includes("@textures/tex.png@") && f.usda.includes("@textures/tex_1.png@"), "both textures referenced");

// Sampler wrap modes.
const matA = f.usda.slice(f.usda.indexOf('def Material "A"'), f.usda.indexOf('def Material "B"'));
const matB = f.usda.slice(f.usda.indexOf('def Material "B"'));
assert(matA.includes('token inputs:wrapS = "clamp"') && matA.includes('token inputs:wrapT = "mirror"'), "CLAMP_TO_EDGE / MIRRORED_REPEAT");
assert(matB.includes('token inputs:wrapS = "repeat"') && matB.includes('token inputs:wrapT = "repeat"'), "default sampler = repeat");

// Warnings: unsupported extension, skipped LINES primitive; each reported once.
assert(warnings.some((w) => w.includes("KHR_materials_unlit")), "warns about unsupported extension");
assert(warnings.some((w) => w.includes("LINES")), "warns about LINES primitive");
assert(new Set(warnings).size === warnings.length, "warnings are deduplicated");
assert(!f.usda.includes('"CubeB_1"'), "LINES primitive not written");

// No onWarning → no throw, same output.
assert(glbToUsda(features).usda === f.usda, "onWarning does not change output");

// Cube has nothing to warn about.
const cubeWarnings = [];
glbToUsda(glb, { onWarning: (m) => cubeWarnings.push(m) });
assert(cubeWarnings.length === 0, `cube has no warnings: ${cubeWarnings}`);

console.log("all tests passed;", usdz.length, "bytes usdz");
