// Writes the test GLBs (see cube-glb.js) for the JS tests and validate.py.
import { writeFileSync } from "node:fs";
import { buildCubeGlb, buildFeatureGlb } from "./cube-glb.js";

writeFileSync(new URL("./cube.glb", import.meta.url), buildCubeGlb());
writeFileSync(new URL("./features.glb", import.meta.url), buildFeatureGlb());
console.log("wrote test/cube.glb, test/features.glb");
