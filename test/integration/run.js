#!/usr/bin/env node
// Integration test against Khronos glTF-Sample-Assets, pinned to the commit in
// manifest.json (every file is checked against its SHA-256). Needs the network the
// first time; files are cached in test/.cache/ (git-ignored).
//
//   npm run test:integration             download missing files, then test
//   npm run test:integration -- --offline   use the cache only (fails if a file is missing)
//   npm run test:integration -- Fox Box     only these models
//
// For each model: parse → USDA → USDZ, read the USDZ back as a zip (stored, 64-byte
// aligned, CRC32, root layer first), check that the glTF's main content survived
// (meshes, materials, textures, skeletons, blend shapes, animation, variants), and run
// test/validate.py (OpenUSD validators) when Python with `pxr` (pip install usd-core)
// is available. Warnings are listed but do not fail a model; errors do.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { crc32 } from "node:zlib";
import { glbToUsda, glbToUsdz } from "../../src/index.js";

const here = dirname(new URL(import.meta.url).pathname);
const root = join(here, "..", "..");
const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
const args = process.argv.slice(2);
const offline = args.includes("--offline");
const only = new Set(args.filter((a) => !a.startsWith("--")));
const cacheDir = join(root, "test", ".cache", "khronos", manifest.commit);
const rawBase = `https://raw.githubusercontent.com/${manifest.repository}/${manifest.commit}/`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fetchFile({ path, sha256: want }) {
  const local = join(cacheDir, path);
  if (existsSync(local)) {
    const bytes = readFileSync(local);
    if (sha256(bytes) === want) return bytes;
    console.warn(`  cached ${path} has the wrong SHA-256; downloading again`);
  }
  if (offline) throw new Error(`${path} is not in the cache (run without --offline)`);
  const res = await fetch(rawBase + path.split("/").map(encodeURIComponent).join("/"));
  if (!res.ok) throw new Error(`download ${path}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (sha256(bytes) !== want) throw new Error(`download ${path}: SHA-256 mismatch`);
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, bytes);
  return bytes;
}

// Python + pxr for the OpenUSD validators (optional).
const python = ["python3", "python"].find((p) => spawnSync(p, ["-c", "import pxr"], { stdio: "ignore" }).status === 0);
const tmp = mkdtempSync(join(tmpdir(), "gltf2usd-it-"));

/** Read the zip back: central directory, stored entries, alignment, CRC32. */
function checkZip(zip, errors) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  if (dv.getUint32(eocd, true) !== 0x06054b50) { errors.push("zip: no end of central directory record"); return []; }
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) { errors.push(`zip: central header ${i} is corrupt`); return names; }
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    const dataStart = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    if (method !== 0) errors.push(`zip: ${name} is compressed (method ${method})`);
    if (dataStart % 64) errors.push(`zip: ${name} data at ${dataStart} is not 64-byte aligned`);
    if ((crc32(zip.subarray(dataStart, dataStart + size)) >>> 0) !== crc) errors.push(`zip: ${name} CRC32 mismatch`);
    names.push(name);
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!/\.usd[ac]?$/.test(names[0] ?? "")) errors.push(`zip: first entry ${names[0]} is not the root layer`);
  return names;
}

/** What the converted stage must contain, derived from the glTF itself. */
function checkContent(json, usda, zipNames, warnings, errors) {
  const count = (re) => (usda.match(re) || []).length;
  const prims = (json.meshes || []).flatMap((m) => m.primitives || []);
  const triangles = prims.filter((p) => (p.mode ?? 4) >= 4 && p.attributes?.POSITION !== undefined);
  const meshPrims = count(/def Mesh "/g);
  if (triangles.length && !meshPrims) errors.push("content: no Mesh prims were written");
  // KHR_draco_mesh_compression is decoded (src/draco.js): no primitive may be skipped or fall back.
  for (const w of warnings) if (/KHR_draco_mesh_compression/.test(w)) errors.push(`content: Draco data was not decoded: ${w}`);
  // EXT_ / KHR_meshopt_compression are decoded (src/meshopt.js): no view may fail to decode.
  for (const w of warnings) if (/meshopt_compression/.test(w)) errors.push(`content: meshopt data was not decoded: ${w}`);
  // Every triangle primitive must become a Mesh prim (a skipped one would otherwise hide here).
  if ((json.extensionsUsed || []).some((e) => /meshopt_compression/.test(e)) && meshPrims < triangles.length) {
    errors.push(`content: ${triangles.length} triangle primitives, only ${meshPrims} Mesh prims`);
  }
  const usedMaterials = new Set(triangles.map((p) => p.material).filter((m) => m !== undefined));
  const materialPrims = count(/def Material "/g);
  if (materialPrims < usedMaterials.size) errors.push(`content: ${usedMaterials.size} glTF materials are used, ${materialPrims} Material prims written`);
  const pngJpeg = (json.images || []).filter((img) => /png|jpe?g/i.test(img.mimeType ?? img.uri ?? "png")).length;
  const textures = zipNames.filter((n) => n.startsWith("textures/")).length;
  if (pngJpeg && !textures) errors.push(`content: ${pngJpeg} PNG / JPEG images, no textures packaged`);
  if (json.skins?.length && !usda.includes("def Skeleton ")) errors.push("content: glTF has skins, no Skeleton written");
  if (json.skins?.length && !usda.includes("primvars:skel:jointIndices")) errors.push("content: no skinned mesh (jointIndices) written");
  if (prims.some((p) => p.targets?.length) && !usda.includes("def BlendShape ")) errors.push("content: glTF has morph targets, no BlendShape written");
  if (json.animations?.length && !usda.includes(".timeSamples")) errors.push("content: glTF has animations, no timeSamples written");
  if (json.extensions?.KHR_materials_variants && !usda.includes('variantSet "materialVariant"')) errors.push("content: material variants missing");
  if ((json.nodes || []).some((n) => n.extensions?.EXT_mesh_gpu_instancing) && !usda.includes("instanceable = true") && !meshPrims) {
    errors.push("content: GPU instances missing");
  }
}

let failed = 0;
const summary = [];
for (const model of manifest.models) {
  if (only.size && !only.has(model.id)) continue;
  const errors = [];
  const warnings = [];
  let usda = "";
  let zipNames = [];
  let validator = "skipped (no Python with pxr)";
  try {
    const files = [];
    for (const f of model.files) files.push({ path: f.path, bytes: await fetchFile(f) });
    const [main, ...external] = files;
    const resources = new Map(external.map((f) => [posix.relative(posix.dirname(main.path), f.path), f.bytes]));
    const options = { resources, onWarning: (w) => warnings.push(w) };
    const json = main.path.endsWith(".gltf")
      ? JSON.parse(new TextDecoder().decode(main.bytes))
      : JSON.parse(new TextDecoder().decode(main.bytes.subarray(20, 20 + new DataView(main.bytes.buffer, main.bytes.byteOffset).getUint32(12, true))));
    usda = glbToUsda(main.bytes, options).usda;
    const usdz = glbToUsdz(main.bytes, { ...options, onWarning: () => {} });
    zipNames = checkZip(usdz, errors);
    checkContent(json, usda, zipNames, warnings, errors);
    if (python) {
      const out = join(tmp, `${model.id}.usdz`);
      writeFileSync(out, usdz);
      const r = spawnSync(python, [join(root, "test", "validate.py"), out], { encoding: "utf8" });
      const last = (r.stdout || "").trim().split("\n").pop() ?? "";
      validator = last || (r.stderr || "").trim().split("\n").pop();
      if (r.status !== 0 || !/^0 validation error\(s\)/.test(last)) errors.push(`OpenUSD validator: ${(r.stdout + r.stderr).trim()}`);
    }
  } catch (e) {
    errors.push(`${e.name}: ${e.message}`);
  }
  const status = errors.length ? "FAIL" : "ok";
  if (errors.length) failed++;
  summary.push({ id: model.id, status, meshes: (usda.match(/def Mesh "/g) || []).length, textures: zipNames.filter((n) => n.startsWith("textures/")).length, warnings: warnings.length, validator });
  console.log(`${status === "ok" ? "ok  " : "FAIL"} ${model.id} (${model.features.join(", ")})`);
  for (const e of errors) console.log(`       error: ${e}`);
  for (const w of warnings) console.log(`       warning: ${w}`);
}
rmSync(tmp, { recursive: true, force: true });

console.log("");
console.table(summary);
console.log(`${summary.length - failed}/${summary.length} models passed (glTF-Sample-Assets @ ${manifest.commit.slice(0, 12)})`);
if (!python) console.log("OpenUSD validation was skipped: install usd-core (pip install usd-core) to run it.");
process.exit(failed ? 1 : 0);
