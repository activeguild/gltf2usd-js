#!/usr/bin/env node
// Builds the public demo site into dist/ (used by Vercel: vercel.json → buildCommand).
// Only the files the demo needs are copied, so README / CLAUDE.md / tests stay off the site.
// Check locally: `npm run build:site && node demo/server.js dist`.
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}dist/`;

const demoFiles = [
  "index.html", "app.js", "checks.js", "usd-preview.js", "usda-parser.js", "usdz-reader.js",
  "style.css", "favicon.svg", "og-image.png",
];
// Imported by demo/app.js to build the sample models in memory.
const testFiles = ["cube-glb.js", "png.js"];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const copies = [
  ...demoFiles.map((f) => `demo/${f}`),
  ...testFiles.map((f) => `test/${f}`),
  ...(await readdir(`${root}src`)).filter((f) => f.endsWith(".js")).map((f) => `src/${f}`),
];
for (const rel of copies) await cp(`${root}${rel}`, `${out}${rel}`);
// robots.txt / sitemap.xml go to the site root.
for (const f of await readdir(`${root}site`)) await cp(`${root}site/${f}`, `${out}${f}`);

console.log(`dist/: ${copies.length} files + site root (${(await readdir(`${root}site`)).join(", ")})`);
