#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { glbToUsda, glbToUsdz } from "./src/index.js";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: glb2usd <in.glb|in.gltf> <out.usdz|out.usda>");
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
if (output.endsWith(".usda")) {
  writeFileSync(output, glbToUsda(data, options).usda);
} else {
  writeFileSync(output, glbToUsdz(data, options));
}
console.log(`wrote ${output}`);
