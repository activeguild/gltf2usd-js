#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { toUsda, toUsdz } from "./src/index.js";

const USAGE = `usage: glb2usd <in.glb|in.gltf> <out.usdz|out.usda>

Converts glTF 2.0 (.glb, or .gltf with its external files next to it) to USDZ, or to
USDA text when the output name ends in .usda. Warnings about dropped data go to stderr.`;
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  console.log(pkg.version);
  process.exit(0);
}
const [input, output] = args;
if (!input || !output) {
  console.error(USAGE);
  process.exit(1);
}

// External files of a .gltf are read relative to it, never outside its folder.
const baseDir = dirname(resolve(input));
const resources = (uri) => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || isAbsolute(uri)) return null; // URLs / absolute paths
  const path = resolve(baseDir, uri);
  const rel = relative(baseDir, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
};

const options = { resources, onWarning: (msg) => console.warn(`warning: ${msg}`) };
const data = readFileSync(input);
let out;
try {
  out = output.endsWith(".usda") ? toUsda(data, options).usda : toUsdz(data, options);
} catch (e) {
  // Invalid input / limits: a one-line message; anything else is a bug, so keep the stack.
  if (e.name === "GltfValidationError" || e.name === "UsdzLimitError") {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
writeFileSync(output, out);
console.log(`wrote ${output}`);
