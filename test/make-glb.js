// Writes test/cube.glb (see cube-glb.js) for the JS tests and validate.py.
import { writeFileSync } from "node:fs";
import { buildCubeGlb } from "./cube-glb.js";

writeFileSync(new URL("./cube.glb", import.meta.url), buildCubeGlb());
console.log("wrote test/cube.glb");
