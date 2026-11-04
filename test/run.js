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
console.log("all tests passed;", usdz.length, "bytes usdz");
