#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { glbToUsda, glbToUsdz } from "./src/index.js";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: glb2usd <in.glb> <out.usdz|out.usda>");
  process.exit(1);
}
const glb = readFileSync(input);
if (output.endsWith(".usda")) {
  writeFileSync(output, glbToUsda(glb).usda);
} else {
  writeFileSync(output, glbToUsdz(glb));
}
console.log(`wrote ${output}`);
