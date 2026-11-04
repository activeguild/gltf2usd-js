// Writes the test GLBs (see cube-glb.js) for the JS tests and validate.py.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCubeGlb, buildCubeGltf, buildFeatureGlb } from "./cube-glb.js";

writeFileSync(new URL("./cube.glb", import.meta.url), buildCubeGlb());
writeFileSync(new URL("./features.glb", import.meta.url), buildFeatureGlb());
// test/gltf/: the cube as .gltf + external .bin / image, for the CLI
const { gltf, resources } = buildCubeGltf();
const dir = fileURLToPath(new URL("./gltf/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}cube.gltf`, gltf);
for (const [name, bytes] of Object.entries(resources)) {
  mkdirSync(dirname(`${dir}${name}`), { recursive: true });
  writeFileSync(`${dir}${name}`, bytes);
}
console.log("wrote test/cube.glb, test/features.glb, test/gltf/cube.gltf");
