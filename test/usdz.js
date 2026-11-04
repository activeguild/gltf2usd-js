// USDZ packaging: zip structure, 64-byte alignment, CRC32, root layer first, entry
// name rules and the classic-zip limits (no corrupt archive past 4 GiB / 65535 entries).
import { crc32 as zlibCrc32 } from "node:zlib";
import { packUsdz, planLayout, UsdzLimitError } from "../src/usdz.js";

let failures = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); failures++; } };
const throwsLike = (fn, pattern, label, type = Error) => {
  try { fn(); } catch (e) {
    assert(e instanceof type, `${label}: expected ${type.name}, got ${e.name}`);
    assert(pattern.test(e.message), `${label}: "${e.message}" does not match ${pattern}`);
    return;
  }
  assert(false, `${label}: expected an error`);
};

/** Read a zip with only the end record and central directory, like an independent reader. */
function readZip(zip) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  assert(dv.getUint32(eocd, true) === 0x06054b50, "end of central directory record at the end");
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  let p = dv.getUint32(eocd + 16, true);
  assert(p + cdSize === eocd, "central directory ends where the end record starts");
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert(dv.getUint32(p, true) === 0x02014b50, `central header ${i} signature`);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    assert(dv.getUint32(local, true) === 0x04034b50, `local header of ${name}`);
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const dataStart = local + 30 + lNameLen + lExtraLen;
    entries.push({ name, method, crc, csize, usize, dataStart, data: zip.subarray(dataStart, dataStart + usize) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const bytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

// Normal package: root layer + textures of awkward sizes (every padding case 0..63).
{
  const files = [{ name: "model.usda", bytes: new TextEncoder().encode("#usda 1.0\n") }];
  for (let i = 0; i < 70; i++) files.push({ name: `textures/t${i}.png`, bytes: bytes(i * 7 + 1, i) });
  const zip = packUsdz(files);
  const entries = readZip(zip);
  assert(entries.length === files.length, "entry count");
  assert(entries[0].name === "model.usda", "root layer is the first entry");
  entries.forEach((e, i) => {
    assert(e.name === files[i].name, `entry ${i} name`);
    assert(e.method === 0 && e.csize === e.usize, `${e.name}: stored (no compression)`);
    assert(e.dataStart % 64 === 0, `${e.name}: data at ${e.dataStart} is not 64-byte aligned`);
    assert(e.crc === zlibCrc32(files[i].bytes) >>> 0, `${e.name}: CRC32 matches zlib`);
    assert(e.data.length === files[i].bytes.length && e.data.every((b, k) => b === files[i].bytes[k]), `${e.name}: data intact`);
  });
}
// Empty file and a single-entry package.
{
  const entries = readZip(packUsdz([{ name: "a.usdc", bytes: new Uint8Array(0) }]));
  assert(entries.length === 1 && entries[0].usize === 0 && entries[0].crc === 0 && entries[0].dataStart % 64 === 0, "empty root layer");
}

// Entry names.
const pkg = (names) => () => packUsdz(names.map((name) => ({ name, bytes: bytes(3) })));
throwsLike(pkg(["textures/a.png", "model.usda"]), /first entry must be the root USD layer/, "texture first");
throwsLike(pkg(["model.usda", "/abs.png"]), /relative path/, "absolute path");
throwsLike(pkg(["model.usda", "C:/x.png"]), /relative path/, "drive letter");
throwsLike(pkg(["model.usda", "textures\\a.png"]), /forward slashes/, "backslash");
throwsLike(pkg(["model.usda", "../a.png"]), /'\.\.' path segment/, "parent segment");
throwsLike(pkg(["model.usda", "textures//a.png"]), /empty, '\.' or '\.\.'/, "empty segment");
throwsLike(pkg(["model.usda", "a\u0001.png"]), /control characters/, "control character");
throwsLike(pkg(["model.usda", "t/a.png", "t/A.png"]), /appears more than once/, "duplicate name (case-insensitive)");
throwsLike(pkg(["model.usda", ""]), /non-empty string/, "empty name");
throwsLike(() => packUsdz([]), /at least the root layer/, "no entries");
assert(readZip(packUsdz([{ name: "Model.USDA", bytes: bytes(1) }, { name: "日本語/テクスチャ.png", bytes: bytes(2) }]))[1].name === "日本語/テクスチャ.png", "UTF-8 names");

// Name length boundary: 65535 bytes fits, 65536 does not.
{
  const long = (n) => `${"a".repeat(n - 4)}.png`;
  const zip = packUsdz([{ name: "model.usda", bytes: bytes(1) }, { name: long(65535), bytes: bytes(5) }]);
  const e = readZip(zip);
  assert(e[1].name.length === 65535 && e[1].dataStart % 64 === 0, "65535-byte name");
  throwsLike(() => packUsdz([{ name: "model.usda", bytes: bytes(1) }, { name: long(65536), bytes: bytes(5) }]), /entry name is 65536 bytes/, "65536-byte name", UsdzLimitError);
}

// Entry count boundary: 65535 entries fit, 65536 do not.
{
  const many = (n) => Array.from({ length: n }, (_, i) => ({ name: i ? `f/${i}` : "model.usda", bytes: new Uint8Array(0) }));
  const zip = packUsdz(many(65535));
  assert(new DataView(zip.buffer).getUint16(zip.length - 22 + 10, true) === 65535, "65535 entries recorded");
  throwsLike(() => packUsdz(many(65536)), /65536 entries/, "65536 entries", UsdzLimitError);
}

// Size limits, checked from lengths alone (no 4 GiB buffers are allocated): the entry
// objects only report a length; planLayout / packUsdz throw before touching the data.
{
  const fake = (name, length) => ({ name, bytes: { length } });
  throwsLike(() => packUsdz([fake("model.usda", 2 ** 32)]), /USDZ exceeds supported ZIP size limits: entry "model.usda" is 4294967296 bytes/, "file ≥ 4 GiB", UsdzLimitError);
  const ok = planLayout([fake("model.usda", 2 ** 32 - 1 - 200)]);
  assert(ok.total <= 2 ** 32 - 1 + 200, "a file just under 4 GiB is planned");
  throwsLike(() => packUsdz([fake("model.usda", 2 ** 31), fake("a.png", 2 ** 31), fake("b.png", 1)]), /would start at byte/, "offset past 4 GiB", UsdzLimitError);
  throwsLike(() => packUsdz([fake("model.usda", 2 ** 32 - 64)]), /central directory would start at byte/, "central directory past 4 GiB", UsdzLimitError);
}

if (failures) { console.error(`usdz: ${failures} failure(s)`); process.exit(1); }
console.log("usdz tests passed");
